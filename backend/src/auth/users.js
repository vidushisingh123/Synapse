import { randomUUID } from 'node:crypto';
import { query, AUTH_GRAPH_NAME } from '../db.js';

// Only "admin" exists until Milestone 2 introduces real roles and permissions.
// The stored role is informational for now: nothing in this milestone authorizes by it.
export const KNOWN_ROLES = new Set(['admin']);

export class UserExistsError extends Error {
  constructor() {
    super('A user with that username already exists.');
    this.name = 'UserExistsError';
  }
}

/**
 * User persistence in the dedicated auth graph. Every query is parameterised and explicitly
 * targets AUTH_GRAPH_NAME. `findById` never selects the password hash.
 */
export function createUserStore({ queryFn = query } = {}) {
  const run = (cypher, params = {}) => queryFn(cypher, params, { graph: AUTH_GRAPH_NAME });

  return {
    async ensureSchema() {
      for (const prop of ['username', 'id']) {
        try {
          await run(`CREATE INDEX FOR (u:User) ON (u.${prop})`);
        } catch (err) {
          if (!/already|exist/i.test(String(err?.message))) throw err;
        }
      }
    },

    /** Includes passwordHash; only the login flow may use this. */
    async findByUsername(username) {
      const rows = await run(
        `MATCH (u:User {username: $username})
         RETURN u.id AS id, u.username AS username, u.role AS role,
                u.passwordHash AS passwordHash, u.disabled AS disabled
         LIMIT 1`,
        { username },
      );
      const r = rows[0];
      return r ? { id: r.id, username: r.username, role: r.role, passwordHash: r.passwordHash, disabled: Boolean(r.disabled) } : null;
    },

    /** Public fields only. */
    async findById(id) {
      const rows = await run(
        `MATCH (u:User {id: $id})
         RETURN u.id AS id, u.username AS username, u.role AS role, u.disabled AS disabled
         LIMIT 1`,
        { id },
      );
      const r = rows[0];
      return r ? { id: r.id, username: r.username, role: r.role, disabled: Boolean(r.disabled) } : null;
    },

    /** Atomic create-if-absent via MERGE; throws UserExistsError if the username is taken. */
    async createUser({ username, passwordHash, role }) {
      if (!KNOWN_ROLES.has(role)) throw new Error('Unknown role.');
      const id = randomUUID();
      const rows = await run(
        `MERGE (u:User {username: $username})
         ON CREATE SET u.id = $id, u.passwordHash = $passwordHash, u.role = $role,
                       u.disabled = false, u.createdAt = $createdAt
         RETURN u.id AS id`,
        { username, id, passwordHash, role, createdAt: new Date().toISOString() },
      );
      if (rows[0]?.id !== id) throw new UserExistsError();
      return { id, username, role };
    },
  };
}
