// @ts-check
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';
import prettier from 'eslint-config-prettier';

/**
 * Flat config. Type-aware rules are on for `src/`, `tests/` and `scripts/`,
 * because the rules worth having here (no floating promises, no unsafe `any`
 * flowing into a privileged call) all need type information.
 *
 * Formatting is Prettier's job: `eslint-config-prettier` is last so no stylistic
 * rule can conflict with `npm run format`.
 *
 * Design: Testing Strategy → CI gates.
 * Requirements: 27.12, 28.3.
 */
export default defineConfig(
  {
    ignores: [
      'dist/**',
      '.astro/**',
      '.wrangler/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'coverage/**',
      'public/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...astro.configs.recommended,

  // Type-aware linting for everything TypeScript can see. `.astro` files are
  // excluded below because `astro-eslint-parser` does not support
  // `projectService` and would emit a warning on every run.
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    rules: {
      // Unused code is either a mistake or dead weight; `_`-prefixed args are the
      // documented escape hatch.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Type-only imports must be explicit — `verbatimModuleSyntax` is on.
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // A dropped promise in the write pipeline silently loses a content commit.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // `any` reaching a privileged call is exactly what the Zod gates prevent.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          /**
           * Hard-coded hostnames break the "attaching a domain is config only"
           * requirement (28.9) and the SEO canonical checks.
           *
           * The allowlist covers hosts that are *not* site configuration:
           * - `localhost` / `127.0.0.1` — local development only.
           * - `schema.org`, `www.w3.org` — vocabulary URIs, which are identifiers
           *   rather than endpoints; changing them would change their meaning.
           * - `api.github.com`, `api.cloudflare.com` — upstream service endpoints.
           *   These are deliberately *not* configurable: the write pipeline sends a
           *   `contents:write` credential to the first and an account token to the
           *   second, so a settable host would be a way to redirect a secret to a
           *   host of someone else's choosing. Both remain injectable per call site
           *   for tests (`GitHubClientConfig.apiBase`), which is a compile-time
           *   argument rather than runtime configuration.
           * - `api.openai.com`, `api.anthropic.com` — the AI provider endpoints, for
           *   exactly the same reason and it is the stronger case: the adapters send
           *   `AI_API_KEY` to them, so a host read from configuration would turn a
           *   settings edit into a credential exfiltration path. The provider is
           *   selected by the `AI_PROVIDER` secret from a closed switch (see
           *   `src/lib/ai/factory.ts`); the *host* each adapter talks to is fixed in
           *   that adapter's own file. Workers AI needs no literal host at all — it is
           *   reached through the `AI` binding.
           */
          selector:
            'Literal[value=/^https?:\\/\\/(?!localhost|127\\.0\\.0\\.1|schema\\.org|www\\.w3\\.org|api\\.github\\.com|api\\.cloudflare\\.com|api\\.openai\\.com|api\\.anthropic\\.com)/]',
          message:
            'No hard-coded hostname. Read the origin from PUBLIC_SITE_URL via src/lib/env.ts.',
        },
      ],
    },
  },

  /**
   * `.size-limit.mjs` is a config file, not application code, and it is outside `tsconfig.json`'s
   * `include` — so the type-aware parser has no program for it and refuses to parse it at all.
   * Linting it without type information is the right trade: it is thirty lines of file-system glue
   * whose real check is that `npm run size-limit` produces the budgets it is supposed to.
   */
  {
    files: ['.size-limit.mjs'],
    languageOptions: { parserOptions: { projectService: false, project: false } },
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Config files and scripts run in Node, not in the Worker.
  {
    files: ['*.config.{js,mjs,ts}', '.size-limit.mjs', 'scripts/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        URL: 'readonly',
        Intl: 'readonly',
      },
    },
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // Tests may name hosts and reach for looser types.
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      /**
       * Test doubles implement async interfaces synchronously.
       *
       * `MemoryKV` has to satisfy `KVNamespace`, whose every method returns a promise,
       * and an in-memory map has nothing to await. The alternative — wrapping each body
       * in `await Promise.resolve()` — adds noise that says nothing. The rule stays on
       * for `src/`, where a promise-returning function that never awaits usually is a
       * mistake.
       */
      '@typescript-eslint/require-await': 'off',
    },
  },

  /**
   * `.astro` files are linted without type information, and this block must stay
   * last so the type-aware rules enabled above are switched back off for them.
   * `astro-eslint-parser` does not forward `projectService`; `astro check`
   * already type-checks these files, so nothing is lost.
   */
  {
    files: ['**/*.astro'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
);
