import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { scanDirectory, scanText } from '../../scripts/scan-secrets';

/**
 * Property 51: No secret pattern appears in the build output.
 *
 * **Validates: Requirements 16.14, 17.2, 23.3, 25.12, 25.13, 26.15, 28.5, 28.6, 28.7**
 *
 * The design calls for "an exhaustive scan of built output against the pattern set — a total-coverage
 * assertion rather than a sampled one", which is why this is not a property test: sampling would be
 * strictly weaker than reading every file, and reading every file is cheap. `npm run scan:secrets` is
 * the gate; this suite pins down the two things the gate's *correctness* depends on and that a change
 * to it could quietly break.
 *
 * 1. **The pattern set actually matches.** A scanner whose regexes have drifted reports "clean" on a
 *    leak, which is worse than no scanner because it is trusted. Each pattern is exercised against a
 *    string it must catch.
 * 2. **The two scopes stay distinct.** Credential *values* are forbidden everywhere under `dist/`,
 *    including the Worker bundle. Credential *names* are forbidden in client-reachable output only,
 *    because server code must name its bindings to read them — flagging that would be a false
 *    positive on every build, and a false positive that appears every time is a scanner that gets
 *    switched off.
 *
 * The scan of the real output runs when `dist/` exists. It usually does not during `npm test`, which
 * runs before the build in the gate order, so the authoritative run is the `scan:secrets` gate after
 * the build. When it is there, it is asserted.
 */

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

describe('Property 51: no secret pattern appears in the build output', () => {
  it('matches every credential value pattern, wherever it sits', () => {
    const cases: [string, string][] = [
      ['client/app.js', `const t = "ghp_${'A'.repeat(36)}";`],
      ['client/app.js', `const t = "github_pat_${'B'.repeat(22)}";`],
      ['client/app.js', 'const k = "sk-abcdefghijklmnopqrstuvwxyz";'],
      ['client/app.js', '-----BEGIN RSA PRIVATE KEY-----'],
      // The same values in the server bundle are equally forbidden: a real credential in any
      // artifact is a leak wherever it sits.
      ['server/index.js', `const t = "ghp_${'C'.repeat(36)}";`],
      ['server/index.js', '-----BEGIN PRIVATE KEY-----'],
    ];

    for (const [path, text] of cases) {
      expect(scanText(path, text), `${path}: ${text.slice(0, 24)}`).not.toEqual([]);
    }
  });

  it('redacts the match rather than printing the credential into a CI log', () => {
    const [finding] = scanText('client/app.js', `const t = "ghp_${'A'.repeat(36)}";`);
    expect(finding).toBeDefined();
    expect(finding?.excerpt).not.toContain('A'.repeat(36));
    expect(finding?.excerpt).toContain('*');
    expect(finding?.line).toBe(1);
  });

  it('forbids credential names in client-reachable output', () => {
    expect(scanText('client/_astro/x.js', 'const k = env.AI_API_KEY;')).not.toEqual([]);
    expect(scanText('client/_astro/x.js', 'const s = env.SESSION_SECRET;')).not.toEqual([]);
    // Not only under `client/`: anything that is not the server bundle is client-reachable.
    expect(scanText('index.html', 'AI_API_KEY')).not.toEqual([]);
  });

  it('allows credential names in the server bundle, where naming a binding is how it is read', () => {
    expect(scanText('server/chunks/env.js', 'const k = env.AI_API_KEY;')).toEqual([]);
    expect(scanText('server/chunks/env.js', 'const s = env.SESSION_SECRET;')).toEqual([]);
    expect(scanText('_worker.js/index.js', 'env.SESSION_SECRET')).toEqual([]);
  });

  it('reports clean on output that carries no credential', () => {
    expect(scanText('client/app.js', 'const total = price * quantity;')).toEqual([]);
    // A near-miss that must not trip the AI-key pattern: `sk-` needs 16+ characters after it.
    expect(scanText('client/app.js', 'className="sk-2"')).toEqual([]);
  });

  it.runIf(existsSync(DIST))('finds nothing in the real build output', async () => {
    const findings = await scanDirectory(DIST);
    expect(
      findings,
      findings.map((finding) => `${finding.file}:${finding.line} ${finding.pattern}`).join('\n'),
    ).toEqual([]);
  });
});
