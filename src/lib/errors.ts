/**
 * The uniform API error envelope and the disclosure boundary.
 *
 * Every failure that crosses to a browser goes through `errorResponse` or `toClientError`, and both
 * build their body with `errorEnvelope`. That single chokepoint is what makes Requirement 25.14
 * checkable rather than aspirational, and it holds in two ways that are worth naming separately:
 *
 * 1. **Nothing internal is ever passed in.** An unrecognised throw becomes `INTERNAL_ERROR` with a
 *    fixed sentence. The thrown value is not inspected for a message, because a thrown provider error
 *    frequently *is* the upstream body — forwarding it is precisely what the requirement forbids.
 * 2. **Anything that gets in anyway is replaced.** `errorEnvelope` runs every displayed sentence and
 *    every field message through `disclosureRisk`, which recognises stack frames, module and
 *    filesystem paths, upstream URLs, SQL fragments, binding names and credential shapes. A message
 *    that trips any of them is swapped for the code's default sentence and the original is logged.
 *    This is the part that makes the guarantee structural: `AppError` messages are caller-written and
 *    therefore "safe by convention", and a convention is one hurried
 *    `new AppError(CODE, { message: String(error) })` away from a leak.
 *
 * `logServerError` is the other half. Everything the response withholds is written to the Worker log
 * — name, message, stack, cause chain, and the caller's context identifiers — with credential-shaped
 * substrings redacted, because a log line outlives the request that produced it.
 *
 * Design: Error Handling → Disclosure policy; Write Pipeline → Endpoint contracts.
 * Requirements: 25.13, 25.14, 25.15, 26.10.
 */

