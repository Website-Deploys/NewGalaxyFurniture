import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_STYLE_TAGS,
  applyFactGuard,
  FACTUAL_FIELDS,
  FIELD_LIMITS,
  LIST_LIMITS,
  type AdminFacts,
  type FactualField,
  type ProductDraftSuggestion,
  type RawSuggestion,
} from '@/lib/ai/fact-guard';
import { assertProperty } from './config';
import { BANNED_CLAIM_PATTERNS, containsBannedClaim } from '@/lib/ai/banned-claims';
import { CATEGORY_SLUGS } from './arbitraries';

/**
 * Properties 47–50 — the AI guardrails.
 *
 * These four are the most load-bearing properties in the suite, because they are the only thing
 * standing between a language model and the operator's published claims about their business.
 * Every other guarantee in the AI flow is a prompt, and a prompt is a request.
 *
 * The arbitraries below are deliberately adversarial rather than representative. A generator that
 * produced plausible furniture copy would mostly exercise the happy path; these produce
 * suggestions that contradict every supplied fact, splice banned claims into random offsets,
 * overrun every length bound, and smuggle `status: 'PUBLISHED'` into the JSON — because those are
 * the cases the guard exists for.
 *
 * Design: Correctness Properties → Properties 47–50; AI Product Assistant → Hallucination
 * guardrails.
 */

/* -------------------------------------------------------------------------- */
/* Arbitraries                                                                */
/* -------------------------------------------------------------------------- */

/** Sentences that assert a banned claim, one per family in the maintained list. */
const BANNED_CLAIM_SAMPLES: readonly string[] = [
  'We have been making furniture since 1998.',
  'New Galaxy Furniture has over 25 years of experience in the trade.',
  'Our workshop is ISO 9001 certified.',
  'This piece comes from a certified manufacturer.',
  'We are an award-winning furniture maker.',
  'Winner of the South India Furniture Award.',
  'Over 10,000 happy customers have bought from us.',
  'Thousands of families trust our furniture.',
  'Our team of 120 craftsmen builds each piece.',
  'Visit any of our 8 showrooms across Karnataka.',
  'Delivered within 7 days anywhere in Bangalore.',
  'Same-day delivery is guaranteed on this item.',
  'Backed by a 10-year warranty.',
  'This sofa carries a lifetime guarantee.',
  'We are the best furniture shop in Bangalore.',
  'Rated the number 1 furniture brand in India.',
  'India’s finest furniture manufacturer.',
];

/** Filler prose with no banned claim in it, so a removal is attributable. */
const CLEAN_SENTENCES: readonly string[] = [
  'The frame is joined at the corners and the arms are gently rolled.',
  'A three-seater proportioned for a compact living room.',
  'The cushions are removable for cleaning.',
  'Soft edges throughout, with a low back and a deep seat.',
  'Suits a room where the seating faces a window.',
];

const cleanProseArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...CLEAN_SENTENCES), { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join(' '));

/** Clean prose with a banned claim spliced in at a random sentence boundary. */
const proseWithBannedClaimArb: fc.Arbitrary<{ text: string; claim: string }> = fc
  .tuple(
    fc.array(fc.constantFrom(...CLEAN_SENTENCES), { minLength: 0, maxLength: 3 }),
    fc.constantFrom(...BANNED_CLAIM_SAMPLES),
    fc.array(fc.constantFrom(...CLEAN_SENTENCES), { minLength: 0, maxLength: 3 }),
  )
  .map(([before, claim, after]) => ({
    text: [...before, claim, ...after].join(' '),
    claim,
  }));

/**
 * A raw suggestion, as a model might emit one.
 *
 * `overlong` inflates every string past its bound; `smuggled` adds the keys the guard must never
 * pass through. Both are switched on by the property that needs them rather than always, so a
 * failure is attributable to one behaviour.
 */
interface RawSuggestionOptions {
  overlong?: boolean;
  smuggled?: boolean;
}

