/**
 * The image loading strategy, checked against the built HTML.
 *
 * `scripts/audit-page-budget.ts` counts nodes, preloads, hydration directives and third-party
 * subresources. This one audits the *images*, because every rule the design states about them is a
 * rule about attributes on an element in the output, and every one of them was until now enforced
 * only by whichever component happened to be rendering:
 *
 * 1. **At most one prioritised image per page**, and if the page has one it must be the one image
 *    the page preloads — matched by URL. Two `fetchpriority="high"` images are two fetches racing
 *    for the same early bandwidth, which is the same defect the "never preload more than one image"
 *    prohibition names. A page with no contentful image (a policy page) has neither, which is not a
 *    gap: there is no LCP image to hint.
 * 2. **The prioritised image is `loading="eager"`.** A high-priority lazy image is a contradiction
 *    the browser resolves by deferring it.
 * 3. **Every other image is `loading="lazy"` and `decoding="async"`** — the design's rule verbatim,
 *    with one exception it also states: the first six cards of a grid are eager (at normal
 *    priority), because they are above the fold. So `loading="eager"` is allowed on at most
 *    `EAGER_CARDS` images per page and only inside a card or gallery tile.
 * 4. **Every image carries intrinsic `width` and `height`.** Without them the box is not reserved
 *    and the image shifts the layout when it arrives, which is the CLS budget.
 * 5. **Every image sits in a reserved slot** — an enclosing element that declares `aspect-ratio`,
 *    or a fixed height, inline or through a class the built stylesheet gives one to. Intrinsic
 *    dimensions reserve the box only while the image's own aspect ratio is what the layout uses; a
 *    cropped `object-fit: cover` slot needs a ratio or a height of its own, and every media slot on
 *    this site is one of those two.
 * 6. **No card is served a full-resolution image.** Card `srcset` candidates never reach the
 *    widest derivative the ladder holds for that image and never reach the 2000 px zoom rung.
 * 7. **The deferred search index is in no page's initial payload** (Requirement 22.7): it may be
 *    named in a `<meta>` for the search box to fetch later, and it may not be a subresource.
 *
 * Rules 3, 5 and 6 need to know what an element's ancestors and classes are, so this walks a tag
 * stack rather than matching in isolation. It is not a full parser and does not need to be: the
 * input is generated markup, and the check is conservative — an unrecognised shape is reported, not
 * assumed fine.
 *
 * Runs in `postbuild`. Usage: tsx scripts/audit-image-loading.ts [dist/client]
 *
 * Design: Performance Budgets → Techniques; Image Pipeline → Delivery budget on the page.
 * Requirements: 15.10, 15.17, 22.7, 22.9, 22.10.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_DIR = join(ROOT, 'dist', 'client');

/** Mirrors `EAGER_CARDS` in `src/lib/images/staging.ts` — the design's "first 6 cards". */
export const MAX_EAGER_IMAGES = 6;

/** The zoom-only derivative. `robots.txt` disallows it; a card must never request it. */
export const ZOOM_WIDTH = 2000;

export interface ImageProblem {
  page: string;
  rule: string;
  detail: string;
}

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function attributeOf(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (match === null) return null;
  return match[2] ?? match[3] ?? match[4] ?? '';
}

interface OpenElement {
  name: string;
  classes: string[];
  style: string;
}

export interface ImageElement {
  tag: string;
  /** Innermost ancestor first. */
  ancestors: OpenElement[];
}

/**
 * Every `<img>` in a document, with the element stack it sits inside.
 *
 * Comments and the contents of `<script>`/`<template>` are removed first: an `<img>` inside a
 * template is markup a framework may clone, and this site has none, so finding one is a signal
 * rather than something to audit as if it were rendered.
 */
