// MCP tool registration for Synapse. Deliberately separate from agent.js (the Groq tool-calling loop):
// both consume the SAME graph tool definitions and runner from graph/tools.js, but neither depends
// on the other, so changing one cannot break the other.
//
// Nothing here queries the graph. Every call goes through `run`, which the HTTP layer builds with
// createAuthorizedRun(user, runTool), so RBAC is enforced per call exactly as for POST /api/tools/:name.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ROLE_PERMISSIONS, TOOL_PERMISSIONS, hasPermission } from '../auth/rbac.js';

export const MCP_SERVER_INFO = Object.freeze({ name: 'synapse-graph', version: '1.0.0' });
const MAX_INPUT_CHARS = 200; // service / engineer names and search keywords

const INSTRUCTIONS =
  'Read-only access to the Synapse company knowledge graph (services, dependencies, incidents, deployments, ' +
  'repositories, engineers). Start with search_services to find exact service names. Results contain only what ' +
  'is recorded in the graph; absence of data means it is not recorded.';

const titleOf = (name) => name.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/**
 * Builds a zod input shape from a graph tool's JSON input_schema, so the MCP contract cannot drift from
 * the definitions the agent and HTTP API already use. Only string properties exist today; anything
 * else fails loudly at registration instead of being silently accepted unvalidated.
 */
export function inputShapeFrom(inputSchema) {
  const required = new Set(Array.isArray(inputSchema?.required) ? inputSchema.required : []);
  const shape = {};
  for (const [key, def] of Object.entries(inputSchema?.properties ?? {})) {
    if (def?.type !== 'string') throw new Error(`Unsupported MCP input type for "${key}": ${def?.type}`);
    let field = z.string().trim().max(MAX_INPUT_CHARS, `Must be at most ${MAX_INPUT_CHARS} characters.`);
    if (required.has(key)) field = field.min(1, 'Must not be empty.');
    field = field.describe(def.description ?? key);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function failure(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Only errors raised on purpose carry client-safe messages; everything else is logged, not leaked. */
function toToolError(err, name, logger) {
  if (err?.name === 'ToolError' || err?.name === 'ForbiddenError' || err?.name === 'UnknownToolError' || err?.expose === true) {
    return failure(err.message);
  }
  logger.error(`[mcp] tool ${name} failed:`, err?.message);
  return failure('The tool failed unexpectedly. Please try again.');
}

/**
 * Creates an MCP server for ONE authenticated request (stateless transport).
 *  - user: req.user, built server-side from a verified token
 *  - definitions: TOOL_DEFINITIONS ({ name, description, input_schema })
 *  - run: an authorized runner (name, input) => result
 * Only tools the user's role may use are registered, so `tools/list` never reveals the rest; `run`
 * authorizes again on every call.
 */
export function createMcpServer({ user, definitions, run, matrix = ROLE_PERMISSIONS, logger = console }) {
  if (typeof run !== 'function') throw new TypeError('An authorized tool runner is required.');
  const server = new McpServer(MCP_SERVER_INFO, { instructions: INSTRUCTIONS });

  for (const def of definitions) {
    const required = Object.hasOwn(TOOL_PERMISSIONS, def.name) ? TOOL_PERMISSIONS[def.name] : null;
    // Fail closed: a tool without a permission mapping, or one this role may not use, is not exposed.
    if (!required || !required.every((p) => hasPermission(user?.role, p, matrix))) continue;

    server.registerTool(
      def.name,
      {
        title: titleOf(def.name),
        description: def.description,
        inputSchema: inputShapeFrom(def.input_schema),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          const data = await run(def.name, args ?? {});
          const structured = isObject(data) ? data : { result: data ?? null };
          return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
        } catch (err) {
          return toToolError(err, def.name, logger);
        }
      },
    );
  }
  return server;
}
