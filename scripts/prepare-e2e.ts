/**
 * `npm run e2e:prepare` — stand up an ISOLATED, LOCAL-ONLY fixture for the browser suite.
 *
 * Nothing here touches a remote resource. It writes only to:
 *   - `.e2e/products/`            — git-ignored fixture catalogue the build reads via NGF_PRODUCTS_DIR
 *   - the LOCAL miniflare D1      — `wrangler d1 execute DB --local` (`.wrangler/state`), never --remote
 *   - `test-results/e2e-admin.json` — git-ignored credentials the specs read (`helpers.e2eCredentials`)
 *   - `node_modules/.astro`       — cleared so the content layer re-reads the fixture directory
 *
 * It never calls the GitHub API, never reads or writes production D1/KV/R2, and never deploys. The
 * admin account it creates is a throwaway with a freshly generated random password, written to the
 * local SQLite database only; the password is placed in the git-ignored credentials file so the
 * Playwright specs can sign in, and nowhere else.
 *
 * The product-create/publish admin flows commit through the GitHub Contents API, which needs a real
 * token and repository; those are covered by the mocked unit/integration suite and are deliberately
 * out of scope for the browser run (see tests/e2e/admin-auth.spec.ts). This fixture is enough to
 * exercise everything that does NOT require GitHub: login, route protection, the dashboard, the
 * product list and its visibility of the committed catalogue, search/filter, validation, and logout.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import { hashPassword } from '../src/lib/auth/password';
import { serializeContentJson } from '../src/lib/github/serialize';
import { demoProducts } from '../tests/fixtures/products';
import { readProductIndex, summarize, writeProductIndex } from '../src/lib/products/index-store';

const PRODUCTS_DIR = '.e2e/products';
const CREDS_PATH = join('test-results', 'e2e-admin.json');
const SEED_SQL = join('.e2e', 'seed-admin.sql');

/** Escape a value for a single-quoted SQLite string literal. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  // 1. The fixture catalogue, written where the build will read it.
  rmSync('.e2e', { recursive: true, force: true });
  mkdirSync(PRODUCTS_DIR, { recursive: true });
  for (const product of demoProducts) {
    writeFileSync(join(PRODUCTS_DIR, `${product.slug}.json`), serializeContentJson({ ...product }));
  }

  // Clear Astro's content-layer cache so the glob loader re-reads the fixture directory rather than
  // a store built from `data/products/`. `global-teardown.ts` clears the same cache on the way out.
  rmSync(join('node_modules', '.astro'), { recursive: true, force: true });

  // 2. A throwaway local admin, with a generated password that is never reused and never printed to
  //    a shared log. Written only to the local SQLite DB and the git-ignored credentials file.
  const email = 'e2e-owner@localhost.test';
  const password = `e2e-${randomBytes(18).toString('base64url')}`;
  const passwordHash = await hashPassword(password);
  const id = `usr_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const createdAt = new Date().toISOString();

  mkdirSync('.e2e', { recursive: true });
  mkdirSync('test-results', { recursive: true });

  // Idempotent: delete any prior fixture account for this address, then insert. Scoped to the one
  // test address so it cannot disturb another local account someone created by hand.
  const seed =
    `DELETE FROM admin_users WHERE email = ${sqlLiteral(email)};\n` +
    `INSERT INTO admin_users (id, email, password_hash, role, status, created_at) VALUES (` +
    `${sqlLiteral(id)}, ${sqlLiteral(email)}, ${sqlLiteral(passwordHash)}, 'owner', 'ACTIVE', ${sqlLiteral(createdAt)});\n`;
  writeFileSync(SEED_SQL, seed);

  // 3. Credentials for the specs. Git-ignored; `helpers.e2eCredentials()` reads exactly this shape.
  writeFileSync(CREDS_PATH, `${JSON.stringify({ email, password, role: 'owner' }, null, 2)}\n`);

  // The LOCAL D1 is migrated and seeded by the caller (the `e2e:prepare` npm script), which pipes
  // the migration files and `${SEED_SQL}` through `wrangler d1 execute DB --local`. This script does
  // not spawn wrangler itself: nesting `tsx -> npx.cmd` is fragile on Windows, and keeping the
  // process boundary in the npm script is both simpler and easier to read in the task runner.
  process.stdout.write(
    `e2e:prepare(generate) — local fixture written.\n` +
      `  products: ${String(demoProducts.length)} written to ${PRODUCTS_DIR}\n` +
      `  seed sql: ${SEED_SQL} (apply to LOCAL D1 only)\n` +
      `  admin:    ${email} (owner)\n` +
      `  creds:    ${CREDS_PATH} (git-ignored)\n`,
  );
}

/* The admin product list reads the KV index, so a note for the harness: the list view's
 * repository-fallback needs a GitHub token to rebuild an empty index. To keep the browser run
 * GitHub-free, the index can be pre-seeded from the same fixtures with `seedLocalIndex` below, which
 * the Playwright global-setup may call against the local KV through the running Worker. It is
 * exported rather than invoked here because KV lives in the Worker process, not this one. */
export async function seedLocalIndexInto(kv: Parameters<typeof writeProductIndex>[0]): Promise<void> {
  const index = await readProductIndex(kv);
  for (const product of demoProducts) index[product.id] = summarize(product);
  await writeProductIndex(kv, index);
}

await main();
