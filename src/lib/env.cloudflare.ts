/**
 * Typed access to runtime configuration and persistent storage — Cloudflare Workers.
 *
 * This is the Cloudflare counterpart of `src/lib/env.ts` (the Netlify resolver). It is ACTIVE on the
 * Cloudflare target: `astro.config.mjs` aliases `@/lib/env` to this module whenever the build runs
 * with `DEPLOY_TARGET=cloudflare`, so every consumer resolves storage and configuration through here
 * on Workers. On the default Netlify target the alias is absent and `@/lib/env` resolves to
 * `src/lib/env.ts` as before, so this module is inert there.
 *
 * It mirrors the public surface of `src/lib/env.ts` deliberately — same function names, same
 * signatures, same `EnvError` / `ENV_ERROR_CODES` contract, same `RuntimeCarrier` parameter on every
 * accessor — so that swapping the active module touches no call site. The *implementations* differ:
 * storage accessors return the Cloudflare adapters (D1 / KV / R2) rather than the Netlify ones, and
 * configuration is read from the Worker `env` binding via `cloudflare:workers` rather than
 * `process.env`.
 *
 * **Where bindings and config come from.** `@astrojs/cloudflare` v14 (Astro 6+) removed
 * `Astro.locals.runtime.env`; the supported access is `import { env } from 'cloudflare:workers'`,
 * which resolves the current invocation's bindings and vars. Prerendered routes have no Worker env,
 * so the storage accessors throw a stable `RUNTIME_UNAVAILABLE` there rather than returning a fake
 * client — a privileged route that silently did nothing would be worse than a clear error.
 *
 * Two rules preserved from the Netlify resolver:
 *   1. A missing/misconfigured dependency surfaces as a stable, greppable `EnvError` code.
 *   2. Secrets are read here for immediate server-side use and never returned in a serialisable
 *      shape.
 *
 * **A known divergence, flagged not hidden.** The Netlify `SecretName` union carries Netlify
 * deploy-status credentials (`NETLIFY_API_TOKEN`, `NETLIFY_SITE_ID`, `NETLIFY_BUILD_HOOK_URL`) and
 * `NETLIFY_DATABASE_URL`. On Cloudflare the database is a binding (not a URL secret) and the
 * deploy-status endpoint reads Cloudflare credentials (`CF_ACCOUNT_ID`, `CF_API_TOKEN`,
 * `CF_WORKER_NAME`, `CF_DEPLOY_HOOK_URL`). This file's `SecretName` therefore covers BOTH sets so it
 * compiles against either resolver. `src/pages/api/admin/deploy-status.ts` is already platform-aware
 * and reads the Cloudflare set when present; the retained `NETLIFY_*` names resolve to `undefined`
 * under a Cloudflare env and exist only so a shared call site type-checks on both targets.
 */

import { env as cloudflareEnv } from 'cloudflare:workers';

import type {
  D1Database,
  KVNamespace,
  R2Bucket,
} from '@cloudflare/workers-types';

import { createD1Database } from '@/lib/runtime/d1';
import { createCloudflareKeyValueStore } from '@/lib/runtime/kv';
import { createCloudflareObjectBucket } from '@/lib/runtime/r2';
import type { KeyValueStore, ObjectBucket, SqlDatabase } from '@/lib/runtime/types';
import { normalise as normaliseSiteUrl } from '@/lib/seo/site-url';

/** Logical bindings. Same names as the Netlify resolver so call sites are identical. */
export type BindingName = 'SESSIONS' | 'DRAFTS' | 'RATELIMIT' | 'DB' | 'MEDIA';

/**
 * Secrets and server-side variables. A superset of the Netlify resolver's union: it keeps the
 * platform-neutral names and adds the Cloudflare deploy-status set (see the file header's
 * divergence note). `NETLIFY_*` names are retained only so a call site that still references them
 * type-checks during the migration; they resolve to `undefined` under a Cloudflare env.
 */
