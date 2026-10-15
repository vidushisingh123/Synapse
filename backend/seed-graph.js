import 'dotenv/config';
import { FalkorDB } from 'falkordb';

const db = await FalkorDB.connect({
  host: process.env.FALKORDB_HOST || '127.0.0.1',
  port: Number(process.env.FALKORDB_PORT || 6379),
});

try {
  const graph = db.selectGraph('synapse');

  await graph.query(`
    MERGE (checkout:Service {name: 'Checkout API'})
    MERGE (payment:Service {name: 'Payment Service'})
    MERGE (inventory:Service {name: 'Inventory Service'})

    MERGE (checkout)-[:DEPENDS_ON]->(payment)
    MERGE (checkout)-[:DEPENDS_ON]->(inventory)

    MERGE (incident:Incident {
      id: 'INC-101',
      title: 'Payment timeouts during checkout',
      status: 'resolved',
      severity: 'high'
    })

    MERGE (incident)-[:AFFECTS]->(checkout)
    MERGE (incident)-[:INVOLVES]->(payment)

    MERGE (repo:Repository {
      name: 'payment-service',
      url: 'https://github.com/example/payment-service'
    })

    MERGE (payment)-[:IMPLEMENTED_IN]->(repo)

    MERGE (engineer:Engineer {
      name: 'Avery Chen',
      expertise: 'Payment systems'
    })

    MERGE (engineer)-[:MAINTAINS]->(repo)
    MERGE (engineer)-[:INVESTIGATED]->(incident)
  `);

  console.log('Seed graph created successfully.');

  const result = await graph.query(`
    MATCH (i:Incident)-[:AFFECTS]->(s:Service)
    MATCH (s)-[:DEPENDS_ON]->(dependency:Service)
    RETURN i.id AS incident,
           i.title AS past_incident,
           s.name AS affected_service,
           dependency.name AS dependency
  `);

  console.dir(result, { depth: null });
} catch (error) {
  console.error('Seeding failed:', error);
  process.exitCode = 1;
} finally {
  await db.close();
}
