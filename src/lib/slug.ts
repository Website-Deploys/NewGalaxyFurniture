/**
 * Slug and SKU generation — the identifiers a product carries for its whole life.
 *
 * Three code paths create products (the admin form, the AI assistant, and
 * `npm run product:add`) and all three call these functions, so all three produce
 * byte-compatible files.
 *
 * **Slug stability is a URL contract.** `uniqueSlug` proposes a slug for a *new*
 * product; it never rewrites an existing one. A rename is an explicit, confirmed
 * operation that writes the new file, deletes the old, and records a 301 in
 * `data/site/redirects.json` — never a side effect of re-running a generator.
 *
 * Design: Data Models → Slug and SKU generation.
 * Requirements: 12.5, 12.11, 12.12, 13.13, 17.19, 27.4.
 */

/** Maximum slug length. The filename is the slug, and long URLs are hostile. */
export const SLUG_MAX_LENGTH = 80;

/** What an empty slug degrades to, so a product always has a URL. */
export const SLUG_FALLBACK = 'item';

/**
 * Combining marks left behind by NFKD decomposition — the Unicode `Mark` general
 * category, which covers every diacritic NFKD splits off, not just Latin ones.
 */
const COMBINING_MARKS = /\p{M}/gu;

/**
 * Deterministic, idempotent, URL-safe slug.
 *
 * The algorithm is the design's, step for step:
 * NFKD normalize → strip diacritics → lowercase → replace every run of
 * non-`[a-z0-9]` with `-` → collapse repeats → trim leading/trailing `-` →
 * truncate to 80 chars at a `-` boundary → fall back to `item` when empty.
 */
export function toSlug(name: string): string {
  const stripped = name
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    // NFKD does not decompose every character (ß, ø, đ, ł …), and any character
    // still outside the target charset — CJK, emoji, punctuation, whitespace —
    // becomes a single separator here.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  const truncated = truncateAtBoundary(stripped, SLUG_MAX_LENGTH);
  return truncated.length === 0 ? SLUG_FALLBACK : truncated;
}

/**
 * Cut to at most `limit` characters, preferring the last `-` boundary inside the
 * limit so a word is not sliced in half. A single word longer than the limit has
 * no boundary to prefer, so it is cut hard — the bound is not negotiable.
 */
function truncateAtBoundary(slug: string, limit: number): string {
  if (slug.length <= limit) return slug;
  const head = slug.slice(0, limit);
  const boundary = head.lastIndexOf('-');
  const cut = boundary > 0 ? head.slice(0, boundary) : head;
  return cut.replace(/-+$/g, '');
}

/**
 * A slug not colliding with `taken`, suffixing `-2`, `-3`, … .
 *
 * The returned slug always starts with `toSlug(name)`: the suffix is appended, the
 * base is never rewritten, so a duplicate is recognisable as a duplicate of its
 * source. That prefix guarantee is why a suffixed slug may exceed
 * `SLUG_MAX_LENGTH` in the pathological case of a ~80-character base that also
 * collides; truncating the base to make room would break the prefix contract that
 * Property 4 pins down, and in practice names that long are already truncated at a
 * word boundary well short of 80.
 */
export function uniqueSlug(name: string, taken: ReadonlySet<string>): string {
  const base = toSlug(name);
  if (!taken.has(base)) return base;

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Category slug → SKU segment. Extended when a category is added.
 *
 * A `Map`, not an object literal, and deliberately so: a category slug is
 * caller-supplied data, and `{}['constructor']` resolves up the prototype chain to
 * a function rather than to `undefined`. The property test for well-formed SKUs
 * found exactly that — a category named `constructor` produced a malformed SKU.
 */
export const SKU_PREFIXES: ReadonlyMap<string, string> = new Map([
  ['sofas', 'SOF'],
  ['beds', 'BED'],
  ['dining-tables', 'DTB'],
  ['dining-chairs', 'DCH'],
  ['accent-chairs', 'ACH'],
  ['coffee-side-tables', 'CST'],
  ['storage-display', 'STD'],
  ['office', 'OFF'],
  ['outdoor', 'OUT'],
]);

/** `NGF` — every SKU this business mints starts here. */
const SKU_NAMESPACE = 'NGF';
const SKU_BODY_LENGTH = 6;
const BASE36 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * The prefix for a category that has no declared mapping: the first three
 * alphanumerics of its slug, uppercased and padded, so a new category still yields
 * a well-formed SKU instead of throwing during product creation.
 */
export function skuPrefixFor(categorySlug: string): string {
  const declared = SKU_PREFIXES.get(categorySlug);
  if (declared !== undefined) return declared;

  const letters = categorySlug.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return letters.length >= 3 ? letters.slice(0, 3) : `${letters}XXX`.slice(0, 3);
}

/**
 * `length` random base-36 characters, from WebCrypto only.
 *
 * There is deliberately no `Math.random` fallback. A SKU is not a secret, but it is a *unique
 * identifier* minted once and printed on an invoice, and `Math.random` is seeded per realm and
 * biased in ways that make collisions likelier than the collision check assumes. Every runtime
 * this code targets — Cloudflare Workers, Node 22, and every supported browser — exposes
 * `crypto.getRandomValues`, so a missing one is a broken environment, not a case to degrade
 * into: failing loudly here is safer than silently minting weaker identifiers.
 */
function randomBase36(length: number): string {
  const bytes = new Uint8Array(length);
  const webcrypto = globalThis.crypto;
  if (typeof webcrypto?.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues is unavailable — cannot generate a SKU.');
  }
  webcrypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += BASE36[(bytes[i] ?? 0) % BASE36.length];
  }
  return out;
}

/**
 * Category-prefixed SKU, e.g. `NGF-SOF-4F2K9C`, matching
 * `/^[A-Z0-9][A-Z0-9-]{2,31}$/` and absent from `taken`.
 *
 * Collisions are retried with a fresh body; after enough retries the body grows,
 * so the function terminates even against an adversarially large `taken` set.
 */
export function generateSku(categorySlug: string, taken: ReadonlySet<string>): string {
  const prefix = skuPrefixFor(categorySlug);
  let bodyLength = SKU_BODY_LENGTH;

  for (let attempt = 0; ; attempt += 1) {
    const candidate = `${SKU_NAMESPACE}-${prefix}-${randomBase36(bodyLength)}`;
    if (!taken.has(candidate)) return candidate;
    // 36^6 ≈ 2.2 billion bodies; 32 misses means `taken` is pathological, not unlucky.
    if (
      attempt > 0 &&
      attempt % 32 === 0 &&
      `${SKU_NAMESPACE}-${prefix}-`.length + bodyLength < 32
    ) {
      bodyLength += 1;
    }
  }
}

/** `/^[A-Z0-9][A-Z0-9-]{2,31}$/` — the shape every SKU in the catalogue satisfies. */
export const SKU_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

/** `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` — the shape every slug satisfies. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
