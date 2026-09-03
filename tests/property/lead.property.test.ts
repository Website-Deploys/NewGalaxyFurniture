import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { checkTraps, MAX_FORM_AGE_MS, MIN_FORM_AGE_MS, scoreSpam } from '@/lib/leads/spam';
import { LeadSchema, LEAD_LIMITS } from '@/schemas/lead';

import { indianE164Arb } from './arbitraries';
import { assertProperty } from './config';

/**
 * The lead spam traps, and the payload bounds they sit in front of.
 *
 * Design: Conversion → Lead capture (Anti-spam is layered without a CAPTCHA).
 */

const NOW = Date.UTC(2026, 2, 14, 9, 0, 0);

/** A payload that passes every bound in Requirement 6.3, so only the trap can reject it. */
const validLeadArb = fc.record({
  type: fc.constantFrom('QUICK_ENQUIRE', 'CALLBACK', 'QUOTE', 'CUSTOM', 'CONTACT' as const),
  name: fc
    .string({ minLength: LEAD_LIMITS.nameMin, maxLength: LEAD_LIMITS.nameMax })
    // Trimming happens in the schema, so a name of only spaces would legitimately fail the
    // minimum. The generator produces names that are non-blank after trimming.
    .filter((value) => value.trim().length >= LEAD_LIMITS.nameMin),
  phone: indianE164Arb,
  message: fc
    .string({ minLength: LEAD_LIMITS.messageMin, maxLength: LEAD_LIMITS.messageMax })
    .filter((value) => value.trim().length >= LEAD_LIMITS.messageMin),
});

describe('Property 43: Spam traps reject bot submissions', () => {
  it('rejects any submission carrying a non-empty honeypot, whatever else it contains', () => {
    assertProperty(
      fc.property(
        validLeadArb,
        // Any non-empty value at all. A bot filling every input it finds is the case.
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.integer({ min: MIN_FORM_AGE_MS, max: MAX_FORM_AGE_MS }),
        (_lead, honeypot, age) => {
          // The honeypot wins even when the timing is impeccable — the two checks are
          // independent, and either one alone must be sufficient.
          return checkTraps({ honeypot, renderedAt: NOW - age }, NOW);
        },
      ),
    );
  });

  it('rejects any submission made less than 1.5 seconds after the form was rendered', () => {
    assertProperty(
      fc.property(validLeadArb, fc.integer({ min: 0, max: MIN_FORM_AGE_MS - 1 }), (_lead, age) =>
        checkTraps({ honeypot: '', renderedAt: NOW - age }, NOW),
      ),
    );
  });

  it('accepts a submission with an empty honeypot and a credible form age', () => {
    // The complement matters as much as the property: a trap that rejected everything would
    // satisfy both assertions above and lose every enquiry the business receives.
    assertProperty(
      fc.property(
        validLeadArb,
        fc.integer({ min: MIN_FORM_AGE_MS, max: MAX_FORM_AGE_MS }),
        fc.constantFrom('', undefined),
        (_lead, age, honeypot) => !checkTraps({ honeypot, renderedAt: NOW - age }, NOW),
      ),
    );
  });

  it('rejects a whitespace-only honeypot, which is still a filled field', () => {
    assertProperty(
      fc.property(
        fc.stringMatching(/^[ \t\n]+$/),
        (honeypot) => checkTraps({ honeypot, renderedAt: NOW - 5000 }, NOW) === true,
      ),
      { numRuns: 60 },
    );
  });

  it('rejects a non-finite or fabricated timestamp rather than treating it as very old', () => {
    for (const renderedAt of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(checkTraps({ honeypot: '', renderedAt }, NOW)).toBe(true);
    }
    // A stale tab is refused too, and a reload is the recovery.
    expect(checkTraps({ honeypot: '', renderedAt: NOW - MAX_FORM_AGE_MS - 1 }, NOW)).toBe(true);
  });

  it('reveals nothing about which trap fired: the verdict is a bare boolean', () => {
    // The type is the guarantee. `checkTraps` returns `boolean`, so there is no reason field
    // for an endpoint to forward into a response by accident (Requirement 6.8).
    const withHoneypot = checkTraps({ honeypot: 'x', renderedAt: NOW - 9000 }, NOW);
    const tooFast = checkTraps({ honeypot: '', renderedAt: NOW - 10 }, NOW);
    expect(withHoneypot).toBe(tooFast);
    expect(typeof withHoneypot).toBe('boolean');
  });
});

