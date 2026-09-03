import { describe, expect, it } from 'vitest';

import {
  applyGalleryKey,
  atFirst,
  atLast,
  closeZoom,
  galleryKeyAction,
  initialGalleryState,
  markImageFailed,
  nextImage,
  openZoom,
  positionLabel,
  previousImage,
  reduceGallery,
  selectImage,
  showsPositionIndicators,
  showsStepControls,
  showsThumbnailRail,
  zoomAvailable,
} from '@/lib/products/gallery-state';
import {
  clearRecent,
  parseRecent,
  pushRecent,
  readRecent,
  recordView,
  RECENTLY_VIEWED_KEY,
  RECENTLY_VIEWED_MAX,
  serializeRecent,
  visibleRecent,
  type RecentCard,
  type RecentEntry,
  type RecentStorage,
} from '@/lib/products/recently-viewed';
import {
  manualRelatedSlugs,
  priceDistance,
  relatedProducts,
  relatedScore,
  withinPriceProximity,
} from '@/lib/products/related';
import type { SearchDoc } from '@/lib/search/types';

/**
 * The product detail page's decisions, as values.
 *
 * The gallery's behavioural requirements (4.4, 4.5, 4.14–4.18) and the recently-viewed buffer's
 * (4.10, 4.11) are all statements about state rather than about pixels, so they are asserted
 * against the pure modules that hold them. Anything asserted here cannot be got wrong by the
 * component, because the component holds no logic of its own.
 *
 * Requirements: 4.4, 4.5, 4.7, 4.8, 4.9, 4.10, 4.11, 4.14, 4.15, 4.16, 4.18.
 */

/* -------------------------------------------------------------------------- */
/* Gallery state machine                                                      */
/* -------------------------------------------------------------------------- */

describe('gallery: stepping and hard stops (Requirement 4.15)', () => {
  it('moves forward and back through the sequence', () => {
    const start = initialGalleryState(4);
    expect(start.index).toBe(0);
    const second = nextImage(start);
    expect(second.index).toBe(1);
    expect(previousImage(second).index).toBe(0);
  });

  it('takes no action on previous at the first image, returning the identical state', () => {
    const state = initialGalleryState(3);
    expect(atFirst(state)).toBe(true);
    // Identity, not equality: the island reads "did not move" as "do not consume the key", so a
    // fresh-but-equal object would silently stop the page scrolling at the ends of the gallery.
    expect(previousImage(state)).toBe(state);
    expect(applyGalleryKey(state, 'ArrowLeft')).toEqual({ state, handled: false });
  });

  it('takes no action on next at the last image, returning the identical state', () => {
    const state = selectImage(initialGalleryState(3), 2);
    expect(atLast(state)).toBe(true);
    expect(nextImage(state)).toBe(state);
    expect(applyGalleryKey(state, 'ArrowRight')).toEqual({ state, handled: false });
  });

  it('maps exactly the specified keys and leaves every other key alone', () => {
    expect(galleryKeyAction('ArrowLeft')).toEqual({ type: 'previous' });
    expect(galleryKeyAction('ArrowRight')).toEqual({ type: 'next' });
    expect(galleryKeyAction('Enter')).toEqual({ type: 'openZoom' });
    expect(galleryKeyAction(' ')).toEqual({ type: 'openZoom' });
    expect(galleryKeyAction('Escape')).toEqual({ type: 'closeZoom' });
    for (const key of ['Tab', 'a', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'PageDown']) {
      expect(galleryKeyAction(key)).toBeNull();
      const state = initialGalleryState(3);
      expect(applyGalleryKey(state, key)).toEqual({ state, handled: false });
    }
  });

  it('opens zoom on Enter and Space, and closes on Escape', () => {
    const state = initialGalleryState(2);
    const opened = applyGalleryKey(state, 'Enter');
    expect(opened.handled).toBe(true);
    expect(opened.state.zoomed).toBe(true);
    const spaced = applyGalleryKey(state, ' ');
    expect(spaced.state.zoomed).toBe(true);
    const closed = applyGalleryKey(opened.state, 'Escape');
    expect(closed.handled).toBe(true);
    expect(closed.state.zoomed).toBe(false);
    // Escape with nothing open is a no-op, so the key falls through to whatever else wants it.
    expect(applyGalleryKey(state, 'Escape')).toEqual({ state, handled: false });
  });
});

