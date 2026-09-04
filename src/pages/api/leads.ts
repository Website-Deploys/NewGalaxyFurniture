/**
 * `POST /api/leads` — the public enquiry endpoint. The only unauthenticated write in the app.
 *
 * The order of the checks below is the requirement, not a preference, and each step is
 * ordered ahead of the next because it is cheaper, or because answering it later would leak
 * something:
 *
 * ```
 * 1. read the body (JSON or multipart)        — a body that will not parse is a 422
 * 2. anti-spam traps                          — 6.8: one generic sentence for both
 * 3. rate limit, 5 / rolling 60 min / address — 6.9: message names whole minutes left
 * 4. Zod validation                           — 6.5: field-level, everything else kept
 * 5. server-side product resolution           — 6.6 / 6.17: browser claims never trusted
 * 6. optional image, same checks as admin     — 6.11 / 6.18
 * 7. store exactly one lead at NEW            — 6.7; 6.19 on failure
 * ```
 *
 * Two orderings are worth defending. **Traps before the rate limit** costs a bot its budget
 * more slowly, but it means a bot never learns the difference between "rejected" and
 * "rate-limited", and a legitimate visitor whose form went stale is not charged one of their
 * five submissions for it. **Validation after the rate limit** means a malformed submission
 * still consumes an attempt, which is deliberate: an attacker probing field bounds is
 * exactly who the ceiling is for.
 *
 * **There is no CSRF token and no origin check.** Both would be theatre here. The endpoint
 * reads no cookie, carries no ambient authority, and performs no action a third-party page
 * could not perform by asking a human to fill the form — the thing a CSRF token protects
 * against (a request made with the victim's credentials) has no analogue. What actually
 * limits abuse is the address ceiling, the traps, and the fact that the worst outcome is a
 * row in the operator's inbox marked with a spam score.
 *
 * **What is never trusted from the browser:** the product's name, SKU and URL (resolved from
 * the slug), the submission time (server clock), the lead's status (always `NEW`), and the
 * originating page (derived from `Referer`, and only when it is same-origin).
 *
 * Design: Conversion → Lead capture.
 * Requirements: 6.3–6.11, 6.17, 6.18, 6.19, 25.1, 25.6, 25.7, 26.10.
 */

import type { APIContext } from 'astro';
import type { R2Bucket } from '@cloudflare/workers-types';

import { consumeNamedLimit, hashIdentifier } from '@/lib/auth/rate-limit';
import { clientAddress } from '@/lib/auth/guard';
import { createWorkerCodec } from '@/lib/images/codec-photon';
import {
  ERROR_CODES,
  errorResponse,
  jsonResponse,
  logServerError,
  minutesPhrase,
} from '@/lib/errors';
import { generateLeadId, insertLead, type NewLead } from '@/lib/leads/store';
import { getCatalogue } from '@/lib/content/catalogue';
import { getD1, getKV, getPublicConfig, getR2, optionalConfig } from '@/lib/env';
import { LeadSchema, fieldErrorsOf } from '@/schemas/lead';
import { checkTraps, scoreSpam } from '@/lib/leads/spam';
import { resolveProductReference } from '@/lib/leads/resolve';
import { storeEnquiryImage } from '@/lib/leads/image';

export const prerender = false;

/** The confirmation the submitting page renders. Says what happens next, and when. */
export const LEAD_CONFIRMATION =
  'Thank you — your enquiry has reached us. We reply on WhatsApp or by phone, usually the same day.';

/** The largest body the endpoint will read at all: the 12 MB image cap plus the fields. */
const MAX_BODY_BYTES = 13 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* Reading the body                                                           */
/* -------------------------------------------------------------------------- */

interface RawSubmission {
  fields: Record<string, unknown>;
  image: File | null;
}

/**
 * Read the submission from either encoding.
 *
 * Multipart exists only because one form can carry an image; JSON is what the other four
 * send. Both funnel into one record so there is a single validation path — two paths would
 * be two sets of bounds to keep in step.
 *
 * `renderedAt` arrives as a string in multipart and a number in JSON, so it is coerced here
 * rather than by making the schema accept a string: the schema is the contract for the
 * *parsed* payload, and loosening it for a transport detail would loosen it for JSON too.
 */
async function readSubmission(request: Request): Promise<RawSubmission | null> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return null;
    }
    const fields: Record<string, unknown> = {};
    let image: File | null = null;
    for (const [key, value] of form.entries()) {
      if (value instanceof File) {
        // An empty file input still submits an entry with a zero size; that is "no image".
        if (key === 'image' && value.size > 0) image = value;
        continue;
      }
      fields[key] = value;
    }
    if (typeof fields.renderedAt === 'string') {
      const parsed = Number.parseInt(fields.renderedAt, 10);
      fields.renderedAt = Number.isFinite(parsed) ? parsed : Number.NaN;
    }
    return { fields, image };
  }

  if (contentType.includes('application/json')) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return null;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    return { fields: body as Record<string, unknown>, image: null };
  }

  return null;
}

