import express from 'express';
import cors from 'cors';
import { query, GRAPH_NAME } from './db.js';
import { TOOL_DEFINITIONS, runTool, getGraphSnapshot, ToolError } from './graph/tools.js';
import { investigate } from './agent.js';
import { createUserStore } from './auth/users.js';
import { createAuthMiddleware } from './auth/middleware.js';
import { createAuthRouter } from './auth/routes.js';

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('FalkorDB did not respond in time')), ms)),
  ]);

/**
 * Builds the Express app. Dependencies are injectable so the HTTP layer can be tested
 * without FalkorDB or Groq; server.js wires the real ones.
 *
 * Route policy (deny by default):
 *   PUBLIC     GET  /api/health          minimal { status }; full details only with a valid token
 *   PUBLIC     POST /api/auth/login
 *   PROTECTED  everything else under /api, including paths that do not exist
 */
export function createApp({
  userStore = createUserStore(),
  tools = { TOOL_DEFINITIONS, runTool, getGraphSnapshot },
  investigateFn = investigate,
  queryFn = query,
  env = process.env,
  logger = console,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: (env.CORS_ORIGIN || 'http://localhost:5173').split(',') }));
  app.use(express.json({ limit: '10kb' }));

  const { requireAuth, optionalAuth } = createAuthMiddleware({ userStore, env, logger });

  // ---- Public ----
  app.get('/api/health', optionalAuth, async (req, res) => {
    try {
      const rows = await withTimeout(queryFn('MATCH (n) RETURN count(n) AS nodes'), 3000);
      if (!req.user) return res.json({ status: 'ok' });
      res.json({ status: 'ok', graph: GRAPH_NAME, nodes: rows[0]?.nodes ?? 0, llmConfigured: Boolean(env.GROQ_API_KEY) });
    } catch (err) {
      logger.error('[health] graph check failed:', err?.message);
      res.status(503).json(req.user ? { status: 'down', error: 'Graph database unavailable.' } : { status: 'down' });
    }
  });

  app.use('/api/auth', createAuthRouter({ userStore, requireAuth, env, logger }));

  // ---- Everything below requires a valid token (also covers unknown /api paths) ----
  app.use('/api', requireAuth);

  app.get('/api/graph', async (_req, res) => {
    res.json(await tools.getGraphSnapshot());
  });

  app.get('/api/tools', (_req, res) => {
    res.json({ tools: tools.TOOL_DEFINITIONS });
  });

  app.post('/api/tools/:name', async (req, res) => {
    const data = await tools.runTool(req.params.name, req.body ?? {});
    res.json({ tool: req.params.name, data });
  });

  app.post('/api/investigate', async (req, res) => {
    const question = String(req.body?.question ?? '').trim();
    if (question.length < 5) throw new ToolError('Please enter a question (at least 5 characters).');
    if (question.length > 500) throw new ToolError('Question is too long (max 500 characters).');
    res.json({ question, ...(await investigateFn(question)) });
  });

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    const production = env.NODE_ENV === 'production';

    if (status >= 500) {
      // Full detail stays in the server log only.
      logger.error('[server] request failed:', err);
      if (err.name === 'AuthConfigError') return res.status(status).json({ error: err.message });
      return res.status(status).json({ error: production ? 'Internal server error.' : `Server error: ${err.message}` });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
    // Only errors we raise on purpose carry client-safe messages.
    const exposable = err.name === 'ToolError' || err.expose === true;
    res.status(status).json({ error: exposable ? err.message : 'Bad request.' });
  });

  return app;
}