export const ERROR_CODES = {
  /** Origin or Referer did not match the deployment origin. Checked before anything else. */
  ORIGIN_MISMATCH: 'ORIGIN_MISMATCH',
  /** No session, or the session expired. The cookie is cleared alongside this. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** Session valid, `X-CSRF-Token` missing or wrong. */
  CSRF_INVALID: 'CSRF_INVALID',
  /** Session valid, role lacks the route's declared permission. */
  FORBIDDEN: 'FORBIDDEN',
  /** Method/path matched no entry in ADMIN_ROUTES. */
  ROUTE_UNKNOWN: 'ROUTE_UNKNOWN',
  /** Wrong or missing Content-Type. */
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  /** Payload failed its Zod schema. Carries `fields`. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** Uniform login failure for both unknown email and wrong password. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** A rate limit or a lockout. The message names whole minutes remaining. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** The stored record changed since it was loaded. Carries `remote`. */
  CONFLICT: 'CONFLICT',
  /**
   * The request is valid but has a consequence the operator has to accept first, and
   * **nothing was written**. Requirements 12.7, 12.11 and 12.12 each require an explicit
   * confirmation — a slug change must not happen as a side effect of an edit, and a
   * deletion must name its target. This is not `VALIDATION_FAILED`: no field is wrong.
   * `fields` names what needs confirming so the message renders in place, and `remote`
   * carries the proposal the UI needs to describe the consequence.
   */
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  /** The requested record does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** A status change the transition machine does not declare. */
  TRANSITION_NOT_ALLOWED: 'TRANSITION_NOT_ALLOWED',
  /** The publish gate rejected the product. Carries `fields`. */
  PUBLISH_GATE_FAILED: 'PUBLISH_GATE_FAILED',
  /** A resolved write path was not on the allowlist. */
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  /** The GitHub write failed for a reason other than a conflict. Values are retained. */
  REPOSITORY_UNAVAILABLE: 'REPOSITORY_UNAVAILABLE',
  /** A required binding or secret is not configured. */
  CONFIGURATION_INCOMPLETE: 'CONFIGURATION_INCOMPLETE',
  /**
   * A public submission tripped an anti-spam trap.
   *
   * Deliberately one code with one sentence for **both** the honeypot and the minimum
   * form age (Requirement 6.8): the message must not say which check fired, because
   * telling a bot which of the two it failed is telling it how to pass. It is not
   * `VALIDATION_FAILED` for the same reason — that code carries `fields`, and a field
   * path would identify the trap.
   */
  SUBMISSION_REJECTED: 'SUBMISSION_REJECTED',
  /**
   * An enquiry referenced a product that is no longer in the Catalogue
   * (Requirement 6.17). Distinct from `NOT_FOUND` because the visitor's other values are
   * retained and the message carries a route back to the Catalogue.
   */
  PRODUCT_UNAVAILABLE: 'PRODUCT_UNAVAILABLE',
  /**
   * A lead passed every check and could not be stored (Requirement 6.19). Distinct from
   * `INTERNAL_ERROR` because the recovery is specific and must be offered: both business
   * numbers, as WhatsApp and Call, as the direct alternative.
   */
  LEAD_NOT_RECORDED: 'LEAD_NOT_RECORDED',
  /**
   * The AI assistant could not produce suggestions — for any reason.
   *
   * One code for every failure mode of that endpoint (provider down, timeout, malformed
   * completion, missing configuration, rate limit at the provider), because the operator's
   * recovery is identical in all of them: continue manually. Distinguishing them in the response
   * would tell an operator something they cannot act on and would leak which provider is
   * configured and how it failed — the endpoint is specified as provider-blind on the way out
   * (Requirement 16.13). It was previously hand-rolled inside the endpoint with a code that was
   * not in this union at all, which is exactly the drift the envelope exists to prevent.
   */
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  /** Anything unclassified. Detail goes to the logs, never to the response. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** The one response body shape for every admin and public API failure. */
export interface ErrorEnvelope {
  error: ErrorCode;
  message: string;
  /** Field path → messages. Present only for validation and publish-gate failures. */
  fields?: Record<string, string[]>;
  /** The current stored value, for a 409 the operator has to diff against. */
  remote?: unknown;
}

/** Default sentences. Safe to display: no internal detail, always a next action. */
const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  ORIGIN_MISMATCH: 'This request did not come from the admin application.',
  UNAUTHENTICATED: 'Your session has ended. Sign in again to continue.',
  CSRF_INVALID: 'This request could not be verified. Reload the page and try again.',
  FORBIDDEN: 'Your role does not allow this action.',
  ROUTE_UNKNOWN: 'That admin endpoint does not exist.',
  UNSUPPORTED_MEDIA_TYPE: 'This endpoint expects a JSON request body.',
  VALIDATION_FAILED: 'Some fields need attention.',
  INVALID_CREDENTIALS: 'Those credentials are not correct.',
  RATE_LIMITED: 'Too many attempts. Try again shortly.',
  CONFLICT: 'Someone else changed this since you opened it. Review the differences below.',
  CONFIRMATION_REQUIRED: 'This change needs your confirmation. Nothing has been saved yet.',
  NOT_FOUND: 'That record could not be found.',
  TRANSITION_NOT_ALLOWED: 'That status change is not available from the current status.',
  PUBLISH_GATE_FAILED: 'This product is not ready to publish yet.',
  PATH_NOT_ALLOWED: 'That content location cannot be written to.',
  REPOSITORY_UNAVAILABLE:
    'Could not save to the content repository. Your changes are kept locally — retry.',
  CONFIGURATION_INCOMPLETE: 'This feature is not configured for this environment yet.',
  INTERNAL_ERROR: 'Something went wrong. Nothing was changed — try again.',
  // One sentence for both traps, naming neither. It still gives a real way through.
  SUBMISSION_REJECTED:
    'We could not accept this enquiry. Please try again, or message or call us on either number — both reach the same people.',
  PRODUCT_UNAVAILABLE:
    'The piece this enquiry refers to is no longer available. Everything else you typed has been kept — browse the Catalogue and pick another piece, or send the enquiry without a product.',
  LEAD_NOT_RECORDED:
    'Your enquiry was not recorded. Nothing has been lost from this page — message or call us on either number and you will reach the same people.',
  AI_UNAVAILABLE:
    'Suggestions are unavailable right now. Continue filling the form manually — nothing you have typed is affected.',
};

