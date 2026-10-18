/**
 * seed-nexuspay.js
 *
 * Expands the Synapse graph with a realistic synthetic dataset for NexusPay,
 * a fictional payment platform. Designed for hackathon demos.
 *
 * SAFE TO RE-RUN: every statement uses MERGE. No existing nodes, relationships,
 * or properties are deleted. Existing data from seed-graph.js, seed-demo.js,
 * and seed-offboarding.js is preserved and extended.
 *
 * Prerequisites: run the base seeds first (seed-graph.js, seed-demo.js, seed-offboarding.js).
 *
 * Run with:
 *   node seed-nexuspay.js          (from the backend/ directory)
 *
 * What this adds to the existing graph:
 *
 *  Services (6 new):
 *    Web App, API Gateway, Notification Service, Refund Service,
 *    Ledger Service, Analytics Service
 *
 *  Repositories (5 new):
 *    web-app, api-gateway, notification-service, refund-service, ledger-service
 *    Note: Analytics Service intentionally has no repository → unowned gap for demos.
 *
 *  Engineers (3 new):
 *    Dana Kim     – Frontend and web platform
 *    Morgan Ellis – Notifications and messaging
 *    Quinn Torres – Ledger and financial data
 *
 *  Dependencies (new edges on top of existing ones):
 *    Web App      → API Gateway → Checkout API → Payment Service (existing chain extended)
 *    API Gateway  → Auth Service
 *    Checkout API → Auth Service (existing checkout→auth preserved)
 *    Refund Service → Payment Service, Ledger Service
 *    Ledger Service → Payment Service
 *    Notification Service → Auth Service (token verification)
 *    Analytics Service → Ledger Service, Inventory Service
 *
 *  Incidents (8 new: INC-130 to INC-137):
 *    INC-130 – Checkout API latency spike (Scenario A)
 *    INC-131 – API Gateway connection pool exhaustion (Scenario A follow-up)
 *    INC-132 – Auth Service token validation failures (Scenario B)
 *    INC-133 – Web App login errors cascading from Auth (Scenario B)
 *    INC-134 – Refund processing delays (Scenario C)
 *    INC-135 – Ledger reconciliation failures (Scenario C follow-up)
 *    INC-136 – Notification delivery backlog
 *    INC-137 – Analytics data pipeline stale (ownership gap demo)
 *
 *  Deployments (5 new: DEP-2050 to DEP-2054):
 *    DEP-2050 – API Gateway connection pool config change (near INC-130 timeline)
 *    DEP-2051 – Auth Service cert rotation automation (near INC-132 timeline)
 *    DEP-2052 – Refund Service retry logic update
 *    DEP-2053 – Ledger Service batch write optimisation
 *    DEP-2054 – Notification Service queue worker scaling
 */

import 'dotenv/config';
import { FalkorDB } from 'falkordb';

const db = await FalkorDB.connect({
  host: process.env.FALKORDB_HOST || '127.0.0.1',
  port: Number(process.env.FALKORDB_PORT || 6379),
});

// ---------------------------------------------------------------------------
// All statements use MERGE so the script is fully idempotent.
// SET is used with = (not +=) on non-identity properties so that if a node
// was already created by a previous seed, its descriptive properties are
// refreshed to the canonical values here without overwriting identity keys.
// ---------------------------------------------------------------------------

