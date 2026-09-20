/**
 * One-time creation of an admin account, written directly to Neon Postgres.
 *
 * Run it once per environment, interactively, after the schema exists:
 *
 *     npm run db:migrate                 # tables must exist first
 *     NETLIFY_DATABASE_URL="postgres://..." npm run seed:admin
 *
 * Design decisions this script is the enforcement point for (unchanged by the Netlify migration):
 *
 * - **No default password ships.** There is no `--password` flag, no environment variable fallback,
 *   and no generated-and-printed value. The operator types a password only they know, or the script
 *   exits non-zero.
 * - **Nothing is echoed.** The prompt runs the TTY in raw mode and prints no characters. The
 *   plaintext exists in one local variable, is passed to `hashPassword`, and is never written to
 *   stdout, a file, a shell argument, or the repository.
 * - **The runtime hash function is the only hash function.** It imports `hashPassword` from
 *   `src/lib/auth/password.ts` rather than reimplementing PBKDF2, so a seeded credential can never
 *   be derived under parameters the app will not accept.
 * - **The insert is parameterised.** The values are bound as `$1..$6` through the Neon driver, not
 *   concatenated into SQL â€” no temp file, no `--command`, nothing visible to `ps`.
 * - **One account per address** is a database guarantee: the `LOWER(email)` unique index rejects a
 *   duplicate, and the script reports that as the intended outcome.
 *
 * Design: Admin Authentication â†’ Credential storage.
 * Requirements: 10.4, 10.13, 10.18.
 */

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import { neon } from '@netlify/neon';

import { hashPassword } from '../src/lib/auth/password';
import { ROLES } from '../src/lib/auth/permissions';

const MIN_PASSWORD_LENGTH = 12;

function fail(message: string): never {
  process.stderr.write(`seed-admin: ${message}\n`);
  process.exit(1);
}

/** A single visible line of input. */
async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

/** A line of input with no echo at all. Raw mode; Ctrl-C handled explicitly. */
async function promptSecret(question: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    fail('a TTY is required â€” this script will not read a password from a pipe or a file');
  }
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return await new Promise<string>((resolve) => {
    let value = '';
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const url = process.env.NETLIFY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    fail('set NETLIFY_DATABASE_URL (or DATABASE_URL) to your Neon connection string');
  }

  const emailRaw = await prompt('Admin email: ');
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email) || email.length > 254) {
    fail('that does not look like an email address');
  }

  const roleRaw = (await prompt(`Role [${ROLES.join('|')}] (default owner): `)).trim();
  const role = roleRaw === '' ? 'owner' : roleRaw;
  if (!(ROLES as readonly string[]).includes(role)) {
    fail(`role must be one of ${ROLES.join(', ')}`);
  }

  const password = await promptSecret('Password (not echoed): ');
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const confirm = await promptSecret('Confirm password: ');
  if (password !== confirm) {
    fail('passwords did not match');
  }

  // The one place the plaintext is used. After this line nothing downstream can recover it.
  const passwordHash = await hashPassword(password);

  const id = `usr_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const createdAt = new Date().toISOString();

  const sql = neon(url);
  try {
    await sql.query(
      'INSERT INTO admin_users (id, email, password_hash, role, status, created_at) ' +
        "VALUES ($1, $2, $3, $4, 'ACTIVE', $5)",
      [id, email, passwordHash, role, createdAt],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/duplicate key|unique/i.test(message)) {
      fail(
        'that email is already registered. The unique index rejected the insert, which is the ' +
          'intended behaviour â€” one account per address.',
      );
    }
    fail(`could not insert the account: ${message}`);
  }

  process.stdout.write(
    `\nCreated ${role} account ${email} (${id}) in the Neon database.\n` +
      'The password was not printed and is not recoverable â€” store it in your password manager now.\n',
  );
}

await main();
