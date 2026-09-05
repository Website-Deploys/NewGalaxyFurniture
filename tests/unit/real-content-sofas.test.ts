import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { getSiteSettings } from '@/lib/content/site';
import { isCatalogueProduct } from '@/lib/content/catalogue-filter';
import { buildEnquiryMessage, buildWhatsAppUrl } from '@/lib/whatsapp';
import { checkPublishGate } from '@/schemas/publish-gate';
import { ProductImage, ProductSchema } from '@/schemas/product';
import type { Product, ProductImageValue } from '@/schemas/product';

/**
 * The two real sofas, pinned to the behaviour the operator asked to be guaranteed.
 *
 * The Premium 3+1+1 Sofa Set (brown-sofa) is now PUBLISHED with its four real, recovered
 * images: it is the first live catalogue product, so this suite reads the committed JSON and
 * fails if a future change accidentally unpublishes it, drops or breaks its images, or breaks
 * the product-specific WhatsApp templating. Corner Sofa remains an image-less DRAFT — the
 * single missing image is what keeps it out of the public catalogue and off a PUBLISHED
 * status — and this suite keeps guarding that.
 *
 * The suite reads the committed JSON so it fails if a future change
 *
 *   - breaks the product-specific WhatsApp templating (name/SKU no longer carried, or the
 *     wa.me URL stops single-decoding back to the message),
 *   - weakens the image requirement for the draft (something other than `images` starts
 *     blocking corner-sofa, or the gate stops blocking an image-less product),
 *   - accidentally unpublishes brown-sofa (status flips off PUBLISHED / it leaves the public
 *     catalogue / loses its images), or
 *   - accidentally publishes the corner-sofa draft (status flips off DRAFT / it leaks into
 *     the public catalogue).
 *
 * It does not modify the publish gate or the catalogue filter — it only observes them.
 */

/** Read a committed product file straight from `data/products/` and parse the canonical shape. */
function loadProduct(slug: string): Product {
  const path = fileURLToPath(new URL(`../../data/products/${slug}.json`, import.meta.url));
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return ProductSchema.parse(raw);
}

/** A single synthetic, schema-valid image — the one thing the draft is missing. */
const validImage: ProductImageValue = ProductImage.parse({
  id: 'img_abc1234567',
  key: 'products/synthetic/original.jpg',
  alt: 'A synthetic image used only to prove images are the sole publish blocker',
  width: 1600,
  height: 1200,
  order: 0,
});

const settings = getSiteSettings();

const cornerSofa = loadProduct('corner-sofa');
const brownSofa = loadProduct('brown-sofa');

/** slug → the exact committed values this suite locks in. */
const cases = [
  { label: 'Corner Sofa', product: cornerSofa, price: 44990 },
  { label: 'Premium 3+1+1 Sofa Set', product: brownSofa, price: 41990 },
] as const;

describe('real sofas: the product-specific WhatsApp enquiry', () => {
  it.each(cases)(
    'resolves to the exact required message for $label, carrying its real name and SKU',
    ({ product }) => {
      const message = buildEnquiryMessage(
        { kind: 'product', productName: product.name, sku: product.sku },
        settings,
      );

      // Identity line + newline + descriptive line, exactly as buildEnquiryMessage.assemble() joins.
      const expected =
        `Hi ${settings.businessName}, I'm interested in the ${product.name} (SKU: ${product.sku}).` +
        '\n' +
        'I would like to enquire about the price, availability and order details.';

      expect(message).toBe(expected);
      // No amount ever leaks into the message, even though these carry a price.
      expect(message).not.toContain('₹');
    },
  );

  it.each(cases)(
    'builds a wa.me URL for $label that single-decodes back to the message, on every number',
    ({ product }) => {
      const message = buildEnquiryMessage(
        { kind: 'product', productName: product.name, sku: product.sku },
        settings,
      );

      expect(settings.whatsapp.length).toBeGreaterThan(0);
      for (const entry of settings.whatsapp) {
        const url = buildWhatsAppUrl(entry.e164, message);
        const raw = url.slice(url.indexOf('?text=') + '?text='.length);

        // A single decode returns the message character for character (no double encoding).
        expect(decodeURIComponent(raw)).toBe(message);
        // And the name + SKU survive that round-trip verbatim.
        expect(decodeURIComponent(raw)).toContain(product.name);
        expect(decodeURIComponent(raw)).toContain(product.sku);
      }
    },
  );
});

describe('Corner Sofa DRAFT: the publish gate blocks on the missing image and nothing else', () => {
  it('refuses to publish Corner Sofa with images as the SOLE failing field', () => {
    const result = checkPublishGate(cornerSofa);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('An image-less draft must not pass the publish gate.');

    // Every other publish-gate field is already satisfied, so the only blocker is images.
    expect(Object.keys(result.fields)).toEqual(['images']);
    expect(result.fields.images).toContain('At least one image required');
  });

  it('passes the publish gate for Corner Sofa the moment one real image exists', () => {
    // Shallow clone with a single valid image added — proving REVIEW→PUBLISH becomes reachable.
    const clone: Product = {
      ...cornerSofa,
      images: [validImage],
      primaryImage: validImage.id,
    };

    expect(checkPublishGate(clone).ok).toBe(true);
  });
});

