/**
 * The Content-Security-Policy audit of the build output.
 *
 * The design requires zero CSP violations on every public page, and the policy is strict enough
 * that a single carelessly added tag breaks a page rather than degrading it — an inline script under
 * `script-src 'self'` does not warn, it does not run. Waiting for a browser to tell us that is
 * waiting until after deploy, so this reads the artifact and fails the build instead.
 *
 * What counts as a violation of the deployed policy:
 *
 * | Directive | Violation this looks for |
 * |---|---|
 * | `script-src` | a `<script>` whose inline body hashes to something not in `FRAMEWORK_INLINE_SCRIPTS`, or a `<script src>` on another origin |
 * | `script-src 'self'` | an inline event-handler attribute (`onclick=`, `onerror=`, …) |
 * | *any* | a `javascript:` URL in `href`, `src`, `action`, or `formaction` |
 * | `object-src 'none'` | `<object>` or `<embed>` |
 * | `frame-src 'none'` | `<iframe>` |
 * | `base-uri 'none'` | `<base>` |
 * | `form-action 'self'` | a `<form action>` on another origin |
 * | `style-src`, `font-src`, `img-src` | a cross-origin stylesheet, font, or image (`data:` is allowed for images) |
 *
 * The inline-script check is a hash check rather than a ban, because Astro's island bootstrap is
 * emitted as literal inline `<script>` elements with no way to externalise it — see
 * `src/lib/security/inline-script-hashes.ts` for why hashing those four is the only honest option.
 * The check runs in both directions: an inline script whose hash is not on the list is a violation,
 * and the `client:load` entry (used only by the server-rendered admin, which never appears in
 * `dist/client/`) is re-derived from the installed Astro package and must still match — so an Astro
 * upgrade that changes a byte fails here rather than in production.
 *
 * Two things are deliberately **not** violations. A `<script type="application/ld+json">` (or
 * `application/json`) block is a data block: it is not executable, and CSP does not govern it —
 * that is what makes the structured data compatible with the strictest `script-src`. And an inline
 * `style` attribute or a `<style>` element is allowed, because `style-src` carries
 * `'unsafe-inline'` for exactly one reason: Astro inlines critical and scoped CSS.
 *
 * Runs in `postbuild`. Usage: tsx scripts/audit-csp.ts [dist/client]
 *
 * Design: Deployment. Requirements: 25.9, 25.10.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FRAMEWORK_INLINE_SCRIPTS } from '../src/lib/security/inline-script-hashes';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_DIR = join(ROOT, 'dist', 'client');

/** Script types that are data, not code. CSP does not apply to these. */
const DATA_SCRIPT_TYPES = [
  'application/ld+json',
  'application/json',
  'importmap',
  'speculationrules',
];

export interface CspViolation {
  page: string;
  directive: string;
  detail: string;
}

/** `sha256-<base64>` over the exact bytes, which is what a CSP hash is computed over. */
export function sha256Of(text: string): string {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

const ALLOWED_HASHES = new Map(
  FRAMEWORK_INLINE_SCRIPTS.map((entry) => [entry.hash, entry.source] as const),
);

/**
 * The `client:load` loader, re-derived from the installed Astro package.
 *
 * It is the one allowlisted script that never appears in `dist/client/` — only the server-rendered
 * admin uses `client:load` — so the HTML scan cannot cover it. Astro exports these loaders as a
 * single-template-literal module with no interpolation and no escapes, so reading between the first
 * and last backtick reproduces the exact string the renderer will inline. If Astro ever changes that
 * shape, this returns something that is not on the list and the audit fails loudly, which is the
 * correct outcome for "we can no longer verify the hash".
 */
function derivedLoadDirectiveHash(): { hash: string; ok: boolean } {
  const file = join(ROOT, 'node_modules', 'astro', 'dist', 'runtime', 'client', 'load.prebuilt.js');
  try {
    const source = readFileSync(file, 'utf8');
    const first = source.indexOf('`');
    const last = source.lastIndexOf('`');
    if (first === -1 || last <= first) return { hash: '<unreadable>', ok: false };
    return { hash: sha256Of(source.slice(first + 1, last)), ok: true };
  } catch {
    return { hash: '<unreadable>', ok: false };
  }
}

function htmlFilesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.html')) found.push(full);
    }
  };
  walk(directory);
  return found;
}

/** Same-origin, in the sense `'self'` means: a root-relative or relative URL. */
function isSelf(url: string): boolean {
  const value = url.trim();
  if (value === '') return true;
  if (value.startsWith('#')) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//');
}

function attributeOf(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (match === null) return null;
  return match[2] ?? match[3] ?? match[4] ?? '';
}

