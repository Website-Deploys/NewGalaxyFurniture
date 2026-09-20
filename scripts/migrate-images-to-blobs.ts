/**
 * `npm run images:migrate` — upload staged product-image objects into Netlify Blobs.
 *
 * The image originals and derivatives were content-addressed under `products/{productId}/{imageId}/`
 * and previously stored in Cloudflare R2. The same bytes are staged in the repository under
 * `.agents/tasks/task-publish-brown-sofa/r2-export/` with a `manifest.json` of
 * `{ key, file, contentType }`. This script writes each object into the `ngf-media` Netlify Blobs
 * store under the identical key, with the same content type recorded in the blob metadata (which is
 * how the `/img/**` route sets its `content-type`). Because the keys are unchanged, no product JSON
 * needs rewriting — the existing `products/.../original.jpg` and `...-1280.webp` references resolve
 * against Blobs exactly as they did against R2.
 *
 * It is additive and idempotent: re-running overwrites each blob with identical bytes; nothing is
 * deleted. New admin uploads write straight to the same store through the running application, so
 * this script is only needed to carry the already-published images across the storage change.
 *
 * Requires a Netlify Blobs context. Run it under `netlify dev` or with a linked site so
 * `getStore` can authenticate:  npx netlify dev --command "npm run images:migrate"
 * or, with explicit Blobs credentials in the environment, directly with tsx.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getStore } from '@netlify/blobs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STAGING = join(ROOT, '.agents', 'tasks', 'task-publish-brown-sofa', 'r2-export');
const MANIFEST = join(STAGING, 'manifest.json');
const STORE_NAME = 'ngf-media';

interface ManifestObject {
  key: string;
  file: string;
  contentType: string;
}

interface Manifest {
  productId: string;
  objects: ManifestObject[];
}

async function main(): Promise<void> {
  if (!existsSync(MANIFEST)) {
    console.error(`images:migrate — no manifest at ${MANIFEST}. Nothing to migrate.`);
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
  if (!Array.isArray(manifest.objects) || manifest.objects.length === 0) {
    console.error('images:migrate — manifest has no objects.');
    process.exitCode = 1;
    return;
  }

  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  console.log(
    `images:migrate — writing ${String(manifest.objects.length)} object(s) into Netlify Blobs "${STORE_NAME}"...`,
  );

  let done = 0;
  for (const object of manifest.objects) {
    const filePath = join(STAGING, object.file);
    if (!existsSync(filePath)) {
      throw new Error(`images:migrate — staged file missing: ${filePath}`);
    }
    const bytes = readFileSync(filePath);
    await store.set(
      object.key,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      {
        metadata: {
          contentType: object.contentType,
          cacheControl: 'public, max-age=31536000, immutable',
        },
      },
    );
    done += 1;
    console.log(`  [${String(done)}/${String(manifest.objects.length)}] ${object.key}`);
  }
  console.log(`images:migrate — done. ${String(done)} object(s) now in Netlify Blobs.`);
}

await main();
