/**
 * Ambient declaration for the `cloudflare:workers` built-in module.
 *
 * `@cloudflare/workers-types` declares this module, but only as
 * `export = CloudflareWorkersModule`, which requires its whole 15,000-line global type
 * file to be in the program. `tsconfig.json` deliberately keeps `types` narrow, so the
 * two members this codebase uses are declared here instead.
 *
 * `env` is typed `unknown` on purpose. A declaration file cannot honestly assert the
 * shape of a deployment's bindings — that depends on `wrangler.toml` and on which
 * secrets were actually set — and claiming `WorkerEnv` here would turn a missing binding
 * into a runtime `undefined` behind a type that said otherwise. `src/lib/env.ts` narrows
 * it once, and every individual binding is verified where it is used so a partially
 * configured deployment fails at the binding that is genuinely absent.
 */

declare module 'cloudflare:workers' {
  const env: unknown;
  const ctx: {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  };
  export { env, ctx };
}
