import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ProductSchema } from '@/schemas/product';

import {
  imagesArb,
  inrAmountArb,
  PRODUCT_STATUSES,
  unknownKeyArb,
  validProductArb,
} from './arbitraries';
import { assertProperty } from './config';

/**
 * The canonical product schema and its six cross-field invariants.
 *
 * Design: Data Models → Canonical product schema, Cross-field invariants.
 */

/** The field paths a failed parse reported, dotted. */
function issuePaths(input: unknown): string[] {
  const result = ProductSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('Property 12: Product serialization round-trips', () => {
  it('parses a JSON round-trip back to the identical object', () => {
    assertProperty(
      fc.property(validProductArb, (product) => {
        const parsed = ProductSchema.parse(JSON.parse(JSON.stringify(product)));
        expect(parsed).toStrictEqual(product);
      }),
    );
  });
});

describe('Property 13: Unknown fields survive the round-trip', () => {
  it('preserves an unrecognised key and its value', () => {
    assertProperty(
      fc.property(validProductArb, unknownKeyArb, fc.jsonValue(), (product, key, value) => {
        const authored: Record<string, unknown> = { ...product, [key]: value };
        const parsed = ProductSchema.parse(JSON.parse(JSON.stringify(authored)));
        expect(Object.hasOwn(parsed, key)).toBe(true);
        expect((parsed as Record<string, unknown>)[key]).toStrictEqual(
          JSON.parse(JSON.stringify(value)) as unknown,
        );
      }),
    );
  });
});

describe('Property 14: Price and price-on-enquiry are mutually exclusive', () => {
  it('rejects a product that carries both, reporting on price', () => {
    assertProperty(
      fc.property(validProductArb, fc.integer({ min: 1, max: 5_000_000 }), (product, price) => {
        const both = {
          ...product,
          priceOnEnquiry: true,
          price,
          originalPrice: null,
          discount: null,
        };
        expect(issuePaths(both)).toContain('price');
      }),
    );
  });

  it('rejects a product that carries neither', () => {
    assertProperty(
      fc.property(validProductArb, (product) => {
        const neither = {
          ...product,
          priceOnEnquiry: false,
          price: null,
          originalPrice: null,
          discount: null,
        };
        expect(issuePaths(neither)).toContain('price');
      }),
    );
  });
});

describe('Property 15: Discounts cannot be fabricated by original price', () => {
  it('rejects an original price that does not exceed the price', () => {
    assertProperty(
      fc.property(
        validProductArb,
        fc
          .tuple(fc.integer({ min: 1, max: 5_000_000 }), fc.integer({ min: 1, max: 5_000_000 }))
          .filter(([original, price]) => original <= price),
        (product, [originalPrice, price]) => {
          const fabricated = {
            ...product,
            priceOnEnquiry: false,
            price,
            originalPrice,
            discount: null,
          };
          expect(issuePaths(fabricated)).toContain('originalPrice');
        },
      ),
    );
  });

  it('rejects a discount with no original price', () => {
    assertProperty(
      fc.property(validProductArb, fc.integer({ min: 0, max: 95 }), (product, discount) => {
        const orphan = {
          ...product,
          priceOnEnquiry: false,
          price: 42_000,
          originalPrice: null,
          discount,
        };
        expect(issuePaths(orphan)).toContain('discount');
      }),
    );
  });
});

describe('Property 16: Discount percentage must be the computed value', () => {
  it('rejects any discount other than the computed percentage', () => {
    assertProperty(
      fc.property(
        validProductArb,
        // A genuine pair: originalPrice > price, and the computed percentage is
        // inside the schema's 0..95 bound so only the injected value can fail.
        fc
          .integer({ min: 1000, max: 5_000_000 })
          .chain((originalPrice) =>
            fc
              .integer({ min: Math.ceil(originalPrice * 0.06), max: originalPrice - 1 })
              .map((price) => [originalPrice, price] as const),
          ),
        fc.integer({ min: 0, max: 95 }),
        (product, [originalPrice, price], injected) => {
          const expected = Math.round(((originalPrice - price) / originalPrice) * 100);
          fc.pre(injected !== expected);
          const wrong = {
            ...product,
            priceOnEnquiry: false,
            price,
            originalPrice,
            discount: injected,
          };
          expect(issuePaths(wrong)).toContain('discount');
        },
      ),
    );
  });

  it('accepts the computed percentage', () => {
    assertProperty(
      fc.property(
        validProductArb,
        fc
          .integer({ min: 1000, max: 5_000_000 })
          .chain((originalPrice) =>
            fc
              .integer({ min: Math.ceil(originalPrice * 0.06), max: originalPrice - 1 })
              .map((price) => [originalPrice, price] as const),
          ),
        (product, [originalPrice, price]) => {
          const right = {
            ...product,
            priceOnEnquiry: false,
            price,
            originalPrice,
            discount: Math.round(((originalPrice - price) / originalPrice) * 100),
          };
          expect(issuePaths(right)).not.toContain('discount');
        },
      ),
    );
  });
});

describe('Property 17: The published flag mirrors status', () => {
  it('rejects every mismatched status/published pair, reporting on published', () => {
    assertProperty(
      fc.property(
        validProductArb,
        fc.constantFrom(...PRODUCT_STATUSES),
        fc.boolean(),
        (product, status, published) => {
          const isPublic = status === 'PUBLISHED' || status === 'OUT_OF_STOCK';
          fc.pre(published !== isPublic);
          expect(issuePaths({ ...product, status, published })).toContain('published');
        },
      ),
    );
  });

  it('accepts the matched pair', () => {
    assertProperty(
      fc.property(validProductArb, fc.constantFrom(...PRODUCT_STATUSES), (product, status) => {
        const isPublic = status === 'PUBLISHED' || status === 'OUT_OF_STOCK';
        const stockStatus = isPublic && status === 'OUT_OF_STOCK' ? 'OUT_OF_STOCK' : 'IN_STOCK';
        fc.pre(status !== 'OUT_OF_STOCK' ? product.stockStatus !== 'OUT_OF_STOCK' : true);
        const coherent = {
          ...product,
          status,
          published: isPublic,
          stockStatus,
          madeToOrder: false,
        };
        expect(issuePaths(coherent)).not.toContain('published');
      }),
    );
  });
});

describe('Property 20: Image order is a contiguous permutation', () => {
  it('rejects duplicated, gapped, or negative orders', () => {
    assertProperty(
      fc.property(
        validProductArb,
        imagesArb.filter((images) => images.length > 0),
        fc.array(fc.integer({ min: -5, max: 25 }), { minLength: 1, maxLength: 6 }),
        (product, images, perturbation) => {
          const perturbed = images.map((image, index) => ({
            ...image,
            order: perturbation[index % perturbation.length] ?? index,
          }));
          const sorted = [...perturbed].map((i) => i.order).sort((a, b) => a - b);
          // Only interesting when the result is genuinely not a permutation of 0..n-1.
          fc.pre(sorted.some((order, index) => order !== index));

          const paths = issuePaths({
            ...product,
            images: perturbed,
            primaryImage: perturbed[0]?.id,
          });
          expect(paths.length).toBeGreaterThan(0);
        },
      ),
    );
  });

  it('accepts a contiguous permutation in any array position', () => {
    assertProperty(
      fc.property(
        validProductArb,
        imagesArb.filter((images) => images.length > 1),
        (product, images) => {
          // Shuffle the array while keeping `order` a permutation of 0..n-1.
          const reversed = [...images].reverse();
          const paths = issuePaths({
            ...product,
            images: reversed,
            primaryImage: reversed[0]?.id,
          });
          expect(paths).not.toContain('images');
        },
      ),
    );
  });
});

describe('schema bounds hold for prices', () => {
  it('rejects a non-integer or non-positive price', () => {
    assertProperty(
      fc.property(validProductArb, inrAmountArb, (product, amount) => {
        const invalid = { ...product, priceOnEnquiry: false, price: -amount - 0.5 };
        expect(issuePaths(invalid)).toContain('price');
      }),
    );
  });
});
