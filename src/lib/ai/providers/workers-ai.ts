/**
 * Workers AI adapter.
 *
 * The third provider, and the one that shows the abstraction is not merely "two HTTP APIs behind
 * a shared shape": Workers AI is reached through a **binding**, not a URL, and it has no API key
 * at all — the credential is the Worker's own identity. The adapter therefore takes an `Ai`
 * binding rather than a config object with a key, and the factory supplies it. Nothing outside
 * this file changes as a result, which is what Requirement 16.15 is asking for.
 *
 * Structured output is requested through the `response_format: json_schema` field the Workers AI
 * text-generation models accept. Vision support depends on the selected model, so
 * `supportsVision` is derived from the model name rather than asserted: the endpoint checks it and
 * omits images instead of sending them somewhere they will be ignored.
 *
 * Requirements: 16.1, 16.2, 16.12, 16.15.
 */

import { AIProviderError, type AIProvider, type AIRequest, type AIResponse } from '../provider';

/**
 * The slice of the Workers AI binding this adapter uses.
 *
 * Declared structurally rather than imported: `@cloudflare/workers-types` types `Ai.run` with a
 * generated union of every model name, which would pin this file to whichever model list shipped
 * with the installed types version.
 */
export interface WorkersAiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface WorkersAIConfig {
  binding: WorkersAiBinding;
  model?: string;
}

/** Models whose names indicate vision capability. */
function visionCapable(model: string): boolean {
  return /vision|llava|vl(?:-|$)/i.test(model);
}

export function createWorkersAIProvider(config: WorkersAIConfig): AIProvider {
  const model = config.model ?? '@cf/meta/llama-3.1-8b-instruct';

  return {
    name: 'workers-ai',
    supportsVision: visionCapable(model),

    async generate(request: AIRequest): Promise<AIResponse> {
      // The binding has no abort signal, so the timeout is imposed here. A settled race is
      // acceptable in this one case: a Workers AI call is billed by neurons consumed, and
      // there is no in-flight request to a third party left dangling.
      const timeout = new Promise<never>((_resolve, reject) => {
        setTimeout(
          () =>
            reject(new AIProviderError('timeout', { detail: 'binding did not settle in time' })),
          request.timeoutMs,
        );
      });

      let raw: unknown;
      try {
        raw = await Promise.race([
          config.binding.run(model, {
            max_tokens: request.maxOutputTokens,
            temperature: 0,
            response_format: { type: 'json_schema', json_schema: request.jsonSchema },
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
          }),
          timeout,
        ]);
      } catch (error) {
        if (error instanceof AIProviderError) throw error;
        throw new AIProviderError('transient', {
          detail: error instanceof Error ? error.message : 'binding failure',
        });
      }

      // The binding returns `{ response: string }` for text generation, and `response` is an
      // object when a JSON schema was honoured.
      if (typeof raw === 'object' && raw !== null && 'response' in raw) {
        const value: unknown = raw.response;
        if (typeof value === 'string' && value.trim() !== '') return { text: value };
        if (typeof value === 'object' && value !== null) return { text: JSON.stringify(value) };
      }

      throw new AIProviderError('unparseable', { detail: 'unexpected binding response shape' });
    },
  };
}
