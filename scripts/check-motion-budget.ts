/**
 * The motion budget, enforced against the built output.
 *
 * Runs as `postbuild`, so `npm run build` fails when any of Requirement 21.15's three limits is
 * exceeded. It reads `dist/` rather than `src/` deliberately: the budget is about what a browser
 * receives, and a component's source template contains Astro expressions and comments that never
 * reach a page. Measuring the source would report a number nobody downloads.
 *
 * The four checks:
 *
 * 1. **Combined inline illustration markup ≤ 18 KB.** Each of the nine primitives is measured once,
 *    from its rendered `<svg>` — deduplicated by primitive name, because the budget is on the *set*
 *    of illustrations, not on how many times a page uses one. A page that renders nine category
 *    glyphs pays for nine glyphs in DOM nodes (which the 1,500-node budget covers) but only once
 *    against this one.
 * 2. **All nine primitives exist in the output.** Requirement 21.5 says the site provides nine
 *    animated primitives; a component that is never rendered provides nothing. This is the check
 *    that would have caught four of them sitting unused in the components directory.
 * 3. **At most four primitives per page.** Counted as *distinct* primitives, which is what the
 *    design's "no page uses more than four of them" means — "them" being the nine.
 * 4. **At most twelve simultaneously animating elements.**
 *
 * **On check 4 and the word "simultaneously".** A page-wide count of animating elements is not a
 * count of simultaneous ones: a section that reveals when it is scrolled to does not animate while
 * a section eight screens above it is animating. So the count is taken **per top-level `<section>`**,
 * which is the largest unit that plausibly animates at once. This is an approximation and it is the
 * conservative direction of one — it is possible to arrange two adjacent short sections that reveal
 * together, and a page-wide count would instead fail every long page for something no visitor could
 * ever see at once. The number reported per page is printed either way, so a reviewer can see the
 * total as well as the enforced maximum.
 *
 * An element inside a `[data-motion-group]` does not carry its own `data-reveal` — the group does —
 * so a staggered group counts as one, which is exactly the design's rule that "staggered groups
 * count as one only if they share a parent animation".
 *
 * Design: Motion System → Keeping motion inside the budget.
 * Requirements: 21.5, 21.9, 21.15.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

/** Requirement 21.15's three numbers. */
const MAX_MARKUP_BYTES = 18 * 1024;
const MAX_PRIMITIVES_PER_PAGE = 4;
const MAX_ANIMATING_PER_SECTION = 12;

/** The nine, by the `data-ngf-primitive` value each emits. */
const EXPECTED_PRIMITIVES = [
  'furniture-line',
  'chair',
  'sofa',
  'bed',
  'table',
  'room',
  'craftsmanship',
  'assembly',
  'category',
] as const;

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

/**
 * Every `<svg …data-ngf-primitive="name"…>…</svg>` in a document, with its name.
 *
 * A hand-rolled scan rather than a parser: the primitives contain no nested `<svg>` (the whole set
 * is `<path>` and `<g>` elements), so finding the matching `</svg>` is a plain forward search. Adding
 * an HTML parser to the dev dependencies to count nine elements would cost more than it explains.
 */
function primitivesIn(html: string): { name: string; markup: string }[] {
  const found: { name: string; markup: string }[] = [];
  const opening = /<svg\b[^>]*\bdata-ngf-primitive="([^"]+)"[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(html)) !== null) {
    const close = html.indexOf('</svg>', match.index);
    if (close === -1) continue;
    found.push({ name: match[1] ?? '', markup: html.slice(match.index, close + 6) });
  }
  return found;
}

/** Split a document into its top-level sections, plus whatever sits outside one. */
function sectionsIn(html: string): string[] {
  const parts = html.split(/<section\b/i);
  return parts.length === 1 ? [html] : parts;
}

/** `data-reveal` occurrences: one per independently triggered animation. */
function countAnimating(fragment: string): number {
  return (fragment.match(/\sdata-reveal(?=[\s=>])/g) ?? []).length;
}

interface Failure {
  page: string;
  message: string;
}

function main(): void {
  let pages: string[];
  try {
    pages = htmlFilesUnder(DIST);
  } catch {
    console.error(
      `[motion-budget] no build output at ${relative(ROOT, DIST)} — run the build first`,
    );
    process.exit(1);
  }

  const failures: Failure[] = [];
  /** name → the largest rendered markup seen for it. */
  const markupByName = new Map<string, string>();

  for (const page of pages) {
    const label = relative(DIST, page);
    const html = readFileSync(page, 'utf8');
    const instances = primitivesIn(html);

    for (const instance of instances) {
      const existing = markupByName.get(instance.name);
      // The largest instance is the honest measurement: `AnimatedRoom` renders its furniture only
      // when `furnished` is true, and the budget has to cover the version that ships the most bytes.
      if (existing === undefined || instance.markup.length > existing.length) {
        markupByName.set(instance.name, instance.markup);
      }
    }

    const distinct = new Set(instances.map((instance) => instance.name));
    if (distinct.size > MAX_PRIMITIVES_PER_PAGE) {
      failures.push({
        page: label,
        message:
          `uses ${String(distinct.size)} distinct primitives (${[...distinct].sort().join(', ')}); ` +
          `Requirement 21.15 allows ${String(MAX_PRIMITIVES_PER_PAGE)}`,
      });
    }

    const perSection = sectionsIn(html).map(countAnimating);
    const worst = perSection.length === 0 ? 0 : Math.max(...perSection);
    const total = countAnimating(html);
    if (worst > MAX_ANIMATING_PER_SECTION) {
      failures.push({
        page: label,
        message:
          `one section animates ${String(worst)} elements simultaneously; ` +
          `Requirement 21.9 allows ${String(MAX_ANIMATING_PER_SECTION)}`,
      });
    }
    if (total > 0) {
      console.log(
        `[motion-budget] ${label}: ${String(distinct.size)} primitive(s), ` +
          `${String(total)} animating element(s) across the page, worst section ${String(worst)}`,
      );
    }
  }

  // 2. All nine present.
  const missing = EXPECTED_PRIMITIVES.filter((name) => !markupByName.has(name));
  if (missing.length > 0) {
    failures.push({
      page: '(build)',
      message:
        `these primitives are never rendered on any page: ${missing.join(', ')}. ` +
        'Requirement 21.5 asks the site to provide nine animated illustrations; an unused component provides none.',
    });
  }

  // 1. The combined markup budget.
  let combined = 0;
  for (const [name, markup] of [...markupByName].sort(([a], [b]) => a.localeCompare(b))) {
    combined += Buffer.byteLength(markup, 'utf8');
    console.log(`[motion-budget]   ${name}: ${String(Buffer.byteLength(markup, 'utf8'))} B`);
  }
  console.log(
    `[motion-budget] combined illustration markup: ${String(combined)} B of ${String(MAX_MARKUP_BYTES)} B`,
  );
  if (combined > MAX_MARKUP_BYTES) {
    failures.push({
      page: '(build)',
      message: `combined illustration markup is ${String(combined)} B; Requirement 21.15 allows ${String(MAX_MARKUP_BYTES)} B`,
    });
  }

  if (failures.length > 0) {
    console.error('\n[motion-budget] FAILED');
    for (const failure of failures) console.error(`  ${failure.page}: ${failure.message}`);
    process.exit(1);
  }
  console.log('[motion-budget] every motion budget is within its limit');
}

main();
