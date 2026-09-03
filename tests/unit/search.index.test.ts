import { describe, expect, it } from 'vitest';

import {
  assertSearchIndexBudget,
  brotliSize,
  measureSearchIndex,
  SEARCH_INDEX_BUDGET_BYTES,
} from '@/lib/search/budget';
import {
  buildSearchIndex,
  coloursOf,
  flagsOf,
  searchIndexHash,
  searchIndexPath,
  serializeSearchIndex,
  toSearchDoc,
} from '@/lib/search/build-index';
import { hasFlag, PRODUCT_FLAGS } from '@/lib/search/types';
import type { SearchDoc } from '@/lib/search/types';
import type { Product } from '@/schemas/product';

import { demoDiningTable, demoDraftChair, demoSofa } from '../fixtures/products';

/**
 * The search index builder and its size budget.
 *
 * Requirements: 2.11, 22.7, 22.8, 22.14.
 */

describe('toSearchDoc', () => {
  it('maps every field the catalogue surfaces need', () => {
    const doc = toSearchDoc(demoSofa);

    expect(doc.i).toBe(demoSofa.slug);
    expect(doc.n).toBe(demoSofa.name);
    expect(doc.k).toBe(demoSofa.sku);
    expect(doc.c).toBe('sofas');
    expect(doc.m).toBe('Sheesham Wood');
    expect(doc.t).toEqual(['l-shape', 'premium']);
    expect(doc.p).toBe(42000);
    expect(doc.st).toBe('IN_STOCK');
    expect(doc.ts).toBe(Math.floor(Date.parse('2025-01-15T10:00:00.000Z') / 1000));
    // The thumbnail is a resolved `/img/**` URL for the primary image.
    expect(doc.th).toBe('/img/p_demo000001/img_demo000001-320.webp');
  });

  it('reports null price for a price-on-enquiry product, never a number', () => {
    const doc = toSearchDoc(demoDiningTable);
    expect(doc.p).toBeNull();
    expect(doc.st).toBe('MADE_TO_ORDER');
    expect(hasFlag(doc, 'madeToOrder')).toBe(true);
  });

  it('omits absent optional fields instead of emitting empty strings', () => {
    const doc = toSearchDoc(demoDraftChair);
    expect(doc.m).toBeUndefined();
    expect(doc.s).toBeUndefined();
    expect(doc.sz).toBeUndefined();
    expect(Object.keys(doc)).not.toContain('m');
    // No image at all: the thumbnail and LQIP are empty rather than a broken URL.
    expect(doc.th).toBe('');
    expect(doc.lq).toBe('');
  });

  it('carries the size so the size filter dimension has values to derive', () => {
    const sized: Product = { ...demoSofa, size: '3 Seater' };
    expect(toSearchDoc(sized).sz).toBe('3 Seater');
  });

  it('merges colour and availableColors without duplicating', () => {
    expect(coloursOf(demoSofa)).toEqual(['Brown', 'Beige']);
    expect(coloursOf({ ...demoSofa, color: 'brown' })).toEqual(['brown', 'Beige']);
    expect(coloursOf({ ...demoSofa, color: undefined, availableColors: [] })).toEqual([]);
  });

  it('packs the five merchandising flags into the bitmask, in the design’s bit order', () => {
    expect(flagsOf(demoSofa)).toBe(PRODUCT_FLAGS.featured | PRODUCT_FLAGS.newArrival);
    expect(flagsOf(demoDiningTable)).toBe(PRODUCT_FLAGS.trending | PRODUCT_FLAGS.madeToOrder);
    expect(
      flagsOf({
        ...demoSofa,
        featured: true,
        trending: true,
        bestSeller: true,
        newArrival: true,
        madeToOrder: true,
        stockStatus: 'MADE_TO_ORDER',
      }),
    ).toBe(31);
  });

  it('turns an unparseable createdAt into 0 rather than NaN', () => {
    // A hand-edited file must not be able to produce a document that breaks the comparator.
    const doc = toSearchDoc({ ...demoSofa, createdAt: 'not a date' });
    expect(doc.ts).toBe(0);
    expect(Number.isNaN(doc.ts)).toBe(false);
  });
});

