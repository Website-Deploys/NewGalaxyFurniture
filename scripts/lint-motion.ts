/**
 * The forbidden-property lint.
 *
 * Requirement 21.8 allows exactly four animatable properties — `transform`, `opacity`, `clip-path`
 * and the stroke-dash pair — and forbids `width`, `height`, `top`, `left`, `margin`, blur and
 * shadow. The task list calls for "a lint rule rejecting animation of" those, and this is that rule.
 *
 * **Why a script and not an ESLint rule.** ESLint parses JavaScript and TypeScript. The declarations
 * this rule is about live in CSS files and in `.astro` `<style>` blocks, which ESLint does not read
 * at all — an ESLint rule here would be a rule that never fires, which is worse than no rule
 * because it looks like coverage. Stylelint would be the tool-shaped answer and would mean a new
 * dependency and a second config for one rule; this is forty lines and runs in the existing `lint`
 * script.
 *
 * **What it checks.** Every `transition`, `transition-property`, `animation` shorthand and every
 * `@keyframes` block in every stylesheet and every `<style>` block under `src/`. A forbidden
 * property named in a transition list, or *mutated* inside a keyframes block, fails with the file,
 * the line, and the offending declaration.
 *
 * **What it deliberately does not check.** A static `filter` or `box-shadow` is fine — those are
 * only forbidden as *animation targets*, and the elevation scale in `tokens.css` is built from
 * `box-shadow`. So the rule looks at animation contexts only, which is what the requirement says.
 *
 * Requirements: 21.8.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

/** Requirement 21.8's list, as the tokens they appear as in a declaration. */
const FORBIDDEN = [
  'width',
  'height',
  'top',
  'left',
  'right',
  'bottom',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'filter',
  'backdrop-filter',
  'box-shadow',
  'text-shadow',
  // `all` is the worst offender of the lot: it animates every one of the above at once.
  'all',
] as const;

interface Problem {
  file: string;
  line: number;
  detail: string;
}

function filesUnder(directory: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extensions.includes(extname(entry))) found.push(full);
    }
  };
  walk(directory);
  return found;
}

/** The CSS in a file: the whole file for `.css`, or every `<style>` block for `.astro`. */
function cssIn(file: string, contents: string): { css: string; lineOffset: number }[] {
  if (extname(file) === '.css') return [{ css: contents, lineOffset: 0 }];
  const blocks: { css: string; lineOffset: number }[] = [];
  const pattern = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(contents)) !== null) {
    blocks.push({
      css: match[1] ?? '',
      lineOffset: contents.slice(0, match.index).split('\n').length - 1,
    });
  }
  return blocks;
}

/**
 * Does a declaration list name a forbidden property?
 *
 * Word-boundary matching, so `transition: max-width …` is caught but `transition: transform …` is
 * not flagged for containing no forbidden token, and a custom property name like
 * `--ngf-part-y` cannot trip the `top`/`left` tokens.
 */
function forbiddenIn(value: string): string[] {
  const tokens = value
    .split(/[\s,]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '');
  return FORBIDDEN.filter((property) => tokens.includes(property));
}

function checkCss(file: string, css: string, lineOffset: number, problems: Problem[]): void {
  const lines = css.split('\n');

  // 1. `transition` / `transition-property` / `animation` shorthands.
  lines.forEach((line, index) => {
    const declaration =
      /(?:^|[;{\s])(transition|transition-property|animation|animation-name)\s*:\s*([^;}]+)/i.exec(
        line,
      );
    if (declaration === null) return;
    const hits = forbiddenIn(declaration[2] ?? '');
    if (hits.length > 0) {
      problems.push({
        file,
        line: lineOffset + index + 1,
        detail: `${declaration[1] ?? ''} animates ${hits.join(', ')} — Requirement 21.8 forbids it`,
      });
    }
  });

  // 2. Properties mutated inside a `@keyframes` block.
  const keyframes = /@keyframes\s+[\w-]+\s*\{/gi;
  let match: RegExpExecArray | null;
  while ((match = keyframes.exec(css)) !== null) {
    // Walk braces from the block's opening to find its end, so a nested `{ }` step does not
    // truncate the block early.
    let depth = 1;
    let cursor = match.index + match[0].length;
    while (cursor < css.length && depth > 0) {
      const char = css[cursor];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      cursor += 1;
    }
    const block = css.slice(match.index, cursor);
    const startLine = lineOffset + css.slice(0, match.index).split('\n').length;

    block.split('\n').forEach((line, index) => {
      const property = /(^|[;{\s])([a-z-]+)\s*:/i.exec(line);
      if (property === null) return;
      const name = (property[2] ?? '').toLowerCase();
      if ((FORBIDDEN as readonly string[]).includes(name)) {
        problems.push({
          file,
          line: startLine + index,
          detail: `@keyframes animates ${name} — Requirement 21.8 forbids it`,
        });
      }
    });
  }
}

function main(): void {
  const problems: Problem[] = [];
  for (const file of filesUnder(SRC, ['.css', '.astro'])) {
    const contents = readFileSync(file, 'utf8');
    for (const block of cssIn(file, contents)) {
      checkCss(relative(ROOT, file), block.css, block.lineOffset, problems);
    }
  }

  if (problems.length > 0) {
    console.error('[lint-motion] forbidden animated properties:');
    for (const problem of problems) {
      console.error(`  ${problem.file}:${String(problem.line)} — ${problem.detail}`);
    }
    process.exit(1);
  }
  console.log('[lint-motion] every animation targets transform, opacity, clip-path or stroke-dash');
}

main();
