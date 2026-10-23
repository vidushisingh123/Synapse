import { query } from '../db.js';

export class ToolError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ToolError';
    this.status = status;
  }
}

async function allServiceNames() {
  const rows = await query('MATCH (s:Service) RETURN s.name AS name ORDER BY name');
  return rows.map((r) => r.name);
}

async function resolveService(input) {
  const wanted = String(input ?? '').trim().toLowerCase();
  const names = await allServiceNames();
  const hit =
    wanted &&
    (names.find((n) => n.toLowerCase() === wanted) ||
      names.find((n) => n.toLowerCase().includes(wanted)));
  if (!hit) {
    throw new ToolError(`No service matches "${input ?? ''}". Known services: ${names.join(', ')}`);
  }
  return hit;
}

/**
 * The service, everything it depends on within 2 hops, and the services that call it directly (1 hop upstream).
 * Callers are included because a symptom on a service is often caused by its caller (e.g. a gateway
 * config change), and that evidence would otherwise be invisible to every scoped tool.
 */
async function scopeFor(service) {
  const down = await query(
    'MATCH (s:Service {name: $name})-[:DEPENDS_ON*1..2]->(d:Service) RETURN DISTINCT d.name AS name',
    { name: service },
  );
  const up = await query(
    'MATCH (u:Service)-[:DEPENDS_ON]->(s:Service {name: $name}) RETURN DISTINCT u.name AS name',
    { name: service },
  );
  return [...new Set([service, ...down.map((r) => r.name), ...up.map((r) => r.name)])];
}

const serviceInput = {
  type: 'object',
  properties: { service: { type: 'string', description: 'Service name, e.g. "Checkout API"' } },
  required: ['service'],
};

