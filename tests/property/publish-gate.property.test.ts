import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ProductSchema } from '@/schemas/product';
import { checkPublishGate, PublishReadySchema } from '@/schemas/publish-gate';

import { imagesArb, validProductArb } from './arbitraries';
import { assertProperty } from './config';

/**
 * The publish gate is a strictly stronger condition than the base schema: a draft
 * may be incomplete, a published product may not.
 *
 * Design: Data Models → Publish gate.
 */

/** A product with no images at all — schema-valid, never publish-ready. */
const imagelessProductArb = validProductArb.map((product) => {
  const { primaryImage: _primaryImage, ...rest } = product;
  return { ...rest, images: [] };
});

/** Every image present but at least one carrying blank alt text. */
const blankAltProductArb = fc
  .tuple(
    validProductArb,
    imagesArb.filter((images) => images.length > 0),
    fc.constantFrom('', ' ', '\t', '\n   '),
  )
  .map(([product, images, blank]) => ({
    ...product,
    images: images.map((image, index) => (index === 0 ? { ...image, alt: blank } : image)),
    primaryImage: images[0]?.id,
  }));

describe('Property 18: The publish gate is stricter than the base schema', () => {
  it('accepts an imageless product as a draft and refuses it for publication', () => {
    assertProperty(
      fc.property(imagelessProductArb, (product) => {
        expect(ProductSchema.safeParse(product).success).toBe(true);
        expect(PublishReadySchema.safeParse(product).success).toBe(false);

        const gate = checkPublishGate(product);
        expect(gate.ok).toBe(false);
        if (!gate.ok) expect(Object.keys(gate.fields)).toContain('images');
      }),
    );
  });

  it('accepts blank alt text as a draft and refuses it for publication', () => {
    assertProperty(
      fc.property(blankAltProductArb, (product) => {
        expect(ProductSchema.safeParse(product).success).toBe(true);

        const gate = checkPublishGate(product);
        expect(gate.ok).toBe(false);
        if (!gate.ok) expect(Object.keys(gate.fields)).toContain('images');
      }),
    );
  });
});

describe('Property 19: Publish-ready implies schema-valid', () => {
  /**
   * Deliberately including inputs that are not products at all: the implication
   * must hold for every value, which is what makes the gate safe to call on a
   * half-filled admin form.
   */
  const anyCandidateArb: fc.Arbitrary<unknown> = fc.oneof(
    { weight: 4, arbitrary: validProductArb },
    { weight: 2, arbitrary: imagelessProductArb },
    { weight: 2, arbitrary: blankAltProductArb },
    {
      weight: 2,
      arbitrary: fc
        .tuple(validProductArb, fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 4 }))
        .map(([product, overrides]) => ({ ...product, ...overrides })),
    },
    { weight: 1, arbitrary: fc.jsonValue() },
  );

  it('never accepts for publication anything the base schema rejects', () => {
    assertProperty(
      fc.property(anyCandidateArb, (candidate) => {
        if (PublishReadySchema.safeParse(candidate).success) {
          expect(ProductSchema.safeParse(candidate).success).toBe(true);
        }
      }),
    );
  });

  it('reports gate failures per field and never throws', () => {
    assertProperty(
      fc.property(anyCandidateArb, (candidate) => {
        const gate = checkPublishGate(candidate);
        expect(gate.ok).toBe(PublishReadySchema.safeParse(candidate).success);
        if (!gate.ok) {
          for (const [field, messages] of Object.entries(gate.fields)) {
            expect(field.length).toBeGreaterThan(0);
            expect(messages.length).toBeGreaterThan(0);
          }
        }
      }),
    );
  });

  it('passes a complete, illustrated, priced product', () => {
    assertProperty(
      fc.property(
        validProductArb,
        imagesArb.filter((images) => images.length > 0),
        // The gate measures the description *after trimming*: the base schema's
        // `min(20)` counts whitespace, the gate does not, because 20 spaces is not
        // a description. A publish-ready product therefore needs 20 real characters.
        fc.string({ minLength: 20, maxLength: 400 }).filter((d) => d.trim().length >= 20),
        (product, images, description) => {
          const ready = { ...product, images, primaryImage: images[0]?.id, description };
          const gate = checkPublishGate(ready);
          expect(gate).toStrictEqual({ ok: true });
        },
      ),
    );
  });

  it('refuses a description padded to length with whitespace', () => {
    assertProperty(
      fc.property(
        validProductArb,
        imagesArb.filter((images) => images.length > 0),
        fc.integer({ min: 20, max: 60 }),
        (product, images, pad) => {
          const padded = {
            ...product,
            images,
            primaryImage: images[0]?.id,
            description: ' '.repeat(pad),
          };
          expect(ProductSchema.safeParse(padded).success).toBe(true);
          const gate = checkPublishGate(padded);
          expect(gate.ok).toBe(false);
          if (!gate.ok) expect(Object.keys(gate.fields)).toContain('description');
        },
      ),
    );
  });
});
