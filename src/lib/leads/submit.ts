/**
 * The browser's one way to submit an enquiry.
 *
 * Every enquiry form calls this, and the reason it exists as a separate module — rather than
 * a `fetch` inside the form component — is the failure taxonomy. Requirements 6.5, 6.8, 6.9,
 * 6.17, 6.18 and 6.19 each specify a *different* recovery for a different failure, and a form
 * that reads a raw response has to re-derive which one it is looking at. Here the response is
 * classified once, into a closed union, so the form renders a recovery per case and TypeScript
 * refuses to let it forget one.
 *
 * The classification is by error **code**, not by status. Two of these share a status (422 is
 * both a validation failure and a rejected submission) and the recoveries are opposite: one
 * marks fields, the other must not, because naming a field would name the trap.
 *
 * Nothing here retains or clears the visitor's values — the form owns its own state and never
 * resets it on failure, which is how "every other entered value is retained" is guaranteed
 * for all six failure paths at once (6.5, 6.9, 6.17, 6.18, 6.19).
 *
 * Requirements: 6.5, 6.8, 6.9, 6.17, 6.18, 6.19, 26.9.
 */

import type { LeadTypeValue } from '@/schemas/lead';

export const LEADS_ENDPOINT = '/api/leads';

export interface EnquiryPayload {
  type: LeadTypeValue;
  name: string;
  phone: string;
  message: string;
  productSlug?: string;
  requirement?: string;
  budget?: string;
  dimensions?: string;
  honeypot: string;
  renderedAt: number;
}

export type FieldErrors = Record<string, string[]>;

/**
 * Why a submission failed, in the terms the form has to act on.
 *
 * - `validation` — mark the named controls, keep everything (6.5, 6.18).
 * - `rejected` — one generic sentence, no field marked (6.8).
 * - `rate-limited` — the message already names the whole minutes remaining (6.9).
 * - `product-unavailable` — offer the Catalogue (6.17).
 * - `not-recorded` — offer both numbers as the direct alternative (6.19).
 * - `network` — offer a retry *and* both numbers; nothing was sent, or nothing came back.
 * - `unknown` — anything else, treated as `network` would be but named honestly.
 */
export type EnquiryFailureKind =
  | 'validation'
  | 'rejected'
  | 'rate-limited'
  | 'product-unavailable'
  | 'not-recorded'
  | 'network'
  | 'unknown';

export interface EnquiryFailure {
  ok: false;
  kind: EnquiryFailureKind;
  message: string;
  fields: FieldErrors;
  /** Where the Catalogue control should point, for `product-unavailable`. */
  catalogueHref?: string;
}

export interface EnquirySuccess {
  ok: true;
  message: string;
}

export type EnquiryResult = EnquirySuccess | EnquiryFailure;

const NETWORK_MESSAGE =
  'Your enquiry could not be sent — the connection failed. Nothing you typed has been lost: try again, or message or call us on either number.';

const UNKNOWN_MESSAGE =
  'Something went wrong sending this enquiry. Nothing you typed has been lost: try again, or message or call us on either number.';

function kindFor(code: string): EnquiryFailureKind {
  switch (code) {
    case 'VALIDATION_FAILED':
      return 'validation';
    case 'SUBMISSION_REJECTED':
      return 'rejected';
    case 'RATE_LIMITED':
      return 'rate-limited';
    case 'PRODUCT_UNAVAILABLE':
      return 'product-unavailable';
    case 'LEAD_NOT_RECORDED':
    case 'CONFIGURATION_INCOMPLETE':
      // A missing binding is, from the visitor's side, the same event as a failed write: the
      // enquiry was not recorded, and the alternative is the same two numbers.
      return 'not-recorded';
    default:
      return 'unknown';
  }
}

interface Envelope {
  error?: unknown;
  message?: unknown;
  fields?: unknown;
  remote?: unknown;
  ok?: unknown;
}

function readFields(value: unknown): FieldErrors {
  if (typeof value !== 'object' || value === null) return {};
  const fields: FieldErrors = {};
  for (const [key, messages] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(messages)) {
      const strings = messages.filter((entry): entry is string => typeof entry === 'string');
      if (strings.length > 0) fields[key] = strings;
    }
  }
  return fields;
}

function catalogueHrefOf(remote: unknown): string | undefined {
  if (typeof remote !== 'object' || remote === null) return undefined;
  const href = (remote as { catalogueHref?: unknown }).catalogueHref;
  return typeof href === 'string' && href.startsWith('/') ? href : undefined;
}

/**
 * Send one enquiry.
 *
 * A `File` switches the request to multipart. Without one it is JSON, which keeps the four
 * forms that cannot attach an image on the cheaper encoding and means the endpoint's
 * multipart branch is exercised only when there is something to attach.
 */
export async function submitEnquiry(
  payload: EnquiryPayload,
  image?: File | null,
  signal?: AbortSignal,
): Promise<EnquiryResult> {
  let response: Response;
  try {
    if (image != null) {
      const form = new FormData();
      // `Object.entries` widens the value to `any` under the type-checked lint rules, so the two
      // cases the payload actually contains are narrowed explicitly rather than cast.
      for (const [key, value] of Object.entries(payload) as [string, unknown][]) {
        if (typeof value === 'number') form.set(key, String(value));
        else if (typeof value === 'string') form.set(key, value);
      }
      form.set('image', image);
      response = await fetch(LEADS_ENDPOINT, {
        method: 'POST',
        body: form,
        ...(signal === undefined ? {} : { signal }),
      });
    } else {
      response = await fetch(LEADS_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(signal === undefined ? {} : { signal }),
      });
    }
  } catch {
    return { ok: false, kind: 'network', message: NETWORK_MESSAGE, fields: {} };
  }

  let body: Envelope;
  try {
    body = (await response.json()) as Envelope;
  } catch {
    // A response with no readable body: if the status was a success the enquiry may well have
    // been stored, so it is reported as a success with the generic confirmation rather than
    // inviting a duplicate submission.
    if (response.ok) {
      return { ok: true, message: 'Thank you — your enquiry has reached us.' };
    }
    return { ok: false, kind: 'unknown', message: UNKNOWN_MESSAGE, fields: {} };
  }

  if (response.ok && body.ok === true) {
    return {
      ok: true,
      message:
        typeof body.message === 'string'
          ? body.message
          : 'Thank you — your enquiry has reached us.',
    };
  }

  const code = typeof body.error === 'string' ? body.error : '';
  const kind = kindFor(code);
  const failure: EnquiryFailure = {
    ok: false,
    kind,
    message:
      typeof body.message === 'string' && body.message !== ''
        ? body.message
        : kind === 'network'
          ? NETWORK_MESSAGE
          : UNKNOWN_MESSAGE,
    // A `rejected` response must not mark a control, so any fields on it are discarded here
    // rather than trusted not to exist.
    fields: kind === 'rejected' ? {} : readFields(body.fields),
  };
  const href = catalogueHrefOf(body.remote);
  if (href !== undefined) failure.catalogueHref = href;
  return failure;
}