export const TOOLS = {
  search_services: {
    description: 'List services in the graph, optionally filtered by a keyword. Use this first to find exact service names.',
    input_schema: { type: 'object', properties: { keyword: { type: 'string' } } },
    async run({ keyword } = {}) {
      const k = String(keyword ?? '').toLowerCase();
      const names = await allServiceNames();
      return { services: names.filter((n) => !k || n.toLowerCase().includes(k)) };
    },
  },

  get_service_dependencies: {
    description: 'Get what a service depends on (downstream, up to 3 hops) and which services depend on it (upstream).',
    input_schema: serviceInput,
    async run(input) {
      const service = await resolveService(input?.service);
      const dependsOn = await query(
        `MATCH p=(s:Service {name: $name})-[:DEPENDS_ON*1..3]->(d:Service)
         RETURN d.name AS name, min(length(p)) AS depth ORDER BY depth, name`,
        { name: service },
      );
      const dependents = await query(
        `MATCH p=(u:Service)-[:DEPENDS_ON*1..3]->(s:Service {name: $name})
         RETURN u.name AS name, min(length(p)) AS depth ORDER BY depth, name`,
        { name: service },
      );
      return { service, dependsOn, dependents };
    },
  },

  get_related_incidents: {
    description: 'Past incidents that affected or involved the service, its dependencies (2 hops) or its direct callers, with status, severity, root cause and resolution.',
    input_schema: serviceInput,
    async run(input) {
      const service = await resolveService(input?.service);
      const names = await scopeFor(service);
      const rows = await query(
        `MATCH (i:Incident)-[r:AFFECTS|INVOLVES]->(s:Service)
         WHERE s.name IN $names
         RETURN i.id AS id, i.title AS title, i.status AS status, i.severity AS severity,
                i.rootCause AS rootCause, i.resolution AS resolution,
                type(r) AS relationship, s.name AS service
         ORDER BY i.id`,
        { names },
      );
      const byId = new Map();
      for (const r of rows) {
        if (!byId.has(r.id)) {
          byId.set(r.id, {
            id: r.id, title: r.title, status: r.status, severity: r.severity,
            rootCause: r.rootCause, resolution: r.resolution, links: [],
          });
        }
        byId.get(r.id).links.push({ relationship: r.relationship, service: r.service });
      }
      return { service, searchedServices: names, incidents: [...byId.values()] };
    },
  },

  get_recent_deployments: {
    description: 'Most recent deployments (newest first, max 5) to the service, its dependencies or its direct callers. Useful for finding a likely trigger.',
    input_schema: serviceInput,
    async run(input) {
      const service = await resolveService(input?.service);
      const names = await scopeFor(service);
      const deployments = await query(
        `MATCH (d:Deployment)-[:DEPLOYED_TO]->(s:Service)
         WHERE s.name IN $names
         RETURN d.id AS id, d.version AS version, d.deployedAt AS deployedAt,
                d.summary AS summary, s.name AS service
         ORDER BY d.deployedAt DESC LIMIT 5`,
        { names },
      );
      return { service, searchedServices: names, deployments };
    },
  },

  get_repositories: {
    description: 'Repositories implementing the service, its dependencies and its direct callers. Also lists services with no repository recorded.',
    input_schema: serviceInput,
    async run(input) {
      const service = await resolveService(input?.service);
      const names = await scopeFor(service);
      const repositories = await query(
        `MATCH (s:Service)-[:IMPLEMENTED_IN]->(r:Repository)
         WHERE s.name IN $names
         RETURN s.name AS service, r.name AS repository, r.url AS url`,
        { names },
      );
      const covered = new Set(repositories.map((r) => r.service));
      return {
        service,
        repositories,
        servicesWithoutRepository: names.filter((n) => !covered.has(n)),
      };
    },
  },

  get_engineers: {
    description: 'Engineers relevant to the service, its dependencies and its direct callers: repository maintainers, past incident investigators, and deployment authors, ranked by relevance.',
    input_schema: serviceInput,
    async run(input) {
      const service = await resolveService(input?.service);
      const names = await scopeFor(service);
      const maintainers = await query(
        `MATCH (s:Service)-[:IMPLEMENTED_IN]->(r:Repository)<-[:MAINTAINS]-(e:Engineer)
         WHERE s.name IN $names
         RETURN e.name AS name, e.expertise AS expertise, r.name AS repository, s.name AS service`,
        { names },
      );
      const investigators = await query(
        `MATCH (e:Engineer)-[:INVESTIGATED]->(i:Incident)-[:AFFECTS|INVOLVES]->(s:Service)
         WHERE s.name IN $names
         RETURN DISTINCT e.name AS name, e.expertise AS expertise, i.id AS incident, s.name AS service`,
        { names },
      );
      const authors = await query(
        `MATCH (e:Engineer)-[:AUTHORED]->(d:Deployment)-[:DEPLOYED_TO]->(s:Service)
         WHERE s.name IN $names
         RETURN DISTINCT e.name AS name, e.expertise AS expertise, d.id AS deployment, s.name AS service`,
        { names },
      );

      const people = new Map();
      const person = (r) => {
        if (!people.has(r.name)) {
          people.set(r.name, { name: r.name, expertise: r.expertise, maintains: [], investigated: [], authoredDeployments: [], score: 0 });
        }
        return people.get(r.name);
      };
      for (const r of maintainers) {
        const p = person(r);
        p.maintains.push({ repository: r.repository, service: r.service });
        p.score += r.service === service ? 4 : 2;
      }
      for (const r of investigators) {
  const p = person(r);
  if (!p.investigated.some((x) => x.incident === r.incident)) p.score += 1;
  p.investigated.push({ incident: r.incident, service: r.service });
}
      for (const r of authors) {
        const p = person(r);
        p.authoredDeployments.push({ deployment: r.deployment, service: r.service });
        p.score += 2;
      }
      const engineers = [...people.values()].sort((a, b) => b.score - a.score);
      return { service, searchedServices: names, engineers };
    },
  },

  get_offboarding_risk: {
    description:
      'Given an engineer name, returns the services they solely maintain (no other maintainer on record), services with no maintainer at all, incidents they uniquely investigated, their recent deployments (institutional knowledge at risk), and the blast-radius services that depend on their services. Use this for offboarding, knowledge-continuity, or bus-factor questions.',
    input_schema: {
      type: 'object',
      properties: {
        engineer: { type: 'string', description: 'Full engineer name, e.g. "Avery Chen"' },
      },
      required: ['engineer'],
    },
    async run({ engineer } = {}) {
      const name = String(engineer ?? '').trim();
      if (!name) throw new ToolError('engineer name is required');

      // Verify engineer exists
      const engRows = await query(
        'MATCH (e:Engineer {name: $name}) RETURN e.name AS name, e.expertise AS expertise',
        { name },
      );
      if (!engRows.length) {
        const all = await query('MATCH (e:Engineer) RETURN e.name AS name ORDER BY name');
        throw new ToolError(
          `No engineer named "${name}" in the graph. Known engineers: ${all.map((r) => r.name).join(', ')}`,
        );
      }
      const expertise = engRows[0].expertise ?? null;

      // 1. Services this engineer maintains (via MAINTAINS→Repository←IMPLEMENTED_IN)
      const maintainedRows = await query(
        `MATCH (e:Engineer {name: $name})-[:MAINTAINS]->(r:Repository)<-[:IMPLEMENTED_IN]-(s:Service)
         RETURN s.name AS service, r.name AS repository`,
        { name },
      );

      // 2. For each maintained repo, find other maintainers
      const ownedServices = [];
      const soloMaintained = [];
      for (const row of maintainedRows) {
        const others = await query(
          `MATCH (r:Repository {name: $repo})<-[:MAINTAINS]-(other:Engineer)
           WHERE other.name <> $name
           RETURN other.name AS name`,
          { repo: row.repository, name },
        );
        const otherMaintainers = others.map((r) => r.name);
        ownedServices.push({
          service: row.service,
          repository: row.repository,
          hasOtherMaintainer: otherMaintainers.length > 0,
          otherMaintainers,
        });
        if (!otherMaintainers.length) soloMaintained.push(row.service);
      }

      // 3. Services with NO maintainer at all (no Engineer→MAINTAINS→Repo←IMPLEMENTED_IN path)
      const unownedRows = await query(
        `MATCH (s:Service)
         WHERE NOT (s)-[:IMPLEMENTED_IN]->(:Repository)<-[:MAINTAINS]-(:Engineer)
         RETURN s.name AS name ORDER BY name`,
      );
      const unownedServices = unownedRows.map((r) => r.name);

      // 4. Incidents uniquely investigated by this engineer (no other investigator on record)
      const incidentRows = await query(
        `MATCH (e:Engineer {name: $name})-[:INVESTIGATED]->(i:Incident)
         RETURN i.id AS id, i.title AS title, i.severity AS severity, i.status AS status`,
        { name },
      );
      const uniquelyInvestigated = [];
      for (const inc of incidentRows) {
        const otherInv = await query(
          `MATCH (other:Engineer)-[:INVESTIGATED]->(i:Incident {id: $id})
           WHERE other.name <> $name
           RETURN other.name AS name`,
          { id: inc.id, name },
        );
        if (!otherInv.length) {
          uniquelyInvestigated.push({ id: inc.id, title: inc.title, severity: inc.severity, status: inc.status });
        }
      }

      // 5. Recent deployments authored (newest 5) — operational knowledge at risk
      const deploymentRows = await query(
        `MATCH (e:Engineer {name: $name})-[:AUTHORED]->(d:Deployment)-[:DEPLOYED_TO]->(s:Service)
         RETURN d.id AS id, d.version AS version, d.deployedAt AS deployedAt,
                d.summary AS summary, s.name AS service
         ORDER BY d.deployedAt DESC LIMIT 5`,
        { name },
      );

      // 6. Blast radius: services that depend on any of the engineer's solo-maintained services
      const dependentRows = soloMaintained.length
        ? await query(
            `MATCH (up:Service)-[:DEPENDS_ON*1..3]->(s:Service)
             WHERE s.name IN $services AND up.name <> s.name
             RETURN DISTINCT up.name AS dependent, s.name AS ownedService
             ORDER BY ownedService, dependent`,
            { services: soloMaintained },
          )
        : [];

      return {
        engineer: name,
        expertise,
        ownedServices,
        soloMaintained,
        unownedServices,
        uniquelyInvestigatedIncidents: uniquelyInvestigated,
        recentDeployments: deploymentRows,
        dependentServices: dependentRows,
      };
    },
  },
};

export const TOOL_DEFINITIONS = Object.entries(TOOLS).map(([name, t]) => ({
  name,
  description: t.description,
  input_schema: t.input_schema,
}));

export async function runTool(name, input = {}) {
  const tool = TOOLS[name];
  if (!tool) throw new ToolError(`Unknown tool "${name}"`, 404);
  return tool.run(input);
}

/** Whole graph as nodes + edges (small demo graph) for the dashboard visualisation. */
export async function getGraphSnapshot() {
  const rows = await query(
    `MATCH (a)-[r]->(b)
     RETURN labels(a)[0] AS aLabel, coalesce(a.name, a.id) AS aName,
            type(r) AS rel,
            labels(b)[0] AS bLabel, coalesce(b.name, b.id) AS bName`,
  );
  const nodes = new Map();
  const edges = [];
  const key = (label, name) => `${label}:${name}`;
  for (const r of rows) {
    const a = key(r.aLabel, r.aName);
    const b = key(r.bLabel, r.bName);
    nodes.set(a, { id: a, label: r.aLabel, name: r.aName });
    nodes.set(b, { id: b, label: r.bLabel, name: r.bName });
    edges.push({ source: a, target: b, type: r.rel });
  }
  return { nodes: [...nodes.values()], edges };
}