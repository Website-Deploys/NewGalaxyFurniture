/**
 * The provider contract, and the failure vocabulary every adapter speaks.
 *
 * The interface is deliberately narrow: one method, one request shape, one response shape. That
 * narrowness is the requirement — Requirement 16.15 asks that an additional provider be
 * configurable "without changing the admin interface or the generation contract", and the way to
 * make that true is to give the contract no room for a provider-specific concept. There is no
 * `openaiOptions`, no `temperature`, no streaming: anything a single provider needs and the
 * others do not belongs inside that provider's adapter.
 *
 * `AIProviderError` is the other half. Adapters translate every upstream failure into it, so the
 * endpoint's retry decision (`retryable`) and its response (`AI_UNAVAILABLE`) are provider-blind.
 * The error carries the upstream detail in `detail` for the *log*, and the endpoint never puts
 * `detail` in a response body — that separation is what makes Requirement 16.14 checkable, since
 * there is one field to audit.
 *
 * Design: AI Product Assistant → Provider-agnostic abstraction, Failure handling.
 * Requirements: 16.1, 16.12, 16.14, 16.15, 25.12, 25.14, 25.15.
 */

export interface AIProvider {
  readonly name: string;
  readonly supportsVision: boolean;
  generate(req: AIRequest): Promise<AIResponse>;
}

export interface AIRequest {
  system: string;
  user: string;
  images?: { mime: string; base64: string }[];
  /** Provider-native structured-output constraint. */
  jsonSchema: object;
  maxOutputTokens: number;
  /** 20_000 in production — see `AI_TIMEOUT_MS`. */
  timeoutMs: number;
}

export interface AIResponse {
  /** The model's raw text. Parsing is the caller's job, and a parse failure is a failure. */
  text: string;
}

/** The design's 20-second ceiling (Requirement 16.12). */
export const AI_TIMEOUT_MS = 20_000;

/** Output ceiling. A full suggestion is well under this; the cap is cost containment. */
export const AI_MAX_OUTPUT_TOKENS = 2_000;

/**
 * The closed set of provider names `AI_PROVIDER` may hold.
 *
 * Here rather than in `factory.ts` because the factory reads Worker bindings, and the *vocabulary*
 * of provider names is a fact about the contract that should be readable — and testable — without
 * a Cloudflare runtime. The factory's switch is exhaustive over this union, so adding a name here
 * fails to compile until an adapter and a case exist for it.
 */
export const AI_PROVIDERS = ['openai', 'anthropic', 'workers-ai'] as const;
export type AIProviderName = (typeof AI_PROVIDERS)[number];

export function isProviderName(value: unknown): value is AIProviderName {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value);
}

export type AIFailureKind =
  /** No response within `timeoutMs`. */
  | 'timeout'
  /** Upstream returned a retryable status (429, 5xx) or the connection failed. */
  | 'transient'
  /** Upstream refused permanently: bad key, bad request, quota exhausted. */
  | 'permanent'
  /** A response arrived but was not usable — non-JSON, truncated, or missing every field. */
  | 'unparseable'
  /** The provider is not configured in this environment. */
  | 'unconfigured';

/**
 * A provider failure, normalised.
 *
 * `detail` is for `console.error` only. It may contain an upstream error body, which may in turn
 * echo request content, so it must never be serialised into a response. The endpoint redacts any
 * credential-shaped substring before logging even so — belt and braces, because "the provider
 * will not echo our key back" is an assumption about someone else's code.
 */
export class AIProviderError extends Error {
  readonly kind: AIFailureKind;
  readonly status?: number;
  readonly detail?: string;

  constructor(kind: AIFailureKind, options: { status?: number; detail?: string } = {}) {
    super(`AI provider failure: ${kind}`);
    this.name = 'AIProviderError';
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.detail !== undefined) this.detail = options.detail;
  }

  /** Whether one retry is worth attempting (Requirement 16.12). */
  get retryable(): boolean {
    return this.kind === 'transient' || this.kind === 'timeout';
  }
}

/** Map an HTTP status to a failure kind. Shared so adapters cannot disagree about 429. */
export function kindForStatus(status: number): AIFailureKind {
  if (status === 408 || status === 409 || status === 425 || status === 429) return 'transient';
  if (status >= 500) return 'transient';
  return 'permanent';
}

/**
 * `fetch` with a hard timeout, as one function every adapter uses.
 *
 * `AbortController` rather than `Promise.race`: a race leaves the request in flight, which on a
 * metered provider means the operator is billed for a generation nobody will read. Aborting
 * actually cancels it.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AIProviderError('timeout', { detail: `no response within ${String(timeoutMs)}ms` });
    }
    throw new AIProviderError('transient', {
      detail: error instanceof Error ? error.message : 'network failure',
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read an error response body for the log, bounded.
 *
 * Bounded because an upstream 502 from a proxy is sometimes a full HTML page, and an unbounded
 * `console.error` of one is how a Worker's log budget disappears.
 */
export async function errorDetail(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<error body unreadable>';
  }
}
