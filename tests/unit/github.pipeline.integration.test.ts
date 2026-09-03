import type { KVNamespace } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors';
import { GitHubContentClient, withProductLock } from '@/lib/github/client';
import { applyFieldPatch, serializeContentJson } from '@/lib/github/serialize';
import {
  buildCommitMessage,
  commitSubject,
  parseCommitTrailers,
  SKIP_CI_MARKER,
} from '@/lib/github/commit-message';
import { deleteProductState, getDraft, saveProductState } from '@/lib/github/drafts';
import { productContentPath, siteContentPath } from '@/lib/github/paths';
import type { InteractiveActor } from '@/lib/auth/actor';
import type { Product } from '@/schemas/product';

import { GitHubApiStub, MemoryKV } from '../fixtures/github-api';
import { demoSofa } from '../fixtures/products';

/**
 * The write pipeline, against a stubbed GitHub API.
 *
 * The stub reproduces the protocol — blob shas, the `sha` precondition, the 60-column
 * base64 wrapping, the Git Data API sequence — so `GitHubContentClient` runs unmodified.
 * What is under test is therefore the client's real behaviour, not a mock of it.
 *
 * Six things the design commits to and this suite pins down:
 *
 * - the single-file update path,
 * - the atomic multi-file rename,
 * - ` [skip ci]` present on draft commits and absent on publish commits,
 * - the `Actor:` / `Action:` / `Status:` trailer contents,
 * - unknown fields surviving a write,
 * - and the 409 conflict path returning the remote value instead of overwriting.
 *
 * Requirements: 12.13, 17.9, 17.10, 17.11, 17.12, 17.14, 17.15, 17.16, 17.18, 25.12.
 */

const TOKEN = 'github_pat_stub_token_value';
const owner: InteractiveActor = {
  email: 'owner@newgalaxyfurniture.test',
  role: 'owner',
  sessionId: 'sess_owner',
} as unknown as InteractiveActor;
const editor: InteractiveActor = {
  email: 'editor@newgalaxyfurniture.test',
  role: 'editor',
  sessionId: 'sess_editor',
} as unknown as InteractiveActor;

let stub: GitHubApiStub;
let client: GitHubContentClient;
let drafts: KVNamespace;

function makeClient(current: GitHubApiStub): GitHubContentClient {
  return new GitHubContentClient({
    token: TOKEN,
    repo: current.repo,
    branch: current.branch,
    apiBase: 'https://api.github.com',
    fetchImpl: current.fetch,
  });
}

/**
 * Await a promise that must reject with an `AppError`, and hand back the narrowed error.
 *
 * `promise.catch(e => e)` widens to `AppError | T`, and the assertions below want the
 * error's `code`, `message`, and `remote`. Narrowing here keeps each test reading as one
 * claim rather than three lines of type ceremony.
 */
async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(AppError);
    return thrown as AppError;
  }
  throw new Error('expected the operation to reject, but it resolved');
}

/** A publishable product; `demoSofa` is the shared fixture from task 1.3. */
function product(overrides: Partial<Product> = {}): Product {
  return { ...demoSofa, ...overrides };
}

beforeEach(() => {
  stub = new GitHubApiStub();
  client = makeClient(stub);
  drafts = new MemoryKV() as unknown as KVNamespace;
});

