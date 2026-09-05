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
 * The two real DRAFT sofas, pinned to the behaviour the operator asked to be guaranteed.
 *
 * These are the first real products in the catalogue and both ship image-less, on purpose:
 * the missing image is the single thing that keeps them out of the public catalogue and out
 * of a PUBLISHED status. This suite reads the committed JSON so it fails if a future change
 *
 *   - breaks the product-specific WhatsApp templating (name/SKU no longer carried, or the
 *     wa.me URL stops single-decoding back to the message),
 *   - weakens the image requirement (something other than `images` starts blocking, or the
 *     gate stops blocking an image-less product), or
 *   - accidentally publishes the drafts (status flips off DRAFT / they leak into the
 *     public catalogue).
 *
 * It does not modify the publish gate or the catalogue filter — it only observes them.
 */

/** Read a committed product file straight from `data/products/` and parse the canonical shape. */
function loadProduct(slug: string): Product {
  const path = fileURLToPath(new URL(`../../data/products/${slug}.json`, import.meta.url));
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return ProductSchema.parse(raw);
}

/** A single synthetic, schema-valid image — the one thing each draft is missing. */
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

describe('real DRAFT sofas: the product-specific WhatsApp enquiry', () => {
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

describe('real DRAFT sofas: the publish gate blocks on the missing image and nothing else', () => {
  it.each(cases)(
    'refuses to publish $label with images as the SOLE failing field',
    ({ product }) => {
      const result = checkPublishGate(product);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('An image-less draft must not pass the publish gate.');

      // Every other publish-gate field is already satisfied, so the only blocker is images.
      expect(Object.keys(result.fields)).toEqual(['images']);
      expect(result.fields.images).toContain('At least one image required');
    },
  );

  it.each(cases)(
    'passes the publish gate for $label the moment one real image exists',
    ({ product }) => {
      // Shallow clone with a single valid image added — proving REVIEW→PUBLISH becomes reachable.
      const clone: Product = {
        ...product,
        images: [validImage],
        primaryImage: validImage.id,
      };

      expect(checkPublishGate(clone).ok).toBe(true);
    },
  );
});

describe('real DRAFT sofas: excluded from the public catalogue until published', () => {
  it.each(cases)('does not surface $label on any public page/search/category', ({ product }) => {
    expect(product.status).toBe('DRAFT');
    expect(isCatalogueProduct(product)).toBe(false);
  });
});

describe('real DRAFT sofas: the committed content is exactly what was authored', () => {
  it.each(cases)(
    'pins $label price, currency, lifecycle and image marker',
    ({ product, price }) => {
      expect(product.price).toBe(price);
      expect(product.currency).toBe('INR');
      expect(product.status).toBe('DRAFT');
      expect(product.published).toBe(false);
      expect(product.category).toBe('sofas');
      expect(product.images).toHaveLength(0);
      // The em dash is verbatim — this marker documents the manual admin upload requirement.
      expect(product.imageStatus).toBe('IMAGE REQUIRED — MANUAL ADMIN UPLOAD');
    },
  );

  it('gives the two sofas distinct, well-formed NGF-SOF SKUs', () => {
    for (const { product } of cases) {
      expect(product.sku).toMatch(/^NGF-SOF-[A-Z0-9]{6}$/);
    }
    expect(cornerSofa.sku).not.toBe(brownSofa.sku);
  });
});

describe('Premium 3+1+1 Sofa Set: the verified record and its WhatsApp enquiry', () => {
  it('carries the verified, renamed customer-facing identity and attributes', () => {
    expect(brownSofa.name).toBe('Premium 3+1+1 Sofa Set');
    expect(brownSofa.sku).toBe('NGF-SOF-WBJZX0');
    expect(brownSofa.slug).toBe('brown-sofa');
    expect(brownSofa.price).toBe(41990);
    expect(brownSofa.material).toContain('Neem Wood');
    // 'Brown Sofa' is retained as a searchable alias in the search-consumed `tags`.
    expect(brownSofa.tags).toContain('Brown Sofa');
    expect(brownSofa.tags).toContain('3+1+1 Sofa');
    expect(brownSofa.tags).toContain('Sofa');
    expect(brownSofa.imageAltText).toBe('Premium 3+1+1 Sofa Set by New Galaxy Furniture');
  });

  it('records the approved manual-upload image order as inert passthrough metadata', () => {
    const record = brownSofa as Product & { pendingImageOrder?: unknown };
    expect(record.pendingImageOrder).toEqual(['front', 'top', 'left', 'right']);
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
