import 'dotenv/config';
import { FalkorDB } from 'falkordb';

export const GRAPH_NAME = 'synapse';
/** Separate graph for authentication data. Never mixed with the knowledge graph. */
export const AUTH_GRAPH_NAME = 'synapse_auth';

// Only known graphs may be selected, so a graph name can never be built from untrusted input.
const ALLOWED_GRAPHS = new Set([GRAPH_NAME, AUTH_GRAPH_NAME]);

let dbPromise;

function connect() {
  if (!dbPromise) {
    dbPromise = FalkorDB.connect({
      host: process.env.FALKORDB_HOST || '127.0.0.1',
      port: Number(process.env.FALKORDB_PORT || 6379),
    }).catch((err) => {
      dbPromise = undefined;
      throw err;
    });
  }
  return dbPromise;
}

/**
 * Run a parameterised Cypher query and return result rows (objects keyed by RETURN alias).
 * Existing callers keep using the knowledge graph; pass `{ graph: AUTH_GRAPH_NAME }` to select another.
 */
export async function query(cypher, params = {}, { graph = GRAPH_NAME } = {}) {
  if (!ALLOWED_GRAPHS.has(graph)) throw new Error('Unknown graph.');
  const db = await connect();
  const result = await db.selectGraph(graph).query(cypher, { params });
  return result.data ?? [];
}

export async function closeDb() {
  if (dbPromise) {
    const db = await dbPromise;
    dbPromise = undefined;
    await db.close();
  }
}