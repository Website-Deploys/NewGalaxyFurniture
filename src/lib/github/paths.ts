/**
 * The path allowlist — the single chokepoint for every repository write.
 *
 * The architectural claim this module makes is worth stating plainly, because it is
 * the reason the design is shaped the way it is: **the browser never sends a file
 * path.** It sends a product id and a validated payload, and the Worker derives the
 * path from the stored slug. Path traversal is therefore eliminated as a *class* of
 * bug rather than filtered for. This function exists as the second line — it is
 * applied to every path the pipeline computes, so a mistake in the derivation is
 * caught before it reaches GitHub, and it is exhaustively property-tested against
 * traversal, encoding, and Unicode-normalization attacks.
 *
 * `resolveContentPath` is **total**: for any string whatsoever it returns either an
 * allowlisted path or `null`. It never throws. A resolver that can throw is a
 * resolver whose caller has an error path, and an error path around a security check
 * is a place for the check to be skipped.
 *
 * Every rejection is ordered cheapest-first and each step is justified where it sits.
 *
 * Design: Write Pipeline → Principles, Path allowlist.
 * Requirements: 17.3, 17.4, 17.5, 17.6, 17.13, 25.5.
 */

/**
 * The only writable shapes. Anchored at both ends, and the slug and id syntaxes are
 * repeated from the schemas rather than imported as loose strings so that a widened
 * schema cannot silently widen the writable surface.
 *
 * Note what is absent: no `src/`, no `.github/`, no `wrangler.toml`, no
 * `package.json`, no `migrations/`, and no binary path. Those are not excluded by a
 * denylist — they are simply not on this list, which is the difference between
 * "we thought of it" and "it cannot be expressed".
 */
export const ALLOWED_PATTERNS: readonly RegExp[] = [
  /^data\/products\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/,
  /^data\/categories\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/,
  /^data\/reviews\/rev_[a-z0-9]{10}\.json$/,
  /^data\/site\/(settings|homepage|rankings|redirects)\.json$/,
  /*
   * The nightly analytics snapshot (task 18.5).
   *
   * One exact filename, not a directory shape: `data/snapshots/` holds precisely this file, and a
   * pattern like `[a-z-]+\.json` would have admitted every future name in that directory in advance.
   * The design's cron writes here and the design's rule is that every write goes through this
   * allowlist; adding the path is what makes both true at once, and it is the smallest addition that
   * does.
   */
  /^data\/snapshots\/analytics\.json$/,
];

/**
 * Percent-decode at most once, refusing anything that was encoded twice.
 *
 * Double-encoding is the attack this closes: `%252e%252e%252f` decodes once to
 * `%2e%2e%2f`, which a *second* decode anywhere downstream — a proxy, a filesystem
 * layer, a URL constructor — would turn into `../`. Refusing a result that still
 * contains a `%` means this function's output can never be re-decoded into something
 * different from what was validated.
 *
 * A malformed sequence (`%`, `%zz`, `%e0%80`) makes `decodeURIComponent` throw; that
 * becomes `null` here, which is how totality is preserved.
 */
function safeDecodeOnce(candidate: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return null;
  }
  // A `%` surviving the decode means either a double-encoded payload or a literal
  // `%` in a filename. Neither is representable in an allowlisted path, so both are
  // refused and the "decode once, validate once" invariant holds.
  if (decoded.includes('%')) return null;
  return decoded;
}

/**
 * Resolve a candidate path, or refuse it.
 *
 * @returns the allowlisted path, byte-identical to what will be sent to GitHub, or
 * `null`. Never throws, for any input.
 */
export function resolveContentPath(candidate: string): string | null {
  // Defensive, because the signature is a promise and callers upstream of a JSON
  // boundary cannot always keep it: a non-string is a refusal, not a TypeError.
  if (typeof candidate !== 'string' || candidate === '') return null;

  // 1. Unicode normalization, on the *raw* input.
  //
  // This is checked before anything else because normalization is not
  // order-independent: an NFD path like `data/products/cafe\u0301.json` looks
  // different from the NFC `café.json` yet may name the same file on a normalizing
  // filesystem, so validating one form and writing the other is a real bypass.
  // Requiring the input to already be NFC means the string that is validated is the
  // string that is written. (In practice no allowlisted path contains a
  // non-ASCII character at all — slugs are `[a-z0-9-]` — so this rejects the
  // *attempt*, early and unambiguously.)
  if (candidate !== candidate.normalize('NFC')) return null;

  // 2. NUL and backslash, on the raw input.
  //
  // A NUL byte truncates the path in any C-string consumer, so `data/products/x.json\0.png`
  // would validate as an image and write as JSON. A backslash is a separator on
  // Windows and inside some Git tooling. Neither is ever legitimate here.
  if (candidate.includes('\0') || candidate.includes('\\')) return null;

  // 3. Single safe decode, refusing double-encoding.
  const decoded = safeDecodeOnce(candidate);
  if (decoded === null) return null;

  // 3b. Re-check NUL and backslash after decoding.
  //
  // Not in the design's code block, and strictly a strengthening: `%00` and `%5c`
  // pass step 2 as literal text and only become dangerous once decoded. The anchored
  // allowlist below would reject them anyway — neither character is in `[a-z0-9-]` —
  // but a security check should refuse for the reason that applies, not by luck of a
  // downstream pattern. Nothing legitimate is excluded: an allowlisted path contains
  // neither character in any encoding.
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  // 4. Segment sanity. `..` is traversal; `.` is a no-op segment that changes the
  // string without changing the target; `''` comes from `//` or a leading/trailing
  // slash and collapses differently in different consumers.
  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }

  // 5. Absolute paths. Redundant after step 4 (a leading `/` yields an empty first
  // segment) and kept because it is the design's stated check and because the
  // redundancy is free: two independent reasons to refuse an absolute path is the
  // right number.
  if (decoded.startsWith('/')) return null;

  // 6. The allowlist itself. Everything above narrows the input; this is the only
  // step that admits anything.
  return ALLOWED_PATTERNS.some((pattern) => pattern.test(decoded)) ? decoded : null;
}

/** True when `candidate` resolves. Sugar for readability at call sites. */
export function isAllowedContentPath(candidate: string): boolean {
  return resolveContentPath(candidate) !== null;
}

/* -------------------------------------------------------------------------- */
/* Server-side path derivation                                                */
/* -------------------------------------------------------------------------- */

/**
 * The path for a product, derived from its **stored** slug.
 *
 * This — not `resolveContentPath` — is what the write pipeline calls. The distinction
 * is the whole of Requirement 17.3: the argument comes from the record the Worker
 * loaded, never from the request body, so there is no attacker-controlled path to
 * resolve in the first place. `resolveContentPath` then validates the result, which
 * catches a corrupt stored slug as well as a bug in this function.
 */
export function productContentPath(slug: string): string | null {
  return resolveContentPath(`data/products/${slug}.json`);
}

export function categoryContentPath(slug: string): string | null {
  return resolveContentPath(`data/categories/${slug}.json`);
}

export function reviewContentPath(id: string): string | null {
  return resolveContentPath(`data/reviews/${id}.json`);
}

export type SiteConfigFile = 'settings' | 'homepage' | 'rankings' | 'redirects';

export function siteContentPath(file: SiteConfigFile): string | null {
  return resolveContentPath(`data/site/${file}.json`);
}
