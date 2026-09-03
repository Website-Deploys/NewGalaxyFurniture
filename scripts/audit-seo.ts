/**
 * The build-output SEO audit.
 *
 * `buildPageMeta` guarantees the *shape* of a page's metadata; it cannot guarantee the properties
 * that are only true of the set — that no two pages share a title, that every indexable page is in
 * the sitemap, that a canonical points at the page it is on. Those are cross-page invariants and
 * this is where they are checked, against the artifact that actually deploys.
 *
 * What it asserts, per page:
 *
 * - exactly one `<title>`, at most 60 characters after entity decoding;
 * - exactly one `<meta name="description">`, at most 155 characters;
 * - exactly one `<link rel="canonical">`, absolute, and pointing at *this* page's own path — a
 *   canonical that names another page silently de-indexes this one;
 * - every `application/ld+json` block parses, and carries `@context` and `@type`.
 *
 * And across pages:
 *
 * - titles are unique among indexable pages, and so are descriptions;
 * - every indexable page appears in `sitemap.xml`, and every `sitemap.xml` entry was built. The
 *   second direction is the one that catches a deleted page still being advertised, and the first
 *   catches a new page that nobody added to `STATIC_SITEMAP_PATHS`.
 *
 * Pages carrying `noindex` are exempt from the uniqueness and sitemap rules and required to be
 * absent from the sitemap — which is what makes the `/404` and preview exemptions explicit rather
 * than forgotten.
 *
 * Runs in `postbuild`. Usage: tsx scripts/audit-seo.ts [dist/client]
 *
 * Design: SEO and Structured Data.
 * Requirements: 23.1, 23.2, 23.3, 23.12, 23.15.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_DIR = join(ROOT, 'dist', 'client');

const TITLE_MAX = 60;
const DESCRIPTION_MAX = 155;

interface PageFacts {
  /** The route this file is served at, e.g. `/collection/sofas`. */
  path: string;
  file: string;
  title: string | null;
  titleCount: number;
  description: string | null;
  descriptionCount: number;
  canonical: string | null;
  canonicalCount: number;
  robots: string | null;
  jsonLd: string[];
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

/** `about/index.html` → `/about`; `index.html` → `/`; `404.html` → `/404`. */
export function routePathOf(relativeFile: string): string {
  const parts = relativeFile.split(sep);
  const last = parts.pop() ?? '';
  if (last === 'index.html') return `/${parts.join('/')}`.replace(/\/+$/, '') || '/';
  return `/${[...parts, last.replace(/\.html$/, '')].join('/')}`;
}

/** The five entities Astro emits. Enough to measure a title honestly. */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function allMatches(html: string, pattern: RegExp): string[] {
  return [...html.matchAll(pattern)].map((match) => match[1] ?? '');
}

/**
 * The `<head>` only.
 *
 * Scoping matters: an inline SVG can legitimately carry a `<title>` child as its accessible name,
 * and `/workshop` renders four illustrations that do exactly that. A document-wide search for
 * `<title>` counts five titles on that page and is simply measuring the wrong thing.
 */
export function headOf(html: string): string {
  return /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? html;
}

export function readPage(html: string, path: string, file: string): PageFacts {
  const head = headOf(html);
  const titles = allMatches(head, /<title>([\s\S]*?)<\/title>/gi);
  const descriptions = allMatches(head, /<meta\s+name="description"\s+content="([^"]*)"\s*\/?>/gi);
  const canonicals = allMatches(head, /<link\s+rel="canonical"\s+href="([^"]*)"\s*\/?>/gi);
  const robots = /<meta\s+name="robots"\s+content="([^"]*)"/i.exec(head);
  const jsonLd = allMatches(head, /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi);

  return {
    path,
    file,
    title: titles[0] === undefined ? null : decodeEntities(titles[0]),
    titleCount: titles.length,
    description: descriptions[0] === undefined ? null : decodeEntities(descriptions[0]),
    descriptionCount: descriptions.length,
    canonical: canonicals[0] ?? null,
    canonicalCount: canonicals.length,
    robots: robots?.[1] ?? null,
    jsonLd,
  };
}

function isNoindex(page: PageFacts): boolean {
  return page.robots !== null && page.robots.includes('noindex');
}

/** `<loc>` values in the built sitemap, as paths. */
function sitemapPaths(directory: string): string[] | null {
  let xml: string;
  try {
    xml = readFileSync(join(directory, 'sitemap.xml'), 'utf8');
  } catch {
    return null;
  }
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => {
    const value = decodeEntities(match[1] ?? '');
    try {
      return new URL(value).pathname.replace(/\/+$/, '') || '/';
    } catch {
      return value;
    }
  });
}

