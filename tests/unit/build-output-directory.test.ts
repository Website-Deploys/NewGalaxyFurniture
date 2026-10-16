import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildOutputDirectory } from '../../scripts/build-output-directory';

const NETLIFY_OUTPUT = fileURLToPath(new URL('../../dist', import.meta.url));
const CLOUDFLARE_OUTPUT = fileURLToPath(new URL('../../dist/client', import.meta.url));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('public build output directory', () => {
  it.each([
    { target: undefined, expected: NETLIFY_OUTPUT },
    { target: 'netlify', expected: NETLIFY_OUTPUT },
    { target: '', expected: NETLIFY_OUTPUT },
    { target: 'cloudflare', expected: CLOUDFLARE_OUTPUT },
    { target: 'preview', expected: NETLIFY_OUTPUT },
    { target: 'Cloudflare', expected: NETLIFY_OUTPUT },
  ])('uses $expected when DEPLOY_TARGET is $target', ({ target, expected }) => {
    vi.stubEnv('DEPLOY_TARGET', target);

    expect(buildOutputDirectory()).toBe(expected);
  });

  it('reads the current target instead of caching the environment when imported', () => {
    vi.stubEnv('DEPLOY_TARGET', 'netlify');
    expect(buildOutputDirectory()).toBe(NETLIFY_OUTPUT);

    vi.stubEnv('DEPLOY_TARGET', 'cloudflare');
    expect(buildOutputDirectory()).toBe(CLOUDFLARE_OUTPUT);
  });
});
