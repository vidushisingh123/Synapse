# Synapse
### An AI-powered engineering knowledge graph and investigation agent

Synapse connects engineering knowledge across services, repositories, incidents, deployments and engineers to help teams investigate technical issues, understand dependencies, discover ownership gaps and reduce knowledge-continuity risks.

Built for **Graph Hacks 2026 — WeMakeDevs × FalkorDB**.

> **Primary track:** Company Brain  
> **Also relevant, if selected in the submission:** Agents That Act on Connected Data

## The problem

Engineering knowledge is often fragmented across services, repositories, incidents, deployment records and individual engineers. When an incident occurs, teams must piece together these connections manually. When an engineer leaves, important service knowledge and ownership can be difficult to identify.

Synapse models these relationships as a graph and uses graph-backed tools to retrieve relevant context for an investigation. The agent presents findings with supporting evidence so that users can inspect the basis of an answer.

## What Synapse does

- **Incident investigation:** Investigate engineering issues using connected graph data.
- **Dependency impact analysis:** Explore which services may be affected by a dependency failure.
- **Root-cause assessment:** Present an evidence-based assessment while distinguishing historical recorded causes from possible explanations.
- **Ownership discovery:** Identify engineers associated with services and repositories, and reveal ownership gaps.
- **Knowledge continuity:** Highlight potential knowledge risks and handover priorities when an engineer leaves.
- **Evidence-backed reports:** Present findings, relevant evidence, next steps and knowledge gaps.
- **Investigation history:** Preserve previous investigations in the browser.
- **Graceful fallback:** When the LLM is unavailable or fails to use graph tools, the application can provide graph-only analysis where the relevant fallback is implemented.

## Why FalkorDB matters

FalkorDB is the graph database at the center of Synapse's engineering knowledge model. The application uses connected entities and relationships to retrieve context for investigations, rather than relying only on isolated text records.

The graph represents relationships among services, repositories, engineers, incidents and deployments. These connections support questions about service dependencies, incident context, ownership and knowledge continuity.

The graph is not intended to be a decorative visualization. The graph queries and tools that power investigations are part of the product's core behavior.

## Architecture

```text
User
 |
 v
React + Vite frontend
 |
 v
Express backend
 |
 +----> Investigation agent and graph tools
 |                |
 |                +----> FalkorDB graph queries
 |                |
 |                +----> Groq LLM (when available)
 |
 +----> Structured investigation report
                  |
                  v
       Findings, evidence and next steps
```

### Technology stack

- **Frontend:** React, Vite, JavaScript and CSS
- **Backend:** Node.js and Express
- **Graph database:** FalkorDB
- **LLM integration:** Groq, configured through environment variables
- **Local infrastructure:** Docker
- **Testing:** Node.js built-in test runner and frontend production build

The graph-only fallback is designed to keep supported investigation paths useful when LLM calls fail. Its results should not be confused with a successful LLM-backed response.

## Graph data model

The current synthetic NexusPay dataset includes the following node labels:

| Node label | Purpose |
|---|---|
| `Service` | Engineering services and their dependencies |
| `Repository` | Code repositories associated with services |
| `Engineer` | People associated with ownership and engineering knowledge |
| `Incident` | Historical incidents and their relationships |
| `Deployment` | Deployment records connected to services |

Relationship types used in the graph include:

| Relationship | Meaning |
|---|---|
| `DEPENDS_ON` | A service depends on another service |
| `IMPLEMENTED_IN` | A service is implemented in a repository |
| `MAINTAINS` | An engineer maintains a service |
| `AUTHORED` | An engineer authored a repository or associated artifact |
| `INVESTIGATED` | An engineer investigated an incident |
| `AFFECTS` / `INVOLVES` | An incident is associated with affected or involved entities |
| `DEPLOYED_TO` | A deployment is associated with a target entity |

The seed scripts populate synthetic engineering data. Counts and relationships can change as the dataset evolves, so inspect the current seed output before treating any totals as authoritative.

## Representative Cypher query patterns

These examples illustrate the kinds of relationship traversals used by Synapse. Confirm node properties and relationship directions against the current seed scripts and backend queries before relying on them as exact production queries.

### 1. Explore service dependencies

```cypher
MATCH (s:Service)-[:DEPENDS_ON]->(dependency:Service)
RETURN s, dependency
LIMIT 50
```

This explores service-to-service dependencies.

### 2. Find engineers who maintain services

```cypher
MATCH (e:Engineer)-[:MAINTAINS]->(s:Service)
RETURN e, s
LIMIT 50
```

This helps connect service ownership to engineering knowledge.

### 3. Connect services to repositories

```cypher
MATCH (s:Service)-[:IMPLEMENTED_IN]->(r:Repository)
RETURN s, r
LIMIT 50
```

This connects a service to the repository where its implementation lives.

### 4. Trace multi-hop dependency paths

```cypher
MATCH p = (source:Service)-[:DEPENDS_ON*1..3]->(target:Service)
RETURN p
LIMIT 50
```

This explores dependency paths up to three relationship hops. Use appropriate bounds and limits for the size of the graph.

