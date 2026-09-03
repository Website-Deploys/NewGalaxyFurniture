/**
 * Secret scan of the build output — the last gate before deploy.
 *
 * Walks every file under `dist/` and fails on the first credential pattern it
 * finds, naming the file, the line, and the byte offset. Runs after `build` in CI
 * so a secret that reached the bundle can never reach the edge.
 *
 * TWO SCOPES, deliberately:
 *
 * - Credential *values* (`ghp_`, `github_pat_`, `sk-`, a private key header) are
 *   forbidden everywhere under `dist/`, server bundle included. A real token in
 *   the Worker bundle is a committed secret no matter who can read it.
 * - Credential *names* (`AI_API_KEY`, `SESSION_SECRET`) are forbidden in
 *   client-reachable output only. `dist/server/**` is server code that never
 *   leaves Cloudflare, and it must name its bindings to read them — that is the
 *   correct pattern, not a leak. The same name in a browser bundle means a secret
 *   was referenced from client-reachable code, which is the defect this catches.
 *
 * Design: Testing Strategy → CI gates; Deployment.
 * Requirements: 28.3, 28.4, 28.6. Property 51 asserts the same invariant.
 *
 * Usage: npm run scan:secrets [-- <directory>]
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

type Scope = 'all' | 'client';

interface Pattern {
  readonly name: string;
  readonly regex: RegExp;
  readonly scope: Scope;
}

const PATTERNS: readonly Pattern[] = [
  { name: 'GitHub personal access token (classic)', regex: /ghp_[A-Za-z0-9]{16,}/g, scope: 'all' },
  { name: 'GitHub fine-grained token', regex: /github_pat_[A-Za-z0-9_]{20,}/g, scope: 'all' },
  { name: 'AI provider key', regex: /\bsk-[A-Za-z0-9_-]{16,}/g, scope: 'all' },
  { name: 'Private key header', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, scope: 'all' },
  { name: 'AI_API_KEY referenced from client code', regex: /AI_API_KEY/g, scope: 'client' },
  { name: 'SESSION_SECRET referenced from client code', regex: /SESSION_SECRET/g, scope: 'client' },
];

/**
 * Server-only output: reachable by Cloudflare, never by a browser.
 *
 * `@astrojs/cloudflare` v14 splits the build into `dist/client/**` (uploaded to
 * the static asset store) and `dist/server/**` (the Worker bundle), replacing the
 * old single-directory layout where server code sat in `dist/_worker.js/**`.
 * `server` is therefore the current server-only prefix; `_worker.js` is retained
 * so the narrower client scope is never applied to a server bundle emitted under
 * the old layout. Credential *values* stay forbidden in both, everywhere.
 */
const SERVER_ONLY_PREFIXES = ['server', '_worker.js'];

/** Binary asset types that cannot carry a credential in text form. */
const SKIP_EXTENSIONS = new Set([
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.avif',
  '.gif',
  '.ico',
  '.mp4',
  '.webm',
  '.pdf',
  '.zip',
  '.gz',
  '.br',
  '.wasm',
]);

export interface Finding {
  readonly file: string;
  readonly offset: number;
  readonly line: number;
  readonly pattern: string;
  readonly excerpt: string;
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
}

function isClientReachable(relativePath: string): boolean {
  const first = relativePath.split(sep)[0];
  return first === undefined || !SERVER_ONLY_PREFIXES.includes(first);
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * Redact the match itself. Printing the credential into a CI log would leak the
 * very thing this gate exists to contain, so the report carries the pattern name,
 * the location, and a masked excerpt.
 */
function redact(match: string): string {
  if (match.length <= 8) return '*'.repeat(match.length);
  return `${match.slice(0, 4)}${'*'.repeat(Math.min(match.length - 8, 24))}${match.slice(-4)}`;
}

export function scanText(relativePath: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const clientReachable = isClientReachable(relativePath);

  for (const { name, regex, scope } of PATTERNS) {
    if (scope === 'client' && !clientReachable) continue;

    // Fresh lastIndex per file: these regexes are module-level and global.
    regex.lastIndex = 0;
    let match: RegExpExecArray | null = regex.exec(text);
    while (match !== null) {
      const offset = match.index;
      const line = text.slice(0, offset).split('\n').length;
      findings.push({ file: relativePath, offset, line, pattern: name, excerpt: redact(match[0]) });
      match = regex.exec(text);
    }
  }
  return findings;
}

export async function scanDirectory(root: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  for await (const file of walk(root)) {
    if (SKIP_EXTENSIONS.has(extensionOf(file))) continue;
    findings.push(...scanText(relative(root, file), await readFile(file, 'utf8')));
  }
  return findings;
}

async function main(): Promise<void> {
  const target = resolve(process.argv[2] ?? 'dist');

  try {
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(
      `scan:secrets — nothing to scan: ${target} does not exist. Run \`npm run build\` first.`,
    );
    process.exitCode = 1;
    return;
  }

  const findings = await scanDirectory(target);

  if (findings.length === 0) {
    console.log(
      `scan:secrets — clean. No credential pattern found under ${relative(process.cwd(), target) || target}/.`,
    );
    return;
  }

  console.error(`scan:secrets — FAILED with ${findings.length} finding(s):`);
  for (const finding of findings) {
    console.error(
      `  ${finding.file}:${finding.line} (byte offset ${finding.offset}) — ${finding.pattern} [${finding.excerpt}]`,
    );
  }
  console.error(
    '\nA credential value in the build output, or a secret name in client-reachable ' +
      'output, means a secret was referenced from the wrong side of the trust ' +
      'boundary. Move the read into a Worker route and re-run.',
  );
  process.exitCode = 1;
}

// Only run when invoked as a script, so tests can import the scan functions.
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('scan-secrets.ts');
if (invokedDirectly) {
  await main();
}
