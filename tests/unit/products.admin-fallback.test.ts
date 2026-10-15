import type { KeyValueStore } from '@/lib/runtime/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getDraft,
  listProductSummariesWithRepositoryFallback,
  saveProductState,
} from '@/lib/github/drafts';
import { GitHubContentClient } from '@/lib/github/client';
import {
  PRODUCT_INDEX_KEY,
  listProductSummaries,
  readProductIndex,
  summarize,
  writeProductIndex,
} from '@/lib/products/index-store';
import { catalogueCounts } from '@/lib/products/query';
import { productContentPath } from '@/lib/github/paths';
import { serializeContentJson } from '@/lib/github/serialize';
import { GitHubApiStub, MemoryKV } from '../fixtures/github-api';
import { demoDiningTable, demoDraftChair, demoSofa } from '../fixtures/products';
import type { InteractiveActor } from '@/lib/auth/actor';
import type { Product } from '@/schemas/product';

/**
 * Regression guard for the reported defect: a product is live on the public website, but the
 * admin dashboard says "Add your first product".
 *
 * Root cause: the public site renders committed `data/products/*.json` (content collections),
 * while the admin dashboard and list read the KV `index:products` cache. Nothing reconciles the
 * two at deploy time, so an empty-but-reachable KV index — a recreated namespace, a fresh
 * environment, or a product committed outside this admin's own write pipeline — made the admin
 * report zero products even though the repository (and therefore the public site) had them.
 *
 * The fix is `listProductSummariesWithRepositoryFallback`: read the KV index, and when it is
 * empty, rebuild it from the repository (the source of truth both sides derive from) before
 * concluding the catalogue is empty. These tests pin that behaviour and its boundaries.
 */

const OWNER = { email: 'owner@example.test', role: 'owner', sessionId: 's1' } as InteractiveActor;

let stub: GitHubApiStub;
let client: GitHubContentClient;
let drafts: KeyValueStore;

beforeEach(() => {
  stub = new GitHubApiStub({ files: { 'data/site/redirects.json': '{}\n' } });
  client = new GitHubContentClient({
    token: 'test-token',
    repo: stub.repo,
    branch: stub.branch,
    apiBase: 'https://api.github.com',
    fetchImpl: stub.fetch,
  });
  drafts = new MemoryKV();
});

/** Commit a published product file to the repo WITHOUT touching the KV index — the exact
 *  condition that produced the defect (a product public on the site, absent from the cache). */
async function commitPublishedProductToRepoOnly(product: Product): Promise<void> {
  const path = productContentPath(product.slug);
  if (path === null) throw new Error('unreachable: product slug has no content path');
  await client.writeFile({
    path,
    content: serializeContentJson({ ...product }),
    message: 'seed: committed outside the admin pipeline',
  });
}

