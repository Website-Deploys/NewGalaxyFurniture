/**
 * Output sanitization for text that came from a person.
 *
 * **Astro and React already escape interpolated text.** So the first question this module has to
 * answer is why it exists at all, and the answer is that "already escaped" is a property of the
 * *current* rendering path, not of the data. Three concrete ways the escaping stops applying:
 *
 * - a template that later needs `set:html` or `dangerouslySetInnerHTML` for formatting — the moment
 *   someone reaches for it, the value crossing it should already be safe;
 * - a value that leaves the template and becomes something other than text: a `href`, a `title`, a
 *   `content=` on a meta tag, a WhatsApp message, a JSON payload for an island;
 * - a value that is rendered by a surface that is not Astro or React at all, which the admin's
 *   client-side rendering and the CSV-ish exports already are in places.
 *
 * So this is defence in depth with a specific job: make the *value* safe, so no consumer of it has
 * to be careful. `safeText` is idempotent and is the identity on ordinary prose — a product
 * description, a review, a customer's name — which is what makes it safe to apply at every render
 * point without changing what visitors read.
 *
 * **What it does not do.** It does not sanitize HTML *into* HTML — there is no allowlist of
 * permitted tags, because no surface on this site renders operator-authored markup. Markup in a
 * product description is not formatting to be preserved, it is either a mistake or an attack, and
 * removing it is correct in both cases. That is a much smaller and much more auditable problem than
 * an HTML sanitizer, and it is the problem this project actually has.
 *
 * Design: Error Handling → Disclosure policy; Correctness Properties → Property 55.
 * Requirements: 16.10, 25.2, 25.3.
 */

/** The five characters that can change the meaning of markup. */
const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML entity encoding. For a value that will be written into markup as-is. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ENTITIES[character] ?? character);
}

/**
 * Control characters, which are never content.
 *
 * Tab, newline and carriage return are kept: a product description has paragraphs, and collapsing
 * them here would silently reformat every multi-paragraph field on the site. Everything else in the
 * C0 and C1 ranges is removed, along with the zero-width and bidirectional-override characters —
 * the last of those because `U+202E` can visually reverse a rendered string, which is how a
 * "harmless.txt" filename displays as something else.
 */
/*
 * Built with `RegExp` from an escaped source string rather than written as a literal: a literal
 * carrying these ranges trips `no-control-regex`, and the right answer to that rule is not to
 * disable it — the rule is correct that a control character inside a regex literal is usually a
 * mistake. This is the exception it cannot see, so it is expressed as data instead.
 */
const CONTROL_CHARACTERS = new RegExp(
  [
    '[',
    '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F', // C0, minus tab / newline / carriage return
    '\\u007F-\\u009F', // DEL and C1
    '\\u200B-\\u200F', // zero-width and directional marks
    '\\u202A-\\u202E\\u2066-\\u2069', // bidirectional overrides and isolates
    '\\uFEFF', // byte-order mark
    ']',
  ].join(''),
  'g',
);

/** Whitespace and control characters — the run a browser ignores when reading a URL's scheme. */
const URL_IGNORABLE = '[\\s\\u0000-\\u0020]*';

function stripControlCharacters(value: string): string {
  return value.replace(CONTROL_CHARACTERS, '');
}

/**
 * Remove markup, leaving the text.
 *
 * Three passes, in this order, because each one closes a hole the next would otherwise walk into:
 *
 * 1. `<script>`/`<style>` elements are removed **with their contents** — dropping only the tags
 *    would promote the script body to visible text, which is not a security problem but is a
 *    nonsense rendering.
 * 2. Comments are removed, including the unterminated `<!--` case, which browsers treat as a
 *    comment running to the end of the document.
 * 3. Anything else that looks like a tag becomes nothing. The pattern deliberately also matches an
 *    *unclosed* trailing `<tag` at the end of the string: a truncated payload like `<img src=x
 *    onerror=` is still dangerous once something appends to it.
 */
export function stripMarkup(value: string): string {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style)\b[\s\S]*$/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--[\s\S]*$/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/<\/?[a-z][^>]*$/gi, '');
}

