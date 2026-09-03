/**
 * OpenAI adapter.
 *
 * A thin translation layer and nothing else: request shape in, `AIResponse` out, every failure
 * normalised to `AIProviderError`. It holds no retry logic, no timeout policy and no prompt —
 * those belong to the endpoint and to `prompt.ts`, so that all three providers behave identically
 * under failure and produce comparable output.
 *
 * Structured output is requested through `response_format: json_schema` with `strict: true`,
 * which is the provider-native constraint the design's `AIRequest.jsonSchema` field exists for.
 * It is a strong hint, not a guarantee — which is exactly why the fact guard runs regardless of
 * whether the model honoured it.
 *
 * Requirements: 16.1, 16.2, 16.12, 16.14, 16.15.
 */

import {
  AIProviderError,
  errorDetail,
  fetchWithTimeout,
  kindForStatus,
  type AIProvider,
  type AIRequest,
  type AIResponse,
} from '../provider';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export interface OpenAIConfig {
  apiKey: string;
  /** Defaults to a vision-capable model; overridden by the `AI_MODEL` secret. */
  model?: string;
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
}

export function createOpenAIProvider(config: OpenAIConfig): AIProvider {
  const model = config.model ?? 'gpt-4o-mini';

  return {
    name: 'openai',
    supportsVision: true,

    async generate(request: AIRequest): Promise<AIResponse> {
      const content: unknown[] = [{ type: 'text', text: request.user }];
      for (const image of request.images ?? []) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${image.mime};base64,${image.base64}`, detail: 'low' },
        });
      }

      const response = await fetchWithTimeout(
        ENDPOINT,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: request.maxOutputTokens,
            // Zero temperature: this is an extraction task, not a creative one, and the fact
            // guard is easier to reason about when the model is as literal as it can be.
            temperature: 0,
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'product_draft', strict: true, schema: request.jsonSchema },
            },
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content },
            ],
          }),
        },
        request.timeoutMs,
      );

      if (!response.ok) {
        throw new AIProviderError(kindForStatus(response.status), {
          status: response.status,
          detail: await errorDetail(response),
        });
      }

      let payload: ChatCompletion;
      try {
        payload = (await response.json()) as ChatCompletion;
      } catch {
        throw new AIProviderError('unparseable', { detail: 'response envelope was not JSON' });
      }

      const choice = payload.choices?.[0];
      const text = choice?.message?.content ?? '';
      // A length-truncated completion is partial JSON. Requirement 16.12 says partial content is
      // a failure, so it is refused here rather than handed to a tolerant parser downstream.
      if (choice?.finish_reason === 'length') {
        throw new AIProviderError('unparseable', { detail: 'completion truncated by token limit' });
      }
      if (text.trim() === '') {
        throw new AIProviderError('unparseable', { detail: 'empty completion' });
      }
      return { text };
    },
  };
}
