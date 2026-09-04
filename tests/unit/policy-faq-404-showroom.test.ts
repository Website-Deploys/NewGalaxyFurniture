import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The FAQ, the six policy pages and the 404 page as source-level invariants (Milestone 3,
 * Checkpoint E — the final relight).
 *
 * Checkpoint E brings /faq, /privacy, /terms, /shipping, /returns, /warranty (all six through the
 * shared `PolicyPage.astro`) and /404 into the premium light-showroom system WITHOUT loosening any
 * of the fact-discipline, no-fabrication, accessibility, no-index or motion-budget rules those pages
 * already carried. These are source assertions in the style of `supporting-pages-showroom.test.ts`:
 * the site has no page-render harness, and each assertion is written so it FAILS if the redesign
 * were reverted or a load-bearing contract (the finalisation notice, the no-terms discipline, the
 * no-JS accordion, the branded-but-noindex 404, the visible-by-default reveal) were broken.
 */

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

/**
 * The customer-visible surface of an `.astro` source: what remains after the explanatory
 * documentation, the JSX comments, and the scoped `<style>` block are removed. The
 * anti-fabrication and no-developer-string checks run against THIS, so a regex cannot false-fail on
 * a word that only ever appears in a code comment (e.g. the docstring that explains why a term is
 * NOT stated) or in a CSS value (e.g. `background-size: 100% 1px`).
 */
const rendered = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments (frontmatter docstrings, CSS comments)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ') // JSX comments
    .replace(/<!--[\s\S]*?-->/g, ' ') // HTML comments
    .replace(/<style[\s\S]*?<\/style>/gi, ' ') // scoped styles
    .replace(/<script[\s\S]*?<\/script>/gi, ' '); // inline scripts

const POLICY = read('src/components/ui/PolicyPage.astro');
const FAQ = read('src/pages/faq.astro');
const NOT_FOUND = read('src/pages/404.astro');
const WORKSHOP = read('src/pages/workshop.astro');

const POLICY_PAGES: [string, string, string][] = [
  ['privacy', 'src/pages/privacy.astro', 'page.privacy.body'],
  ['terms', 'src/pages/terms.astro', 'page.terms.body'],
  ['shipping', 'src/pages/shipping.astro', 'page.shipping.body'],
  ['returns', 'src/pages/returns.astro', 'page.returns.body'],
  ['warranty', 'src/pages/warranty.astro', 'page.warranty.body'],
];

/**
 * Developer-flavoured strings that must NEVER reach a customer-visible line. A raw content key
 * (`page.*.body`) is allowed only as an attribute value (`data-content-key`, `contentKey=`), never
 * as rendered prose.
 */
const DEVELOPER_STRINGS: RegExp[] = [
  /\[PLACEHOLDER\]/i,
  /Awaiting content/i,
  />\s*undefined\s*</,
  />\s*null\s*</,
];

/** Numeric policy terms that must not be printed on a policy or FAQ page. */
const NUMERIC_TERM_PATTERNS: RegExp[] = [
  /\b\d+\s*(?:year|month|week|day|hour)s?\b/i,
  /\b\d+\s*%/,
  /\b(?:₹|rs\.?|inr)\s*\d/i,
];

describe('workshop — the glued inline-link bug is fixed', () => {
  it('renders "on the contact page" with a real space before the contact link', () => {
    // The bug: `published on the` ended a line and `<a href="/contact">` began the next, so Astro
    // collapsed the newline and rendered "published on thecontact page". The fix keeps the word and
    // the opening tag on one line (or inserts an explicit space), so the space survives.
    expect(WORKSHOP).not.toMatch(/on the\s*\n\s*<a href="\/contact">/);
    expect(WORKSHOP).toMatch(/on the <a href="\/contact"[\s\S]*?>contact page/);
  });

  it('leaves no prose word glued directly against an inline anchor anywhere in the page', () => {
    expect(WORKSHOP).not.toMatch(/[a-z]<a\s/);
    expect(WORKSHOP).not.toMatch(/<\/a>[a-z]/);
  });
});

