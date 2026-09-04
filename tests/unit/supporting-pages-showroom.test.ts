import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The five supporting pages — /about, /workshop, /gallery, /reviews, /contact — as source-level
 * invariants (Milestone 3, Checkpoint D).
 *
 * Checkpoint D relights the supporting pages into the premium light-showroom system already built
 * for the catalogue and the custom-furniture guided process, WITHOUT loosening any of the
 * no-fabrication, empty-state, JSON-LD, accessibility or motion-budget rules those pages already
 * carried. These are source assertions in the style of `catalogue-hero.test.ts`,
 * `product-detail-showroom.test.ts` and `custom-furniture-process.test.ts`: the site has no
 * page-render harness, and each assertion is written so it FAILS if the redesign were reverted or a
 * load-bearing contract (the premium hero, the drawing-board panels, the reused-primitive ceiling,
 * the visible-by-default reveal, the honest empty states, the no-invented-fact discipline) were
 * broken.
 */

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const ABOUT = read('src/pages/about.astro');
const WORKSHOP = read('src/pages/workshop.astro');
const GALLERY = read('src/pages/gallery.astro');
const REVIEWS = read('src/pages/reviews.astro');
const CONTACT = read('src/pages/contact.astro');

/** Claim families that must not appear in a page's prose — years, counts, awards, guarantees. */
const FABRICATION_PATTERNS: RegExp[] = [
  /\bsince\s+(?:19|20)\d{2}\b/i,
  /\b\d+\+?\s*years?\b/i,
  /\b\d[\d,]*\s*(?:pieces|customers|homes|orders|clients|families)\b/i,
  /\bfree (?:delivery|shipping)\b/i,
  /\b(?:money[- ]back|lifetime|guarantee[d]?|warrant(?:y|ies))\b/i,
  /\b(?:award|certified|iso\s*\d|patent)\b/i,
];

describe('about — the premium hero, the placeholder story and the values band', () => {
  it('opens with the shared .ngf-cathero premium hero, revealed as one group', () => {
    expect(ABOUT).toContain('ngf-cathero');
    expect(ABOUT).toContain('ngf-cathero-eyebrow');
    expect(ABOUT).toContain('ngf-cathero-panel');
    // The whole hero is one staggered reveal group — it counts as a single animating element.
    expect(ABOUT).toMatch(/ngf-cathero[\s\S]*data-reveal data-motion-group/);
  });

  it('renders the business name as the h1 and the service area from settings', () => {
    expect(ABOUT).toContain('<h1>{settings.businessName}</h1>');
    expect(ABOUT).toContain('settings.serviceArea.join');
  });

  it('draws exactly one reused primitive as the brand mark: titled and trigger="none"', () => {
    const tags = ABOUT.match(
      /<Animated\w+|<CraftsmanshipLines|<FurnitureAssembly|<CategoryIllustration/g,
    );
    expect(tags).toHaveLength(1);
    expect(ABOUT).toContain('<AnimatedRoom');
    const start = ABOUT.indexOf('<AnimatedRoom');
    const block = ABOUT.slice(start, ABOUT.indexOf('/>', start));
    expect(block).toContain('trigger="none"');
    expect(block).toContain('title=');
  });

  it('keeps PlaceholderCopy for page.about.body — no hardcoded history is written', () => {
    expect(ABOUT).toContain('<PlaceholderCopy');
    expect(ABOUT).toContain('contentKey="page.about.body"');
  });

  it('has a values band expressed as claim-free positioning', () => {
    expect(ABOUT).toContain('ngf-about-values');
    expect(ABOUT).toContain('Made to order');
    expect(ABOUT).toContain('Direct from the workshop');
  });

  it('offers the WhatsApp and Call CTA and invents no year, count, award or guarantee', () => {
    expect(ABOUT).toContain('<WhatsAppLink');
    expect(ABOUT).toContain('<CallLink');
    for (const pattern of FABRICATION_PATTERNS) {
      expect(pattern.test(ABOUT), `about must not claim ${String(pattern)}`).toBe(false);
    }
  });
});

