import 'dotenv/config';
import { FalkorDB } from 'falkordb';

const db = await FalkorDB.connect({
  host: process.env.FALKORDB_HOST || '127.0.0.1',
  port: Number(process.env.FALKORDB_PORT || 6379),
});

const statements = [
  // Services and dependencies
  `MERGE (checkout:Service {name: 'Checkout API'})
   MERGE (payment:Service {name: 'Payment Service'})
   MERGE (auth:Service {name: 'Auth Service'})
   MERGE (fraud:Service {name: 'Fraud Check Service'})
   MERGE (checkout)-[:DEPENDS_ON]->(auth)
   MERGE (payment)-[:DEPENDS_ON]->(fraud)`,

  // Repositories (payment-service already exists from seed-graph.js)
  `MATCH (checkout:Service {name: 'Checkout API'}), (inventory:Service {name: 'Inventory Service'})
   MERGE (cr:Repository {name: 'checkout-api'})
   SET cr.url = 'https://github.com/example/checkout-api'
   MERGE (ir:Repository {name: 'inventory-service'})
   SET ir.url = 'https://github.com/example/inventory-service'
   MERGE (checkout)-[:IMPLEMENTED_IN]->(cr)
   MERGE (inventory)-[:IMPLEMENTED_IN]->(ir)`,

  // Engineers (Avery Chen already exists)
  `MATCH (cr:Repository {name: 'checkout-api'}), (ir:Repository {name: 'inventory-service'}), (pr:Repository {name: 'payment-service'})
   MERGE (sam:Engineer {name: 'Sam Okafor'})
   SET sam.expertise = 'Checkout and API design'
   MERGE (jordan:Engineer {name: 'Jordan Patel'})
   SET jordan.expertise = 'Inventory and caching'
   MERGE (avery:Engineer {name: 'Avery Chen'})
   SET avery.expertise = 'Payment systems'
   MERGE (sam)-[:MAINTAINS]->(cr)
   MERGE (jordan)-[:MAINTAINS]->(ir)
   MERGE (avery)-[:MAINTAINS]->(pr)`,

  // Incidents (INC-101 already exists; add root cause and resolution)
  `MATCH (checkout:Service {name: 'Checkout API'}), (payment:Service {name: 'Payment Service'}),
         (inventory:Service {name: 'Inventory Service'}), (fraud:Service {name: 'Fraud Check Service'}),
         (avery:Engineer {name: 'Avery Chen'}), (jordan:Engineer {name: 'Jordan Patel'})
   MERGE (i101:Incident {id: 'INC-101'})
   SET i101.rootCause = 'Payment gateway client timeout was too aggressive under peak load and retries were disabled',
       i101.resolution = 'Raised the timeout and restored retry with exponential backoff'
   MERGE (i087:Incident {id: 'INC-087'})
   SET i087.title = 'Stale stock shown at checkout',
       i087.status = 'resolved', i087.severity = 'medium',
       i087.rootCause = 'Inventory cache TTL too long after a bulk update',
       i087.resolution = 'Reduced cache TTL and added invalidation on bulk updates'
   MERGE (i087)-[:AFFECTS]->(checkout)
   MERGE (i087)-[:INVOLVES]->(inventory)
   MERGE (jordan)-[:INVESTIGATED]->(i087)
   MERGE (i115:Incident {id: 'INC-115'})
   SET i115.title = 'Fraud check latency spike delayed payments',
       i115.status = 'resolved', i115.severity = 'medium',
       i115.rootCause = 'Fraud model cold start after autoscaling',
       i115.resolution = 'Pre-warmed fraud service instances'
   MERGE (i115)-[:AFFECTS]->(payment)
   MERGE (i115)-[:INVOLVES]->(fraud)
   MERGE (avery)-[:INVESTIGATED]->(i115)`,

  // Deployments: the recent payment change mirrors INC-101's root cause
  `MATCH (payment:Service {name: 'Payment Service'}), (inventory:Service {name: 'Inventory Service'}),
         (avery:Engineer {name: 'Avery Chen'}), (jordan:Engineer {name: 'Jordan Patel'})
   MERGE (d1:Deployment {id: 'DEP-2041'})
   SET d1.version = 'v2.4.1', d1.deployedAt = '2026-10-14T09:12:00Z',
       d1.summary = 'Lowered payment gateway client timeout from 10s to 2s and removed the retry wrapper'
   MERGE (d1)-[:DEPLOYED_TO]->(payment)
   MERGE (avery)-[:AUTHORED]->(d1)
   MERGE (d2:Deployment {id: 'DEP-1987'})
   SET d2.version = 'v1.9.0', d2.deployedAt = '2026-09-20T15:30:00Z',
       d2.summary = 'Inventory sync batching improvements'
   MERGE (d2)-[:DEPLOYED_TO]->(inventory)
   MERGE (jordan)-[:AUTHORED]->(d2)`,
];

try {
  const graph = db.selectGraph('synapse');
  for (const cypher of statements) await graph.query(cypher);
  console.log('Demo data added.');
  const counts = await graph.query('MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count ORDER BY label');
  console.table(counts.data);
} catch (error) {
  console.error('Demo seeding failed:', error);
  process.exitCode = 1;
} finally {
  await db.close();
}