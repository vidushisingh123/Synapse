import { runTool } from './src/graph/tools.js';
import { closeDb } from './src/db.js';

try {
  for (const [name, input] of [
    ['search_services', {}],
    ['get_service_dependencies', { service: 'Checkout API' }],
    ['get_related_incidents', { service: 'Checkout API' }],
    ['get_recent_deployments', { service: 'Checkout API' }],
    ['get_repositories', { service: 'Checkout API' }],
    ['get_engineers', { service: 'Checkout API' }],
  ]) {
    console.log(`\n=== ${name}`);
    console.dir(await runTool(name, input), { depth: null });
  }
} catch (err) {
  console.error('Tool test failed:', err);
  process.exitCode = 1;
} finally {
  await closeDb();
}