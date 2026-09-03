import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { filterPublishedReviews } from '@/lib/content/reviews';
import {
  containsExecutableMarkup,
  escapeHtml,
  jsonScriptText,
  safeHref,
  safeText,
} from '@/lib/security/sanitize';
import type { Review } from '@/schemas/review';

import { NUM_RUNS } from './config';

/**
 * Property 55: Rendered user input contains no executable markup.
 *
 * **Validates: Requirements 16.10, 25.2**
 *
 * The design states it as: ∀ user-supplied strings rendered into HTML, the output contains no
 * executable markup (`<script`, `onerror=`, `javascript:`) after sanitization.
 *
 * The generator is a payload corpus rather than `fc.string()`, and that choice is the whole test. A
 * random string is overwhelmingly unlikely to contain a tag, so a property over `fc.string()` would
 * pass against a sanitizer that did nothing. The corpus is built from the shapes that actually
 * defeat naive sanitizers — an event handler with no quotes, a `javascript:` URL with an embedded
 * newline, a broken tag that a browser's error recovery repairs, an unterminated comment, a nested
 * `<scr<script>ipt>` that survives one pass of tag stripping — combined with, and embedded inside,
 * ordinary prose.
 *
 * The four templates the design names are covered by exercising the sanitizer at the point each one
 * calls it: the product card and the PDP through `safeText` on the name, description and
 * specifications; reviews through `filterPublishedReviews`, which sanitizes on read; and the lead
 * detail through the same `safeText` its store applies to every visitor-supplied column. Testing the
 * function they all share is stronger than testing four renders, because a fifth surface added later
 * gets the same guarantee.
 *
 * Design: Correctness Properties → Property 55.
 */

/* -------------------------------------------------------------------------- */
/* The payload corpus                                                         */
/* -------------------------------------------------------------------------- */

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil.test/x.js></SCRIPT>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<img src=x onerror=alert(1)>',
  '<img src="x" onerror="alert(1)">',
  '<img src=x onerror=alert`1`>',
  '<svg/onload=alert(1)>',
  '<body onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<object data="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></object>',
  '<embed src="javascript:alert(1)">',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="java\nscript:alert(1)">click</a>',
  '<style>@import "javascript:alert(1)";</style>',
  '<!--<script>alert(1)</script>-->',
  '<!-- unterminated comment <script>alert(1)</script>',
  '"><script>alert(1)</script>',
  "'><img src=x onerror=alert(1)>",
  '</textarea><script>alert(1)</script>',
  '</title><script>alert(1)</script>',
  '<base href="//evil.test/">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<form action="javascript:alert(1)"><button>go</button></form>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '<img src=x onerror=', // truncated, still dangerous once something is appended
  '<script',
  'javascript:alert(document.cookie)',
  'JaVaScRiPt:alert(1)',
  'vbscript:msgbox(1)',
  'data:text/html,<script>alert(1)</script>',
];

const PROSE = [
  'A three-seater sofa on a seasoned hardwood frame.',
  'Delivered to Bengaluru in two weeks — the frame is teak.',
  '5 < 6 & 7 > 2 is a true statement about numbers',
  'Ravi & Sons — "excellent finish"',
  'सोफा — दो सीटर', // non-Latin text must survive untouched in substance
  '',
];

/** An arbitrary that mixes a payload with prose, in either order, or nests one inside the other. */
const attacked = fc
  .tuple(
    fc.constantFrom(...PAYLOADS),
    fc.constantFrom(...PROSE),
    fc.constantFrom(...PROSE),
    fc.integer({ min: 0, max: 3 }),
  )
  .map(([payload, before, after, shape]) => {
    switch (shape) {
      case 0:
        return payload;
      case 1:
        return `${before} ${payload}`;
      case 2:
        return `${payload} ${after}`;
      default:
        return `${before} ${payload} ${after}`;
    }
  });

/** Ordinary text, for the assertions about what sanitization must *not* change. */
const prose = fc.constantFrom(...PROSE);

/* -------------------------------------------------------------------------- */
/* Property 55                                                                */
/* -------------------------------------------------------------------------- */

