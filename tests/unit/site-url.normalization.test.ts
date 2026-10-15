/**
 * Site-URL normalization parity across the shared helper and both env resolvers.
 *
 * The invariant these tests protect: `PUBLIC_SITE_URL` is normalised by ONE implementation
 * (`src/lib/seo/site-url.ts#normalise`), and both the Netlify resolver (`src/lib/env.ts`) and the
 * Cloudflare resolver (`src/lib/env.cloudflare.ts`) delegate to it, so the two deployment targets
 * cannot normalise the origin differently. `seo.meta.test.ts` guards this structurally (one
 * normalizer, both resolvers import it); these tests guard it *behaviourally* by exercising the
 * actual values a misconfiguration would produce.
 *
 * The five cases named in the Stage 2 plan: a normal URL, surrounding whitespace, one trailing
 * slash, multiple trailing slashes, and missing/blank.
 *
 * `env.cloudflare.ts` imports the virtual module `cloudflare:workers`, which does not exist under
 * vitest, so it is mocked. `env.ts` reads `process.env`, which is set per-case. Both resolvers cache
 * nothing for the public config (they read on each call), so no module reset is needed between the
 * site-url cases; the mocked Cloudflare env is mutated in place.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalise } from '@/lib/seo/site-url';

/* -------------------------------------------------------------------------- */
/* The shared normalizer — the single implementation.                         */
/* -------------------------------------------------------------------------- */

describe('normalise (the one shared site-URL normalizer)', () => {
  it('passes a clean origin through unchanged', () => {
    expect(normalise('https://shop.example')).toBe('https://shop.example');
  });

  it('trims surrounding whitespace', () => {
    expect(normalise('  https://shop.example  ')).toBe('https://shop.example');
  });

  it('removes a single trailing slash', () => {
    expect(normalise('https://shop.example/')).toBe('https://shop.example');
  });

  it('removes multiple trailing slashes (documented behaviour: strip all, not one)', () => {
    expect(normalise('https://shop.example///')).toBe('https://shop.example');
  });

  it('trims whitespace then strips trailing slashes together', () => {
    expect(normalise('  https://shop.example//  ')).toBe('https://shop.example');
  });

  it('leaves a path-bearing origin intact except for its trailing slash', () => {
    expect(normalise('https://shop.example/base/')).toBe('https://shop.example/base');
  });
});

/* -------------------------------------------------------------------------- */
/* Netlify resolver: getPublicConfig reads process.env and delegates to it.    */
/* -------------------------------------------------------------------------- */

describe('env.ts getPublicConfig site URL', () => {
  const KEY = 'PUBLIC_SITE_URL';
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[KEY];
  });
  afterEach(() => {
    if (previous === undefined) delete process.env[KEY];
    else process.env[KEY] = previous;
    vi.resetModules();
  });

  async function siteUrlFor(value: string | undefined): Promise<string> {
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    vi.resetModules();
    const mod = await import('@/lib/env');
    return mod.getPublicConfig({}).siteUrl;
  }

  it('normalises one trailing slash', async () => {
    expect(await siteUrlFor('https://shop.example/')).toBe('https://shop.example');
  });

  it('normalises multiple trailing slashes identically to the shared helper', async () => {
    expect(await siteUrlFor('https://shop.example///')).toBe('https://shop.example');
  });

  it('trims whitespace', async () => {
    expect(await siteUrlFor('  https://shop.example/  ')).toBe('https://shop.example');
  });

  it('throws CONFIG_UNAVAILABLE when missing', async () => {
    await expect(siteUrlFor(undefined)).rejects.toMatchObject({ code: 'CONFIG_UNAVAILABLE' });
  });

  it('throws CONFIG_UNAVAILABLE when blank', async () => {
    await expect(siteUrlFor('   ')).rejects.toMatchObject({ code: 'CONFIG_UNAVAILABLE' });
  });
});

/* -------------------------------------------------------------------------- */
/* Cloudflare resolver: getPublicConfig reads the Worker env (mocked).         */
/* -------------------------------------------------------------------------- */

describe('env.cloudflare.ts getPublicConfig site URL', () => {
  // A mutable object standing in for the `cloudflare:workers` module's `env`. The resolver reads
  // `env.PUBLIC_SITE_URL`; mutate this between cases.
  const workerEnv: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(workerEnv)) delete workerEnv[key];
    vi.resetModules();
    vi.doMock('cloudflare:workers', () => ({ env: workerEnv, ctx: { waitUntil() {}, passThroughOnException() {} } }));
  });
  afterEach(() => {
    vi.doUnmock('cloudflare:workers');
    vi.resetModules();
  });

  async function siteUrlFor(value: string | undefined): Promise<string> {
    if (value !== undefined) workerEnv.PUBLIC_SITE_URL = value;
    const mod = await import('@/lib/env.cloudflare');
    return mod.getPublicConfig({}).siteUrl;
  }

  it('normalises one trailing slash', async () => {
    expect(await siteUrlFor('https://shop.example/')).toBe('https://shop.example');
  });

  it('normalises multiple trailing slashes identically to the shared helper', async () => {
    expect(await siteUrlFor('https://shop.example///')).toBe('https://shop.example');
  });

  it('trims whitespace', async () => {
    expect(await siteUrlFor('  https://shop.example/  ')).toBe('https://shop.example');
  });

  it('throws CONFIG_UNAVAILABLE when missing', async () => {
    await expect(siteUrlFor(undefined)).rejects.toMatchObject({ code: 'CONFIG_UNAVAILABLE' });
  });

  it('throws CONFIG_UNAVAILABLE when blank', async () => {
    await expect(siteUrlFor('   ')).rejects.toMatchObject({ code: 'CONFIG_UNAVAILABLE' });
  });
});
