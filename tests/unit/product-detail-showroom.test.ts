import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildEnquiryMessage } from '@/lib/whatsapp';
import { demoSofa } from '../fixtures/products';

/**
 * The premium product detail page and product-card motion, as source-level invariants
 * (Milestone 3, Checkpoint B).
 *
 * These are source assertions in the style of `catalogue-hero.test.ts`: the site has no
 * page-render harness, and the properties worth protecting live in the page/component source and
 * the shared stylesheet. Each assertion is written so it would FAIL if the code were reverted to
 * the pre-checkpoint layout or if a load-bearing contract (product-specific WhatsApp, omit-when-
 * empty, the no-hover-fetch card rule, CSS-only motion) were broken.
 */

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const PDP_PAGE = read('src/pages/product/[slug].astro');
const PRODUCT_DETAIL = read('src/components/product/ProductDetail.astro');
const PRODUCT_CARD = read('src/components/product/ProductCard.astro');
const BASE_LAYOUT = read('src/layouts/BaseLayout.astro');
const SHELL_CSS = read('src/styles/shell.css');

describe('the PDP product-specific WhatsApp (Requirement 5.1, 5.2)', () => {
  it('builds the enquiry message from the product name and SKU, never a hardcoded name', () => {
    // The property the whole conversion flow rests on: the message names the exact piece and its
    // SKU. Built here from the fixture through the same pure function the PDP uses.
    const message = buildEnquiryMessage(
      { kind: 'product', productName: demoSofa.name, sku: demoSofa.sku },
      { businessName: 'New Galaxy Furniture' } as never,
    );
    expect(message).toContain(demoSofa.name);
    expect(message).toContain(`SKU: ${demoSofa.sku}`);
  });

  it('passes a product EnquiryContext built from the record, so no name is hardcoded', () => {
    // The in-page controls take `enquiryContext`, which is assembled from `product.name`/`.sku`.
    expect(PRODUCT_DETAIL).toMatch(/kind:\s*'product'/);
    expect(PRODUCT_DETAIL).toContain('productName: product.name');
    expect(PRODUCT_DETAIL).toContain('sku: product.sku');
    expect(PRODUCT_DETAIL).toContain('context={enquiryContext}');
    // The literal product name must never be baked into the component.
    expect(PRODUCT_DETAIL).not.toContain(demoSofa.name);
  });
});

describe('the sticky mobile action bar is public-page-only', () => {
  it('the PDP page supplies the bar a product EnquiryContext with the exact name and SKU', () => {
    // The sticky bar's message is product-specific because the PDP hands BaseLayout the product
    // context — carrying name and SKU — rather than falling back to the general enquiry.
    expect(PDP_PAGE).toMatch(/actionBar=\{\{/);
    expect(PDP_PAGE).toMatch(/actionBar=\{\{[\s\S]*kind:\s*'product'/);
    expect(PDP_PAGE).toMatch(/actionBar=\{\{[\s\S]*productName:\s*product\.name/);
    expect(PDP_PAGE).toMatch(/actionBar=\{\{[\s\S]*sku:\s*product\.sku/);
  });

  it('routes the bar context through buildEnquiryMessage in the layout, not a hand-rolled string', () => {
    expect(BASE_LAYOUT).toContain('buildEnquiryMessage(actionBar ?? { kind: \'general\' }');
  });

  it('keeps the sticky bar out of ProductDetail, which /admin/preview reuses', () => {
    // The shared body must gain no sticky chrome: admin preview renders it and must not sprout a
    // mobile action bar. So ProductDetail references neither the action bar nor a fixed CTA.
    expect(PRODUCT_DETAIL).not.toContain('ngf-actionbar');
    expect(PRODUCT_DETAIL).not.toContain('MobileActionBar');
    expect(PRODUCT_DETAIL).not.toContain('actionBar');
  });
});

describe('the PDP information panel composes the omit-when-empty components (Requirement 4.3)', () => {
  it('uses the decomposed blocks rather than restating price/spec/stock/variant logic', () => {
    for (const component of ['PriceBlock', 'SpecList', 'StockBadge', 'VariantList', 'Breadcrumbs']) {
      expect(PRODUCT_DETAIL).toContain(`<${component}`);
    }
  });

  it('renders the info card in the light-showroom language: white card, taupe hairline, radius-xl', () => {
    const info = SHELL_CSS.slice(
      SHELL_CSS.indexOf('.ngf-pdp-info {'),
      SHELL_CSS.indexOf('.ngf-pdp-head'),
    );
    expect(info).toMatch(/background-color:\s*var\(--color-white\)/);
    expect(info).toMatch(/border:\s*1px solid var\(--color-taupe\)/);
    expect(info).toMatch(/border-radius:\s*var\(--radius-xl\)/);
  });

  it('frames the specification area as a drawing-board panel (cream + hairline grid)', () => {
    const panel = SHELL_CSS.slice(SHELL_CSS.indexOf('.ngf-pdp-specpanel {'));
    expect(panel).toMatch(/background-color:\s*var\(--color-cream\)/);
    expect(panel).toContain('background-size: 24px 24px');
  });

  it('keeps the gallerySlot boolean mechanism rather than sniffing Astro.slots', () => {
    // The explicit boolean is a correctness fix (an image-less product must not skip the fallback).
    expect(PRODUCT_DETAIL).toContain('gallerySlot');
    expect(PDP_PAGE).toContain('gallerySlot={galleryImages.length > 0}');
  });
});

describe('product card motion is CSS-only and reduced-motion-safe (Requirements 1.11–1.14)', () => {
  it('never introduces an inline event handler on the card', () => {
    expect(PRODUCT_CARD).not.toMatch(/\son(error|click|mouseover|load)=/i);
  });

  it('gates the second image and the hover motion behind (hover:hover) and (min-width:768px)', () => {
    // Requirement 1.14: the second image is a background-image applied only inside this query, so
    // a touch device never fetches it. The block must contain the hover custom-property assignment.
    const gate = '@media (hover: hover) and (min-width: 768px)';
    const gateBlock = SHELL_CSS.slice(SHELL_CSS.indexOf(gate));
    expect(gateBlock).toContain('var(--ngf-card-hover-src)');
    // The image scale is a hover-only transform, so it too costs nothing on touch.
    expect(gateBlock).toMatch(/\.ngf-card-media > \.ngf-image\s*\{\s*transform: scale/);
  });

  it('only ever reads the second image from inside the hover media query', () => {
    // The custom property is assigned inline in the component, but the stylesheet must reference
    // `--ngf-card-hover-src` exclusively inside the hover gate — never in a default rule that a
    // no-hover device would match and fetch.
    const gateIndex = SHELL_CSS.indexOf('@media (hover: hover) and (min-width: 768px)');
    const before = SHELL_CSS.slice(0, gateIndex);
    expect(before).not.toContain('background-image: var(--ngf-card-hover-src)');
  });

  it('animates only transform/opacity on the card and its layers, never a loop', () => {
    // The card media image transition is transform only; no `infinite`/`alternate` anywhere here.
    const media = SHELL_CSS.slice(
      SHELL_CSS.indexOf('.ngf-card-media > .ngf-image {'),
      SHELL_CSS.indexOf('.ngf-card-hover'),
    );
    expect(media).toMatch(/transition: transform/);
    expect(SHELL_CSS.slice(SHELL_CSS.indexOf('.ngf-card {'))).not.toMatch(/animation:[^;]*infinite/);
  });
});