/** The HTTP status each code is returned with. */
const STATUS: Record<ErrorCode, number> = {
  ORIGIN_MISMATCH: 403,
  UNAUTHENTICATED: 401,
  CSRF_INVALID: 403,
  FORBIDDEN: 403,
  ROUTE_UNKNOWN: 404,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VALIDATION_FAILED: 422,
  INVALID_CREDENTIALS: 401,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  CONFIRMATION_REQUIRED: 409,
  NOT_FOUND: 404,
  TRANSITION_NOT_ALLOWED: 422,
  PUBLISH_GATE_FAILED: 422,
  PATH_NOT_ALLOWED: 422,
  REPOSITORY_UNAVAILABLE: 502,
  CONFIGURATION_INCOMPLETE: 503,
  INTERNAL_ERROR: 500,
  SUBMISSION_REJECTED: 422,
  PRODUCT_UNAVAILABLE: 422,
  // 503 rather than 500: the enquiry was well-formed and the store was unavailable.
  LEAD_NOT_RECORDED: 503,
  // 503: the request was fine and an optional dependency was not. The form stays usable.
  AI_UNAVAILABLE: 503,
};

export function statusForErrorCode(code: ErrorCode): number {
  return STATUS[code];
}

/* -------------------------------------------------------------------------- */
/* The disclosure boundary                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Credential-shaped substrings, replaced before any text is logged.
 *
 * Every known provider key prefix, bearer headers, and the header/JSON forms in which a provider
 * echoes one back inside an error body. This lives here rather than in the AI module because the
 * GitHub client, the endpoint wrappers and the logger all need it, and a redactor that exists in one
 * caller is a redactor the next caller forgets.
 *
 * Requirements: 16.14, 25.13.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[REDACTED]')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '$1-[REDACTED]')
    .replace(/\bghp_[A-Za-z0-9]{8,}/g, 'ghp_[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}/g, 'github_pat_[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(
      /("?(?:api[_-]?key|authorization|x-api-key|token|secret|password)"?\s*[:=]\s*"?)[^"\s,}]{8,}/gi,
      '$1[REDACTED]',
    );
}

/**
 * The names of every binding and secret this deployment reads.
 *
 * A response that names one tells a reader how the deployment is wired and which secret to go
 * looking for. They are matched as whole words, upper-snake being distinctive enough that no English
 * sentence in a message contains one by accident.
 */
const INTERNAL_IDENTIFIERS = [
  'GITHUB_TOKEN',
  'GITHUB_OWNER',
  'GITHUB_REPO',
  'GITHUB_BRANCH',
  'ADMIN_SESSION_SECRET',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AI_PROVIDER',
  'CF_ACCOUNT_ID',
  'CF_API_TOKEN',
  'SESSIONS',
  'DRAFTS',
  'RATE_LIMIT',
  'IMAGES',
  'LEAD_IMAGES',
  'ANALYTICS',
];

/**
 * Every shape of internal detail that must not cross the boundary.
 *
 * Each one is a thing an unfiltered failure genuinely produces: a stack frame from a thrown `Error`,
 * a module path from a bundler, a `file:///` or `/var/task/` prefix from a runtime, a Windows drive
 * path from a local build, an upstream provider URL, an SQL fragment from a D1 error, a binding
 * name, a credential.
 */
