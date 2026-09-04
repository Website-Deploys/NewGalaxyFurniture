import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * No template may emit an inline DOM event handler.
 *
 * The deployed policy is `script-src 'self'` plus four framework-bootstrap hashes, with no
 * `'unsafe-inline'` — so an `onerror=` or `onclick=` attribute is not a style preference here, it is
 * code the browser refuses to run.
 *
 * This test exists because that happened. `ResponsiveImage.astro` carried
 * `onerror="this.closest('.ngf-image')?.setAttribute('data-failed','true')"`, which meant every
 * product image on the site silently lost its load-failure fallback. `scripts/audit-csp.ts` catches
 * inline handlers, and it did — but only in a build that renders a product, and the catalogue ships
 * empty, so no build had rendered one. The defect sat behind a gate that could not see it.
 *
 * A static scan of the templates has no such blind spot: it does not care whether a component
 * happens to be rendered by the current content.
 *
 * Requirements: 25.6, 25.9, 25.10.
 * Design: Security → Content security policy.
 */

/**
 * A lowercase `on…="…"` attribute.
 *
 * Deliberately narrow. React props are camelCase (`onClick={…}`) and are function references rather
 * than quoted strings, so an island's props do not match; a DOM attribute in `.astro` markup is
 * lowercase with a quoted value, and does.
 */
const INLINE_HANDLER = /\son[a-z]+\s*=\s*["']/g;

function astroFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...astroFiles(path));
    else if (entry.endsWith('.astro')) found.push(path);
  }
  return found;
}

describe('inline event handlers', () => {
  const files = astroFiles('src');

  it('scans a meaningful number of templates', () => {
    // Guards the guard: a scan that silently found no files would pass for the wrong reason.
    expect(files.length).toBeGreaterThan(30);
  });

  it('appears in no Astro template', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(INLINE_HANDLER)) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${file}:${String(line)} — ${match[0].trim()}`);
      }
    }
    expect(
      offenders,
      `inline event handler(s) the deployed CSP will refuse to run:\n${offenders.join('\n')}`,
    ).toStrictEqual([]);
  });

  it('recognises the handler it was written to catch', () => {
    // The pattern, asserted against the exact attribute that shipped, and against the React prop
    // form it must not flag.
    const shipped = ` onerror="this.closest('.ngf-image')?.setAttribute('data-failed','true')"`;
    expect(INLINE_HANDLER.test(shipped)).toBe(true);
    INLINE_HANDLER.lastIndex = 0;
    expect(INLINE_HANDLER.test(' onChange={handleChange}')).toBe(false);
    INLINE_HANDLER.lastIndex = 0;
    expect(INLINE_HANDLER.test(' onKeyDown={onKeyDown}')).toBe(false);
    INLINE_HANDLER.lastIndex = 0;
  });
});
