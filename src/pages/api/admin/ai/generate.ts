/**
 * `POST /api/admin/ai/generate` — a suggestion, and nothing else.
 *
 * What this endpoint can do is deliberately tiny: read images from R2, call the configured
 * provider, guard the result, return it. What it *cannot* do is the point:
 *
 * - **It cannot write anything.** No repository client, no KV write, no product record. It returns
 *   JSON to the browser and the operator decides what to keep. The only status the AI flow can
 *   produce is `DRAFT`, and only through `POST /api/admin/products` driven by the operator
 *   (Requirement 16.11).
 * - **It cannot leak the provider.** The response body contains a suggestion, warnings, and a
 *   stable error code. It never contains the provider name, the model name, the key, or an
 *   upstream error body; those go to `console.error` with credential-shaped substrings redacted
 *   first (Requirements 16.14, 25.14, 25.15).
 * - **It cannot be unbounded.** 20 generations per hour per session, from the shared
 *   `KV_RATE_LIMITS.aiGenerate` row, because each call spends the operator's provider budget
 *   (Requirement 16.13).
 *
 * Every failure — timeout, unparseable output, provider error, missing configuration — returns
 * `503 {error:'AI_UNAVAILABLE'}` with a sentence that tells the operator to continue manually.
 * A single stable code is on purpose: distinguishing "the provider timed out" from "the provider
 * refused our key" in a browser response would tell an attacker about our infrastructure and tells
 * the operator nothing they can act on (Requirement 16.12).
 *
 * Design: AI Product Assistant → Provider-agnostic abstraction, Failure handling.
 * Requirements: 16.1, 16.2, 16.11, 16.12, 16.13, 16.14, 16.15, 25.12, 25.14, 25.15.
 */

import type { APIContext } from 'astro';
import { z } from 'zod';

import { AIProviderError } from '@/lib/ai/provider';
import { consumeNamedLimit } from '@/lib/auth/rate-limit';
import { createAIProvider } from '@/lib/ai/factory';
import { createGitHubClient } from '@/lib/github/factory';
import { DERIVATIVE_WIDTHS, derivativeKey } from '@/lib/images/srcset';
import {
  ERROR_CODES,
  errorResponse,
  jsonResponse,
  logServerError,
  minutesPhrase,
} from '@/lib/errors';
import { generateSuggestion } from '@/lib/ai/generate';
import { getKV, getR2 } from '@/lib/env';
import { getPublishedCategories } from '@/lib/content/catalogue';
import { readValidatedJson, requireAdmin } from '@/lib/auth/guard';
import { StockStatus } from '@/schemas/product';

export const prerender = false;

/**
 * The sentence every AI failure returns, alongside `ERROR_CODES.AI_UNAVAILABLE`.
 *
 * The code lives in `ERROR_CODES` (task 21.6's envelope audit moved it there). It used to be a local
 * constant, on the reasoning that the enum is shared envelope vocabulary while this code belongs to
 * one screen — with the consequence that one endpoint answered in a body nothing else produced,
 * carrying a code no consumer could discover from the union. "Every API failure uses the uniform
 * envelope" is only checkable if there is one list, and a feature-specific code is still a member of
 * it. The literal the design names and the assistant UI matches on is unchanged.
 */
const AI_UNAVAILABLE_MESSAGE =
  'Suggestions are unavailable just now. The product form is fully usable — continue manually and nothing will be lost.';

/** The width whose derivative is sent to the provider (the design's 640 px). */
const VISION_WIDTH = 640;

/**
 * Admin facts, as the browser may state them.
 *
 * `.strict()` so an unrecognised key is a validation failure rather than being carried into the
 * prompt unexamined. Note the absence of `status`, `published` and `sku`: the request has no way
 * to mention them, so the endpoint has nothing to ignore.
 */
const DimensionsInput = z
  .object({
    lengthCm: z.number().positive().optional(),
    widthCm: z.number().positive().optional(),
    heightCm: z.number().positive().optional(),
    depthCm: z.number().positive().optional(),
    display: z.string().max(120).optional(),
  })
  .strict();

const GenerateInputSchema = z
  .object({
    facts: z
      .object({
        rawNotes: z.string().max(4000).optional(),
        name: z.string().max(120).optional(),
        category: z.string().max(80).optional(),
        price: z.number().int().positive().nullable().optional(),
        originalPrice: z.number().int().positive().nullable().optional(),
        priceOnEnquiry: z.boolean().optional(),
        material: z.string().max(120).optional(),
        color: z.string().max(60).optional(),
        availableColors: z.array(z.string().max(60)).max(20).optional(),
        dimensions: DimensionsInput.optional(),
        size: z.string().max(60).optional(),
        stockStatus: StockStatus.optional(),
        madeToOrder: z.boolean().optional(),
        customization: z.string().max(2000).optional(),
        deliveryInformation: z.string().max(2000).optional(),
        adminTags: z.array(z.string().max(40)).max(24).optional(),
      })
      .strict(),
    /** The product the images belong to, and the image ids to send. */
    productId: z
      .string()
      .regex(/^p_[a-z0-9]{10}$/)
      .optional(),
    imageIds: z
      .array(z.string().regex(/^img_[a-z0-9]{10}$/))
      .max(6)
      .default([]),
  })
  .strict();