export function audit(directory: string): { problems: string[]; pages: PageFacts[] } {
  const problems: string[] = [];
  const pages = htmlFilesUnder(directory).map((file) => {
    const rel = relative(directory, file);
    return readPage(readFileSync(file, 'utf8'), routePathOf(rel), rel);
  });

  for (const page of pages) {
    if (page.titleCount !== 1) {
      problems.push(`${page.file}: expected exactly one <title>, found ${String(page.titleCount)}`);
    }
    if (page.title !== null && page.title.length > TITLE_MAX) {
      problems.push(
        `${page.file}: title is ${String(page.title.length)} chars (max ${String(TITLE_MAX)}): "${page.title}"`,
      );
    }
    if (page.descriptionCount !== 1) {
      problems.push(
        `${page.file}: expected exactly one meta description, found ${String(page.descriptionCount)}`,
      );
    }
    if (page.description !== null && page.description.length > DESCRIPTION_MAX) {
      problems.push(
        `${page.file}: description is ${String(page.description.length)} chars (max ${String(DESCRIPTION_MAX)})`,
      );
    }
    if (page.canonicalCount !== 1) {
      problems.push(
        `${page.file}: expected exactly one rel=canonical, found ${String(page.canonicalCount)}`,
      );
    }
    if (page.canonical !== null) {
      if (!/^https?:\/\//i.test(page.canonical)) {
        problems.push(`${page.file}: canonical is not absolute: "${page.canonical}"`);
      } else {
        const canonicalPath = new URL(page.canonical).pathname.replace(/\/+$/, '') || '/';
        if (canonicalPath !== page.path) {
          problems.push(
            `${page.file}: canonical points at ${canonicalPath}, but the page is served at ${page.path}`,
          );
        }
      }
    }
    for (const block of page.jsonLd) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block);
      } catch (error) {
        problems.push(`${page.file}: a JSON-LD block does not parse (${String(error)})`);
        continue;
      }
      const record = parsed as Record<string, unknown>;
      if (record['@context'] === undefined || record['@type'] === undefined) {
        problems.push(`${page.file}: a JSON-LD block is missing @context or @type`);
      }
    }
  }

  // --- Cross-page ----------------------------------------------------------
  const indexable = pages.filter((page) => !isNoindex(page));

  const byTitle = new Map<string, string[]>();
  const byDescription = new Map<string, string[]>();
  for (const page of indexable) {
    if (page.title !== null)
      byTitle.set(page.title, [...(byTitle.get(page.title) ?? []), page.file]);
    if (page.description !== null) {
      byDescription.set(page.description, [
        ...(byDescription.get(page.description) ?? []),
        page.file,
      ]);
    }
  }
  for (const [title, files] of byTitle) {
    if (files.length > 1) problems.push(`duplicate title "${title}" on: ${files.join(', ')}`);
  }
  for (const [, files] of byDescription) {
    if (files.length > 1) problems.push(`duplicate meta description on: ${files.join(', ')}`);
  }

  const sitemap = sitemapPaths(directory);
  if (sitemap === null) {
    problems.push('sitemap.xml was not built');
  } else {
    const listed = new Set(sitemap);
    const built = new Set(pages.map((page) => page.path));
    for (const page of indexable) {
      if (!listed.has(page.path)) {
        problems.push(`${page.path} is indexable but is absent from sitemap.xml`);
      }
    }
    for (const page of pages) {
      if (isNoindex(page) && listed.has(page.path)) {
        problems.push(`${page.path} is noindex but is listed in sitemap.xml`);
      }
    }
    for (const path of listed) {
      if (!built.has(path)) {
        problems.push(`sitemap.xml lists ${path}, which was not built`);
      }
    }
  }

  return { problems, pages };
}

function main(): void {
  const target = process.argv[2] ?? DEFAULT_DIR;
  try {
    if (!statSync(target).isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`[audit-seo] no build output at ${relative(ROOT, target)} — run the build first`);
    process.exitCode = 1;
    return;
  }

  const { problems, pages } = audit(target);
  if (problems.length === 0) {
    console.log(
      `[audit-seo] ${String(pages.length)} page(s): titles and descriptions unique and within ` +
        'bounds, canonicals absolute and self-referential, sitemap complete.',
    );
    return;
  }

  console.error(`[audit-seo] FAILED with ${String(problems.length)} problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exitCode = 1;
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('audit-seo.ts');
if (invokedDirectly) {
  main();
}
