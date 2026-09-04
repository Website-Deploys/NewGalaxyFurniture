import { describe, expect, it } from 'vitest';

import {
  applyCategoryPatch,
  assignedProductCount,
  assignedProductsMessage,
  buildNewCategory,
  CategoryCreateInput,
  CategoryPatchInput,
  CategoryReorderInput,
  previewCategorySlug,
  reorderCategories,
  validateCategory,
} from '@/lib/categories/store';
import {
  applyReviewPatch,
  buildNewReview,
  generateReviewId,
  reorderReviews,
  ReviewCreateInput,
  ReviewPatchInput,
  reviewWriteSkipsCi,
  validateReview,
} from '@/lib/reviews/store';
import type { Category } from '@/schemas/category';
import type { ProductSummary } from '@/lib/products/index-store';
import type { Review } from '@/schemas/review';

/**
 * Category and review management.
 *
 * Both are operator-authored content with one honesty rule each that the code has to enforce
 * rather than merely document: a category cannot be deleted out from under the products assigned
 * to it, and nothing about a review is ever generated or pre-filled.
 *
 * Requirements: 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 17.14, 17.16.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function category(overrides: Partial<Category> = {}): Category {
  const base = {
    slug: 'sofas',
    name: 'Sofas',
    shortDescription: '',
    order: 0,
    illustration: 'sofa' as const,
    subcategories: [],
    published: true,
  };
  const parsed = validateCategory({ ...base, ...overrides });
  if (!parsed.ok) throw new Error(`fixture invalid: ${JSON.stringify(parsed.fields)}`);
  return parsed.category;
}

function review(overrides: Partial<Review> = {}): Review {
  const parsed = validateReview({
    id: generateReviewId(),
    customerName: 'Asha Rao',
    rating: 5,
    text: 'The sofa arrived well made and the fabric is exactly as shown.',
    status: 'DRAFT',
    featured: false,
    order: 0,
    ...overrides,
  });
  if (!parsed.ok) throw new Error(`fixture invalid: ${JSON.stringify(parsed.fields)}`);
  return parsed.review;
}

function summary(overrides: Partial<ProductSummary>): ProductSummary {
  return {
    id: 'p_aaaaaaaaaa',
    slug: 'a-sofa',
    sku: 'NGF-SOF-AAAAAA',
    name: 'A Sofa',
    category: 'sofas',
    status: 'DRAFT',
    price: null,
    priceOnEnquiry: true,
    stockStatus: 'IN_STOCK',
    updatedAt: '2026-03-14T09:00:00.000Z',
    ...overrides,
  } as ProductSummary;
}

/* -------------------------------------------------------------------------- */
/* Categories                                                                 */
/* -------------------------------------------------------------------------- */