### 5. Explore incident relationships

```cypher
MATCH (i:Incident)-[r]-(related)
RETURN i, r, related
LIMIT 50
```

This inspects incident relationships. The application should use more specific patterns and filters for individual investigations.

**Implementation note:** These are representative Cypher patterns, not a claim that every application tool uses these exact statements. The authoritative query logic is in the backend graph tools and must be reviewed alongside the current graph schema.

## Getting started

### Prerequisites

- Node.js and npm
- Docker Desktop or another working Docker installation
- Git
- A Groq API key for LLM-backed investigations; graph-only functionality may remain available for supported paths without it

### 1. Clone the repository

```bash
git clone <YOUR_PUBLIC_REPOSITORY_URL>
cd Synapse
```

Replace the placeholder with the actual public repository URL.

### 2. Start FalkorDB

```bash
docker run -d --name Synapse-db \
  -p 6379:6379 \
  -p 3000:3000 \
  falkordb/falkordb
```

If the container already exists, start it with:

```bash
docker start Synapse-db
```

The port `6379` is used for the database connection. Port `3000` exposes the container's web interface if supported by the image configuration.

### 3. Configure the backend

Create `backend/.env` using the variable names required by the backend. For the current configuration, the expected values are similar to:

```dotenv
FALKORDB_HOST=127.0.0.1
FALKORDB_PORT=6379
PORT=4000
CORS_ORIGIN=http://localhost:5173
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=openai/gpt-oss-120b
```

Use your own API key locally. **Never commit `.env` or expose credentials in screenshots, logs or the frontend.** Check the actual backend configuration before changing the model name or any environment-variable names.

### 4. Install dependencies and seed the graph

In a Git Bash or another shell that supports `&&`:

```bash
cd backend
npm install
npm run seed-all
```

Alternatively, execute the seed scripts individually in this order:

```bash
npm run seed-graph
npm run seed-demo
npm run seed-offboarding
npm run seed-nexuspay
```

The seed scripts populate the synthetic graph used by the demonstrations. Run them against the intended local development database.

### 5. Start the backend

From the `backend` directory:

```bash
npm run dev
```

The backend is expected to listen on port `4000` under the default configuration.

### 6. Start the frontend

Open a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open the local URL printed by Vite, typically `http://localhost:5173`.

If your actual frontend script or environment differs, follow the scripts in the committed `frontend/package.json`.

## Example investigations

Use the following questions as a demo checklist. Their results depend on the current seeded graph and the implemented tools.

1. **Incident investigation:** Why is Checkout API experiencing elevated latency?
2. **Dependency impact:** What could be affected if Payment Service becomes unavailable?
3. **Incident context:** What do we know about refund processing incidents?
4. **Ownership:** What services does Riley Moss maintain?
5. **Ownership gaps:** What ownership gaps exist in the graph?
6. **Knowledge continuity:** If Avery Chen leaves next week, what knowledge is at risk and what handover tasks are most urgent?

## API overview

The backend has exposed the following routes during development. Verify them against the current server implementation before using them as a stable external API.

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Health check |
| `GET /api/graph` | Retrieve graph data |
| `GET /api/tools` | List available tools |
| `POST /api/tools/:name` | Invoke a named tool |
| `POST /api/investigate` | Run an investigation |

Request and response fields are defined by the current backend implementation.

## Testing

From the `backend` directory, run the complete Node.js test suite:

```bash
npm test
```

Run the focused regression suites individually or together when debugging:

```bash
node --test test/agent-rate-limit.test.js test/offboarding.test.js test/investigation.test.js
```

If the Checkout API latency regression test exists in the current repository, include it in verification:

```bash
node --test test/checkout-latency-regression.test.js
```

Build the frontend using its actual package script:

```bash
cd ../frontend
npm run build
```

Only report test counts and build results that were observed during the final verification run.

## Limitations and responsible interpretation

- The demo uses synthetic engineering data rather than live production telemetry.
- Findings are limited by the completeness and accuracy of the graph.
- A historical incident's recorded root cause is not proof of the cause of a new incident.
- A hypothesis or dependency correlation should not be presented as a confirmed operational cause.
- LLM availability and tool-use behavior may vary. Supported graph-only fallback paths do not guarantee that every investigation will have identical output.
- Recommended engineers and handover tasks are decision support; they do not replace human judgment.

## Demo video

The demo should show a working investigation, the graph connections behind its findings, evidence supporting the answer, and a knowledge-continuity scenario.

**Demo link:** Add the actual video URL after recording.

## AI assistance disclosure

AI coding assistants were used to support parts of the development process. The project authors are responsible for reviewing, testing, understanding and explaining the submitted implementation, including the graph model, Cypher queries, agent tools and technical decisions.

## Hackathon

Built for **Graph Hacks: Context for AI Agents**, organized by WeMakeDevs in collaboration with FalkorDB.

- Official event: https://www.wemakedevs.org/hackathons/falkordb
- Rules: https://www.wemakedevs.org/hackathons/falkordb/rules

## License

Add the license that applies to this repository. Do not claim an open-source license unless the repository includes the corresponding license file.