function rawSuggestionArb(options: RawSuggestionOptions = {}): fc.Arbitrary<RawSuggestion> {
  const text = (base: fc.Arbitrary<string>): fc.Arbitrary<string> =>
    options.overlong === true
      ? base.map((value) => `${value} ${'lorem ipsum dolor sit amet '.repeat(400)}`)
      : base;

  return fc
    .record({
      name: text(fc.string({ minLength: 1, maxLength: 200 })),
      shortDescription: text(cleanProseArb),
      description: text(cleanProseArb),
      category: fc.oneof(
        fc.constantFrom(...CATEGORY_SLUGS),
        // Invented categories: the case Requirement 16.9 is about.
        fc.constantFrom('recliners', 'wardrobes', 'garden-swings', 'not a slug at all', ''),
      ),
      subcategory: text(fc.string({ maxLength: 100 })),
      material: fc.constantFrom('Sheesham Wood', 'Teak', 'Solid Oak', 'Engineered Wood', ''),
      color: fc.constantFrom('Beige', 'Charcoal', 'Walnut Brown', ''),
      styleTags: fc.array(
        fc.oneof(
          fc.constantFrom(...ALLOWED_STYLE_TAGS),
          fc.constantFrom('bestselling', 'award-winning', 'iso-certified', 'ultra-premium'),
        ),
        { maxLength: 40 },
      ),
      features: fc.array(text(fc.constantFrom(...CLEAN_SENTENCES)), { maxLength: 30 }),
      seoTitle: text(fc.string({ maxLength: 120 })),
      seoDescription: text(cleanProseArb),
      keywords: fc.array(
        fc.oneof(fc.constantFrom(...ALLOWED_STYLE_TAGS), fc.string({ maxLength: 40 })),
        { maxLength: 40 },
      ),
      imageAltText: fc.array(
        fc.record({
          imageId: fc.constantFrom('img_aaaaaaaaaa', 'img_bbbbbbbbbb', 'img_cccccccccc'),
          alt: text(fc.string({ maxLength: 220 })),
        }),
        { maxLength: 6 },
      ),
      whatsappText: text(cleanProseArb),
    })
    .map((suggestion): RawSuggestion => {
      const raw: RawSuggestion = { ...suggestion };
      if (options.smuggled === true) {
        raw.status = 'PUBLISHED';
        raw.published = true;
        raw.price = 42_000;
        raw.sku = 'NGF-SOF-FAKE01';
        raw.slug = 'injected-slug';
        raw.id = 'p_injected01';
        raw.aiAssisted = false;
      }
      return raw;
    });
}

/** Every factual field, with a value of the right shape. */
const FACT_VALUES: Record<FactualField, unknown> = {
  price: 42_000,
  originalPrice: 55_000,
  dimensions: { display: '7 ft × 3 ft × 2.5 ft', lengthCm: 213 },
  size: '3 Seater',
  material: 'Mango Wood',
  color: 'Beige',
  availableColors: ['Beige', 'Grey', 'Brown'],
  stockStatus: 'IN_STOCK',
  madeToOrder: false,
  deliveryInformation: 'Delivery is arranged after the order is confirmed.',
  customization: 'Fabric and size can be changed.',
};

/**
 * A `Partial<AdminFacts>` produced by dropping a random subset of the factual keys — the design's
 * stated strategy for Properties 47 and 48.
 */
const factsArb: fc.Arbitrary<{ facts: AdminFacts; supplied: Set<FactualField> }> = fc
  .subarray([...FACTUAL_FIELDS], { minLength: 0, maxLength: FACTUAL_FIELDS.length })
  .map((supplied) => {
    const facts: Record<string, unknown> = {};
    for (const field of supplied) facts[field] = FACT_VALUES[field];
    return { facts, supplied: new Set(supplied) };
  });

/** The guarded value for a factual field, where the suggestion carries one. */
function guardedFactual(
  guarded: ProductDraftSuggestion,
  field: FactualField,
): string | null | undefined {
  if (field === 'material') return guarded.material.value;
  if (field === 'color') return guarded.color.value;
  return undefined;
}

/** Fields the suggestion type carries at all. The other nine have no slot to leak through. */
const CARRIED_FACTUAL_FIELDS: readonly FactualField[] = ['material', 'color'];

/* -------------------------------------------------------------------------- */
/* Property 47                                                                */
/* -------------------------------------------------------------------------- */