/**
 * The originating page path (Requirement 6.7).
 *
 * Read from `Referer` and accepted only when it is same-origin. A cross-origin referrer is
 * discarded rather than stored: it would be a third party's URL sitting in the operator's inbox,
 * labelled "the page this enquiry came from".
 *
 * **Same-origin is judged against the request's own URL, not against `PUBLIC_SITE_URL`**, and the
 * difference is not academic. A preview deployment, a custom domain that has not been written into
 * the configuration yet, or simply local development all serve the site from a host that is not the
 * configured canonical one — and comparing against the configured value there discards every
 * referrer and stores `null` for every lead's originating page. That was the observed behaviour
 * before this changed: a smoke test against a local server produced correctly stored leads with no
 * source path at all. The request URL is the host the browser actually used, so it is the only
 * comparison that is right in every environment. `siteUrl` is kept as a second accepted origin, so
 * a canonical-host referrer is still honoured behind a proxy that rewrites the request host.
 */
function sourcePathOf(
  request: Request,
  siteUrl: string,
): { path: string | null; raw: string | null } {
  const referer = request.headers.get('referer');
  if (referer === null || referer === '') return { path: null, raw: null };
  try {
    const url = new URL(referer);
    const accepted = new Set<string>([new URL(request.url).origin]);
    try {
      accepted.add(new URL(siteUrl).origin);
    } catch {
      // A malformed `PUBLIC_SITE_URL` leaves the request's own origin as the only acceptable one.
    }
    if (!accepted.has(url.origin)) return { path: null, raw: null };
    return { path: `${url.pathname}${url.search}`.slice(0, 400), raw: referer.slice(0, 400) };
  } catch {
    return { path: null, raw: null };
  }
}

/**
 * A salted hash of the user agent — the only thing derived from the requester, and it is not
 * an identifier: it is stable across every visitor using the same browser build, which is
 * precisely what makes it useful for spotting a script and useless for tracking a person.
 * The address itself is never stored (Requirement 20.2's spirit, applied to leads too).
 */
async function uaHashOf(request: Request, salt: string): Promise<string | null> {
  const ua = request.headers.get('user-agent');
  if (ua === null || ua === '') return null;
  return (await hashIdentifier(`${salt}:${ua}`)).slice(0, 32);
}

/* -------------------------------------------------------------------------- */
/* The handler                                                                */
/* -------------------------------------------------------------------------- */

