/**
 * Typed access to the Worker runtime bindings and configuration.
 *
 * Two rules this module exists to enforce:
 *
 * 1. Nothing reads `locals.runtime.env` directly. A missing binding surfaces as a
 *    stable, greppable error code instead of `undefined.get is not a function`
 *    three frames deeper.
 * 2. Secrets are read here and never returned to a caller that could serialize
 *    them. `requireSecret` returns the value for immediate server-side use; no
 *    function in this module hands out the whole env object with secrets on it.
 *
 * **Where the env comes from.** `Astro.locals.runtime.env` no longer exists.
 * @astrojs/cloudflare v14 (Astro 6+) removed it: `createLocals` now installs a
 * `runtime` property whose `env` getter *throws* a migration message, and the
 * supported access is `import { env } from 'cloudflare:workers'`. The original
 * implementation of this module read `context.locals.runtime.env`, which meant every
 * accessor here detonated the adapter's getter on first use and every binding-using
 * route would have returned a 500 — including the entire admin API. Bindings are
 * therefore read from `cloudflare:workers` below.
 *
 * The `context` parameter is retained on every accessor even though it is no longer
 * consulted for bindings. It keeps the call sites and the design's signatures intact,
 * and it is still meaningful: it is the caller's assertion that it is running on an
 * on-demand route, which is the only place bindings exist at all.
 *
 * Design: Architecture → Folder Structure (Bindings); Deployment.
 * Requirements: 25.12, 25.13, 28.5, 28.9.
 */

import { env as cloudflareEnv } from 'cloudflare:workers';

import type {
  D1Database,
  Fetcher,
  KVNamespace,
  R2Bucket,
  RateLimit,
} from '@cloudflare/workers-types';

/** Every binding and variable declared in `wrangler.toml` / set via `wrangler secret put`. */
export interface WorkerEnv {
  // KV
  SESSIONS?: KVNamespace;
  DRAFTS?: KVNamespace;
  RATELIMIT?: KVNamespace;
  // D1
  DB?: D1Database;
  // R2
  MEDIA?: R2Bucket;
  // Static assets
  ASSETS?: Fetcher;
  // Rate Limiting bindings (60 s windows; longer windows live in RATELIMIT KV)
  RL_ADMIN_API?: RateLimit;
  RL_EVENTS?: RateLimit;
  // Public configuration
  PUBLIC_SITE_URL?: string;
  PUBLIC_WHATSAPP_NUMBERS?: string;
  PUBLIC_PHONE_NUMBERS?: string;
  // Secrets — server-side only
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
  AI_PROVIDER?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  SESSION_SECRET?: string;
  CF_DEPLOY_HOOK_URL?: string;
  /**
   * Deploy-status credentials.
   *
   * Not in the design's secret list, and required by it: `/api/admin/deploy-status` is
   * specified as reading "the Cloudflare deployments API for the latest build of the
   * content branch", and that API needs an account id and an API token. The design names
   * only `CF_DEPLOY_HOOK_URL`, which is write-only — it starts a build and reports
   * nothing about one. All three are optional, and the endpoint returns a stable
   * `CONFIGURATION_INCOMPLETE` when they are unset, so an environment without them
   * degrades to "cannot report the deploy" rather than failing to build.
   */
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  /** Worker (script) name whose deployments are polled. Defaults to the wrangler `name`. */
  CF_WORKER_NAME?: string;
}

export type BindingName = 'SESSIONS' | 'DRAFTS' | 'RATELIMIT' | 'DB' | 'MEDIA' | 'ASSETS';
export type RateLimiterName = 'RL_ADMIN_API' | 'RL_EVENTS';
export type SecretName =
  | 'GITHUB_TOKEN'
  | 'GITHUB_REPO'
  | 'GITHUB_BRANCH'
  | 'AI_PROVIDER'
  | 'AI_API_KEY'
  | 'AI_MODEL'
  | 'SESSION_SECRET'
  | 'CF_DEPLOY_HOOK_URL'
  | 'CF_ACCOUNT_ID'
  | 'CF_API_TOKEN'
  | 'CF_WORKER_NAME';

/**
 * Stable error codes. These are matched on by the admin error envelope and by
 * tests, so they are part of the contract: rename with care.
 */