describe('catalogue membership: brown-sofa is live, corner-sofa is not', () => {
  it('excludes the Corner Sofa DRAFT from any public page/search/category', () => {
    expect(cornerSofa.status).toBe('DRAFT');
    expect(cornerSofa.published).toBe(false);
    expect(isCatalogueProduct(cornerSofa)).toBe(false);
  });

  it('includes the PUBLISHED Premium 3+1+1 Sofa Set in the public catalogue', () => {
    expect(brownSofa.status).toBe('PUBLISHED');
    expect(brownSofa.published).toBe(true);
    expect(isCatalogueProduct(brownSofa)).toBe(true);
  });
});

describe('Corner Sofa DRAFT: the committed content is exactly what was authored', () => {
  it('pins Corner Sofa price, currency, lifecycle and image marker', () => {
    expect(cornerSofa.price).toBe(44990);
    expect(cornerSofa.currency).toBe('INR');
    expect(cornerSofa.status).toBe('DRAFT');
    expect(cornerSofa.published).toBe(false);
    expect(cornerSofa.category).toBe('sofas');
    expect(cornerSofa.images).toHaveLength(0);
    // The em dash is verbatim — this marker documents the manual admin upload requirement.
    expect(cornerSofa.imageStatus).toBe('IMAGE REQUIRED — MANUAL ADMIN UPLOAD');
  });

  it('gives the two sofas distinct, well-formed NGF-SOF SKUs', () => {
    for (const { product } of cases) {
      expect(product.sku).toMatch(/^NGF-SOF-[A-Z0-9]{6}$/);
    }
    expect(cornerSofa.sku).not.toBe(brownSofa.sku);
  });
});

describe('Premium 3+1+1 Sofa Set: the published record, its images and its WhatsApp enquiry', () => {
  it('carries the verified, renamed customer-facing identity and attributes', () => {
    expect(brownSofa.name).toBe('Premium 3+1+1 Sofa Set');
    expect(brownSofa.sku).toBe('NGF-SOF-WBJZX0');
    expect(brownSofa.slug).toBe('brown-sofa');
    expect(brownSofa.price).toBe(41990);
    expect(brownSofa.currency).toBe('INR');
    expect(brownSofa.category).toBe('sofas');
    expect(brownSofa.material).toContain('Neem Wood');
    // 'Brown Sofa' is retained as a searchable alias in the search-consumed `tags`.
    expect(brownSofa.tags).toContain('Brown Sofa');
    expect(brownSofa.tags).toContain('3+1+1 Sofa');
    expect(brownSofa.tags).toContain('Sofa');
    expect(brownSofa.imageAltText).toBe('Premium 3+1+1 Sofa Set by New Galaxy Furniture');
  });

  it('is PUBLISHED with its four real recovered images and passes the publish gate', () => {
    expect(brownSofa.status).toBe('PUBLISHED');
    expect(brownSofa.published).toBe(true);
    expect(brownSofa.stockStatus).toBe('IN_STOCK');
    expect(brownSofa.images).toHaveLength(4);
    expect(brownSofa.primaryImage).toBe('img_tchmzkuoeb');
    expect(isCatalogueProduct(brownSofa)).toBe(true);
    expect(checkPublishGate(brownSofa).ok).toBe(true);
  });

  it('gives every image a non-empty alt and a well-formed R2 original key under its product id', () => {
    const keyPattern = /^products\/p_322e7n6mth\/img_[a-z0-9]{10}\/original\.webp$/;
    for (const image of brownSofa.images) {
      expect(image.alt.trim().length).toBeGreaterThan(0);
      expect(image.key).toMatch(keyPattern);
    }
    // primaryImage references one of the product's own images.
    expect(brownSofa.images.some((image) => image.id === brownSofa.primaryImage)).toBe(true);
    // Image order is a contiguous 0..3 permutation.
    expect(brownSofa.images.map((image) => image.order).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('produces the exact required WhatsApp message, never mentioning Corner Sofa', () => {
    const message = buildEnquiryMessage(
      { kind: 'product', productName: brownSofa.name, sku: brownSofa.sku },
      settings,
    );

    // Verbatim — the two sentences are joined with a single newline by assemble().
    expect(message).toBe(
      "Hi New Galaxy Furniture, I'm interested in the Premium 3+1+1 Sofa Set (SKU: NGF-SOF-WBJZX0)." +
        '\n' +
        'I would like to enquire about the price, availability and order details.',
    );
    expect(message).not.toContain('Corner Sofa');
  });
});

describe('Corner Sofa stays completely separate from the Premium 3+1+1 Sofa Set', () => {
  it('keeps its own name in its WhatsApp message and never borrows the other sofa', () => {
    const message = buildEnquiryMessage(
      { kind: 'product', productName: cornerSofa.name, sku: cornerSofa.sku },
      settings,
    );

    expect(message).toContain('Corner Sofa');
    expect(message).not.toContain('Premium 3+1+1 Sofa Set');
    // The two records never share a name, SKU or price.
    expect(cornerSofa.name).not.toBe(brownSofa.name);
    expect(cornerSofa.sku).not.toBe(brownSofa.sku);
    expect(cornerSofa.price).not.toBe(brownSofa.price);
  });
});