export async function POST(context: APIContext): Promise<Response> {
  const declared = Number.parseInt(context.request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return errorResponse(ERROR_CODES.VALIDATION_FAILED, {
      fields: { image: ['That file is larger than 12 MB. Send a smaller export.'] },
    });
  }

  // 1. The body.
  const submission = await readSubmission(context.request);
  if (submission === null) {
    return errorResponse(ERROR_CODES.VALIDATION_FAILED, {
      message: 'This enquiry could not be read. Reload the page and try again.',
    });
  }

  // 2. The traps. One sentence, naming neither (Requirement 6.8).
  const renderedAt =
    typeof submission.fields.renderedAt === 'number' ? submission.fields.renderedAt : Number.NaN;
  const honeypot =
    typeof submission.fields.honeypot === 'string' ? submission.fields.honeypot : undefined;
  if (checkTraps({ honeypot, renderedAt })) {
    return errorResponse(ERROR_CODES.SUBMISSION_REJECTED);
  }

  // 3. Five per rolling hour per address (Requirement 6.9).
  try {
    const decision = await consumeNamedLimit(
      getKV(context, 'RATELIMIT'),
      'leadSubmit',
      clientAddress(context.request),
    );
    if (!decision.allowed) {
      return errorResponse(ERROR_CODES.RATE_LIMITED, {
        message:
          `You have sent the maximum number of enquiries for now. Try again in ` +
          `${minutesPhrase(decision.retryAfterMinutes)} — or message or call us on either number, ` +
          `which has no limit. Nothing you typed has been cleared.`,
        headers: { 'retry-after': String(decision.retryAfterMinutes * 60) },
      });
    }
  } catch (error) {
    logServerError('leads: rate limiter unavailable', error);
    return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE);
  }

  // 4. Validation. Field-keyed, so the form marks each failing control and keeps the rest.
  const parsed = LeadSchema.safeParse(submission.fields);
  if (!parsed.success) {
    return errorResponse(ERROR_CODES.VALIDATION_FAILED, {
      fields: fieldErrorsOf(parsed.error),
    });
  }
  const lead = parsed.data;

  let siteUrl: string;
  try {
    siteUrl = getPublicConfig(context).siteUrl;
  } catch (error) {
    logServerError('leads: site URL unavailable', error);
    return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE);
  }

  // 5. The product, resolved on the server or not at all.
  let resolved: { slug: string; name: string; sku: string; url: string } | null = null;
  if (lead.productSlug !== undefined) {
    const outcome = resolveProductReference(lead.productSlug, await getCatalogue(), siteUrl);
    if (!outcome.ok) {
      // The control back to the Catalogue is `fields.productSlug`'s recovery, rendered by
      // the form; the message states the fact and the envelope carries where to go.
      return errorResponse(ERROR_CODES.PRODUCT_UNAVAILABLE, {
        fields: { productSlug: ['This piece is no longer listed.'] },
        remote: { catalogueHref: '/collection' },
      });
    }
    resolved = outcome.product;
  }

  const id = generateLeadId();

  // 6. The attachment. Validated and stored before the lead, so a rejected image rejects the
  // whole submission (6.18) and a stored key always refers to an object that exists.
  let imageKey: string | null = null;
  if (submission.image !== null) {
    let bucket: R2Bucket;
    try {
      bucket = getR2(context);
    } catch (error) {
      logServerError('leads: media bucket unavailable', error);
      return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE);
    }
    try {
      const stored = await storeEnquiryImage(bucket, createWorkerCodec(), id, submission.image);
      if (!stored.ok) {
        return errorResponse(ERROR_CODES.VALIDATION_FAILED, {
          fields: { image: [stored.error.message] },
        });
      }
      imageKey = stored.key;
    } catch (error) {
      logServerError('leads: attachment could not be stored', error);
      return errorResponse(ERROR_CODES.VALIDATION_FAILED, {
        fields: {
          image: [
            'This image could not be processed. Send the enquiry without it and we will ask for it on WhatsApp.',
          ],
        },
      });
    }
  }

  // The marking tier. Never rejects (Requirement 6.10).
  const assessment = scoreSpam({
    name: lead.name,
    message: lead.message,
    requirement: lead.requirement,
    budget: lead.budget,
    dimensions: lead.dimensions,
  });

  const source = sourcePathOf(context.request, siteUrl);
  const salt = optionalConfig(context, 'SESSION_SECRET') ?? 'ngf-ua';

  const record: NewLead = {
    id,
    // The server clock, always (Requirement 6.7). The browser's is not consulted.
    createdAt: new Date().toISOString(),
    type: lead.type,
    name: lead.name,
    phone: lead.phone,
    message: lead.message,
    productSlug: resolved?.slug ?? null,
    productName: resolved?.name ?? null,
    productSku: resolved?.sku ?? null,
    productUrl: resolved?.url ?? null,
    budget: lead.budget ?? null,
    dimensions: lead.dimensions ?? null,
    imageKey,
    sourcePath: source.path,
    referrer: source.raw,
    uaHash: await uaHashOf(context.request, salt),
    country: context.request.headers.get('cf-ipcountry'),
    /**
     * The requirement field is stored on the note.
     *
     * There is no `requirement` column — the design's `leads` table does not have one — and
     * inventing one in a migration would put the same free text in two places for the four
     * forms that have no requirement field. The note is the operator-facing free-text field,
     * it is displayed in the leads admin, and prefixing it names its origin so an operator
     * cannot mistake a visitor's words for a colleague's.
     */
    note:
      lead.requirement === undefined
        ? assessment.reasons.length === 0
          ? null
          : `Flagged: ${assessment.reasons.join(' ')}`
        : `Requirement (from the visitor): ${lead.requirement}` +
          (assessment.reasons.length === 0 ? '' : `\n\nFlagged: ${assessment.reasons.join(' ')}`),
    spamScore: assessment.score,
  };

  // 7. Exactly one lead, at NEW.
  try {
    await insertLead(getD1(context), record);
  } catch (error) {
    logServerError('leads: could not store lead', error);
    // Requirement 6.19: say it was not recorded and offer both numbers. The form renders the
    // controls; the envelope says which failure this is so it knows to.
    return errorResponse(ERROR_CODES.LEAD_NOT_RECORDED);
  }

  return jsonResponse({
    ok: true,
    message: LEAD_CONFIRMATION,
    ...(resolved === null ? {} : { product: { name: resolved.name, sku: resolved.sku } }),
  });
}

/** Every other method gets the envelope rather than Astro's default 404 page. */
export function ALL(): Response {
  return errorResponse(ERROR_CODES.ROUTE_UNKNOWN, {
    message: 'Enquiries are submitted with POST.',
    status: 405,
  });
}