export function imagesWithAncestors(html: string): ImageElement[] {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<template\b[\s\S]*?<\/template>/gi, '');

  const found: ImageElement[] = [];
  const stack: OpenElement[] = [];

  for (const match of cleaned.matchAll(/<\/?([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const whole = match[0];
    const name = (match[1] ?? '').toLowerCase();
    if (whole.startsWith('</')) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index]?.name === name) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    if (name === 'img') {
      found.push({ tag: whole, ancestors: [...stack].reverse() });
      continue;
    }

    if (VOID_ELEMENTS.has(name) || whole.endsWith('/>')) continue;

    stack.push({
      name,
      classes: (attributeOf(whole, 'class') ?? '').split(/\s+/).filter((value) => value !== ''),
      style: attributeOf(whole, 'style') ?? '',
    });
  }

  return found;
}

/** `<link rel="preload" as="image">` hrefs, in document order. */
export function preloadedImageUrls(html: string): string[] {
  return [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter((match) => {
      const rel = (attributeOf(match[0], 'rel') ?? '').toLowerCase().split(/\s+/);
      if (!rel.includes('preload')) return false;
      const as = (attributeOf(match[0], 'as') ?? '').toLowerCase();
      return as === 'image' || attributeOf(match[0], 'imagesrcset') !== null;
    })
    .map((match) => attributeOf(match[0], 'href') ?? '');
}

/**
 * Class names the built stylesheets give a reserved box to.
 *
 * Two shapes count, because both hold the slot open before the bytes arrive:
 *
 * - `aspect-ratio` in any form — the media boxes, the hero figure, the skeleton tiles;
 * - a `height` in an absolute unit — the 96 px thumbnail rail, whose box is a fixed rectangle
 *   rather than a ratio. `height: 100%` and `height: auto` are *not* reservations: they defer to
 *   something else, which is the case this check exists to catch.
 */
export function classesReservingBox(cssFiles: readonly string[]): Set<string> {
  const classes = new Set<string>();
  for (const file of cssFiles) {
    let css: string;
    try {
      css = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1] ?? '';
      const body = rule[2] ?? '';
      const reserves =
        /(^|[;\s])aspect-ratio\s*:/.test(body) ||
        /(^|[;\s])height\s*:\s*[\d.]+(px|rem|em|vh|ch|cm|mm|in|pt)/i.test(body);
      if (!reserves) continue;
      for (const name of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
        const value = name[1];
        if (value !== undefined) classes.add(value);
      }
    }
  }
  return classes;
}

/**
 * `srcset` candidate widths, and whether the set reaches the image's own intrinsic width.
 *
 * A card whose widest candidate equals the intrinsic width is being offered the full-resolution
 * file, which is exactly what Requirement 22.9 forbids.
 */
export function srcsetWidths(srcset: string): number[] {
  return srcset
    .split(',')
    .map((candidate) => /(\d+)w\s*$/.exec(candidate.trim())?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => Number.parseInt(value, 10))
    .sort((a, b) => a - b);
}

/**
 * The container classes that mark an eager image as an above-the-fold card or gallery photograph.
 *
 * - `ngf-card-media` / `ngf-grid`: a product card's media slot and the catalogue grid it sits in.
 * - `ngf-gallerypage`: the standalone gallery surface.
 * - `ngf-lookbook`: the gallery lookbook grid (`/gallery`), whose first tiles are eager and whose
 *   first tile is the page's prioritised LCP image — the same above-the-fold gallery photographs
 *   `ngf-gallerypage` already names, in the lookbook's masonry rhythm. Each tile reserves its box
 *   via the `.ngf-image` aspect-ratio inside `.ngf-lookbook-frame`, so recognising it here only
 *   admits the eager-eligibility, not any relaxation of the reserved-box or full-resolution rules.
 */
const CARD_CONTAINER_CLASSES = new Set([
  'ngf-card-media',
  'ngf-gallerypage',
  'ngf-grid',
  'ngf-lookbook',
]);

