/**
 * One-off, LOCAL-ONLY repair of the DRAFTS KV working state.
 *
 * Background. The admin product editor faithfully renders whatever record `resolveProduct`
 * (src/lib/github/drafts.ts) hands it. A stray duplicate of the "Premium 3+1+1 Sofa Set" —
 * id `p_eg3vtxpioj`, slug `premium-3-1-1-sofa-set`, auto-generated sku `NGF-SOF-9E2HP8`,
 * status REVIEW — existed ONLY in the local, git-ignored `.wrangler/state` KV cache. It had
 * no committed file under `data/products/`, yet the local `index:products` blob mapped only
 * that stray id, so the editor resolved and displayed the wrong auto-generated SKU. The
 * verified product (id `p_322e7n6mth`, slug `brown-sofa`, sku `NGF-SOF-WBJZX0`) is committed
 * to `data/products/brown-sofa.json` and present as `draft:p_322e7n6mth`.
 *
 * KV is a cache, never a source of truth: `POST /api/admin/rehydrate` rebuilds it from the
 * repository. This script performs the same repository-authoritative rebuild for the local
 * cache, surgically:
 *
 *   1. Delete the stray `draft:p_eg3vtxpioj` key (it has no repo file, so rehydrate would
 *      not remove it on its own).
 *   2. Rebuild `index:products` from the committed `data/products/*.json` files using the
 *      codebase's own `ProductSchema` + `summarize()`, so the index contains exactly the
 *      products that have a committed file (`p_322e7n6mth`/brown-sofa and
 *      `p_qrmfww7uiz`/corner-sofa) and drops the stray entry.
 *
 * The verified draft (`draft:p_322e7n6mth`) and the corner-sofa draft (`draft:p_qrmfww7uiz`)
 * are left untouched. No tracked source file is read for identity mutation and none is
 * written. Every wrangler command is pinned to `--local`; there is no `--remote` path.
 *
 * Usage: tsx scripts/repair-sofa-kv.ts
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { ProductSchema } from '../src/schemas/product.ts';
import { summarize, type ProductIndex } from '../src/lib/products/index-store.ts';

/** The KV binding for the product-index/draft cache, as declared in wrangler.toml. */
const DRAFTS_BINDING = 'DRAFTS';
/** The KV key the whole product index lives under (mirrors PRODUCT_INDEX_KEY). */
const INDEX_KEY = 'index:products';
/** The stray duplicate that must be removed from local KV state. */
const STRAY_DRAFT_KEY = 'draft:p_eg3vtxpioj';
/** The committed source of truth. */
const PRODUCTS_DIR = join(process.cwd(), 'data', 'products');

/**
 * Wrangler's JS entrypoint, resolved directly (no shell, no npx.cmd) — the same technique
 * scripts/prepare-e2e.ts uses to avoid Node's DEP0190 shell warning on Windows.
 */
const wranglerBin = (() => {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('wrangler/package.json');
  const pkg = require('wrangler/package.json') as { bin: string | { wrangler: string } };
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.wrangler;
  return join(dirname(pkgPath), binRel);
})();

function wrangler(args: readonly string[]): string {
  // Hard guard: this script must never touch remote state.
  if (args.includes('--remote')) throw new Error('refusing to run a --remote wrangler command');
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`wrangler ${args.join(' ')} failed`);
  }
  return result.stdout ?? '';
}

/** Build the product index from the committed repository files, repository-authoritative. */
function buildIndexFromRepository(): ProductIndex {
  const index: ProductIndex = {};
  for (const entry of readdirSync(PRODUCTS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const raw = readFileSync(join(PRODUCTS_DIR, entry), 'utf8');
    const parsed = ProductSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(`data/products/${entry} does not match ProductSchema; aborting repair`);
    }
    index[parsed.data.id] = summarize(parsed.data);
  }
  return index;
}

function main(): void {
  const index = buildIndexFromRepository();
  const ids = Object.keys(index).sort();
  if (ids.includes('p_eg3vtxpioj')) {
    throw new Error('the stray id p_eg3vtxpioj unexpectedly has a committed file; aborting');
  }
  process.stdout.write(
    `repair-sofa-kv — rebuilt index from ${String(ids.length)} committed product file(s): ` +
      `${ids.join(', ')}\n`,
  );

  // Write the rebuilt index via a git-ignored scratch file so no shell quoting of the JSON
  // payload is required.
  const scratchDir = join(process.cwd(), '.wrangler', 'tmp');
  mkdirSync(scratchDir, { recursive: true });
  const scratch = join(scratchDir, `repair-sofa-kv-${String(Date.now())}.json`);
  try {
    writeFileSync(scratch, JSON.stringify(index), { mode: 0o600 });
    wrangler(['kv', 'key', 'put', INDEX_KEY, '--binding', DRAFTS_BINDING, '--local', '--path', scratch]);
  } finally {
    rmSync(scratch, { force: true });
  }
  process.stdout.write(`repair-sofa-kv — wrote ${INDEX_KEY} (local).\n`);

  // Remove the stray duplicate draft. It has no repo file, so a plain rehydrate would leave
  // it behind.
  wrangler(['kv', 'key', 'delete', STRAY_DRAFT_KEY, '--binding', DRAFTS_BINDING, '--local']);
  process.stdout.write(`repair-sofa-kv — deleted ${STRAY_DRAFT_KEY} (local).\n`);
}

main();
