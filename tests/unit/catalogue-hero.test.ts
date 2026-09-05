import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The catalogue heroes, as source-level invariants.
 *
 * Checkpoint A of Milestone 3 gives `/collection` and every `/collection/{slug}` a premium
 * catalogue opener: a copy column (eyebrow, breadcrumb on a category, title, the category's own
 * supporting copy, the honest count) beside a drawing-board panel holding a line illustration at
 * showroom scale. The load-bearing property is that a **category** page is not a clone of the
 * generic index — it renders its own `shortDescription` and its own `CategoryIllustration`.
 *
 * These are source-level assertions rather than a rendered-DOM harness because the site has no
 * page-render test fixture; the properties worth protecting live in the page source and the shared
 * stylesheet, and asserting them there fails in the editor rather than only in a screenshot.
 */

const CATEGORY_PAGE = readFileSync(
  fileURLToPath(new URL('../../src/pages/collection/[category].astro', import.meta.url)),
  'utf8',
);
const INDEX_PAGE = readFileSync(
  fileURLToPath(new URL('../../src/pages/collection/index.astro', import.meta.url)),
  'utf8',
);
const SHELL_CSS = readFileSync(
  fileURLToPath(new URL('../../src/styles/shell.css', import.meta.url)),
  'utf8',
);

describe('the category catalogue hero (Milestone 3, Checkpoint A)', () => {
  it('renders the category-specific illustration by its schema key', () => {
    // The distinct visual identity: each category page draws its own glyph from the schema's
    // `illustration` field, not a shared ornament. If this ever became a static drawing the
    // categories would all look alike, which is the exact regression this checkpoint forbids.
    expect(CATEGORY_PAGE).toMatch(
      /<CategoryIllustration[\s\S]*illustration=\{category\.illustration\}/,
    );
  });

  it('draws the category glyph on view so the outline → details sequence plays', () => {
    // Milestone 2: the hero glyph runs its own draw-on entrance (`trigger="inView"`) rather than
    // rendering flat, so each category's line-art reads as being measured and finished. The copy
    // column stays the hero's reveal group; the glyph is the one further animation in the section.
    expect(CATEGORY_PAGE).toMatch(/<CategoryIllustration[\s\S]*trigger="inView"/);
  });

  it('renders the category shortDescription and its intro copy in the hero', () => {
    expect(CATEGORY_PAGE).toContain('{category.shortDescription}');
    expect(CATEGORY_PAGE).toContain('category.intro !== undefined');
  });

  it('carries a WhatsApp enquiry CTA scoped to the category, without inventing a claim', () => {
    // The category surface's conversion endpoint. A category-kind enquiry names the category only
    // (no product, no price, no fabricated claim), and it is a real WhatsAppLink rather than a
    // hand-rolled control.
    expect(CATEGORY_PAGE).toContain('<WhatsAppLink');
    expect(CATEGORY_PAGE).toMatch(/kind: 'category', categoryName: category\.name/);
    expect(CATEGORY_PAGE).toContain('ngf-cathero-cta');
  });

  it('opens with the shared eyebrow + drawing-board panel, revealed as one group', () => {
    expect(CATEGORY_PAGE).toContain('ngf-cathero-eyebrow');
    expect(CATEGORY_PAGE).toContain('ngf-cathero-panel');
    // The copy column is a staggered reveal group, so the opener's copy counts as one element.
    expect(CATEGORY_PAGE).toMatch(/ngf-cathero[\s\S]*data-reveal data-motion-group/);
  });

  it('keeps the breadcrumb and the honest product count in the hero', () => {
    expect(CATEGORY_PAGE).toContain('ngf-catalogue-breadcrumbs');
    expect(CATEGORY_PAGE).toMatch(/1 product.*\$\{count\} products/s);
  });
});

