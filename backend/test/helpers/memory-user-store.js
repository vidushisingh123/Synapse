// In-memory stand-in for the FalkorDB-backed user store (same interface as createUserStore).
import { randomUUID } from 'node:crypto';
import { UserExistsError } from '../../src/auth/users.js';

export function createMemoryUserStore() {
  const byName = new Map();
  const byId = new Map();
  return {
    byName,
    async ensureSchema() {},
    async findByUsername(username) {
      const r = byName.get(username);
      return r ? { ...r } : null;
    },
    async findById(id) {
      const r = byId.get(id);
      if (!r) return null;
      const { passwordHash: _omit, ...publicFields } = r; // mirrors the real store: no hash
      return publicFields;
    },
    async createUser({ username, passwordHash, role }) {
      if (byName.has(username)) throw new UserExistsError();
      const rec = { id: randomUUID(), username, passwordHash, role, disabled: false };
      byName.set(username, rec);
      byId.set(rec.id, rec);
      return { id: rec.id, username, role };
    },
  };
}
