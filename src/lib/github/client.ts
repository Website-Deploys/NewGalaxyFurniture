/**
 * The GitHub content write client.
 *
 * Four rules govern every method here, and they are the reason the class exists rather
 * than a handful of `fetch` calls at the endpoints:
 *
 * 1. **Every path goes through `resolveContentPath`.** Not "should" — the client refuses
 *    to act on a path that does not resolve, so there is no way to reach the GitHub API
 *    from this codebase without passing the allowlist. Callers derive the path from the
 *    stored record (`productContentPath(product.slug)`); no browser-supplied path is
 *    ever accepted (Requirements 17.3, 17.4, 25.5).
 * 2. **The token never leaves the server.** It is read from the Worker binding, used as
 *    an `Authorization` header, and never returned, logged, or included in an error.
 *    Upstream error bodies are not echoed either — `AppError` carries a stable code and
 *    a display-safe sentence, and the upstream status goes to `console.error` only
 *    (Requirements 17.2, 25.12, 25.14).
 * 3. **No last-writer-wins.** Updates carry the blob `sha` they were read at. A
 *    `409`/`422` from GitHub means the file moved underneath us, and the client re-reads
 *    the current remote value and raises `CONFLICT` carrying it, so the admin UI can
 *    show a field-level diff (Requirements 17.10, 17.11).
 * 4. **Multi-file changes are one commit.** A rename writes the new file, deletes the
 *    old one, and updates `redirects.json` through the Git Data API as a single commit,
 *    so the repository is never half-renamed (Requirement 17.16).
 *
 * Design: Write Pipeline → Principles, Commit strategy, Conflict handling.
 * Requirements: 12.13, 17.2, 17.9–17.18, 25.12, 26.4, 26.5.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import { AppError, ERROR_CODES } from '../errors';
import { parseContentJson } from './serialize';
import { resolveContentPath } from './paths';

/**
 * The GitHub API host.
 *
 * The repository-wide "no hard-coded hostname" lint rule allows this host explicitly.
 * The rule exists for Requirement 28.9 — attaching a purchased domain must be a
 * configuration change — and the *site* origin is genuinely configuration. An upstream
 * service endpoint is not: it is a fixed property of GitHub, and making it configurable
 * would add a way to point the write pipeline, credential and all, at a host of
 * someone else's choosing. It stays overridable per client through `apiBase`, which is
 * how the pipeline tests inject a stub.
 */
export const GITHUB_API_BASE = 'https://api.github.com';

const API_VERSION = '2022-11-28';
const USER_AGENT = 'new-galaxy-furniture-admin';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubClientConfig {
  /** Fine-grained PAT with `contents:write` on the content repository. */
  token: string;
  /** `owner/repo`. */
  repo: string;
  /** The branch content commits land on. */
  branch: string;
  /** Overridable for tests. Defaults to the real API. */
  apiBase?: string;
  /** Overridable for tests. Defaults to the platform `fetch`. */
  fetchImpl?: FetchLike;
}

export interface ContentFile {
  path: string;
  /** Decoded UTF-8 text. */
  content: string;
  /** Blob sha — required to update or delete the file. */
  sha: string;
}

export interface ContentJson {
  path: string;
  /** The exact stored bytes, so unknown fields can be merged rather than rebuilt. */
  raw: string;
  value: unknown;
  sha: string;
}

export interface WriteFileInput {
  path: string;
  content: string;
  /** Omit to create; supply the sha read alongside the content to update. */
  sha?: string;
  message: string;
}

export interface WriteResult {
  commitSha: string;
  blobSha: string;
  path: string;
}

/** A change in a multi-file, single-commit action. */
export type TreeChange = { path: string; content: string } | { path: string; delete: true };

/* -------------------------------------------------------------------------- */
/* Encoding                                                                   */
/* -------------------------------------------------------------------------- */

