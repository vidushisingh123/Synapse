# Synapse

AI-powered company knowledge graph and investigation agent .
All data is synthetic and fictional.

## Architecture

```
React (Vite)  ──HTTP──►  Express API  ──Cypher──►  FalkorDB (graph "synapse")
                              │
                              └─► LLM agent (Anthropic API, server-side key only)
                                    calls 6 fixed graph tools, cites evidence IDs
```

- **Tools** (`backend/src/graph/tools.js`): parameterised Cypher only. The LLM chooses tools and arguments but never writes Cypher.
- **Agent** (`backend/src/agent.js`): tool-use loop. Every tool result becomes evidence `E1…En`. The report separates **facts** (must cite evidence) from **hypotheses** (with confidence). Invalid citations are dropped, and uncited "facts" are demoted to hypotheses.
- **Fallback**: with no `ANTHROPIC_API_KEY`, or if the LLM call fails, a deterministic graph-only investigation runs on the same tools.

## Graph schema

Nodes: `Service{name}`, `Incident{id,title,status,severity,rootCause,resolution}`, `Repository{name,url}`, `Engineer{name,expertise}`, `Deployment{id,version,deployedAt,summary}`

Relationships:
`(Service)-[:DEPENDS_ON]->(Service)`, `(Incident)-[:AFFECTS]->(Service)`, `(Incident)-[:INVOLVES]->(Service)`,
`(Service)-[:IMPLEMENTED_IN]->(Repository)`, `(Engineer)-[:MAINTAINS]->(Repository)`,
`(Engineer)-[:INVESTIGATED]->(Incident)`, `(Deployment)-[:DEPLOYED_TO]->(Service)`, `(Engineer)-[:AUTHORED]->(Deployment)`

## Cypher examples

```cypher
// What does Checkout transitively depend on?
MATCH p=(s:Service {name:'Checkout API'})-[:DEPENDS_ON*1..3]->(d:Service)
RETURN d.name, min(length(p)) AS depth

// Past incidents touching Checkout or its dependencies
MATCH (i:Incident)-[:AFFECTS|INVOLVES]->(s:Service)
WHERE s.name IN ['Checkout API','Payment Service','Inventory Service']
RETURN i.id, i.title, i.rootCause

// Who maintains code behind a service
MATCH (s:Service {name:'Payment Service'})-[:IMPLEMENTED_IN]->(r)<-[:MAINTAINS]-(e:Engineer)
RETURN e.name, r.name
```

## Setup

1. Start FalkorDB: `docker run -p 6379:6379 -it --rm falkordb/falkordb` (or your existing container).
2. Backend:
```bash
   cd backend
   npm install
   npm install @anthropic-ai/sdk
   # .env: FALKORDB_HOST, FALKORDB_PORT, PORT=4000, CORS_ORIGIN=http://localhost:5173,
   #       ANTHROPIC_API_KEY=..., ANTHROPIC_MODEL=claude-sonnet-5-5
   npm run seed-graph
   npm run seed-demo
   npm run test-tools
   npm run dev
```
3. Frontend:
```bash
   cd frontend
   npm install
   npm run dev      # http://localhost:5173 (set VITE_API_URL if the API is not on :4000)
```

## API

- `GET /api/health`
- `GET /api/graph`
- `GET /api/tools`, `POST /api/tools/:name` with a JSON body like `{"service":"Checkout API"}`
- `POST /api/investigate` with `{"question":"..."}`

## Demo script

1. Open the dashboard and click **Use demo question**, then **Investigate**.
2. Walk through: affected services → past incidents (INC-101) → latest deployment DEP-2041 → recommended engineer (Avery Chen).
3. Point out facts vs hypotheses and the clickable evidence IDs (E1…), and the highlighted subgraph.
4. Click an evidence ID to show the raw graph rows that back the claim.