describe('the enriched category illustrations (Milestone 2)', () => {
  const ILLUSTRATION = readFileSync(
    fileURLToPath(
      new URL('../../src/components/motion/CategoryIllustration.astro', import.meta.url),
    ),
    'utf8',
  );

  it('dispatches an architectural line-art glyph for each of the nine schema keys', () => {
    // The dispatch must stay exhaustive over the schema enum so a missing key is a TS error.
    for (const key of [
      'sofa',
      'bed',
      'diningTable',
      'diningChair',
      'accentChair',
      'coffeeTable',
      'storage',
      'office',
      'outdoor',
    ]) {
      expect(ILLUSTRATION).toMatch(new RegExp(`\\b${key}:\\s*\\[`));
    }
  });

  it('builds each glyph as a drawn outline plus faded-in detail parts', () => {
    // The outline draws (`.ngf-draw` / stroke-dashoffset) and the details settle in
    // (`.ngf-part` / opacity + transform) — the "outline → details → finished" sequence, using
    // only the two lint-permitted mechanisms.
    expect(ILLUSTRATION).toContain('ngf-draw');
    expect(ILLUSTRATION).toContain('ngf-part');
    expect(ILLUSTRATION).toContain('--ngf-part-delay');
    expect(ILLUSTRATION).toContain('--ngf-draw-delay');
  });
});

describe('the collection index hero', () => {
  it('opens with the shared hero language and keeps the furniture-line ornament', () => {
    expect(INDEX_PAGE).toContain('ngf-cathero');
    expect(INDEX_PAGE).toContain('ngf-cathero-eyebrow');
    // The site's required render of the furniture-line primitive stays on this page, still folded
    // into the hero's single group reveal with `trigger="none"`.
    expect(INDEX_PAGE).toContain('<AnimatedFurnitureLine');
    expect(INDEX_PAGE).toMatch(/<AnimatedFurnitureLine[\s\S]*trigger="none"/);
  });

  it('makes the reading order explicit with an in-hero category-navigation row', () => {
    // Milestone 2: the collection opener carries the way into each room between the title and the
    // controls, reusing CATEGORY_NAV so the row cannot drift from the footer or the empty state.
    expect(INDEX_PAGE).toContain("import { CATEGORY_NAV } from '@/lib/site/navigation'");
    expect(INDEX_PAGE).toContain('ngf-cathero-nav');
    expect(INDEX_PAGE).toMatch(/CATEGORY_NAV\.map\(/);
  });

  it('keeps the whole hero, navigation row included, a single reveal group', () => {
    // The category nav is the hero's last group child, so the opener still counts as one animating
    // element against the motion budget.
    expect(INDEX_PAGE).toMatch(/ngf-cathero[\s\S]*data-reveal data-motion-group/);
    expect(INDEX_PAGE).toMatch(/data-reveal data-motion-group[\s\S]*ngf-cathero-nav/);
  });
});

describe('the hero stylesheet', () => {
  it('draws the drawing-board panel on a cream ground with a hairline grid and a taupe border', () => {
    const panel = SHELL_CSS.slice(SHELL_CSS.indexOf('.ngf-cathero-panel {'));
    expect(panel).toMatch(/background-color:\s*var\(--color-cream\)/);
    expect(panel).toMatch(/border:\s*1px solid var\(--color-taupe\)/);
    expect(panel).toMatch(/border-radius:\s*var\(--radius-xl\)/);
    expect(panel).toContain('background-size: 24px 24px');
  });

  it('holds the technical dimension rule in the final state under reduced motion', () => {
    // The rule scales out from centre only inside the no-preference block; its default is full width.
    const ruleDefault = SHELL_CSS.slice(
      SHELL_CSS.indexOf('.ngf-cathero-rule {'),
      SHELL_CSS.indexOf('.ngf-cathero-rule::before'),
    );
    expect(ruleDefault).toContain('transform: scaleX(1)');
    expect(SHELL_CSS).toMatch(
      /prefers-reduced-motion: no-preference[\s\S]*?\.ngf-cathero-rule\s*\{\s*transform: scaleX\(0\)/,
    );
  });
});
