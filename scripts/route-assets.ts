/**
 * What a route actually costs, resolved from the build output.
 *
 * `size-limit` measures files. A *route* budget is not a file — it is the transitive closure of
 * everything a browser fetches to render one page, and on this stack that closure is assembled from
 * three places, only the first of which is obvious:
 *
 * 1. `<script src>` and `<link rel="stylesheet">` in the document;
 * 2. the `component-url` and `renderer-url` attributes on every `<astro-island>` — islands are
 *    fetched by the hydration runtime, not by a `<script>` tag, so a glob over `<script src>` misses
 *    the entire interactive payload;
 * 3. the static imports of everything found by (1) and (2), followed transitively — which is where
 *    React, `react-dom/client`, the schemas, and MiniSearch actually live.
 *
 * Astro's output filenames are content-hashed, so a hand-written glob per route would be a list of
 * hashes that is wrong after the next edit. Resolving the closure from the artifact keeps the budget
 * honest in both directions: a chunk that gets pulled into a route by a new import appears in that
 * route's total automatically, and a chunk that stops being used stops being counted.
 *
 * Astro's inline island bootstrap is JavaScript the route delivers too, so it is counted rather than
 * excused — `writeInlineScriptBundle` concatenates it into one measurable file per route.
 *
 * Used by `.size-limit.mjs`. Nothing here enforces a budget; it only reports what is there.
 *
 * Requirements: 22.4, 22.5, 22.6, 22.7.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';

export interface RouteAssets {
  /** Client JS, as paths relative to the process cwd. */
  js: string[];
  /** Stylesheets, as paths relative to the process cwd. */
  css: string[];
  /** The inline framework bootstrap for this route, concatenated. */
  inlineScript: string;
}

/** `/_astro/x.js` → `<dist>/_astro/x.js`; `./y.js` from a chunk → resolved against the chunk. */
function toFile(distDir: string, url: string, fromFile?: string): string | null {
  const clean = url.split('?')[0]?.split('#')[0] ?? '';
  if (clean === '' || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return null;
  const path = clean.startsWith('/')
    ? join(distDir, clean)
    : resolve(dirname(fromFile ?? distDir), clean);
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

/**
 * The static import specifiers in a built chunk.
 *
 * A regex over `from"…"` / `import"…"` rather than a parser: the input is generated, minified,
 * single-quoted-or-double-quoted ES module output whose import forms are exactly these three, and a
 * miss is visible as a chunk missing from a total rather than as a silent wrong number.
 */
function importsOf(code: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined && (specifier.startsWith('.') || specifier.startsWith('/'))) {
        found.push(specifier);
      }
    }
  }
  return found;
}

/**
 * Every JS file reachable from `entries`, following imports.
 *
 * Dynamic imports are followed as well as static ones. A dynamically imported chunk is still bytes
 * this route can pull, and counting it is the conservative direction: the budget then holds even for
 * a visitor who opens the gallery lightbox. The one asset genuinely excluded from a budget by the
 * design — the search index — is not a JS chunk at all but a separate JSON route, so it is never in
 * this closure and needs no special case.
 */
export function jsClosure(distDir: string, entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    let code: string;
    try {
      code = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const specifier of importsOf(code)) {
      const resolved = toFile(distDir, specifier, file);
      if (resolved !== null && resolved.endsWith('.js')) queue.push(resolved);
    }
  }
  return [...seen].sort();
}

function attributeValues(html: string, tag: string, attribute: string): string[] {
  const tagPattern = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const values: string[] = [];
  for (const match of html.matchAll(tagPattern)) {
    const value = new RegExp(`\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i').exec(match[0]);
    if (value?.[1] !== undefined && value[1] !== '') values.push(value[1]);
  }
  return values;
}

/** The inline `<script>` bodies in a document — the framework island bootstrap. */
export function inlineScriptsOf(html: string): string[] {
  const bodies: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    if (/\bsrc\s*=/.test(attributes)) continue;
    if (/type\s*=\s*"application\//i.test(attributes)) continue;
    if (body.trim() === '') continue;
    bodies.push(body);
  }
  return bodies;
}

/** Everything one built page fetches. `htmlPath` is relative to `distDir`. */
export function routeAssets(distDir: string, htmlPath: string): RouteAssets {
  const file = join(distDir, htmlPath);
  const html = readFileSync(file, 'utf8');

  const scriptSrcs = attributeValues(html, 'script', 'src');
  const islandComponents = attributeValues(html, 'astro-island', 'component-url');
  const islandRenderers = attributeValues(html, 'astro-island', 'renderer-url');

  const entries = [...scriptSrcs, ...islandComponents, ...islandRenderers]
    .map((url) => toFile(distDir, url, file))
    .filter((path): path is string => path !== null && path.endsWith('.js'));

  const css = attributeValues(html, 'link', 'href')
    .filter((href) => href.endsWith('.css'))
    .map((href) => toFile(distDir, href, file))
    .filter((path): path is string => path !== null);

  return {
    js: jsClosure(distDir, entries).map((path) => relative(process.cwd(), path)),
    css: [...new Set(css)].sort().map((path) => relative(process.cwd(), path)),
    inlineScript: inlineScriptsOf(html).join('\n'),
  };
}

/**
 * Write a route's inline bootstrap to a measurable file and return its path.
 *
 * Under `dist/.size-limit/`, which is inside the build output and therefore never uploaded as a
 * public asset (the asset directory is `dist/client`) and never committed.
 */
export function writeInlineScriptBundle(name: string, code: string): string | null {
  if (code.trim() === '') return null;
  const directory = join('dist', '.size-limit');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.inline.js`);
  writeFileSync(path, code, 'utf8');
  return path;
}

/** Files directly under a directory whose name starts with `prefix` and ends with `suffix`. */
export function filesNamed(directory: string, prefix: string, suffix: string): string[] {
  try {
    return readdirSync(directory)
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix))
      .map((entry) => join(directory, entry))
      .sort();
  } catch {
    return [];
  }
}

/** For messages: a posix-style relative path, whatever the platform. */
export function displayPath(path: string): string {
  return path.split('\\').join(posix.sep);
}
