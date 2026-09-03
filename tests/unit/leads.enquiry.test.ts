import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBatcher, type BeaconTransport } from '@/lib/analytics/client';
import { eventsFromBody } from '@/lib/analytics/ingest';
import { isLikelyBot } from '@/lib/analytics/bots';
import { isQuarantinedKey, quarantineKey, QUARANTINE_PREFIX } from '@/lib/leads/image';
import { LeadSchema, LEAD_LIMITS, fieldErrorsOf } from '@/schemas/lead';
import { MAX_TIMESTAMP_SKEW_MS } from '@/lib/analytics/rollup';
import { parsePageEvent } from '@/lib/analytics/page';
import { productPath, resolveProductReference } from '@/lib/leads/resolve';
import { submitEnquiry, type EnquiryPayload } from '@/lib/leads/submit';
import { demoSofa } from '../fixtures/products';
import type { Product } from '@/schemas/product';

/**
 * The public enquiry path and the analytics client, as decisions rather than as HTTP.
 *
 * The endpoints (`/api/leads`, `/api/events`) are thin: they order the checks and hand off to the
 * modules exercised here. What that ordering *is* is asserted by the modules' own contracts —
 * a trap that cannot say which trap it was, a resolver that cannot be handed a product name, a
 * classifier that maps each error code to exactly one recovery. Those are the parts that can be
 * wrong in a way a browser would not reveal.
 *
 * Requirements: 6.3, 6.4, 6.5, 6.6, 6.9, 6.11, 6.17, 6.18, 6.19, 20.1, 20.2, 20.3.
 */

/* -------------------------------------------------------------------------- */
/* The payload contract                                                       */
/* -------------------------------------------------------------------------- */

const RENDERED_AT = Date.now() - 10_000;

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'CONTACT',
    name: 'Asha Rao',
    phone: '9513443606',
    message: 'Is the charcoal three-seater available in a 7 ft width?',
    renderedAt: RENDERED_AT,
    ...overrides,
  };
}

describe('the lead payload normalises the phone number (Requirement 6.4)', () => {
  it('accepts every form the requirement names and stores one canonical value', () => {
    for (const input of [
      '9513443606',
      '09513443606',
      '+91 95134 43606',
      '919513443606',
      '+919513443606',
      '(095134) 43606',
      '91-95134-43606',
    ]) {
      const parsed = LeadSchema.safeParse(payload({ phone: input }));
      expect(parsed.success, `phone "${input}"`).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data.phone).toBe('+919513443606');
    }
  });

  it('reports an unnormalisable number against the phone field with a human sentence', () => {
    const parsed = LeadSchema.safeParse(payload({ phone: '12345' }));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const fields = fieldErrorsOf(parsed.error);
    expect(Object.keys(fields)).toEqual(['phone']);
    // The message has to be renderable under the control, which means it names the accepted
    // shape rather than saying "invalid".
    expect(fields.phone?.[0]).toMatch(/10-digit/);
  });
});

