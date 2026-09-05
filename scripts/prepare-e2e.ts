/**
 * Prepare the local Worker state the end-to-end suite runs against.
 *
 * The admin half of the site is not testable end to end without two things the repository cannot
 * carry: a migrated database and an account to sign in with. `scripts/seed-admin.ts` deliberately
 * cannot supply the second one — it demands a TTY and refuses to read a password from a pipe,
 * which is exactly right for a production credential and useless for a test runner. So this script
 * exists alongside it, with the opposite trade-offs made explicit:
 *
 * - **`--local` only, always.** There is no `--remote` flag and no way to reach one. Every command
 *   it runs is pinned to `--local`, so the worst it can touch is `.wrangler/state/`, which is
 *   git-ignored and disposable.
 * - **The password is generated here and never committed.** 32 random bytes from WebCrypto, written
 *   to `test-results/e2e-admin.json` — a git-ignored directory — and hashed with the *same*
 *   `hashPassword` the Worker verifies against, so a seeded credential can only exist under
 *   parameters the real login accepts. No credential is hard-coded in a spec file, in this script,
 *   or anywhere in the repository.
 * - **The account is obviously not real.** `e2e@localhost.invalid`: `.invalid` is the reserved TLD
 *   from RFC 2606, so the address cannot resolve and cannot be mistaken for an operator's.
 * - **It runs before `wrangler dev` starts**, from the Playwright `webServer` command, so the
 *   running Worker opens a database that is already migrated and already seeded rather than having
 *   rows written underneath it.
 *
 * It also materialises the fixture catalogue. The end-to-end suite has to be able to assert a real
 * product detail page, a real product card, a filter with real values and a `Product` block in the
 * structured data — and the spec's rule is that a demo product lives only in `tests/fixtures/` and is
 * never written into `data/products/`. So the fixtures are written as JSON into a git-ignored
 * directory and `src/content.config.ts` reads the collection from there for that build only, via
 * `NGF_PRODUCTS_DIR`. `data/products/` is never touched, and a build with the variable unset — every
 * build CI or Cloudflare runs — reads the repository exactly as before.
 *
 * Run by `npm run e2e:prepare`; not part of any CI gate and not needed for `npm test`.
 *
 * Design: Testing Strategy → End-to-end testing.
 * Requirements: 27.12, 10.1, 10.4.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { hashPassword } from '../src/lib/auth/password';
import { demoProducts } from '../tests/fixtures/products';

const DB_BINDING = 'DB';

/** RFC 2606 reserved TLD — this address cannot resolve anywhere. */
const E2E_EMAIL = 'e2e@localhost.invalid';
const E2E_ROLE = 'owner';
const E2E_USER_ID = 'usr_e2elocalonly';

/** Git-ignored, so the generated password never reaches a commit. */
export const CREDENTIALS_PATH = join('test-results', 'e2e-admin.json');

/** Git-ignored, and the only place a demo product is ever written. Mirrors `playwright.config.ts`. */
export const PRODUCTS_DIR = join('.e2e', 'products');

function fail(message: string): never {
  process.stderr.write(`prepare-e2e: ${message}\n`);
  process.exit(1);
}

/** SQL string literal escaping: doubled single quotes, the only metacharacter. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Wrangler's JS entrypoint, resolved once.
 *
 * Not `npx`, and not `shell: true`: spawning through a shell with an args array is what Node warns
 * about (DEP0190), and `npx.cmd` only exists to bridge that shell on Windows. Instead we run the
 * entrypoint directly under this same Node (`process.execPath`), which needs no shell and no `.cmd`
 * on any platform.
 *
 * The path is read from Wrangler's own `package.json` `bin.wrangler` field rather than resolved as a
 * subpath, because the package's `exports` map does not expose `./bin/wrangler.js` and resolving it
 * directly throws. `package.json` itself is always resolvable, so we join its `bin` value against the
 * directory it lives in.
 */
const wranglerBin = (() => {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('wrangler/package.json');
  const pkg = require('wrangler/package.json') as { bin: string | { wrangler: string } };
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.wrangler;
  return join(dirname(pkgPath), binRel);
})();

function wrangler(args: readonly string[]): void {
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    stdio: 'inherit',
  });
  if (result.status !== 0) fail(`wrangler ${args.join(' ')} failed`);
}

