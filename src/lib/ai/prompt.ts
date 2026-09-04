/**
 * The system prompt, the admin-facts rendering, and the JSON schema the provider is constrained
 * to.
 *
 * A word on what this file is *for*, because it is easy to over-invest in. The prompt is an
 * optimisation, not a control. It reduces how often the model asserts something it should not,
 * which saves the operator warnings to read — but `applyFactGuard` is what makes the output safe,
 * and it runs identically whether the model followed these instructions or ignored them entirely.
 * If the prompt and the guard ever disagree, the guard wins, and the prompt is the thing to fix.
 *
 * Keeping the prompt here rather than inside the adapters is what makes the three providers
 * comparable: they receive the same system text, the same user text and the same schema, so a
 * difference in output is a difference between models rather than between our prompts.
 *
 * Requirements: 16.1, 16.2, 16.5, 16.8, 16.9, 16.10.
 */

import { ALLOWED_STYLE_TAGS, FIELD_LIMITS, LIST_LIMITS, type AdminFacts } from './fact-guard';

/**
 * The rules, stated as prohibitions with reasons.
 *
 * The reasons are included deliberately: instruction-following improves when a constraint is
 * explained rather than merely asserted, and the reasons are also the honest description of the
 * policy for any human who reads this file later.
 */
export function systemPrompt(categorySlugs: readonly string[]): string {
  return [
    'You write catalogue copy for a furniture retailer in Bangalore, India. You produce JSON only, matching the provided schema exactly.',
    '',
    "ABSOLUTE RULES. A deterministic filter runs on your output and removes anything that breaks them, so breaking one wastes the operator's time rather than achieving anything:",
    '',
    '1. Assert no fact that is not in the OPERATOR FACTS below. If the material, colour, dimensions, size, price, stock status, delivery terms or customisation options are not stated there, leave those fields empty. Do not infer them from the photographs. A brown surface in a photograph is not evidence of teak.',
    '2. Never mention: how long the business has traded, any certification or standard, any award, any number of customers, employees, showrooms or factories, any delivery time, any warranty or guarantee period, or any claim to be the best, largest, cheapest or number one anywhere.',
    "3. Never state a price. Prices are the operator's to publish.",
    '4. Describe only what is visibly present in the photographs and what the operator stated. Say "appears to be" nowhere — if you are unsure, omit it.',
    '5. Write plain text. No markdown, no HTML, no emoji, no bullet characters.',
    '6. Indian English, and Indian conventions: "colour", "customisation", "₹" for currency (though you will not state prices).',
    '',
    'STYLE. Concrete and specific about form, proportion and use. A short description says what the piece is and who it suits. A full description covers form, construction as visible, and the room it belongs in. No superlatives, no marketing throat-clearing, no "elevate your space".',
    '',
    `CATEGORY. Choose exactly one of these existing category slugs, or return null: ${categorySlugs.join(', ') || '(none configured — return null)'}.`,
    '',
    `STYLE TAGS AND KEYWORDS. Choose only from this closed vocabulary; anything else is discarded: ${ALLOWED_STYLE_TAGS.join(', ')}.`,
    '',
    'LENGTHS. name ≤ ' +
      String(FIELD_LIMITS.name) +
      ' characters, shortDescription ≤ ' +
      String(FIELD_LIMITS.shortDescription) +
      ', description ≤ 1200, seoTitle ≤ ' +
      String(FIELD_LIMITS.seoTitle) +
      ', seoDescription ≤ ' +
      String(FIELD_LIMITS.seoDescription) +
      ', each feature ≤ ' +
      String(FIELD_LIMITS.feature) +
      ', each alt text ≤ ' +
      String(FIELD_LIMITS.alt) +
      `, at most ${String(LIST_LIMITS.features)} features and ${String(LIST_LIMITS.keywords)} keywords.`,
    '',
    'ALT TEXT. One entry per supplied image id, describing what that photograph shows for someone who cannot see it. Not a caption, not a sales line.',
    '',
    'WHATSAPP TEXT. One or two sentences a customer would send to enquire about this piece. It must name the product. No price, no delivery promise.',
  ].join('\n');
}

