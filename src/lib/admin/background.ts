/**
 * Continue work after the response has been sent.
 *
 * Two operations need this, and for the same reason: they are slow, and the operator has no
 * reason to wait. Derivative generation is hundreds of milliseconds of AVIF encoding per
 * width, and a soft delete is one read plus one write per stored object. Both must finish,
 * so neither can be a dropped promise — `waitUntil` is what keeps the isolate alive until
 * they do.
 *
 * The `ExecutionContext` arrives on `locals.cfContext` (the `locals.runtime` property that
 * used to carry it was removed in @astrojs/cloudflare v14). It is read defensively because
 * there are two situations where it is absent — a prerendered render and a unit test — and
 * in both the correct fallback is to await the work rather than to lose it.
 *
 * Requirements: 15.8, 15.13, 15.16.
 */

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

function executionContextOf(locals: unknown): ExecutionContextLike | null {
  if (typeof locals !== 'object' || locals === null) return null;
  const candidate = (locals as { cfContext?: unknown }).cfContext;
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
