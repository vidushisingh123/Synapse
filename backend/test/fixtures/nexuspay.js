// In-memory stand-in for the graph tools, shaped exactly like their real return values and
// populated from seed-nexuspay.js (INC-130/131/132/136, DEP-2050/2051, Checkout API dependencies).
// INC-101's rootCause and the older Fraud Check deployment come from seed-demo.js, which was not provided,
// so those two values here are test data, not copies of the seed.
import { ToolError } from '../../src/graph/tools.js';

const SERVICES = ['API Gateway', 'Analytics Service', 'Auth Service', 'Checkout API', 'Fraud Check', 'Inventory Service',
  'Ledger Service', 'Notification Service', 'Payment Service', 'Refund Service', 'Web App'];

const INC = {
  'INC-130': { id: 'INC-130', title: 'Checkout API elevated latency — p99 above 8 seconds', status: 'resolved', severity: 'high',
    rootCause: 'API Gateway connection pool reduction in DEP-2050 caused upstream queuing; Payment Service timeout cascaded to Checkout API response times',
    resolution: 'Reverted API Gateway pool size to 400; added per-route timeout overrides so payment calls are not throttled by gateway defaults',
    links: [{ relationship: 'AFFECTS', service: 'Checkout API' }, { relationship: 'INVOLVES', service: 'Payment Service' }, { relationship: 'INVOLVES', service: 'API Gateway' }] },
  'INC-101': { id: 'INC-101', title: 'Payment timeouts during checkout', status: 'resolved', severity: 'high',
    rootCause: null, resolution: null,
    links: [{ relationship: 'AFFECTS', service: 'Checkout API' }, { relationship: 'INVOLVES', service: 'Payment Service' }] },
  'INC-132': { id: 'INC-132', title: 'Auth Service token validation failures — 15% of login requests rejected', status: 'resolved', severity: 'high',
    rootCause: 'Token-signing key rotation in DEP-2051 shortened rotation window to 30 days; tokens issued 31+ days ago were rejected before clients could refresh',
    resolution: 'Extended grace period for old signing keys to 7 days post-rotation',
    links: [{ relationship: 'AFFECTS', service: 'Auth Service' }, { relationship: 'INVOLVES', service: 'Checkout API' }] },
  'INC-131': { id: 'INC-131', title: 'API Gateway connection pool exhausted under peak load', status: 'resolved', severity: 'medium',
    rootCause: 'Pool size of 200 (set in DEP-2050) was insufficient for Black-Friday-scale traffic; connections queued until gateway returned 503s',
    resolution: 'Pool size set to 400 with auto-scaling policy', links: [{ relationship: 'AFFECTS', service: 'API Gateway' }] },
  'INC-136': { id: 'INC-136', title: 'Notification delivery backlog — order confirmation emails delayed by 45 minutes', status: 'resolved', severity: 'low',
    rootCause: 'Email provider rate limit hit during a promotional campaign', resolution: 'Added provider-level rate limiter',
    links: [{ relationship: 'AFFECTS', service: 'Notification Service' }, { relationship: 'INVOLVES', service: 'Checkout API' }] },
};

const DEPLOYMENTS = [
  { id: 'DEP-2051', version: 'v2.8.0', deployedAt: '2026-10-16T07:20:00Z', service: 'Auth Service',
    summary: 'Automated TLS certificate rotation using cert-manager; removed manual renewal cron job; updated token-signing key rotation schedule from 90d to 30d' },
  { id: 'DEP-2050', version: 'v3.1.0', deployedAt: '2026-10-15T18:45:00Z', service: 'API Gateway',
    summary: 'Reduced API Gateway HTTP connection pool size from 500 to 200 to limit downstream pressure; also tightened upstream timeout from 30s to 8s' },
  { id: 'DEP-1900', version: 'v1.2.0', deployedAt: '2026-09-01T10:00:00Z', service: 'Fraud Check', summary: 'Updated model thresholds' },
];

const CHECKOUT_SCOPE = ['Checkout API', 'Payment Service', 'Inventory Service', 'Auth Service', 'Notification Service', 'Fraud Check', 'Ledger Service', 'API Gateway'];

const tools = {
  search_services: () => ({ services: SERVICES }),
  get_service_dependencies: ({ service }) => {
    if (service !== 'Checkout API') return { service, dependsOn: [], dependents: [] };
    return {
      service,
      dependsOn: [['Auth Service', 1], ['Inventory Service', 1], ['Notification Service', 1], ['Payment Service', 1], ['Fraud Check', 2], ['Ledger Service', 2]]
        .map(([name, depth]) => ({ name, depth })),
      dependents: [{ name: 'API Gateway', depth: 1 }, { name: 'Web App', depth: 2 }],
    };
  },
  get_related_incidents: ({ service }) => ({
    service, searchedServices: CHECKOUT_SCOPE, incidents: Object.values(INC).filter((i) => i.links.some((l) => CHECKOUT_SCOPE.includes(l.service))),
  }),
  get_recent_deployments: ({ service }) => ({ service, searchedServices: CHECKOUT_SCOPE, deployments: DEPLOYMENTS }),
  get_repositories: ({ service }) => ({
    service, repositories: [{ service: 'API Gateway', repository: 'api-gateway', url: 'https://github.com/nexuspay/api-gateway' }],
    servicesWithoutRepository: ['Checkout API'].filter(() => false),
  }),
  get_engineers: ({ service }) => {
    if (['Refund Service', 'Ledger Service'].includes(service)) {
      return { service, searchedServices: [service], engineers: [{ name: 'Quinn Torres', expertise: 'Ledger', maintains: [{ repository: 'ledger-service', service: 'Ledger Service' }], investigated: [], authoredDeployments: [], score: 4 }] };
    }
    if (service !== 'Checkout API') return { service, searchedServices: [service], engineers: [] };
    return { service, searchedServices: CHECKOUT_SCOPE, engineers: [
      { name: 'Sam Okafor', expertise: 'Checkout', maintains: [{ repository: 'api-gateway', service: 'API Gateway' }], investigated: [{ incident: 'INC-130', service: 'Checkout API' }], authoredDeployments: [], score: 3 },
      { name: 'Dana Kim', expertise: 'Frontend and web platform', maintains: [{ repository: 'api-gateway', service: 'API Gateway' }], investigated: [], authoredDeployments: [{ deployment: 'DEP-2050', service: 'API Gateway' }], score: 4 },
    ] };
  },
  get_offboarding_risk: ({ engineer }) => {
    if (engineer !== 'Quinn Torres') throw new ToolError(`No engineer named "${engineer}" in the graph. Known engineers: Quinn Torres`);
    return { engineer, expertise: 'Ledger', ownedServices: [{ service: 'Ledger Service', repository: 'ledger-service', hasOtherMaintainer: false, otherMaintainers: [] }],
      soloMaintained: ['Ledger Service'], unownedServices: ['Analytics Service'], uniquelyInvestigatedIncidents: [],
      recentDeployments: [], dependentServices: [{ dependent: 'Payment Service', ownedService: 'Ledger Service' }] };
  },
};

/** A tool runner with the same (name, input) signature as runTool. */
export const fakeRun = async (name, input = {}) => {
  if (!tools[name]) throw new ToolError(`Unknown tool "${name}"`, 404);
  return tools[name](input);
};

export const QUESTION = 'Why is Checkout API experiencing delays, and which dependent services should I investigate?';