const statements = [

  // ── 1. New services ────────────────────────────────────────────────────────
  `MERGE (webapp:Service {name: 'Web App'})`,
  `MERGE (gateway:Service {name: 'API Gateway'})`,
  `MERGE (notify:Service {name: 'Notification Service'})`,
  `MERGE (refund:Service {name: 'Refund Service'})`,
  `MERGE (ledger:Service {name: 'Ledger Service'})`,
  `MERGE (analytics:Service {name: 'Analytics Service'})`,

  // ── 2. New repositories ────────────────────────────────────────────────────
  `MERGE (r_webapp:Repository {name: 'web-app'})
   SET r_webapp.url = 'https://github.com/nexuspay/web-app'`,

  `MERGE (r_gateway:Repository {name: 'api-gateway'})
   SET r_gateway.url = 'https://github.com/nexuspay/api-gateway'`,

  `MERGE (r_notify:Repository {name: 'notification-service'})
   SET r_notify.url = 'https://github.com/nexuspay/notification-service'`,

  `MERGE (r_refund:Repository {name: 'refund-service'})
   SET r_refund.url = 'https://github.com/nexuspay/refund-service'`,

  `MERGE (r_ledger:Repository {name: 'ledger-service'})
   SET r_ledger.url = 'https://github.com/nexuspay/ledger-service'`,

  // Note: Analytics Service intentionally gets no repository (unowned gap).

  // ── 3. Service → Repository mappings ──────────────────────────────────────
  `MATCH (webapp:Service {name: 'Web App'}), (r:Repository {name: 'web-app'})
   MERGE (webapp)-[:IMPLEMENTED_IN]->(r)`,

  `MATCH (gateway:Service {name: 'API Gateway'}), (r:Repository {name: 'api-gateway'})
   MERGE (gateway)-[:IMPLEMENTED_IN]->(r)`,

  `MATCH (notify:Service {name: 'Notification Service'}), (r:Repository {name: 'notification-service'})
   MERGE (notify)-[:IMPLEMENTED_IN]->(r)`,

  `MATCH (refund:Service {name: 'Refund Service'}), (r:Repository {name: 'refund-service'})
   MERGE (refund)-[:IMPLEMENTED_IN]->(r)`,

  `MATCH (ledger:Service {name: 'Ledger Service'}), (r:Repository {name: 'ledger-service'})
   MERGE (ledger)-[:IMPLEMENTED_IN]->(r)`,

  // ── 4. New engineers ───────────────────────────────────────────────────────
  `MERGE (dana:Engineer {name: 'Dana Kim'})
   SET dana.expertise = 'Frontend and web platform'`,

  `MERGE (morgan:Engineer {name: 'Morgan Ellis'})
   SET morgan.expertise = 'Notifications and messaging infrastructure'`,

  `MERGE (quinn:Engineer {name: 'Quinn Torres'})
   SET quinn.expertise = 'Ledger, financial data pipelines, and reconciliation'`,

  // ── 5. Engineer → Repository (MAINTAINS) ──────────────────────────────────
  // Dana Kim: sole maintainer of web-app; also co-maintains api-gateway with Sam Okafor
  `MATCH (dana:Engineer {name: 'Dana Kim'}), (r:Repository {name: 'web-app'})
   MERGE (dana)-[:MAINTAINS]->(r)`,

  `MATCH (dana:Engineer {name: 'Dana Kim'}), (r:Repository {name: 'api-gateway'})
   MERGE (dana)-[:MAINTAINS]->(r)`,

  // Sam Okafor co-maintains api-gateway (already maintains checkout-api from seed-demo)
  `MATCH (sam:Engineer {name: 'Sam Okafor'}), (r:Repository {name: 'api-gateway'})
   MERGE (sam)-[:MAINTAINS]->(r)`,

  // Morgan Ellis: sole maintainer of notification-service
  `MATCH (morgan:Engineer {name: 'Morgan Ellis'}), (r:Repository {name: 'notification-service'})
   MERGE (morgan)-[:MAINTAINS]->(r)`,

  // Quinn Torres: sole maintainer of both refund-service and ledger-service
  // (intentional single-point-of-failure for offboarding demos)
  `MATCH (quinn:Engineer {name: 'Quinn Torres'}), (r:Repository {name: 'refund-service'})
   MERGE (quinn)-[:MAINTAINS]->(r)`,

  `MATCH (quinn:Engineer {name: 'Quinn Torres'}), (r:Repository {name: 'ledger-service'})
   MERGE (quinn)-[:MAINTAINS]->(r)`,

  // Avery Chen already maintains payment-service (preserved from seed-demo).
  // Jordan Patel already maintains inventory-service (preserved from seed-demo).
  // Riley Moss already maintains auth-service (preserved from seed-offboarding).

  // ── 6. Service dependencies ────────────────────────────────────────────────
  // Web App is the user-facing entry point; routes everything through API Gateway
  `MATCH (webapp:Service {name: 'Web App'}), (gateway:Service {name: 'API Gateway'})
   MERGE (webapp)-[:DEPENDS_ON]->(gateway)`,

  // API Gateway fans out to core services
  `MATCH (gateway:Service {name: 'API Gateway'}), (checkout:Service {name: 'Checkout API'})
   MERGE (gateway)-[:DEPENDS_ON]->(checkout)`,

  `MATCH (gateway:Service {name: 'API Gateway'}), (auth:Service {name: 'Auth Service'})
   MERGE (gateway)-[:DEPENDS_ON]->(auth)`,

  `MATCH (gateway:Service {name: 'API Gateway'}), (notify:Service {name: 'Notification Service'})
   MERGE (gateway)-[:DEPENDS_ON]->(notify)`,

  // Checkout API → Auth Service already set in seed-demo; Checkout → Payment already in seed-graph
  // Add Checkout API → Notification Service (order confirmations)
  `MATCH (checkout:Service {name: 'Checkout API'}), (notify:Service {name: 'Notification Service'})
   MERGE (checkout)-[:DEPENDS_ON]->(notify)`,

  // Payment → Fraud Check already in seed-demo; add Payment → Ledger (transaction recording)
  `MATCH (payment:Service {name: 'Payment Service'}), (ledger:Service {name: 'Ledger Service'})
   MERGE (payment)-[:DEPENDS_ON]->(ledger)`,

  // Refund Service depends on Payment Service and Ledger Service
  `MATCH (refund:Service {name: 'Refund Service'}), (payment:Service {name: 'Payment Service'})
   MERGE (refund)-[:DEPENDS_ON]->(payment)`,

  `MATCH (refund:Service {name: 'Refund Service'}), (ledger:Service {name: 'Ledger Service'})
   MERGE (refund)-[:DEPENDS_ON]->(ledger)`,

  // Notification Service depends on Auth Service for token verification
  `MATCH (notify:Service {name: 'Notification Service'}), (auth:Service {name: 'Auth Service'})
   MERGE (notify)-[:DEPENDS_ON]->(auth)`,

  // Analytics Service reads from Ledger and Inventory (read-only downstream consumer)
  `MATCH (analytics:Service {name: 'Analytics Service'}), (ledger:Service {name: 'Ledger Service'})
   MERGE (analytics)-[:DEPENDS_ON]->(ledger)`,

  `MATCH (analytics:Service {name: 'Analytics Service'}), (inventory:Service {name: 'Inventory Service'})
   MERGE (analytics)-[:DEPENDS_ON]->(inventory)`,

  // ── 7. New deployments ─────────────────────────────────────────────────────
  // DEP-2050: API Gateway connection pool config — deployed just before INC-130/INC-131
  `MATCH (gateway:Service {name: 'API Gateway'}), (dana:Engineer {name: 'Dana Kim'})
   MERGE (d2050:Deployment {id: 'DEP-2050'})
   SET d2050.version    = 'v3.1.0',
       d2050.deployedAt = '2026-10-15T18:45:00Z',
       d2050.summary    = 'Reduced API Gateway HTTP connection pool size from 500 to 200 to limit downstream pressure; also tightened upstream timeout from 30s to 8s'
   MERGE (d2050)-[:DEPLOYED_TO]->(gateway)
   MERGE (dana)-[:AUTHORED]->(d2050)`,

  // DEP-2051: Auth Service cert rotation automation — deployed just before INC-132
  `MATCH (auth:Service {name: 'Auth Service'}), (riley:Engineer {name: 'Riley Moss'})
   MERGE (d2051:Deployment {id: 'DEP-2051'})
   SET d2051.version    = 'v2.8.0',
       d2051.deployedAt = '2026-10-16T07:20:00Z',
       d2051.summary    = 'Automated TLS certificate rotation using cert-manager; removed manual renewal cron job; updated token-signing key rotation schedule from 90d to 30d'
   MERGE (d2051)-[:DEPLOYED_TO]->(auth)
   MERGE (riley)-[:AUTHORED]->(d2051)`,

  // DEP-2052: Refund Service retry logic
  `MATCH (refund:Service {name: 'Refund Service'}), (quinn:Engineer {name: 'Quinn Torres'})
   MERGE (d2052:Deployment {id: 'DEP-2052'})
   SET d2052.version    = 'v1.4.0',
       d2052.deployedAt = '2026-10-13T11:00:00Z',
       d2052.summary    = 'Replaced synchronous retry loop with async exponential backoff queue; added dead-letter queue for failed refund transactions'
   MERGE (d2052)-[:DEPLOYED_TO]->(refund)
   MERGE (quinn)-[:AUTHORED]->(d2052)`,

  // DEP-2053: Ledger Service batch write optimisation
  `MATCH (ledger:Service {name: 'Ledger Service'}), (quinn:Engineer {name: 'Quinn Torres'})
   MERGE (d2053:Deployment {id: 'DEP-2053'})
   SET d2053.version    = 'v2.2.0',
       d2053.deployedAt = '2026-10-12T14:30:00Z',
       d2053.summary    = 'Switched transaction writes from single-row inserts to batch commits of 100; added checksum validation on batch close'
   MERGE (d2053)-[:DEPLOYED_TO]->(ledger)
   MERGE (quinn)-[:AUTHORED]->(d2053)`,

  // DEP-2054: Notification Service queue worker scaling
  `MATCH (notify:Service {name: 'Notification Service'}), (morgan:Engineer {name: 'Morgan Ellis'})
   MERGE (d2054:Deployment {id: 'DEP-2054'})
   SET d2054.version    = 'v1.7.2',
       d2054.deployedAt = '2026-10-11T09:15:00Z',
       d2054.summary    = 'Increased notification queue workers from 4 to 12; added circuit breaker on email provider calls'
   MERGE (d2054)-[:DEPLOYED_TO]->(notify)
   MERGE (morgan)-[:AUTHORED]->(d2054)`,

  // ── 8. Incidents — Scenario A: Checkout latency ────────────────────────────

  // INC-130: Checkout API latency spike (primary incident)
  `MATCH (checkout:Service {name: 'Checkout API'}), (payment:Service {name: 'Payment Service'}),
         (gateway:Service {name: 'API Gateway'}),
         (sam:Engineer {name: 'Sam Okafor'}), (avery:Engineer {name: 'Avery Chen'})
   MERGE (i130:Incident {id: 'INC-130'})
   SET i130.title      = 'Checkout API elevated latency — p99 above 8 seconds',
       i130.status     = 'resolved',
       i130.severity   = 'high',
       i130.rootCause  = 'API Gateway connection pool reduction in DEP-2050 caused upstream queuing; Payment Service timeout cascaded to Checkout API response times',
       i130.resolution = 'Reverted API Gateway pool size to 400; added per-route timeout overrides so payment calls are not throttled by gateway defaults'
   MERGE (i130)-[:AFFECTS]->(checkout)
   MERGE (i130)-[:INVOLVES]->(payment)
   MERGE (i130)-[:INVOLVES]->(gateway)
   MERGE (sam)-[:INVESTIGATED]->(i130)
   MERGE (avery)-[:INVESTIGATED]->(i130)`,

  // INC-131: API Gateway connection pool exhaustion (follow-up)
  `MATCH (gateway:Service {name: 'API Gateway'}), (dana:Engineer {name: 'Dana Kim'}),
         (sam:Engineer {name: 'Sam Okafor'})
   MERGE (i131:Incident {id: 'INC-131'})
   SET i131.title      = 'API Gateway connection pool exhausted under peak load',
       i131.status     = 'resolved',
       i131.severity   = 'medium',
       i131.rootCause  = 'Pool size of 200 (set in DEP-2050) was insufficient for Black-Friday-scale traffic; connections queued until gateway returned 503s',
       i131.resolution = 'Pool size set to 400 with auto-scaling policy; load test added to CI for gateway config changes'
   MERGE (i131)-[:AFFECTS]->(gateway)
   MERGE (dana)-[:INVESTIGATED]->(i131)
   MERGE (sam)-[:INVESTIGATED]->(i131)`,

  // ── 9. Incidents — Scenario B: Auth failures ──────────────────────────────

  // INC-132: Auth Service token validation failures
  `MATCH (auth:Service {name: 'Auth Service'}), (checkout:Service {name: 'Checkout API'}),
         (riley:Engineer {name: 'Riley Moss'})
   MERGE (i132:Incident {id: 'INC-132'})
   SET i132.title      = 'Auth Service token validation failures — 15% of login requests rejected',
       i132.status     = 'resolved',
       i132.severity   = 'high',
       i132.rootCause  = 'Token-signing key rotation in DEP-2051 shortened rotation window to 30 days; tokens issued 31+ days ago were rejected before clients could refresh',
       i132.resolution = 'Extended grace period for old signing keys to 7 days post-rotation; added proactive token refresh nudge in Auth SDK'
   MERGE (i132)-[:AFFECTS]->(auth)
   MERGE (i132)-[:INVOLVES]->(checkout)
   MERGE (riley)-[:INVESTIGATED]->(i132)`,

  // INC-133: Web App login errors (downstream cascade from INC-132)
  `MATCH (webapp:Service {name: 'Web App'}), (auth:Service {name: 'Auth Service'}),
         (dana:Engineer {name: 'Dana Kim'}), (riley:Engineer {name: 'Riley Moss'})
   MERGE (i133:Incident {id: 'INC-133'})
   SET i133.title      = 'Web App login page showing 401 errors for returning users',
       i133.status     = 'resolved',
       i133.severity   = 'high',
       i133.rootCause  = 'Cascade from INC-132: Auth Service rejected existing tokens; Web App did not handle 401 gracefully and showed blank error page instead of re-login prompt',
       i133.resolution = 'Web App updated to redirect 401 responses to login flow; added Auth Service health check to Web App startup probe'
   MERGE (i133)-[:AFFECTS]->(webapp)
   MERGE (i133)-[:INVOLVES]->(auth)
   MERGE (dana)-[:INVESTIGATED]->(i133)
   MERGE (riley)-[:INVESTIGATED]->(i133)`,

  // ── 10. Incidents — Scenario C: Refund processing delays ──────────────────

  // INC-134: Refund processing delays
  `MATCH (refund:Service {name: 'Refund Service'}), (payment:Service {name: 'Payment Service'}),
         (ledger:Service {name: 'Ledger Service'}),
         (quinn:Engineer {name: 'Quinn Torres'}), (avery:Engineer {name: 'Avery Chen'})
   MERGE (i134:Incident {id: 'INC-134'})
   SET i134.title      = 'Refund processing delays — refunds taking 4+ hours instead of under 5 minutes',
       i134.status     = 'resolved',
       i134.severity   = 'high',
       i134.rootCause  = 'Ledger Service batch commit in DEP-2053 held write locks longer than expected; Refund Service payment reversals queued behind batch commits and timed out',
       i134.resolution = 'Reduced Ledger batch size from 100 to 25 for reversal transactions; Refund Service now uses a dedicated Ledger write endpoint with higher priority'
   MERGE (i134)-[:AFFECTS]->(refund)
   MERGE (i134)-[:INVOLVES]->(payment)
   MERGE (i134)-[:INVOLVES]->(ledger)
   MERGE (quinn)-[:INVESTIGATED]->(i134)
   MERGE (avery)-[:INVESTIGATED]->(i134)`,

  // INC-135: Ledger reconciliation failures (follow-up to INC-134)
  `MATCH (ledger:Service {name: 'Ledger Service'}), (quinn:Engineer {name: 'Quinn Torres'})
   MERGE (i135:Incident {id: 'INC-135'})
   SET i135.title      = 'Daily ledger reconciliation job failing with checksum mismatch',
       i135.status     = 'investigating',
       i135.severity   = 'medium',
       i135.rootCause  = 'Batch checksum validation added in DEP-2053 exposed pre-existing floating-point rounding inconsistencies in currency conversion; reconciliation job uses strict equality checks',
       i135.resolution = null
   MERGE (i135)-[:AFFECTS]->(ledger)
   MERGE (quinn)-[:INVESTIGATED]->(i135)`,

  // ── 11. Additional incidents ───────────────────────────────────────────────

  // INC-136: Notification delivery backlog
  `MATCH (notify:Service {name: 'Notification Service'}), (checkout:Service {name: 'Checkout API'}),
         (morgan:Engineer {name: 'Morgan Ellis'})
   MERGE (i136:Incident {id: 'INC-136'})
   SET i136.title      = 'Notification delivery backlog — order confirmation emails delayed by 45 minutes',
       i136.status     = 'resolved',
       i136.severity   = 'low',
       i136.rootCause  = 'Email provider rate limit hit during a promotional campaign; worker scaling in DEP-2054 increased throughput but also hit the provider cap faster',
       i136.resolution = 'Added provider-level rate limiter in Notification Service; switched to bulk email API endpoint to improve throughput per rate-limit token'
   MERGE (i136)-[:AFFECTS]->(notify)
   MERGE (i136)-[:INVOLVES]->(checkout)
   MERGE (morgan)-[:INVESTIGATED]->(i136)`,

  // INC-137: Analytics pipeline stale — ownership gap demo
  // Intentionally has no engineer investigator to demonstrate the gap
  `MATCH (analytics:Service {name: 'Analytics Service'}), (ledger:Service {name: 'Ledger Service'})
   MERGE (i137:Incident {id: 'INC-137'})
   SET i137.title      = 'Analytics dashboard showing stale data — 6 hours behind real time',
       i137.status     = 'open',
       i137.severity   = 'low',
       i137.rootCause  = null,
       i137.resolution = null
   MERGE (i137)-[:AFFECTS]->(analytics)
   MERGE (i137)-[:INVOLVES]->(ledger)`,
  // Note: no engineer is assigned to INC-137 — Analytics Service has no repository or maintainer.
  // This is intentional: it surfaces as an ownership gap in offboarding and investigation reports.

];

