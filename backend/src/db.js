import 'dotenv/config';
import { FalkorDB } from 'falkordb';

export const GRAPH_NAME = 'synapse';

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

/** Run a parameterised Cypher query and return result rows (objects keyed by RETURN alias). */
export async function query(cypher, params = {}) {
  const db = await connect();
  const result = await db.selectGraph(GRAPH_NAME).query(cypher, { params });
  return result.data ?? [];
}

export async function closeDb() {
  if (dbPromise) {
    const db = await dbPromise;
    dbPromise = undefined;
    await db.close();
  }
}