describe('Property 55: Rendered user input contains no executable markup', () => {
  it('leaves no executable markup in any sanitized value', () => {
    fc.assert(
      fc.property(attacked, (input) => {
        expect(containsExecutableMarkup(safeText(input))).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('leaves no tag of any kind, opened or closed', () => {
    fc.assert(
      fc.property(attacked, (input) => {
        const output = safeText(input);
        expect(output).not.toMatch(/<\/?[a-z]/i);
        expect(output).not.toContain('<!--');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is idempotent, so a value that passes through two surfaces is not double-processed', () => {
    fc.assert(
      fc.property(attacked, (input) => {
        const once = safeText(input);
        expect(safeText(once)).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is the identity on ordinary prose, so no visitor-visible text is altered', () => {
    fc.assert(
      fc.property(prose, (input) => {
        expect(safeText(input)).toBe(input.trim());
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('preserves paragraph breaks, which a description depends on', () => {
    expect(safeText('First paragraph.\n\nSecond paragraph.')).toBe(
      'First paragraph.\n\nSecond paragraph.',
    );
  });

  it('holds through the review reader, which is where the review templates get their text', () => {
    fc.assert(
      fc.property(attacked, attacked, (name, text) => {
        const review = {
          id: 'r_1',
          customerName: name === '' ? 'x' : name,
          rating: 5,
          text,
          status: 'PUBLISHED',
          featured: false,
          order: 0,
        } as Review;
        const [published] = filterPublishedReviews([review]);
        expect(published).toBeDefined();
        expect(containsExecutableMarkup(published?.customerName ?? '')).toBe(false);
        expect(containsExecutableMarkup(published?.text ?? '')).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('holds for every value the card, PDP and lead detail render', () => {
    /*
     * The fields, named as the templates name them: the card renders the name and the classification
     * label; the PDP adds the description, the specifications and the two free-text blocks; the lead
     * detail renders the enquirer's own name, message, budget and dimensions. All of them go through
     * `safeText`, which is what this asserts field by field so a rename cannot quietly drop one.
     */
    fc.assert(
      fc.property(
        fc.record({
          name: attacked,
          classification: attacked,
          description: attacked,
          material: attacked,
          colour: attacked,
          customization: attacked,
          deliveryInformation: attacked,
          alt: attacked,
          leadName: attacked,
          leadMessage: attacked,
          leadBudget: attacked,
          leadDimensions: attacked,
        }),
        (fields) => {
          for (const [field, value] of Object.entries(fields)) {
            const rendered = safeText(value);
            expect(containsExecutableMarkup(rendered), field).toBe(false);
            expect(rendered, field).not.toMatch(/<\/?[a-z]/i);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The supporting guarantees Property 55 relies on                            */
/* -------------------------------------------------------------------------- */

describe('safeHref', () => {
  it('refuses every scheme that can execute', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'javascript:alert(1)',
          'JaVaScRiPt:alert(1)',
          'java\tscript:alert(1)',
          'vbscript:msgbox(1)',
          'data:text/html,<script>alert(1)</script>',
          'file:///etc/passwd',
          '//evil.test/path',
        ),
        (input) => {
          expect(safeHref(input)).toBeNull();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('passes through the schemes the site actually links with, and relative paths', () => {
    expect(safeHref('/collection/sofas')).toBe('/collection/sofas');
    expect(safeHref('https://wa.me/919513443606')).toBe('https://wa.me/919513443606');
    expect(safeHref('tel:+919513443606')).toBe('tel:+919513443606');
    expect(safeHref('mailto:hello@example.test')).toBe('mailto:hello@example.test');
    expect(safeHref('#main')).toBe('#main');
  });

  it('returns null rather than a placeholder, so the caller decides what an unusable link means', () => {
    expect(safeHref('   ')).toBeNull();
  });
});

describe('escapeHtml and jsonScriptText', () => {
  it('escapes every character that can change the meaning of markup', () => {
    fc.assert(
      fc.property(attacked, (input) => {
        const escaped = escapeHtml(input);
        expect(escaped).not.toMatch(/[<>]/);
        expect(escaped.includes('"')).toBe(false);
        expect(escaped.includes("'")).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('produces a data block no value can break out of, and that still parses', () => {
    fc.assert(
      fc.property(attacked, (input) => {
        const text = jsonScriptText({ value: input });
        expect(text.toLowerCase()).not.toContain('</script');
        expect(text).not.toContain('<');
        expect(text).not.toContain('>');
        expect(JSON.parse(text)).toEqual({ value: input });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
