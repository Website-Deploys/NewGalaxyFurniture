/**
 * Anti-spam for the public enquiry forms, in two strictly separated tiers.
 *
 * The separation is the design: Requirement 6.8 names two checks that **reject**, and
 * Requirement 6.10 says every other heuristic must **mark and keep**. Those are opposite
 * dispositions, so they are opposite functions here, and neither can be mistaken for the
 * other at a call site:
 *
 * - `checkTraps` returns a boolean-ish verdict with **no reason attached**. It cannot tell a
 *   caller which trap fired, because the response must not either: a message that
 *   distinguishes "your honeypot was filled" from "you submitted too fast" is a free
 *   tutorial for the next attempt. Both cases produce the single
 *   `SUBMISSION_REJECTED` sentence.
 * - `scoreSpam` returns a number and a list of reasons, and it never rejects anything. A
 *   furniture enquiry that says "I saw your reviews online, here is the link" is a real
 *   customer, and a heuristic that discarded it would lose an order. So the operator sees
 *   the lead with the flag and judges for themselves.
 *
 * **On the form-age check and the browser clock.** `renderedAt` comes from the visitor's
 * own clock, so the age is only as trustworthy as that clock. The bounds are therefore
 * generous in both directions: up to a minute of clock-ahead skew is tolerated, and a form
 * older than twelve hours is treated as failing rather than passing. The second bound is
 * the interesting one — a tab left open overnight is a real thing, and its submission is
 * refused with the generic sentence, which a reload resolves. The alternative is worse: a
 * fabricated `renderedAt` of `0` would otherwise report an age of five decades and sail
 * through the one check that exists to cost an attacker time.
 *
 * Design: Conversion → Lead capture (Anti-spam is layered without a CAPTCHA).
 * Requirements: 6.8, 6.10.
 */

import { MIN_FORM_AGE_MS } from '@/schemas/lead';

export { MIN_FORM_AGE_MS };

/** Clock-ahead tolerance. A visitor whose clock runs fast is not a bot. */
export const MAX_CLOCK_SKEW_AHEAD_MS = 60_000;

/** Beyond this, the form is stale or the timestamp is fabricated. Twelve hours. */
export const MAX_FORM_AGE_MS = 12 * 60 * 60 * 1000;

export interface TrapInput {
  /**
   * The hidden field. **Any** non-empty value is a bot, taken literally as Requirement 6.8
   * words it — including a lone space. The tempting leniency here is to trim first, so that a
   * stray whitespace character does not refuse a human; it is the wrong trade. Nothing a person
   * does reaches this field at all (it is off-canvas, `tabindex="-1"`, `aria-hidden`, and
   * `autocomplete="off"`, and the form initialises it to the empty string), whereas a form
   * filler that writes a space into every input is exactly what the trap is for.
   */
  honeypot?: string | undefined;
  /** Epoch ms the form was rendered, as the browser reported it. */
  renderedAt: number;
}

/**
 * Did this submission trip a rejecting trap?
 *
 * Returns `true` when the submission must be refused. Deliberately returns nothing else:
 * there is no reason field, no code, and no way for a caller to accidentally forward one.
 */
export function checkTraps(input: TrapInput, now: number = Date.now()): boolean {
  if (typeof input.honeypot === 'string' && input.honeypot !== '') return true;

  if (!Number.isFinite(input.renderedAt)) return true;
  const age = now - input.renderedAt;
  if (age < MIN_FORM_AGE_MS - MAX_CLOCK_SKEW_AHEAD_MS) return true;
  if (age > MAX_FORM_AGE_MS) return true;
  // A form whose clock is behind ours by less than the skew allowance but whose reported age
  // is still under the minimum is refused: that is the ordinary too-fast submission.
  return age < MIN_FORM_AGE_MS && input.renderedAt <= now;
}

/* -------------------------------------------------------------------------- */
/* Tier two: mark, never discard                                              */
/* -------------------------------------------------------------------------- */

/**
 * Words that never appear in a furniture enquiry and always appear in link spam.
 *
 * Kept short and specific on purpose. Every addition is a chance to flag a real customer,
 * and the flag is visible to the operator — so a noisy list makes the signal worthless
 * rather than making the filter stronger.
 */
const SPAM_TERMS: readonly string[] = [
  'seo service',
  'backlink',
  'guest post',
  'crypto',
  'bitcoin',
  'casino',
  'viagra',
  'payday loan',
  'forex',
  'porn',
  'escort',
  'buy followers',
  'rank your website',
];

const URL_PATTERN = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]{2,}/gi;

export interface SpamAssessment {
  /** 0 means nothing was noticed. Stored on the lead as `spam_score`. */
  score: number;
  /** Human-readable reasons, for the operator. Never returned to the submitter. */
  reasons: string[];
}

/**
 * Score the free text of a submission.
 *
 * Every signal here is about the *shape* of the text rather than its opinions, and the
 * scores are small and additive so no single signal can make a lead look conclusively bad.
 */
export function scoreSpam(parts: {
  name: string;
  message: string;
  requirement?: string | undefined;
  budget?: string | undefined;
  dimensions?: string | undefined;
}): SpamAssessment {
  const reasons: string[] = [];
  let score = 0;

  const freeText = [parts.message, parts.requirement, parts.budget, parts.dimensions]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');

  const links = freeText.match(URL_PATTERN) ?? [];
  if (links.length > 0) {
    // One link is normal ("here is the piece I saw"). Several is a pitch.
    const points = links.length === 1 ? 1 : 3;
    score += points;
    reasons.push(
      links.length === 1 ? 'Contains one link.' : `Contains ${String(links.length)} links.`,
    );
  }

  // A link in the *name* has no innocent reading.
  if (URL_PATTERN.test(parts.name)) {
    score += 3;
    reasons.push('The name field contains a link.');
  }

  const haystack = `${parts.name}\n${freeText}`.toLowerCase();
  const hits = SPAM_TERMS.filter((term) => haystack.includes(term));
  if (hits.length > 0) {
    score += 2 * hits.length;
    reasons.push(`Mentions ${hits.map((term) => `“${term}”`).join(', ')}.`);
  }

  // Shouting, measured only on text long enough for the ratio to mean anything.
  const letters = freeText.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 25) {
    const upper = letters.replace(/[^A-Z]/g, '').length;
    if (upper / letters.length > 0.7) {
      score += 1;
      reasons.push('Almost entirely capital letters.');
    }
  }

  // `aaaaaaaaaa`, `!!!!!!!!!!` — a keyboard-mashing signature.
  if (/(.)\1{9,}/.test(freeText)) {
    score += 1;
    reasons.push('Contains a long run of one repeated character.');
  }

  return { score, reasons };
}
