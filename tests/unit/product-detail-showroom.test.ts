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

  it('gates the spec panel and its eyebrow on having at least one spec (Requirement 4.3)', () => {
    // A spec-less product must not show a labelled but empty drawing-board frame: the panel is
    // gated on `hasSpecs`, computed from the same fields SpecList renders. Reverting the gate (an
    // always-rendered `<section class="ngf-pdp-specpanel">`) fails this.
    expect(PRODUCT_DETAIL).toMatch(/const hasSpecs =/);
    // The emptiness test mirrors SpecList's own fields, so it cannot drift from what is displayed.
    for (const field of [
      'product.material',
      'product.color',
      'product.availableColors',
      'product.size',
    ]) {
      expect(PRODUCT_DETAIL).toContain(field);
    }
    expect(PRODUCT_DETAIL).toMatch(/hasDimensions/);
    // The panel renders only inside the guard — never unconditionally.
    expect(PRODUCT_DETAIL).toMatch(
      /hasSpecs &&\s*\(\s*<section class="ngf-pdp-specpanel"/,
    );
    expect(PRODUCT_DETAIL).not.toMatch(
      /}\s*\n\s*<section class="ngf-pdp-specpanel"/,
    );
  });
});

describe('the PDP carries an animated, reduced-motion-safe technical overlay (issue 1)', () => {
  it('renders a decorative technical hairline in the always-present gallery column', () => {
    // The animated technical treatment must survive a spec-less product, so it lives in the media
    // column (which always renders) rather than in the gated spec panel.
    const media = PRODUCT_DETAIL.slice(
      PRODUCT_DETAIL.indexOf('data-reveal="mask"'),
      PRODUCT_DETAIL.indexOf('class="ngf-pdp-info"'),
    );
    expect(media).toContain('class="ngf-pdp-rule"');
    // Decorative only: no numbers drawn, hidden from assistive tech.
    expect(media).toContain('aria-hidden="true"');
  });

  it('animates the rule with transform only, one-shot, reduced-motion-safe', () => {
    const rule = SHELL_CSS.slice(
      SHELL_CSS.indexOf('.ngf-pdp-rule {'),
      SHELL_CSS.indexOf('/* The information card. */'),
    );
    // The animating property is transform (scaleX), costing no layout — never width/height.
    expect(rule).toMatch(/transform:\s*scaleX\(1\)/);
    expect(rule).toMatch(/transition:\s*transform var\(--dur-story\)/);
    expect(rule).not.toMatch(/animation:[^;]*infinite/);
    // Held full-width unless motion is allowed, using the visible-by-default from-state — never
    // an inverted [data-revealed] selector.
    expect(rule).toContain('@media (prefers-reduced-motion: no-preference)');
    expect(rule).toMatch(
      /\[data-reveal\]:not\(\[data-revealed\]\) \.ngf-pdp-rule \{\s*transform:\s*scaleX\(0\)/,
    );
    expect(rule).toContain("data-motion='off'");
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
