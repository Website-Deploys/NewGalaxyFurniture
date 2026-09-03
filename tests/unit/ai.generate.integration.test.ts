import { describe, expect, it, vi } from 'vitest';

import {
  AI_PROVIDERS,
  AI_TIMEOUT_MS,
  AIProviderError,
  isProviderName,
  type AIProvider,
  type AIRequest,
} from '@/lib/ai/provider';
import { applyFactGuard } from '@/lib/ai/fact-guard';
import { createOpenAIProvider } from '@/lib/ai/providers/openai';
import { generateSuggestion, redactSecrets, RETRY_BASE_MS } from '@/lib/ai/generate';
import {
  parseSuggestionJson,
  suggestionJsonSchema,
  systemPrompt,
  userPrompt,
} from '@/lib/ai/prompt';

/**
 * The AI flow end to end, against a stubbed provider.
 *
 * The four scenarios the design's failure table names — success, timeout, malformed JSON, provider
 * error — are exercised through `generateSuggestion`, which is the whole flow minus the Astro
 * request plumbing: prompt assembly, the provider call, the retry decision, the parse, and the fact
 * guard. Stubbing at the `AIProvider` seam rather than at `fetch` is deliberate: it is the seam the
 * design defines, so these tests assert the contract every future provider must satisfy rather than
 * one provider's wire format.
 *
 * The `sleep` and `random` injections mean the retry path is tested at full speed and
 * deterministically. A test that actually waited 400–1000 ms per retry would be a test people skip.
 *
 * Requirements: 16.1, 16.2, 16.5, 16.8, 16.11, 16.12, 16.14, 16.15, 25.14, 25.15.
 */

const CATEGORY_SLUGS = ['sofas', 'beds', 'dining-tables'];

/** A well-formed model response. */
const GOOD_JSON = JSON.stringify({
  name: 'Rolled-Arm Three-Seater Sofa',
  shortDescription: 'A three-seater with rolled arms and a low back.',
  description:
    'A three-seater sofa with gently rolled arms and a low back. The cushions are removable, and the proportions suit a compact living room. The seat is deep enough to sit back into.',
  category: 'sofas',
  subcategory: 'three-seater',
  material: 'Sheesham Wood',
  color: 'Charcoal',
  styleTags: ['modern', 'upholstered', 'living-room', 'award-winning'],
  features: ['Removable cushions', 'Rolled arms', 'Backed by a 10-year warranty'],
  seoTitle: 'Rolled-Arm Three-Seater Sofa',
  seoDescription: 'A three-seater sofa with rolled arms, removable cushions and a low back.',
  keywords: ['modern', 'sofa-not-in-vocabulary', 'living-room'],
  imageAltText: [
    { imageId: 'img_aaaaaaaaaa', alt: 'A charcoal three-seater sofa seen from the front.' },
    { imageId: 'img_zzzzzzzzzz', alt: 'An image that was not part of this request.' },
  ],
  whatsappText: 'Hi, I am interested in the Rolled-Arm Three-Seater Sofa.',
  // Smuggled: the model asking to publish. The guard must drop these.
  status: 'PUBLISHED',
  published: true,
  price: 42000,
});

interface StubOptions {
  /** Responses in order. A function may throw to simulate a failure on that attempt. */
  attempts: (string | (() => never))[];
  supportsVision?: boolean;
}

function stubProvider(options: StubOptions): { provider: AIProvider; requests: AIRequest[] } {
  const requests: AIRequest[] = [];
  let attempt = 0;
  return {
    requests,
    provider: {
      name: 'stub',
      supportsVision: options.supportsVision ?? true,
      generate(request: AIRequest) {
        requests.push(request);
        const next = options.attempts[attempt] ?? options.attempts[options.attempts.length - 1];
        attempt += 1;
        if (typeof next === 'function') next();
        return Promise.resolve({ text: next as string });
      },
    },
  };
}

const noSleep = (): Promise<void> => Promise.resolve();
const fixedRandom = (): number => 0.5;

const IMAGES = [{ imageId: 'img_aaaaaaaaaa', mime: 'image/webp', base64: 'AAAA' }];

function run(options: StubOptions, facts = {}): ReturnType<typeof generateSuggestion> {
  const stub = stubProvider(options);
  return generateSuggestion(stub.provider, {
    facts,
    images: IMAGES,
    categorySlugs: CATEGORY_SLUGS,
    sleep: noSleep,
    random: fixedRandom,
  });
}