/** Render the admin's facts, and say explicitly which fields were left unsupplied. */
export function userPrompt(facts: AdminFacts, imageIds: readonly string[]): string {
  const lines: string[] = ['OPERATOR FACTS — the only facts you may assert:'];
  const supplied: string[] = [];
  const missing: string[] = [];

  /**
   * Render a primitive, or nothing.
   *
   * Deliberately not `String(value)`: the facts arrive through a Zod schema so nested objects
   * are not expected, and an unexpected one would render as `[object Object]` — a literal
   * string the model would then dutifully treat as a fact about the furniture.
   */
  const scalar = (value: unknown): string | null => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    return null;
  };

  const add = (label: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') {
      missing.push(label);
      return;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        missing.push(label);
        return;
      }
      supplied.push(`${label}: ${value.join(', ')}`);
      return;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value)
        .map(([key, entry]) => {
          const rendered = scalar(entry);
          return rendered === null ? null : `${key}=${rendered}`;
        })
        .filter((entry): entry is string => entry !== null);
      if (entries.length === 0) {
        missing.push(label);
        return;
      }
      supplied.push(`${label}: ${entries.join(', ')}`);
      return;
    }
    const rendered = scalar(value);
    if (rendered === null) missing.push(label);
    else supplied.push(`${label}: ${rendered}`);
  };

  add('Product name', facts.name);
  add('Category', facts.category);
  add('Material', facts.material);
  add('Colour', facts.color);
  add('Available colours', facts.availableColors);
  add('Dimensions', facts.dimensions);
  add('Size', facts.size);
  add('Stock status', facts.stockStatus);
  add('Made to order', facts.madeToOrder);
  add('Customisation', facts.customization);
  add('Delivery information', facts.deliveryInformation);

  lines.push(...(supplied.length === 0 ? ['(none supplied)'] : supplied));

  if (missing.length > 0) {
    lines.push(
      '',
      `NOT SUPPLIED — leave every one of these empty and do not guess: ${missing.join(', ')}.`,
    );
  }

  if (typeof facts.rawNotes === 'string' && facts.rawNotes.trim() !== '') {
    lines.push(
      '',
      'OPERATOR NOTES (treat as facts, but assert nothing beyond them):',
      facts.rawNotes.trim(),
    );
  }

  lines.push(
    '',
    imageIds.length === 0
      ? 'No photographs were supplied. Work from the notes alone, and do not describe visual detail you cannot know.'
      : `PHOTOGRAPH IDS, in the order the images appear: ${imageIds.join(', ')}. Return one alt-text entry per id.`,
  );

  return lines.join('\n');
}

/**
 * The structured-output schema.
 *
 * Flat strings and arrays rather than the `Suggested<T>` wrapper the internal type uses: the model
 * has no business asserting provenance, and asking it to would give it a field in which to claim
 * that an invented material came from the operator. Provenance is assigned by the guard, which
 * knows what the operator actually supplied.
 *
 * `additionalProperties: false` on every object, and `required` listing every key, because
 * OpenAI's strict mode demands both — and because a schema that admits extra keys is a schema
 * through which a model can return a `status`.
 */
export function suggestionJsonSchema(): object {
  const string = (maxLength: number): object => ({ type: 'string', maxLength });
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'name',
      'shortDescription',
      'description',
      'category',
      'subcategory',
      'styleTags',
      'features',
      'seoTitle',
      'seoDescription',
      'keywords',
      'imageAltText',
      'whatsappText',
    ],
    properties: {
      name: string(FIELD_LIMITS.name),
      shortDescription: string(FIELD_LIMITS.shortDescription),
      description: string(1200),
      category: { type: ['string', 'null'] },
      subcategory: { type: ['string', 'null'] },
      styleTags: {
        type: 'array',
        maxItems: LIST_LIMITS.styleTags,
        items: string(FIELD_LIMITS.styleTag),
      },
      features: {
        type: 'array',
        maxItems: LIST_LIMITS.features,
        items: string(FIELD_LIMITS.feature),
      },
      seoTitle: string(FIELD_LIMITS.seoTitle),
      seoDescription: string(FIELD_LIMITS.seoDescription),
      keywords: {
        type: 'array',
        maxItems: LIST_LIMITS.keywords,
        items: string(FIELD_LIMITS.keyword),
      },
      imageAltText: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['imageId', 'alt'],
          properties: { imageId: { type: 'string' }, alt: string(FIELD_LIMITS.alt) },
        },
      },
      whatsappText: string(FIELD_LIMITS.whatsappText),
    },
  };
}

/**
 * Parse the model's text as the suggestion object.
 *
 * Strict by design (Requirement 16.12): partial or unparseable JSON is a failure, never coerced.
 * The one accommodation is a fenced code block, which some models emit despite being told not to —
 * unwrapping a fence is not coercion, because the JSON inside it is either complete or it is not.
 * A truncated object inside a fence still fails, which is the case that matters.
 */
export function parseSuggestionJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  if (candidate === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  // An object with none of the expected keys is not a suggestion — it is more likely a refusal or
  // an error envelope the provider returned with a 200. Treating it as an empty suggestion would
  // present the operator with a blank form and call it a success.
  const record = parsed as Record<string, unknown>;
  const expected = ['name', 'shortDescription', 'description', 'seoTitle', 'whatsappText'];
  if (!expected.some((key) => key in record)) return null;

  return record;
}