export const ENV_ERROR_CODES = {
  /** The runtime context carried no Cloudflare env at all (wrong render mode, or `astro dev` without platformProxy). */
  RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
  /** The env exists but a required binding is missing from wrangler.toml or the deployment. */
  BINDING_UNAVAILABLE: 'BINDING_UNAVAILABLE',
  /** A required variable or secret is unset or empty. */
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
 * Retained for source compatibility with the accessors' original signatures. The
 * bindings no longer come from `locals` — see the note at the top of this file — so
 * this is now only a marker that the caller believes it holds a request context.
 */
export interface RuntimeCarrier {
  locals?: unknown;
}

/**
 * Shape check only. Individual bindings are verified where they are used, so a
 * partially configured deployment fails at the binding that is actually missing.
 */
function isWorkerEnv(value: unknown): value is WorkerEnv {
  return typeof value === 'object' && value !== null;
}

/**
 * The Cloudflare env for the current invocation.
 *
 * Throws `RUNTIME_UNAVAILABLE` rather than returning a fake env, because silently
 * continuing without bindings is how a privileged route ends up doing nothing and
 * reporting success. `context` is accepted and ignored (see the file header).
 */
export function getWorkerEnv(_context?: RuntimeCarrier): WorkerEnv {
  if (!isWorkerEnv(cloudflareEnv)) {
    throw new EnvError(
      ENV_ERROR_CODES.RUNTIME_UNAVAILABLE,
      'cloudflare:workers env',
      'this route has no Cloudflare runtime; prerendered routes cannot use bindings',
    );
  }
  return cloudflareEnv;
}

function requireFrom<T>(name: string, value: T | undefined, hint: string): T {
  if (value === undefined || value === null) {
    throw new EnvError(ENV_ERROR_CODES.BINDING_UNAVAILABLE, name, hint);
  }
  return value;
}

/** A KV namespace binding, or `BINDING_UNAVAILABLE`. */
export function getKV(
  context: RuntimeCarrier,
  name: 'SESSIONS' | 'DRAFTS' | 'RATELIMIT',
): KVNamespace {
  const env = getWorkerEnv(context);
  return requireFrom(
    name,
    env[name],
    `add a [[kv_namespaces]] entry named ${name} to wrangler.toml`,
  );
}

/** The D1 database binding, or `BINDING_UNAVAILABLE`. */
export function getD1(context: RuntimeCarrier): D1Database {
  const env = getWorkerEnv(context);
  return requireFrom('DB', env.DB, 'add a [[d1_databases]] entry bound as DB to wrangler.toml');
}

/** The R2 media bucket binding, or `BINDING_UNAVAILABLE`. */
export function getR2(context: RuntimeCarrier): R2Bucket {
  const env = getWorkerEnv(context);
  return requireFrom(
    'MEDIA',
    env.MEDIA,
    'add a [[r2_buckets]] entry bound as MEDIA to wrangler.toml',
  );
}

/** A Rate Limiting binding, or `BINDING_UNAVAILABLE`. */
export function getRateLimiter(context: RuntimeCarrier, name: RateLimiterName): RateLimit {
  const env = getWorkerEnv(context);
  return requireFrom(name, env[name], `add a [[ratelimits]] entry named ${name} to wrangler.toml`);
}

/** The static asset fetcher, or `BINDING_UNAVAILABLE`. */
export function getAssets(context: RuntimeCarrier): Fetcher {
  const env = getWorkerEnv(context);
  return requireFrom(
    'ASSETS',
    env.ASSETS,
    'add an [assets] block with binding = "ASSETS" to wrangler.toml',
  );
}

/**
 * A required secret or variable, trimmed. Throws `CONFIG_UNAVAILABLE` when unset
 * or blank. The returned value is for immediate server-side use only — never put
 * it in a response body, a log line, or a rendered template.
 */
export function requireSecret(context: RuntimeCarrier, name: SecretName): string {
  const env = getWorkerEnv(context);
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
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
 * `PUBLIC_SITE_URL` falls back to Astro's build-time `import.meta.env` value so
 * prerendered routes — which have no Worker env — still resolve a canonical
 * origin, and never a hard-coded hostname.
 */
export function getPublicConfig(context?: RuntimeCarrier): {
  siteUrl: string;
  whatsappNumbers: string[];
  phoneNumbers: string[];
} {
  let env: WorkerEnv = {};
  if (context !== undefined) {
    try {
      env = getWorkerEnv(context);
    } catch {
      env = {};
    }
  }

  const buildTime = import.meta.env as Record<string, string | undefined>;
  const siteUrl = env.PUBLIC_SITE_URL ?? buildTime.PUBLIC_SITE_URL;
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
    siteUrl: siteUrl.trim().replace(/\/$/, ''),
    whatsappNumbers: split(env.PUBLIC_WHATSAPP_NUMBERS ?? buildTime.PUBLIC_WHATSAPP_NUMBERS),
    phoneNumbers: split(env.PUBLIC_PHONE_NUMBERS ?? buildTime.PUBLIC_PHONE_NUMBERS),
  };
}
