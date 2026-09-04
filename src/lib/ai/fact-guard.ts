/**
 * The deterministic post-generation filter.
 *
 * This module is where the honesty of the AI assistant actually lives. Everything upstream of it
 * — the system prompt, the JSON schema, the provider's own guardrails — is a request to a
 * probabilistic system. `applyFactGuard` is a pure function that runs on every generation, and it
 * cannot be persuaded, jailbroken, or prompt-injected, because it never reads the model's output
 * as an instruction. It reads it as data and rewrites it.
 *
 * The five rules, and the reasoning behind each:
 *
 * 1. **No factual invention** (Requirements 16.5, 16.7). For each field in `FACTUAL_FIELDS`: if
 *    the admin did not supply it, the suggestion is discarded and the field left blank, with a
 *    warning naming it. A plausible material is worse than a blank one — the operator will scan
 *    a filled field and accept it, and "Sheesham" invented from a photograph of a brown sofa is
 *    a lie the business then has to honour.
 * 2. **Admin facts win** (Requirements 16.4, 16.6). If the admin *did* supply the field, the
 *    stored value is the admin's, byte for byte. A differing generated value is not merged,
 *    averaged or preferred — it is replaced, and the replacement is reported.
 * 3. **Closed vocabularies** (Requirement 16.9). `category` must be an existing category slug or
 *    it becomes `null` with a warning; a product filed under an invented category would fail
 *    `validate:content` at the next build. `styleTags` and `keywords` are filtered against an
 *    allowed vocabulary plus whatever tags the admin added themselves.
 * 4. **Length and safety bounds** (Requirements 16.10, 16.11). Every string is stripped of HTML
 *    and markdown control characters and truncated to its schema maximum. The bounds are read
 *    from `FIELD_LIMITS`, which mirrors `src/schemas/product.ts` — a value that reached storage
 *    over-length would fail the write, so clamping here is what makes the suggestion usable.
 * 5. **Status is untouchable.** There is no `status` or `published` field on
 *    `ProductDraftSuggestion`, and `applyFactGuard` returns that type. Publication is therefore
 *    unreachable from this code path by construction rather than by a check that could be
 *    forgotten — the strongest available form of Requirement 16.11. The guard additionally
 *    *deletes* any `status`/`published` key a model smuggled into its JSON, so the object handed
 *    to the client cannot even carry the suggestion of one.
 *
 * Every rule reports. The operator sees a list of what was blanked, what was overridden and what
 * was scrubbed, because a silent correction teaches nothing and an operator who cannot see the
 * guard working has no reason to trust it.
 *
 * Design: AI Product Assistant → Fact / suggestion separation, Hallucination guardrails.
 * Requirements: 14.11, 15.15, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9, 16.10, 16.11, 18.5.
 */

import { priceMentions, scrubBannedClaims } from './banned-claims';
import type { DimensionsValue, StockStatusValue } from '@/schemas/product';

/* -------------------------------------------------------------------------- */
/* The contract                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The fields the machine may never assert (Requirement 16.7).
 *
 * `as const` and exported, because the property tests iterate it: adding a factual field to the
 * product schema and forgetting to add it here would leave that field unguarded, and Property 47
 * reads this list rather than a copy of it.
 */
export const FACTUAL_FIELDS = [
  'price',
  'originalPrice',
  'dimensions',
  'size',
  'material',
  'color',
  'availableColors',
  'stockStatus',
  'madeToOrder',
  'deliveryInformation',
  'customization',
] as const;

export type FactualField = (typeof FACTUAL_FIELDS)[number];

/** Everything the admin actually asserted. The ONLY source of factual claims. */
export interface AdminFacts {
  rawNotes?: string;
  name?: string;
  category?: string;
  price?: number | null;
  originalPrice?: number | null;
  priceOnEnquiry?: boolean;
  material?: string;
  color?: string;
  availableColors?: string[];
  dimensions?: DimensionsValue;
  size?: string;
  stockStatus?: StockStatusValue;
  madeToOrder?: boolean;
  customization?: string;
  deliveryInformation?: string;
  /** Tags the operator added. Admitted into the vocabulary alongside the allowed list. */
  adminTags?: string[];
}