describe('gallery: thumbnail activation (Requirement 4.4)', () => {
  it('swaps the displayed image and marks the new position', () => {
    const state = selectImage(initialGalleryState(5), 3);
    expect(state.index).toBe(3);
    expect(positionLabel(state)).toBe('Image 4 of 5');
  });

  it('ignores an out-of-range or non-integer index rather than clamping to a different image', () => {
    const state = initialGalleryState(3);
    for (const index of [-1, 3, 99, 1.5, Number.NaN]) {
      expect(selectImage(state, index)).toBe(state);
    }
    expect(selectImage(state, 0)).toBe(state);
  });
});

describe('gallery: the single-image product (Requirement 4.16)', () => {
  const single = initialGalleryState(1);

  it('omits the rail, the indicators, and the previous/next controls', () => {
    expect(showsThumbnailRail(single)).toBe(false);
    expect(showsPositionIndicators(single)).toBe(false);
    expect(showsStepControls(single)).toBe(false);
  });

  it('keeps zoom operable', () => {
    expect(zoomAvailable(single)).toBe(true);
    expect(openZoom(single).zoomed).toBe(true);
  });

  it('is simultaneously at the first and the last image, so both arrows are no-ops', () => {
    expect(atFirst(single)).toBe(true);
    expect(atLast(single)).toBe(true);
    expect(nextImage(single)).toBe(single);
    expect(previousImage(single)).toBe(single);
  });

  it('shows the rail, indicators, and controls as soon as there are two images', () => {
    const pair = initialGalleryState(2);
    expect(showsThumbnailRail(pair)).toBe(true);
    expect(showsPositionIndicators(pair)).toBe(true);
    expect(showsStepControls(pair)).toBe(true);
  });
});

describe('gallery: position and total exposed to assistive technology (Requirements 4.5, 4.14, 4.15)', () => {
  it('states the one-based position and the total', () => {
    expect(positionLabel(initialGalleryState(6))).toBe('Image 1 of 6');
    expect(positionLabel(selectImage(initialGalleryState(6), 5))).toBe('Image 6 of 6');
  });

  it('says something honest for a product with no images', () => {
    const none = initialGalleryState(0);
    expect(positionLabel(none)).toBe('No images');
    expect(zoomAvailable(none)).toBe(false);
    expect(openZoom(none)).toBe(none);
  });
});

describe('gallery: load failure (Requirement 4.18)', () => {
  it('records the failed image without moving the displayed position', () => {
    const state = selectImage(initialGalleryState(4), 2);
    const failed = markImageFailed(state, 2);
    expect(failed.failed.has(2)).toBe(true);
    expect(failed.index).toBe(2);
  });

  it('keeps every other image navigable after a failure', () => {
    const failed = markImageFailed(initialGalleryState(3), 0);
    const stepped = nextImage(failed);
    expect(stepped.index).toBe(1);
    expect(stepped.failed.has(0)).toBe(true);
    expect(selectImage(stepped, 2).index).toBe(2);
  });

  it('is idempotent and ignores an index that does not exist', () => {
    const once = markImageFailed(initialGalleryState(2), 1);
    expect(markImageFailed(once, 1)).toBe(once);
    expect(markImageFailed(once, 7)).toBe(once);
  });
});

describe('gallery: the reducer covers every action', () => {
  it('dispatches each action to its transition', () => {
    let state = initialGalleryState(3);
    state = reduceGallery(state, { type: 'next' });
    expect(state.index).toBe(1);
    state = reduceGallery(state, { type: 'select', index: 2 });
    expect(state.index).toBe(2);
    state = reduceGallery(state, { type: 'previous' });
    expect(state.index).toBe(1);
    state = reduceGallery(state, { type: 'openZoom' });
    expect(state.zoomed).toBe(true);
    state = reduceGallery(state, { type: 'imageFailed', index: 1 });
    expect(state.failed.has(1)).toBe(true);
    state = reduceGallery(state, { type: 'closeZoom' });
    expect(state.zoomed).toBe(false);
    expect(closeZoom(state)).toBe(state);
  });
});

/* -------------------------------------------------------------------------- */
/* Recently viewed                                                            */
/* -------------------------------------------------------------------------- */

function card(name: string, slug: string): RecentCard {
  return { name, price: '₹42,000', href: `/product/${slug}` };
}

