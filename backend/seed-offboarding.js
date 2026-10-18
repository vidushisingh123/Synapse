/**
 * seed-offboarding.js
 *
 * Adds data needed to demonstrate the Knowledge Continuity & Offboarding feature.
 * Safe to re-run: all statements use MERGE so no duplicates are created and no
 * existing unrelated data is overwritten.
 *
 * What this adds:
 *  - Riley Moss: engineer who maintains auth-service
 *  - auth-service repository, linked to Auth Service (covered — has one maintainer)
 *  - fraud-check repository, linked to Fraud Check Service (no maintainer → unowned gap)
 *  - INC-120: an incident investigated ONLY by Riley Moss, to demonstrate unique-investigator fact
 *
 * After running this seed:
 *  - Avery Chen: sole maintainer of payment-service (Payment Service) — solo single-point-of-failure
 *  - Riley Moss: sole maintainer of auth-service (Auth Service) — solo single-point-of-failure
 *  - Fraud Check Service: has a repo but no maintainer → surfaces as unowned gap
 *  - Auth Service: covered (Riley Moss is the maintainer)
 *
 * Run with: node seed-offboarding.js  (from the backend/ directory)
 */

import 'dotenv/config';
import { FalkorDB } from 'falkordb';

const db = await FalkorDB.connect({
  host: process.env.FALKORDB_HOST || '127.0.0.1',
  port: Number(process.env.FALKORDB_PORT || 6379),
});

const statements = [
  // 1. Repository for Auth Service (no maintainer assigned here intentionally for Avery's blast-radius)
  //    Riley Moss will maintain it — showing a covered service.
  `MATCH (auth:Service {name: 'Auth Service'})
   MERGE (ar:Repository {name: 'auth-service'})
   SET ar.url = 'https://github.com/example/auth-service'
   MERGE (auth)-[:IMPLEMENTED_IN]->(ar)`,

  // 2. Repository for Fraud Check Service — deliberately left without a maintainer
  //    so it surfaces as an unowned gap in offboarding reports.
  `MATCH (fraud:Service {name: 'Fraud Check Service'})
   MERGE (fr:Repository {name: 'fraud-check'})
   SET fr.url = 'https://github.com/example/fraud-check'
   MERGE (fraud)-[:IMPLEMENTED_IN]->(fr)`,

  // 3. Riley Moss: engineer who maintains auth-service.
  //    Auth Service is covered (has a maintainer) — demonstrates the non-solo case.
  `MATCH (ar:Repository {name: 'auth-service'})
   MERGE (riley:Engineer {name: 'Riley Moss'})
   SET riley.expertise = 'Auth and security'
   MERGE (riley)-[:MAINTAINS]->(ar)`,

  // 4. INC-120: investigated ONLY by Riley Moss.
  //    Demonstrates the "uniquely investigated incident" fact in the report.
  `MATCH (auth:Service {name: 'Auth Service'}), (riley:Engineer {name: 'Riley Moss'})
   MERGE (i120:Incident {id: 'INC-120'})
   SET i120.title = 'Auth token validation failures after cert rotation',
       i120.status = 'resolved',
       i120.severity = 'high',
       i120.rootCause = 'New TLS certificate not propagated to all auth service replicas before old cert expired',
       i120.resolution = 'Automated cert propagation check added to deployment pipeline'
   MERGE (i120)-[:AFFECTS]->(auth)
   MERGE (riley)-[:INVESTIGATED]->(i120)`,
];

try {
  const graph = db.selectGraph('synapse');
  for (const stmt of statements) {
    await graph.query(stmt);
  }
  console.log('Offboarding seed applied (idempotent — safe to re-run).');

  const counts = await graph.query(
    'MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count ORDER BY label',
  );
  console.table(counts.data);

  // Verify the key scenario is seeded correctly
  const soloCheck = await graph.query(
    `MATCH (e:Engineer)-[:MAINTAINS]->(r:Repository)<-[:IMPLEMENTED_IN]-(s:Service {name: 'Payment Service'})
     RETURN e.name AS engineer, r.name AS repo`,
  );
  console.log('\nPayment Service maintainers (expect only Avery Chen):');
  console.table(soloCheck.data);

  const fraudCheck = await graph.query(
    `MATCH (s:Service {name: 'Fraud Check Service'})
     OPTIONAL MATCH (s)-[:IMPLEMENTED_IN]->(r:Repository)<-[:MAINTAINS]-(e:Engineer)
     RETURN s.name AS service, r.name AS repo, e.name AS maintainer`,
  );
  console.log('\nFraud Check Service ownership (expect repo=fraud-check, maintainer=null):');
  console.table(fraudCheck.data);
} catch (err) {
  console.error('Offboarding seed failed:', err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
