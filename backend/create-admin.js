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
import { createInterface } from 'node:readline/promises';
import { closeDb } from './src/db.js';
import { createUserStore, UserExistsError } from './src/auth/users.js';
import { createAdmin, InputError } from './src/auth/admin.js';
import { normalizeUsername, usernameError, passwordError } from './src/auth/validation.js';

function promptVisible(label) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(label).finally(() => rl.close());
}

function promptHidden(label) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    process.stdout.write(label);
    let buf = '';
    const finish = (fn, value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      fn(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(resolve, buf);
        if (ch === '\u0003') return finish(reject, new InputError('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

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
