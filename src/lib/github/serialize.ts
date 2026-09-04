/**
 * Content serialization and field merging for the write pipeline.
 *
 * Two guarantees, both of which the design calls for and neither of which is free:
 *
 * **Unknown fields survive.** A write reads the raw JSON, applies the operator's field
 * patch on top, and re-serializes the result. It never round-trips through the Zod
 * schema output, because `.passthrough()` preserves unknown keys on *parse* but the
 * pipeline would still drop them if it wrote a freshly constructed object instead of the
 * merged one. So the base of every merge is the parsed *raw* file, not a validated
 * projection of it (Requirement 17.9).
 *
 * **Diffs are reviewable.** Keys are emitted in a deterministic order and the file ends
 * with a newline, so two writes of the same logical content produce byte-identical
 * output and `git diff` shows only what actually changed. Sorting is a one-time
 * reordering of the seeded files on their first admin write; after that every diff is
 * minimal, which is worth far more than preserving whatever order a file happened to be
 * authored in.
 *
 * Design: Write Pipeline → Conflict handling (merge semantics).
 * Requirements: 17.9, 17.10, 17.11.
 */

/** Plain JSON objects only — arrays and primitives are handled separately. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively order object keys.
 *
 * Arrays keep their order — in this data model array order is *meaningful*
 * (`images[].order`, `homepage` sections, `placeholders`), so sorting them would be a
 * data change disguised as formatting.
 */
function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (!isPlainObject(value)) return value;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    ordered[key] = withSortedKeys(value[key]);
  }
  return ordered;
}

/**
 * Render a content value as the exact bytes to commit: two-space indent, sorted keys,
 * one trailing newline.
 */
export function serializeContentJson(value: unknown): string {
  return `${JSON.stringify(withSortedKeys(value), null, 2)}\n`;
}

/**
 * Apply an operator's field patch over the stored record.
 *
 * The merge is **shallow at the top level**, deliberately. A deep merge cannot express
 * "clear this nested object" or "replace these dimensions with a different set" — the
 * caller would have no way to remove a nested key — and it makes array handling
 * ambiguous. The admin form patches whole top-level fields, so shallow is both
 * sufficient and unambiguous: `{ dimensions: { widthCm: 90 } }` replaces `dimensions`
 * entirely, which is what the form submits.
 *
 * `undefined` in the patch means "leave alone"; an explicit `null` means "set to null".
 * That distinction is what lets the form clear a nullable field (`originalPrice`,
 * `price`) without a separate delete verb.
 *
 * Keys the patch does not mention are copied through untouched — including keys no
 * schema knows about, which is the whole point.
 */
export function applyFieldPatch(
  stored: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base: Record<string, unknown> = isPlainObject(stored) ? { ...stored } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // `__proto__` cannot be an own property of a JSON-parsed object in the first place
    // (assignment mutates the prototype instead), so it is skipped explicitly rather
    // than silently corrupting the base object.
    if (key === '__proto__') continue;
    base[key] = value;
  }
  return base;
}

/** Parse stored file content, or null when it is not JSON at all. */
export function parseContentJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