/** True when this `<img>` is a product card's or gallery tile's photograph. */
function isCardImage(image: ImageElement): boolean {
  return image.ancestors.some((ancestor) =>
    ancestor.classes.some((name) => CARD_CONTAINER_CLASSES.has(name)),
  );
}

function inReservedBox(image: ImageElement, reservingClasses: Set<string>): boolean {
  return image.ancestors.some(
    (ancestor) =>
      /(aspect-ratio|height)\s*:/.test(ancestor.style) ||
      ancestor.classes.some((name) => reservingClasses.has(name)),
  );
}

export function auditImages(
  html: string,
  page: string,
  reservingClasses: Set<string>,
): ImageProblem[] {
  const problems: ImageProblem[] = [];
  const images = imagesWithAncestors(html);
  const preloads = preloadedImageUrls(html);

  const prioritised = images.filter(
    (image) => (attributeOf(image.tag, 'fetchpriority') ?? '').toLowerCase() === 'high',
  );

  if (prioritised.length > 1) {
    problems.push({
      page,
      rule: 'at most one prioritised image',
      detail: `${String(prioritised.length)} images carry fetchpriority="high" — they compete for the same early bandwidth`,
    });
  }

  if (preloads.length > 1) {
    problems.push({
      page,
      rule: 'at most one preloaded image',
      detail: `${String(preloads.length)} image preloads`,
    });
  }

  const priority = prioritised[0];
  const preload = preloads[0];

  if (priority !== undefined && preload === undefined) {
    problems.push({
      page,
      rule: 'the prioritised image is the preloaded one',
      detail:
        'an image is fetchpriority="high" and nothing is preloaded — the hint the design pairs with it is missing',
    });
  }

  if (priority !== undefined && preload !== undefined) {
    const src = attributeOf(priority.tag, 'src') ?? '';
    if (src !== preload) {
      problems.push({
        page,
        rule: 'the prioritised image is the preloaded one',
        detail: `preloads ${preload} and prioritises ${src} — two fetches instead of one`,
      });
    }
    if ((attributeOf(priority.tag, 'loading') ?? 'eager').toLowerCase() !== 'eager') {
      problems.push({
        page,
        rule: 'the prioritised image loads eagerly',
        detail: 'fetchpriority="high" with loading="lazy" defers the image it prioritises',
      });
    }
  }

  if (priority === undefined && preload !== undefined) {
    problems.push({
      page,
      rule: 'the preloaded image is the prioritised one',
      detail: `preloads ${preload} but no image on the page is fetchpriority="high"`,
    });
  }

  let eagerCount = 0;

  for (const image of images) {
    const src = attributeOf(image.tag, 'src') ?? '(no src)';
    const loading = (attributeOf(image.tag, 'loading') ?? '').toLowerCase();
    const decoding = (attributeOf(image.tag, 'decoding') ?? '').toLowerCase();
    const isPriority = image === priority;

    if (attributeOf(image.tag, 'width') === null || attributeOf(image.tag, 'height') === null) {
      problems.push({
        page,
        rule: 'intrinsic width and height on every image',
        detail: `${src} carries no reserved box`,
      });
    }

    if (!inReservedBox(image, reservingClasses)) {
      problems.push({
        page,
        rule: 'every media slot reserves its box',
        detail: `${src} has no ancestor declaring an aspect-ratio or a fixed height`,
      });
    }

    if (isPriority) continue;

    if (loading === 'eager') {
      eagerCount += 1;
      if (!isCardImage(image)) {
        problems.push({
          page,
          rule: 'only the prioritised image and above-fold cards load eagerly',
          detail: `${src} is loading="eager" and is not a card`,
        });
      }
    } else if (loading !== 'lazy') {
      problems.push({
        page,
        rule: 'every image except the prioritised one is loading="lazy"',
        detail: `${src} declares loading="${loading === '' ? '(absent)' : loading}"`,
      });
    }

    if (decoding !== 'async') {
      problems.push({
        page,
        rule: 'every image except the prioritised one is decoding="async"',
        detail: `${src} declares decoding="${decoding === '' ? '(absent)' : decoding}"`,
      });
    }
  }

  if (eagerCount > MAX_EAGER_IMAGES) {
    problems.push({
      page,
      rule: `at most ${String(MAX_EAGER_IMAGES)} eager images (the first grid row)`,
      detail: `${String(eagerCount)} eager images besides the prioritised one`,
    });
  }

  /* Card candidates: never the intrinsic width, never the zoom rung. */
  for (const image of images) {
    if (!isCardImage(image)) continue;
    const srcset = attributeOf(image.tag, 'srcset');
    if (srcset === null || srcset === '') continue;
    const widths = srcsetWidths(srcset);
    const intrinsic = Number.parseInt(attributeOf(image.tag, 'width') ?? '0', 10);
    const widest = widths[widths.length - 1] ?? 0;
    if (widest >= ZOOM_WIDTH) {
      problems.push({
        page,
        rule: 'no card is served a full-resolution image',
        detail: `a card advertises the ${String(widest)}px derivative`,
      });
    }
    if (Number.isFinite(intrinsic) && intrinsic > 0 && widest >= intrinsic) {
      problems.push({
        page,
        rule: 'no card is served a full-resolution image',
        detail: `a card's widest candidate is ${String(widest)}w for a ${String(intrinsic)}px original`,
      });
    }
  }

  /* Requirement 22.7: the index is fetched on search intent, never as part of the page. */
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    for (const attribute of ['src', 'href', 'imagesrcset']) {
      const value = attributeOf(match[0], attribute) ?? '';
      if (value.includes('/search-index/')) {
        problems.push({
          page,
          rule: 'the search index is in no initial payload',
          detail: `${match[1] ?? 'element'} references ${value}`,
        });
      }
    }
  }

  return problems;
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

function cssFilesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.css')) found.push(full);
    }
  };
  walk(directory);
  return found;
}

export interface ImageAuditSummary {
  problems: ImageProblem[];
  pages: number;
  images: number;
  prioritised: number;
  preloads: number;
}

export function auditDirectory(directory: string): ImageAuditSummary {
  const reservingClasses = classesReservingBox(cssFilesUnder(directory));
  const problems: ImageProblem[] = [];
  let images = 0;
  let prioritised = 0;
  let preloads = 0;

  const files = htmlFilesUnder(directory);
  for (const file of files) {
    const page = relative(directory, file);
    const html = readFileSync(file, 'utf8');
    problems.push(...auditImages(html, page, reservingClasses));
    const found = imagesWithAncestors(html);
    images += found.length;
    prioritised += found.filter(
      (image) => (attributeOf(image.tag, 'fetchpriority') ?? '').toLowerCase() === 'high',
    ).length;
    preloads += preloadedImageUrls(html).length;
  }

  return { problems, pages: files.length, images, prioritised, preloads };
}

function main(): void {
  const target = process.argv[2] ?? DEFAULT_DIR;
  try {
    if (!statSync(target).isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`[image-loading] no build output at ${relative(ROOT, target)} — build first`);
    process.exitCode = 1;
    return;
  }

  const summary = auditDirectory(target);

  if (summary.problems.length === 0) {
    console.log(
      `[image-loading] ${String(summary.pages)} page(s), ${String(summary.images)} image(s): ` +
        `${String(summary.prioritised)} prioritised and ${String(summary.preloads)} preloaded, ` +
        'each one paired; every other image lazy and async, every box reserved, ' +
        'no card served at full resolution, search index outside every initial payload.',
    );
    return;
  }

  console.error(`[image-loading] FAILED with ${String(summary.problems.length)} problem(s):`);
  for (const problem of summary.problems) {
    console.error(`  ${problem.page} — ${problem.rule}: ${problem.detail}`);
  }
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('audit-image-loading.ts');
if (invokedDirectly) {
  main();
}
