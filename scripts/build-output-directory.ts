import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Public build output, using the same target selection as astro.config.mjs. */
export function buildOutputDirectory(): string {
  return process.env.DEPLOY_TARGET === 'cloudflare'
    ? join(ROOT, 'dist', 'client')
    : join(ROOT, 'dist');
}
