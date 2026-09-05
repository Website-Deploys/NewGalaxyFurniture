import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildSrcSet, DERIVATIVE_WIDTHS } from '@/lib/images/srcset';
import { cardImagePreload, heroImagePreload } from '@/lib/images/preload';
import {
  CARD_MAX_WIDTH,
  EAGER_CARDS,
  cardWidths,
  isEagerCard,
  loadingAttributes,
} from '@/lib/images/staging';
import type { ProductImageValue } from '@/schemas/product';

import {
  auditImages,
  classesReservingBox,
  imagesWithAncestors,
  MAX_EAGER_IMAGES,
  preloadedImageUrls,
  srcsetWidths,
} from '../../scripts/audit-image-loading';

/**
 * The image loading strategy: the staging rules, and the build-time audit that holds every surface
 * to them.
 *
 * The rules are the design's "Delivery budget on the page" table plus its Techniques list. They used
 * to be decided at each call site, and two of them were being decided wrongly: six eager cards each
 * claimed `fetchpriority="high"`, and a card's `srcset` advertised the full-resolution derivative.
 * Both are now unreachable from the markup, and the audit fails the build on either.
 *
 * The audit's own rules are exercised against synthetic pages rather than only against `dist/`,
 * because the catalogue is empty: with no product content the real output contains one image, so a
 * check that only ran over `dist/` would report "clean" for rules it never evaluated.
 *
 * Requirements: 15.10, 15.17, 22.7, 22.9, 22.10.
 */

function image(overrides: Partial<ProductImageValue> = {}): ProductImageValue {
  return {
    id: 'img_test000001',
    key: 'originals/img_test000001.jpg',
    alt: 'A test photograph',
    width: 2400,
    height: 1600,
    order: 0,
    altSource: 'admin',
    ...overrides,
  };
}

const ASPECT_CLASSES = new Set(['ngf-image', 'ngf-hero-figure']);

/** A minimal page: one prioritised hero, its matching preload, and a reserved box. */
function heroPage(): string {
  return `<html><head>
    <link rel="preload" as="image" href="/hero.svg" fetchpriority="high">
    </head><body><figure class="ngf-hero-figure">
    <img src="/hero.svg" width="1600" height="1200" alt="" loading="eager" decoding="sync" fetchpriority="high">
    </figure></body></html>`;
}

function rules(problems: { rule: string }[]): string[] {
  return problems.map((problem) => problem.rule);
}

describe('the staging rules', () => {
  it('marks the first six cards of a grid eager and everything after them lazy', () => {
    expect(EAGER_CARDS).toBe(6);
    for (let position = 0; position < 6; position += 1) {
      expect(isEagerCard(position), `position ${String(position)}`).toBe(true);
    }
    for (const position of [6, 7, 24, 999]) {
      expect(isEagerCard(position), `position ${String(position)}`).toBe(false);
    }
    // Total over nonsense input: the staging decision never throws and never defaults to eager.
    expect(isEagerCard(-1)).toBe(false);
    expect(isEagerCard(Number.NaN)).toBe(false);
  });

  it('separates priority from eager, so six eager cards claim no priority', () => {
    expect(loadingAttributes({ priority: true })).toEqual({
      loading: 'eager',
      decoding: 'sync',
      fetchpriority: 'high',
    });
    expect(loadingAttributes({ eager: true })).toEqual({
      loading: 'eager',
      decoding: 'async',
      fetchpriority: 'auto',
    });
    expect(loadingAttributes()).toEqual({
      loading: 'lazy',
      decoding: 'async',
      fetchpriority: 'auto',
    });
    // Both flags together is the priority image, not a lazy high-priority contradiction.
    expect(loadingAttributes({ priority: true, eager: true }).fetchpriority).toBe('high');
  });

  it('never offers a card the full-resolution derivative or the zoom rung', () => {
    for (const intrinsic of [800, 960, 1280, 1600, 2000, 3000, 4096]) {
      const widths = cardWidths(intrinsic);
      expect(widths.length, `intrinsic ${String(intrinsic)}`).toBeGreaterThan(0);
      const widest = widths[widths.length - 1] ?? 0;
      expect(widest, `intrinsic ${String(intrinsic)}`).toBeLessThan(intrinsic);
      expect(widest).toBeLessThanOrEqual(CARD_MAX_WIDTH);
      expect(widths).not.toContain(2000);
    }
  });

  it('keeps a card srcset non-empty even for an image narrower than the ladder', () => {
    /*
     * Below the 800 px upload minimum the schema enforces — impossible through the pipeline, still
     * representable in the type. The image's own width is then the only candidate there is: an empty
     * `srcset` would send the browser to `src` with no width information, which is worse than
     * offering the one file that exists.
     */
    expect(cardWidths(200)).toEqual([200]);
    expect(cardWidths(320)).toEqual([DERIVATIVE_WIDTHS[0]]);
    expect(buildSrcSet({ productId: 'p', image: image({ width: 200 }) }, cardWidths(200))).not.toBe(
      '',
    );
  });

  it('builds the card preload from the same capped ladder the card renders', () => {
    const hint = cardImagePreload('prod-1', image({ width: 2400, height: 1800 }));
    expect(hint).not.toBeNull();
    expect(srcsetWidths(hint?.srcset ?? '')).toEqual(cardWidths(2400));
    expect(hint?.sizes).toContain('vw');
  });

  it('hints nothing when there is no contentful image', () => {
    expect(cardImagePreload('prod-1', null)).toBeNull();
    expect(heroImagePreload(null)).toBeNull();
    expect(heroImagePreload('   ')).toBeNull();
    expect(heroImagePreload('/brand/hero.svg')).toEqual({ href: '/brand/hero.svg' });
  });
});

