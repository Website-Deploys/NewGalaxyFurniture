/**
 * Ambient declaration for the `cloudflare:workers` built-in module.
 *
 * `cloudflare:workers` is a virtual module the `@astrojs/cloudflare` / Workers build resolves at
 * build time; bare `tsc` has no knowledge of it, so without this declaration a standalone typecheck
 * fails with TS2307 on `src/lib/env.cloudflare.ts`.
 *
 * `@cloudflare/workers-types` does declare this module, but only as `export = CloudflareWorkersModule`,
 * which pulls its whole ~15,000-line global type file into the program. `tsconfig.json` keeps `types`
 * narrow on purpose, so the two members this codebase uses are declared here instead.
 *
 * `env` is typed `unknown` deliberately. A declaration file cannot honestly assert the shape of a
 * deployment's bindings — that depends on `wrangler.toml` and on which secrets were actually set —
 * and claiming a concrete env type here would turn a missing binding into a runtime `undefined`
 * behind a type that said otherwise. `src/lib/env.cloudflare.ts` narrows it once, and every
 * individual binding is verified where it is used, so a partially configured deployment fails at the
 * binding that is genuinely absent.
 *
 * This mirrors the declaration the project carried before the Netlify migration; it is a type-only
 * file with no runtime effect and no secret.
 */

declare module 'cloudflare:workers' {
  const env: unknown;
  const ctx: {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  };
  export { env, ctx };
}
