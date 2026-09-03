/**
 * The one place public surfaces read reviews from, and the aggregate-rating rule.
 *
 * Two requirements meet here and both are refusals:
 *
 * - **Nothing unpublished is ever public** (Requirement 18.8). `getPublishedReviews()` is
 *   the only reader a public surface calls, exactly as `getCatalogue()` is for products, so
 *   the filter exists once rather than at each call site.
 * - **`aggregateRating` is withheld by default** (Requirement 18.10). Structured data
 *   claiming a rating is a claim to Google and to every visitor who sees stars in a search
 *   result. It is emitted only when published reviews are linked to *that specific product*
 *   — not site-wide reviews, not reviews of other products, and not a rating averaged over
 *   an empty set. `aggregateRatingFor` returns `null` in every other case, and `null` means
 *   the property is omitted from the JSON-LD rather than emitted as zero.
 *
 * Design: Data Models → Other collections; SEO and Structured Data.
 * Requirements: 18.8, 18.10.
 */

import { getCollection } from 'astro:content';

import { safeText } from '@/lib/security/sanitize';
import type { Review } from '@/schemas/review';

/**
 * A review's two free-text fields, sanitized (Requirement 25.2, Property 55).
 *
 * Applied in the reader rather than in each template, because there are three consumers — the
 * homepage section, `/reviews`, and the admin's published preview — and a fourth would be one more
 * place to remember. Review text is the most exposed operator-entered field on the site: it is long,
 * it is transcribed from a customer's message, and it is rendered inside a `blockquote` where markup
 * would be least noticed. `safeText` is the identity on prose and keeps paragraph breaks, so the
 * "published with their words unchanged" promise on `/reviews` still holds.
 */
function sanitizeReview(review: Review): Review {
  return { ...review, customerName: safeText(review.customerName), text: safeText(review.text) };
}

/** Published only, sanitized, in operator order, featured first. */
export function filterPublishedReviews(reviews: readonly Review[]): Review[] {
  return reviews
    .filter((review) => review.status === 'PUBLISHED')
    .map(sanitizeReview)
    .sort(
      (a, b) =>
        Number(b.featured) - Number(a.featured) || a.order - b.order || a.id.localeCompare(b.id),
    );
}

export async function getPublishedReviews(): Promise<Review[]> {
  const entries = await getCollection('reviews');
  return filterPublishedReviews(entries.map((entry) => entry.data));
}

/** Published reviews linked to one product. */
export function reviewsForProduct(reviews: readonly Review[], productId: string): Review[] {
  return filterPublishedReviews(reviews).filter((review) => review.productId === productId);
}

export interface AggregateRating {
  ratingValue: number;
  reviewCount: number;
  bestRating: 5;
  worstRating: 1;
}

/**
 * The `aggregateRating` for a product, or `null`.
 *
 * `null` is the default and the common case: with no published review linked to the
 * product there is no rating to report, and reporting one anyway is the fabrication
 * Requirement 18.10 forbids. The average is rounded to one decimal place — the precision
 * the underlying integer ratings can actually support.
 */
export function aggregateRatingFor(
  reviews: readonly Review[],
  productId: string,
): AggregateRating | null {
  const linked = reviewsForProduct(reviews, productId);
  if (linked.length === 0) return null;
  const total = linked.reduce((sum, review) => sum + review.rating, 0);
  return {
    ratingValue: Math.round((total / linked.length) * 10) / 10,
    reviewCount: linked.length,
    bestRating: 5,
    worstRating: 1,
  };
}