describe('the built-output image audit', () => {
  it('accepts a page whose prioritised image is the preloaded one', () => {
    expect(auditImages(heroPage(), 'index.html', ASPECT_CLASSES)).toEqual([]);
  });

  it('rejects two prioritised images', () => {
    const html = heroPage().replace(
      '</body>',
      '<figure class="ngf-hero-figure"><img src="/b.jpg" width="8" height="8" alt="" loading="eager" decoding="async" fetchpriority="high"></figure></body>',
    );
    expect(rules(auditImages(html, 'p.html', ASPECT_CLASSES))).toContain(
      'at most one prioritised image',
    );
  });

  it('rejects two preloaded images', () => {
    const html = heroPage().replace(
      '</head>',
      '<link rel="preload" as="image" href="/second.jpg"></head>',
    );
    expect(rules(auditImages(html, 'p.html', ASPECT_CLASSES))).toContain(
      'at most one preloaded image',
    );
  });

  it('rejects a prioritised image that is never preloaded, and a preload with no priority', () => {
    const noPreload = heroPage().replace(/<link[^>]*>/, '');
    expect(rules(auditImages(noPreload, 'p.html', ASPECT_CLASSES))).toContain(
      'the prioritised image is the preloaded one',
    );

    const noPriority = heroPage().replace(
      ' fetchpriority="high">\n    </figure>',
      '>\n    </figure>',
    );
    expect(rules(auditImages(noPriority, 'p.html', ASPECT_CLASSES))).toContain(
      'the preloaded image is the prioritised one',
    );
  });

  it('rejects a preload that names a different candidate than the element fetches', () => {
    const html = heroPage().replace(
      'href="/hero.svg" fetchpriority',
      'href="/other.svg" fetchpriority',
    );
    expect(
      auditImages(html, 'p.html', ASPECT_CLASSES)
        .map((problem) => problem.detail)
        .join(' '),
    ).toContain('two fetches instead of one');
  });

  it('rejects a prioritised image that is lazy', () => {
    const html = heroPage().replace('loading="eager"', 'loading="lazy"');
    expect(rules(auditImages(html, 'p.html', ASPECT_CLASSES))).toContain(
      'the prioritised image loads eagerly',
    );
  });

  it('rejects an image with no intrinsic dimensions and one with no reserved box', () => {
    const noDimensions =
      '<figure class="ngf-image"><img src="/a.jpg" alt="" loading="lazy" decoding="async"></figure>';
    expect(rules(auditImages(noDimensions, 'p.html', ASPECT_CLASSES))).toContain(
      'intrinsic width and height on every image',
    );

    const noBox =
      '<div class="plain"><img src="/a.jpg" width="4" height="3" alt="" loading="lazy" decoding="async"></div>';
    expect(rules(auditImages(noBox, 'p.html', ASPECT_CLASSES))).toContain(
      'every media slot reserves its box',
    );
  });

  it('accepts an inline aspect-ratio as a reserved box', () => {
    const inline =
      '<div style="aspect-ratio: 4 / 5;"><img src="/a.jpg" width="4" height="5" alt="" loading="lazy" decoding="async"></div>';
    expect(auditImages(inline, 'p.html', new Set())).toEqual([]);
  });

  it('rejects a non-prioritised image that is not lazy and async', () => {
    const notLazy =
      '<figure class="ngf-image"><img src="/a.jpg" width="4" height="3" alt="" decoding="async"></figure>';
    expect(rules(auditImages(notLazy, 'p.html', ASPECT_CLASSES))).toContain(
      'every image except the prioritised one is loading="lazy"',
    );

    const notAsync =
      '<figure class="ngf-image"><img src="/a.jpg" width="4" height="3" alt="" loading="lazy" decoding="sync"></figure>';
    expect(rules(auditImages(notAsync, 'p.html', ASPECT_CLASSES))).toContain(
      'every image except the prioritised one is decoding="async"',
    );
  });

  it('allows six eager cards and rejects a seventh', () => {
    const card = (index: number): string =>
      `<li class="ngf-grid"><div class="ngf-card-media"><span class="ngf-image"><img src="/c${String(index)}.webp" width="960" height="1200" srcset="/c${String(index)}-320.webp 320w, /c${String(index)}-640.webp 640w" sizes="30vw" alt="" loading="eager" decoding="async"></span></div></li>`;
    const six = `<ul>${Array.from({ length: MAX_EAGER_IMAGES }, (_unused, index) => card(index)).join('')}</ul>`;
    expect(auditImages(six, 'collection.html', ASPECT_CLASSES)).toEqual([]);

    const seven = `<ul>${Array.from({ length: MAX_EAGER_IMAGES + 1 }, (_unused, index) => card(index)).join('')}</ul>`;
    expect(rules(auditImages(seven, 'collection.html', ASPECT_CLASSES)).join(' ')).toContain(
      'at most 6 eager images',
    );
  });

  it('rejects an eager image that is not a card', () => {
    const html =
      '<figure class="ngf-image"><img src="/a.jpg" width="4" height="3" alt="" loading="eager" decoding="async"></figure>';
    expect(rules(auditImages(html, 'p.html', ASPECT_CLASSES))).toContain(
      'only the prioritised image and above-fold cards load eagerly',
    );
  });

  it('recognises each eager-eligible container: card grid, gallery page, and the lookbook', () => {
    /*
     * The audit allowlists the containers whose above-the-fold tiles are legitimately eager. The
     * gallery lookbook (`/gallery`, ul.ngf-lookbook > li.ngf-lookbook-tile > a.ngf-lookbook-link >
     * span.ngf-lookbook-frame > .ngf-image) joined this set: its first tiles are eager and its first
     * tile is the page's prioritised LCP image, exactly like the catalogue grid. This case guards
     * that the lookbook is accepted so the e2e boot blocker cannot silently reopen.
     */
    const eagerTile = (container: string, inner = ''): string =>
      `<ul class="${container}"><li${inner}><span class="ngf-image"><img src="/a.jpg" width="4" height="3" alt="" loading="eager" decoding="async"></span></li></ul>`;
    for (const container of ['ngf-grid', 'ngf-gallerypage', 'ngf-lookbook']) {
      expect(auditImages(eagerTile(container), 'p.html', ASPECT_CLASSES), container).toEqual([]);
    }

    // The real lookbook shape from src/pages/gallery.astro, eager first tile, box reserved by .ngf-image.
    const lookbook =
      '<ul class="ngf-lookbook"><li class="ngf-lookbook-tile ngf-lookbook-tile-wide">' +
      '<a class="ngf-lookbook-link" href="/product/x"><span class="ngf-lookbook-frame" data-reveal="mask">' +
      '<span class="ngf-image"><img src="/img/p1/i1-960.webp" width="960" height="1200" ' +
      'srcset="/img/p1/i1-320.webp 320w, /img/p1/i1-640.webp 640w" sizes="30vw" alt="" ' +
      'loading="eager" decoding="async"></span></span></a></li></ul>';
    expect(auditImages(lookbook, 'gallery.html', ASPECT_CLASSES)).toEqual([]);

    // An eager image with no recognised container is still rejected — the rule is not weakened.
    const notContainer =
      '<figure class="ngf-image"><img src="/a.jpg" width="4" height="3" alt="" loading="eager" decoding="async"></figure>';
    expect(rules(auditImages(notContainer, 'p.html', ASPECT_CLASSES))).toContain(
      'only the prioritised image and above-fold cards load eagerly',
    );
  });

  it('rejects a card served its full-resolution or zoom derivative', () => {
    const fullRes =
      '<div class="ngf-card-media"><span class="ngf-image"><img src="/c.webp" width="1600" height="1200" srcset="/c-960.webp 960w, /c-1600.webp 1600w" sizes="30vw" alt="" loading="lazy" decoding="async"></span></div>';
    expect(rules(auditImages(fullRes, 'p.html', ASPECT_CLASSES))).toContain(
      'no card is served a full-resolution image',
    );

    const zoom =
      '<div class="ngf-card-media"><span class="ngf-image"><img src="/c.webp" width="4000" height="3000" srcset="/c-2000.webp 2000w" sizes="30vw" alt="" loading="lazy" decoding="async"></span></div>';
    expect(
      auditImages(zoom, 'p.html', ASPECT_CLASSES)
        .map((problem) => problem.detail)
        .join(' '),
    ).toContain('2000px derivative');
  });

  it('rejects a page that pulls the search index into its initial payload', () => {
    const html = `${heroPage()}<link rel="preload" as="fetch" href="/search-index/abc.json">`;
    expect(rules(auditImages(html, 'p.html', ASPECT_CLASSES))).toContain(
      'the search index is in no initial payload',
    );
  });

  it('reads the element stack and the preloads it needs', () => {
    const images = imagesWithAncestors(
      '<main><div class="ngf-card-media"><span class="ngf-image"><img src="/a.jpg"></span></div></main>',
    );
    expect(images).toHaveLength(1);
    expect(images[0]?.ancestors.map((ancestor) => ancestor.name)).toEqual(['span', 'div', 'main']);

    // An <img> inside a comment or a script is not markup the page renders.
    expect(imagesWithAncestors('<!-- <img src="/x.jpg"> -->')).toEqual([]);
    expect(imagesWithAncestors('<script>const s = "<img src=\'/x.jpg\'>";</script>')).toEqual([]);

    expect(preloadedImageUrls(heroPage())).toEqual(['/hero.svg']);
    // A font preload is not an image preload.
    expect(
      preloadedImageUrls('<link rel="preload" href="/f.woff2" as="font" type="font/woff2">'),
    ).toEqual([]);

    expect(srcsetWidths('/a-320.webp 320w, /a-640.webp 640w')).toEqual([320, 640]);
  });

  it('collects the classes a stylesheet reserves a box for, and no others', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ngf-aspect-'));
    const path = join(directory, 'styles.css');
    writeFileSync(
      path,
      '.ngf-image{aspect-ratio:4/5;display:block}.plain{display:block}.ngf-hero-figure,.other{aspect-ratio:1}' +
        '.ngf-gallery-thumb>img{height:72px}.stretchy{height:100%}',
      'utf8',
    );
    try {
      const classes = classesReservingBox([path]);
      expect(classes.has('ngf-image')).toBe(true);
      expect(classes.has('ngf-hero-figure')).toBe(true);
      expect(classes.has('other')).toBe(true);
      expect(classes.has('plain')).toBe(false);
      // A fixed height reserves a box; `height: 100%` defers to something else and does not.
      expect(classes.has('ngf-gallery-thumb')).toBe(true);
      expect(classes.has('stretchy')).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