describe('optional fields collapse rather than storing blanks', () => {
  it('turns an untouched optional field into an absent one', () => {
    const parsed = LeadSchema.safeParse(
      payload({ type: 'CUSTOM', requirement: '   ', budget: '', dimensions: '  ' }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.requirement).toBeUndefined();
    expect(parsed.data.budget).toBeUndefined();
    expect(parsed.data.dimensions).toBeUndefined();
  });

  it('trims what it keeps, so a stored value has no leading or trailing space', () => {
    const parsed = LeadSchema.safeParse(
      payload({ name: '  Asha Rao  ', message: `  ${'x'.repeat(20)}  ` }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.name).toBe('Asha Rao');
    expect(parsed.data.message).toBe('x'.repeat(20));
  });

  it('measures the bound after trimming, so padding cannot smuggle length past it', () => {
    const parsed = LeadSchema.safeParse(
      payload({ message: `${' '.repeat(40)}too short${' '.repeat(40)}` }),
    );
    // "too short" is 9 characters — one under the minimum — and 80 spaces do not fix that.
    expect(LEAD_LIMITS.messageMin).toBe(10);
    expect(parsed.success).toBe(false);
  });

  it('reports every failing field at once rather than stopping at the first', () => {
    const parsed = LeadSchema.safeParse(payload({ name: 'A', phone: 'nope', message: 'hi' }));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(Object.keys(fieldErrorsOf(parsed.error)).sort()).toEqual(['message', 'name', 'phone']);
  });
});

/* -------------------------------------------------------------------------- */
/* Server-side product resolution                                             */
/* -------------------------------------------------------------------------- */

const SITE = 'https://example.test';

describe('product resolution happens on the server (Requirements 6.6, 6.17)', () => {
  const catalogue: Product[] = [demoSofa];

  it('resolves the name, SKU and an absolute canonical URL from the slug alone', () => {
    const product = catalogue[0]!;
    const outcome = resolveProductReference(product.slug, catalogue, SITE);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.product).toEqual({
      slug: product.slug,
      name: product.name,
      sku: product.sku,
      url: `${SITE}${productPath(product.slug)}`,
    });
  });

  it('tolerates a trailing slash on the configured site URL', () => {
    const product = catalogue[0]!;
    const outcome = resolveProductReference(product.slug, catalogue, `${SITE}/`);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.product.url).toBe(`${SITE}${productPath(product.slug)}`);
  });

  it('refuses a slug that is not in the catalogue it was given', () => {
    // The catalogue passed in is `getCatalogue()`'s output — PUBLISHED and OUT_OF_STOCK only —
    // so a draft, an unpublished product and a product that never existed are one case here,
    // and they get one message. Distinguishing them would leak the state of unpublished
    // content to anyone who can guess a slug.
    for (const slug of ['not-a-product', 'draft-sofa', '']) {
      const outcome = resolveProductReference(slug, catalogue, SITE);
      expect(outcome.ok, slug).toBe(false);
    }
  });

  it('has no parameter through which a browser-supplied name or SKU could arrive', () => {
    // The signature is the guarantee. This assertion is about arity: three parameters, the
    // second of which is the server's own catalogue.
    expect(resolveProductReference.length).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* The quarantined attachment                                                  */
/* -------------------------------------------------------------------------- */

describe('enquiry images are quarantined (Requirement 6.11)', () => {
  it('builds a key under the quarantine prefix from the lead id and the sniffed extension', () => {
    expect(quarantineKey('lead_abc123', 'webp')).toBe(
      `${QUARANTINE_PREFIX}lead_abc123/attachment.webp`,
    );
    expect(isQuarantinedKey(quarantineKey('lead_abc123', 'jpg'))).toBe(true);
  });

  it('does not sit under the products prefix the public delivery route resolves', () => {
    // `/img/[...path]` maps `products/{id}/{imageId}/…` and nothing else, so a key outside that
    // prefix has no public URL at all. The confinement is the absence of a route.
    expect(QUARANTINE_PREFIX.startsWith('products/')).toBe(false);
    expect(isQuarantinedKey('products/p1/img_1/original.webp')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Failure classification                                                      */
/* -------------------------------------------------------------------------- */

const SUBMIT_PAYLOAD: EnquiryPayload = {
  type: 'CONTACT',
  name: 'Asha Rao',
  phone: '9513443606',
  message: 'Do you deliver to Mysuru?',
  honeypot: '',
  renderedAt: RENDERED_AT,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('every failure maps to exactly one recovery', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports a stored enquiry with the server’s own confirmation sentence', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, message: 'Thank you — received.' }));
    const result = await submitEnquiry(SUBMIT_PAYLOAD);
    expect(result).toEqual({ ok: true, message: 'Thank you — received.' });
  });

  it('classifies a validation failure and keeps its field messages', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: 'VALIDATION_FAILED',
        message: 'Some fields need attention.',
        fields: { phone: ['Enter a 10-digit Indian mobile number.'] },
      }),
    );
    const result = await submitEnquiry(SUBMIT_PAYLOAD);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('validation');
    expect(result.fields.phone).toHaveLength(1);
  });

  it('discards any field on a trap rejection, so no control is marked (Requirement 6.8)', async () => {
    // The endpoint does not send fields with this code. The client drops them anyway: marking a
    // control would tell a bot which trap it hit, and that must not depend on the server
    // remembering not to send one.
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: 'SUBMISSION_REJECTED',
        message: 'We could not accept this enquiry.',
        fields: { honeypot: ['must be empty'] },
      }),
    );
    const result = await submitEnquiry(SUBMIT_PAYLOAD);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('rejected');
    expect(result.fields).toEqual({});
  });

  it('passes the rate-limit sentence through unchanged, minutes and all', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, {
        error: 'RATE_LIMITED',
        message: 'You have sent the maximum number of enquiries for now. Try again in 43 minutes.',
      }),
    );
    const result = await submitEnquiry(SUBMIT_PAYLOAD);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('rate-limited');
    expect(result.message).toMatch(/43 minutes/);
  });

  it('carries the Catalogue destination for an unavailable product (Requirement 6.17)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: 'PRODUCT_UNAVAILABLE',
        message: 'The piece this enquiry refers to is no longer available.',
        fields: { productSlug: ['This piece is no longer listed.'] },
        remote: { catalogueHref: '/collection' },
      }),
    );
    const result = await submitEnquiry(SUBMIT_PAYLOAD);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('product-unavailable');
    expect(result.catalogueHref).toBe('/collection');
  });

  it('refuses an off-site Catalogue destination handed back in the envelope', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: 'PRODUCT_UNAVAILABLE',
        message: 'No longer available.',
        remote: { catalogueHref: 'https://evil.test/collection' },
      }),
    );
    const result = await submitEnquiry(SUBMIT_PAYLOAD);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Only a same-site path is accepted, so a compromised or mistaken response cannot turn the
    // recovery control into an off-site redirect.
    expect(result.catalogueHref).toBeUndefined();
  });

  it('treats a storage failure and a missing binding alike: not recorded (Requirement 6.19)', async () => {
    for (const code of ['LEAD_NOT_RECORDED', 'CONFIGURATION_INCOMPLETE']) {
      fetchMock.mockResolvedValue(jsonResponse(503, { error: code, message: 'Not recorded.' }));
      const result = await submitEnquiry(SUBMIT_PAYLOAD);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.kind, code).toBe('not-recorded');
    }
  });

  it('classifies a dropped connection as a network failure, with a retryable message', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await submitEnquiry(SUBMIT_PAYLOAD);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('network');
    expect(result.message).toMatch(/try again/i);
  });

  it('sends multipart only when there is an image, and JSON otherwise', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, message: 'ok' }));

    await submitEnquiry(SUBMIT_PAYLOAD);
    const jsonInit = fetchMock.mock.calls[0]?.[1];
    expect(typeof jsonInit?.body).toBe('string');

    fetchMock.mockClear();
    const file = new File([new Uint8Array([1, 2, 3])], 'sketch.png', { type: 'image/png' });
    await submitEnquiry(SUBMIT_PAYLOAD, file);
    const multipartInit = fetchMock.mock.calls[0]?.[1];
    expect(multipartInit?.body instanceof FormData).toBe(true);
    const form = multipartInit?.body as FormData;
    // Every field survives the encoding change, including the trap fields.
    expect(form.get('name')).toBe('Asha Rao');
    expect(form.get('honeypot')).toBe('');
    expect(form.get('renderedAt')).toBe(String(RENDERED_AT));
    expect(form.get('image')).toBeInstanceOf(File);
  });
});