/** Base64 without a data-URL prefix. Chunked so a large image cannot blow the stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 8192;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export async function POST(context: APIContext): Promise<Response> {
  const guard = await requireAdmin(context, 'ai.generate');
  if (!guard.ok) return guard.response;

  const body = await readValidatedJson(context.request, GenerateInputSchema);
  if (!body.ok) return body.response;

  // Rate limit after validation but before any spend. Keyed by session, because the budget being
  // protected is the operator's provider bill, not a per-address abuse surface.
  try {
    const decision = await consumeNamedLimit(
      getKV(context, 'RATELIMIT'),
      'aiGenerate',
      guard.session.id,
    );
    if (!decision.allowed) {
      return errorResponse(ERROR_CODES.RATE_LIMITED, {
        message: `You have used this hour's 20 suggestions. Try again in ${minutesPhrase(decision.retryAfterMinutes)} — the product form works without it.`,
        headers: { 'retry-after': String(decision.retryAfterMinutes * 60) },
      });
    }
  } catch (error) {
    logServerError('ai: rate limit unavailable', error);
    return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE);
  }

  const provider = createAIProvider(context);
  if (!provider.ok) {
    // The reason names a missing secret and stays in the log. The browser learns only that
    // suggestions are unavailable.
    console.error(`[ai] provider unavailable: ${provider.reason}`);
    return jsonUnavailable();
  }

  // --- The images ------------------------------------------------------------
  const images: { imageId: string; mime: string; base64: string }[] = [];
  const imageWarnings: string[] = [];
  if (body.value.imageIds.length > 0 && body.value.productId !== undefined) {
    try {
      const bucket = getR2(context);
      for (const imageId of body.value.imageIds) {
        // The 640 px WebP derivative: enough for a model to see form and colour, and a fraction
        // of the original's bytes. The width comes from the shared ladder so this cannot ask for
        // a derivative the pipeline never writes.
        if (!DERIVATIVE_WIDTHS.includes(VISION_WIDTH)) break;
        const object = await bucket.get(
          derivativeKey(body.value.productId, imageId, VISION_WIDTH, 'webp'),
        );
        if (object === null) {
          imageWarnings.push(
            `One image is still being optimised, so it was not sent for analysis. Generate again in a moment to include it.`,
          );
          continue;
        }
        images.push({
          imageId,
          mime: 'image/webp',
          base64: toBase64(new Uint8Array(await object.arrayBuffer())),
        });
      }
    } catch (error) {
      // Missing media binding: proceed on the notes alone rather than refusing. A suggestion
      // from the notes is worth more than no suggestion.
      logServerError('ai: could not read image derivatives', error);
      imageWarnings.push(
        'The product photographs could not be read, so the suggestion is based on your notes alone.',
      );
    }
  }

  // --- Generate --------------------------------------------------------------
  try {
    const outcome = await generateSuggestion(provider.provider, {
      facts: body.value.facts,
      images,
      categorySlugs: await categorySlugs(context),
    });

    if (outcome.retried) console.warn('[ai] first attempt failed; the retry succeeded');

    return jsonResponse({
      suggestion: outcome.suggestion,
      warnings: [...imageWarnings, ...outcome.warnings],
      /** Echoed so the UI can label each field and record `aiFields` on create. */
      imageIds: images.map((image) => image.imageId),
    });
  } catch (error) {
    if (error instanceof AIProviderError) {
      /*
       * The one place an upstream body is written down. It goes through the shared logger, which
       * redacts credential shapes on the way out — the same redaction the GitHub client and every
       * other catch block get, rather than this endpoint's own copy of it.
       */
      logServerError('ai: generation failed', error.detail ?? 'no detail', {
        kind: error.kind,
        ...(error.status === undefined ? {} : { status: error.status }),
      });
    } else {
      logServerError('ai: generation failed with an unexpected error', error);
    }
    return jsonUnavailable();
  }
}

/**
 * The category slugs a suggestion may be assigned to.
 *
 * Read from the repository first, because a category created since the last deploy is not in the
 * bundled collection and the guard would otherwise null it with a warning for a category that
 * genuinely exists. This is a *read* — `listCategorySlugs` lists a directory — so it does not
 * give this endpoint a write path: nothing here ever calls `writeFile`, and the path allowlist
 * would be the second line if it did.
 *
 * The bundled collection is the fallback, so a repository hiccup degrades to "the categories as of
 * the last deploy" rather than to "no category may be assigned".
 */
async function categorySlugs(context: APIContext): Promise<string[]> {
  try {
    const slugs = await createGitHubClient(context).listCategorySlugs();
    if (slugs.length > 0) return slugs;
  } catch (error) {
    logServerError('ai: could not list categories from the repository', error);
  }
  try {
    return (await getPublishedCategories()).map((category) => category.slug);
  } catch (error) {
    logServerError('ai: could not read the bundled categories', error);
    return [];
  }
}

/**
 * `503 {error:'AI_UNAVAILABLE'}` — the single outcome for every failure mode.
 *
 * Through `errorResponse` rather than a hand-built body: the code is now a member of `ERROR_CODES`,
 * so this endpoint answers in the same envelope, with the same headers, as every other one. It used
 * to construct its own response with a code that was not in the union, which meant the "every API
 * failure uses the uniform envelope" rule had one silent exception (Requirement 25.14).
 */
function jsonUnavailable(): Response {
  return errorResponse(ERROR_CODES.AI_UNAVAILABLE, { message: AI_UNAVAILABLE_MESSAGE });
}
