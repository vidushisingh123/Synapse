// Live check of the MCP endpoint against a RUNNING backend (and therefore your real FalkorDB graph).
// It signs in with a normal account to get a fresh token (so it can never hit an expired one), then
// exercises tools/list and tools/call through the official MCP client.
//
//   node mcp-smoke.js
//
// Optional environment variables (names only; nothing is read from .env and nothing secret is printed):
//   SYNAPSE_URL       backend base URL           (default http://localhost:4000)
//   SYNAPSE_USERNAME  account to sign in with    (prompted if unset)
//   SYNAPSE_PASSWORD  its password               (prompted, hidden, if unset)
//   SYNAPSE_SERVICE   service to query           (default: first service returned by search_services)
//   SYNAPSE_ENGINEER  engineer for offboarding   (default "Avery Chen")
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = (process.env.SYNAPSE_URL || 'http://localhost:4000').replace(/\/+$/, '');
const EXPECTED_TOOLS = [
  'search_services', 'get_service_dependencies', 'get_related_incidents', 'get_recent_deployments',
  'get_repositories', 'get_engineers', 'get_offboarding_risk',
];

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  return ok;
};

function ask(prompt, hidden = false) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const canHide = hidden && typeof stdin.setRawMode === 'function';
    let buf = '';
    const finish = () => {
      if (canHide) stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      resolve(buf);
    };
    const onData = (chunk) => {
      for (const c of String(chunk)) {
        if (c === '\r' || c === '\n') return finish();
        if (c === '\u0003') process.exit(130); // Ctrl-C
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    if (canHide) stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function main() {
  const username = process.env.SYNAPSE_USERNAME || (await ask('Username: '));
  const password = process.env.SYNAPSE_PASSWORD || (await ask('Password: ', true));

  // 0. Unauthenticated access must be refused.
  const anon = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }).catch((e) => { throw new Error(`Cannot reach ${BASE}: ${e.message}. Is the backend running?`); });
  check(anon.status === 401, 'unauthenticated POST /mcp is refused', `HTTP ${anon.status}`);

  // 1. Sign in (fresh token every run).
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  if (!login.ok) throw new Error(`Login failed (HTTP ${login.status}). Check the username and password.`);
  const { token, expiresIn, user } = await login.json();
  console.log(`Signed in as ${user.username} (role: ${user.role}); token valid for ${expiresIn}s.`);

  // 2. Connect over Streamable HTTP and list tools.
  const client = new Client({ name: 'synapse-smoke', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
  } catch (err) {
    // Roles without tools:invoke (e.g. viewer) are meant to be refused by /mcp.
    if (/forbidden/i.test(err.message)) {
      check(true, `role "${user.role}" is refused by /mcp (needs tools:invoke)`);
      console.log('\nDone. To test the tools, sign in with an analyst or admin account.');
      process.exit(failures ? 1 : 0);
    }
    throw err;
  }
  const names = (await client.listTools()).tools.map((t) => t.name);
  console.log(`tools/list -> ${names.length} tool(s): ${names.join(', ') || '(none)'}`);
  const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
  check(names.length > 0, 'tools/list returns tools for this role');
  if (user.role === 'admin' || user.role === 'analyst') check(missing.length === 0, 'all 7 graph tools are registered', missing.join(', '));

  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), data: r.structuredContent, text: r.content?.[0]?.text ?? '' };
  };

  // 3. tools/call against the real graph.
  const found = await call('search_services', {});
  const services = found.data?.services ?? [];
  check(!found.isError && services.length > 0, 'search_services returns services from the graph', `${services.length} found`);
  const service = process.env.SYNAPSE_SERVICE || services[0];
  if (service) {
    const deps = await call('get_service_dependencies', { service });
    check(!deps.isError, `get_service_dependencies("${service}")`,
      deps.isError ? deps.text : `${deps.data.dependsOn.length} downstream, ${deps.data.dependents.length} upstream`);
    const inc = await call('get_related_incidents', { service });
    check(!inc.isError, `get_related_incidents("${service}")`, inc.isError ? inc.text : `${inc.data.incidents.length} incident(s)`);
    const dep = await call('get_recent_deployments', { service });
    check(!dep.isError, `get_recent_deployments("${service}")`, dep.isError ? dep.text : `${dep.data.deployments.length} deployment(s)`);
    const repos = await call('get_repositories', { service });
    check(!repos.isError, `get_repositories("${service}")`, repos.isError ? repos.text : `${repos.data.repositories.length} repo(s)`);
    const eng = await call('get_engineers', { service });
    check(!eng.isError, `get_engineers("${service}")`, eng.isError ? eng.text : `${eng.data.engineers.length} engineer(s)`);
  }

  // 4. Validation and graph errors come back as tool errors, not crashes.
  const bad = await call('get_service_dependencies', {});
  check(bad.isError, 'missing required input is rejected');
  const unknown = await call('get_service_dependencies', { service: 'No Such Service 12345' });
  check(unknown.isError, 'unknown service returns a tool error');

  // 5. Offboarding data is permission-gated.
  if (names.includes('get_offboarding_risk')) {
    const engineer = process.env.SYNAPSE_ENGINEER || 'Avery Chen';
    const off = await call('get_offboarding_risk', { engineer });
    check(!off.isError, `get_offboarding_risk("${engineer}")`,
      off.isError ? off.text : `${off.data.soloMaintained.length} solo-maintained service(s)`);
  } else {
    console.log('  (get_offboarding_risk not offered to this role - expected for roles without offboarding:read)');
  }

  await client.close();
  console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(`\nERROR: ${err.message}`); process.exit(1); });