describe('buildSearchIndex', () => {
  it('emits one document per product it is given, newest first', () => {
    const docs = buildSearchIndex([demoSofa, demoDiningTable]);
    expect(docs.map((doc) => doc.i)).toEqual([demoDiningTable.slug, demoSofa.slug]);
  });

  it('does not re-implement the Draft filter — it indexes exactly what it is handed', () => {
    // The public/draft decision lives in `getCatalogue()` and nowhere else (Requirement 2.11).
    // This builder is therefore deliberately not a second gate, and this test pins that down so
    // nobody "fixes" it by adding a status check here and creating two places for the rule.
    const docs = buildSearchIndex([demoDraftChair]);
    expect(docs).toHaveLength(1);
  });

  it('is deterministic: the same catalogue yields the same bytes and the same hash', () => {
    const first = serializeSearchIndex(buildSearchIndex([demoSofa, demoDiningTable]));
    const second = serializeSearchIndex(buildSearchIndex([demoDiningTable, demoSofa]));
    expect(second).toBe(first);
    expect(searchIndexHash(second)).toBe(searchIndexHash(first));
  });

  it('changes the hash — and therefore the asset URL — when the catalogue changes', () => {
    const before = searchIndexHash(serializeSearchIndex(buildSearchIndex([demoSofa])));
    const after = searchIndexHash(
      serializeSearchIndex(buildSearchIndex([{ ...demoSofa, price: 43000 }])),
    );
    expect(after).not.toBe(before);
    expect(searchIndexPath(after)).toBe(`/search-index/${after}.json`);
  });

  it('produces an empty array for an empty catalogue, which is the launch state', () => {
    expect(serializeSearchIndex(buildSearchIndex([]))).toBe('[]');
  });
});

/* -------------------------------------------------------------------------- */
/* The 60 KB Brotli budget gate                                               */
/* -------------------------------------------------------------------------- */

/** A synthetic document of realistic size, for filling the budget. */
function syntheticDoc(index: number): SearchDoc {
  return {
    i: `synthetic-product-number-${index}`,
    n: `Synthetic Product Number ${index} Handcrafted Sheesham`,
    k: `NGF-SYN-${String(index).padStart(6, '0')}`,
    c: 'sofas',
    s: 'sectional',
    m: 'Sheesham Wood, fabric upholstery',
    o: ['Brown', 'Beige', 'Walnut'],
    t: ['l-shape', 'premium', 'handcrafted'],
    p: 25_000 + index,
    st: 'IN_STOCK',
    f: 1,
    ts: 1_700_000_000 + index,
    th: `/img/p_syn${String(index).padStart(7, '0')}/img_syn${String(index).padStart(5, '0')}-320.webp`,
    // A 24 px WebP LQIP is a few hundred base64 characters; random-ish content so it does not
    // compress to nothing and the measurement stays honest.
    lq: `data:image/webp;base64,${Buffer.from(`lqip-${index}-`.repeat(24)).toString('base64')}`,
    sz: '3 Seater',
  };
}

/**
 * A document whose LQIP is near-incompressible, which is what a real base64-encoded 24 px WebP
 * is. Deterministic (xorshift32 from a fixed seed) so the test is not flaky.
 */
function incompressibleDoc(index: number): SearchDoc {
  let seed = (index + 1) * 2_654_435_761;
  const next = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % 256;
  };
  const bytes = Buffer.from(Array.from({ length: 300 }, next));
  return {
    ...syntheticDoc(index),
    lq: `data:image/webp;base64,${bytes.toString('base64')}`,
  };
}

describe('search index budget', () => {
  it('measures the real Brotli size and reports it against the 60 KB budget', () => {
    const serialized = serializeSearchIndex(buildSearchIndex([demoSofa, demoDiningTable]));
    const report = measureSearchIndex(serialized);

    expect(report.budgetBytes).toBe(60 * 1024);
    expect(report.rawBytes).toBe(Buffer.byteLength(serialized, 'utf8'));
    expect(report.brotliBytes).toBe(brotliSize(serialized));
    expect(report.brotliBytes).toBeLessThan(report.rawBytes);
    expect(report.ok).toBe(true);
  });

  it('passes an empty catalogue and a catalogue at the assumed scale', () => {
    expect(assertSearchIndexBudget('[]', 0).ok).toBe(true);

    // The design assumes under ~500 products for this architecture. 400 synthetic documents must
    // fit, otherwise the budget is unreachable in practice and the escape hatch is already needed.
    const docs = Array.from({ length: 400 }, (_unused, index) => syntheticDoc(index));
    const report = assertSearchIndexBudget(serializeSearchIndex(docs), docs.length);
    expect(report.ok).toBe(true);
    expect(report.brotliBytes).toBeLessThanOrEqual(SEARCH_INDEX_BUDGET_BYTES);
  });

  it('fails the build when the index exceeds the budget, naming the size and the escape hatch', () => {
    // Incompressible payloads rather than 5,000 repetitive ones: the point of the test is the
    // gate, and Brotli at quality 11 over a megabyte of near-identical JSON costs seconds for no
    // extra confidence. Real LQIP data URIs are base64-encoded compressed images, so they are
    // genuinely near-incompressible — this is the realistic worst case, not a contrived one.
    const docs = Array.from({ length: 220 }, (_unused, index) => incompressibleDoc(index));
    const serialized = serializeSearchIndex(docs);

    let thrown: unknown = null;
    try {
      assertSearchIndexBudget(serialized, docs.length);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('SEARCH_INDEX_OVER_BUDGET');
    expect(message).toContain('220 products');
    expect(message).toContain(String(SEARCH_INDEX_BUDGET_BYTES));
    // The remedy is named, because the person who hits this is adding a product, not debugging.
    expect(message).toContain('per-category indexes');
  });
});
