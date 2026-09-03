import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { getSiteSettings } from '@/lib/content/site';
import {
  buildEnquiryMessage,
  buildTelUrl,
  buildWhatsAppUrl,
  MESSAGE_MAX_LENGTH,
} from '@/lib/whatsapp';
import { SiteSettingsSchema } from '@/schemas/site';
import type { SiteSettings } from '@/schemas/site';

import {
  adversarialTextArb,
  e164Arb,
  enquiryContextArb,
  indianE164Arb,
  ngfSkuArb,
  productEnquiryContextArb,
  productNameArb,
} from './arbitraries';
import { assertProperty } from './config';

/**
 * Enquiry message and URL construction.
 *
 * Design: Conversion → Message and URL construction.
 *
 * NOTE ON PROPERTY 8. The design states the round-trip as
 * `decodeURIComponent(new URL(u).searchParams.get('text')) === message`. Taken
 * literally that expression decodes **twice**: `URLSearchParams.get` already
 * percent-decodes, so the extra `decodeURIComponent` throws `URIError` on any
 * message containing a literal `%` (e.g. "15% off") and silently corrupts a
 * message containing a `+`. The claim the property is named for — and the one
 * requirement 5.5 states — is that decoding *exactly once* returns the original
 * text. That is what is asserted here, in both single-decode forms: through
 * `URLSearchParams` (which decodes for you) and through one explicit
 * `decodeURIComponent` of the raw, still-encoded query value. This deviation is
 * reported rather than applied silently.
 */

/** The real settings file, so these properties also prove it parses. */
const realSite: SiteSettings = getSiteSettings();

/** A second business name, to prove no copy is hard-coded to one brand string. */
const otherSite: SiteSettings = SiteSettingsSchema.parse({
  ...realSite,
  businessName: 'Another Furniture Co. & Sons "Ltd"',
});

const siteArb: fc.Arbitrary<SiteSettings> = fc.constantFrom(realSite, otherSite);

/** The still-encoded value of the single `text` parameter. */
function rawTextParam(url: string): string {
  const marker = '?text=';
  const at = url.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  return url.slice(at + marker.length);
}

describe('Property 8: Enquiry URLs are encoded exactly once', () => {
  it('one decode of the message parameter returns the message', () => {
    assertProperty(
      fc.property(enquiryContextArb, siteArb, indianE164Arb, (ctx, site, number) => {
        const message = buildEnquiryMessage(ctx, site);
        const url = buildWhatsAppUrl(number, message);
        const parsed = new URL(url);

        // Single decode #1: URLSearchParams decodes once.
        expect(parsed.searchParams.get('text')).toBe(message);
        // Single decode #2: the raw parameter decoded exactly once.
        expect(decodeURIComponent(rawTextParam(url))).toBe(message);
      }),
    );
  });

  it('leaves no residual encoded sequence after that single decode', () => {
    assertProperty(
      fc.property(productEnquiryContextArb, siteArb, indianE164Arb, (ctx, site, number) => {
        const message = buildEnquiryMessage(ctx, site);
        const decodedOnce = new URL(buildWhatsAppUrl(number, message)).searchParams.get('text');
        expect(decodedOnce).not.toBeNull();
        // A double-encoded URL would still contain a `%XX` escape after one decode
        // wherever the original text did not itself contain one.
        if (!/%[0-9a-fA-F]{2}/.test(message)) {
          expect(/%[0-9a-fA-F]{2}/.test(decodedOnce ?? '')).toBe(false);
        }
      }),
    );
  });
});