export type Provenance = 'admin' | 'ai' | 'ai-derived-from-admin';

export interface Suggested<T> {
  value: T;
  source: Provenance;
  /** One short line, shown on hover in the UI. */
  rationale?: string;
}

/**
 * The suggestion object.
 *
 * Note what is absent and cannot be added without changing this type: `status`, `published`,
 * `price`, `sku`, `slug`, `id`. The factual fields the guard *does* carry are the ones the form
 * needs to echo back what the admin supplied; they are never a channel for a generated value,
 * because rule 1 blanks them and rule 2 overwrites them.
 */
export interface ProductDraftSuggestion {
  name: Suggested<string>;
  shortDescription: Suggested<string>;
  description: Suggested<string>;
  /** An existing category slug, or null. */
  category: Suggested<string | null>;
  subcategory: Suggested<string | null>;
  material: Suggested<string | null>;
  color: Suggested<string | null>;
  styleTags: Suggested<string[]>;
  features: Suggested<string[]>;
  seoTitle: Suggested<string>;
  seoDescription: Suggested<string>;
  keywords: Suggested<string[]>;
  imageAltText: Suggested<{ imageId: string; alt: string }[]>;
  whatsappText: Suggested<string>;
  warnings: string[];
}

export interface FactGuardOptions {
  /** Existing category slugs. A suggestion outside this set becomes null. */
  categorySlugs?: readonly string[];
  /** Extra vocabulary the operator has established, beyond `ALLOWED_STYLE_TAGS`. */
  extraVocabulary?: readonly string[];
  /** Image ids the request actually referenced. Alt text for anything else is dropped. */
  imageIds?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Bounds and vocabulary                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Schema maxima, mirrored from `src/schemas/product.ts`.
 *
 * Duplicated deliberately rather than derived: reaching into a Zod schema for `maxLength` couples
 * this filter to Zod internals, and the numbers here are asserted against the schema by the unit
 * suite, which is a cheaper and more legible coupling.
 */
export const FIELD_LIMITS = {
  name: 120,
  shortDescription: 240,
  description: 6000,
  category: 80,
  subcategory: 80,
  material: 120,
  color: 60,
  styleTag: 40,
  feature: 160,
  seoTitle: 70,
  seoDescription: 170,
  keyword: 40,
  alt: 180,
  whatsappText: 900,
} as const;

/** Item-count caps, likewise mirrored from the schema. */
export const LIST_LIMITS = {
  styleTags: 24,
  features: 12,
  keywords: 20,
} as const;

/**
 * The allowed style-tag and keyword vocabulary.
 *
 * A closed list is what makes tags useful as filters: an open one accumulates near-duplicates
 * ("mid century", "mid-century", "midcentury") that split a facet into three and make each look
 * empty. The operator can extend it per product through `AdminFacts.adminTags`, which is an
 * explicit act rather than a drift.
 */
export const ALLOWED_STYLE_TAGS: readonly string[] = [
  'modern',
  'contemporary',
  'minimal',
  'scandinavian',
  'mid-century',
  'industrial',
  'rustic',
  'traditional',
  'classic',
  'colonial',
  'transitional',
  'bohemian',
  'coastal',
  'art-deco',
  'farmhouse',
  'luxury',
  'compact',
  'space-saving',
  'modular',
  'sectional',
  'upholstered',
  'wooden',
  'metal',
  'glass',
  'cane',
  'rattan',
  'leatherette',
  'fabric',
  'teak-finish',
  'walnut-finish',
  'oak-finish',
  'matte',
  'glossy',
  'tufted',
  'recliner',
  'convertible',
  'storage',
  'outdoor',
  'indoor',
  'living-room',
  'bedroom',
  'dining',
  'office',
  'kids',
  'handcrafted',
  'made-to-order',
  'customisable',
];

/* -------------------------------------------------------------------------- */
/* Sanitisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Strip markup and control characters (Requirement 16.10).
 *
 * The order matters. Entities are decoded *before* tags are removed, because
 * `&lt;script&gt;alert(1)&lt;/script&gt;` is inert text until something decodes it — and
 * something downstream always does. Decoding first means the tag stripper sees the tag and
 * removes it, rather than passing through an encoded payload that a template later un-encodes.
 * Angle brackets that remain after stripping are dropped outright, so no partial tag survives.
 */
export function sanitizeText(raw: unknown): string {
  if (typeof raw !== 'string') return '';

  let text = raw
    // The named and numeric entities a model plausibly emits.
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*(\d{1,7});/g, (_match, code: string) => {
      const point = Number.parseInt(code, 10);
      return point > 0 && point < 0x110000 ? String.fromCodePoint(point) : '';
    })
    .replace(/&#x0*([0-9a-f]{1,6});/gi, (_match, code: string) => {
      const point = Number.parseInt(code, 16);
      return point > 0 && point < 0x110000 ? String.fromCodePoint(point) : '';
    });

  text = text
    // HTML comments, then elements, then any stray bracket.
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/[<>]/g, '')
    // Markdown control characters. The text is stored as plain text and rendered as plain
    // text, so a stray `**` or `#` is noise the operator would have to delete by hand.
    .replace(/[*_`~#|]/g, '')
    .replace(/^\s*>+\s?/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // C0/C1 control characters except newline and tab, plus zero-width and bidi
    // overrides — the latter can make stored text render differently from what it says.
    //
    // `no-control-regex` exists to catch a control character that arrived in a pattern by
    // accident. Here they are the subject: this is the "remove control characters" clause of
    // Requirement 16.10, and the class cannot be written without naming them. Building it from
    // `String.fromCharCode` at runtime would satisfy the linter while making the one
    // security-relevant character range in this file unreadable.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');

  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Sanitise, then truncate on a word boundary where one is close enough to the cut. */
export function clamp(raw: unknown, limit: number): string {
  const text = sanitizeText(raw);
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  // Only break on a word if that costs less than a fifth of the budget; otherwise a long
  // unbroken token would shrink the field drastically.
  return (lastSpace > limit * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** A vocabulary token: lower case, hyphenated, `[a-z0-9-]` only. */
export function normalizeTag(raw: unknown): string {
  return sanitizeText(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, FIELD_LIMITS.styleTag);
}

/* -------------------------------------------------------------------------- */
/* Reading an untrusted suggestion                                            */
/* -------------------------------------------------------------------------- */

/**
 * A parsed-but-unverified suggestion.
 *
 * `unknown`-typed on purpose: this is a JSON object a language model produced, so every field
 * may be missing, the wrong type, or hostile. The guard's job is to turn it into a
 * `ProductDraftSuggestion`, and it is easier to be exhaustive about that when the input type
 * forces every field to be handled.
 */
export type RawSuggestion = Record<string, unknown>;

function readString(raw: RawSuggestion, key: string): string {
  const value = raw[key];
  if (typeof value === 'string') return value;
  // A `Suggested<T>`-shaped value: some providers echo the schema back wrapped.
  if (typeof value === 'object' && value !== null && 'value' in value) {
    const inner: unknown = value.value;
    if (typeof inner === 'string') return inner;
  }
  return '';
}

function readStringList(raw: RawSuggestion, key: string): string[] {
  const value = raw[key];
  const source: unknown = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && 'value' in value
      ? value.value
      : null;
  if (!Array.isArray(source)) return [];
  return source.filter((entry): entry is string => typeof entry === 'string');
}

function readAltList(raw: RawSuggestion): { imageId: string; alt: string }[] {
  const value = raw.imageAltText;
  const source: unknown = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && 'value' in value
      ? value.value
      : null;
  if (!Array.isArray(source)) return [];
  const entries: { imageId: string; alt: string }[] = [];
  for (const candidate of source) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.imageId !== 'string') continue;
    entries.push({
      imageId: record.imageId,
      alt: typeof record.alt === 'string' ? record.alt : '',
    });
  }
  return entries;
}

/* -------------------------------------------------------------------------- */
/* Rule 1 and 2: the factual fields                                           */
/* -------------------------------------------------------------------------- */

/** Is this factual field present in the admin's facts? */
export function factSupplied(facts: AdminFacts, field: FactualField): boolean {
  const value = (facts as Record<string, unknown>)[field];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some((entry) => entry !== undefined);
  // A supplied `false` for `madeToOrder` is a fact, not an absence: the operator said "no".
  return true;
}

/** How a factual field is named to the operator in a warning. */
const FACTUAL_LABEL: Record<FactualField, string> = {
  price: 'Price',
  originalPrice: 'Original price',
  dimensions: 'Dimensions',
  size: 'Size',
  material: 'Material',
  color: 'Colour',
  availableColors: 'Available colours',
  stockStatus: 'Stock status',
  madeToOrder: 'Made to order',
  deliveryInformation: 'Delivery information',
  customization: 'Customisation',
};

/**
 * Prices the generated prose is permitted to mention: the ones the admin supplied.
 *
 * Also drawn from `rawNotes`, because an operator who typed "beige 3-seater, ₹42,000" in the
 * notes box *did* supply that price even though they did not fill the price field — refusing to
 * let the description mention it would be pedantry, and the operator can still see it in the
 * warning list if the guard removes something else.
 */
function allowedPrices(facts: AdminFacts): number[] {
  const prices: number[] = [];
  if (typeof facts.price === 'number' && facts.price > 0) prices.push(facts.price);
  if (typeof facts.originalPrice === 'number' && facts.originalPrice > 0) {
    prices.push(facts.originalPrice);
  }
  if (typeof facts.rawNotes === 'string') prices.push(...priceMentions(facts.rawNotes));
  return prices;
}

/* -------------------------------------------------------------------------- */
/* The guard                                                                  */
/* -------------------------------------------------------------------------- */

export interface FactGuardResult {
  guarded: ProductDraftSuggestion;
  warnings: string[];
}

/**
 * Blank any factual field the admin did not supply, replace any that disagrees with the admin's
 * value, close the vocabularies, scrub banned claims, and bound every string.
 *
 * Pure and total: any `raw` whatsoever, including `{}`, produces a valid `ProductDraftSuggestion`.
 * That totality is what lets the endpoint treat the guard as unconditional — there is no input
 * for which it throws and therefore no path around it.
 */
export function applyFactGuard(
  raw: RawSuggestion,
  facts: AdminFacts,
  options: FactGuardOptions = {},
): FactGuardResult {
  const warnings: string[] = [];
  const prices = allowedPrices(facts);

  /**
   * Sanitise, scrub, then clamp — in that order, and the order is load-bearing.
   *
   * Sanitising first means a claim hidden inside markup (`**ISO 9001 certified**`) is visible to
   * the scrubber. Scrubbing before clamping is the part the property suite forced: clamping first
   * truncates mid-sentence, which both hid claims from the reporter — the operator was told
   * nothing had been removed when the truncation had removed it — and could leave a dangling
   * fragment (`Backed by a 10-year warr`) that no pattern matches but that still reads as the
   * claim. Scrubbing whole sentences from the complete text and truncating the result afterwards
   * has neither failure.
   */
  const freeText = (key: string, limit: number, label: string): Suggested<string> => {
    const scrubbed = scrubBannedClaims(sanitizeText(readString(raw, key)), prices);
    for (const removal of scrubbed.removals) warnings.push(`${label}: ${removal}`);
    return {
      value: clamp(scrubbed.text, limit),
      source: 'ai',
      ...(scrubbed.removals.length === 0
        ? {}
        : { rationale: 'Some generated text was removed — see the warnings.' }),
    };
  };

  // --- Rules 1 and 2, over the factual fields the suggestion carries ---------
  //
  // Only `material` and `color` appear on `ProductDraftSuggestion`; the remaining nine factual
  // fields have no slot on it at all, which is a stronger guarantee than blanking them. They are
  // still walked below so that the *warning* is produced for every one of them — the operator is
  // told each factual field they left unsupplied, which is what Requirement 16.5 asks for.
  const factual = (field: 'material' | 'color', limit: number): Suggested<string | null> => {
    const supplied = factSupplied(facts, field);
    const admin = facts[field];
    if (supplied && typeof admin === 'string') {
      const suggested = sanitizeText(readString(raw, field));
      const adminValue = clamp(admin, limit);
      if (suggested !== '' && suggested !== adminValue) {
        warnings.push(
          `${FACTUAL_LABEL[field]}: the suggestion said “${suggested}” — replaced with your value “${adminValue}”.`,
        );
      }
      return {
        value: adminValue,
        source: 'admin',
        rationale: 'Your value. The suggestion cannot change a fact you supplied.',
      };
    }
    if (readString(raw, field).trim() !== '') {
      warnings.push(
        `${FACTUAL_LABEL[field]}: you did not supply this, so the suggested value was discarded and the field left blank.`,
      );
    } else {
      warnings.push(`${FACTUAL_LABEL[field]}: not supplied — left blank.`);
    }
    return { value: null, source: 'admin' };
  };

  for (const field of FACTUAL_FIELDS) {
    if (field === 'material' || field === 'color') continue; // handled above, with their values
    if (factSupplied(facts, field)) continue;
    warnings.push(
      `${FACTUAL_LABEL[field]}: not supplied — left blank. Nothing was generated for it.`,
    );
  }

  // --- Rule 3: closed vocabularies ------------------------------------------
  const knownCategories = new Set(options.categorySlugs ?? []);
  const suggestedCategory = normalizeTag(readString(raw, 'category'));
  let category: Suggested<string | null>;
  if (typeof facts.category === 'string' && facts.category.trim() !== '') {
    const adminCategory = normalizeTag(facts.category);
    if (knownCategories.size > 0 && !knownCategories.has(adminCategory)) {
      warnings.push(
        `Category: “${facts.category}” is not an existing category, so no category was assigned.`,
      );
      category = { value: null, source: 'admin' };
    } else {
      category = { value: adminCategory, source: 'admin', rationale: 'Your choice.' };
    }
  } else if (suggestedCategory !== '' && knownCategories.has(suggestedCategory)) {
    category = {
      value: suggestedCategory,
      source: 'ai',
      rationale: 'Matched to an existing category.',
    };
  } else {
    if (suggestedCategory !== '') {
      warnings.push(
        `Category: the suggested category “${suggestedCategory}” does not exist, so no category was assigned. Choose one yourself.`,
      );
    } else {
      warnings.push('Category: none was assigned. Choose one yourself.');
    }
    category = { value: null, source: 'ai' };
  }

  const vocabulary = new Set<string>([
    ...ALLOWED_STYLE_TAGS,
    ...(options.extraVocabulary ?? []).map((entry) => normalizeTag(entry)),
    ...(facts.adminTags ?? []).map((entry) => normalizeTag(entry)),
  ]);
  vocabulary.delete('');

  const filterVocabulary = (
    key: 'styleTags' | 'keywords',
    cap: number,
    label: string,
  ): Suggested<string[]> => {
    const seen = new Set<string>();
    const kept: string[] = [];
    const rejected: string[] = [];
    for (const candidate of readStringList(raw, key)) {
      const tag = normalizeTag(candidate);
      if (tag === '' || seen.has(tag)) continue;
      seen.add(tag);
      if (vocabulary.has(tag)) {
        if (kept.length < cap) kept.push(tag);
      } else {
        rejected.push(tag);
      }
    }
    if (rejected.length > 0) {
      warnings.push(
        `${label}: dropped ${String(rejected.length)} outside the allowed vocabulary (${rejected
          .slice(0, 8)
          .join(', ')}${rejected.length > 8 ? ', …' : ''}). Add any you want as your own tags.`,
      );
    }
    return { value: kept, source: 'ai' };
  };

  // --- Rule 4: bounds, over everything else ---------------------------------
  const knownImages = options.imageIds === undefined ? null : new Set(options.imageIds);
  const altEntries: { imageId: string; alt: string }[] = [];
  let unknownAlts = 0;
  for (const entry of readAltList(raw)) {
    if (knownImages !== null && !knownImages.has(entry.imageId)) {
      unknownAlts += 1;
      continue;
    }
    const alt = clamp(entry.alt, FIELD_LIMITS.alt);
    if (alt !== '') altEntries.push({ imageId: entry.imageId, alt });
  }
  if (unknownAlts > 0) {
    warnings.push(
      `Image alt text: dropped ${String(unknownAlts)} entr${unknownAlts === 1 ? 'y' : 'ies'} for images that were not part of this request.`,
    );
  }

  // Same order as `freeText`: sanitise, scrub, then clamp. A feature bullet is one sentence, so a
  // scrub usually empties it entirely — which is the right outcome. "Backed by a 10-year warranty"
  // has nothing salvageable in it.
  const scrubbedFeatures: string[] = [];
  for (const feature of readStringList(raw, 'features')) {
    if (scrubbedFeatures.length >= LIST_LIMITS.features) break;
    const scrubbed = scrubBannedClaims(sanitizeText(feature), prices);
    for (const removal of scrubbed.removals) warnings.push(`Features: ${removal}`);
    const bounded = clamp(scrubbed.text, FIELD_LIMITS.feature);
    if (bounded !== '') scrubbedFeatures.push(bounded);
  }

  const guarded: ProductDraftSuggestion = {
    name: { value: clamp(readString(raw, 'name'), FIELD_LIMITS.name), source: 'ai' },
    shortDescription: freeText(
      'shortDescription',
      FIELD_LIMITS.shortDescription,
      'Short description',
    ),
    description: freeText('description', FIELD_LIMITS.description, 'Description'),
    category,
    subcategory: {
      value: (() => {
        const value = clamp(readString(raw, 'subcategory'), FIELD_LIMITS.subcategory);
        return value === '' ? null : value;
      })(),
      source: 'ai',
    },
    material: factual('material', FIELD_LIMITS.material),
    color: factual('color', FIELD_LIMITS.color),
    styleTags: filterVocabulary('styleTags', LIST_LIMITS.styleTags, 'Style tags'),
    features: { value: scrubbedFeatures, source: 'ai' },
    seoTitle: { value: clamp(readString(raw, 'seoTitle'), FIELD_LIMITS.seoTitle), source: 'ai' },
    seoDescription: freeText('seoDescription', FIELD_LIMITS.seoDescription, 'SEO description'),
    keywords: filterVocabulary('keywords', LIST_LIMITS.keywords, 'Keywords'),
    imageAltText: { value: altEntries, source: 'ai' },
    whatsappText: freeText('whatsappText', FIELD_LIMITS.whatsappText, 'WhatsApp text'),
    warnings: [],
  };

  // If the admin supplied a name, it is theirs — the same rule as the factual fields, applied to
  // the one non-factual field an operator most often has a settled answer for.
  if (typeof facts.name === 'string' && facts.name.trim() !== '') {
    guarded.name = {
      value: clamp(facts.name, FIELD_LIMITS.name),
      source: 'admin',
      rationale: 'Your value.',
    };
  }

  // --- Rule 5: status can never be produced ---------------------------------
  //
  // `guarded` is built key by key above, so a `status` key cannot arrive by spread. This
  // deletion covers the remaining route — a future refactor that spreads `raw` — and makes the
  // intent explicit at the point it matters. Property 50 asserts the outcome.
  const escaped = guarded as unknown as Record<string, unknown>;
  for (const forbidden of ['status', 'published', 'aiAssisted', 'id', 'sku', 'slug', 'price']) {
    if (forbidden in escaped) {
      delete escaped[forbidden];
      warnings.push(
        `The suggestion tried to set “${forbidden}”, which it is never allowed to. It was removed.`,
      );
    }
  }

  guarded.warnings = warnings;
  return { guarded, warnings };
}

/**
 * The field paths whose value came from the assistant — `product.aiFields` in the committed JSON.
 *
 * Derived from the guarded suggestion rather than tracked by the UI, so provenance in the stored
 * record reflects what the guard actually produced. A field the guard replaced with the admin's
 * value is `source: 'admin'` and is therefore correctly absent.
 */
export function aiFieldPaths(suggestion: ProductDraftSuggestion): string[] {
  const paths: string[] = [];
  for (const [key, entry] of Object.entries(suggestion)) {
    if (key === 'warnings') continue;
    if (typeof entry !== 'object' || entry === null || !('source' in entry)) continue;
    const suggested = entry as Suggested<unknown>;
    if (suggested.source !== 'ai' && suggested.source !== 'ai-derived-from-admin') continue;
    // An empty suggestion is not a contribution: recording it would claim the AI wrote a blank.
    const value = suggested.value;
    const empty = value === null || value === '' || (Array.isArray(value) && value.length === 0);
    if (!empty) paths.push(key);
  }
  return paths.sort();
}