describe('single-file update', () => {
  it('creates a file, then updates it with the sha it was read at', async () => {
    const path = productContentPath('luxury-l-shape-sofa')!;

    const created = await client.writeFile({
      path,
      content: serializeContentJson({ slug: 'luxury-l-shape-sofa', name: 'Sofa' }),
      message:
        'content(product): create "Sofa" [NGF-SOF-000001]\n\nActor: a (owner)\nAction: CREATE\n',
    });
    expect(created.commitSha).not.toBe('');
    expect(stub.read(path)).toContain('"name": "Sofa"');

    const read = await client.readJson(path);
    expect(read).not.toBeNull();
    expect(read!.value).toEqual({ slug: 'luxury-l-shape-sofa', name: 'Sofa' });

    await client.writeFile({
      path,
      content: serializeContentJson({ slug: 'luxury-l-shape-sofa', name: 'Sofa Updated' }),
      sha: read!.sha,
      message: 'content(product): update "Sofa Updated"\n\nActor: a (owner)\nAction: UPDATE\n',
    });
    expect(stub.readJson(path)).toEqual({ slug: 'luxury-l-shape-sofa', name: 'Sofa Updated' });
  });

  it('returns null for a missing file rather than throwing', async () => {
    expect(await client.readFile(productContentPath('does-not-exist')!)).toBeNull();
  });

  it('round-trips non-ASCII content through base64', async () => {
    const path = siteContentPath('settings')!;
    const value = { businessName: 'New Galaxy Furniture', tagline: 'सोफ़ा · ₹1,00,000 · café 🛋️' };
    await client.writeFile({
      path,
      content: serializeContentJson(value),
      message: 'm\n\nActor: a (owner)\n',
    });
    // A client that used `btoa` directly would have thrown on the multi-byte characters.
    expect(await client.readJson(path).then((file) => file!.value)).toEqual(value);
  });

  it('refuses a path outside the allowlist before making any request', async () => {
    const before = stub.requests.length;
    await expect(
      client.writeFile({ path: '../package.json', content: '{}', message: 'm' }),
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(client.readFile('src/lib/auth/password.ts')).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    });
    // Nothing reached the network: the allowlist is a precondition, not a response check.
    expect(stub.requests.length).toBe(before);
  });

  it('never returns the token, and always sends it', async () => {
    const path = siteContentPath('rankings')!;
    await client.writeFile({ path, content: '{}\n', message: 'm\n\nActor: a (owner)\n' });
    expect(stub.tokensSeen.length).toBeGreaterThan(0);
    for (const header of stub.tokensSeen) expect(header).toBe(`Bearer ${TOKEN}`);
    // Requirement 25.12: nothing the client hands back mentions the credential.
    const read = await client.readFile(path);
    expect(JSON.stringify(read)).not.toContain(TOKEN);
  });
});

describe('unknown-field preservation', () => {
  it('keeps fields the schema does not recognise across a patch write', async () => {
    const path = productContentPath('legacy-sofa')!;
    // A file authored by a future schema version, or edited by hand.
    const stored = {
      slug: 'legacy-sofa',
      name: 'Legacy Sofa',
      price: 45000,
      legacyId: 'IMP-2019-4471',
      importedFrom: 'old-catalogue.csv',
      'v2:pricing': { tier: 'premium', notes: 'negotiated' },
      notes: ['keep', 'these'],
    };
    stub.clobber(path, serializeContentJson(stored));

    const file = await client.readJson(path);
    const merged = applyFieldPatch(file!.value, { name: 'Legacy Sofa (renamed)', price: 47000 });
    await client.writeFile({
      path,
      content: serializeContentJson(merged),
      sha: file!.sha,
      message:
        'content(product): update "Legacy Sofa (renamed)"\n\nActor: a (owner)\nAction: UPDATE\n',
    });

    const after = stub.readJson(path)!;
    // The patched fields changed…
    expect(after.name).toBe('Legacy Sofa (renamed)');
    expect(after.price).toBe(47000);
    // …and every unrecognised field is still there, values intact.
    expect(after.legacyId).toBe('IMP-2019-4471');
    expect(after.importedFrom).toBe('old-catalogue.csv');
    expect(after['v2:pricing']).toEqual({ tier: 'premium', notes: 'negotiated' });
    expect(after.notes).toEqual(['keep', 'these']);
  });

  it('distinguishes "leave alone" from "set to null" in a patch', async () => {
    const base = { price: 45000, originalPrice: 60000, discount: 25, custom: 'kept' };
    // `undefined` leaves the stored value; explicit `null` clears it. Without that
    // distinction the form could never clear a nullable field.
    expect(applyFieldPatch(base, { price: undefined, originalPrice: null })).toEqual({
      price: 45000,
      originalPrice: null,
      discount: 25,
      custom: 'kept',
    });
  });

  it('serializes deterministically with sorted keys and a trailing newline', async () => {
    const a = serializeContentJson({ b: 1, a: 2, nested: { z: 1, y: 2 } });
    const b = serializeContentJson({ nested: { y: 2, z: 1 }, a: 2, b: 1 });
    // Two writes of the same logical content are byte-identical, so `git diff` shows only
    // real changes.
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    expect(a.indexOf('"a"')).toBeLessThan(a.indexOf('"b"'));
    // Array order is data, not formatting, and must survive.
    expect(serializeContentJson({ order: [3, 1, 2] })).toContain('[\n    3,\n    1,\n    2\n  ]');
  });
});