describe('success', () => {
  it('returns a guarded suggestion, with the guard applied to the model’s own output', async () => {
    const outcome = await run({ attempts: [GOOD_JSON] }, { material: 'Mango Wood' });

    expect(outcome.retried).toBe(false);
    expect(outcome.suggestion.name.value).toBe('Rolled-Arm Three-Seater Sofa');
    expect(outcome.suggestion.category.value).toBe('sofas');

    // The admin's material wins over the model's, and the override is reported.
    expect(outcome.suggestion.material.value).toBe('Mango Wood');
    expect(outcome.suggestion.material.source).toBe('admin');
    expect(outcome.warnings.some((w) => w.includes('Sheesham Wood'))).toBe(true);

    // Colour was not supplied, so it is blank despite the model offering one.
    expect(outcome.suggestion.color.value).toBeNull();
    expect(outcome.warnings.some((w) => w.startsWith('Colour:'))).toBe(true);

    // The award tag is outside the vocabulary; the warranty feature is a banned claim.
    expect(outcome.suggestion.styleTags.value).not.toContain('award-winning');
    expect(outcome.suggestion.features.value.join(' ')).not.toMatch(/warranty/i);
    expect(outcome.suggestion.keywords.value).not.toContain('sofa-not-in-vocabulary');

    // Alt text for an image that was not part of the request is dropped.
    expect(outcome.suggestion.imageAltText.value.map((entry) => entry.imageId)).toEqual([
      'img_aaaaaaaaaa',
    ]);

    // And nothing about publication survives.
    const escaped = outcome.suggestion as unknown as Record<string, unknown>;
    expect('status' in escaped).toBe(false);
    expect('published' in escaped).toBe(false);
    expect('price' in escaped).toBe(false);
  });

  it('sends the same prompt, schema and timeout regardless of provider', async () => {
    const stub = stubProvider({ attempts: [GOOD_JSON] });
    await generateSuggestion(stub.provider, {
      facts: { rawNotes: 'beige three-seater' },
      images: IMAGES,
      categorySlugs: CATEGORY_SLUGS,
    });

    const [request] = stub.requests;
    expect(request).toBeDefined();
    expect(request!.timeoutMs).toBe(AI_TIMEOUT_MS);
    expect(request!.jsonSchema).toEqual(suggestionJsonSchema());
    expect(request!.system).toBe(systemPrompt(CATEGORY_SLUGS));
    // The user prompt names the unsupplied fields explicitly, which is what keeps the model from
    // filling them in and the guard from having to.
    expect(request!.user).toContain('NOT SUPPLIED');
    expect(request!.user).toContain('img_aaaaaaaaaa');
  });

  it('omits images for a provider without vision rather than sending them to be discarded', async () => {
    const stub = stubProvider({ attempts: [GOOD_JSON], supportsVision: false });
    await generateSuggestion(stub.provider, {
      facts: {},
      images: IMAGES,
      categorySlugs: CATEGORY_SLUGS,
    });
    expect(stub.requests[0]?.images).toBeUndefined();
  });
});

describe('timeout', () => {
  it('retries once, then fails with a timeout', async () => {
    const timeout = (): never => {
      throw new AIProviderError('timeout', { detail: 'no response within 20000ms' });
    };
    const stub = stubProvider({ attempts: [timeout, timeout] });

    await expect(
      generateSuggestion(stub.provider, {
        facts: {},
        images: [],
        categorySlugs: CATEGORY_SLUGS,
        sleep: noSleep,
        random: fixedRandom,
      }),
    ).rejects.toMatchObject({ name: 'AIProviderError', kind: 'timeout' });

    // Exactly two attempts: one retry, not a loop.
    expect(stub.requests).toHaveLength(2);
  });

  it('succeeds when the retry succeeds, and says so', async () => {
    const timeout = (): never => {
      throw new AIProviderError('timeout');
    };
    const outcome = await run({ attempts: [timeout, GOOD_JSON] });
    expect(outcome.retried).toBe(true);
    expect(outcome.suggestion.name.value).toBe('Rolled-Arm Three-Seater Sofa');
  });

  it('waits a jittered backoff before the retry', async () => {
    // Typed with the parameter, so `mock.calls[0][0]` is the backoff and not `never`.
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const stub = stubProvider({
      attempts: [
        (): never => {
          throw new AIProviderError('transient', { status: 429 });
        },
        GOOD_JSON,
      ],
    });

    await generateSuggestion(stub.provider, {
      facts: {},
      images: [],
      categorySlugs: CATEGORY_SLUGS,
      sleep,
      random: () => 0.5,
    });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0]).toBe(RETRY_BASE_MS + 300);
  });
});

