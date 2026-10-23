// Terminal prompts shared by the account-creation scripts. Passwords are read with echo off
// and are never printed or logged.
import { createInterface } from 'node:readline/promises';
import { InputError } from './admin.js';

export function promptVisible(label) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(label).finally(() => rl.close());
}

export function promptHidden(label) {
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
