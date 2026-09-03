/**
 * One-time creation of the single `owner` account.
 *
 * Run it once per environment, interactively:
 *
 *     npm run db:migrate                  # tables must exist first
 *     npx tsx scripts/seed-admin.ts --local
 *     npx tsx scripts/seed-admin.ts --remote
 *
 * Design decisions this script is the enforcement point for:
 *
 * - **No default password ships.** There is no `--password` flag, no environment
 *   variable fallback, and no generated-and-printed value. The operator types a
 *   password that only they know, or the script exits non-zero.
 * - **Nothing is echoed.** The prompt runs the TTY in raw mode and prints no
 *   characters, no asterisks, and no length. The plaintext exists in one local
 *   variable, is passed to `hashPassword`, and is never written to stdout, to a
 *   file, to a shell argument (where `ps` would show it), or to the repository.
 * - **The runtime hash function is the only hash function.** The script imports
 *   `hashPassword` from `src/lib/auth/password.ts` rather than reimplementing
 *   PBKDF2, so a seeded credential can never be derived under parameters the
 *   Worker will not accept.
 * - **The SQL goes through a temporary file, not `--command`.** A command line is
 *   visible to every process on the machine; a 0600 temp file inside the repo's
 *   ignored `.wrangler/` directory is not, and it is unlinked in a `finally`.
 *
 * Design: Admin Authentication → Credential storage.
 * Requirements: 10.4, 10.13, 10.18.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import { hashPassword } from '../src/lib/auth/password';
import { ROLES } from '../src/lib/auth/permissions';

const DB_BINDING = 'DB';
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

/**
 * A line of input with no echo at all.
 *
 * Raw mode is required: readline's `output` writes every keystroke back, and there
 * is no supported way to suppress that without owning the keypress loop. Ctrl-C is
 * handled explicitly because raw mode suppresses the default SIGINT.
 */
async function promptSecret(question: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    fail('a TTY is required — this script will not read a password from a pipe or a file');
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
          // Ctrl-C
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        // Ignore the remaining C0 controls (arrow keys arrive as escape sequences).
        if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

/** SQL string literal escaping: doubled single quotes, the only metacharacter. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const local = args.has('--local');
  const remote = args.has('--remote');
  if (local === remote) {
    fail('pass exactly one of --local or --remote');
  }

  const emailRaw = await prompt('Admin email: ');
  const email = emailRaw.trim().toLowerCase();
  // Deliberately conservative: this is a single operator account, not a signup form.
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
    // The length of the *rejected* value is the operator's own input; the accepted
    // value's length is never reported.
    fail(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const confirm = await promptSecret('Confirm password: ');
  if (password !== confirm) {
    fail('passwords did not match');
  }

  // The one place the plaintext is used. After this line nothing downstream can
  // recover it, and it is never referenced again.
  const passwordHash = await hashPassword(password);

  const id = `usr_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const createdAt = new Date().toISOString();

  const sql = [
    'INSERT INTO admin_users (id, email, password_hash, role, status, created_at)',
    `VALUES (${sqlString(id)}, ${sqlString(email)}, ${sqlString(passwordHash)}, ${sqlString(role)}, 'ACTIVE', ${sqlString(createdAt)});`,
  ].join('\n');

  const scratchDir = join(process.cwd(), '.wrangler', 'tmp');
  mkdirSync(scratchDir, { recursive: true });
  const sqlPath = join(scratchDir, `seed-admin-${Date.now()}.sql`);

  try {
    writeFileSync(sqlPath, `${sql}\n`, { mode: 0o600 });
    const result = spawnSync(
      'npx',
      [
        'wrangler',
        'd1',
        'execute',
        DB_BINDING,
        local ? '--local' : '--remote',
        '--file',
        sqlPath,
        ...(remote ? ['--yes'] : []),
      ],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      fail(
        'wrangler d1 execute failed. If the address is already taken the UNIQUE index ' +
          'rejected the insert, which is the intended behaviour — one account per address.',
      );
    }
  } finally {
    rmSync(sqlPath, { force: true });
  }

  process.stdout.write(
    `\nCreated ${role} account ${email} (${id}) in the ${local ? 'local' : 'remote'} database.\n` +
      'The password was not printed and is not recoverable — store it in your password manager now.\n',
  );
}

await main();
