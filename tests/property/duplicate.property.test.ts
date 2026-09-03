import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { duplicateProduct } from '@/lib/products/duplicate';
import { toSlug } from '@/lib/slug';
import { ProductSchema } from '@/schemas/product';

import { ngfSkuArb, slugArb, validProductArb } from './arbitraries';
import { assertProperty } from './config';

/**
 * Duplication.
 *
 * Design: Data Models → Slug and SKU generation ("Duplicate must not overwrite the
 * original").
 */

const takenArb = fc
  .tuple(fc.uniqueArray(slugArb, { maxLength: 10 }), fc.uniqueArray(ngfSkuArb, { maxLength: 10 }))
  .map(([slugs, skus]) => ({ slugs: new Set(slugs), skus: new Set(skus) }));

describe('Property 7: Duplicate never mutates or clobbers its source', () => {
  it('differs in id, sku, and slug, and is a DRAFT', () => {
    assertProperty(
      fc.property(validProductArb, takenArb, (source, taken) => {
        const withSource = {
          slugs: new Set([...taken.slugs, source.slug]),
          skus: new Set([...taken.skus, source.sku]),
        };
        const copy = duplicateProduct(source, withSource);

        expect(copy.id).not.toBe(source.id);
        expect(copy.sku).not.toBe(source.sku);
        expect(copy.slug).not.toBe(source.slug);
        expect(copy.status).toBe('DRAFT');
        expect(copy.published).toBe(false);
        expect(withSource.slugs.has(copy.slug)).toBe(false);
        expect(withSource.skus.has(copy.sku)).toBe(false);
        expect(copy.slug.startsWith(toSlug(`${source.name} copy`))).toBe(true);
      }),
    );
  });

  it('leaves the source object byte-identical', () => {
    assertProperty(
      fc.property(validProductArb, takenArb, (source, taken) => {
        const before = structuredClone(source);
        duplicateProduct(source, taken);
        expect(source).toStrictEqual(before);
      }),
    );
  });

  it('shares no nested array or object with the source', () => {
    assertProperty(
      fc.property(validProductArb, takenArb, (source, taken) => {
        const copy = duplicateProduct(source, taken);

        expect(copy).not.toBe(source);
        expect(copy.images).not.toBe(source.images);
        expect(copy.tags).not.toBe(source.tags);
        expect(copy.variants).not.toBe(source.variants);
        expect(copy.availableColors).not.toBe(source.availableColors);
        expect(copy.relatedProductIds).not.toBe(source.relatedProductIds);
        expect(copy.keywords).not.toBe(source.keywords);
        expect(copy.aiFields).not.toBe(source.aiFields);
        copy.images.forEach((image, index) => {
          expect(image).not.toBe(source.images[index]);
        });

        // And mutating the copy's nested data cannot reach the source.
        const sourceImagesBefore = structuredClone(source.images);
        copy.images.push({
          id: 'img_zzzzzzzzzz',
          key: 'originals/img_zzzzzzzzzz.jpg',
          alt: 'added to the copy only',
          width: 100,
          height: 100,
          order: copy.images.length,
          altSource: 'admin',
        });
        copy.tags.push('mutated');
        expect(source.images).toStrictEqual(sourceImagesBefore);
        expect(source.tags).not.toContain('mutated');
      }),
    );
  });

  it('produces a schema-valid draft', () => {
    assertProperty(
      fc.property(validProductArb, takenArb, (source, taken) => {
        const result = ProductSchema.safeParse(duplicateProduct(source, taken));
        expect(result.success ? [] : result.error.issues.map((i) => i.path.join('.'))).toEqual([]);
      }),
    );
  });

  it('preserves unknown passthrough fields in the copy', () => {
    assertProperty(
      fc.property(validProductArb, takenArb, fc.jsonValue(), (source, taken, extra) => {
        const authored = { ...source, legacyImportPayload: extra } as typeof source;
        const copy = duplicateProduct(authored, taken);
        expect(copy['legacyImportPayload']).toStrictEqual(extra);
      }),
    );
  });

  it('is repeatable: two duplicates of one source do not collide', () => {
    assertProperty(
      fc.property(validProductArb, (source) => {
        const slugs = new Set([source.slug]);
        const skus = new Set([source.sku]);
        const first = duplicateProduct(source, { slugs, skus });
        slugs.add(first.slug);
        skus.add(first.sku);
        const second = duplicateProduct(source, { slugs, skus });

        expect(second.slug).not.toBe(first.slug);
        expect(second.sku).not.toBe(first.sku);
        expect(second.id).not.toBe(first.id);
      }),
    );
  });
});
