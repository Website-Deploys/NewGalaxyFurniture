/**
 * Continue work after the response has been sent.
 *
 * Two operations need this, and for the same reason: they are slow, and the operator has no
 * reason to wait. Derivative generation is hundreds of milliseconds of AVIF encoding per
 * width, and a soft delete is one read plus one write per stored object. Both must finish,
 * so neither can be a dropped promise.
 *
 * **Netlify.** The `@astrojs/netlify` adapter exposes the Netlify Functions request context on
 * `locals.netlify.context`. When that context carries a `waitUntil`, the work is handed to it so
 * the runtime keeps the function alive until it settles without the operator waiting on the
 * response. When it does not — a prerendered render, a unit test, or a runtime that does not
 * surface `waitUntil` — the correct fallback is to await the work inline rather than lose it: the
 * data stays consistent, the operator simply waits a little longer.
 *
 * Requirements: 15.8, 15.13, 15.16.
 */

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

function executionContextOf(locals: unknown): ExecutionContextLike | null {
  if (typeof locals !== 'object' || locals === null) return null;
  // `@astrojs/netlify` sets `locals.netlify = { context }`; the Netlify Functions context may
  // carry a `waitUntil`. Read it structurally so a runtime that omits it falls back cleanly.
  const netlify = (locals as { netlify?: unknown }).netlify;
  const candidate =
    typeof netlify === 'object' && netlify !== null
      ? (netlify as { context?: unknown }).context
      : undefined;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const waitUntil = (candidate as { waitUntil?: unknown }).waitUntil;
  return typeof waitUntil === 'function' ? (candidate as ExecutionContextLike) : null;
}

/**
 * Hand `work` to the platform, or await it.
 *
 * @returns true when the work was deferred, false when it was awaited inline.
 */
export async function runAfterResponse(locals: unknown, work: Promise<unknown>): Promise<boolean> {
  const ctx = executionContextOf(locals);
  if (ctx !== null) {
    ctx.waitUntil(work);
    return true;
  }
  // No platform context: finishing the work late is not an option, so it finishes now.
  await work;
  return false;
}
