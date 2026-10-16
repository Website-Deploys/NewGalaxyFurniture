import { build } from 'vite';
import type { RolldownOutput } from 'rolldown';
import { describe, expect, it } from 'vitest';

import { cloudflareBuildEnvironment } from '../../scripts/cloudflare-build-environment.mjs';

describe('Cloudflare production build environment', () => {
  it('pins public configuration and omits generated local-preview credentials', async () => {
    const publicConfig = {
      PUBLIC_SITE_URL: 'https://shop.example',
      PUBLIC_PHONE_NUMBERS: '+910000000001',
      GITHUB_TOKEN: 'synthetic-private-marker',
    };
    const guard = cloudflareBuildEnvironment(publicConfig);
    publicConfig.PUBLIC_SITE_URL = 'http://localhost:4321';

    const result = (await build({
      configFile: false,
      envDir: false,
      publicDir: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'synthetic-local-preview-producer',
          resolveId: (id) => (id === 'virtual:entry' ? id : undefined),
          load: (id) =>
            id === 'virtual:entry'
              ? 'console.log(import.meta.env.PUBLIC_SITE_URL, import.meta.env.PUBLIC_PHONE_NUMBERS)'
              : undefined,
          generateBundle() {
            this.emitFile({
              type: 'asset',
              fileName: '.dev.vars',
              source: 'GITHUB_TOKEN=synthetic-private-marker',
            });
          },
        },
        guard,
      ],
      build: {
        write: false,
        minify: false,
        rolldownOptions: { input: 'virtual:entry' },
      },
    })) as RolldownOutput;

    expect(result.output.some((item) => item.fileName === '.dev.vars')).toBe(false);
    const code = result.output
      .filter((item) => item.type === 'chunk')
      .map((item) => item.code)
      .join('\n');
    expect(code).toContain('https://shop.example');
    expect(code).toContain('+910000000001');
    expect(code).not.toContain('localhost');
    expect(code).not.toContain('synthetic-private-marker');
  });

  it('does not apply to the local development server', () => {
    expect(cloudflareBuildEnvironment({}).apply).toBe('build');
  });
});