/** UTF-8 → base64. `btoa` alone throws above U+00FF, and content is arbitrary text. */
export function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64 → UTF-8. GitHub wraps base64 at 60 columns, so whitespace is stripped. */
export function base64ToUtf8(value: string): string {
  const binary = atob(value.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

interface ContentsResponse {
  content?: string;
  sha?: string;
  encoding?: string;
}

interface CommitResponse {
  commit?: { sha?: string };
  content?: { sha?: string };
}

export class GitHubContentClient {
  private readonly token: string;
  private readonly repo: string;
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  readonly branch: string;

  constructor(config: GitHubClientConfig) {
    if (config.token.trim() === '' || !/^[^/]+\/[^/]+$/.test(config.repo)) {
      throw new AppError(ERROR_CODES.CONFIGURATION_INCOMPLETE, {
        message: 'The content repository is not configured for this environment.',
      });
    }
    this.token = config.token;
    this.repo = config.repo;
    this.branch = config.branch === '' ? 'main' : config.branch;
    this.apiBase = (config.apiBase ?? GITHUB_API_BASE).replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /**
   * Resolve a path or refuse. Every method funnels through this — it is the single
   * chokepoint promised by the design.
   */
  private resolve(candidate: string): string {
    const resolved = resolveContentPath(candidate);
    if (resolved === null) {
      // The offending path is deliberately not in the message: it is either a bug in
      // our own derivation (visible in logs) or an attack (which learns nothing).
      console.error('[github] refused a path outside the content allowlist');
      throw new AppError(ERROR_CODES.PATH_NOT_ALLOWED);
    }
    return resolved;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
        'user-agent': USER_AGENT,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    let json: unknown = null;
    const text = await response.text();
    if (text !== '') json = parseContentJson(text);
    return { status: response.status, json };
  }

  /**
   * Anything that is not a conflict and not a 404 becomes `REPOSITORY_UNAVAILABLE`:
   * "your changes are kept locally — retry". The upstream status is logged; the upstream
   * body is not, in either direction.
   */
  private fail(operation: string, status: number): never {
    console.error(`[github] ${operation} failed with status ${status}`);
    throw new AppError(ERROR_CODES.REPOSITORY_UNAVAILABLE);
  }

  private contentsUrl(path: string): string {
    // Each segment is encoded independently so `/` stays a separator. The path is
    // already allowlisted to `[a-z0-9-_./]`, so this is belt-and-braces.
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return `/repos/${this.repo}/contents/${encoded}`;
  }

  /**
   * The product slugs present in the repository. The only caller is rehydration.
   */
  async listProductSlugs(): Promise<string[]> {
    return await this.listDirectory('products');
  }

  /**
   * The file names in one allowlisted content directory.
   *
   * The directory is chosen from a closed union rather than taken as a string, for the
   * same reason `listProductSlugs` hard-codes its path: `resolveContentPath` only admits
   * `*.json` *files*, so a directory path cannot go through it, and loosening the resolver
   * to allow listings would widen the writable surface to pay for a read. A caller
   * therefore cannot name a directory that is not one of these three.
   */
  private async listDirectory(directory: 'products' | 'categories' | 'reviews'): Promise<string[]> {
    const { status, json } = await this.request(
      'GET',
      `/repos/${this.repo}/contents/data/${directory}?ref=${encodeURIComponent(this.branch)}`,
    );
    if (status === 404) return [];
    if (status !== 200) this.fail(`list data/${directory}`, status);
    if (!Array.isArray(json)) this.fail(`list data/${directory}`, status);

    const names: string[] = [];
    for (const entry of json as { name?: unknown; type?: unknown }[]) {
      if (entry.type !== 'file' || typeof entry.name !== 'string') continue;
      if (!entry.name.endsWith('.json')) continue;
      names.push(entry.name.slice(0, -'.json'.length));
    }
    return names;
  }

  /** The category slugs present in the repository. */
  async listCategorySlugs(): Promise<string[]> {
    return await this.listDirectory('categories');
  }

  /** The review ids present in the repository. */
  async listReviewIds(): Promise<string[]> {
    return await this.listDirectory('reviews');
  }

  /**
   * The most recent commits touching `data/` — the dashboard's recent-activity list.
   *
   * Requirement 11.6 asks for "the recorded content change history", and this *is* the record:
   * because every admin write commits with an `Actor:` trailer, `git log data/` is the audit
   * trail and there is no second log to read from. The path is a module constant for the same
   * reason as in `listProductSlugs` — a caller cannot name a different one.
   */
  async listContentCommits(
    limit = 5,
  ): Promise<{ subject: string; actor: string | null; at: string | null; sha: string | null }[]> {
    const { status, json } = await this.request(
      'GET',
      `/repos/${this.repo}/commits?path=data&sha=${encodeURIComponent(this.branch)}&per_page=${String(Math.max(1, Math.min(20, limit)))}`,
    );
    if (status === 404 || status === 409) return []; // empty repository or no such branch
    if (status !== 200 || !Array.isArray(json)) this.fail('list commits', status);

    const commits: {
      subject: string;
      actor: string | null;
      at: string | null;
      sha: string | null;
    }[] = [];
    for (const entry of json as {
      sha?: unknown;
      commit?: { message?: unknown; author?: { date?: unknown } };
    }[]) {
      const message = typeof entry.commit?.message === 'string' ? entry.commit.message : '';
      if (message === '') continue;
      const lines = message.split('\n');
      const actorLine = lines.find((line) => line.startsWith('Actor: '));
      commits.push({
        subject: lines[0] ?? '',
        actor: actorLine === undefined ? null : actorLine.slice('Actor: '.length),
        at: typeof entry.commit?.author?.date === 'string' ? entry.commit.author.date : null,
        sha: typeof entry.sha === 'string' ? entry.sha : null,
      });
    }
    return commits;
  }

  /** Read a file with its blob sha, or null when it does not exist. */
  async readFile(candidate: string): Promise<ContentFile | null> {
    const path = this.resolve(candidate);
    const { status, json } = await this.request(
      'GET',
      `${this.contentsUrl(path)}?ref=${encodeURIComponent(this.branch)}`,
    );
    if (status === 404) return null;
    if (status !== 200) this.fail(`read ${path}`, status);

    const body = json as ContentsResponse | null;
    if (body === null || typeof body.content !== 'string' || typeof body.sha !== 'string') {
      this.fail(`read ${path}`, status);
    }
    return { path, content: base64ToUtf8(body.content), sha: body.sha };
  }

  /**
   * Read a file and parse it, keeping the raw bytes.
   *
   * `raw` is what makes unknown-field preservation possible: the merge starts from the
   * stored object, not from a schema-shaped reconstruction of it.
   */
  async readJson(candidate: string): Promise<ContentJson | null> {
    const file = await this.readFile(candidate);
    if (file === null) return null;
    const value = parseContentJson(file.content);
    if (value === null) {
      // A hand-edited file that is not valid JSON. Refusing to write is correct:
      // merging into it would either fail or silently discard the operator's edit.
      console.error('[github] stored content file is not valid JSON');
      throw new AppError(ERROR_CODES.REPOSITORY_UNAVAILABLE, {
        message:
          'The stored content file could not be read. It may have been edited by hand — fix it in the repository and retry.',
      });
    }
    return { path: file.path, raw: file.content, value, sha: file.sha };
  }

  /**
   * Create or update one file.
   *
   * On `409`/`422` the current remote value is re-read and attached to a `CONFLICT`, so
   * the operator gets a field-level diff instead of a silent overwrite.
   */
  async writeFile(input: WriteFileInput): Promise<WriteResult> {
    const path = this.resolve(input.path);
    const { status, json } = await this.request('PUT', this.contentsUrl(path), {
      message: input.message,
      content: utf8ToBase64(input.content),
      branch: this.branch,
      ...(input.sha === undefined ? {} : { sha: input.sha }),
    });

    if (status === 409 || status === 422) await this.raiseConflict(path);
    if (status !== 200 && status !== 201) this.fail(`write ${path}`, status);

    const body = json as CommitResponse | null;
    return {
      path,
      commitSha: body?.commit?.sha ?? '',
      blobSha: body?.content?.sha ?? '',
    };
  }

  /** Delete one file. Requires the sha it was read at, for the same reason writes do. */
  async deleteFile(input: { path: string; sha: string; message: string }): Promise<WriteResult> {
    const path = this.resolve(input.path);
    const { status, json } = await this.request('DELETE', this.contentsUrl(path), {
      message: input.message,
      sha: input.sha,
      branch: this.branch,
    });

    if (status === 409 || status === 422) await this.raiseConflict(path);
    if (status !== 200) this.fail(`delete ${path}`, status);

    const body = json as CommitResponse | null;
    return { path, commitSha: body?.commit?.sha ?? '', blobSha: '' };
  }

  /**
   * Re-read the file and raise `CONFLICT` carrying the current remote value.
   *
   * This is the "never last-writer-wins" clause made concrete: the operator's values are
   * still in their form, the remote's values are in the error, and the UI asks which to
   * keep per field.
   */
  private async raiseConflict(path: string): Promise<never> {
    // The re-read failing does not change the outcome: it is still a conflict, and the
    // operator still must not have their stale values written. `remote: null` then means
    // "changed, and we could not read the new value" — the UI offers retry rather than a
    // diff.
    const remote = await this.readFile(path)
      .then((current) =>
        current === null
          ? null
          : { path, sha: current.sha, value: parseContentJson(current.content) },
      )
      .catch(() => null);
    throw new AppError(ERROR_CODES.CONFLICT, { remote });
  }

  /**
   * Apply several changes as one commit, via the Git Data API.
   *
   * Six calls where the Contents API would need one per file, and worth it: a rename is
   * "write the new file, delete the old one, add a redirect", and any prefix of that
   * applied on its own is a broken site. `base_tree` is the current tree, so files not
   * mentioned are untouched.
   */
  async writeTree(input: {
    changes: readonly TreeChange[];
    message: string;
  }): Promise<WriteResult> {
    if (input.changes.length === 0) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, {
        message: 'Nothing to commit.',
      });
    }
    const resolved = input.changes.map((change) => ({
      ...change,
      path: this.resolve(change.path),
    }));

    const ref = await this.request(
      'GET',
      `/repos/${this.repo}/git/ref/heads/${encodeURIComponent(this.branch)}`,
    );
    if (ref.status !== 200) this.fail('read ref', ref.status);
    const headSha = (ref.json as { object?: { sha?: string } } | null)?.object?.sha;
    if (typeof headSha !== 'string') this.fail('read ref', ref.status);

    const head = await this.request('GET', `/repos/${this.repo}/git/commits/${headSha}`);
    if (head.status !== 200) this.fail('read commit', head.status);
    const baseTree = (head.json as { tree?: { sha?: string } } | null)?.tree?.sha;
    if (typeof baseTree !== 'string') this.fail('read commit', head.status);

    const tree: Record<string, unknown>[] = [];
    for (const change of resolved) {
      if ('delete' in change) {
        // A null sha in a tree entry is how the Git Data API expresses a deletion.
        tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const blob = await this.request('POST', `/repos/${this.repo}/git/blobs`, {
        content: utf8ToBase64(change.content),
        encoding: 'base64',
      });
      if (blob.status !== 201) this.fail(`create blob for ${change.path}`, blob.status);
      const blobSha = (blob.json as { sha?: string } | null)?.sha;
      if (typeof blobSha !== 'string') this.fail(`create blob for ${change.path}`, blob.status);
      tree.push({ path: change.path, mode: '100644', type: 'blob', sha: blobSha });
    }

    const created = await this.request('POST', `/repos/${this.repo}/git/trees`, {
      base_tree: baseTree,
      tree,
    });
    if (created.status !== 201) this.fail('create tree', created.status);
    const treeSha = (created.json as { sha?: string } | null)?.sha;
    if (typeof treeSha !== 'string') this.fail('create tree', created.status);

    const commit = await this.request('POST', `/repos/${this.repo}/git/commits`, {
      message: input.message,
      tree: treeSha,
      parents: [headSha],
    });
    if (commit.status !== 201) this.fail('create commit', commit.status);
    const commitSha = (commit.json as { sha?: string } | null)?.sha;
    if (typeof commitSha !== 'string') this.fail('create commit', commit.status);

    const updated = await this.request(
      'PATCH',
      `/repos/${this.repo}/git/refs/heads/${encodeURIComponent(this.branch)}`,
      { sha: commitSha, force: false },
    );
    // A non-fast-forward ref update is the multi-file equivalent of a blob sha mismatch:
    // someone else committed while we were building the tree.
    if (updated.status === 409 || updated.status === 422) {
      throw new AppError(ERROR_CODES.CONFLICT, { remote: null });
    }
    if (updated.status !== 200) this.fail('update ref', updated.status);

    return { path: resolved[0]?.path ?? '', commitSha, blobSha: treeSha };
  }
}

/* -------------------------------------------------------------------------- */
/* Write serialization                                                        */
/* -------------------------------------------------------------------------- */

/** Cloudflare KV rejects `expirationTtl` under 60 s, so the 10 s lock is value-based. */
const LOCK_KV_TTL_SECONDS = 60;
export const PRODUCT_LOCK_TTL_MS = 10_000;

interface LockRecord {
  token: string;
  expiresAt: number;
}

/**
 * Serialize concurrent writes to one product (Requirement 12.13).
 *
 * The lock turns the common case — two admin tabs saving the same product seconds
 * apart — into a queue rather than a conflict, so the operator sees a brief wait instead
 * of a diff. It is explicitly **not** the correctness mechanism: KV is eventually
 * consistent and has no compare-and-set, so two writers can both believe they hold it.
 * The blob `sha` on the GitHub write is what actually guarantees the second write
 * observes the first, and the conflict path is what happens when the lock loses. Layering
 * an advisory lock over an authoritative check is the right shape; relying on the lock
 * alone would not be.
 *
 * The design specifies a 10 s TTL, which KV cannot express. The expiry therefore lives
 * *inside* the record and the KV TTL is the platform minimum, used only for cleanup.
 */
export async function withProductLock<T>(
  kv: KVNamespace,
  productId: string,
  operation: () => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  const key = `lock:product:${productId}`;
  const existing = await kv.get(key, 'text');
  if (existing !== null) {
    const parsed = parseContentJson(existing) as LockRecord | null;
    if (parsed !== null && typeof parsed.expiresAt === 'number' && parsed.expiresAt > now) {
      throw new AppError(ERROR_CODES.CONFLICT, {
        message: 'Another save for this product is in progress. Try again in a moment.',
      });
    }
  }

  const token = crypto.randomUUID();
  await kv.put(key, JSON.stringify({ token, expiresAt: now + PRODUCT_LOCK_TTL_MS }), {
    expirationTtl: LOCK_KV_TTL_SECONDS,
  });

  try {
    return await operation();
  } finally {
    // Only release a lock we still own: if ours expired and someone else took it,
    // deleting theirs would be worse than leaving ours to expire.
    const current = await kv.get(key, 'text');
    const parsed = current === null ? null : (parseContentJson(current) as LockRecord | null);
    if (parsed?.token === token) await kv.delete(key);
  }
}