describe('PolicyPage — the shared shell, relit but honest', () => {
  it('keeps the visible finalisation notice as a role="note" directing to contact', () => {
    expect(POLICY).toContain('role="note"');
    expect(POLICY).toContain('This policy is being finalised');
    // Both conversion controls live inside the notice.
    expect(POLICY).toContain('<WhatsAppLink');
    expect(POLICY).toContain('<CallLink');
  });

  it('keeps the operator-checklist attribute and the source-only business-review marker', () => {
    expect(POLICY).toContain('data-content-key={contentKey}');
    // The marker is an HTML comment: present in source, absent from rendered text.
    expect(POLICY).toContain('[FOR BUSINESS REVIEW]');
    expect(POLICY).toMatch(/\{\/\*\s*\[FOR BUSINESS REVIEW\]/);
  });

  it('renders only each section prompt and carries no term prop through which a value could pass', () => {
    // Each section renders `section.prompt`, never a `body`/`value`/`term`.
    expect(POLICY).toContain('{section.prompt}');
    expect(POLICY).not.toMatch(/section\.(?:body|value|term|window|period|timeframe)/);
    // The interface exposes only heading + prompt.
    expect(POLICY).toMatch(
      /interface PolicySection[\s\S]*?heading: string;[\s\S]*?prompt: string;/,
    );
  });

  it('marks the customer-facing outstanding line findable but never prints a developer string', () => {
    expect(POLICY).toContain('data-ngf-awaiting-content');
    // The visible sentence is reassuring customer copy, not a status token.
    expect(POLICY).toContain('We are finalising the exact wording of this section');
    const visible = rendered(POLICY);
    for (const pattern of DEVELOPER_STRINGS) {
      expect(pattern.test(visible), `PolicyPage must not render ${String(pattern)}`).toBe(false);
    }
  });

  it('is relit into the light-showroom system: reveal head, card sections, restrained motion', () => {
    // Visible-by-default reveals opted in on the head and the section group — never inverted here.
    expect(POLICY).toContain('class="ngf-page-head" data-reveal data-motion-group');
    expect(POLICY).toContain('ngf-policy-sections');
    // The head carries exactly the light-showroom architectural hairline, not a heavy ornament.
    expect(POLICY).toContain('ngf-page-hairline');
    // No animation library, no continuous loop, no per-section data-reveal explosion.
    expect(POLICY).not.toMatch(/from ['"](?:gsap|framer|animejs|motion)['"]/);
  });
});

describe('each policy page mounts through PolicyPage with no term stated', () => {
  for (const [name, path, key] of POLICY_PAGES) {
    it(`${name} passes its contentKey and lead through PolicyPage and states no numeric term`, () => {
      const page = read(path);
      expect(page).toContain('<PolicyPage');
      expect(page).toContain(`contentKey="${key}"`);
      expect(page).toContain('lead=');
      // No delivery timeframe, return window, warranty length, price or percentage anywhere.
      const visible = rendered(page);
      for (const pattern of NUMERIC_TERM_PATTERNS) {
        expect(pattern.test(visible), `${name} must not state ${String(pattern)}`).toBe(false);
      }
      for (const pattern of DEVELOPER_STRINGS) {
        expect(pattern.test(visible), `${name} must not render ${String(pattern)}`).toBe(false);
      }
    });
  }
});

describe('faq — premium accordion, no-JS, fact-only', () => {
  it('keeps the <details>/<summary> accordion and its content-checklist key', () => {
    expect(FAQ).toContain('<details>');
    expect(FAQ).toContain('<summary>');
    expect(FAQ).toContain('data-content-key="page.faq.entries"');
  });

  it('keeps PlaceholderCopy for page.faq.entries so the answers stay on the checklist', () => {
    expect(FAQ).toContain('<PlaceholderCopy');
    expect(FAQ).toContain('contentKey="page.faq.entries"');
  });

  it('answers the three answerable questions only from established facts', () => {
    // No cart/checkout (a fact about the site).
    expect(FAQ).toContain('there is no cart, no checkout');
    // Both numbers are equivalent.
    expect(FAQ).toContain('Both numbers are for orders and enquiries');
    // Manufactures in Bengaluru and serves the settings service area.
    expect(FAQ).toContain('We manufacture in Bengaluru');
    expect(FAQ).toContain('serviceArea');
  });

  it('gives every unanswered question the claim-free ask-us copy plus a policy pointer', () => {
    expect(FAQ).toContain('We have not finalised this yet');
    expect(FAQ).toContain('Will be published on ');
    // The pointers link to the real policy routes, never a fabricated term.
    expect(FAQ).toContain("href: '/shipping'");
    expect(FAQ).toContain("href: '/returns'");
    expect(FAQ).toContain("href: '/warranty'");
  });

  it('is relit as light-showroom cards with a visible-by-default reveal, no term stated', () => {
    expect(FAQ).toContain('class="ngf-faq"');
    expect(FAQ).toContain('data-reveal data-motion-group');
    const visible = rendered(FAQ);
    for (const pattern of NUMERIC_TERM_PATTERNS) {
      expect(pattern.test(visible), `faq must not state ${String(pattern)}`).toBe(false);
    }
  });
});

describe('404 — branded, helpful, but still a real noindex 404', () => {
  it('renders a Fraunces heading via the shared .ngf-page-head language', () => {
    expect(NOT_FOUND).toContain('class="ngf-page-head"');
    expect(NOT_FOUND).toContain('data-ngf-404-heading');
  });

  it('adds helpful navigation: home, collection and custom-furniture, plus WhatsApp and Call', () => {
    expect(NOT_FOUND).toContain('href="/"');
    expect(NOT_FOUND).toContain('href="/collection"');
    expect(NOT_FOUND).toContain('href="/custom-furniture"');
    expect(NOT_FOUND).toContain('<WhatsAppLink');
    expect(NOT_FOUND).toContain('<CallLink');
  });

  it('stays a real 404: keeps noindex and the EmptyState composition', () => {
    expect(NOT_FOUND).toContain('noindex: true');
    expect(NOT_FOUND).toContain('<EmptyState');
  });

  it('keeps the progressive-enhancement path-sharpening script and introduces no new one', () => {
    // The one allowed inline script: text-only, textContent, for /collection/* and /product/*.
    expect(NOT_FOUND).toContain('data-ngf-404-message');
    expect(NOT_FOUND).toContain('window.location.pathname');
    expect(NOT_FOUND).toContain('.textContent');
    // Exactly one <script> block, no inline event handler attributes.
    expect(NOT_FOUND.match(/<script/g) ?? []).toHaveLength(1);
    expect(NOT_FOUND).not.toMatch(/\son(?:click|load|error|mouseover)=/i);
  });

  it('shows no bare "Not Found"/standalone "Error" body text', () => {
    // The heading is the branded "Page not found"/sharpened copy, never a bare error string.
    expect(NOT_FOUND).not.toMatch(/>\s*Not Found\s*</);
    expect(NOT_FOUND).not.toMatch(/>\s*Error\s*</);
  });
});
