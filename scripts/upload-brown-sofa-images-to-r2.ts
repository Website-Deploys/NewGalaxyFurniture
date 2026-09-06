/**
 * ============================================================================
 *  ⚠️  THIS SCRIPT WRITES TO **PRODUCTION** CLOUDFLARE R2.  ⚠️
 * ============================================================================
 *
 * Upload the image objects for product `p_322e7n6mth` (the "Premium 3+1+1 Sofa
 * Set", slug `brown-sofa`) into the production R2 bucket, so the now-published
 * product renders real images on the live storefront instead of 404s.
 *
 * WHY THIS IS A SEPARATE, OPERATOR-RUN STEP
 * -----------------------------------------
 * A git commit ships the product JSON (`data/products/brown-sofa.json`) but NOT
 * the image binaries. The originals and derivatives live only in the local,
 * git-ignored miniflare R2 bucket. Cloudflare/Netlify build the site from the
 * repo, so the published product would point at `/img/**` URLs whose R2 objects
 * do not exist in production. This script pushes those objects up.
 *
 * It is intentionally NOT run by the automated agent: it requires real
 * Cloudflare credentials and mutates a live bucket. Run it yourself.
 *
 * SAFETY / IDEMPOTENCY
 * --------------------
 * The keys are content-addressed and immutable (`products/{productId}/{imageId}/...`),
 * so re-running is safe: each `put` simply overwrites with identical bytes. If an
 * earlier partial upload already placed some objects, running again reconciles the
 * rest. Nothing is deleted.
 *
 * PREREQUISITES
 * -------------
 *   1. Run the staging export first (reads local R2 only, no network):
 *          node scripts/export-brown-sofa-r2-objects.mjs
 *      That writes files + `manifest.json` under
 *          .agents/tasks/task-publish-brown-sofa/r2-export/
 *   2. Authenticate wrangler against the production account:
 *          npx wrangler login            (or set CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID)
 *
 * RUN
 * ---
 *   # dry run — prints every wrangler command, uploads nothing:
 *   npx tsx scripts/upload-brown-sofa-images-to-r2.ts --dry-run
 *
 *   # real upload to PRODUCTION R2:
 *   npx tsx scripts/upload-brown-sofa-images-to-r2.ts
 *
 * The bucket name is read from `wrangler.toml` (the production `[[r2_buckets]]`
 * binding `MEDIA` -> `bucket_name`), never hard-coded.
 *
 * Design: Image Pipeline → Delivery; Deployment.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER_TOML = join(ROOT, 'wrangler.toml');
const STAGING = join(ROOT, '.agents', 'tasks', 'task-publish-brown-sofa', 'r2-export');
const MANIFEST = join(STAGING, 'manifest.json');
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

interface ManifestObject {
  key: string;
  file: string;
  contentType: string;
  cacheControl?: string;
  size: number;
}

interface Manifest {
  productId: string;
  objects: ManifestObject[];
}

/**
 * Read the PRODUCTION R2 bucket name from wrangler.toml.
 *
 * The top-level `[[r2_buckets]]` block is the production binding; the preview
 * bucket lives under `[env.preview.r2_buckets]`. We only scan the text before
 * the first `[env.` section header so the preview bucket can never be picked.
 */
function productionBucketName(): string {
  const toml = readFileSync(WRANGLER_TOML, 'utf8');
  const envIndex = toml.indexOf('\n[env.');
  const topLevel = envIndex === -1 ? toml : toml.slice(0, envIndex);
  // Find the MEDIA binding block and its bucket_name.
  const mediaIndex = topLevel.indexOf('binding = "MEDIA"');
  if (mediaIndex === -1) {
    throw new Error('Could not find the MEDIA r2_buckets binding in wrangler.toml');
  }
  const after = topLevel.slice(mediaIndex);
  const match = after.match(/bucket_name\s*=\s*"([^"]+)"/);
  if (!match || !match[1]) {
    throw new Error('Could not read bucket_name for the MEDIA binding in wrangler.toml');
  }
  return match[1];
}

function loadManifest(): Manifest {
  if (!existsSync(MANIFEST)) {
    throw new Error(
      `Manifest not found at ${MANIFEST}. Run: node scripts/export-brown-sofa-r2-objects.mjs`,
    );
  }
  const parsed = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
  if (!Array.isArray(parsed.objects) || parsed.objects.length === 0) {
    throw new Error(`Manifest at ${MANIFEST} has no objects to upload`);
  }
  return parsed;
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const bucket = productionBucketName();
  const manifest = loadManifest();

  console.log(
    `${dryRun ? '[dry-run] ' : ''}Uploading ${manifest.objects.length} objects for ` +
      `${manifest.productId} to PRODUCTION R2 bucket "${bucket}".`,
  );
  if (!dryRun) {
    console.log('This writes to LIVE R2. Ctrl-C now if that is not what you want.\n');
  }

  let done = 0;
  for (const object of manifest.objects) {
    const filePath = join(STAGING, object.file);
    if (!existsSync(filePath)) {
      throw new Error(`Staged file missing: ${filePath}. Re-run the export script.`);
    }
    const remoteTarget = `${bucket}/${object.key}`;
    const args = [
      'wrangler',
      'r2',
      'object',
      'put',
      remoteTarget,
      '--file',
      filePath,
      '--content-type',
      object.contentType,
      '--cache-control',
      object.cacheControl ?? CACHE_CONTROL,
      '--remote',
    ];

    if (dryRun) {
      console.log('npx ' + args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' '));
      done += 1;
      continue;
    }

    const result = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status !== 0) {
      throw new Error(
        `wrangler put failed for ${object.key} (exit ${result.status ?? 'unknown'}). ` +
          'Fix the error and re-run — completed puts are idempotent.',
      );
    }
    done += 1;
    console.log(`  [${done}/${manifest.objects.length}] ${object.key}`);
  }

  console.log(
    `\n${dryRun ? '[dry-run] would upload' : 'Uploaded'} ${done} objects to "${bucket}".`,
  );
}

main();
