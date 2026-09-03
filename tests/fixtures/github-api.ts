/**
 * An in-memory stand-in for the GitHub Contents and Git Data APIs.
 *
 * This is a *stub of the protocol*, not a stub of our client: it holds a file tree,
 * computes blob shas, enforces the `sha` precondition on updates, and records every
 * commit message it receives. `GitHubContentClient` runs unmodified against it, so the
 * pipeline test exercises the real request construction, the real base64 encoding, the
 * real conflict handling, and the real commit-message rendering.
 *
 * The one behaviour worth calling out is `mismatchedSha`: the Contents API answers a
 * stale-`sha` update with `409`, and that is the branch the "never last-writer-wins"
 * requirement lives on, so the stub reproduces it faithfully rather than accepting the
 * write.
 *
 * Used only by tests. Nothing here is imported by `src/`.
 */

export interface StubFile {
  content: string;
  sha: string;
}

export interface RecordedCommit {
  message: string;
  paths: string[];
  kind: 'contents-put' | 'contents-delete' | 'tree';
}

let shaCounter = 0;
function nextSha(): string {
  shaCounter += 1;
  return `blob${String(shaCounter).padStart(36, '0')}`;
}

function utf8ToBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function base64ToUtf8(value: string): string {
  return Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8');
}

export interface StubOptions {
  repo?: string;
  branch?: string;
  /** Files present before the test runs, keyed by repository path. */
  files?: Record<string, string>;
}

export class GitHubApiStub {
  readonly repo: string;
  readonly branch: string;
  readonly files = new Map<string, StubFile>();
  readonly commits: RecordedCommit[] = [];
  readonly requests: { method: string; path: string }[] = [];
  /** Bearer tokens seen. Asserted to never be empty and never to leak into a response. */
  readonly tokensSeen: string[] = [];

  /** When set, the next Contents write answers with this status regardless of the sha. */
  forceStatusOnce: number | null = null;
  /**
   * Simulates a concurrent writer: called immediately before a Contents write is
   * evaluated, so the test can change the remote between the client's read and its write.
   */
  onBeforeWrite: (() => void) | null = null;

  headSha = 'commit000000000000000000000000000000000';
  treeSha = 'tree00000000000000000000000000000000000';

  constructor(options: StubOptions = {}) {
    this.repo = options.repo ?? 'Website-Deploys/NewGalaxyFurniture';
    this.branch = options.branch ?? 'main';
    for (const [path, content] of Object.entries(options.files ?? {})) {
      this.files.set(path, { content, sha: nextSha() });
    }
  }

  /** Drop-in for `fetch`, wired into the client as `fetchImpl`. */
  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    this.requests.push({ method, path });

    const auth = new Headers(init?.headers).get('authorization') ?? '';
    this.tokensSeen.push(auth);