describe('creating a category', () => {
  it('derives the slug from the name and orders it last', () => {
    const existing = [
      category({ slug: 'sofas', order: 0 }),
      category({ slug: 'beds', name: 'Beds', illustration: 'bed', order: 1 }),
    ];
    const parsed = CategoryCreateInput.safeParse({
      name: 'Accent Chairs',
      illustration: 'accentChair',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const built = buildNewCategory(parsed.data, existing);
    const validated = validateCategory(built);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.category.slug).toBe('accent-chairs');
    expect(validated.category.slug).toBe(previewCategorySlug('Accent Chairs'));
    // A new thing goes after the existing ones.
    expect(validated.category.order).toBe(2);
  });

  it('leaves the description empty rather than writing one', () => {
    const parsed = CategoryCreateInput.safeParse({ name: 'Outdoor', illustration: 'outdoor' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const built = buildNewCategory(parsed.data, []);
    // Requirement 18.9's spirit: a category blurb is operator copy. An invented sentence about
    // furniture would read as the operator's own words.
    expect(built.shortDescription).toBe('');
  });

  it('avoids a slug collision without losing the name’s prefix', () => {
    const existing = [category({ slug: 'sofas' })];
    const parsed = CategoryCreateInput.safeParse({ name: 'Sofas', illustration: 'sofa' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const built = buildNewCategory(parsed.data, existing);
    expect(built.slug).not.toBe('sofas');
    expect(String(built.slug).startsWith('sofas')).toBe(true);
  });

  it('has no field through which a slug or an order could be supplied', () => {
    // The slug is the public URL, so it is set once from the name and is never patchable —
    // there is no rename-with-redirect path for a category.
    expect(
      CategoryCreateInput.safeParse({ name: 'X', illustration: 'sofa', slug: 'chosen' }).success,
    ).toBe(false);
    expect(
      CategoryCreateInput.safeParse({ name: 'X', illustration: 'sofa', order: 0 }).success,
    ).toBe(false);
    expect(CategoryPatchInput.safeParse({ patch: { slug: 'renamed' } }).success).toBe(false);
    expect(CategoryPatchInput.safeParse({ patch: { order: 3 } }).success).toBe(false);
  });
});

describe('editing a category', () => {
  it('clears an optional SEO field with null, and leaves the slug alone', () => {
    const current = category({ seoTitle: 'Sofas in Bengaluru' });
    const patched = applyCategoryPatch(current, { seoTitle: null, published: false });
    const validated = validateCategory(patched);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.category.seoTitle).toBeUndefined();
    expect(validated.category.published).toBe(false);
    expect(validated.category.slug).toBe(current.slug);
  });
});

describe('reordering categories', () => {
  it('renumbers contiguously from zero so no two claim a position', () => {
    const existing = [
      category({ slug: 'sofas', order: 0 }),
      category({ slug: 'beds', name: 'Beds', illustration: 'bed', order: 5 }),
      category({ slug: 'outdoor', name: 'Outdoor', illustration: 'outdoor', order: 9 }),
    ];
    const assignments = reorderCategories(existing, ['outdoor', 'sofas', 'beds']);
    expect(assignments).toEqual([
      { slug: 'outdoor', order: 0 },
      { slug: 'sofas', order: 1 },
      { slug: 'beds', order: 2 },
    ]);
  });

  it('keeps a category a stale client omitted, rather than dropping it', () => {
    const existing = [
      category({ slug: 'sofas', order: 0 }),
      category({ slug: 'beds', name: 'Beds', illustration: 'bed', order: 1 }),
    ];
    // Another tab created `beds` after this client loaded. Omitting it must not delete it from
    // the ordering.
    const assignments = reorderCategories(existing, ['sofas']);
    expect(assignments.map((entry) => entry.slug)).toEqual(['sofas', 'beds']);
  });

  it('ignores an unknown slug', () => {
    const assignments = reorderCategories([category({ slug: 'sofas' })], ['ghost', 'sofas']);
    expect(assignments).toEqual([{ slug: 'sofas', order: 0 }]);
    expect(CategoryReorderInput.safeParse({ order: [] }).success).toBe(false);
  });
});

describe('deleting a category with products assigned', () => {
  it('counts products in every status, not only the published ones', () => {
    const summaries = [
      summary({ id: 'p_1', category: 'sofas', status: 'DRAFT' }),
      summary({ id: 'p_2', category: 'sofas', status: 'PUBLISHED' }),
      summary({ id: 'p_3', category: 'sofas', status: 'OUT_OF_STOCK' }),
      summary({ id: 'p_4', category: 'beds', status: 'PUBLISHED' }),
    ];
    const counted = assignedProductCount(summaries, 'sofas');
    // A draft assigned to a deleted category fails `validate:content` at the next build, so it
    // has to block the deletion too (Requirement 18.5).
    expect(counted).toEqual({ total: 3, published: 2 });
    expect(assignedProductCount(summaries, 'outdoor')).toEqual({ total: 0, published: 0 });
  });

  it('reports the number in the refusal message, and says what to do', () => {
    const message = assignedProductsMessage({ total: 3, published: 2 });
    expect(message).toContain('3');
    expect(message).toContain('cannot be deleted');
    expect(message).toContain('2 of them are live');
    expect(message).toContain('Move them to another category first');

    // Singular reads correctly too — a message that says "1 products is" undermines the rest.
    const one = assignedProductsMessage({ total: 1, published: 1 });
    expect(one).toContain('1 product is');
    expect(one).toContain('1 of them is');
  });
});

/* -------------------------------------------------------------------------- */
/* Reviews                                                                    */
/* -------------------------------------------------------------------------- */

describe('creating a review', () => {
  it('requires the customer’s own name, rating and words — none has a default', () => {
    // Requirement 18.9: nothing about a review is generated or pre-filled. The schema having no
    // default is what makes that true; an omitted field is a validation error, not a guess.
    for (const partial of [
      { rating: 5, text: 'Well made and delivered as described.' },
      { customerName: 'Asha Rao', text: 'Well made and delivered as described.' },
      { customerName: 'Asha Rao', rating: 5 },
      {},
    ]) {
      expect(ReviewCreateInput.safeParse(partial).success).toBe(false);
    }
  });

  it('creates as DRAFT, with no way to ask for anything else', () => {
    const parsed = ReviewCreateInput.safeParse({
      customerName: 'Asha Rao',
      rating: 4,
      text: 'Solid frame, and the fabric matches the photographs.',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const built = buildNewReview(parsed.data, []);
    expect(built.status).toBe('DRAFT');
    expect(built.featured).toBe(false);
    expect(built.order).toBe(0);
    // No date is invented: a review with no supplied date has no date at all.
    expect('date' in built).toBe(false);

    // And `status` cannot be sent, so publication stays an explicit later act.
    expect(
      ReviewCreateInput.safeParse({
        customerName: 'A',
        rating: 5,
        text: 'Good enough words.',
        status: 'PUBLISHED',
      }).success,
    ).toBe(false);
  });

  it('bounds the rating to 1–5 integers', () => {
    for (const rating of [0, 6, 4.5, -1]) {
      expect(
        ReviewCreateInput.safeParse({ customerName: 'A', rating, text: 'Some real words.' })
          .success,
        `accepted ${String(rating)}`,
      ).toBe(false);
    }
    for (const rating of [1, 2, 3, 4, 5]) {
      expect(
        ReviewCreateInput.safeParse({ customerName: 'A', rating, text: 'Some real words.' })
          .success,
      ).toBe(true);
    }
  });

  it('generates an id the path allowlist admits', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(generateReviewId()).toMatch(/^rev_[a-z0-9]{10}$/);
    }
  });
});

describe('publishing and editing a review', () => {
  it('moves status only through an explicit status field', () => {
    const current = review();
    const published = applyReviewPatch(current, { text: 'Edited words that are long enough.' });
    // An edit alone does not publish.
    expect(published.status).toBe('DRAFT');

    const parsed = ReviewPatchInput.safeParse({ patch: {}, status: 'PUBLISHED' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const explicit = applyReviewPatch(current, parsed.data.patch, parsed.data.status);
    expect(explicit.status).toBe('PUBLISHED');
  });

  it('rejects an unrecognised patch key rather than dropping it', () => {
    expect(ReviewPatchInput.safeParse({ patch: { order: 2 } }).success).toBe(false);
    expect(ReviewPatchInput.safeParse({ patch: { id: 'rev_aaaaaaaaaa' } }).success).toBe(false);
  });

  it('clears an optional media key with null', () => {
    const current = review({ customerPhotoKey: 'reviews/x.jpg' });
    const patched = applyReviewPatch(current, { customerPhotoKey: null });
    expect('customerPhotoKey' in patched).toBe(false);
  });
});

describe('the build decision for a review write', () => {
  it('skips CI only when the review is invisible before and after', () => {
    // Requirement 17.14: a draft-to-draft save changes nothing a visitor sees.
    expect(reviewWriteSkipsCi('DRAFT', 'DRAFT')).toBe(true);
    expect(reviewWriteSkipsCi(null, 'DRAFT')).toBe(true);
    expect(reviewWriteSkipsCi('UNPUBLISHED', 'DRAFT')).toBe(true);

    // Anything touching a published review rebuilds — including unpublishing one, which has to
    // actually disappear from the site.
    expect(reviewWriteSkipsCi('DRAFT', 'PUBLISHED')).toBe(false);
    expect(reviewWriteSkipsCi('PUBLISHED', 'PUBLISHED')).toBe(false);
    expect(reviewWriteSkipsCi('PUBLISHED', 'UNPUBLISHED')).toBe(false);
  });
});

describe('reordering reviews', () => {
  it('renumbers contiguously and keeps omitted reviews', () => {
    const a = review({ order: 0 });
    const b = review({ order: 4 });
    const assignments = reorderReviews([a, b], [b.id]);
    expect(assignments).toEqual([
      { id: b.id, order: 0 },
      { id: a.id, order: 1 },
    ]);
  });
});