export function auditHtml(html: string, page: string): CspViolation[] {
  const violations: CspViolation[] = [];
  const add = (directive: string, detail: string): void => {
    violations.push({ page, directive, detail });
  };

  // --- scripts -------------------------------------------------------------
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let script: RegExpExecArray | null;
  while ((script = scriptPattern.exec(html)) !== null) {
    const attributes = script[1] ?? '';
    const body = script[2] ?? '';
    const type = (attributeOf(`<script ${attributes}>`, 'type') ?? '').toLowerCase();
    const src = attributeOf(`<script ${attributes}>`, 'src');

    if (DATA_SCRIPT_TYPES.includes(type)) continue;

    if (src === null) {
      if (body.trim() !== '' && !ALLOWED_HASHES.has(sha256Of(body))) {
        add(
          'script-src',
          `inline script with no allowlisted hash (${String(body.length)} chars, ` +
            `${sha256Of(body)}): ${body.trim().slice(0, 80)}…`,
        );
      }
      continue;
    }
    if (!isSelf(src)) add("script-src 'self'", `cross-origin script: ${src}`);
    if (body.trim() !== '') {
      add('script-src', 'a <script src> element also carries an inline body');
    }
  }

  // --- inline event handlers ----------------------------------------------
  // Bounded to attribute position: `\son\w+\s*=` inside a tag. Matching document-wide would flag
  // the word "on" in prose.
  const tagPattern = /<[a-z][^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagPattern.exec(html)) !== null) {
    const markup = tag[0];
    const handler = /\s(on[a-z]+)\s*=/i.exec(markup);
    if (handler !== null) {
      add(
        "script-src 'self'",
        `inline event handler ${String(handler[1])} on: ${markup.slice(0, 90)}`,
      );
    }
    for (const attribute of ['href', 'src', 'action', 'formaction']) {
      const value = attributeOf(markup, attribute);
      if (value !== null && /^\s*javascript:/i.test(value)) {
        add("script-src 'self'", `javascript: URL in ${attribute}: ${value.slice(0, 60)}`);
      }
    }
  }

  // --- forbidden elements --------------------------------------------------
  if (/<iframe\b/i.test(html)) add("frame-src 'none'", '<iframe> present');
  if (/<object\b/i.test(html)) add("object-src 'none'", '<object> present');
  if (/<embed\b/i.test(html)) add("object-src 'none'", '<embed> present');
  if (/<base\b/i.test(html)) add("base-uri 'none'", '<base> present');

  // --- cross-origin subresources ------------------------------------------
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const markup = match[0];
    const rel = (attributeOf(markup, 'rel') ?? '').toLowerCase();
    const href = attributeOf(markup, 'href');
    if (href === null || isSelf(href)) continue;
    if (rel.includes('stylesheet')) add("style-src 'self'", `cross-origin stylesheet: ${href}`);
    else if (rel.includes('preload') && (attributeOf(markup, 'as') ?? '') === 'font') {
      add("font-src 'self'", `cross-origin font: ${href}`);
    }
  }

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = attributeOf(match[0], 'src');
    if (src === null || isSelf(src) || /^data:/i.test(src)) continue;
    add("img-src 'self' data:", `cross-origin image: ${src}`);
  }

  for (const match of html.matchAll(/<form\b[^>]*>/gi)) {
    const action = attributeOf(match[0], 'action');
    if (action === null || isSelf(action)) continue;
    add("form-action 'self'", `cross-origin form action: ${action}`);
  }

  return violations;
}

export function auditDirectory(directory: string): { violations: CspViolation[]; pages: number } {
  const pages = htmlFilesUnder(directory);
  const violations = pages.flatMap((page) =>
    auditHtml(readFileSync(page, 'utf8'), relative(directory, page)),
  );
  return { violations, pages: pages.length };
}

function main(): void {
  const target = process.argv[2] ?? DEFAULT_DIR;
  try {
    if (!statSync(target).isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`[audit-csp] no build output at ${relative(ROOT, target)} — run the build first`);
    process.exitCode = 1;
    return;
  }

  const { violations, pages } = auditDirectory(target);

  // The one allowlisted hash the HTML scan cannot reach.
  const derived = derivedLoadDirectiveHash();
  if (!derived.ok || !ALLOWED_HASHES.has(derived.hash)) {
    violations.push({
      page: 'node_modules/astro (client:load loader)',
      directive: 'script-src',
      detail:
        `the installed Astro's client:load loader hashes to ${derived.hash}, which is not in ` +
        'FRAMEWORK_INLINE_SCRIPTS — the admin would stop hydrating. Update the list after ' +
        'reviewing what changed.',
    });
  }

  if (violations.length === 0) {
    console.log(
      `[audit-csp] ${String(pages)} page(s): 0 violations of the deployed policy — every inline ` +
        `script hashes to one of the ${String(ALLOWED_HASHES.size)} allowlisted framework ` +
        'bootstraps, no inline handler, no cross-origin subresource, no frame or object.',
    );
    return;
  }

  console.error(`[audit-csp] FAILED with ${String(violations.length)} violation(s):`);
  for (const violation of violations) {
    console.error(`  ${violation.page} — ${violation.directive}: ${violation.detail}`);
  }
  console.error(
    '\nThe policy is not the thing to change. Move the code into an external same-origin module, ' +
      'or attach the handler from one.',
  );
  process.exitCode = 1;
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('audit-csp.ts');
if (invokedDirectly) {
  main();
}