/** A password no one chose and no one needs to remember. */
function generatePassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Write the fixture catalogue out as content files.
 *
 * A full rewrite each time: the directory is removed first, so a fixture renamed or deleted in
 * `tests/fixtures/products.ts` cannot leave a stale product behind to be found by a test that no
 * longer expects it. One file per product at `{slug}.json`, which is the filename convention the
 * glob loader's `generateId` and the admin write pipeline both use.
 */
function writeFixtureProducts(): void {
  rmSync(PRODUCTS_DIR, { recursive: true, force: true });
  mkdirSync(PRODUCTS_DIR, { recursive: true });
  for (const product of demoProducts) {
    writeFileSync(
      join(PRODUCTS_DIR, `${product.slug}.json`),
      `${JSON.stringify(product, null, 2)}\n`,
    );
  }
}

async function main(): Promise<void> {
  // 0. Fresh KV.
  //
  // The rate limiters are the reason. Their windows are 15 minutes for login attempts and an hour
  // for enquiry submissions, and their counters live in `.wrangler/state`, which survives between
  // runs — so the second run of the suite inside a quarter of an hour starts with the login
  // allowance already spent and every sign-in answers 429. That is the limiter working exactly as
  // designed (`tests/unit/auth.session.integration.test.ts` proves the thresholds), and it makes the
  // end-to-end suite depend on how long ago it last ran, which is not a property any suite should
  // have. Sessions live here too; discarding them is what a fresh run wants anyway.
  //
  // Only `--local` state, which is git-ignored and rebuilt on demand.
  rmSync(join(process.cwd(), '.wrangler', 'state', 'v3', 'kv'), { recursive: true, force: true });

  // 1. Tables. Idempotent — wrangler skips migrations that have already run.
  wrangler(['d1', 'migrations', 'apply', DB_BINDING, '--local']);

  // 2. The account, replaced rather than inserted so a re-run is idempotent, and with the
  //    lockout ledger cleared so a previous run's failed-login tests cannot lock this one out.
  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  const sql = [
    'DELETE FROM login_attempts;',
    `DELETE FROM admin_users WHERE LOWER(email) = ${sqlString(E2E_EMAIL)};`,
    'INSERT INTO admin_users (id, email, password_hash, role, status, created_at)',
    `VALUES (${sqlString(E2E_USER_ID)}, ${sqlString(E2E_EMAIL)}, ${sqlString(passwordHash)}, ${sqlString(E2E_ROLE)}, 'ACTIVE', ${sqlString(new Date().toISOString())});`,
  ].join('\n');

  const scratchDir = join(process.cwd(), '.wrangler', 'tmp');
  mkdirSync(scratchDir, { recursive: true });
  const sqlPath = join(scratchDir, `prepare-e2e-${String(Date.now())}.sql`);
  try {
    writeFileSync(sqlPath, `${sql}\n`, { mode: 0o600 });
    wrangler(['d1', 'execute', DB_BINDING, '--local', '--file', sqlPath]);
  } finally {
    rmSync(sqlPath, { force: true });
  }

  // 3. Hand the plaintext to the runner through a git-ignored file rather than an environment
  //    variable, because Playwright spawns its workers itself and an inherited variable would
  //    also reach every process those workers start.
  mkdirSync('test-results', { recursive: true });
  writeFileSync(
    CREDENTIALS_PATH,
    `${JSON.stringify({ email: E2E_EMAIL, password, role: E2E_ROLE }, null, 2)}\n`,
    { mode: 0o600 },
  );

  // 4. The fixture catalogue, for the product-dependent assertions.
  //
  // Astro's content-layer cache goes first. It is keyed by collection name and not by the directory
  // the loader read from, so a store left behind by an earlier build — with or without the fixtures —
  // would be reused and the collection would not reflect what is on disk now. Clearing it is what
  // makes this run's catalogue exactly the fixtures and nothing else. `tests/e2e/global-teardown.ts`
  // clears it again afterwards, so the next ordinary build cannot inherit them.
  rmSync(join(process.cwd(), 'node_modules', '.astro'), { recursive: true, force: true });
  writeFixtureProducts();

  const published = demoProducts.filter((product) => product.status === 'PUBLISHED').length;
  process.stdout.write(
    `prepare-e2e — local database migrated; ${E2E_ROLE} account ${E2E_EMAIL} seeded; ` +
      `credentials written to ${CREDENTIALS_PATH} (git-ignored); ` +
      `${String(demoProducts.length)} fixture product(s) (${String(published)} published) written to ` +
      `${PRODUCTS_DIR} (git-ignored — data/products/ untouched).\n`,
  );
}

await main();
