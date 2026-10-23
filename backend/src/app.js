import express from 'express';
import cors from 'cors';
import { query, GRAPH_NAME } from './db.js';
import { TOOL_DEFINITIONS, runTool, getGraphSnapshot, ToolError } from './graph/tools.js';
import { investigate } from './agent.js';
import { createUserStore } from './auth/users.js';
import { createAuthMiddleware } from './auth/middleware.js';
import { createAuthRouter } from './auth/routes.js';
import { createMcpRouter } from './mcp/router.js';
import { PERMISSIONS, ROLE_PERMISSIONS, requirePermission, createAuthorizedRun } from './auth/rbac.js';

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
 *   AUTH ONLY  GET  /api/auth/me         any authenticated user
 *   graph:read GET  /api/graph
 *   tools:invoke  GET /api/tools, POST /api/tools/:name (plus a per-tool permission, e.g. offboarding:read)
 *   investigate   POST /api/investigate (every tool the agent calls is authorized again, per tool)
 *   tools:invoke  POST /mcp (MCP Streamable HTTP; only tools the role may use are listed, each call is authorized again)
 *   anything else under /api, including paths that do not exist, requires a valid token
 *
 * Role-level only: a role with a permission can use it against all graph data (service-level
 * scoping arrives in Milestone 3).
 */
export function createApp({
  userStore = createUserStore(),
  tools = { TOOL_DEFINITIONS, runTool, getGraphSnapshot },
  investigateFn = investigate,
  queryFn = query,
  rolePermissions = ROLE_PERMISSIONS,
  env = process.env,
  logger = console,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: (env.CORS_ORIGIN || 'http://localhost:5173').split(',') }));
  app.use(express.json({ limit: '10kb' }));
  // Responses can carry investigation results, graph data or account details: never let a browser or proxy cache them.
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const { requireAuth, optionalAuth } = createAuthMiddleware({ userStore, env, logger });
  const need = (permission) => requirePermission(permission, { matrix: rolePermissions, logger });
  // Every tool call, from the HTTP endpoint or from the agent, goes through this per-request runner.
  const authorizedRun = (req) => createAuthorizedRun(req.user, tools.runTool, { matrix: rolePermissions, logger });

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

  app.use('/api/auth', createAuthRouter({ userStore, requireAuth, rolePermissions, env, logger }));

  // MCP (Streamable HTTP). Same bearer token and RBAC as /api; set MCP_ENABLED=false to turn it off.
  if (env.MCP_ENABLED !== 'false') {
    app.use('/mcp', createMcpRouter({ requireAuth, tools, rolePermissions, env, logger }));
  }

  // ---- Everything below requires a valid token (also covers unknown /api paths) ----
  app.use('/api', requireAuth);

  app.get('/api/graph', need(PERMISSIONS.GRAPH_READ), async (_req, res) => {
    res.json(await tools.getGraphSnapshot());
  });

  app.get('/api/tools', need(PERMISSIONS.TOOLS_INVOKE), (_req, res) => {
    res.json({ tools: tools.TOOL_DEFINITIONS });
  });

  app.post('/api/tools/:name', need(PERMISSIONS.TOOLS_INVOKE), async (req, res) => {
    const data = await authorizedRun(req)(req.params.name, req.body ?? {});
    res.json({ tool: req.params.name, data });
  });

  app.post('/api/investigate', need(PERMISSIONS.INVESTIGATE), async (req, res) => {
    const rawQuestion = req.body?.question;
    if (typeof rawQuestion !== 'string') throw new ToolError('Please provide "question" as a text string.');
    const question = rawQuestion.trim();
    if (question.length < 5) throw new ToolError('Please enter a question (at least 5 characters).');
    if (question.length > 500) throw new ToolError('Question is too long (max 500 characters).');
    res.json({ question, ...(await investigateFn(question, { run: authorizedRun(req) })) });
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
      if (err.name === 'AuthConfigError' || err.expose === true) {
        return res.status(status).json({ error: err.message, ...(typeof err.code === 'string' ? { code: err.code } : {}) });
      }
      return res.status(status).json({ error: production ? 'Internal server error.' : `Server error: ${err.message}` });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
    // Only errors we raise on purpose carry client-safe messages.
    const exposable = err.name === 'ToolError' || err.expose === true;
    res.status(status).json({
      error: exposable ? err.message : 'Bad request.',
      ...(exposable && typeof err.code === 'string' ? { code: err.code } : {}),
    });
  });

  return app;
}
