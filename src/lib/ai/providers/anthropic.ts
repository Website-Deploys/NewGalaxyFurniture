/**
 * Anthropic adapter.
 *
 * Structurally identical to the OpenAI one, which is the point: adding a provider is one file
 * plus one switch case (Requirement 16.15), and this file is the evidence that the contract in
 * `provider.ts` is genuinely provider-neutral rather than OpenAI's shape with a different name.
 *
 * The Messages API has no `response_format`, so the JSON schema is delivered as a **tool** with
 * `tool_choice` forcing its use — the provider-native structured-output mechanism here. The
 * response is then read out of the tool-use block rather than out of free text. Where a model
 * ignores the forcing and answers in prose, that is an `unparseable` failure, not something to
 * salvage with a regex.
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

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const TOOL_NAME = 'emit_product_draft';

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
}

interface MessagesResponse {
  content?: { type?: string; name?: string; text?: string; input?: unknown }[];
  stop_reason?: string;
}

export function createAnthropicProvider(config: AnthropicConfig): AIProvider {
  const model = config.model ?? 'claude-3-5-sonnet-latest';

  return {
    name: 'anthropic',
    supportsVision: true,

    async generate(request: AIRequest): Promise<AIResponse> {
      const content: unknown[] = [];
      for (const image of request.images ?? []) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: image.mime, data: image.base64 },
        });
      }
      content.push({ type: 'text', text: request.user });

      const response = await fetchWithTimeout(
        ENDPOINT,
        {
          method: 'POST',
          headers: {
            'x-api-key': config.apiKey,
            'anthropic-version': API_VERSION,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: request.maxOutputTokens,
            temperature: 0,
            system: request.system,
            tools: [
              {
                name: TOOL_NAME,
                description: 'Return the product draft suggestion.',
                input_schema: request.jsonSchema,
              },
            ],
            tool_choice: { type: 'tool', name: TOOL_NAME },
            messages: [{ role: 'user', content }],
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

      let payload: MessagesResponse;
      try {
        payload = (await response.json()) as MessagesResponse;
      } catch {
        throw new AIProviderError('unparseable', { detail: 'response envelope was not JSON' });
      }

      if (payload.stop_reason === 'max_tokens') {
        throw new AIProviderError('unparseable', { detail: 'response truncated by token limit' });
      }

      const toolUse = payload.content?.find(
        (block) => block.type === 'tool_use' && block.name === TOOL_NAME,
      );
      if (toolUse?.input !== undefined) {
        // The tool input is already an object. Re-serialising keeps the adapter's contract
        // (`text`) uniform, so the endpoint has exactly one parse path for all providers.
        return { text: JSON.stringify(toolUse.input) };
      }

      throw new AIProviderError('unparseable', {
        detail: 'no tool_use block in the response despite forced tool choice',
      });
    },
  };
}
