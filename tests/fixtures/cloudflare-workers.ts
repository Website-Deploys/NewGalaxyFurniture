/**
 * A stub for `cloudflare:workers`, aliased in `vitest.config.ts`.
 *
 * `cloudflare:workers` is a runtime module that exists only inside the Workers runtime, and
 * `src/lib/env.ts` imports `env` from it to read bindings. Anything that transitively imports that
 * module — the admin guard does, for `getKV` and `getPublicConfig` — cannot be loaded in a plain Node
 * test without this.
 *
 * The env is **empty**, deliberately. A stub that pre-populated bindings would let a test pass while
 * exercising a code path that reads a binding it was never given, and the accessors in
 * `src/lib/env.ts` are specified to throw `BINDING_UNAVAILABLE` in exactly that case. An empty env
 * means a test that needs a binding must pass one in explicitly, which is what every suite here
 * does.
 */

export const env: Record<string, unknown> = {};

/** Present for source compatibility; nothing under test schedules Worker-level work. */
export const WorkerEntrypoint = class {};
export const DurableObject = class {};
export function waitUntil(_promise: Promise<unknown>): void {
  /* no scheduler in a unit test */
}
