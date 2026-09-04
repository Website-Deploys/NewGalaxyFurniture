/**
 * The disclosure boundary, audited over the source rather than trusted.
 *
 * `src/lib/errors.ts` guarantees that nothing internal crosses to a browser — but only for failures
 * that actually go through it. This checks that they all do, because the ways around it are easy to
 * write and invisible in review:
 *
 * 1. **Only `errors.ts` builds an error body.** A hand-rolled `new Response(JSON.stringify({ error:
 *    … }))` skips the envelope, the code union, the status table and the disclosure filter in one
 *    line — and one endpoint did exactly that before task 16 (the AI route, with a code that was not
 *    in the union at all). So no file outside `errors.ts` may serialise an object with an `error` key.
 * 2. **A `catch` in an API route returns through the envelope.** If a catch block constructs a
 *    `Response` itself, it is answering a failure without the mapper.
 * 3. **A caught value is never handed to `console.error`.** A thrown `Error`'s stack, or an upstream
 *    error object, printed raw, is a credential and a filesystem path in a log line that outlives the
 *    request. `logServerError` exists for this and redacts on the way out.
 * 4. **Every `catch` that answers with a *server-side* fault also logs.** A failure that is answered
 *    but not recorded is an incident with no evidence; the mapper's whole premise is that the detail
 *    goes somewhere. The rule is deliberately limited to the codes that mean something is wrong with
 *    the deployment — a missing binding, an unavailable repository, an unclassified throw. A `catch`
 *    that answers `VALIDATION_FAILED` because a visitor sent a malformed body is not an incident, and
 *    requiring a log line for it would add noise to every request a bot makes, which is how a log
 *    stops being read.
 *
 * Wired into `npm run lint`, so it runs before a commit rather than after an incident.
 *
 * Usage: tsx scripts/audit-error-disclosure.ts
 *
 * Design: Error Handling → Disclosure policy.
 * Requirements: 25.14, 25.15.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const ENVELOPE_MODULE = join(SRC, 'lib', 'errors.ts');

/**
 * The codes that mean the deployment is at fault. Answering with one of these from a `catch` without
 * logging leaves an operator with a 5xx and no evidence.
 */
const SERVER_FAULT_CODES = [
  'CONFIGURATION_INCOMPLETE',
  'REPOSITORY_UNAVAILABLE',
  'INTERNAL_ERROR',
  'LEAD_NOT_RECORDED',
  'AI_UNAVAILABLE',
  'PATH_NOT_ALLOWED',
];

/** Bindings a `catch` clause conventionally uses. */
const CAUGHT_NAMES = ['error', 'err', 'e', 'cause', 'thrown', 'reason'];

export interface DisclosureProblem {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

function filesUnder(directory: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extensions.some((extension) => entry.endsWith(extension))) found.push(full);
    }
  };
  walk(directory);
  return found;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * The body of every `catch` clause, with its offset.
 *
 * Brace-matched from the clause's opening `{`. String and comment contents are not parsed, which for
 * this codebase's own source is adequate: an unbalanced brace inside a string literal in a catch body
 * would have to be deliberate.
 */
export function catchBlocks(source: string): { body: string; index: number }[] {
  const blocks: { body: string; index: number }[] = [];
  for (const match of source.matchAll(/\bcatch\b\s*(\([^)]*\))?\s*\{/g)) {
    const start = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    for (let position = start; position < source.length; position += 1) {
      const character = source[position];
      if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          blocks.push({ body: source.slice(start, position + 1), index: match.index ?? 0 });
          break;
        }
      }
    }
  }
  return blocks;
}

/** Strip line and block comments, so a rule never fires on prose about itself. */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

export function auditSource(
  file: string,
  source: string,
  isApiRoute: boolean,
): DisclosureProblem[] {
  const problems: DisclosureProblem[] = [];
  const code = withoutComments(source);

  /* 1. Only the envelope module serialises an error body. */
  for (const match of code.matchAll(/JSON\.stringify\(\s*\{[^}]*\berror\s*:/g)) {
    problems.push({
      file,
      line: lineOf(code, match.index ?? 0),
      rule: 'only src/lib/errors.ts builds an error body',
      detail:
        'serialises an object with an `error` key — use errorResponse or toClientErrorResponse',
    });
  }

  /* 3. A caught value never reaches console.error / console.warn. */
  for (const match of code.matchAll(/console\.(?:error|warn|log)\(([^;]*)\)/g)) {
    const argumentText = match[1] ?? '';
    const passesCaught = CAUGHT_NAMES.some((name) =>
      new RegExp(`(^|[\\s,(])${name}\\b(?!\\s*[:.])`).test(argumentText),
    );
    if (passesCaught) {
      problems.push({
        file,
        line: lineOf(code, match.index ?? 0),
        rule: 'a caught value is logged through logServerError',
        detail:
          'console.error was handed a caught binding — its stack and any credential go unredacted',
      });
    }
  }

  if (!isApiRoute) return problems;

  for (const block of catchBlocks(code)) {
    /* 2. A catch in an API route answers through the envelope. */
    if (/\bnew Response\(/.test(block.body)) {
      problems.push({
        file,
        line: lineOf(code, block.index),
        rule: 'a catch block answers through the envelope',
        detail:
          'constructs a Response directly instead of returning errorResponse/toClientErrorResponse',
      });
    }

    /* 4. A catch that answers with a server-side fault also records it. */
    const answersServerFault =
      /\btoClientErrorResponse\(/.test(block.body) ||
      SERVER_FAULT_CODES.some((code) => block.body.includes(`ERROR_CODES.${code}`));
    const logs = /\blogServerError\(/.test(block.body);
    if (answersServerFault && !logs) {
      problems.push({
        file,
        line: lineOf(code, block.index),
        rule: 'a catch block that answers a server-side fault also logs it',
        detail: 'returns a 5xx-class envelope with nothing written to the Worker log',
      });
    }
  }

  return problems;
}

export function auditRepository(): DisclosureProblem[] {
  const problems: DisclosureProblem[] = [];
  for (const file of filesUnder(SRC, ['.ts', '.tsx'])) {
    if (file === ENVELOPE_MODULE) continue;
    const relativePath = relative(ROOT, file);
    const isApiRoute = relativePath.startsWith(join('src', 'pages', 'api'));
    problems.push(...auditSource(relativePath, readFileSync(file, 'utf8'), isApiRoute));
  }
  return problems;
}

function main(): void {
  const problems = auditRepository();
  if (problems.length === 0) {
    console.log(
      '[error-disclosure] every failure crosses the boundary through the envelope, and every ' +
        'caught value is logged through the redacting logger.',
    );
    return;
  }
  console.error(`[error-disclosure] FAILED with ${String(problems.length)} problem(s):`);
  for (const problem of problems) {
    console.error(`  ${problem.file}:${String(problem.line)} — ${problem.rule}: ${problem.detail}`);
  }
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('audit-error-disclosure.ts');
if (invokedDirectly) {
  main();
}
