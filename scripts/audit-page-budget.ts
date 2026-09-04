/**
 * The page-shape rules from the design's "Techniques (binding, not optional)" list.
 *
 * `size-limit` measures bytes. These four rules are not about bytes, they are about shape, and each
 * one is a rule the design states as prohibited rather than discouraged:
 *
 * 1. **At most one preloaded image per page.** Two preloads compete for the same early bandwidth and
 *    the second one delays the first, which makes LCP worse than not preloading at all.
 * 2. **At most 1,500 DOM nodes on any public page.** Past that, style recalculation on a mid-range
 *    phone starts to dominate interaction latency regardless of how small the JavaScript is.
 * 3. **Every island is `client:visible` or `client:idle`** on a public page — never `client:load`.
 *    `client:load` hydrates during the initial load, which is precisely the "no marketing component
 *    hydrates eagerly" rule. Admin is exempt and is not in this output.
 * 4. **Zero third-party scripts on any public critical path** — no chat widget, no tag manager, no
 *    web-font CDN. Checked here as "no cross-origin subresource of any kind", which is the same
 *    condition from the other direction and is also what `scripts/audit-csp.ts` enforces as policy.
 *
 * Each is measured from the built HTML, so what is checked is what deploys.
 *
 * Runs in `postbuild`. Usage: tsx scripts/audit-page-budget.ts [dist/client]
 *
 * Design: Performance Budgets → Techniques.
 * Requirements: 22.9, 22.10, 22.11, 22.12, 22.13.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_DIR = join(ROOT, 'dist', 'client');

export const MAX_DOM_NODES = 1500;
export const MAX_PRELOADED_IMAGES = 1;

export interface PageProblem {
  page: string;
  rule: string;
  detail: string;
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

function attributeOf(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (match === null) return null;
  return match[2] ?? match[3] ?? match[4] ?? '';
}

/**
 * Element count, as an approximation of DOM nodes.
 *
 * Every opening tag, minus the void elements' non-existent closers, minus comments and the doctype.
 * It undercounts text nodes, which a browser also counts — so the real figure is higher and the
 * margin below the limit is what matters, not the exact number. A parser would give a truer count
 * and would be a dependency added to count elements.
 */
export function countElements(html: string): number {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  return (withoutComments.match(/<[a-z][a-z0-9-]*\b/gi) ?? []).length;
}

/** `<link rel="preload" as="image">` — the LCP hint, which may appear at most once. */
export function countPreloadedImages(html: string): number {
  return [...html.matchAll(/<link\b[^>]*>/gi)].filter((match) => {
    const tag = match[0];
    const rel = (attributeOf(tag, 'rel') ?? '').toLowerCase();
    if (!rel.split(/\s+/).includes('preload')) return false;
    const as = (attributeOf(tag, 'as') ?? '').toLowerCase();
    return as === 'image' || attributeOf(tag, 'imagesrcset') !== null;
  }).length;
}

/**
 * `rel` values on a `<link>` that cause a fetch.
 *
 * The distinction matters: `rel="canonical"` carries an absolute URL on this site by design — it is
 * a *statement* about identity, not a request — and counting it as a third-party subresource flagged
 * all twenty-four pages on the first run. Only the rels that make the browser go and get something
 * are subresources.
 */
const FETCHING_RELS = [
  'stylesheet',
  'preload',
  'modulepreload',
  'prefetch',
  'prerender',
  'icon',
  'shortcut',
  'apple-touch-icon',
  'manifest',
];

/** Cross-origin subresource URLs: scripts, stylesheets, fonts, images, media. */
export function crossOriginSubresources(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/<(script|link|img|source|video|audio)\b[^>]*>/gi)) {
    const tag = match[0];
    if (/^<link\b/i.test(tag)) {
      const rel = (attributeOf(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
      if (!rel.some((value) => FETCHING_RELS.includes(value))) continue;
    }
    for (const attribute of ['src', 'href', 'srcset', 'imagesrcset']) {
      const value = attributeOf(tag, attribute);
      if (value === null || value === '') continue;
      for (const candidate of value.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '')) {
        if (candidate === '' || candidate.startsWith('data:')) continue;
        if (/^https?:\/\//i.test(candidate) || candidate.startsWith('//')) found.push(candidate);
      }
    }
  }
  return [...new Set(found)];
}

/** Island hydration directives, read from the `client` attribute Astro puts on `astro-island`. */
export function hydrationDirectives(html: string): string[] {
  return [...html.matchAll(/<astro-island\b[^>]*>/gi)]
    .map((match) => attributeOf(match[0], 'client') ?? '')
    .filter((value) => value !== '');
}

const ALLOWED_PUBLIC_DIRECTIVES = ['visible', 'idle', 'media'];

export function auditPage(html: string, page: string): PageProblem[] {
  const problems: PageProblem[] = [];

  const nodes = countElements(html);
  if (nodes > MAX_DOM_NODES) {
    problems.push({
      page,
      rule: `at most ${String(MAX_DOM_NODES)} DOM nodes`,
      detail: `${String(nodes)} elements`,
    });
  }

  const preloads = countPreloadedImages(html);
  if (preloads > MAX_PRELOADED_IMAGES) {
    problems.push({
      page,
      rule: `at most ${String(MAX_PRELOADED_IMAGES)} preloaded image`,
      detail: `${String(preloads)} image preloads — the second delays the first`,
    });
  }

  for (const url of crossOriginSubresources(html)) {
    problems.push({ page, rule: 'no third-party subresource', detail: url });
  }

  for (const directive of hydrationDirectives(html)) {
    if (!ALLOWED_PUBLIC_DIRECTIVES.includes(directive)) {
      problems.push({
        page,
        rule: 'islands hydrate on visibility or idle, never on load',
        detail: `client:${directive}`,
      });
    }
  }

  return problems;
}

export interface AuditSummary {
  problems: PageProblem[];
  pages: number;
  worstNodes: { page: string; nodes: number };
  directives: Set<string>;
}

export function auditDirectory(directory: string): AuditSummary {
  const files = htmlFilesUnder(directory);
  const problems: PageProblem[] = [];
  let worstNodes = { page: '(none)', nodes: 0 };
  const directives = new Set<string>();

  for (const file of files) {
    const page = relative(directory, file);
    const html = readFileSync(file, 'utf8');
    problems.push(...auditPage(html, page));
    const nodes = countElements(html);
    if (nodes > worstNodes.nodes) worstNodes = { page, nodes };
    for (const directive of hydrationDirectives(html)) directives.add(directive);
  }

  return { problems, pages: files.length, worstNodes, directives };
}

function main(): void {
  const target = process.argv[2] ?? DEFAULT_DIR;
  try {
    if (!statSync(target).isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(
      `[page-budget] no build output at ${relative(ROOT, target)} — run the build first`,
    );
    process.exitCode = 1;
    return;
  }

  const { problems, pages, worstNodes, directives } = auditDirectory(target);

  if (problems.length === 0) {
    console.log(
      `[page-budget] ${String(pages)} page(s): busiest DOM is ${worstNodes.page} at ` +
        `${String(worstNodes.nodes)} of ${String(MAX_DOM_NODES)} elements; hydration is ` +
        `${directives.size === 0 ? 'none' : [...directives].sort().join(', ')}; ` +
        'at most one image preloaded per page; no third-party subresource.',
    );
    return;
  }

  console.error(`[page-budget] FAILED with ${String(problems.length)} problem(s):`);
  for (const problem of problems) {
    console.error(`  ${problem.page} — ${problem.rule}: ${problem.detail}`);
  }
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('audit-page-budget.ts');
if (invokedDirectly) {
  main();
}
