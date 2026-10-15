import 'dotenv/config';
import { FalkorDB } from 'falkordb';

const db = await FalkorDB.connect({
  host: process.env.FALKORDB_HOST || '127.0.0.1',
  port: Number(process.env.FALKORDB_PORT || 6379),
});

try {
  console.log('Connected to FalkorDB!');

  const graph = db.selectGraph('synapse');

  await graph.query(`
    MERGE (checkout:Service {name: 'Checkout API'})
    MERGE (payment:Service {name: 'Payment Service'})
    MERGE (checkout)-[:DEPENDS_ON]->(payment)
  `);

  const result = await graph.query(`
    MATCH (s:Service)-[r:DEPENDS_ON]->(d:Service)
    RETURN s.name AS service,
           type(r) AS relationship,
           d.name AS dependency
  `);

  console.log('Graph query result:');
  console.dir(result, { depth: null });
} catch (error) {
  console.error('Graph test failed:', error);
  process.exitCode = 1;
} finally {
  await db.close();
}
