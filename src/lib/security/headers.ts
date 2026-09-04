/**
 * The security headers, defined once.
 *
 * They have to be applied in two places — `src/middleware.ts` for everything the Worker answers
 * (`/admin/**`, `/api/**`, `/img/**`, redirects) and `public/_headers` for the prerendered HTML and
 * hashed assets, which Cloudflare serves from the asset store without invoking the Worker at all.
 * Two application points is a fact of the platform; two *definitions* would be a defect, because
 * the pair would drift and the drift would be invisible. So the values live here, the middleware
 * imports them, and a unit test parses `public/_headers` and asserts it carries exactly this set
 * with exactly these values.
 *
 * The policy, header by header:
 *
 * - **HSTS** with `includeSubDomains` and `preload` — one year, every subdomain, and eligible for
 *   the preload list so the very first request is already HTTPS.
 * - **`X-Content-Type-Options: nosniff`** — a JSON response or an uploaded original is never
 *   re-interpreted as HTML.
 * - **`Referrer-Policy: strict-origin-when-cross-origin`** — a visitor following a WhatsApp link
 *   from a product page leaks the origin, not which piece they were looking at.
 * - **`X-Frame-Options: DENY`** plus **`frame-ancestors 'none'`** — both, because the header is
 *   what old browsers honour and the CSP directive is what current ones do.
 * - **`Permissions-Policy`** denying camera, microphone and geolocation. The site asks for none of
 *   the three; denying them means an injected script cannot ask either.
 * - **`Cross-Origin-Opener-Policy: same-origin`** — a page opened from here cannot reach back
 *   through `window.opener`.
 * - **The CSP**, whose two notable clauses are both deliberate:
 *   - `style-src 'self' 'unsafe-inline'` — required, and only for styles: Astro inlines critical
 *     CSS and scoped component styles into the document. There is no equivalent concession for
 *     scripts.
 *   - `script-src 'self'` plus the four hashes in `./inline-script-hashes.ts`, and **no nonce and
 *     no `'unsafe-inline'`**. Every script this project writes is an external same-origin file,
 *     including the pre-paint motion-preference bootstrap, which was moved out of an inline block
 *     for exactly this reason. The four hashes are Astro's island bootstrap, which the framework
 *     emits as literal inline elements with no way to externalise them — see that file for why a
 *     hash is the only honest option of the three available. `scripts/audit-csp.ts` fails the build
 *     if any inline script hashes to something not on that list, or if an inline event handler, a
 *     `javascript:` URL, or a cross-origin subresource appears in the built output.
 *
 * `connect-src` names `https://api.whatsapp.com` because the design's policy does; the site's own
 * beacons and form posts are same-origin, and `wa.me` links are navigations, which CSP does not
 * govern through `connect-src`.
 *
 * Design: Deployment.
 * Requirements: 25.9, 25.10.
 */

import { INLINE_SCRIPT_HASH_SOURCES } from './inline-script-hashes';

/** The policy from the design, as one line. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  ["script-src 'self'", ...INLINE_SCRIPT_HASH_SOURCES].join(' '),
  "connect-src 'self' https://api.whatsapp.com",
  "font-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Every response carries all of these. Lowercase names because that is what `Headers` normalises
 * to, which keeps the middleware's `set` calls and the test's lookups on one spelling.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': CONTENT_SECURITY_POLICY,
};

/**
 * Apply the set to a response.
 *
 * `set`, not `append`: a route that already answered with one of these — or a platform layer that
 * added a weaker default — is overwritten rather than joined, because two `Content-Security-Policy`
 * headers are intersected by the browser and the resulting policy is neither of the two anyone
 * wrote.
 */
export function applySecurityHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}