const DISCLOSURE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'stack frame', pattern: /\bat\s+[\w$.<>[\] ]+\s*\(/ },
  { name: 'stack frame', pattern: /\.(?:ts|tsx|js|mjs|cjs|astro):\d+(?::\d+)?/ },
  { name: 'error class name', pattern: /\b(?:TypeError|ReferenceError|SyntaxError|RangeError)\b/ },
  { name: 'file url', pattern: /\bfile:\/\// },
  {
    name: 'filesystem path',
    pattern: /(?:^|[\s"'(=])\/(?:home|root|usr|var|tmp|etc|opt|projects|proc|dev|workspace)\//i,
  },
  { name: 'windows path', pattern: /\b[A-Za-z]:\\/ },
  { name: 'node_modules path', pattern: /node_modules/ },
  { name: 'upstream url', pattern: /https?:\/\/(?:api|[a-z0-9-]*\.?api)\./i },
  { name: 'sql fragment', pattern: /\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)\s+[\w"'`(*]/i },
  { name: 'sql error', pattern: /\bD1_[A-Z_]+\b|\bSQLITE_[A-Z_]+\b/ },
  { name: 'credential', pattern: /\b(?:ghp_|github_pat_|sk-|sk-ant-)[A-Za-z0-9_-]{8,}/ },
  { name: 'credential header', pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  {
    name: 'internal identifier',
    pattern: new RegExp(`\\b(?:${INTERNAL_IDENTIFIERS.join('|')})\\b`),
  },
];

/** The reason a string is unsafe to display, or null when there is none. */
export function disclosureRisk(text: string): string | null {
  for (const { name, pattern } of DISCLOSURE_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return null;
}

/** True when a string carries no internal detail and may be shown to a browser. */
export function isDisclosureSafe(text: string): boolean {
  return disclosureRisk(text) === null;
}

/**
 * The gate every displayed sentence passes.
 *
 * A message that looks like internal detail is *replaced*, not redacted: a half-scrubbed stack trace
 * is still a stack trace, and the default sentence for the code is a better answer than a mangled
 * one. The original goes to `logServerError`, where it belongs.
 *
 * This is what makes the guarantee structural rather than a convention. `AppError` messages are
 * caller-written and therefore in principle safe, but "in principle" is one careless
 * `new AppError(CODE, { message: String(error) })` away from a leak, and that call site is a
 * plausible thing for someone to write in a hurry.
 */
function safeMessage(message: string, fallback: string): string {
  const risk = disclosureRisk(message);
  if (risk === null) return message;
  console.error(`[errors] a ${risk} was replaced before it reached a response`);
  return fallback;
}

/** The same gate over field-level messages, whose values are echoed back to a form. */
function safeFields(fields: Record<string, string[]>): Record<string, string[]> {
  const safe: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(fields)) {
    safe[field] = messages.map((message) =>
      safeMessage(message, 'This value could not be accepted.'),
    );
  }
  return safe;
}

export function errorEnvelope(
  code: ErrorCode,
  overrides: { message?: string; fields?: Record<string, string[]>; remote?: unknown } = {},
): ErrorEnvelope {
  const fallback = DEFAULT_MESSAGES[code];
  return {
    error: code,
    message: overrides.message === undefined ? fallback : safeMessage(overrides.message, fallback),
    ...(overrides.fields === undefined ? {} : { fields: safeFields(overrides.fields) }),
    ...(overrides.remote === undefined ? {} : { remote: overrides.remote }),
  };
}

export function errorResponse(
  code: ErrorCode,
  overrides: {
    message?: string;
    fields?: Record<string, string[]>;
    remote?: unknown;
    headers?: Record<string, string>;
    status?: number;
  } = {},
): Response {
  return new Response(JSON.stringify(errorEnvelope(code, overrides)), {
    status: overrides.status ?? STATUS[code],
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Admin API responses are per-session and must never be shared or indexed.
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      ...overrides.headers,
    },
  });
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      ...init.headers,
    },
  });
}

/**
 * A typed failure that a handler may throw and the endpoint wrapper turns into a
 * response. It carries only display-safe material by construction.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly fields?: Record<string, string[]>;
  readonly remote?: unknown;

  constructor(
    code: ErrorCode,
    options: { message?: string; fields?: Record<string, string[]>; remote?: unknown } = {},
  ) {
    super(options.message ?? DEFAULT_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    if (options.fields !== undefined) this.fields = options.fields;
    if (options.remote !== undefined) this.remote = options.remote;
  }
}

/**
 * Map any thrown value to an envelope.
 *
 * An unrecognised throw becomes `INTERNAL_ERROR` with the default sentence. The
 * original is deliberately not inspected for a message: a thrown provider error
 * frequently *is* the upstream body, and forwarding it is precisely what
 * Requirement 25.14 forbids. Callers log the original themselves.
 */
