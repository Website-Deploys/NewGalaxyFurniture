/**
 * The generation flow, extracted from the endpoint so it can be tested against a stub provider.
 *
 * The endpoint (`src/pages/api/admin/ai/generate.ts`) is the guard, the rate limit, the bindings
 * and the response envelope. Everything that decides *what happens* — the timeout, the single
 * jittered retry, the parse, the guard, the redaction of what is logged — is here, taking an
 * `AIProvider` as an argument. That is what lets the integration suite exercise success, timeout,
 * malformed JSON and provider error without a network, and without asserting against an Astro
 * context.
 *
 * The retry policy, precisely (Requirement 16.12): **one** retry, and only when the failure is
 * retryable — a transient upstream status or a timeout. A permanent refusal (bad key, bad request)
 * is not retried, because retrying a 401 is a way to turn one failure into two. `unparseable` is
 * not retried either: partial JSON is a failure, and a second identical call at temperature 0 is
 * very likely to produce the same partial JSON while spending the operator's budget twice.
 *
 * Requirements: 16.1, 16.2, 16.5, 16.12, 16.14, 25.14, 25.15.
 */

import { applyFactGuard, type AdminFacts, type ProductDraftSuggestion } from './fact-guard';
import { AI_MAX_OUTPUT_TOKENS, AI_TIMEOUT_MS, AIProviderError } from './provider';
import { parseSuggestionJson, suggestionJsonSchema, systemPrompt, userPrompt } from './prompt';
import type { AIProvider } from './provider';

export interface GenerateInput {
  facts: AdminFacts;
  /** The 640 px derivatives the endpoint fetched from R2, in image order. */
  images: { imageId: string; mime: string; base64: string }[];
  categorySlugs: readonly string[];
  timeoutMs?: number;
  /** Injected in tests so the retry path does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests so the jitter is deterministic. */
  random?: () => number;
}

export interface GenerateOutcome {
  suggestion: ProductDraftSuggestion;
  warnings: string[];
  /** True when the first attempt failed and the retry succeeded. Shown to nobody; logged. */
  retried: boolean;
}

/** Base backoff before the single retry. Jittered to avoid synchronised retries. */
export const RETRY_BASE_MS = 400;
export const RETRY_JITTER_MS = 600;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Redact anything credential-shaped before a detail string reaches a log.
 *
 * Re-exported from `@/lib/errors` rather than implemented twice. `detail` here is an upstream error
 * body — providers do sometimes echo a request header back in an error — and the redactor that runs
 * over it must be the same one the shared logger and the GitHub client use, or the three drift and
 * only one of them catches a newly-shaped key (Requirements 16.14, 25.13).
 */
export { redactSecrets } from '@/lib/errors';

/**
 * Generate, guard, and return a suggestion.
 *
 * Throws `AIProviderError` on failure. It never throws anything else: a bug in the parse path
 * surfaces as `unparseable` rather than as a 500, so the operator's form always receives the
 * documented "suggestions unavailable, continue manually" outcome.
 */
export async function generateSuggestion(
  provider: AIProvider,
  input: GenerateInput,
): Promise<GenerateOutcome> {
  const timeoutMs = input.timeoutMs ?? AI_TIMEOUT_MS;
  const sleep = input.sleep ?? defaultSleep;
  const random = input.random ?? Math.random;

  const request = {
    system: systemPrompt(input.categorySlugs),
    user: userPrompt(
      input.facts,
      input.images.map((image) => image.imageId),
    ),
    // A provider without vision gets no images rather than images it will discard.
    ...(provider.supportsVision && input.images.length > 0
      ? { images: input.images.map(({ mime, base64 }) => ({ mime, base64 })) }
      : {}),
    jsonSchema: suggestionJsonSchema(),
    maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
    timeoutMs,
  };

  let retried = false;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const response = await provider.generate(request);
      const parsed = parseSuggestionJson(response.text);
      if (parsed === null) {
        throw new AIProviderError('unparseable', {
          detail: `could not parse a suggestion from ${String(response.text.length)} characters of output`,
        });
      }

      const { guarded, warnings } = applyFactGuard(parsed, input.facts, {
        categorySlugs: input.categorySlugs,
        imageIds: input.images.map((image) => image.imageId),
        ...(input.facts.adminTags === undefined ? {} : { extraVocabulary: input.facts.adminTags }),
      });
      return { suggestion: guarded, warnings, retried };
    } catch (error) {
      const failure =
        error instanceof AIProviderError
          ? error
          : new AIProviderError('transient', {
              detail: error instanceof Error ? error.message : 'unknown failure',
            });

      if (attempt === 1 && failure.retryable) {
        retried = true;
        await sleep(RETRY_BASE_MS + Math.floor(random() * RETRY_JITTER_MS));
        continue;
      }
      throw failure;
    }
  }
}
