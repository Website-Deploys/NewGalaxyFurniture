/**
 * Provider selection: one switch, driven by the `AI_PROVIDER` secret.
 *
 * This is the "one file plus one switch case" seam of Requirement 16.15. Nothing else in the
 * codebase names a provider — the endpoint asks the factory for an `AIProvider` and does not
 * learn which one it got, and the browser is never told either (Requirement 16.14).
 *
 * The switch is exhaustive over a closed union rather than a lookup in a record, so adding
 * `'gemini'` to `AI_PROVIDERS` fails to compile until the case is written. A record with a
 * fallback would silently accept an unhandled name and fail at request time instead.
 *
 * An unconfigured environment is a first-class outcome, not an exception to smother: the assistant
 * is an accelerator and the manual product form must remain fully usable without it
 * (Requirement 16.12). `createAIProvider` therefore returns a discriminated result rather than
 * throwing, so the endpoint's "not configured" path is visible in its control flow.
 *
 * Design: AI Product Assistant → Provider-agnostic abstraction.
 * Requirements: 16.12, 16.14, 16.15, 25.12, 25.13.
 */

import { createAnthropicProvider } from './providers/anthropic';
import { createOpenAIProvider } from './providers/openai';
import { createWorkersAIProvider, type WorkersAiBinding } from './providers/workers-ai';
import { getWorkerEnv, optionalConfig } from '@/lib/env';
import { isProviderName } from './provider';
import type { AIProvider } from './provider';
import type { RuntimeCarrier } from '@/lib/env';

export { AI_PROVIDERS, isProviderName, type AIProviderName } from './provider';

export type ProviderResult =
  | { ok: true; provider: AIProvider }
  /**
   * `reason` is for the server log. It names the missing secret, never its value, and never
   * reaches a response body — the endpoint answers `CONFIGURATION_INCOMPLETE` with its own
   * sentence.
   */
  | { ok: false; reason: string };

/**
 * Build the configured provider.
 *
 * The API key is read here, handed straight to the adapter's closure, and never returned,
 * logged, or attached to anything the caller can serialise. `requireSecret`'s contract is that
 * its result is for immediate server-side use; this is that use.
 */
export function createAIProvider(context: RuntimeCarrier): ProviderResult {
  const configured = optionalConfig(context, 'AI_PROVIDER');
  if (configured === undefined) {
    return { ok: false, reason: 'AI_PROVIDER is not set' };
  }
  if (!isProviderName(configured)) {
    // The name is echoed into the *log* only. It is operator-supplied configuration rather than
    // a secret, and naming it is the difference between a fixable misconfiguration and a mystery.
    return { ok: false, reason: `AI_PROVIDER "${configured}" is not a supported provider` };
  }

  const model = optionalConfig(context, 'AI_MODEL');

  switch (configured) {
    case 'openai': {
      const apiKey = optionalConfig(context, 'AI_API_KEY');
      if (apiKey === undefined) return { ok: false, reason: 'AI_API_KEY is not set' };
      return {
        ok: true,
        provider: createOpenAIProvider({ apiKey, ...(model === undefined ? {} : { model }) }),
      };
    }
    case 'anthropic': {
      const apiKey = optionalConfig(context, 'AI_API_KEY');
      if (apiKey === undefined) return { ok: false, reason: 'AI_API_KEY is not set' };
      return {
        ok: true,
        provider: createAnthropicProvider({ apiKey, ...(model === undefined ? {} : { model }) }),
      };
    }
    case 'workers-ai': {
      // No key: the binding *is* the credential. See the adapter's header.
      const binding = readAiBinding(context);
      if (binding === null) {
        return { ok: false, reason: 'the AI binding is not present in this environment' };
      }
      return {
        ok: true,
        provider: createWorkersAIProvider({ binding, ...(model === undefined ? {} : { model }) }),
      };
    }
  }
}

/**
 * The Workers AI binding, or null.
 *
 * `WorkerEnv` does not declare `AI` — it is added to `wrangler.toml` only when Workers AI is the
 * chosen provider, and adding an always-optional field to the shared env interface for one
 * provider's benefit would put a provider concept in a provider-neutral place. It is read
 * structurally here, which keeps the coupling inside the factory.
 */
function readAiBinding(context: RuntimeCarrier): WorkersAiBinding | null {
  let env: Record<string, unknown>;
  try {
    env = getWorkerEnv(context) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
  const binding = env.AI;
  if (typeof binding !== 'object' || binding === null) return null;
  const candidate = binding as { run?: unknown };
  return typeof candidate.run === 'function' ? (binding as WorkersAiBinding) : null;
}
