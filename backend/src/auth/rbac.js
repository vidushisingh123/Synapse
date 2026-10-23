// Central role-based access control. This is the ONLY place that maps roles to permissions
// and tools to required permissions. Everything fails closed: unknown roles, permissions
// and tools are denied.
//
// NOTE (Milestone 2): this is role-level authorization only. Any role that holds a permission
// can use it against ALL graph data. Service-level (resource) scoping is Milestone 3.

export const PERMISSIONS = Object.freeze({
  GRAPH_READ: 'graph:read',
  TOOLS_INVOKE: 'tools:invoke',
  INVESTIGATE: 'investigate',
  OFFBOARDING_READ: 'offboarding:read',
  ADMIN_USERS: 'admin:users', // reserved for future user management; no route uses it yet
});

export const ROLES = Object.freeze(['admin', 'analyst', 'viewer']);

const P = PERMISSIONS;
export const ROLE_PERMISSIONS = Object.freeze({
  admin: Object.freeze([P.GRAPH_READ, P.TOOLS_INVOKE, P.INVESTIGATE, P.OFFBOARDING_READ, P.ADMIN_USERS]),
  analyst: Object.freeze([P.GRAPH_READ, P.TOOLS_INVOKE, P.INVESTIGATE, P.OFFBOARDING_READ]),
  viewer: Object.freeze([P.GRAPH_READ]),
});

/**
 * Permissions required to execute each graph tool (ALL listed permissions are required).
 * A tool missing from this map cannot be executed by anyone.
 */
export const TOOL_PERMISSIONS = Object.freeze({
  search_services: Object.freeze([P.TOOLS_INVOKE]),
  get_service_dependencies: Object.freeze([P.TOOLS_INVOKE]),
  get_related_incidents: Object.freeze([P.TOOLS_INVOKE]),
  get_recent_deployments: Object.freeze([P.TOOLS_INVOKE]),
  get_repositories: Object.freeze([P.TOOLS_INVOKE]),
  get_engineers: Object.freeze([P.TOOLS_INVOKE]),
  get_offboarding_risk: Object.freeze([P.TOOLS_INVOKE, P.OFFBOARDING_READ]),
});

const KNOWN_PERMISSIONS = new Set(Object.values(PERMISSIONS));
const hasOwn = (obj, key) => typeof key === 'string' && Object.hasOwn(obj, key);

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden: your role does not permit this action.') {
    super(message);
    this.name = 'ForbiddenError';
    this.status = 403;
    this.code = 'forbidden';
    this.expose = true;
  }
}

/** Same shape and message the tool layer has always used for unknown tools. */
export class UnknownToolError extends Error {
  constructor(name) {
    super(`Unknown tool "${String(name).slice(0, 100)}"`);
    this.name = 'UnknownToolError';
    this.status = 404;
    this.expose = true;
  }
}

export const isKnownRole = (role, matrix = ROLE_PERMISSIONS) => hasOwn(matrix, role);
export const isKnownPermission = (permission) => typeof permission === 'string' && KNOWN_PERMISSIONS.has(permission);

/** Permissions held by a role. Unknown roles hold none. */
export function permissionsForRole(role, matrix = ROLE_PERMISSIONS) {
  return isKnownRole(role, matrix) ? matrix[role].filter(isKnownPermission) : [];
}

export function hasPermission(role, permission, matrix = ROLE_PERMISSIONS) {
  if (!isKnownPermission(permission)) return false;
  return permissionsForRole(role, matrix).includes(permission);
}

const describe = (user) => `user=${String(user?.id ?? 'unknown').slice(0, 64)} role=${JSON.stringify(String(user?.role ?? '').slice(0, 32))}`;

/**
 * Express middleware. Must run after authentication: the principal is req.user, which is built
 * server-side from the verified token and a fresh user lookup, never from the request body,
 * query string or headers other than Authorization.
 */
export function requirePermission(permission, { matrix = ROLE_PERMISSIONS, logger = console } = {}) {
  if (!isKnownPermission(permission)) throw new Error(`Unknown permission "${permission}"`); // caught at startup
  const middleware = (req, res, next) => {
    if (!req.user) {
      return res.set('WWW-Authenticate', 'Bearer').status(401).json({ error: 'Authentication required.', code: 'unauthorized' });
    }
    if (!hasPermission(req.user.role, permission, matrix)) {
      logger.warn(`[rbac] denied ${permission} ${describe(req.user)} ${req.method} ${req.path}`);
      return res.status(403).json({ error: 'Forbidden: your role does not permit this action.', code: 'forbidden' });
    }
    next();
  };
  middleware.requiredPermission = permission; // lets tests assert that every route declares one
  return middleware;
}

/** Throws UnknownToolError for unmapped tools and ForbiddenError when the role lacks a required permission. */
export function authorizeTool(user, toolName, { matrix = ROLE_PERMISSIONS, logger = console } = {}) {
  const required = hasOwn(TOOL_PERMISSIONS, toolName) ? TOOL_PERMISSIONS[toolName] : null;
  if (!required) throw new UnknownToolError(toolName);
  if (!user || !required.every((p) => hasPermission(user.role, p, matrix))) {
    logger.warn(`[rbac] denied tool ${toolName} ${describe(user)}`);
    throw new ForbiddenError('Forbidden: your role does not permit this tool.');
  }
}

/**
 * Wraps a tool runner so every call is authorized for `user` before it executes.
 * Use this for BOTH the direct tool endpoint and the investigation agent, so an LLM-requested
 * tool call is held to exactly the same rules as a direct HTTP call.
 */
export function createAuthorizedRun(user, run, options = {}) {
  if (typeof run !== 'function') throw new TypeError('A tool runner function is required.');
  return async (name, input) => {
    authorizeTool(user, name, options);
    return run(name, input);
  };
}