    // Every request this stub receives carries a JSON string body or none: the client
    // stringifies before calling fetch. `String(init.body)` would silently produce
    // '[object Object]' for anything else, so the type is narrowed instead.
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    const body: unknown = rawBody === undefined ? undefined : JSON.parse(rawBody);
    return this.route(method, path, url, body);
  };

  private json(status: number, value: unknown): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  private contentsPrefix(): string {
    return `/repos/${this.repo}/contents/`;
  }

  private route(method: string, path: string, url: URL, body: unknown): Response {
    const contents = this.contentsPrefix();

    if (path.startsWith(contents)) {
      const filePath = decodeURIComponent(path.slice(contents.length));
      if (method === 'GET') return this.getContents(filePath, url);
      if (method === 'PUT') return this.putContents(filePath, body);
      if (method === 'DELETE') return this.deleteContents(filePath, body);
    }

    if (method === 'GET' && path === `/repos/${this.repo}/git/ref/heads/${this.branch}`) {
      return this.json(200, { object: { sha: this.headSha } });
    }
    if (method === 'GET' && path.startsWith(`/repos/${this.repo}/git/commits/`)) {
      return this.json(200, { tree: { sha: this.treeSha } });
    }
    if (method === 'POST' && path === `/repos/${this.repo}/git/blobs`) {
      const input = body as { content?: string };
      const sha = nextSha();
      this.pendingBlobs.set(sha, base64ToUtf8(input.content ?? ''));
      return this.json(201, { sha });
    }
    if (method === 'POST' && path === `/repos/${this.repo}/git/trees`) {
      const input = body as { tree?: { path: string; sha: string | null }[] };
      this.pendingTree = input.tree ?? [];
      return this.json(201, { sha: nextSha() });
    }
    if (method === 'POST' && path === `/repos/${this.repo}/git/commits`) {
      const input = body as { message?: string };
      // The whole tree lands at once, which is what makes the commit atomic.
      const paths: string[] = [];
      for (const entry of this.pendingTree) {
        paths.push(entry.path);
        if (entry.sha === null) {
          this.files.delete(entry.path);
          continue;
        }
        this.files.set(entry.path, {
          content: this.pendingBlobs.get(entry.sha) ?? '',
          sha: entry.sha,
        });
      }
      this.commits.push({ message: input.message ?? '', paths, kind: 'tree' });
      this.pendingTree = [];
      this.pendingBlobs.clear();
      this.headSha = nextSha();
      return this.json(201, { sha: this.headSha });
    }
    if (method === 'PATCH' && path === `/repos/${this.repo}/git/refs/heads/${this.branch}`) {
      return this.json(200, { object: { sha: this.headSha } });
    }

    return this.json(404, { message: 'Not Found' });
  }

  private pendingBlobs = new Map<string, string>();
  private pendingTree: { path: string; sha: string | null }[] = [];

  private getContents(filePath: string, url: URL): Response {
    // Directory listing, for rehydration and for the category and review admin lists.
    if (
      filePath === 'data/products' ||
      filePath === 'data/categories' ||
      filePath === 'data/reviews'
    ) {
      const prefix = `${filePath}/`;
      const entries = [...this.files.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ name: key.slice(prefix.length), type: 'file' }));
      return this.json(200, entries);
    }
    if (url.searchParams.get('ref') !== this.branch) {
      return this.json(404, { message: 'Not Found' });
    }
    const file = this.files.get(filePath);
    if (file === undefined) return this.json(404, { message: 'Not Found' });
    return this.json(200, {
      path: filePath,
      sha: file.sha,
      encoding: 'base64',
      // GitHub wraps base64 at 60 columns; reproducing that catches a client that
      // forgets to strip whitespace before decoding.
      content: (utf8ToBase64(file.content).match(/.{1,60}/g) ?? []).join('\n'),
    });
  }

  private putContents(filePath: string, body: unknown): Response {
    this.onBeforeWrite?.();
    if (this.forceStatusOnce !== null) {
      const status = this.forceStatusOnce;
      this.forceStatusOnce = null;
      return this.json(status, { message: 'forced' });
    }

    const input = body as { message?: string; content?: string; sha?: string };
    const existing = this.files.get(filePath);

    if (existing !== undefined && input.sha !== existing.sha) {
      // The precondition failure the Contents API reports for a stale update.
      return this.json(409, { message: 'is at a different sha than expected' });
    }
    if (existing === undefined && input.sha !== undefined) {
      return this.json(422, { message: 'sha supplied for a file that does not exist' });
    }

    const sha = nextSha();
    this.files.set(filePath, { content: base64ToUtf8(input.content ?? ''), sha });
    this.commits.push({ message: input.message ?? '', paths: [filePath], kind: 'contents-put' });
    this.headSha = nextSha();
    return this.json(existing === undefined ? 201 : 200, {
      content: { sha },
      commit: { sha: this.headSha },
    });
  }

  private deleteContents(filePath: string, body: unknown): Response {
    const input = body as { message?: string; sha?: string };
    const existing = this.files.get(filePath);
    if (existing === undefined) return this.json(404, { message: 'Not Found' });
    if (input.sha !== existing.sha) {
      return this.json(409, { message: 'is at a different sha than expected' });
    }
    this.files.delete(filePath);
    this.commits.push({ message: input.message ?? '', paths: [filePath], kind: 'contents-delete' });
    this.headSha = nextSha();
    return this.json(200, { commit: { sha: this.headSha } });
  }

  /** Test helper: current file content as text. */
  read(filePath: string): string | null {
    return this.files.get(filePath)?.content ?? null;
  }

  /** Test helper: current file content parsed. */
  readJson(filePath: string): Record<string, unknown> | null {
    const raw = this.read(filePath);
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
  }

  /** Test helper: simulate another writer changing the file out from under us. */
  clobber(filePath: string, content: string): void {
    this.files.set(filePath, { content, sha: nextSha() });
  }

  get lastCommit(): RecordedCommit | undefined {
    return this.commits[this.commits.length - 1];
  }
}

/** A minimal in-memory KVNamespace, for the draft store and the write lock. */
export class MemoryKV {
  private readonly store = new Map<string, string>();

  get = async (key: string, _type?: string): Promise<string | null> => this.store.get(key) ?? null;

  put = async (key: string, value: string): Promise<void> => {
    this.store.set(key, value);
  };

  delete = async (key: string): Promise<void> => {
    this.store.delete(key);
  };

  list = async (options?: {
    prefix?: string;
  }): Promise<{
    keys: { name: string }[];
    list_complete: true;
    cacheStatus: null;
  }> => ({
    keys: [...this.store.keys()]
      .filter((key) => options?.prefix === undefined || key.startsWith(options.prefix))
      .map((name) => ({ name })),
    list_complete: true,
    cacheStatus: null,
  });

  get size(): number {
    return this.store.size;
  }
}