describe('malformed JSON', () => {
  /** Requirement 16.12: partial or unparseable content is a failure, never coerced. */
  const cases: readonly (readonly [string, string])[] = [
    ['not JSON at all', 'I cannot help with that request.'],
    ['a truncated object', '{"name":"Sofa","description":"A three-seat'],
    ['a JSON array', '[{"name":"Sofa"}]'],
    ['an empty string', ''],
    ['a bare string', '"just a string"'],
    ['an object with none of the expected keys', '{"error":"content_filter","code":42}'],
  ];

  for (const [label, text] of cases) {
    it(`fails on ${label} rather than salvaging it`, async () => {
      await expect(run({ attempts: [text] })).rejects.toMatchObject({
        name: 'AIProviderError',
        kind: 'unparseable',
      });
    });
  }

  it('does not retry unparseable output', async () => {
    // A second identical call at temperature 0 would very likely return the same broken JSON and
    // bill the operator twice for it.
    const stub = stubProvider({ attempts: ['nonsense', GOOD_JSON] });
    await expect(
      generateSuggestion(stub.provider, {
        facts: {},
        images: [],
        categorySlugs: CATEGORY_SLUGS,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ kind: 'unparseable' });
    expect(stub.requests).toHaveLength(1);
  });

  it('unwraps a fenced code block, which is formatting rather than corruption', () => {
    const parsed = parseSuggestionJson('```json\n{"name":"Sofa","description":"x"}\n```');
    expect(parsed?.name).toBe('Sofa');
    // But a truncated object inside a fence still fails.
    expect(parseSuggestionJson('```json\n{"name":"Sofa","desc\n```')).toBeNull();
  });
});

describe('provider error', () => {
  it('does not retry a permanent refusal', async () => {
    const stub = stubProvider({
      attempts: [
        (): never => {
          throw new AIProviderError('permanent', { status: 401, detail: 'invalid api key' });
        },
        GOOD_JSON,
      ],
    });

    await expect(
      generateSuggestion(stub.provider, {
        facts: {},
        images: [],
        categorySlugs: CATEGORY_SLUGS,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ kind: 'permanent', status: 401 });
    // Retrying a 401 turns one failure into two and tells the operator nothing new.
    expect(stub.requests).toHaveLength(1);
  });

  it('retries a transient status once', async () => {
    for (const status of [429, 500, 502, 503]) {
      const stub = stubProvider({
        attempts: [
          (): never => {
            throw new AIProviderError('transient', { status });
          },
          GOOD_JSON,
        ],
      });
      const outcome = await generateSuggestion(stub.provider, {
        facts: {},
        images: [],
        categorySlugs: CATEGORY_SLUGS,
        sleep: noSleep,
        random: fixedRandom,
      });
      expect(outcome.retried).toBe(true);
    }
  });

  it('normalises an unexpected throw rather than letting it escape', async () => {
    const stub = stubProvider({
      attempts: [
        (): never => {
          throw new TypeError('something inside the adapter broke');
        },
        (): never => {
          throw new TypeError('again');
        },
      ],
    });
    await expect(
      generateSuggestion(stub.provider, {
        facts: {},
        images: [],
        categorySlugs: CATEGORY_SLUGS,
        sleep: noSleep,
        random: fixedRandom,
      }),
    ).rejects.toMatchObject({ name: 'AIProviderError' });
  });
});

describe('no credential or provider identity can reach the client', () => {
  it('redacts every credential shape from a detail string before it is logged', () => {
    const shapes: readonly string[] = [
      'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'ghp_abcdefghijklmnopqrstuvwxyz1234',
      'github_pat_11ABCDEFG0abcdefghijkl',
    ];
    for (const secret of shapes) {
      const redacted = redactSecrets(`upstream said: {"error":"bad key ${secret}"}`);
      expect(redacted).not.toContain(secret);
      expect(redacted).toContain('[REDACTED]');
    }

    expect(redactSecrets('Authorization: Bearer abcdef1234567890')).not.toContain(
      'abcdef1234567890',
    );
    expect(redactSecrets('{"api_key":"abcdef1234567890"}')).not.toContain('abcdef1234567890');
  });

  it('keeps the upstream body out of the error the endpoint would serialise', async () => {
    const stub = stubProvider({
      attempts: [
        (): never => {
          throw new AIProviderError('permanent', {
            status: 400,
            detail: 'gpt-4o-mini rejected the request; org-abc123',
          });
        },
      ],
    });

    try {
      await generateSuggestion(stub.provider, {
        facts: {},
        images: [],
        categorySlugs: CATEGORY_SLUGS,
        sleep: noSleep,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      // The detail exists for the log. The *message* — the only field a careless caller might
      // forward — names neither the model nor the organisation.
      expect(error).toBeInstanceOf(AIProviderError);
      const failure = error as AIProviderError;
      expect(failure.message).toBe('AI provider failure: permanent');
      expect(failure.message).not.toContain('gpt-4o-mini');
      expect(failure.message).not.toContain('org-abc123');
    }
  });

  it('the suggestion object names no provider, model or key', async () => {
    const outcome = await run({ attempts: [GOOD_JSON] });
    const serialised = JSON.stringify({
      suggestion: outcome.suggestion,
      warnings: outcome.warnings,
    });
    for (const forbidden of [
      'openai',
      'anthropic',
      'workers-ai',
      'gpt-',
      'claude',
      'sk-',
      'AI_API_KEY',
    ]) {
      expect(serialised.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('an adapter never puts its key in the request it builds beyond the auth header', async () => {
    // The OpenAI adapter is constructed with a key and asked to call a stubbed fetch. The body it
    // sends must not carry the key: a key in a JSON body is a key in every proxy log on the path.
    const captured: { url: string; init: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((url: string, init: RequestInit) => {
      captured.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: GOOD_JSON } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof globalThis.fetch;

    try {
      const provider = createOpenAIProvider({ apiKey: 'sk-test-secret-value-1234567890' });
      await provider.generate({
        system: 'x',
        user: 'y',
        jsonSchema: suggestionJsonSchema(),
        maxOutputTokens: 100,
        timeoutMs: 1_000,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const call = captured[0];
    expect(call).toBeDefined();
    const body = call!.init.body;
    expect(typeof body).toBe('string');
    expect(body as string).not.toContain('sk-test-secret-value');
    expect(JSON.stringify(call!.init.headers)).toContain('sk-test-secret-value');
  });
});

describe('the provider seam', () => {
  it('has one adapter per declared provider name, and the names are closed', () => {
    expect([...AI_PROVIDERS]).toEqual(['openai', 'anthropic', 'workers-ai']);
    for (const name of AI_PROVIDERS) expect(isProviderName(name)).toBe(true);
    for (const name of ['gemini', 'OPENAI', '', 'openai '])
      expect(isProviderName(name)).toBe(false);
  });

  it('the prompt lists only existing categories, so a suggestion cannot invent one', () => {
    const prompt = systemPrompt(CATEGORY_SLUGS);
    for (const slug of CATEGORY_SLUGS) expect(prompt).toContain(slug);
    expect(prompt).toContain('or return null');
  });

  it('the user prompt states unsupplied fields and repeats no fact it was not given', () => {
    const prompt = userPrompt({ material: 'Teak' }, []);
    expect(prompt).toContain('Material: Teak');
    expect(prompt).toContain('NOT SUPPLIED');
    expect(prompt).toContain('Colour');
    expect(prompt).toContain('No photographs were supplied');
  });
});

describe('the guard runs on every path into a stored suggestion', () => {
  it('is applied by generateSuggestion, not left to the caller', async () => {
    // The same raw output, guarded directly and through the flow, must agree — which is what
    // establishes that the flow has no bypass.
    const direct = applyFactGuard(
      JSON.parse(GOOD_JSON) as Record<string, unknown>,
      {},
      {
        categorySlugs: CATEGORY_SLUGS,
        imageIds: ['img_aaaaaaaaaa'],
      },
    );
    const viaFlow = await run({ attempts: [GOOD_JSON] });
    expect(viaFlow.suggestion).toEqual(direct.guarded);
  });
});