export type SecretName =
  | 'GITHUB_TOKEN'
  | 'GITHUB_REPO'
  | 'GITHUB_BRANCH'
  | 'AI_PROVIDER'
  | 'AI_API_KEY'
  | 'AI_MODEL'
  | 'SESSION_SECRET'
  /** Cloudflare deploy-status credentials — all optional. */
  | 'CF_DEPLOY_HOOK_URL'
  | 'CF_ACCOUNT_ID'
  | 'CF_API_TOKEN'
  | 'CF_WORKER_NAME'
  /** Retained for source compatibility during the migration; unset under Cloudflare. */
  | 'NETLIFY_DATABASE_URL'
  | 'NETLIFY_BUILD_HOOK_URL'
  | 'NETLIFY_API_TOKEN'
  | 'NETLIFY_SITE_ID';

/**
 * Every binding and variable the Worker may carry. All optional: a partially configured deployment
 * fails at the specific binding that is missing, with a stable code, rather than at a type cast.
 */
interface WorkerEnv {
  // Bindings
  SESSIONS?: KVNamespace;
  DRAFTS?: KVNamespace;
  RATELIMIT?: KVNamespace;
  DB?: D1Database;
  MEDIA?: R2Bucket;
  // Public configuration
  PUBLIC_SITE_URL?: string;
  PUBLIC_WHATSAPP_NUMBERS?: string;
  PUBLIC_PHONE_NUMBERS?: string;
  // Secrets / server-side vars (string-valued)
  [key: string]: unknown;
}

/**
 * Stable error codes. Matched on by the admin error envelope and by tests, so they are part of the
 * contract: rename with care. Identical to the Netlify resolver's codes.
 */
export const ENV_ERROR_CODES = {
  RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
  BINDING_UNAVAILABLE: 'BINDING_UNAVAILABLE',
  CONFIG_UNAVAILABLE: 'CONFIG_UNAVAILABLE',
} as const;

export type EnvErrorCode = (typeof ENV_ERROR_CODES)[keyof typeof ENV_ERROR_CODES];

export class EnvError extends Error {
  readonly code: EnvErrorCode;
  /** The binding or variable name at fault. Never the value. */
  readonly name_: string;

  constructor(code: EnvErrorCode, name: string, hint: string) {
    super(`${code}: ${name} — ${hint}`);
    this.name = 'EnvError';
    this.code = code;
    this.name_ = name;
  }
}

/**
 * Retained for source compatibility with the Netlify resolver's signatures. On Cloudflare the
 * bindings come from `cloudflare:workers`, not from `locals`, so this is only a marker that the
 * caller believes it holds a request context (an on-demand route — the only place bindings exist).
 */
export interface RuntimeCarrier {
  locals?: unknown;
}

/** Shape check only. Individual bindings are verified where they are read. */
function workerEnv(): WorkerEnv {
  const value: unknown = cloudflareEnv;
  if (typeof value !== 'object' || value === null) {
    throw new EnvError(
      ENV_ERROR_CODES.RUNTIME_UNAVAILABLE,
      'cloudflare:workers env',
      'this route has no Cloudflare runtime; prerendered routes cannot use bindings',
    );
  }
  return value as WorkerEnv;
}

