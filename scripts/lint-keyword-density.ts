/**
 * The keyword-density lint.
 *
 * Requirement 23.17 asks for location signals carried by genuine content and forbids keyword
 * stuffing, with "a lint rule flags any page whose keyword density exceeds 2%" as the enforcement.
 * This is that rule. It is a *ceiling*, not a target: a page at 0% is fine, and the only thing
 * failing here means is that a phrase was repeated more often than a person writing prose would
 * repeat it.
 *
 * **What it measures, and why that scope.** The text inside `<main>`, with `<script>`, `<style>`,
 * and every tag stripped — so the page's own words, not the shell's. The header and the footer
 * carry the business name on every page by design (a wordmark, a navigation, a copyright line);
 * counting them would produce an identical, unavoidable baseline on all twenty pages and would say
 * nothing about whether any page's copy was stuffed. `<main>` is exactly the region an author
 * controls, which is exactly the region the rule is about.
 *
 * **How density is computed.** For each target phrase: `occurrences × words-in-phrase / total
 * words`. A three-word phrase appearing twice in a 300-word page is 2%. Phrase matching is
 * case-insensitive and whitespace-normalised, and bounded by word edges so "Bengaluru" inside
 * "Bengalurus" does not count.
 *
 * **When it runs.** Wired into `npm run lint`, per the task, and also into `postbuild`. The lint
 * script routinely runs on a clean tree with no `dist/`, where there is nothing to measure and the
 * honest answer is to say so and pass; the `postbuild` hook is what guarantees the check actually
 * executes against real output on every build.
 *
 * Usage: tsx scripts/lint-keyword-density.ts [directory]
 *
 * Design: SEO and Structured Data → Local SEO content strategy.
 * Requirements: 23.17.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_DIR = join(ROOT, 'dist', 'client');

/** The ceiling, as a fraction. */
export const MAX_DENSITY = 0.02;

/**
 * The target phrases from the design's local-SEO strategy.
 *
 * Both spellings of the city are listed because both are searched for, and each is counted
 * separately — a page may legitimately name one of them once.
 */
export const TARGET_PHRASES: readonly string[] = [
  'New Galaxy Furniture',
  'furniture in Bengaluru',
  'furniture in Bangalore',
  'furniture showroom Bengaluru',
  'furniture manufacturer Bengaluru',
  'custom furniture Bengaluru',
  'sofas Bengaluru',
  'beds Bengaluru',
  'dining tables Bengaluru',
  'furniture Karnataka',
  'Bengaluru',
  'Bangalore',
  'Karnataka',
];

export interface DensityFinding {
  page: string;
  phrase: string;
  occurrences: number;
  totalWords: number;
  density: number;
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

/** The visible text of the page's `<main>`, or of the whole document when it has none. */
export function mainText(html: string): string {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  const region = main?.[1] ?? html;
  return region
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(text: string): number {
  const words = text.match(/[\p{L}\p{N}']+/gu);
  return words === null ? 0 : words.length;
}

/** Escape a phrase for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function densities(
  text: string,
  phrases: readonly string[] = TARGET_PHRASES,
): Map<string, { occurrences: number; density: number }> {
  const total = wordCount(text);
  const result = new Map<string, { occurrences: number; density: number }>();
  if (total === 0) return result;

  for (const phrase of phrases) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(phrase).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`,
      'giu',
    );
    const occurrences = (text.match(pattern) ?? []).length;
    if (occurrences === 0) continue;
    result.set(phrase, {
      occurrences,
      density: (occurrences * wordCount(phrase)) / total,
    });
  }
  return result;
}

export function analyse(directory: string): { findings: DensityFinding[]; pages: number } {
  const findings: DensityFinding[] = [];
  const pages = htmlFilesUnder(directory);

  for (const page of pages) {
    const text = mainText(readFileSync(page, 'utf8'));
    const total = wordCount(text);
    for (const [phrase, measure] of densities(text)) {
      if (measure.density > MAX_DENSITY) {
        findings.push({
          page: relative(directory, page),
          phrase,
          occurrences: measure.occurrences,
          totalWords: total,
          density: measure.density,
        });
      }
    }
  }
  return { findings, pages: pages.length };
}

function main(): void {
  const target = process.argv[2] ?? DEFAULT_DIR;

  let info;
  try {
    info = statSync(target);
  } catch {
    console.log(
      `[keyword-density] no build output at ${relative(ROOT, target)} — nothing to measure yet ` +
        '(the postbuild hook runs this against real output).',
    );
    return;
  }
  if (!info.isDirectory()) {
    console.error(`[keyword-density] ${target} is not a directory`);
    process.exitCode = 1;
    return;
  }

  const { findings, pages } = analyse(target);

  if (findings.length === 0) {
    console.log(
      `[keyword-density] ${String(pages)} page(s) checked; no target phrase exceeds ` +
        `${String(MAX_DENSITY * 100)}% of the page's own words.`,
    );
    return;
  }

  console.error('[keyword-density] FAILED');
  for (const finding of findings) {
    console.error(
      `  ${finding.page}: "${finding.phrase}" ×${String(finding.occurrences)} in ` +
        `${String(finding.totalWords)} words = ${(finding.density * 100).toFixed(2)}% ` +
        `(ceiling ${String(MAX_DENSITY * 100)}%)`,
    );
  }
  console.error(
    '\nLocation signals belong in sentences that would be written anyway. Remove the repetition ' +
      'rather than the phrase.',
  );
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('lint-keyword-density.ts');
if (invokedDirectly) {
  main();
}