/* -------------------------------------------------------------------------- */
/* The analytics client                                                        */
/* -------------------------------------------------------------------------- */

function recordingTransport(): { transport: BeaconTransport; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    transport: {
      send(_url, body) {
        sent.push(body);
        return true;
      },
    },
  };
}

describe('the event batcher', () => {
  it('flushes after five events and not before', () => {
    const { transport, sent } = recordingTransport();
    const batcher = createBatcher({ transport, now: () => 1_000 });

    for (let index = 0; index < 4; index += 1) batcher.track('product_view', `p${String(index)}`);
    expect(sent).toHaveLength(0);
    expect(batcher.size()).toBe(4);

    batcher.track('product_view', 'p4');
    expect(sent).toHaveLength(1);
    expect(batcher.size()).toBe(0);

    const parsed = JSON.parse(sent[0]!) as { events: unknown[] };
    expect(parsed.events).toHaveLength(5);
  });

  it('clears the queue before sending, so a refused beacon cannot double-count', () => {
    const batcher = createBatcher({
      transport: {
        send() {
          throw new Error('refused');
        },
      },
      now: () => 1_000,
    });
    for (let index = 0; index < 5; index += 1) batcher.track('whatsapp_click');
    // An undercount is the documented failure mode. Re-sending the same five on the next flush
    // would be an overcount, which is a lie rather than a limitation.
    expect(batcher.size()).toBe(0);
  });

  it('ignores an unknown event type instead of queueing something the server will drop', () => {
    const { transport, sent } = recordingTransport();
    const batcher = createBatcher({ transport });
    // @ts-expect-error — deliberately outside the union, as a stale deployed page might send.
    batcher.track('page_view', 'x');
    batcher.flush();
    expect(sent).toHaveLength(0);
  });

  it('carries no identifier of any kind in the payload', () => {
    const { transport, sent } = recordingTransport();
    const batcher = createBatcher({ transport, now: () => 42 });
    batcher.track('product_view', 'rolled-arm-sofa');
    batcher.flush();
    const parsed = JSON.parse(sent[0]!) as { events: Record<string, unknown>[] };
    // Three keys: type, timestamp, entity. There is nowhere for a visitor id to hide.
    expect(Object.keys(parsed.events[0]!).sort()).toEqual(['e', 't', 'ts']);
  });

  it('bounds the entity length before it leaves the browser', () => {
    const { transport, sent } = recordingTransport();
    const batcher = createBatcher({ transport });
    batcher.track('search', 'x'.repeat(400));
    batcher.flush();
    const parsed = JSON.parse(sent[0]!) as { events: { e: string }[] };
    expect(parsed.events[0]?.e).toHaveLength(120);
  });
});

