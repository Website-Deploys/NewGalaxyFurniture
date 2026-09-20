/**
 * Provider selection: one switch, driven by the `AI_PROVIDER` environment variable.
 *
 * This is the "one file plus one switch case" seam of Requirement 16.15. Nothing else in the
 * codebase names a provider — the endpoint asks the factory for an `AIProvider` and does not
 * learn which one it got, and the browser is never told either (Requirement 16.14).
 *
 * Both supported providers are external HTTP APIs (OpenAI, Anthropic) reached with an API key read
 * from the environment. There is no Cloudflare Workers AI binding: the migration removed it, so the
 * provider set is exactly the two key-based HTTP adapters, and adding a third (e.g. Gemini) is still
 * "one file plus one switch case".
 *
 * An unconfigured environment is a first-class outcome, not an exception to smother: the assistant
 * is an accelerator and the manual product form must remain fully usable without it
 * (Requirement 16.12). `createAIProvider` returns a discriminated result rather than throwing, so
 * the endpoint's "not configured" path is visible in its control flow and never crashes a page.
 *
 * Design: AI Product Assistant → Provider-agnostic abstraction.
 * Requirements: 16.12, 16.14, 16.15, 25.12, 25.13.
 */

import { createAnthropicProvider } from './providers/anthropic';
import { createOpenAIProvider } from './providers/openai';
import { optionalConfig } from '@/lib/env';
import { isProviderName } from './provider';
import type { AIProvider } from './provider';
import type { RuntimeCarrier } from '@/lib/env';

export { AI_PROVIDERS, isProviderName, type AIProviderName } from './provider';

export type ProviderResult =
  | { ok: true; provider: AIProvider }
  /**
   * `reason` is for the server log. It names the missing variable, never its value, and never
   * reaches a response body — the endpoint answers `CONFIGURATION_INCOMPLETE` with its own
   * sentence.
   */
  | { ok: false; reason: string };

/**
 * Build the configured provider.
 *
 * The API key is read here, handed straight to the adapter's closure, and never returned, logged,
 * or attached to anything the caller can serialise. `requireSecret`/`optionalConfig`'s contract is
 * that the result is for immediate server-side use; this is that use.
 */
export function createAIProvider(context: RuntimeCarrier): ProviderResult {
  const configured = optionalConfig(context, 'AI_PROVIDER');
  if (configured === undefined) {
    return { ok: false, reason: 'AI_PROVIDER is not set' };
  }
  if (!isProviderName(configured)) {
    // The name is echoed into the *log* only. It is operator-supplied configuration rather than a
    // secret, and naming it is the difference between a fixable misconfiguration and a mystery.
    return { ok: false, reason: `AI_PROVIDER "${configured}" is not a supported provider` };
  }

  const model = optionalConfig(context, 'AI_MODEL');
  const apiKey = optionalConfig(context, 'AI_API_KEY');
  if (apiKey === undefined) return { ok: false, reason: 'AI_API_KEY is not set' };

  switch (configured) {
    case 'openai':
      return {
        ok: true,
        provider: createOpenAIProvider({ apiKey, ...(model === undefined ? {} : { model }) }),
      };
    case 'anthropic':
      return {
        ok: true,
        provider: createAnthropicProvider({ apiKey, ...(model === undefined ? {} : { model }) }),
      };
  }
}
