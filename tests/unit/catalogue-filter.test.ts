import { describe, expect, it } from 'vitest';

import {
  filterCatalogue,
  filterCategories,
  isCatalogueProduct,
  isPublishedCategory,
} from '@/lib/content/catalogue-filter';
import type { ProductStatusValue } from '@/schemas/product';

import { demoDiningTable, demoDraftChair, demoSofa } from '../fixtures/products';

/**
 * The single public/not-public decision every catalogue surface reads.
 *
 * Requirements: 1.1, 1.16, 2.11, 4.1, 18.8, 26.1.
 */

const ALL_STATUSES: ProductStatusValue[] = [
  'DRAFT',
  'REVIEW',
  'PUBLISHED',
  'UNPUBLISHED',
  'OUT_OF_STOCK',
];

describe('isCatalogueProduct', () => {
  it('includes PUBLISHED and OUT_OF_STOCK', () => {
    expect(isCatalogueProduct({ status: 'PUBLISHED' })).toBe(true);
    expect(isCatalogueProduct({ status: 'OUT_OF_STOCK' })).toBe(true);
  });

  it('excludes DRAFT, REVIEW, and UNPUBLISHED', () => {
    expect(isCatalogueProduct({ status: 'DRAFT' })).toBe(false);
    expect(isCatalogueProduct({ status: 'REVIEW' })).toBe(false);
    expect(isCatalogueProduct({ status: 'UNPUBLISHED' })).toBe(false);
  });

  it('classifies every declared status exactly one way', () => {
    const publicStatuses = ALL_STATUSES.filter((status) => isCatalogueProduct({ status }));
    expect(publicStatuses).toEqual(['PUBLISHED', 'OUT_OF_STOCK']);
  });
});

describe('filterCatalogue', () => {
  it('keeps published fixtures and drops the draft', () => {
    const kept = filterCatalogue([demoSofa, demoDiningTable, demoDraftChair]);
    expect(kept.map((product) => product.slug)).toEqual([demoSofa.slug, demoDiningTable.slug]);
  });

  it('preserves input order', () => {
    const kept = filterCatalogue([demoDiningTable, demoDraftChair, demoSofa]);
    expect(kept.map((product) => product.slug)).toEqual([demoDiningTable.slug, demoSofa.slug]);
  });

  it('returns an empty list for an empty catalogue — the designed empty state', () => {
    expect(filterCatalogue([])).toEqual([]);
  });
});

describe('category filtering', () => {
  const categories = [
    { slug: 'outdoor', name: 'Outdoor', order: 9, published: true },
    { slug: 'sofas', name: 'Sofas & Sectionals', order: 1, published: true },
    { slug: 'hidden', name: 'Hidden', order: 2, published: false },
    { slug: 'beds', name: 'Beds', order: 1, published: true },
  ];

  it('drops unpublished categories', () => {
    expect(isPublishedCategory(categories[2]!)).toBe(false);
    expect(filterCategories(categories).map((c) => c.slug)).not.toContain('hidden');
  });

  it('orders by operator order, breaking ties on slug', () => {
    expect(filterCategories(categories).map((c) => c.slug)).toEqual(['beds', 'sofas', 'outdoor']);
  });

  it('does not mutate its input', () => {
    const input = [...categories];
    filterCategories(input);
    expect(input.map((c) => c.slug)).toEqual(categories.map((c) => c.slug));
  });
});
