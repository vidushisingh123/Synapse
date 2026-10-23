// Streamable HTTP endpoint for MCP: POST /mcp (JSON-RPC), stateless, one server per request.
//
// Access model: the SAME bearer JWT as /api (Authorization: Bearer <token> from POST /api/auth/login),
// the same fresh user lookup, and the same RBAC. The endpoint requires `tools:invoke`; each tool
// additionally requires its own permission (e.g. offboarding:read). Nothing is public.
import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PERMISSIONS, createAuthorizedRun, requirePermission } from '../auth/rbac.js';
import { createMcpServer } from './server.js';

export function createMcpRouter({ requireAuth, tools, rolePermissions, env = process.env, logger = console }) {
  const router = Router();
  const allowedOrigins = new Set((env.CORS_ORIGIN || 'http://localhost:5173').split(',').map((o) => o.trim()).filter(Boolean));

  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // Browsers always send Origin; reject unexpected ones (blocks DNS-rebinding / hostile web pages).
  // Non-browser MCP clients send no Origin and are unaffected. The bearer token is still required.
  router.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: 'Origin not allowed.', code: 'forbidden_origin' });
    next();
  });

  router.use(requireAuth);
  router.use(requirePermission(PERMISSIONS.TOOLS_INVOKE, { matrix: rolePermissions, logger }));

  router.post('/', async (req, res) => {
    const run = createAuthorizedRun(req.user, tools.runTool, { matrix: rolePermissions, logger });
    const server = createMcpServer({ user: req.user, definitions: tools.TOOL_DEFINITIONS, run, matrix: rolePermissions, logger });
    // Stateless: no session ids, no server-side per-client state. JSON responses (no SSE stream to leave open).
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error('[mcp] request failed:', err?.message);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error.' }, id: null });
      }
    }
  });

  // Stateless server: no server-initiated SSE stream (GET) and no sessions to terminate (DELETE).
  router.all('/', (_req, res) => {
    res.set('Allow', 'POST').status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  });

  return router;
}
