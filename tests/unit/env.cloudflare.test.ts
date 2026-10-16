import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Cloudflare configuration boundary', () => {
  const runtime: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(runtime)) delete runtime[key];
    vi.resetModules();
    vi.doMock('cloudflare:workers', () => ({ env: runtime }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('cloudflare:workers');
    vi.resetModules();
  });

  it('never uses a build-time secret when its runtime binding is absent', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'synthetic-build-only-secret');
    const { requireSecret } = await import('@/lib/env.cloudflare');
    expect(() => requireSecret({}, 'GITHUB_TOKEN')).toThrow(
      expect.objectContaining({ code: 'CONFIG_UNAVAILABLE' }),
    );
  });

  it('reads secrets from runtime bindings and rejects blank runtime values', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'synthetic-build-only-secret');
    runtime.GITHUB_TOKEN = ' synthetic-runtime-only-secret ';
    const { requireSecret } = await import('@/lib/env.cloudflare');
    expect(requireSecret({}, 'GITHUB_TOKEN')).toBe('synthetic-runtime-only-secret');
    runtime.GITHUB_TOKEN = '';
    expect(() => requireSecret({}, 'GITHUB_TOKEN')).toThrow();
  });

  it('allows only public configuration to fall back to build-time values', async () => {
    vi.stubEnv('PUBLIC_SITE_URL', 'https://shop.example/');
    vi.stubEnv('PUBLIC_WHATSAPP_NUMBERS', '+910000000001');
    vi.stubEnv('PUBLIC_PHONE_NUMBERS', '+910000000002');
    const { getPublicConfig } = await import('@/lib/env.cloudflare');
    expect(getPublicConfig()).toEqual({
      siteUrl: 'https://shop.example',
      whatsappNumbers: ['+910000000001'],
      phoneNumbers: ['+910000000002'],
    });
    runtime.PUBLIC_SITE_URL = 'https://preview.example/';
    expect(getPublicConfig().siteUrl).toBe('https://preview.example');
  });
});