export function toClientError(thrown: unknown): ErrorEnvelope {
  if (thrown instanceof AppError) {
    return errorEnvelope(thrown.code, {
      message: thrown.message,
      ...(thrown.fields === undefined ? {} : { fields: thrown.fields }),
      ...(thrown.remote === undefined ? {} : { remote: thrown.remote }),
    });
  }
  return errorEnvelope(ERROR_CODES.INTERNAL_ERROR);
}

/** `toClientError`, as a Response. */
export function toClientErrorResponse(thrown: unknown): Response {
  const envelope = toClientError(thrown);
  return errorResponse(envelope.error, {
    message: envelope.message,
    ...(envelope.fields === undefined ? {} : { fields: envelope.fields }),
    ...(envelope.remote === undefined ? {} : { remote: envelope.remote }),
  });
}

/* -------------------------------------------------------------------------- */
/* The server-side log                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Write a failure to the Worker log with full detail and no credentials.
 *
 * The counterpart of `toClientError`, and the reason that function is allowed to be so uninformative:
 * everything it withholds is recorded here. The name, the message, the stack, and the cause chain all
 * go to the log — that is where a path and a line number are *useful* — and every one of them passes
 * through `redactSecrets` first, because a provider that echoes an `Authorization` header inside an
 * error body would otherwise put a live key into a log that outlives the request.
 *
 * `context` is for the identifiers that make a log line actionable: a product id, a slug, a status.
 * It is deliberately `Record<string, string | number | boolean>` rather than `unknown` so nobody
 * passes the whole request body — which, on the lead endpoint, would be a visitor's name and phone
 * number written into a log that stores no visitor data by design (Requirement 20.2).
 *
 * Every API route's `catch` calls this, so "log the detail, return the envelope" is one line in each
 * place rather than a `console.error` shape that drifts per file.
 *
 * Requirements: 25.13, 25.14, 25.15.
 */
export function logServerError(
  scope: string,
  thrown: unknown,
  context: Record<string, string | number | boolean> = {},
): void {
  const parts: string[] = [`[${scope}]`];

  if (thrown instanceof AppError) {
    parts.push(`${thrown.code}: ${thrown.message}`);
  } else if (thrown instanceof Error) {
    parts.push(`${thrown.name}: ${thrown.message}`);
    if (typeof thrown.stack === 'string') parts.push(`\n${thrown.stack}`);
    const cause: unknown = (thrown as { cause?: unknown }).cause;
    if (cause instanceof Error) parts.push(`\ncaused by ${cause.name}: ${cause.message}`);
    else if (typeof cause === 'string') parts.push(`\ncaused by ${cause}`);
  } else if (typeof thrown === 'string') {
    parts.push(thrown);
  } else if (thrown !== undefined && thrown !== null) {
    // A thrown non-Error — frequently an upstream response body. Bounded, because one unbounded
    // log line is how a Worker's log budget disappears.
    let serialized: string;
    try {
      serialized = JSON.stringify(thrown);
    } catch {
      serialized = '[unserialisable thrown value]';
    }
    parts.push(serialized.slice(0, 2000));
  } else {
    parts.push('threw a nullish value');
  }

  const entries = Object.entries(context);
  if (entries.length > 0) {
    parts.push(`\ncontext: ${entries.map(([key, value]) => `${key}=${String(value)}`).join(' ')}`);
  }

  console.error(redactSecrets(parts.join(' ')));
}

/** "3 minutes" / "1 minute" — rate-limit messages state whole minutes (26.10). */
export function minutesPhrase(minutes: number): string {
  const whole = Math.max(1, Math.ceil(minutes));
  return whole === 1 ? '1 minute' : `${whole} minutes`;
}
