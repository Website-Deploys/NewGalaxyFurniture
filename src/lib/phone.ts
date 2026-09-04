/**
 * Indian phone normalization.
 *
 * A visitor types their number the way they say it: `9513443606`,
 * `09513443606`, `+91 95134 43606`, `91-95134-43606`, `(095134) 43606`. All of
 * those are the same person, and all of them normalize to `+919513443606` so the
 * stored lead has one canonical form the operator can dial and message.
 *
 * Nothing here throws. An unnormalizable value comes back as a typed failure
 * carrying a message fit to render under the field, because requirement 6.5 wants a
 * field-level error with every other entered value retained — not an exception.
 *
 * Design: Conversion → Lead capture.
 * Requirements: 6.4, 6.5, 19.8.
 */

/** E.164: `+`, a non-zero country digit, then 7–14 more digits. */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export const INDIA_COUNTRY_CODE = '91';

/** Indian mobile numbers are 10 digits and begin 6, 7, 8, or 9. */
const INDIAN_SUBSCRIBER = /^[6-9]\d{9}$/;

export type PhoneResult =
  { readonly ok: true; readonly e164: string } | { readonly ok: false; readonly message: string };

const FAILURE_MESSAGE =
  'Enter a 10-digit Indian mobile number, with or without +91 (for example 95134 43606).';

/** True when the value is already a well-formed E.164 number. */
export function isE164(value: string): boolean {
  return E164_PATTERN.test(value);
}

/**
 * Normalize any accepted Indian form to `+91XXXXXXXXXX`.
 *
 * Separators (spaces, non-breaking spaces, hyphens, dots, parentheses, slashes)
 * are ignored wherever they appear. Everything else — letters, extensions, a second
 * number pasted in, a non-Indian country code — is a failure.
 */
export function normalizeIndianPhone(input: string): PhoneResult {
  if (typeof input !== 'string') return { ok: false, message: FAILURE_MESSAGE };

  const trimmed = input.trim();
  // Only separators may be stripped. Anything else present means the value is not
  // a single Indian number, and quietly deleting it would normalize "9513a43606"
  // into a valid-looking number the visitor never typed.
  if (!/^[+\d\s\u00a0().\-/]*$/.test(trimmed)) {
    return { ok: false, message: FAILURE_MESSAGE };
  }

  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D+/g, '');

  const subscriber = extractSubscriber(digits, hasPlus);
  if (subscriber === null) return { ok: false, message: FAILURE_MESSAGE };

  return { ok: true, e164: `+${INDIA_COUNTRY_CODE}${subscriber}` };
}

/** The 10 subscriber digits, or `null` when the value is not an Indian number. */
function extractSubscriber(digits: string, hasPlus: boolean): string | null {
  // +91XXXXXXXXXX / 91XXXXXXXXXX
  if (digits.length === 12 && digits.startsWith(INDIA_COUNTRY_CODE)) {
    const subscriber = digits.slice(2);
    return INDIAN_SUBSCRIBER.test(subscriber) ? subscriber : null;
  }
  // 0091XXXXXXXXXX — the international prefix as dialled from India.
  if (digits.length === 14 && digits.startsWith(`00${INDIA_COUNTRY_CODE}`)) {
    const subscriber = digits.slice(4);
    return INDIAN_SUBSCRIBER.test(subscriber) ? subscriber : null;
  }
  // 0XXXXXXXXXX — the national trunk prefix. Never valid after a `+`.
  if (!hasPlus && digits.length === 11 && digits.startsWith('0')) {
    const subscriber = digits.slice(1);
    return INDIAN_SUBSCRIBER.test(subscriber) ? subscriber : null;
  }
  // XXXXXXXXXX — bare. A leading `+` with no country code is not a number.
  if (!hasPlus && digits.length === 10) {
    return INDIAN_SUBSCRIBER.test(digits) ? digits : null;
  }
  return null;
}

/**
 * `+919513443606` → `+91 95134 43606`, the grouping Indian numbers are read in.
 * Any other country code is displayed as `+CC ` followed by its digits unchanged,
 * because guessing another country's grouping would misinform.
 */
export function formatDisplayPhone(e164: string): string {
  if (!isE164(e164)) return e164;
  const digits = e164.slice(1);
  if (digits.length === 12 && digits.startsWith(INDIA_COUNTRY_CODE)) {
    const subscriber = digits.slice(2);
    return `+${INDIA_COUNTRY_CODE} ${subscriber.slice(0, 5)} ${subscriber.slice(5)}`;
  }
  return e164;
}
