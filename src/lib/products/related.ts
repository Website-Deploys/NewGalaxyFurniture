/**
 * Related products: deterministic selection, never random, never time-varying.
 *
 * Requirement 4.7 is unusually explicit about *why* this has to be a pure function of the
 * catalogue: "repeated renders of the same catalogue present the same related products in the
 * same order and no selection or ordering is random or time-varying". So there is no
 * `Math.random`, no `Date.now`, no dependence on array identity or insertion order beyond what
 * is stated below, and every comparison rung ends in a total tie-break on slug.
 *
 * The selection has two stages, and the order between them matters:
 *
 * 1. **Operator-specified products first, in the operator's own order.** These are an override,
 *    not a hint. They are not scored and they are not re-sorted — an operator who lists three
 *    products expects those three, in that sequence, at the front. They are still subject to the
 *    structural rules: the target is excluded, duplicates collapse, and only Catalogue documents
 *    are eligible.
 * 2. **Everything else, scored.** Same subcategory `+5`, same category `+4`, each shared tag
 *    `+2` capped at `+6`, same material `+2`, price within ±35% `+2`, at least one shared colour
 *    `+1`. A candidate scoring `0` is **excluded**, which is the whole point of Requirement 4.9:
 *    an empty related section is a correct outcome and is preferable to a rail of unrelated
 *    furniture.
 *
 * Ordering of the scored remainder is score descending, then price proximity ascending, then
 * slug ascending — which is Requirement 4.7's "count of shared attributes, then price proximity,
 * breaking ties on slug" with the design's weights supplying the count.
 *
 * **Two notes on the shapes involved.**
 *
 * `SearchDoc` carries no product status, so "restricted to Catalogue products" (Requirement 4.8)
 * is satisfied by construction rather than by a filter here: every caller builds `all` from
 * `getCatalogue()`, which is the single place the Draft/UNPUBLISHED exclusion lives. Re-deriving
 * it from a document that does not carry the fact would be a second, weaker copy of that rule.
 *
 * `SearchDoc` also carries no `relatedProductIds` — deliberately, because twelve slugs per
 * product would be paid for by every visitor who fetches the client index, and related products
 * are resolved at build time on the server. The operator's list is therefore passed alongside the
 * target as `RelatedTarget.r`, resolved from the product records by `manualRelatedSlugs`.
 *
 * Design: Catalogue → Product cards, PDP, and related products.
 * Requirements: 4.7, 4.8, 4.9.
 */

import type { SearchDoc } from '@/lib/search/types';
import type { Product } from '@/schemas/product';

/** The scoring weights, as data — so the tests and the docs read the same numbers. */
export const RELATED_WEIGHTS = {
  subcategory: 5,
  category: 4,
  /** Per shared tag… */
  tag: 2,
  /** …up to this ceiling. */
  tagCap: 6,
  material: 2,
  priceProximity: 2,
  colour: 1,
} as const;

/** The band the `priceProximity` weight is paid for: ±35% of the target's price. */
export const PRICE_PROXIMITY_RATIO = 0.35;

/** The largest score any candidate can reach. Useful in tests as an upper bound. */
export const MAX_RELATED_SCORE =
  RELATED_WEIGHTS.subcategory +
  RELATED_WEIGHTS.category +
  RELATED_WEIGHTS.tagCap +
  RELATED_WEIGHTS.material +
  RELATED_WEIGHTS.priceProximity +
  RELATED_WEIGHTS.colour;

export const RELATED_LIMIT = 8;

/**
 * A target document plus the operator's own list of related product slugs.
 *
 * `r` is optional and empty by default, which is the common case: most products let the site
 * choose, exactly as the admin form's hint says.
 */
