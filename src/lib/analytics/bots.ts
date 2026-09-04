/**
 * Bot detection for the event pipeline: deliberately crude, deliberately one-directional.
 *
 * Requirement 20.3 asks the endpoint to drop obvious bot traffic. "Obvious" is the operative
 * word, and the function below is written to be honest about how little it can know:
 *
 * - **It only looks at the user agent**, which is self-declared. A crawler that claims to be
 *   Chrome is indistinguishable here from Chrome, and nothing in this module pretends
 *   otherwise. What it catches is the large majority of real crawler traffic, which announces
 *   itself politely in exactly this header.
 * - **It errs towards keeping the event.** A false positive silently deletes a real visitor's
 *   interest from the operator's only view of demand; a false negative inflates a count that
 *   is already documented as a lower bound. Of the two, the second is the recoverable one.
 * - **It stores nothing.** The user agent is read, tested, and discarded. There is no hash, no
 *   log line carrying it, and no column it could reach (Requirement 20.2).
 *
 * A missing user agent is treated as a bot. Every browser sends one; a request without it is
 * a script that did not bother.
 */

/**
 * Substrings that appear in the user agent of a crawler and not of a browser.
 *
 * Lowercased and matched as substrings, so `Googlebot/2.1` and `compatible; Googlebot` both
 * hit `googlebot`. Kept to well-known, unambiguous tokens: `spider`, `crawler` and `bot` as
 * bare words catch the long tail, and the specific names catch the crawlers that omit them.
 */
const BOT_TOKENS: readonly string[] = [
  'bot',
  'crawl',
  'spider',
  'slurp',
  'headlesschrome',
  'phantomjs',
  'puppeteer',
  'playwright',
  'lighthouse',
  'pagespeed',
  'curl/',
  'wget/',
  'python-requests',
  'go-http-client',
  'axios/',
  'node-fetch',
  'okhttp',
  'java/',
  'libwww-perl',
  'httpclient',
  'preview',
  'monitor',
  'uptime',
  'pingdom',
  'facebookexternalhit',
  'whatsapp',
  'telegrambot',
  'embedly',
  'quora link preview',
  'skypeuripreview',
  'bitlybot',
];

/** True when the user agent is one this pipeline will not count. */
export function isLikelyBot(userAgent: string | null | undefined): boolean {
  if (typeof userAgent !== 'string') return true;
  const value = userAgent.trim().toLowerCase();
  if (value === '') return true;
  // A browser user agent is never this short; a script's frequently is.
  if (value.length < 16) return true;
  return BOT_TOKENS.some((token) => value.includes(token));
}