describe('Property 9: Product enquiries always name the product and SKU', () => {
  it('includes the product name and SKU verbatim', () => {
    assertProperty(
      fc.property(
        fc.oneof(productNameArb, adversarialTextArb).filter((n) => n.length > 0),
        ngfSkuArb,
        siteArb,
        (productName, sku, site) => {
          const message = buildEnquiryMessage({ kind: 'product', productName, sku }, site);
          expect(message).toContain(productName);
          expect(message).toContain(sku);
        },
      ),
    );
  });

  it('survives the URL round-trip with the name and SKU intact', () => {
    assertProperty(
      fc.property(productEnquiryContextArb, siteArb, indianE164Arb, (ctx, site, number) => {
        const message = buildEnquiryMessage(ctx, site);
        const decoded = new URL(buildWhatsAppUrl(number, message)).searchParams.get('text') ?? '';
        expect(decoded).toContain(ctx.productName ?? '');
        expect(decoded).toContain(ctx.sku ?? '');
      }),
    );
  });

  it('carries no numeric amount, so a price-on-enquiry product leaks no price', () => {
    assertProperty(
      fc.property(ngfSkuArb, siteArb, (sku, site) => {
        const message = buildEnquiryMessage(
          { kind: 'product', productName: 'Solid Teak Dining Table', sku },
          site,
        );
        expect(message).not.toContain('₹');
      }),
    );
  });

  it('keeps the name and SKU in full when the message is shortened to 900 characters', () => {
    assertProperty(
      fc.property(
        fc.string({ minLength: 400, maxLength: 1200 }).filter((n) => n.trim().length > 0),
        ngfSkuArb,
        siteArb,
        (productName, sku, site) => {
          const message = buildEnquiryMessage(
            {
              kind: 'product',
              productName,
              sku,
              productUrl: `https://example.test/product/${'x'.repeat(200)}`,
            },
            site,
          );
          expect(message).toContain(productName);
          expect(message).toContain(sku);
          // The identity line is never cut, so the cap can only be exceeded by a
          // name longer than the cap itself — which the schema's 120-char bound
          // rules out for real products.
          const identityLength = message.split('\n')[0]?.length ?? 0;
          if (identityLength <= MESSAGE_MAX_LENGTH) {
            expect(message.length).toBeLessThanOrEqual(MESSAGE_MAX_LENGTH);
          }
        },
      ),
    );
  });

  it('names no product or SKU for category, custom, and general enquiries', () => {
    assertProperty(
      fc.property(siteArb, ngfSkuArb, (site, sku) => {
        for (const kind of ['general', 'custom'] as const) {
          const message = buildEnquiryMessage({ kind }, site);
          expect(message).not.toContain('SKU');
          expect(message).not.toContain(sku);
        }
        const categoryMessage = buildEnquiryMessage(
          { kind: 'category', categoryName: 'Sofas & Sectionals' },
          site,
        );
        expect(categoryMessage).toContain('Sofas & Sectionals');
        expect(categoryMessage).not.toContain('SKU');
      }),
    );
  });
});

describe('Property 10: wa.me numbers are digits only', () => {
  /** The same number written with `+`, spaces, dashes, and parentheses. */
  const messyE164Arb = e164Arb.chain((e164) =>
    fc.array(fc.constantFrom(' ', '-', '(', ')', '.', '\u00a0'), { maxLength: 4 }).map((noise) => {
      let out = e164;
      for (const ch of noise) {
        const at = 1 + Math.floor((out.length - 1) / 2);
        out = `${out.slice(0, at)}${ch}${out.slice(at)}`;
      }
      return out;
    }),
  );

  it('emits a digits-only path with no plus, space, or punctuation', () => {
    assertProperty(
      fc.property(messyE164Arb, adversarialTextArb, (number, message) => {
        const url = buildWhatsAppUrl(number, message);
        const parsed = new URL(url);
        expect(parsed.host).toBe('wa.me');
        expect(parsed.pathname).toMatch(/^\/\d+$/);
        expect(parsed.pathname).toBe(`/${number.replace(/\D+/g, '')}`);
      }),
    );
  });

  it('emits tel: URLs with a leading plus and digits only', () => {
    assertProperty(
      fc.property(messyE164Arb, (number) => {
        expect(buildTelUrl(number)).toMatch(/^tel:\+\d+$/);
      }),
    );
  });

  it('keeps both business numbers reachable as digits', () => {
    for (const entry of [...realSite.whatsapp, ...realSite.phone]) {
      expect(new URL(buildWhatsAppUrl(entry.e164, 'hi')).pathname).toBe(
        `/${entry.e164.replace(/\D+/g, '')}`,
      );
      expect(buildTelUrl(entry.e164)).toBe(`tel:${entry.e164}`);
    }
  });
});

describe('Property 11: Adversarial message text still yields a parseable URL', () => {
  const hostileMessageArb = fc.oneof(
    fc
      .array(fc.constantFrom('&', '#', '+', '?', '%', '=', '\n', '\r', '₹', '🛋️', 'a', ' ', '"'), {
        maxLength: 120,
      })
      .map((chars) => chars.join('')),
    adversarialTextArb,
  );

  it('parses, and carries exactly one query parameter', () => {
    assertProperty(
      fc.property(hostileMessageArb, indianE164Arb, (message, number) => {
        const url = new URL(buildWhatsAppUrl(number, message));
        expect([...url.searchParams.keys()]).toEqual(['text']);
        expect(url.searchParams.get('text')).toBe(message);
      }),
    );
  });

  it('preserves every newline as a line break', () => {
    assertProperty(
      fc.property(
        fc.array(fc.constantFrom('a', '\n', '₹', '&'), { minLength: 1, maxLength: 60 }),
        indianE164Arb,
        (chars, number) => {
          const message = chars.join('');
          const decoded = new URL(buildWhatsAppUrl(number, message)).searchParams.get('text') ?? '';
          expect(decoded.split('\n').length).toBe(message.split('\n').length);
        },
      ),
    );
  });
});
