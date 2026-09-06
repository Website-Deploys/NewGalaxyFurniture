/**
 * Export the R2 objects for product `p_322e7n6mth` (the "Premium 3+1+1 Sofa Set",
 * slug `brown-sofa`) out of the LOCAL, git-ignored miniflare R2 bucket into a
 * staging folder, preserving the full R2 key path.
 *
 * WHY THIS EXISTS
 * ---------------
 * A git commit ships the product JSON but NOT the image binaries: those live only
 * in `.wrangler/state/v3/r2/ngf-media` (git-ignored). Once the product is published
 * the live site would 404 every image until the same objects are uploaded to the
 * PRODUCTION R2 bucket. This script stages the bytes so the upload script has real
 * files to push. It reads ONLY local state and writes ONLY into the staging folder;
 * it never touches production or `--remote`.
 *
 * HOW IT WORKS
 * ------------
 * miniflare stores R2 as: a per-bucket sqlite (`_mf_objects`: key -> blob_id +
 * http_metadata) plus content-addressed blob files under `ngf-media/blobs/{blob_id}`.
 * For each object whose key starts with `products/p_322e7n6mth/` we copy the blob to
 * `<staging>/<key>` and emit a manifest (`manifest.json`) of key -> {file, contentType,
 * cacheControl, size} that the upload script consumes.
 *
 * RUN
 * ---
 *   node scripts/export-brown-sofa-r2-objects.mjs
 *
 * Requires Node >= 22.12 (uses the built-in `node:sqlite`). Idempotent: re-running
 * overwrites the staging folder with the same content-addressed bytes.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, copyFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRODUCT_ID = 'p_322e7n6mth';
const R2_STATE = join(ROOT, '.wrangler', 'state', 'v3', 'r2');
const BLOBS_DIR = join(R2_STATE, 'ngf-media', 'blobs');
const SQLITE_DIR = join(R2_STATE, 'miniflare-R2BucketObject');
const STAGING = join(ROOT, '.agents', 'tasks', 'task-publish-brown-sofa', 'r2-export');

function findBucketSqlite() {
  const files = readdirSync(SQLITE_DIR).filter(
    (f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite',
  );
  if (files.length !== 1) {
    throw new Error(
      `Expected exactly one per-bucket sqlite in ${SQLITE_DIR}, found: ${files.join(', ') || '(none)'}`,
    );
  }
  return join(SQLITE_DIR, files[0]);
}

const dbPath = findBucketSqlite();
const db = new DatabaseSync(dbPath, { readOnly: true });

const rows = db
  .prepare(
    "SELECT key, blob_id, size, http_metadata FROM _mf_objects WHERE key LIKE ? ORDER BY key",
  )
  .all(`products/${PRODUCT_ID}/%`);

if (rows.length === 0) {
  throw new Error(`No R2 objects found for product ${PRODUCT_ID} in ${dbPath}`);
}

const manifest = [];
for (const row of rows) {
  const blobPath = join(BLOBS_DIR, row.blob_id);
  if (!existsSync(blobPath)) {
    throw new Error(`Blob missing for key ${row.key}: ${blobPath}`);
  }
  const meta = row.http_metadata ? JSON.parse(row.http_metadata) : {};
  const contentType = meta.contentType ?? 'application/octet-stream';
  const cacheControl = meta.cacheControl ?? 'public, max-age=31536000, immutable';

  const dest = join(STAGING, row.key);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(blobPath, dest);
  const staged = statSync(dest);

  manifest.push({
    key: row.key,
    file: row.key, // relative to the staging root
    contentType,
    cacheControl,
    size: staged.size,
  });
}

db.close();

// Deterministic manifest: sorted by key, two-space indent, trailing newline.
manifest.sort((a, b) => a.key.localeCompare(b.key));
const manifestPath = join(STAGING, 'manifest.json');
writeFileSync(manifestPath, JSON.stringify({ productId: PRODUCT_ID, objects: manifest }, null, 2) + '\n');

console.log(`Exported ${manifest.length} R2 objects for ${PRODUCT_ID} to:`);
console.log(`  ${STAGING}`);
console.log(`Manifest: ${manifestPath}`);
