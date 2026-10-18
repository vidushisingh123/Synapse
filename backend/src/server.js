import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { query, closeDb, GRAPH_NAME } from './db.js';
import { TOOL_DEFINITIONS, runTool, getGraphSnapshot, ToolError } from './graph/tools.js';
import { investigate } from './agent.js';

const app = express();
app.use(cors({ origin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',') }));
app.use(express.json({ limit: '10kb' }));

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('FalkorDB did not respond in time')), ms)),
  ]);

app.get('/api/health', async (_req, res) => {
  try {
    const rows = await withTimeout(query('MATCH (n) RETURN count(n) AS nodes'), 3000);
    res.json({ status: 'ok', graph: GRAPH_NAME, nodes: rows[0]?.nodes ?? 0,   llmConfigured: Boolean(process.env.GROQ_API_KEY) });
  } catch (err) {
    res.status(503).json({ status: 'down', error: err.message });
  }
});

app.get('/api/graph', async (_req, res) => {
  res.json(await getGraphSnapshot());
});

app.get('/api/tools', (_req, res) => {
  res.json({ tools: TOOL_DEFINITIONS });
});

app.post('/api/tools/:name', async (req, res) => {
  const data = await runTool(req.params.name, req.body ?? {});
  res.json({ tool: req.params.name, data });
});

app.post('/api/investigate', async (req, res) => {
  const question = String(req.body?.question ?? '').trim();
  if (question.length < 5) throw new ToolError('Please enter a question (at least 5 characters).');
  if (question.length > 500) throw new ToolError('Question is too long (max 500 characters).');
  res.json({ question, ...(await investigate(question)) });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? `Server error: ${err.message}` : err.message });
});

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () => console.log(`Synapse API listening on http://localhost:${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await closeDb().catch(() => {});
    process.exit(0);
  });
}