/**
 * Defang the scheme prefixes that make a *string* dangerous once it becomes an attribute.
 *
 * The colon is removed and the word kept, so a reader still sees what was written. This is not
 * theatre: a sanitized value on this site does not always end up as a text node. A product name goes
 * into `data-ngf-product-name`, which an island reads back; the same string reaches an `aria-label`
 * and a WhatsApp message. `javascript:alert(1)` as visible prose is harmless, and one assignment
 * from a `data-` attribute to an `href` away from not being — and the design states Property 55 in
 * exactly these terms: the output contains no `<script`, no `onerror=`, and no `javascript:`.
 *
 * A separated form (`java script:`) is matched too, because a browser strips tab, newline and
 * carriage return from inside a URL before deciding its scheme.
 */
const SCRIPT_SCHEME = new RegExp(`\\b(java|vb)(${URL_IGNORABLE})script(${URL_IGNORABLE}):`, 'gi');
const HTML_DATA_SCHEME = new RegExp(`\\bdata(${URL_IGNORABLE}):(${URL_IGNORABLE})text/html`, 'gi');

function defangSchemes(value: string): string {
  return value.replace(SCRIPT_SCHEME, '$1$2script$3').replace(HTML_DATA_SCHEME, '$1$2 text/html');
}

/**
 * The function every template calls on a person-supplied string.
 *
 * Idempotent — `safeText(safeText(x)) === safeText(x)` — because it is applied at render time and a
 * value may pass through more than one surface. It does not entity-encode: the consumer is a
 * template that escapes on interpolation, and encoding here as well would render `&amp;` where the
 * author wrote `&`.
 */
export function safeText(value: string): string {
  return defangSchemes(stripControlCharacters(stripMarkup(value)))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** `safeText` over an optional value, preserving "absent". */
export function safeTextOrUndefined(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const cleaned = safeText(value);
  return cleaned === '' ? undefined : cleaned;
}

/** Schemes a link may use. Everything else — `javascript:`, `data:`, `vbscript:` — is refused. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'tel:', 'mailto:']);

/**
 * A URL that is safe to put in an `href`, or `null`.
 *
 * `null` rather than a fallback like `#`, so the caller has to decide what an unusable link means —
 * usually "render text instead of a link", which is the right answer and is not something this
 * function can choose. Relative and root-relative paths are allowed and returned unchanged;
 * protocol-relative `//host` is refused because it silently inherits the page's scheme and is
 * indistinguishable from a path at a glance.
 */
export function safeHref(value: string): string | null {
  /*
   * Tab, newline and carriage return are removed *before* the scheme is read, because that is what a
   * browser does: `java\tscript:alert(1)` in an `href` is a `javascript:` URL to Chrome and Safari.
   * Leaving them in was a real hole — the scheme regex failed to match, and the value fell through
   * to the "this is a relative path" branch and was returned unchanged. A property test found it.
   */
  const trimmed = stripControlCharacters(value.replace(/[\t\n\r]/g, '')).trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('//')) return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('?')) return trimmed;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed; // a relative path
  try {
    return SAFE_SCHEMES.has(new URL(trimmed).protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Does this string carry executable markup? The predicate Property 55 is stated in terms of.
 *
 * Used by the property test over the card, PDP, review and lead templates, and available to any
 * surface that wants to assert rather than assume. It errs towards saying yes: `onerror` as a bare
 * word in prose would be flagged, which is the right bias for a test oracle.
 */
export function containsExecutableMarkup(value: string): boolean {
  return (
    /<\s*script/i.test(value) ||
    /<\s*\/\s*script/i.test(value) ||
    /<\s*iframe/i.test(value) ||
    /<\s*object/i.test(value) ||
    /<\s*embed/i.test(value) ||
    /\son[a-z]+\s*=/i.test(value) ||
    /javascript\s*:/i.test(value) ||
    /vbscript\s*:/i.test(value) ||
    /data:text\/html/i.test(value)
  );
}

/**
 * JSON for a `<script type="application/json">` data block.
 *
 * `<`, `>` and `&` are escaped as unicode sequences — valid JSON, and impossible to close the
 * element with. The admin bootstrap uses this: its values are server-generated today, but a data
 * block whose safety depends on where its values happened to come from is one refactor away from
 * being an injection point.
 */
export function jsonScriptText(payload: unknown): string {
  return JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
