// Creates the first (or another) admin account. There is no public registration.
//
//   npm run create-admin
//
// Username: SYNAPSE_ADMIN_USERNAME, or prompted.
// Password: prompted with hidden input (recommended). For non-interactive use you may set
//           SYNAPSE_ADMIN_PASSWORD, but environment variables can end up in shell history and
//           process listings, so unset it afterwards. No default credentials exist, and the
//           password is never printed or logged.
import 'dotenv/config';
import { closeDb } from './src/db.js';
import { createUserStore, UserExistsError } from './src/auth/users.js';
import { createAdmin, InputError } from './src/auth/admin.js';
import { normalizeUsername, usernameError, passwordError } from './src/auth/validation.js';
import { promptVisible, promptHidden } from './src/auth/prompt.js';

async function main() {
  const interactive = Boolean(process.stdin.isTTY);

  let username = process.env.SYNAPSE_ADMIN_USERNAME;
  if (!username) {
    if (!interactive) throw new InputError('Set SYNAPSE_ADMIN_USERNAME, or run this in an interactive terminal.');
    username = await promptVisible('Admin username: ');
  }
  username = normalizeUsername(username);
  const uErr = usernameError(username);
  if (uErr) throw new InputError(uErr);

  let password = process.env.SYNAPSE_ADMIN_PASSWORD;
  if (!password) {
    if (!interactive) throw new InputError('Set SYNAPSE_ADMIN_PASSWORD, or run this in an interactive terminal.');
    password = await promptHidden('Admin password (input hidden): ');
    const pErr = passwordError(password, username);
    if (pErr) throw new InputError(pErr);
    const again = await promptHidden('Repeat password: ');
    if (again !== password) throw new InputError('Passwords do not match.');
  }
  // Validate before touching the database so a bad password is reported as such.
  const policyError = passwordError(password, username);
  if (policyError) throw new InputError(policyError);

  const store = createUserStore();
  await store.ensureSchema();
  const user = await createAdmin({ username, password, store });
  console.log(`Created admin user "${user.username}" (id ${user.id}).`);
}

main()
  .catch((err) => {
    if (err instanceof InputError || err instanceof UserExistsError) console.error(`Error: ${err.message}`);
    else console.error('Error: could not create the admin user. Is FalkorDB running and reachable?');
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => {}));
