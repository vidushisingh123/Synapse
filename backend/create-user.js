// Creates an analyst, viewer or admin account. There is no public registration and no
// user-management API yet; this is the only way accounts are created.
//
//   npm run create-user -- --role=analyst
//
// Username: SYNAPSE_USER_USERNAME, or prompted.
// Role:     --role=<admin|analyst|viewer>, or SYNAPSE_USER_ROLE, or prompted.
// Password: prompted with hidden input (recommended). For non-interactive use you may set
//           SYNAPSE_USER_PASSWORD, but environment variables can end up in shell history and
//           process listings, so unset it afterwards. No default credentials exist, and the
//           password is never printed or logged.
import 'dotenv/config';
import { closeDb } from './src/db.js';
import { createUserStore, UserExistsError } from './src/auth/users.js';
import { createAccount, InputError } from './src/auth/admin.js';
import { normalizeUsername, usernameError, passwordError } from './src/auth/validation.js';
import { isKnownRole } from './src/auth/rbac.js';
import { promptVisible, promptHidden } from './src/auth/prompt.js';

async function main() {
  const interactive = Boolean(process.stdin.isTTY);

  const roleArg = process.argv.slice(2).find((a) => a.startsWith('--role='))?.slice('--role='.length);
  let role = roleArg ?? process.env.SYNAPSE_USER_ROLE;
  if (!role) {
    if (!interactive) throw new InputError('Pass --role=<admin|analyst|viewer> or set SYNAPSE_USER_ROLE.');
    role = await promptVisible('Role (admin, analyst, viewer): ');
  }
  role = String(role).trim().toLowerCase();
  if (!isKnownRole(role)) throw new InputError('Role must be one of: admin, analyst, viewer.');

  let username = process.env.SYNAPSE_USER_USERNAME;
  if (!username) {
    if (!interactive) throw new InputError('Set SYNAPSE_USER_USERNAME, or run this in an interactive terminal.');
    username = await promptVisible('Username: ');
  }
  username = normalizeUsername(username);
  const uErr = usernameError(username);
  if (uErr) throw new InputError(uErr);

  let password = process.env.SYNAPSE_USER_PASSWORD;
  if (!password) {
    if (!interactive) throw new InputError('Set SYNAPSE_USER_PASSWORD, or run this in an interactive terminal.');
    password = await promptHidden('Password (input hidden): ');
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
  const user = await createAccount({ username, password, role, store });
  console.log(`Created ${user.role} user "${user.username}" (id ${user.id}).`);
}

main()
  .catch((err) => {
    if (err instanceof InputError || err instanceof UserExistsError) console.error(`Error: ${err.message}`);
    else console.error('Error: could not create the user. Is FalkorDB running and reachable?');
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => {}));