describe('workshop — an architectural story on drawing-board panels', () => {
  it('reuses the .ngf-process drawing-board sequence as its own top-level section', () => {
    expect(WORKSHOP).toMatch(/<section class="ngf-process" aria-labelledby="[^"]+">/);
    expect(WORKSHOP).toContain('ngf-process-steps');
    // The sequence is one data-reveal + data-motion-group container — one animating element.
    expect(WORKSHOP).toMatch(/ngf-process-steps[^>]*data-reveal data-motion-group/);
  });

  it('draws the drawing-board panel on cream with a 24px hairline grid, taupe border and xl radius', () => {
    const panel = WORKSHOP.slice(WORKSHOP.indexOf('.ngf-process-panel {'));
    expect(panel).toMatch(/background-color:\s*var\(--color-cream\)/);
    expect(panel).toMatch(/border:\s*1px solid var\(--color-taupe\)/);
    expect(panel).toMatch(/border-radius:\s*var\(--radius-xl\)/);
    expect(panel).toContain('background-size: 24px 24px');
    expect(panel).toMatch(/aspect-ratio:\s*4 \/ 3/);
  });

  it('uses at most four distinct reused primitives, and no new or fifth primitive', () => {
    const distinct = new Set(
      [
        ...WORKSHOP.matchAll(
          /<(Animated\w+|CraftsmanshipLines|FurnitureAssembly|CategoryIllustration)\b/g,
        ),
      ].map((m) => m[1]),
    );
    expect(distinct.size).toBeLessThanOrEqual(4);
    // The four the sequence uses are the four furniture silhouettes — the ones the site would
    // otherwise render nowhere, so drawing them here keeps the nine-illustration set complete.
    expect(WORKSHOP).toContain('<AnimatedSofa');
    expect(WORKSHOP).toContain('<AnimatedBed');
    expect(WORKSHOP).toContain('<AnimatedTable');
    expect(WORKSHOP).toContain('<AnimatedChair');
  });

  it('renders every stage illustration titled and as a static final state (trigger="none")', () => {
    for (const tag of ['AnimatedSofa', 'AnimatedBed', 'AnimatedTable', 'AnimatedChair']) {
      const start = WORKSHOP.indexOf(`<${tag}`);
      expect(start, `${tag} must be rendered`).toBeGreaterThan(-1);
      const block = WORKSHOP.slice(start, WORKSHOP.indexOf('/>', start));
      expect(block, `${tag} must use trigger="none"`).toContain('trigger="none"');
      expect(block, `${tag} must carry a descriptive title`).toContain('title=');
    }
  });

  it('keeps the honest PlaceholderCopy for page.workshop.body and fabricates no photograph or process', () => {
    expect(WORKSHOP).toContain('<PlaceholderCopy');
    expect(WORKSHOP).toContain('contentKey="page.workshop.body"');
    // No <img>/photograph is introduced, and no process/timeline claim is written.
    expect(WORKSHOP).not.toMatch(/<img\b/);
    expect(WORKSHOP).not.toContain('ResponsiveImage');
    for (const pattern of FABRICATION_PATTERNS) {
      expect(pattern.test(WORKSHOP), `workshop must not claim ${String(pattern)}`).toBe(false);
    }
  });

  it('keeps the reveal visible-by-default — the connecting line rests at full extent', () => {
    // Default is scaleY(1); the from-state (scale 0) lives only inside prefers-reduced-motion:
    // no-preference, gated on :not([data-revealed]) — never inverted so a broken script cannot hide.
    expect(WORKSHOP).toMatch(
      /\.ngf-process-step:not\(\.ngf-process-step-last\)::after[\s\S]*?transform: scaleY\(1\)/,
    );
    expect(WORKSHOP).toMatch(
      /prefers-reduced-motion: no-preference[\s\S]*?\[data-reveal\]:not\(\[data-revealed\]\) \.ngf-process-step::after \{\s*transform: scaleY\(0\)/,
    );
  });
});

describe('gallery — the lookbook grid and the live empty state', () => {
  it('keeps the composed EmptyState empty path with the homepage GallerySection wording', () => {
    expect(GALLERY).toContain('<EmptyState');
    expect(GALLERY).toContain('Photography is in progress');
    // The Ask-for-photographs WhatsApp CTA + Call — the error-states.test.ts contract.
    expect(GALLERY).toContain('Ask for photographs');
    expect(GALLERY).toContain('<CallLink');
  });

  it('draws the populated path as a lookbook with image-reveal masks and hover zoom', () => {
    expect(GALLERY).toContain('ngf-lookbook');
    // The image reveal mask — clip-path only, so the box never resizes.
    expect(GALLERY).toContain('data-reveal="mask"');
    // The subtle hover zoom scales the image inside its clipped frame.
    expect(GALLERY).toMatch(/\.ngf-lookbook-link:hover[\s\S]*?transform: scale\(/);
    expect(GALLERY).toMatch(/border-radius:\s*var\(--radius-xl\)/);
  });

  it('links every tile to the product it shows and preserves the image-loading discipline', () => {
    expect(GALLERY).toContain('href={`/product/${tile.product.slug}`}');
    expect(GALLERY).toContain('<ResponsiveImage');
    // The first tile is priority; eagerness is decided by the shared staging helper, not per tile.
    expect(GALLERY).toContain('priority={index === 0}');
    expect(GALLERY).toContain('isEagerCard(index)');
  });
});

describe('reviews — admin-controlled, no aggregate rating, honest empty state', () => {
  it('reads only from getPublishedReviews and adds no filter of its own', () => {
    expect(REVIEWS).toContain('getPublishedReviews()');
  });

  it('renders the premium empty state with the homepage CustomerReviews wording as the live path', () => {
    expect(REVIEWS).toContain('<EmptyState');
    expect(REVIEWS).toContain('No reviews published yet');
    expect(REVIEWS).toContain('We would rather show none than write our own');
    expect(REVIEWS).toContain('tone="page"');
    // The next action stays a slot — the error-states.test.ts contract.
    expect(REVIEWS).toContain('slot="action"');
  });

  it('emits no aggregateRating structured data and keeps the testimonial note', () => {
    // The page passes no jsonLd to pageMeta, so it cannot emit an aggregateRating (or any) block —
    // the frontmatter's pageMeta call has no `jsonLd:` key. `aggregateRating` appears only in the
    // explanatory docstring, never in a rendered JSON-LD payload.
    const frontmatter = REVIEWS.slice(0, REVIEWS.indexOf('---', 3));
    expect(frontmatter).not.toContain('jsonLd');
    expect(REVIEWS).toContain('We\n      publish no overall rating and emit no rating markup');
  });

  it('creates no fake review — the only review fields come from the record', () => {
    // No hardcoded customer name/quote: every field is read off `review.*`.
    expect(REVIEWS).toContain('review.customerName');
    expect(REVIEWS).toContain('review.rating');
    expect(REVIEWS).toContain('review.text');
    for (const pattern of FABRICATION_PATTERNS) {
      expect(pattern.test(REVIEWS), `reviews must not claim ${String(pattern)}`).toBe(false);
    }
  });
});

describe('contact — simple, both numbers, no invented location', () => {
  it('shows the business name and both numbers via ContactNumbers with WhatsApp and Call', () => {
    expect(CONTACT).toContain('<ContactNumbers');
    expect(CONTACT).toContain('<WhatsAppLink');
    expect(CONTACT).toContain('<CallLink');
    // No hand-rolled channels — the shared components own the URLs.
    expect(CONTACT).not.toMatch(/wa\.me/);
    expect(CONTACT).not.toMatch(/href="tel:/);
  });

  it('offers a custom-furniture CTA pointing at the enquiry page', () => {
    expect(CONTACT).toMatch(/href="\/custom-furniture"/);
    expect(CONTACT).toContain('ngf-contact-custom-cta');
  });

  it('renders the service area from settings only', () => {
    expect(CONTACT).toContain('serviceArea.join');
  });

  it('keeps the honest address notice and invents no address, hours, coordinates or social', () => {
    expect(CONTACT).toContain('Address not published yet');
    // The location block stays conditional on the settings value.
    expect(CONTACT).toContain('hasAddress ?');
    expect(CONTACT).toContain('location.mapUrl !== null');
    expect(CONTACT).toContain('socialLinks.length > 0');
    // No fabricated postal code, hours, or literal coordinate string in the source.
    expect(CONTACT).not.toMatch(/\bMon(?:day)?[–-]/i);
    expect(CONTACT).not.toMatch(/\b\d{1,2}\s*(?:am|pm)\b/i);
  });

  it('keeps localBusinessJsonLd and the enquiry/callback forms', () => {
    expect(CONTACT).toContain('localBusinessJsonLd');
    expect(CONTACT).toContain('<EnquiryIsland form="contact"');
    expect(CONTACT).toContain('<EnquiryIsland form="callback"');
  });
});