function entry(slug: string, ts: number): RecentEntry {
  return { slug, ts, card: card(slug.toUpperCase(), slug) };
}

/** An in-memory `localStorage`, so the buffer is exercised without a browser. */
function memoryStorage(initial: string | null = null): RecentStorage & { value: string | null } {
  const store: { value: string | null } = { value: initial };
  return {
    get value() {
      return store.value;
    },
    set value(next: string | null) {
      store.value = next;
    },
    getItem: (key) => (key === RECENTLY_VIEWED_KEY ? store.value : null),
    setItem: (key, next) => {
      if (key === RECENTLY_VIEWED_KEY) store.value = next;
    },
  };
}

describe('recently viewed: the ring buffer (Requirement 4.10)', () => {
  it('records the newest view first', () => {
    const list = pushRecent(pushRecent([], entry('alpha', 1)), entry('beta', 2));
    expect(list.map((item) => item.slug)).toEqual(['beta', 'alpha']);
  });

  it('moves an existing entry rather than duplicating it', () => {
    let list: RecentEntry[] = [];
    for (const slug of ['alpha', 'beta', 'gamma']) list = pushRecent(list, entry(slug, 1));
    list = pushRecent(list, entry('alpha', 9));
    expect(list.map((item) => item.slug)).toEqual(['alpha', 'gamma', 'beta']);
    expect(list.filter((item) => item.slug === 'alpha')).toHaveLength(1);
    expect(list).toHaveLength(3);
  });

  it('discards the oldest entry beyond eight, and never exceeds eight', () => {
    let list: RecentEntry[] = [];
    for (let index = 0; index < 12; index += 1) list = pushRecent(list, entry(`p-${index}`, index));
    expect(list).toHaveLength(RECENTLY_VIEWED_MAX);
    expect(list[0]?.slug).toBe('p-11');
    // p-0 through p-3 were evicted; p-4 is the oldest survivor.
    expect(list[RECENTLY_VIEWED_MAX - 1]?.slug).toBe('p-4');
    expect(list.some((item) => item.slug === 'p-0')).toBe(false);
  });

  it('ignores a blank slug', () => {
    const list = pushRecent([entry('alpha', 1)], { slug: '   ', ts: 2 });
    expect(list.map((item) => item.slug)).toEqual(['alpha']);
  });
});

describe('recently viewed: what is shown (Requirement 4.11)', () => {
  it('omits the section entirely below two products other than the current one', () => {
    expect(visibleRecent([], 'current')).toEqual([]);
    expect(visibleRecent([entry('current', 3)], 'current')).toEqual([]);
    expect(visibleRecent([entry('current', 3), entry('alpha', 2)], 'current')).toEqual([]);
  });

  it('renders most recent first, excluding the current product, once two others exist', () => {
    const list = [entry('current', 5), entry('gamma', 4), entry('beta', 3), entry('alpha', 2)];
    expect(visibleRecent(list, 'current').map((item) => item.slug)).toEqual([
      'gamma',
      'beta',
      'alpha',
    ]);
  });

  it('does not count an entry it cannot describe', () => {
    const list: RecentEntry[] = [{ slug: 'beta', ts: 2 }, entry('gamma', 3)];
    expect(visibleRecent(list, 'current')).toEqual([]);
  });
});