describe('Property 47: Unsupplied factual fields are blanked with a warning', () => {
  /**
   * **Validates: Requirements 15.15, 16.2, 16.5, 16.7, 16.9**
   */
  it('blanks every factual field absent from the facts, and records a warning naming it', () => {
    assertProperty(
      fc.property(rawSuggestionArb(), factsArb, (raw, { facts, supplied }) => {
        const { guarded, warnings } = applyFactGuard(raw, facts, {
          categorySlugs: CATEGORY_SLUGS,
        });

        for (const field of FACTUAL_FIELDS) {
          if (supplied.has(field)) continue;

          // Every unsupplied factual field is reported. The warning names the field, so the
          // operator can act on it rather than merely being told "something was dropped".
          const reported = warnings.some((warning) =>
            warning.toLowerCase().includes(labelOf(field)),
          );
          expect(reported, `no warning for unsupplied ${field}`).toBe(true);

          // And where the suggestion type has a slot for it, that slot is blank.
          if (CARRIED_FACTUAL_FIELDS.includes(field)) {
            expect(guardedFactual(guarded, field), `${field} was not blanked`).toBeNull();
          }
        }

        // The nine factual fields with no slot on the suggestion cannot be present at all —
        // this is the structural half of the guarantee.
        const escaped = guarded as unknown as Record<string, unknown>;
        for (const field of FACTUAL_FIELDS) {
          if (CARRIED_FACTUAL_FIELDS.includes(field)) continue;
          expect(field in escaped, `${field} leaked onto the suggestion`).toBe(false);
        }
      }),
    );
  });

  it('reports an invented category as unassigned', () => {
    assertProperty(
      fc.property(rawSuggestionArb(), (raw) => {
        const { guarded, warnings } = applyFactGuard(raw, {}, { categorySlugs: CATEGORY_SLUGS });
        const value = guarded.category.value;
        if (value !== null) {
          // A non-null category is always one that exists.
          expect(CATEGORY_SLUGS).toContain(value);
        } else {
          expect(warnings.some((warning) => warning.startsWith('Category:'))).toBe(true);
        }
      }),
    );
  });
});

/** The lowercased label a warning uses for a factual field. */
function labelOf(field: FactualField): string {
  switch (field) {
    case 'color':
      return 'colour';
    case 'availableColors':
      return 'available colours';
    case 'originalPrice':
      return 'original price';
    case 'stockStatus':
      return 'stock status';
    case 'madeToOrder':
      return 'made to order';
    case 'deliveryInformation':
      return 'delivery information';
    case 'customization':
      return 'customisation';
    default:
      return field;
  }
}

/* -------------------------------------------------------------------------- */
/* Property 48                                                                */
/* -------------------------------------------------------------------------- */