describe('the 409 conflict path', () => {
  it('refuses a stale write and returns the current remote value', async () => {
    const path = productContentPath('contested-sofa')!;
    stub.clobber(
      path,
      serializeContentJson({ slug: 'contested-sofa', name: 'Original', price: 1000 }),
    );

    // The operator loads the file…
    const loaded = await client.readJson(path);
    expect(loaded).not.toBeNull();

    // …someone else saves it while the form is open…
    stub.clobber(
      path,
      serializeContentJson({
        slug: 'contested-sofa',
        name: 'Changed by someone else',
        price: 2000,
      }),
    );

    // …and the operator's save is refused rather than winning.
    const attempt = client.writeFile({
      path,
      content: serializeContentJson({ slug: 'contested-sofa', name: 'My version', price: 1500 }),
      sha: loaded!.sha,
      message: 'content(product): update "My version"\n\nActor: a (owner)\nAction: UPDATE\n',
    });

    const error = await expectAppError(attempt);
    expect(error.code).toBe('CONFLICT');

    // The remote value comes back so the UI can diff field by field.
    const remote = error.remote as { path: string; sha: string; value: Record<string, unknown> };
    expect(remote.path).toBe(path);
    expect(remote.value.name).toBe('Changed by someone else');
    expect(remote.value.price).toBe(2000);
    expect(remote.sha).not.toBe(loaded!.sha);

    // And no last-writer-wins: the remote is untouched by the refused attempt.
    expect(stub.readJson(path)!.name).toBe('Changed by someone else');
  });

  it('maps a 422 to the same conflict outcome', async () => {
    const path = productContentPath('unprocessable-sofa')!;
    stub.clobber(path, serializeContentJson({ slug: 'unprocessable-sofa', name: 'A' }));
    const loaded = await client.readJson(path);

    stub.forceStatusOnce = 422;
    const attempt = client.writeFile({
      path,
      content: serializeContentJson({ slug: 'unprocessable-sofa', name: 'B' }),
      sha: loaded!.sha,
      message: 'm\n\nActor: a (owner)\n',
    });
    await expect(attempt).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('reports a conflict on a stale delete too', async () => {
    const path = productContentPath('doomed-sofa')!;
    stub.clobber(path, serializeContentJson({ slug: 'doomed-sofa', name: 'A' }));
    const loaded = await client.readJson(path);
    stub.clobber(path, serializeContentJson({ slug: 'doomed-sofa', name: 'B' }));

    await expect(
      client.deleteFile({ path, sha: loaded!.sha, message: 'm\n\nActor: a (owner)\n' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Not deleted — a stale delete is as dangerous as a stale write.
    expect(stub.read(path)).not.toBeNull();
  });

  it('does not echo the upstream error body', async () => {
    const path = productContentPath('server-error-sofa')!;
    stub.forceStatusOnce = 500;
    const attempt = client.writeFile({ path, content: '{}\n', message: 'm\n\nActor: a (owner)\n' });
    const error = await expectAppError(attempt);
    expect(error.code).toBe('REPOSITORY_UNAVAILABLE');
    // Requirement 25.14: a stable code and a display-safe sentence, nothing upstream.
    expect(error.message).not.toContain('forced');
    expect(error.message).not.toContain('500');
    expect(error.message).toContain('retry');
  });
});

describe('atomic multi-file rename', () => {
  it('writes the new file, deletes the old one, and updates redirects in one commit', async () => {
    const oldPath = productContentPath('old-slug-sofa')!;
    const newPath = productContentPath('new-slug-sofa')!;
    const redirects = siteContentPath('redirects')!;
    stub.clobber(oldPath, serializeContentJson({ slug: 'old-slug-sofa', name: 'Sofa' }));
    stub.clobber(redirects, serializeContentJson({}));

    const commitsBefore = stub.commits.length;
    await client.writeTree({
      changes: [
        { path: newPath, content: serializeContentJson({ slug: 'new-slug-sofa', name: 'Sofa' }) },
        { path: oldPath, delete: true },
        {
          path: redirects,
          content: serializeContentJson({ '/product/old-slug-sofa': '/product/new-slug-sofa' }),
        },
      ],
      message: buildCommitMessage({
        scope: 'product',
        action: 'rename',
        subject: { name: 'Sofa', sku: 'NGF-SOF-4F2K9C' },
        actor: owner,
        actionCode: 'RENAME',
        skipCi: false,
      }),
    });

    // One commit, three files — never a half-renamed repository.
    expect(stub.commits.length).toBe(commitsBefore + 1);
    expect(stub.lastCommit!.kind).toBe('tree');
    expect(stub.lastCommit!.paths.sort()).toEqual([newPath, oldPath, redirects].sort());

    expect(stub.read(oldPath)).toBeNull();
    expect(stub.readJson(newPath)!.slug).toBe('new-slug-sofa');
    expect(stub.readJson(redirects)!['/product/old-slug-sofa']).toBe('/product/new-slug-sofa');
  });

  it('refuses the whole tree when any path is outside the allowlist', async () => {
    const filesBefore = new Map(stub.files);
    await expect(
      client.writeTree({
        changes: [
          { path: productContentPath('fine-sofa')!, content: '{}\n' },
          { path: '.github/workflows/ci.yml', content: 'malicious' },
        ],
        message: 'm\n\nActor: a (owner)\n',
      }),
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    // Nothing partially applied: every path is resolved before the first blob is created.
    expect([...stub.files.keys()]).toEqual([...filesBefore.keys()]);
  });
});

describe('commit messages: subject, trailers, and [skip ci]', () => {
  it('renders the design’s exact shape', () => {
    const message = buildCommitMessage({
      scope: 'product',
      action: 'publish',
      subject: { name: 'Luxury L-Shape Sofa', sku: 'NGF-SOF-4F2K9C' },
      actor: { email: 'admin@example.com', role: 'owner' },
      transition: { from: 'REVIEW', to: 'PUBLISHED' },
      skipCi: false,
    });

    expect(message).toBe(
      'content(product): publish "Luxury L-Shape Sofa" [NGF-SOF-4F2K9C]\n' +
        '\n' +
        'Actor: admin@example.com (owner)\n' +
        'Action: PUBLISH\n' +
        'Status: REVIEW -> PUBLISHED\n',
    );
  });

  it('records the actor, the action, and the transition in the trailers', () => {
    const trailers = parseCommitTrailers(
      buildCommitMessage({
        scope: 'product',
        action: 'unpublish',
        subject: { name: 'Sofa', sku: 'NGF-SOF-1' },
        actor: editor,
        transition: { from: 'PUBLISHED', to: 'UNPUBLISHED' },
        actionCode: 'UNPUBLISH',
        skipCi: false,
      }),
    );
    // `git log data/products/` is the audit trail, so all three have to be there.
    expect(trailers.Actor).toBe('editor@newgalaxyfurniture.test (editor)');
    expect(trailers.Action).toBe('UNPUBLISH');
    expect(trailers.Status).toBe('PUBLISHED -> UNPUBLISHED');
  });

  it('folds a hostile product name onto one line and never abbreviates the SKU', () => {
    const message = buildCommitMessage({
      scope: 'product',
      action: 'update',
      subject: {
        name: `Sofa\nActor: attacker@evil.test\n${'x'.repeat(200)}`,
        sku: 'NGF-SOF-4F2K9C',
      },
      actor: owner,
      skipCi: false,
    });
    const lines = message.split('\n');
    // A newline in the name must not be able to forge a trailer.
    expect(parseCommitTrailers(message).Actor).toBe('owner@newgalaxyfurniture.test (owner)');
    expect(lines[0]).toContain('[NGF-SOF-4F2K9C]');
    expect(lines[0]!.includes('\n')).toBe(false);
    expect(lines[1]).toBe('');
  });

  it('appends [skip ci] to draft and review commits', () => {
    for (const action of ['update', 'create'] as const) {
      const subject = commitSubject(
        buildCommitMessage({
          scope: 'product',
          action,
          subject: { name: 'Draft Sofa', sku: 'NGF-SOF-1' },
          actor: owner,
          skipCi: true,
        }),
      );
      expect(subject.endsWith(SKIP_CI_MARKER)).toBe(true);
    }
  });

  it('omits [skip ci] on publish, unpublish and delete commits', () => {
    for (const action of ['publish', 'unpublish', 'delete'] as const) {
      const subject = commitSubject(
        buildCommitMessage({
          scope: 'product',
          action,
          subject: { name: 'Sofa', sku: 'NGF-SOF-1' },
          actor: owner,
          skipCi: false,
        }),
      );
      expect(subject).not.toContain(SKIP_CI_MARKER);
    }
  });
});

describe('the state → repository mapping', () => {
  it('writes both KV and the repo for a draft, with [skip ci] and no deploy', async () => {
    const draft = product({ status: 'DRAFT', published: false, stockStatus: 'IN_STOCK' });
    const result = await saveProductState({
      drafts,
      client,
      product: draft,
      from: null,
      actor: owner,
      action: 'create',
      savedAt: '2026-01-15T09:00:00.000Z',
    });

    expect(result.deployTriggered).toBe(false);
    expect(result.draftRetained).toBe(true);
    // Repo copy exists, so the draft has version history.
    expect(stub.readJson(productContentPath(draft.slug)!)!.status).toBe('DRAFT');
    // KV copy exists, so preview is instant.
    expect((await getDraft(drafts, draft.id))?.product.status).toBe('DRAFT');
    expect(commitSubject(stub.lastCommit!.message)).toContain(SKIP_CI_MARKER);
  });

  it('writes the repo, deletes the KV draft, and triggers a deploy on publish', async () => {
    const draft = product({ status: 'DRAFT', published: false, stockStatus: 'IN_STOCK' });
    await saveProductState({
      drafts,
      client,
      product: draft,
      from: null,
      actor: owner,
      action: 'create',
      savedAt: '2026-01-15T09:00:00.000Z',
    });
    expect(await getDraft(drafts, draft.id)).not.toBeNull();

    const published = product({ ...draft, status: 'PUBLISHED', published: true });
    const result = await saveProductState({
      drafts,
      client,
      product: published,
      from: 'DRAFT',
      actor: owner,
      action: 'publish',
      savedAt: '2026-01-15T09:05:00.000Z',
    });

    expect(result.deployTriggered).toBe(true);
    expect(result.draftRetained).toBe(false);
    // The working copy is gone: the repository is now the only place this lives.
    expect(await getDraft(drafts, draft.id)).toBeNull();
    expect(stub.readJson(productContentPath(published.slug)!)!.status).toBe('PUBLISHED');

    const message = stub.lastCommit!.message;
    expect(commitSubject(message)).not.toContain(SKIP_CI_MARKER);
    expect(parseCommitTrailers(message).Status).toBe('DRAFT -> PUBLISHED');
    expect(parseCommitTrailers(message).Action).toBe('PUBLISH');
  });

  it('triggers a deploy when a published product returns to draft', async () => {
    // The state table lists DRAFT as "no build", which is right for a draft that was
    // never public and wrong for one that was — the live page has to come down.
    const published = product({ status: 'PUBLISHED', published: true, stockStatus: 'IN_STOCK' });
    const result = await saveProductState({
      drafts,
      client,
      product: product({ ...published, status: 'DRAFT', published: false }),
      from: 'PUBLISHED',
      actor: owner,
      action: 'update',
      savedAt: '2026-01-15T09:00:00.000Z',
    });
    expect(result.deployTriggered).toBe(true);
    expect(commitSubject(stub.lastCommit!.message)).not.toContain(SKIP_CI_MARKER);
  });

  it('preserves unknown fields through a lifecycle save', async () => {
    const draft = product({ status: 'DRAFT', published: false, stockStatus: 'IN_STOCK' });
    const path = productContentPath(draft.slug)!;
    stub.clobber(
      path,
      serializeContentJson({
        ...draft,
        status: 'DRAFT',
        published: false,
        legacyId: 'IMP-1',
        odd: [1, 2],
      }),
    );

    await saveProductState({
      drafts,
      client,
      product: draft,
      from: 'DRAFT',
      actor: owner,
      action: 'update',
      savedAt: '2026-01-15T09:00:00.000Z',
    });

    const after = stub.readJson(path)!;
    expect(after.legacyId).toBe('IMP-1');
    expect(after.odd).toEqual([1, 2]);
  });

  it('removes the file and the draft on delete, and always rebuilds', async () => {
    const draft = product({ status: 'DRAFT', published: false, stockStatus: 'IN_STOCK' });
    await saveProductState({
      drafts,
      client,
      product: draft,
      from: null,
      actor: owner,
      action: 'create',
      savedAt: '2026-01-15T09:00:00.000Z',
    });

    const result = await deleteProductState({ drafts, client, product: draft, actor: owner });

    expect(result.deployTriggered).toBe(true);
    expect(stub.read(productContentPath(draft.slug)!)).toBeNull();
    expect(await getDraft(drafts, draft.id)).toBeNull();
    expect(stub.lastCommit!.kind).toBe('contents-delete');
    expect(parseCommitTrailers(stub.lastCommit!.message).Action).toBe('DELETE');
  });

  it('never writes outside data/', async () => {
    const draft = product({ status: 'DRAFT', published: false, stockStatus: 'IN_STOCK' });
    await saveProductState({
      drafts,
      client,
      product: draft,
      from: null,
      actor: owner,
      action: 'create',
      savedAt: '2026-01-15T09:00:00.000Z',
    });
    // Requirement 17.13, observed rather than asserted about the allowlist: every path the
    // pipeline actually touched is under data/.
    for (const commit of stub.commits) {
      for (const path of commit.paths) expect(path.startsWith('data/')).toBe(true);
    }
    for (const path of stub.files.keys()) expect(path.startsWith('data/')).toBe(true);
  });
});

describe('the product write lock', () => {
  it('serializes a second concurrent save into a retryable conflict', async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    let released = false;

    const first = withProductLock(
      kv,
      'p_0000000001',
      async () => {
        // While the first save holds the lock, the second must not proceed.
        await expect(
          withProductLock(kv, 'p_0000000001', async () => 'second', now),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        released = true;
        return 'first';
      },
      now,
    );

    expect(await first).toBe('first');
    expect(released).toBe(true);
    // Released afterwards, so a legitimate retry succeeds.
    expect(await withProductLock(kv, 'p_0000000001', async () => 'later', now)).toBe('later');
  });

  it('does not block a different product', async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    await withProductLock(
      kv,
      'p_0000000001',
      async () => {
        expect(await withProductLock(kv, 'p_0000000002', async () => 'ok', now)).toBe('ok');
      },
      now,
    );
  });

  it('lets an expired lock be taken over', async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    // A Worker that died mid-save must not wedge the product forever.
    await withProductLock(kv, 'p_0000000003', async () => 'first', now);
    expect(await withProductLock(kv, 'p_0000000003', async () => 'second', now + 60_000)).toBe(
      'second',
    );
  });

  it('releases the lock even when the operation throws', async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    await expect(
      withProductLock(kv, 'p_0000000004', () => Promise.reject(new Error('write failed')), now),
    ).rejects.toThrow('write failed');
    // A failed GitHub call must leave the product retryable immediately.
    expect(await withProductLock(kv, 'p_0000000004', async () => 'retry', now)).toBe('retry');
  });
});
