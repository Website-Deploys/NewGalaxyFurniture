import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The custom-furniture guided process, as source-level invariants (Milestone 3, Checkpoint C).
 *
 * Checkpoint C redesigns `/custom-furniture` into a premium guided sequence — DISCOVER → DESIGN →
 * CRAFT → DELIVER — while keeping every conversion path the page already carried: the
 * `CustomFurnitureForm` enquiry island, the before/after comparison slider the e2e suite depends
 * on, and the WhatsApp/Call controls. These are source assertions in the style of
 * `catalogue-hero.test.ts` and `product-detail-showroom.test.ts`: the site has no page-render
 * harness, and each assertion is written so it FAILS if the feature were reverted or a load-bearing
 * contract (four reused primitives, no new primitive, the visible-by-default reveal, the claim-free
 * copy, the CTA order) were broken.
 */

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const PAGE = read('src/pages/custom-furniture.astro');

describe('the four-stage guided process (Milestone 3, Checkpoint C)', () => {
  it('names the four stages in order: Discover, Design, Craft, Deliver', () => {
    const titles = ['Discover', 'Design', 'Craft', 'Deliver'];
    const positions = titles.map((title) => PAGE.indexOf(`title: '${title}'`));
    // Every stage title is present.
    for (const [index, position] of positions.entries()) {
      expect(position, `${titles[index]} must appear`).toBeGreaterThan(-1);
    }
    // And in the required order.
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it('numbers the stages 01 through 04', () => {
    for (const step of ['01', '02', '03', '04']) {
      expect(PAGE).toContain(`step: '${step}'`);
    }
  });

  it('maps each stage to one of the four reused primitives, in DISCOVER→DELIVER order', () => {
    // DISCOVER → room outline, DESIGN → dimension/blueprint lines, CRAFT → joinery/assembly,
    // DELIVER → finished silhouette. The order the components appear in the template must match.
    const room = PAGE.indexOf('<AnimatedRoom');
    const lines = PAGE.indexOf('<CraftsmanshipLines');
    const assembly = PAGE.indexOf('<FurnitureAssembly');
    const finished = PAGE.indexOf('<AnimatedFurnitureLine');
    for (const [name, pos] of [
      ['AnimatedRoom', room],
      ['CraftsmanshipLines', lines],
      ['FurnitureAssembly', assembly],
      ['AnimatedFurnitureLine', finished],
    ] as const) {
      expect(pos, `${name} must be rendered`).toBeGreaterThan(-1);
    }
    expect(room).toBeLessThan(lines);
    expect(lines).toBeLessThan(assembly);
    expect(assembly).toBeLessThan(finished);
  });

  it('invents no new primitive: only the four reused ones and the decorative arrow appear', () => {
    // A fifth distinct primitive on the page would break the motion budget. The stage illustrations
    // are exactly the four established primitives; the DELIVER arrow is ArrowMotion, which is not a
    // primitive (it carries no data-ngf-primitive). No AnimatedSofa/Bed/Chair/Table/CategoryIllustration.
    for (const forbidden of [
      '<AnimatedSofa',
      '<AnimatedBed',
      '<AnimatedChair',
      '<AnimatedTable',
      '<CategoryIllustration',
    ]) {
      expect(PAGE, `${forbidden} must not be added`).not.toContain(forbidden);
    }
    expect(PAGE).toContain('<ArrowMotion');
  });

  it('draws each stage primitive as a static final state — trigger="none", so no data-reveal of its own', () => {
    // Every one of the four primitive tags carries trigger="none": it renders drawn and folded into
    // the group reveal rather than emitting its own data-reveal. Count the tags, count the triggers.
    const primitiveTags = PAGE.match(
      /<(?:AnimatedRoom|CraftsmanshipLines|FurnitureAssembly|AnimatedFurnitureLine)\b/g,
    );
    expect(primitiveTags).toHaveLength(4);
    // Each of the four blocks contains trigger="none".
    for (const tag of ['AnimatedRoom', 'CraftsmanshipLines', 'FurnitureAssembly', 'AnimatedFurnitureLine']) {
      const start = PAGE.indexOf(`<${tag}`);
      const end = PAGE.indexOf('/>', start);
      const block = PAGE.slice(start, end);
      expect(block, `${tag} must use trigger="none"`).toContain('trigger="none"');
      // Titled, so it is a meaningful role="img" rather than aria-hidden.
      expect(block, `${tag} must carry a descriptive title`).toContain('title=');
    }
  });

  it('wraps the sequence in one data-reveal + data-motion-group container', () => {
    // The whole sequence counts as ONE animating element and staggers in as one group.
    expect(PAGE).toMatch(/ngf-process-steps[^>]*data-reveal data-motion-group/);
  });

  it('keeps the process section as its own top-level section with an accessible heading', () => {
    expect(PAGE).toMatch(/<section class="ngf-process" aria-labelledby="ngf-process-heading">/);
    expect(PAGE).toMatch(/id="ngf-process-heading"/);
  });
});

describe('the connecting line is CSS/SVG, transform-only and reduced-motion-safe', () => {
  it('sits at full extent by default and scales from 0 only in the no-preference not-revealed branch', () => {
    // Full extent is the default (scaleY(1)/scaleX(1)); the from-state (scale 0) lives only inside
    // prefers-reduced-motion: no-preference, gated on :not([data-revealed]) — never inverted.
    expect(PAGE).toMatch(/\.ngf-process-step:not\(\.ngf-process-step-last\)::after[\s\S]*?transform: scaleY\(1\)/);
    expect(PAGE).toMatch(/\.ngf-process-step:not\(\.ngf-process-step-last\)::after[\s\S]*?transition: transform/);
    expect(PAGE).toMatch(
      /prefers-reduced-motion: no-preference[\s\S]*?\[data-reveal\]:not\(\[data-revealed\]\) \.ngf-process-step::after \{\s*transform: scaleY\(0\)/,
    );
    // The animating property is transform, never width/height, so it costs no layout, and there is
    // no continuous loop.
    const connector = PAGE.slice(
      PAGE.indexOf('.ngf-process-step:not(.ngf-process-step-last)::after {'),
    );
    expect(connector).not.toMatch(/animation:[^;]*infinite/);
  });
});

describe('the drawing-board panel keeps the light-showroom language', () => {
  it('is a cream ground with a 24px hairline grid, a taupe border and the xl radius', () => {
    const panel = PAGE.slice(PAGE.indexOf('.ngf-process-panel {'));
    expect(panel).toMatch(/background-color:\s*var\(--color-cream\)/);
    expect(panel).toMatch(/border:\s*1px solid var\(--color-taupe\)/);
    expect(panel).toMatch(/border-radius:\s*var\(--radius-xl\)/);
    expect(panel).toContain('background-size: 24px 24px');
  });

  it('reserves the illustration frame with a fixed aspect-ratio so drawing it shifts no layout', () => {
    const panel = PAGE.slice(PAGE.indexOf('.ngf-process-panel {'));
    expect(panel).toMatch(/aspect-ratio:\s*4 \/ 3/);
  });
});

describe('every conversion path the page already carried survives', () => {
  it('still renders the custom enquiry island in its reserved slot', () => {
    expect(PAGE).toContain('data-ngf-custom-enquiry-slot');
    expect(PAGE).toMatch(/<EnquiryIsland form="custom" context=\{\{ kind: 'custom' \}\}/);
  });

  it('renders exactly one before/after comparison (one [role=slider] for the e2e suite)', () => {
    const matches = PAGE.match(/<BeforeAfterRoom\b/g);
    expect(matches).toHaveLength(1);
  });

  it('keeps the descriptive body flowing from the operator content key, not hardcoded claims', () => {
    // The "what we can change" copy still comes from the homepage customFurniture section via
    // PlaceholderCopy, so the operator edits one place and no capability is baked into markup.
    expect(PAGE).toContain('getHomepage()');
    expect(PAGE).toContain("key === 'customFurniture'");
    expect(PAGE).toContain('contentKey="homepage.customFurniture.body"');
  });

  it('uses the shared WhatsApp/Call components, never hand-rolled wa.me or tel: URLs', () => {
    expect(PAGE).toContain('<WhatsAppLink');
    expect(PAGE).toContain('<CallLink');
    expect(PAGE).not.toMatch(/wa\.me/);
    expect(PAGE).not.toMatch(/href="tel:/);
    // ContactNumbers stays, with no sales/support labelling.
    expect(PAGE).toContain('<ContactNumbers');
  });
});

describe('the CTA hierarchy is WhatsApp → Call → enquiry form in reading order', () => {
  it('presents WhatsApp before Call before the form island', () => {
    const whatsapp = PAGE.indexOf('<WhatsAppLink');
    const call = PAGE.indexOf('<CallLink');
    const form = PAGE.indexOf('<EnquiryIsland');
    expect(whatsapp).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(whatsapp);
    expect(form).toBeGreaterThan(call);
  });
});

describe('the stage copy claims no unsupplied fact (Requirement 8.4 discipline)', () => {
  it('states no lead time, price, quantity, warranty, "since <year>" or "<n> years"', () => {
    // The same claim families homepage.contracts.test.ts forbids, applied to every stage sentence.
    const forbidden = [
      /\b\d+\s*(?:-|\s)?\s*(?:day|days|week|weeks|month|months|year|years)\b/i,
      /\b(?:₹|rs\.?|inr)\s*\d/i,
      /\bsince\s+(?:19|20)\d{2}\b/i,
      /\b\d+\+?\s*years?\b/i,
      /\b\d[\d,]*\s*(?:pieces|customers|homes|orders|clients)\b/i,
      /\bfree (?:delivery|shipping)\b/i,
      /\b(?:money[- ]back|lifetime|guarantee[d]?|warrant(?:y|ies))\b/i,
    ];
    // Pull the stage copy strings out of the frontmatter array.
    const copyMatches = [...PAGE.matchAll(/copy:\s*'([^']+)'/g)].map((match) => match[1] ?? '');
    expect(copyMatches.length).toBe(4);
    for (const copy of copyMatches) {
      for (const pattern of forbidden) {
        expect(pattern.test(copy), `stage copy must not claim ${String(pattern)}: ${copy}`).toBe(
          false,
        );
      }
    }
  });
});