describe('recently viewed: storage is device-local and defensive (Requirement 4.10)', () => {
  it('round-trips through storage', () => {
    const storage = memoryStorage();
    const list = recordView(storage, entry('alpha', 1));
    expect(readRecent(storage)).toEqual(list);
    expect(storage.value).toBe(serializeRecent(list));
  });

  it('records a view on top of what the device already held', () => {
    const storage = memoryStorage(serializeRecent([entry('alpha', 1)]));
    const list = recordView(storage, entry('beta', 2));
    expect(list.map((item) => item.slug)).toEqual(['beta', 'alpha']);
  });

  it('treats a missing, malformed, or hostile stored value as no list at all', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('')).toEqual([]);
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent('{"slug":"a"}')).toEqual([]);
    expect(parseRecent('[1,2,3]')).toEqual([]);
    expect(parseRecent('[{"ts":1}]')).toEqual([]);
    expect(readRecent(null)).toEqual([]);
  });

  it('refuses a card whose href is not a site-relative product path', () => {
    // The stored value is visitor-writable, and `href` is injected into an anchor.
    const hostile = JSON.stringify([
      { slug: 'a', ts: 1, card: { name: 'A', price: '₹1', href: 'javascript:alert(1)' } },
      { slug: 'b', ts: 2, card: { name: 'B', price: '₹1', href: 'https://evil.test/product/b' } },
      { slug: 'c', ts: 3, card: { name: 'C', price: '₹1', href: '/product/c' } },
    ]);
    const parsed = parseRecent(hostile);
    expect(parsed.map((item) => item.card === undefined)).toEqual([true, true, false]);
    // The two hostile entries carry no card, so they are never rendered.
    expect(visibleRecent(parsed, 'z')).toEqual([]);
  });

  it('drops a duplicate slug and caps a hand-edited list at eight', () => {
    const raw = JSON.stringify([
      ...Array.from({ length: 12 }, (_unused, index) => entry(`p-${index}`, index)),
      entry('p-0', 99),
    ]);
    const parsed = parseRecent(raw);
    expect(parsed).toHaveLength(RECENTLY_VIEWED_MAX);
    expect(new Set(parsed.map((item) => item.slug)).size).toBe(parsed.length);
  });

  it('survives storage that throws on access', () => {
    const throwing: RecentStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readRecent(throwing)).toEqual([]);
    expect(() => recordView(throwing, entry('alpha', 1))).not.toThrow();
  });

  it('clears the list', () => {
    const storage = memoryStorage(serializeRecent([entry('alpha', 1), entry('beta', 2)]));
    expect(clearRecent(storage)).toEqual([]);
    expect(readRecent(storage)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Related products — the worked examples behind Properties 40 and 41         */
/* -------------------------------------------------------------------------- */

function doc(overrides: Partial<SearchDoc> & { i: string }): SearchDoc {
  return {
    n: overrides.i,
    k: `NGF-${overrides.i.toUpperCase()}-0`,
    c: 'sofas',
    o: [],
    t: [],
    p: 40_000,
    st: 'IN_STOCK',
    f: 0,
    ts: 1_700_000_000,
    th: '',
    lq: '',
    ...overrides,
  };
}

describe('related products: scoring (Requirements 4.7, 4.8, 4.9)', () => {
  const target = doc({
    i: 'target',
    c: 'sofas',
    s: 'sectional',
    m: 'Sheesham Wood',
    t: ['l-shape', 'premium', 'handcrafted'],
    o: ['Brown', 'Walnut'],
    p: 100_000,
  });

  it('pays each rung the design\u2019s weight', () => {
    expect(relatedScore(target, doc({ i: 'a', c: 'beds', p: null }))).toBe(0);
    expect(relatedScore(target, doc({ i: 'b', c: 'sofas', p: null }))).toBe(4);
    expect(relatedScore(target, doc({ i: 'c', c: 'sofas', s: 'sectional', p: null }))).toBe(9);
    expect(relatedScore(target, doc({ i: 'd', c: 'beds', m: 'Sheesham Wood', p: null }))).toBe(2);
    expect(relatedScore(target, doc({ i: 'e', c: 'beds', o: ['Brown'], p: null }))).toBe(1);
    expect(relatedScore(target, doc({ i: 'f', c: 'beds', p: 100_000 }))).toBe(2);
  });

  it('caps the tag rung at +6 however many tags are shared', () => {
    const two = doc({ i: 'two', c: 'beds', t: ['l-shape', 'premium'], p: null });
    const three = doc({ i: 'three', c: 'beds', t: ['l-shape', 'premium', 'handcrafted'], p: null });
    expect(relatedScore(target, two)).toBe(4);
    expect(relatedScore(target, three)).toBe(6);
  });

  it('pays the colour rung once, not once per shared colour', () => {
    const one = doc({ i: 'one', c: 'beds', o: ['Brown'], p: null });
    const both = doc({ i: 'both', c: 'beds', o: ['Brown', 'Walnut'], p: null });
    expect(relatedScore(target, both)).toBe(relatedScore(target, one));
  });

  it('folds case and accents, so one material is not two', () => {
    expect(relatedScore(target, doc({ i: 'x', c: 'beds', m: 'sheesham  wood', p: null }))).toBe(2);
    const cafe = doc({ i: 'y', c: 'beds', o: ['Café Noir'], p: null });
    const plain = { ...target, o: ['Cafe Noir'] };
    expect(relatedScore(plain, cafe)).toBe(1);
  });

  it('measures price proximity as ±35% of the target, and tails unpriced products', () => {
    expect(withinPriceProximity(100_000, 135_000)).toBe(true);
    expect(withinPriceProximity(100_000, 65_000)).toBe(true);
    expect(withinPriceProximity(100_000, 135_001)).toBe(false);
    expect(withinPriceProximity(100_000, null)).toBe(false);
    expect(withinPriceProximity(null, 100_000)).toBe(false);
    expect(priceDistance(100_000, null)).toBe(Number.POSITIVE_INFINITY);
    expect(priceDistance(100_000, 120_000)).toBeCloseTo(0.2);
  });

  it('excludes a zero-scoring candidate rather than padding the section (4.9)', () => {
    const unrelated = doc({ i: 'unrelated', c: 'outdoor', p: null });
    expect(relatedProducts(target, [unrelated])).toEqual([]);
  });

  it('excludes the target itself even when the catalogue lists it (4.8)', () => {
    const sibling = doc({ i: 'sibling', c: 'sofas', p: 100_000 });
    const result = relatedProducts(target, [target, sibling]);
    expect(result.map((entry) => entry.i)).toEqual(['sibling']);
  });

  it('caps the section at eight (4.8)', () => {
    const pool = Array.from({ length: 20 }, (_unused, index) =>
      doc({ i: `sofa-${index}`, c: 'sofas', p: 100_000 }),
    );
    expect(relatedProducts(target, pool)).toHaveLength(8);
  });

  it('breaks ties on slug, so the order is stable across builds', () => {
    const pool = ['delta', 'alpha', 'charlie', 'bravo'].map((slug) =>
      doc({ i: slug, c: 'sofas', p: 100_000 }),
    );
    expect(relatedProducts(target, pool).map((entry) => entry.i)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'delta',
    ]);
  });

  it('orders a higher score before a nearer price', () => {
    const sameSubcategoryFarPrice = doc({ i: 'a-sub', c: 'sofas', s: 'sectional', p: 300_000 });
    const sameCategoryExactPrice = doc({ i: 'z-price', c: 'sofas', p: 100_000 });
    const result = relatedProducts(target, [sameCategoryExactPrice, sameSubcategoryFarPrice]);
    expect(result.map((entry) => entry.i)).toEqual(['a-sub', 'z-price']);
  });

  it('puts the operator\u2019s own list first, in the operator\u2019s order', () => {
    const pool = [
      doc({ i: 'scored', c: 'sofas', s: 'sectional', p: 100_000 }),
      doc({ i: 'manual-one', c: 'outdoor', p: null }),
      doc({ i: 'manual-two', c: 'office', p: null }),
    ];
    const result = relatedProducts({ ...target, r: ['manual-two', 'manual-one'] }, pool);
    expect(result.map((entry) => entry.i)).toEqual(['manual-two', 'manual-one', 'scored']);
  });
});

describe('related products: resolving the operator\u2019s list (Requirement 4.7)', () => {
  const base = {
    id: 'p_aaaaaaaaaa',
    slug: 'target',
    relatedProductIds: [] as string[],
  };

  function product(id: string, slug: string, related: string[] = []) {
    return { ...base, id, slug, relatedProductIds: related } as unknown as Parameters<
      typeof manualRelatedSlugs
    >[0];
  }

  it('accepts a product id or a slug, and preserves the operator\u2019s order', () => {
    const target = product('p_aaaaaaaaaa', 'target', ['p_cccccccccc', 'beta']);
    const catalogue = [
      target,
      product('p_bbbbbbbbbb', 'beta'),
      product('p_cccccccccc', 'gamma'),
    ] as Parameters<typeof manualRelatedSlugs>[1];
    expect(manualRelatedSlugs(target, catalogue)).toEqual(['gamma', 'beta']);
  });

  it('drops an unresolvable entry, a self-reference, and a duplicate', () => {
    const target = product('p_aaaaaaaaaa', 'target', [
      'p_zzzzzzzzzz',
      'target',
      'beta',
      'p_bbbbbbbbbb',
      '  ',
    ]);
    const catalogue = [target, product('p_bbbbbbbbbb', 'beta')] as Parameters<
      typeof manualRelatedSlugs
    >[1];
    expect(manualRelatedSlugs(target, catalogue)).toEqual(['beta']);
  });
});