try {
  const graph = db.selectGraph('synapse');

  console.log('Applying NexusPay seed statements…');
  for (let i = 0; i < statements.length; i++) {
    try {
      await graph.query(statements[i]);
    } catch (err) {
      // Surface the failing statement index and a trimmed preview for debugging
      const preview = statements[i].trim().slice(0, 120).replace(/\s+/g, ' ');
      console.error(`Statement ${i} failed: ${err.message}\n  → ${preview}…`);
      throw err;
    }
  }

  console.log('\n✓ NexusPay seed applied successfully (idempotent — safe to re-run).\n');

  // ── Verification queries ──────────────────────────────────────────────────

  const labelCounts = await graph.query(
    'MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count ORDER BY label',
  );
  console.log('Node counts by label:');
  console.table(labelCounts.data);

  const relCounts = await graph.query(
    'MATCH ()-[r]->() RETURN type(r) AS relationship, count(r) AS count ORDER BY relationship',
  );
  console.log('Relationship counts by type:');
  console.table(relCounts.data);

  // Verify ownership: solo-maintained services
  const solo = await graph.query(`
    MATCH (e:Engineer)-[:MAINTAINS]->(r:Repository)<-[:IMPLEMENTED_IN]-(s:Service)
    WITH s, collect(e.name) AS maintainers
    WHERE size(maintainers) = 1
    RETURN s.name AS service, maintainers[0] AS sole_maintainer
    ORDER BY service
  `);
  console.log('\nSolo-maintained services (single point of failure):');
  console.table(solo.data);

  // Verify unowned services (no repo or no maintainer)
  const unowned = await graph.query(`
    MATCH (s:Service)
    WHERE NOT (s)-[:IMPLEMENTED_IN]->(:Repository)<-[:MAINTAINS]-(:Engineer)
    RETURN s.name AS unowned_service
    ORDER BY unowned_service
  `);
  console.log('\nServices with no recorded maintainer (ownership gaps):');
  console.table(unowned.data);

  // Verify service dependency chain
  const depChain = await graph.query(`
    MATCH (webapp:Service {name: 'Web App'})-[:DEPENDS_ON*1..4]->(leaf:Service)
    RETURN webapp.name AS from, leaf.name AS to
    ORDER BY leaf.name
  `);
  console.log('\nDependency chains from Web App:');
  console.table(depChain.data);

  // Verify incidents with no investigator (gaps)
  const uninvestigated = await graph.query(`
    MATCH (i:Incident)
    WHERE NOT (:Engineer)-[:INVESTIGATED]->(i)
    RETURN i.id AS incident, i.title AS title, i.status AS status
    ORDER BY i.id
  `);
  console.log('\nIncidents with no recorded investigator:');
  console.table(uninvestigated.data);

} catch (err) {
  console.error('\n✗ NexusPay seed failed:', err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
