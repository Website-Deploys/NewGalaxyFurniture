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

/*
 * The /about and /workshop blocks below were refreshed for the photograph-based redesign:
 *   - about:    `0e923a8 feat(about): replace the Our story placeholder with a photo band`
 *   - workshop: `0c4ad56 feat(workshop): restructure as a two-column how-it-works story`
 *
 * The earlier assertions pinned the intermediate "drawing-board" design — a `.ngf-cathero-panel`,
 * an `<AnimatedRoom>` brand mark, a `<PlaceholderCopy>` body, a `.ngf-process` step sequence, and
 * (on workshop) the absence of any `<img>`. The pages have since moved to a real showroom/workbench
 * photograph with claim-free copy, which is the current intended design. These tests now assert
 * that design instead, while KEEPING every no-fabrication guard the originals carried: the
 * FABRICATION_PATTERNS sweep (no years, counts, awards, free delivery, guarantees) still runs on
 * both pages unchanged, so adding a photograph did not loosen the no-invented-facts discipline.
 */
describe('about — the premium photo hero, the claim-free story and the values band', () => {
  it('opens with the shared .ngf-cathero hero carrying the real showroom photograph, revealed as one group', () => {
    expect(ABOUT).toContain('ngf-cathero');
    expect(ABOUT).toContain('ngf-cathero-eyebrow');
    // The drawing-board panel was replaced by a real, ratio-reserved showroom photograph.
    expect(ABOUT).toContain('ngf-abouthero-figure');
    // The whole hero is one staggered reveal group — it counts as a single animating element.
    expect(ABOUT).toMatch(/ngf-cathero[\s\S]*data-reveal data-motion-group/);
  });

  it('renders the business name as the h1 and the service area from settings', () => {
    expect(ABOUT).toContain('<h1>{settings.businessName}</h1>');
    expect(ABOUT).toContain('settings.serviceArea.join');
  });

  it('shows the showroom photograph as a titled, dimensioned, lazy-safe hero image', () => {
    // The hero is a real photograph now, not a reused line-drawing primitive. It is the page's one
    // prioritised image: eager + high fetch priority, with intrinsic width/height reserving its box
    // (the image-loading audit's rule 5) and descriptive alt text.
    const start = ABOUT.indexOf('ngf-abouthero-figure');
    expect(start, 'the about hero figure must be present').toBeGreaterThan(-1);
    const figure = ABOUT.slice(start, ABOUT.indexOf('</figure>', start));
    expect(figure).toMatch(/<img\b/);
    expect(figure).toContain('alt={ABOUT_HERO.alt}');
    expect(figure).toContain('width={ABOUT_HERO.width}');
    expect(figure).toContain('height={ABOUT_HERO.height}');
    expect(figure).toContain('loading="eager"');
    expect(figure).toContain('fetchpriority="high"');
    // No reused illustration primitive stands in for the photo any more.
    expect(ABOUT).not.toContain('<AnimatedRoom');
  });

  it('tells the Our-story through a photo band, not hardcoded history — the body stays on the checklist', () => {
    // The placeholder body component is gone from the page; the "Our story" band carries an
    // invitation to talk rather than a fabricated backstory. The checklist obligation for
    // `page.about.body` is enforced by site.admin/homepage.contracts against settings.placeholders,
    // not by a component in the page — so the page itself writes no history.
    expect(ABOUT).toContain('ngf-about-story');
    expect(ABOUT).not.toContain('<PlaceholderCopy');
    // No invented age/scale/achievement: the FABRICATION_PATTERNS sweep below is the real guard,
    // but spot-check the specific families the Our-story band is most tempted toward.
    expect(ABOUT).not.toMatch(/\bour\s+(?:story|journey)\s+began\b/i);
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

describe('workshop — a two-column how-it-works story beside a real workbench photograph', () => {
  it('lays out the how-it-works story in two columns with a sticky photograph aside', () => {
    expect(WORKSHOP).toContain('ngf-workshop-layout');
    expect(WORKSHOP).toContain('ngf-workshop-main');
    expect(WORKSHOP).toContain('ngf-workshop-aside');
    // The four furniture studies are one data-reveal + data-motion-group list — one animating element.
    expect(WORKSHOP).toMatch(/ngf-workshop-studies[^>]*data-reveal data-motion-group/);
  });

  it('carries the real workbench photograph as a titled, dimensioned, prioritised image', () => {
    // The redesign shows a real photograph of the making (Requirement 7.10 is satisfied by showing
    // what the workshop IS, while still asserting no unsupplied process/timeline/capability — the
    // FABRICATION_PATTERNS sweep below enforces that half). It is the page's single largest image:
    // eager + high fetch priority, with intrinsic dimensions reserving its box against CLS.
    const start = WORKSHOP.indexOf('ngf-workshop-photo');
    expect(start, 'the workshop photo figure must be present').toBeGreaterThan(-1);
    const figure = WORKSHOP.slice(start, WORKSHOP.indexOf('</figure>', start));
    expect(figure).toMatch(/<img\b/);
    expect(figure).toContain('alt={WORKSHOP_HERO.alt}');
    expect(figure).toContain('width={WORKSHOP_HERO.width}');
    expect(figure).toContain('height={WORKSHOP_HERO.height}');
    expect(figure).toContain('loading="eager"');
    expect(figure).toContain('fetchpriority="high"');
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
    // The four the studies use are the four furniture silhouettes — the ones the site would
    // otherwise render nowhere, so drawing them here keeps the nine-illustration set complete.
    expect(WORKSHOP).toContain('<AnimatedSofa');
    expect(WORKSHOP).toContain('<AnimatedBed');
    expect(WORKSHOP).toContain('<AnimatedTable');
    expect(WORKSHOP).toContain('<AnimatedChair');
  });

  it('renders every furniture study titled and as a static final state (trigger="none")', () => {
    for (const tag of ['AnimatedSofa', 'AnimatedBed', 'AnimatedTable', 'AnimatedChair']) {
      const start = WORKSHOP.indexOf(`<${tag}`);
      expect(start, `${tag} must be rendered`).toBeGreaterThan(-1);
      const block = WORKSHOP.slice(start, WORKSHOP.indexOf('/>', start));
      expect(block, `${tag} must use trigger="none"`).toContain('trigger="none"');
      expect(block, `${tag} must carry a descriptive title`).toContain('title=');
    }
  });

  it('shows a three-step commission outline and invents no process, timeline or capability', () => {
    // The honest "how it works" sequence: share an idea, get a plan & quote, we build it. Each is an
    // invitation to talk, never a promise. The page body is no longer a PlaceholderCopy component —
    // the checklist obligation for `page.workshop.body` lives in settings.placeholders, asserted by
    // the site.admin / homepage.contracts suites, not by a component here.
    expect(WORKSHOP).toContain('ngf-workshop-steps');
    expect(WORKSHOP).toContain('Share your idea');
    expect(WORKSHOP).toContain('Get a plan');
    // The no-invented-facts discipline is unchanged: no year, count, award, free delivery or
    // guarantee may appear anywhere in the page's prose.
    for (const pattern of FABRICATION_PATTERNS) {
      expect(pattern.test(WORKSHOP), `workshop must not claim ${String(pattern)}`).toBe(false);
    }
  });

  it('keeps the furniture studies visible-by-default via the shared reveal attributes', () => {
    // The studies opt into the site's reveal system with [data-reveal][data-motion-group], which is
    // visible-by-default: the from-state lives only inside prefers-reduced-motion: no-preference and
    // is gated on :not([data-revealed]), so a broken script can never hide the content. The page
    // relies on the shared mechanism rather than a page-local connector-line animation.
    expect(WORKSHOP).toMatch(/data-reveal data-motion-group/);
  });
});

describe('gallery — per-product boards and the live empty state', () => {
  it('keeps the composed EmptyState empty path with the homepage GallerySection wording', () => {
    expect(GALLERY).toContain('<EmptyState');
    expect(GALLERY).toContain('Photography is in progress');
    // The Ask-for-photographs WhatsApp CTA + Call — the error-states.test.ts contract.
    expect(GALLERY).toContain('Ask for photographs');
    expect(GALLERY).toContain('<CallLink');
  });

  it('draws the populated path as per-product GalleryBoard islands with filter tabs', () => {
    // One interactive board per product, hydrated when visible.
    expect(GALLERY).toContain('<GalleryBoard');
    expect(GALLERY).toContain('client:visible');
    // Tiles come from the shared server-side assembly, so the derivative ladder stays server-side.
    expect(GALLERY).toContain('resolvableGalleryTilesOf');
    // The "See it in your space" conversion card and the closing feature row.
    expect(GALLERY).toContain('ngf-gallery-feats');
    expect(GALLERY).toContain('Contact Us');
  });

  it('links every tile to the product it shows and prioritises exactly one lead image', () => {
    // Each board links to its own product page.
    expect(GALLERY).toContain('productHref={`/product/${board.product.slug}`}');
    // Only the first board's first tile is the prioritised, preloaded lead image.
    expect(GALLERY).toContain('leadTileId={boardIndex === 0 ? board.tiles[0]?.id : undefined}');
    // The preload hint is built from the lead tile itself, so preload and element pair up.
    expect(GALLERY).toContain('const leadTile = boards[0]?.tiles[0]');
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

describe('contact — reference two-column layout, both numbers, no invented location', () => {
  it('drives both numbers through the shared WhatsAppLink and CallLink, never a hand-rolled URL', () => {
    expect(CONTACT).toContain('<WhatsAppLink');
    expect(CONTACT).toContain('<CallLink');
    // No hand-rolled channels — the shared components own the URLs (Requirement 5.11).
    expect(CONTACT).not.toMatch(/wa\.me/);
    expect(CONTACT).not.toMatch(/href="tel:/);
  });

  it('lays the enquiry forms beside the three info cards from the reference', () => {
    expect(CONTACT).toContain('ngf-contact-grid');
    expect(CONTACT).toContain('Get in touch');
    expect(CONTACT).toContain('Or ask us to call you');
    expect(CONTACT).toContain('Visit our showroom');
    expect(CONTACT).toContain('Contact us directly');
    // The old showroom-photo hero is gone, so no empty band is left behind.
    expect(CONTACT).not.toContain('ngf-contact-hero');
    expect(CONTACT).not.toContain('Talk to us');
  });

  it('renders the service area from settings only', () => {
    expect(CONTACT).toContain('serviceArea.join');
  });

  it('keeps the honest address notice and invents no address, hours, coordinates or social', () => {
    expect(CONTACT).toContain('Address not published yet');
    // The location block stays conditional on the settings value.
    expect(CONTACT).toContain('hasAddress ?');
    expect(CONTACT).toContain('location.mapUrl !== null');
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