describe('admin product list reflects the committed/public catalogue', () => {
  it('rebuilds the empty KV index from the repository instead of reporting "no products"', async () => {
    // A published product exists in the repo (hence on the public site) but the KV index is empty.
    await commitPublishedProductToRepoOnly(demoSofa);
    expect(await listProductSummaries(drafts)).toHaveLength(0);

    const summaries = await listProductSummariesWithRepositoryFallback({ drafts, client });

    // The admin now sees the product that is live on the site.
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.slug).toBe(demoSofa.slug);
    expect(summaries[0]?.status).toBe('PUBLISHED');

    // The dashboard counts agree with the canonical source — not a false empty state.
    const counts = catalogueCounts(summaries);
    expect(counts.total).toBe(1);
    expect(counts.published).toBe(1);

    // The rebuild persisted the cache, so the next read is served from KV.
    const indexAfter = await readProductIndex(drafts);
    expect(Object.keys(indexAfter)).toHaveLength(1);
  });

  it('reconciles a populated index with one cheap slug listing and no per-file reads when complete', async () => {
    // Normal operation: a save populated the index for every repository product.
    await saveProductState({
      drafts,
      client,
      product: demoSofa,
      from: null,
      actor: OWNER,
      action: 'create',
    });
    stub.requests.length = 0;

    const summaries = await listProductSummariesWithRepositoryFallback({ drafts, client });
    expect(summaries).toHaveLength(1);

    // The index is not assumed complete, so exactly one lightweight directory listing is made to
    // check for products committed outside the admin — and nothing more, because nothing is
    // missing. No per-file content GET is issued.
    const listings = stub.requests.filter(
      (r) => r.method === 'GET' && r.path.endsWith('/contents/data/products'),
    );
    const fileReads = stub.requests.filter(
      (r) => r.method === 'GET' && /\/contents\/data\/products\/.+\.json$/.test(r.path),
    );
    expect(listings.length).toBe(1);
    expect(fileReads.length).toBe(0);
  });

  it('pulls in a product committed outside the admin while the index already has others (partial index)', async () => {
    // The index already holds one product (created through the admin)...
    await saveProductState({
      drafts,
      client,
      product: demoSofa,
      from: null,
      actor: OWNER,
      action: 'create',
    });
    // ...and a SECOND product is committed to the repository outside the admin pipeline, so it is
    // public but absent from this non-empty index.
    await commitPublishedProductToRepoOnly(demoDiningTable);

    const summaries = await listProductSummariesWithRepositoryFallback({ drafts, client });

    // Both are now visible; the index was reconciled, not assumed complete.
    const slugs = summaries.map((s) => s.slug).sort();
    expect(slugs).toEqual([demoDiningTable.slug, demoSofa.slug].sort());
    expect(catalogueCounts(summaries).total).toBe(2);

    // The reconciliation persisted, so a second call is served from KV without re-adding.
    const indexAfter = await readProductIndex(drafts);
    expect(Object.keys(indexAfter).sort()).toEqual([demoSofa.id, demoDiningTable.id].sort());
  });

  it('preserves an existing draft/newer admin edit during reconciliation (no overwrite)', async () => {
    // The admin has a draft of demoSofa in the index whose name differs from the repository copy
    // (a newer, unsaved-to-public edit lives in the index row).
    const editedSummary = { ...summarize(demoSofa), name: 'Admin-edited name' };
    await writeProductIndex(drafts, { [demoSofa.id]: editedSummary });
    // The repository's copy of the SAME product carries the old name...
    await commitPublishedProductToRepoOnly(demoSofa);
    // ...and a different product is also committed outside the admin.
    await commitPublishedProductToRepoOnly(demoDiningTable);

    const summaries = await listProductSummariesWithRepositoryFallback({ drafts, client });

    // The missing product was added, but the existing row was NOT overwritten by the repo copy:
    // the admin's newer name survives (reconciliation fills gaps, it never clobbers).
    const sofaRow = summaries.find((s) => s.id === demoSofa.id);
    const tableRow = summaries.find((s) => s.id === demoDiningTable.id);
    expect(sofaRow?.name).toBe('Admin-edited name');
    expect(tableRow?.slug).toBe(demoDiningTable.slug);
    expect(summaries).toHaveLength(2);
  });

  it('restores the KV working copy for a reconciled DRAFT so the editor can read it back', async () => {
    // A DRAFT product committed to the repo, index non-empty but missing it.
    await saveProductState({
      drafts,
      client,
      product: demoSofa,
      from: null,
      actor: OWNER,
      action: 'create',
    });
    await commitPublishedProductToRepoOnly(demoDraftChair); // status DRAFT

    expect(await getDraft(drafts, demoDraftChair.id)).toBeNull();
    await listProductSummariesWithRepositoryFallback({ drafts, client });

    // The reconciliation put back the draft working copy, matching rehydrate's behaviour.
    const restored = await getDraft(drafts, demoDraftChair.id);
    expect(restored?.product.id).toBe(demoDraftChair.id);
    expect(restored?.product.status).toBe('DRAFT');
  });

  it('returns the known index (not an error, not empty) when reconciliation listing fails', async () => {
    // Index is non-empty; a transient repository failure during the reconciliation listing must
    // not blank the working list or throw — the operator keeps seeing what the cache holds.
    await writeProductIndex(drafts, { [demoSofa.id]: summarize(demoSofa) });

    let call = 0;
    const flaky = new GitHubContentClient({
      token: 'test-token',
      repo: stub.repo,
      branch: stub.branch,
      apiBase: 'https://api.github.com',
      fetchImpl: async () => {
        call += 1;
        return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
      },
    });

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const summaries = await listProductSummariesWithRepositoryFallback({ drafts, client: flaky });
    spy.mockRestore();

    expect(call).toBeGreaterThan(0); // it did attempt the listing
    expect(summaries).toHaveLength(1); // and fell back to the known index
    expect(summaries[0]?.id).toBe(demoSofa.id);
  });

  it('reports a genuinely empty repository as a true empty state (no fabrication)', async () => {
    // KV empty AND the repository has no products: this is a real "no products yet".
    const summaries = await listProductSummariesWithRepositoryFallback({ drafts, client });
    expect(summaries).toEqual([]);
    expect(catalogueCounts(summaries).total).toBe(0);
  });

  it('propagates a repository failure instead of returning a false empty list', async () => {
    // KV empty and the repository cannot be listed: the caller must render a configuration
    // error, never "Add your first product". The failure must not be swallowed into [].
    const failing = new GitHubContentClient({
      token: 'test-token',
      repo: stub.repo,
      branch: stub.branch,
      apiBase: 'https://api.github.com',
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: 'boom' }), { status: 500 }),
    });

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      listProductSummariesWithRepositoryFallback({ drafts, client: failing }),
    ).rejects.toThrow();
    spy.mockRestore();
  });

  it('does not duplicate rows when the index is rebuilt over an existing (stale) key', async () => {
    // A rebuild is keyed by product id, so re-running it cannot create a second row for the
    // same product even if a partial/stale index was present.
    await commitPublishedProductToRepoOnly(demoSofa);

    const first = await listProductSummariesWithRepositoryFallback({ drafts, client });
    expect(first).toHaveLength(1);

    // Force the empty-index path again by clearing the cache, then rebuild.
    await writeProductIndex(drafts, {});
    const second = await listProductSummariesWithRepositoryFallback({ drafts, client });
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(demoSofa.id);

    // And the stored index holds exactly one entry under one key.
    const raw = await drafts.get(PRODUCT_INDEX_KEY, 'text');
    const parsed = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
    expect(Object.keys(parsed)).toEqual([demoSofa.id]);
  });
});