describe('Property 48: Admin facts always win', () => {
  /**
   * **Validates: Requirements 16.4, 16.6, 16.7**
   *
   * The suggestion is made to *contradict* every supplied fact, which is the only version of this
   * property worth asserting: a guard that preferred the admin value only when the two already
   * agreed would pass a weaker test and be useless.
   */
  it('returns the admin value exactly for every supplied factual field', () => {
    assertProperty(
      fc.property(
        rawSuggestionArb(),
        factsArb,
        fc.constantFrom('Reclaimed Pine', 'Powder-Coated Steel', 'Rattan'),
        fc.constantFrom('Mustard', 'Slate Blue', 'Off-White'),
        (raw, { facts, supplied }, contradictingMaterial, contradictingColor) => {
          // Force the disagreement rather than hoping the generator produced one.
          const contradicting: RawSuggestion = {
            ...raw,
            material: contradictingMaterial,
            color: contradictingColor,
          };

          const { guarded, warnings } = applyFactGuard(contradicting, facts, {
            categorySlugs: CATEGORY_SLUGS,
          });

          for (const field of CARRIED_FACTUAL_FIELDS) {
            const value = guardedFactual(guarded, field);
            if (supplied.has(field)) {
              expect(value).toBe(FACT_VALUES[field]);
              // Provenance says so too: the operator must see that this is their value.
              const entry = field === 'material' ? guarded.material : guarded.color;
              expect(entry.source).toBe('admin');
              // And the override is reported, since a silent correction teaches nothing.
              expect(
                warnings.some(
                  (warning) =>
                    warning.toLowerCase().includes(labelOf(field)) &&
                    warning.includes('replaced with your value'),
                ),
                `override of ${field} was not reported`,
              ).toBe(true);
            } else {
              expect(value).toBeNull();
            }
          }
        },
      ),
    );
  });

  it('prefers a supplied name over a generated one', () => {
    assertProperty(
      fc.property(rawSuggestionArb(), fc.string({ minLength: 2, maxLength: 60 }), (raw, name) => {
        const trimmed = name.trim();
        fc.pre(trimmed !== '');
        const { guarded } = applyFactGuard(
          raw,
          { name: trimmed },
          {
            categorySlugs: CATEGORY_SLUGS,
          },
        );
        expect(guarded.name.source).toBe('admin');
      }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Property 49                                                                */
/* -------------------------------------------------------------------------- */

describe('Property 49: Banned claims are scrubbed from free text', () => {
  /**
   * **Validates: Requirements 7.10, 8.4, 16.8, 18.9, 19.6, 20.9, 23.10, 23.18**
   */
  it('removes the claim from every free-text field and reports each removal', () => {
    assertProperty(
      fc.property(
        proseWithBannedClaimArb,
        fc.constantFrom(
          'description' as const,
          'shortDescription' as const,
          'seoDescription' as const,
          'whatsappText' as const,
        ),
        ({ text, claim }, field) => {
          const raw: RawSuggestion = { [field]: text, name: 'A sofa' };
          const { guarded, warnings } = applyFactGuard(
            raw,
            {},
            {
              categorySlugs: CATEGORY_SLUGS,
            },
          );

          const value = guarded[field].value;
          // The sentence carrying the claim is gone.
          expect(value).not.toContain(claim);
          // And no banned pattern matches what survived — the stronger statement, since it
          // also catches a claim the splice happened to duplicate.
          expect(containsBannedClaim(value)).toBe(false);
          // The removal is reported. Not reporting it would leave the operator believing the
          // assistant wrote something it did not.
          expect(warnings.some((warning) => warning.includes('Removed'))).toBe(true);
        },
      ),
    );
  });

  it('holds for every family in the maintained pattern list', () => {
    // Exhaustive rather than sampled: each family is a distinct legal exposure, so "most of
    // them work" is not an acceptable result.
    for (const sample of BANNED_CLAIM_SAMPLES) {
      const raw: RawSuggestion = {
        description: `A three-seater sofa. ${sample} The cushions are removable.`,
        name: 'A sofa',
      };
      const { guarded } = applyFactGuard(raw, {}, { categorySlugs: CATEGORY_SLUGS });
      expect(guarded.description.value, `not scrubbed: ${sample}`).not.toContain(sample);
      expect(containsBannedClaim(guarded.description.value)).toBe(false);
    }
    // And every declared pattern has at least one sample exercising it, so the list above
    // cannot silently fall behind the list it is testing.
    for (const pattern of BANNED_CLAIM_PATTERNS) {
      expect(
        BANNED_CLAIM_SAMPLES.some((sample) => pattern.pattern.test(sample)),
        `no sample exercises the "${pattern.id}" pattern`,
      ).toBe(true);
    }
  });

  it('removes a price the admin did not supply, and keeps one they did', () => {
    assertProperty(
      fc.property(fc.integer({ min: 1_000, max: 900_000 }), (price) => {
        const supplied = `Priced at ₹${price.toLocaleString('en-IN')} for the three-seater.`;
        const invented = `Priced at ₹${(price + 7_777).toLocaleString('en-IN')} for the three-seater.`;

        const withSupplied = applyFactGuard(
          { description: `A sofa. ${supplied}`, name: 'A sofa' },
          { price },
          { categorySlugs: CATEGORY_SLUGS },
        );
        expect(withSupplied.guarded.description.value).toContain('Priced at');

        const withInvented = applyFactGuard(
          { description: `A sofa. ${invented}`, name: 'A sofa' },
          { price },
          { categorySlugs: CATEGORY_SLUGS },
        );
        expect(withInvented.guarded.description.value).not.toContain('Priced at');
        expect(
          withInvented.warnings.some((warning) => warning.includes('price you did not supply')),
        ).toBe(true);
      }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Property 50                                                                */
/* -------------------------------------------------------------------------- */

describe('Property 50: The guard can never publish or exceed schema bounds', () => {
  /**
   * **Validates: Requirements 14.10, 14.11, 16.10, 16.11**
   */
  it('never returns a status or a publication flag, however the suggestion asks', () => {
    assertProperty(
      fc.property(
        rawSuggestionArb({ smuggled: true, overlong: true }),
        factsArb,
        (raw, { facts }) => {
          const { guarded } = applyFactGuard(raw, facts, { categorySlugs: CATEGORY_SLUGS });
          const escaped = guarded as unknown as Record<string, unknown>;

          for (const forbidden of ['status', 'published', 'price', 'sku', 'slug', 'id']) {
            expect(forbidden in escaped, `${forbidden} survived the guard`).toBe(false);
          }
          // Nor anywhere in the serialised object, which catches a nested occurrence a
          // key check would miss.
          const serialised = JSON.stringify(guarded);
          expect(serialised).not.toContain('"status"');
          expect(serialised).not.toContain('"published"');
        },
      ),
    );
  });

  it('respects every schema maximum, on strings and on list lengths', () => {
    assertProperty(
      fc.property(
        rawSuggestionArb({ overlong: true, smuggled: true }),
        factsArb,
        (raw, { facts }) => {
          const { guarded } = applyFactGuard(raw, facts, { categorySlugs: CATEGORY_SLUGS });

          expect(guarded.name.value.length).toBeLessThanOrEqual(FIELD_LIMITS.name);
          expect(guarded.shortDescription.value.length).toBeLessThanOrEqual(
            FIELD_LIMITS.shortDescription,
          );
          expect(guarded.description.value.length).toBeLessThanOrEqual(FIELD_LIMITS.description);
          expect(guarded.seoTitle.value.length).toBeLessThanOrEqual(FIELD_LIMITS.seoTitle);
          expect(guarded.seoDescription.value.length).toBeLessThanOrEqual(
            FIELD_LIMITS.seoDescription,
          );
          expect(guarded.whatsappText.value.length).toBeLessThanOrEqual(FIELD_LIMITS.whatsappText);
          expect(guarded.subcategory.value?.length ?? 0).toBeLessThanOrEqual(
            FIELD_LIMITS.subcategory,
          );

          expect(guarded.styleTags.value.length).toBeLessThanOrEqual(LIST_LIMITS.styleTags);
          expect(guarded.features.value.length).toBeLessThanOrEqual(LIST_LIMITS.features);
          expect(guarded.keywords.value.length).toBeLessThanOrEqual(LIST_LIMITS.keywords);

          for (const feature of guarded.features.value) {
            expect(feature.length).toBeLessThanOrEqual(FIELD_LIMITS.feature);
          }
          for (const tag of guarded.styleTags.value) {
            expect(tag.length).toBeLessThanOrEqual(FIELD_LIMITS.styleTag);
          }
          for (const entry of guarded.imageAltText.value) {
            expect(entry.alt.length).toBeLessThanOrEqual(FIELD_LIMITS.alt);
          }
        },
      ),
    );
  });

  it('strips markup and control characters from every string it returns', () => {
    assertProperty(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 300 }),
        fc.constantFrom(
          '<script>alert(1)</script>',
          '&lt;img src=x onerror=alert(1)&gt;',
          '**bold** _italic_ `code`',
          '<!-- comment -->',
          '[link](https://example.test)',
          'zero\u200bwidth\u202ebidi',
        ),
        (noise, markup) => {
          const raw: RawSuggestion = {
            name: `${markup}${noise}`,
            description: `${noise}${markup} A sofa with removable cushions.`,
            seoTitle: markup,
            whatsappText: markup,
          };
          const { guarded } = applyFactGuard(raw, {}, { categorySlugs: CATEGORY_SLUGS });

          for (const value of [
            guarded.name.value,
            guarded.description.value,
            guarded.seoTitle.value,
            guarded.whatsappText.value,
          ]) {
            expect(value).not.toMatch(/[<>]/);
            expect(value).not.toMatch(/[*_`~#|]/);
            expect(value).not.toMatch(/[\u200b-\u200f\u202a-\u202e\ufeff]/);
            // eslint-disable-next-line no-control-regex
            expect(value).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
          }
        },
      ),
    );
  });

  it('is total: any object at all yields a valid suggestion', () => {
    assertProperty(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 20 }), fc.jsonValue() as fc.Arbitrary<unknown>, {
          maxKeys: 12,
        }),
        (junk) => {
          const { guarded, warnings } = applyFactGuard(junk, {});
          // Never throws, and always produces the full shape — which is what lets the endpoint
          // treat the guard as unconditional.
          expect(typeof guarded.name.value).toBe('string');
          expect(Array.isArray(guarded.styleTags.value)).toBe(true);
          expect(Array.isArray(guarded.warnings)).toBe(true);
          expect(warnings.length).toBeGreaterThan(0);
        },
      ),
    );
  });
});