export interface RelatedTarget extends SearchDoc {
  r?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Folding                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Attribute comparison key.
 *
 * The same fold `src/lib/search/filter.ts` uses for facets, and for the same reason: an operator
 * who typed `Sheesham Wood` on one product and `sheesham wood` on another meant one material,
 * and a related-products engine that disagreed with the material *filter* about that would be
 * incoherent. Accents are stripped so `Café Noir` and `Cafe Noir` are one colour.
 */
function fold(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function foldedSet(values: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    const key = fold(value);
    if (key !== '') out.add(key);
  }
  return out;
}

/** Two optional strings naming the same thing. `undefined` never matches anything. */
function sameOptional(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const left = fold(a);
  return left !== '' && left === fold(b);
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Relative price distance, or `Infinity` when either side has no price.
 *
 * `Infinity` rather than `0` so a price-on-enquiry candidate tails the proximity rung instead of
 * leading it — the same discipline `src/lib/search/sort.ts` applies to the price sorts, so the
 * two never disagree about where an unpriced product belongs.
 */
export function priceDistance(target: number | null, candidate: number | null): number {
  if (target === null || candidate === null || target <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(candidate - target) / target;
}

export function withinPriceProximity(target: number | null, candidate: number | null): boolean {
  return priceDistance(target, candidate) <= PRICE_PROXIMITY_RATIO;
}

/**
 * How much this candidate has in common with the target. `0` means "nothing", which means
 * "excluded" (Requirement 4.9).
 *
 * Exported because the property tests assert the relevance claim against the same arithmetic the
 * selection uses, rather than against a re-implementation of it that could drift.
 */
export function relatedScore(target: SearchDoc, candidate: SearchDoc): number {
  let score = 0;

  if (sameOptional(target.s, candidate.s)) score += RELATED_WEIGHTS.subcategory;
  if (sameOptional(target.c, candidate.c)) score += RELATED_WEIGHTS.category;

  const targetTags = foldedSet(target.t);
  let sharedTags = 0;
  for (const tag of foldedSet(candidate.t)) if (targetTags.has(tag)) sharedTags += 1;
  score += Math.min(sharedTags * RELATED_WEIGHTS.tag, RELATED_WEIGHTS.tagCap);

  if (sameOptional(target.m, candidate.m)) score += RELATED_WEIGHTS.material;
  if (withinPriceProximity(target.p, candidate.p)) score += RELATED_WEIGHTS.priceProximity;

  const targetColours = foldedSet(target.o);
  for (const colour of foldedSet(candidate.o)) {
    if (targetColours.has(colour)) {
      // Flat, not per colour: the design lists "shared colour +1" against "shared tag +2 each".
      score += RELATED_WEIGHTS.colour;
      break;
    }
  }

  return score;
}

/**
 * Whether the candidate shares any attribute the engine recognises.
 *
 * This is exactly `relatedScore(...) > 0`, and it is stated as its own predicate because
 * Requirement 4.9 is phrased in terms of sharing rather than scoring, and the PDP's
 * omit-the-section decision reads better against the requirement's own words.
 */
export function sharesAnyAttribute(target: SearchDoc, candidate: SearchDoc): boolean {
  return relatedScore(target, candidate) > 0;
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

/** Ascending slug — the universal tie-break, so the order is total. */
function bySlug(a: SearchDoc, b: SearchDoc): number {
  return a.i < b.i ? -1 : a.i > b.i ? 1 : 0;
}

/**
 * The related products for `target`, at most `limit`, deterministic.
 *
 * Never contains `target`, never contains a duplicate slug, and every member is either
 * operator-specified or shares at least one attribute with the target.
 */
export function relatedProducts(
  target: RelatedTarget,
  all: readonly SearchDoc[],
  limit: number = RELATED_LIMIT,
): SearchDoc[] {
  if (limit <= 0) return [];

  // De-duplicate the candidate pool on slug before anything else, so a catalogue that somehow
  // carries the same slug twice cannot produce the same card twice.
  const bySlugKey = new Map<string, SearchDoc>();
  for (const doc of all) {
    if (doc.i === target.i) continue;
    if (!bySlugKey.has(doc.i)) bySlugKey.set(doc.i, doc);
  }

  const picked: SearchDoc[] = [];
  const taken = new Set<string>();

  // Stage 1 — the operator's own list, in the operator's own order.
  for (const slug of target.r ?? []) {
    if (picked.length >= limit) break;
    const doc = bySlugKey.get(slug);
    if (doc === undefined || taken.has(slug)) continue;
    taken.add(slug);
    picked.push(doc);
  }

  if (picked.length >= limit) return picked;

  // Stage 2 — scored, zero-scoring candidates excluded.
  const scored: { doc: SearchDoc; score: number; distance: number }[] = [];
  for (const doc of bySlugKey.values()) {
    if (taken.has(doc.i)) continue;
    const score = relatedScore(target, doc);
    if (score === 0) continue;
    scored.push({ doc, score, distance: priceDistance(target.p, doc.p) });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      // `Infinity - Infinity` is NaN, which would corrupt the comparator, so the two unpriced
      // cases are compared as equal explicitly and fall through to the slug tie-break.
      (a.distance === b.distance ? 0 : a.distance < b.distance ? -1 : 1) ||
      bySlug(a.doc, b.doc),
  );

  for (const entry of scored) {
    if (picked.length >= limit) break;
    picked.push(entry.doc);
  }

  return picked;
}

/* -------------------------------------------------------------------------- */
/* Resolving the operator's list                                              */
/* -------------------------------------------------------------------------- */

/**
 * Resolve `product.relatedProductIds` to Catalogue slugs, preserving the operator's order.
 *
 * The stored strings are free-form "product identifiers" (that is what the admin field calls
 * them), so both spellings an operator can plausibly paste are accepted: the product `id`
 * (`p_xxxxxxxxxx`) and the `slug`. An entry that resolves to nothing — a deleted product, a
 * typo, a product that has since been unpublished — is **dropped silently**, because the
 * alternative is either a broken card or a build failure over a merchandising nicety.
 * A self-reference is dropped too; Requirement 4.8 excludes the target unconditionally.
 */
export function manualRelatedSlugs(product: Product, catalogue: readonly Product[]): string[] {
  const byId = new Map<string, Product>();
  const bySlugKey = new Map<string, Product>();
  for (const candidate of catalogue) {
    byId.set(candidate.id, candidate);
    bySlugKey.set(fold(candidate.slug), candidate);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of product.relatedProductIds) {
    const key = raw.trim();
    if (key === '') continue;
    const match = byId.get(key) ?? bySlugKey.get(fold(key));
    if (match === undefined || match.slug === product.slug || seen.has(match.slug)) continue;
    seen.add(match.slug);
    out.push(match.slug);
  }
  return out;
}