describe('the batch the endpoint accepts', () => {
  const now = Date.UTC(2026, 2, 14, 9, 0, 0);

  it('accepts the wrapper shape and a bare array, and nothing else', () => {
    const event = { t: 'product_view', e: 'sofa', ts: now };
    expect(eventsFromBody({ events: [event] }, now).events).toHaveLength(1);
    expect(eventsFromBody([event], now).events).toHaveLength(1);
    for (const body of [null, 'string', 42, {}, { events: 'nope' }]) {
      expect(eventsFromBody(body, now).events).toHaveLength(0);
    }
  });

  it('reports how many entries were submitted, so the drop rate is observable', () => {
    const result = eventsFromBody(
      { events: Array.from({ length: 25 }, () => ({ t: 'product_view', e: 'a', ts: now })) },
      now,
    );
    expect(result.submitted).toBe(25);
    expect(result.events).toHaveLength(20);
    expect(result.rejected).toBe(5);
  });

  it('drops a timestamp outside the ten-minute window in either direction', () => {
    const outside = MAX_TIMESTAMP_SKEW_MS + 1_000;
    const result = eventsFromBody(
      {
        events: [
          { t: 'product_view', e: 'a', ts: now - outside },
          { t: 'product_view', e: 'b', ts: now + outside },
          { t: 'product_view', e: 'c', ts: now },
        ],
      },
      now,
    );
    expect(result.events.map((event) => event.e)).toEqual(['c']);
  });
});

describe('bot filtering', () => {
  it('drops the crawlers that announce themselves, and keeps real browsers', () => {
    const bots = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0)',
      'curl/8.4.0',
      'python-requests/2.31.0',
      'Mozilla/5.0 HeadlessChrome/120.0.0.0',
      'facebookexternalhit/1.1',
      null,
      '',
      'short',
    ];
    for (const agent of bots) expect(isLikelyBot(agent), String(agent)).toBe(true);

    const humans = [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ];
    for (const agent of humans) expect(isLikelyBot(agent), agent).toBe(false);
  });
});

describe('the page-event meta tag', () => {
  it('parses a known type and its entity, and refuses an unknown type', () => {
    expect(parsePageEvent('product_view:rolled-arm-sofa')).toEqual({
      type: 'product_view',
      entity: 'rolled-arm-sofa',
    });
    expect(parsePageEvent('category_view:sofas')).toEqual({
      type: 'category_view',
      entity: 'sofas',
    });
    expect(parsePageEvent('whatsapp_click')).toEqual({ type: 'whatsapp_click', entity: '' });
    expect(parsePageEvent('page_view:home')).toBeNull();
    expect(parsePageEvent('')).toBeNull();
  });
});