describe('the marking tier never rejects (Requirement 6.10)', () => {
  it('returns a score and reasons for any text at all, and never throws', () => {
    assertProperty(
      fc.property(fc.string({ maxLength: 400 }), fc.string({ maxLength: 400 }), (name, message) => {
        const assessment = scoreSpam({ name, message });
        return assessment.score >= 0 && Array.isArray(assessment.reasons);
      }),
    );
  });

  it('scores an ordinary furniture enquiry at zero', () => {
    const assessment = scoreSpam({
      name: 'Asha Rao',
      message: 'Is the charcoal three-seater available in a 7 ft width? We are in Jayanagar.',
    });
    expect(assessment.score).toBe(0);
    expect(assessment.reasons).toEqual([]);
  });

  it('marks link spam and a link in the name field without rejecting either', () => {
    const linked = scoreSpam({
      name: 'SEO Growth',
      message: 'rank your website — visit https://a.test and https://b.test and https://c.test',
    });
    expect(linked.score).toBeGreaterThan(0);
    expect(linked.reasons.length).toBeGreaterThan(0);

    const namedLink = scoreSpam({ name: 'www.buy-followers.test', message: 'hello there friend' });
    expect(namedLink.score).toBeGreaterThan(0);
  });
});

describe('the payload bounds Requirement 6.3 fixes', () => {
  it('accepts every generated valid payload once the traps have passed', () => {
    assertProperty(
      fc.property(validLeadArb, (lead) => {
        const parsed = LeadSchema.safeParse({
          ...lead,
          // Quick Enquire additionally requires a product reference; give every payload one so
          // the type is free to vary.
          productSlug: 'rolled-arm-sofa',
          renderedAt: NOW - 5000,
        });
        return parsed.success;
      }),
    );
  });

  it('refuses a Quick Enquire with no product reference, and names the field', () => {
    const parsed = LeadSchema.safeParse({
      type: 'QUICK_ENQUIRE',
      name: 'Asha Rao',
      phone: '9513443606',
      message: 'Is this available in walnut?',
      renderedAt: NOW - 5000,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path.join('.') === 'productSlug')).toBe(true);
  });

  it('refuses any value over its bound, on the field that is over it', () => {
    const base = {
      type: 'CUSTOM' as const,
      name: 'Asha Rao',
      phone: '9513443606',
      message: 'A seven foot dining table in teak, please.',
      renderedAt: NOW - 5000,
    };
    const overLong: readonly [string, string][] = [
      ['name', 'a'.repeat(LEAD_LIMITS.nameMax + 1)],
      ['message', 'a'.repeat(LEAD_LIMITS.messageMax + 1)],
      ['requirement', 'a'.repeat(LEAD_LIMITS.requirementMax + 1)],
      ['budget', 'a'.repeat(LEAD_LIMITS.budgetMax + 1)],
      ['dimensions', 'a'.repeat(LEAD_LIMITS.dimensionsMax + 1)],
    ];
    for (const [field, value] of overLong) {
      const parsed = LeadSchema.safeParse({ ...base, [field]: value });
      expect(parsed.success, `${field} over its bound`).toBe(false);
      if (parsed.success) continue;
      expect(
        parsed.error.issues.some((issue) => issue.path.join('.') === field),
        `${field} names itself`,
      ).toBe(true);
    }
  });

  it('rejects a browser-supplied product name, SKU or URL outright', () => {
    // `.strict()` is what makes Requirement 6.6 structural: the values cannot arrive at all,
    // so there is no code path that could prefer them over the resolved ones.
    for (const key of ['productName', 'productSku', 'productUrl', 'status', 'spamScore']) {
      const parsed = LeadSchema.safeParse({
        type: 'CONTACT',
        name: 'Asha Rao',
        phone: '9513443606',
        message: 'Do you deliver to Mysuru?',
        renderedAt: NOW - 5000,
        [key]: 'anything',
      });
      expect(parsed.success, `${key} must be refused`).toBe(false);
    }
  });
});
