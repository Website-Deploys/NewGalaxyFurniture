/**
 * Typed access to runtime configuration and persistent storage — Netlify-native.
 *
 * This module is the single seam between the application and its infrastructure. Nothing else
 * reads `process.env` for a secret, constructs a database client, or opens a storage bucket:
 * routes and stores ask this module for `getD1()`, `getKV()`, `getR2()`, `requireSecret()` or
 * `getPublicConfig()`, and receive an object typed to the project's own storage interfaces
 * (`src/lib/runtime/types.ts`).
 *
 * **Where configuration comes from.** On Netlify, environment variables and secrets are
 * `process.env` inside a Function; public build-time values are also on `import.meta.env`. There is
 * no Cloudflare runtime, no `cloudflare:workers` import, and no binding object — the "binding"
 * accessors now return adapter-backed clients (Neon Postgres, Netlify Blobs) constructed on first
 * use and cached per process.
 *
 * Two rules preserved from the original design:
 *   1. A missing/misconfigured dependency surfaces as a stable, greppable `EnvError` code rather
 *      than a deep `undefined` failure.
 *   2. Secrets are read here for immediate server-side use and never returned in a shape a caller
 *      could serialise wholesale.
 *
 * The `context` parameter is retained on every accessor for source compatibility with the ~30 call
 * sites and to carry Netlify request context (client IP/geo) where a caller needs it; the storage
 * accessors no longer depend on it.
 */

import { createBlobKeyValueStore } from '@/lib/runtime/blob-kv';
import { createBlobObjectBucket } from '@/lib/runtime/blob-bucket';
import { createNeonDatabase } from '@/lib/runtime/neon';
import type { KeyValueStore, ObjectBucket, SqlDatabase } from '@/lib/runtime/types';

/** Logical KV namespaces, each a separate Netlify Blobs store. */
export type BindingName = 'SESSIONS' | 'DRAFTS' | 'RATELIMIT' | 'DB' | 'MEDIA';
export type SecretName =
  | 'GITHUB_TOKEN'
  | 'GITHUB_REPO'
  | 'GITHUB_BRANCH'
  | 'AI_PROVIDER'
  | 'AI_API_KEY'
  | 'AI_MODEL'
  | 'SESSION_SECRET'
  | 'NETLIFY_DATABASE_URL'
  /** Optional deploy-status credentials (Netlify build hook + API). */
  | 'NETLIFY_BUILD_HOOK_URL'
  | 'NETLIFY_API_TOKEN'
  | 'NETLIFY_SITE_ID';

/** The Blobs store name for each KV namespace. Prefixed so they never collide. */
const KV_STORE_NAMES: Record<'SESSIONS' | 'DRAFTS' | 'RATELIMIT', string> = {
  SESSIONS: 'ngf-sessions',
  DRAFTS: 'ngf-drafts',
  RATELIMIT: 'ngf-ratelimit',
};

/** The Blobs store name for image objects. */
const MEDIA_STORE_NAME = 'ngf-media';

/**
 * Stable error codes. Matched on by the admin error envelope and by tests, so they are part of the
 * contract: rename with care. `RUNTIME_UNAVAILABLE` is retained for source compatibility; it is now
 * only thrown if an accessor is somehow called with no environment at all.
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
 * Retained for source compatibility with the accessors' original signatures. It is the caller's
 * assertion that it holds a request context (an on-demand route); the storage accessors no longer
 * consult it, but keeping it avoids editing ~30 call sites and carries Netlify locals when present.
 */
export interface RuntimeCarrier {
  locals?: unknown;
}

/* -------------------------------------------------------------------------- */
/* Configuration (process.env + build-time public vars)                       */
/* -------------------------------------------------------------------------- */

/** Read a variable from the Netlify Function environment, then the build-time env. */
function readEnv(name: string): string | undefined {
  const runtime =
    typeof process !== 'undefined' && process.env !== undefined ? process.env[name] : undefined;
  if (runtime !== undefined && runtime !== '') return runtime;
  const build = (import.meta.env as Record<string, string | undefined>)[name];
  return build !== undefined && build !== '' ? build : undefined;
}

/* -------------------------------------------------------------------------- */
/* Storage accessors (cached per process)                                     */
/* -------------------------------------------------------------------------- */

let cachedDb: SqlDatabase | undefined;
const cachedKv = new Map<string, KeyValueStore>();
let cachedBucket: ObjectBucket | undefined;

/** The SQL database (Neon Postgres). Requires `NETLIFY_DATABASE_URL` in the environment. */
export function getD1(_context?: RuntimeCarrier): SqlDatabase {
  if (cachedDb !== undefined) return cachedDb;
  const url = readEnv('NETLIFY_DATABASE_URL') ?? readEnv('DATABASE_URL');
  if (url === undefined) {
    throw new EnvError(
      ENV_ERROR_CODES.BINDING_UNAVAILABLE,
      'DB',
      'set NETLIFY_DATABASE_URL (Netlify DB / Neon) in the environment',
    );
  }
  cachedDb = createNeonDatabase(url);
  return cachedDb;
}

/** A KV namespace (Netlify Blobs store). */
export function getKV(
  _context: RuntimeCarrier,
  name: 'SESSIONS' | 'DRAFTS' | 'RATELIMIT',
): KeyValueStore {
  const existing = cachedKv.get(name);
  if (existing !== undefined) return existing;
  const store = createBlobKeyValueStore(KV_STORE_NAMES[name]);
  cachedKv.set(name, store);
  return store;
}

/** The media object bucket (Netlify Blobs store). */
export function getR2(_context?: RuntimeCarrier): ObjectBucket {
  if (cachedBucket !== undefined) return cachedBucket;
  cachedBucket = createBlobObjectBucket(MEDIA_STORE_NAME);
  return cachedBucket;
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
      `set it in the Netlify site environment — it is never read from the repository`,
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
 * `PUBLIC_SITE_URL` resolves from the environment (runtime or build), so prerendered routes and
 * functions alike get a canonical origin, never a hard-coded hostname.
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
      'set it in the Netlify site environment and in .env — canonical URLs must never be hard-coded',
    );
  }

  const split = (value: string | undefined): string[] =>
    (value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');

  return {
    siteUrl: siteUrl.trim().replace(/\/$/, ''),
    whatsappNumbers: split(readEnv('PUBLIC_WHATSAPP_NUMBERS')),
    phoneNumbers: split(readEnv('PUBLIC_PHONE_NUMBERS')),
  };
}

/**
 * The client IP for a request, from Netlify's headers.
 *
 * Replaces the Cloudflare `cf-connecting-ip` header. Netlify sets `x-nf-client-connection-ip`, with
 * `x-forwarded-for` as a fallback. Used only to key anonymous rate limits, never stored.
 */
export function clientIp(request: Request): string {
  return (
    request.headers.get('x-nf-client-connection-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