function requireBinding<T>(name: string, value: T | undefined, hint: string): T {
  if (value === undefined || value === null) {
    throw new EnvError(ENV_ERROR_CODES.BINDING_UNAVAILABLE, name, hint);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Storage accessors                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The SQL database (Cloudflare D1). Unlike the Netlify resolver this is NOT cached per process:
 * the D1 binding belongs to the current invocation's `env`, and the adapter is a thin, cheap
 * wrapper, so it is constructed per call. Requires the `DB` binding in `wrangler.toml`.
 */
export function getD1(_context?: RuntimeCarrier): SqlDatabase {
  const env = workerEnv();
  const db = requireBinding(
    'DB',
    env.DB,
    'add a [[d1_databases]] entry bound as DB to wrangler.toml',
  );
  return createD1Database(db);
}

/** A KV namespace (Cloudflare KV binding). */
export function getKV(
  _context: RuntimeCarrier,
  name: 'SESSIONS' | 'DRAFTS' | 'RATELIMIT',
): KeyValueStore {
  const env = workerEnv();
  const namespace = requireBinding(
    name,
    env[name],
    `add a [[kv_namespaces]] entry named ${name} to wrangler.toml`,
  );
  return createCloudflareKeyValueStore(namespace);
}

/** The media object bucket (Cloudflare R2 binding). */
export function getR2(_context?: RuntimeCarrier): ObjectBucket {
  const env = workerEnv();
  const bucket = requireBinding(
    'MEDIA',
    env.MEDIA,
    'add a [[r2_buckets]] entry bound as MEDIA to wrangler.toml',
  );
  return createCloudflareObjectBucket(bucket);
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/** Secrets come only from runtime bindings; only public settings have build fallbacks. */
function readEnv(name: string): string | undefined {
  let runtime: string | undefined;
  try {
    const value = workerEnv()[name];
    if (typeof value === 'string' && value !== '') runtime = value;
  } catch {
    // Prerendering may fall back to the explicit public settings below.
  }
  if (runtime !== undefined) return runtime;
  // A dynamic import.meta.env lookup bundles the entire build environment,
  // including private .env values. Static public reads keep that boundary closed.
  const publicBuildConfig: Record<string, unknown> = {
    PUBLIC_SITE_URL: import.meta.env.PUBLIC_SITE_URL,
    PUBLIC_WHATSAPP_NUMBERS: import.meta.env.PUBLIC_WHATSAPP_NUMBERS,
    PUBLIC_PHONE_NUMBERS: import.meta.env.PUBLIC_PHONE_NUMBERS,
  };
  const build = publicBuildConfig[name];
  return typeof build === 'string' && build !== '' ? build : undefined;
}

/**
 * A required secret or variable, trimmed. Throws `CONFIG_UNAVAILABLE` when unset or blank. The
 * returned value is for immediate server-side use only — never put it in a response body, a log
 * line, or a rendered template.
 */
export function requireSecret(_context: RuntimeCarrier, name: SecretName): string {
  const value = readEnv(name);
  if (value === undefined || value.trim() === '') {
    throw new EnvError(
      ENV_ERROR_CODES.CONFIG_UNAVAILABLE,
      name,
      `set it with \`wrangler secret put ${name}\` — it is never read from the repository`,
    );
  }
  return value.trim();
}

/** An optional variable, or `undefined` when unset or blank. */
export function optionalConfig(context: RuntimeCarrier, name: SecretName): string | undefined {
  try {
    return requireSecret(context, name);
  } catch (error) {
    if (error instanceof EnvError && error.code === ENV_ERROR_CODES.CONFIG_UNAVAILABLE) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Public, non-secret configuration. Safe to pass to a template or an island.
 *
 * `PUBLIC_SITE_URL` resolves from the Worker env (runtime) or the build-time env, so prerendered
 * routes — which have no Worker env — still resolve a canonical origin, never a hard-coded hostname.
 */
export function getPublicConfig(_context?: RuntimeCarrier): {
  siteUrl: string;
  whatsappNumbers: string[];
  phoneNumbers: string[];
} {
  const siteUrl = readEnv('PUBLIC_SITE_URL');
  if (siteUrl === undefined || siteUrl.trim() === '') {
    throw new EnvError(
      ENV_ERROR_CODES.CONFIG_UNAVAILABLE,
      'PUBLIC_SITE_URL',
      'set it in wrangler.toml [vars] and in .dev.vars — canonical URLs must never be hard-coded',
    );
  }

  const split = (value: string | undefined): string[] =>
    (value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');

  return {
    // One normalizer for the whole codebase (strips all trailing slashes); see
    // `src/lib/seo/site-url.ts#normalise`. Identical to the Netlify resolver's call.
    siteUrl: normaliseSiteUrl(siteUrl),
    whatsappNumbers: split(readEnv('PUBLIC_WHATSAPP_NUMBERS')),
    phoneNumbers: split(readEnv('PUBLIC_PHONE_NUMBERS')),
  };
}

/**
 * The client IP for a request, from Cloudflare's header.
 *
 * Cloudflare sets `cf-connecting-ip` on every request reaching the Worker; `x-forwarded-for` is a
 * fallback for local/`astro dev`. Used only to key anonymous rate limits, never stored. This is the
 * one behavioural change from the Netlify resolver's `clientIp`, which reads
 * `x-nf-client-connection-ip`.
 */
export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
