import 'dotenv/config';
import { createApp } from './app.js';
import { closeDb } from './db.js';
import { assertAuthConfig } from './auth/config.js';
import { createUserStore } from './auth/users.js';

// Fatal in production when JWT_SECRET is missing or insecure.
try {
  assertAuthConfig();
} catch (err) {
  console.error(`[startup] ${err.message}`);
  process.exit(1);
}

const userStore = createUserStore();
userStore.ensureSchema().catch((err) => console.warn('[startup] could not ensure auth indexes:', err.message));

const app = createApp({ userStore });

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () => console.log(`Synapse API listening on http://localhost:${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await closeDb().catch(() => {});
    process.exit(0);
  });
}
