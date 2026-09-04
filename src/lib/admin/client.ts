/**
 * The admin islands' one way to talk to the API.
 *
 * Every mutating call needs the CSRF token, and the token is only obtainable from the SSR
 * bootstrap payload — it lives in the KV session record and is deliberately not in a
 * readable cookie. Centralising the call here means an island cannot forget it, and the
 * failure shape is uniform: an error envelope with `fields` lands as a `FieldErrors` map that
 * the form renders inline against the controls that failed.
 *
 * There is no retry and no optimistic write in this module. Both belong to the caller, which
 * knows whether the operation is idempotent — a blind retry of `POST /duplicate` creates two
 * products.
 *
 * Requirements: 10.8, 10.9, 26.3, 26.9.
 */

export interface AdminBootstrap {
  csrfToken: string | null;
  role: string | null;
  permissions: string[];
  expiresAt: number | null;
}

/** Read the JSON payload `AdminLayout` renders. Never evaluated, only parsed. */
export function readBootstrap(): AdminBootstrap {
  const element = document.getElementById('ngf-admin-bootstrap');
  if (element === null) return { csrfToken: null, role: null, permissions: [], expiresAt: null };
  try {
    const parsed = JSON.parse(element.textContent ?? '{}') as Partial<AdminBootstrap>;
    return {
      csrfToken: typeof parsed.csrfToken === 'string' ? parsed.csrfToken : null,
      role: typeof parsed.role === 'string' ? parsed.role : null,
      permissions: Array.isArray(parsed.permissions) ? parsed.permissions : [],
      expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : null,
    };
  } catch {
    return { csrfToken: null, role: null, permissions: [], expiresAt: null };
  }
}

export type FieldErrors = Record<string, string[]>;

export interface ApiFailure {
  code: string;
  message: string;
  fields?: FieldErrors;
  remote?: unknown;
  status: number;
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiFailure };

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Multipart uploads send a FormData body and no JSON content type. */
  formData?: FormData;
  signal?: AbortSignal;
}

/**
 * Call the admin API.
 *
 * A session that expired mid-edit comes back as `UNAUTHENTICATED`; the caller shows the
 * message and keeps the operator's values, because losing an edit to a re-login is exactly
 * the failure the design's recovery table forbids.
 */
export async function adminFetch<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const method = options.method ?? 'GET';
  const csrfToken = readBootstrap().csrfToken ?? '';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;

  let body: BodyInit | undefined;
  if (options.formData !== undefined) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  } else if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    body = '{}';
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return {
      ok: false,
      error: {
        code: 'NETWORK',
        message: 'Could not reach the server. Your changes are still here — try again.',
        status: 0,
      },
    };
  }

  if (response.status === 204) return { ok: true, value: undefined as T };

  let payload: unknown = null;
  const text = await response.text();
  if (text !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const envelope = (payload ?? {}) as {
      error?: string;
      message?: string;
      fields?: FieldErrors;
      remote?: unknown;
    };
    return {
      ok: false,
      error: {
        code: envelope.error ?? 'INTERNAL_ERROR',
        message: envelope.message ?? 'Something went wrong. Nothing was changed — try again.',
        status: response.status,
        ...(envelope.fields === undefined ? {} : { fields: envelope.fields }),
        ...(envelope.remote === undefined ? {} : { remote: envelope.remote }),
      },
    };
  }

  return { ok: true, value: payload as T };
}

/** Merge two field-error maps without losing either side's messages. */
export function mergeFieldErrors(a: FieldErrors, b: FieldErrors): FieldErrors {
  const merged: FieldErrors = { ...a };
  for (const [key, messages] of Object.entries(b)) {
    const existing = merged[key];
    merged[key] = existing === undefined ? [...messages] : [...new Set([...existing, ...messages])];
  }
  return merged;
}
