/**
 * The KV draft store and the state → repository mapping.
 *
 * Draft state is written to **both** KV and the repository, which looks redundant until
 * you name what each one buys:
 *
 * - **KV** gives instant preview and a fast admin list. `/admin/preview/:id` must show
 *   the saved values within a second of the save (Requirement 12.4), and a GitHub API
 *   round trip per row of the product list would make the list unusable.
 * - **The repository** gives drafts version history, which is what makes "review the diff
 *   before approving" possible at all.
 *
 * KV is a cache and working copy and is **never** the source of truth. `POST
 * /api/admin/rehydrate` rebuilds it from the repository, and the fact that it can be
 * rebuilt from scratch is what keeps that claim honest.
 *
 * | State | Data lives | Commit | Build |
 * |---|---|---|---|
 * | `DRAFT` / `REVIEW` | KV + repo | yes, `[skip ci]` | no |
 * | `PUBLISHED` / `OUT_OF_STOCK` / `UNPUBLISHED` | repo, KV draft deleted | yes | yes |
 * | deleted | repo file removed, KV draft removed | yes | yes |
 *
 * Design: Write Pipeline → State → repository mapping.
 * Requirements: 12.4, 14.9, 17.9, 17.14, 17.15.
 */

import type { KeyValueStore } from '@/lib/runtime/types';

import { AppError, ERROR_CODES } from '../errors';
import { applyFieldPatch, parseContentJson, serializeContentJson } from './serialize';
import { buildCommitMessage, type CommitScope } from './commit-message';
import { productContentPath } from './paths';
import {
  forgetProduct,
  listProductSummaries,
  readProductIndex,
  rememberProduct,
  writeProductIndex,
  productSlugFor,
  summarize,
  type ProductIndex,
  type ProductSummary,
} from '../products/index-store';
import { ProductSchema, type Product, type ProductStatusValue } from '@/schemas/product';
import { shouldSkipCi, transitionAction } from '../products/transitions';
import type { GitHubContentClient } from './client';
import type { InteractiveActor } from '../auth/actor';

const DRAFT_PREFIX = 'draft:';

export interface DraftRecord {
  product: Product;
  savedAt: string;
}

function draftKey(productId: string): string {
  return `${DRAFT_PREFIX}${productId}`;
}

/* -------------------------------------------------------------------------- */
/* Draft CRUD                                                                 */
/* -------------------------------------------------------------------------- */

export async function putDraft(
  drafts: KeyValueStore,
  product: Product,
  savedAt: string = new Date().toISOString(),
): Promise<void> {
  // No `expirationTtl`: a draft is working state and must not evaporate because the
  // operator went to lunch. It is removed explicitly when the product goes public or is
  // deleted.
  await drafts.put(
    draftKey(product.id),
    JSON.stringify({ product, savedAt } satisfies DraftRecord),
  );
}

/**
 * Read a draft, validating it on the way out.
 *
 * A draft that no longer parses (schema tightened since it was saved, or the record was
 * corrupted) is treated as absent rather than returned unvalidated: the repository copy
 * is the source of truth and is still there.
 */
export async function getDraft(
  drafts: KeyValueStore,
  productId: string,
): Promise<DraftRecord | null> {
  const raw = await drafts.get(draftKey(productId), 'text');
  if (raw === null) return null;
  const parsed = parseContentJson(raw) as { product?: unknown; savedAt?: unknown } | null;
  if (parsed === null) return null;
  const product = ProductSchema.safeParse(parsed.product);
  if (!product.success) return null;
  return {
    product: product.data,
    savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date(0).toISOString(),
  };
}

export async function deleteDraft(drafts: KeyValueStore, productId: string): Promise<void> {
  await drafts.delete(draftKey(productId));
}

/**
 * Every draft, for the admin list.
 *
 * KV list pagination is followed to the end; a truncated first page would silently hide
 * drafts from the operator, which is worse than the extra round trips.
 */
export async function listDrafts(drafts: KeyValueStore): Promise<DraftRecord[]> {
  const records: DraftRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await drafts.list({
      prefix: DRAFT_PREFIX,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const key of page.keys) {
      const record = await getDraft(drafts, key.name.slice(DRAFT_PREFIX.length));
      if (record !== null) records.push(record);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
  return records;
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

export interface ProductSource {
  product: Product;
  source: 'draft' | 'repo';
}

export interface ResolveDeps {
  drafts: KeyValueStore;
  client: GitHubContentClient;
}

/**
 * Resolve a product by id, draft first.
 *
 * Draft-first is what makes preview reflect unsaved-to-public work; the repository copy
 * of a `DRAFT` exists for history, not for reading back. `slugHint` short-circuits the
 * index lookup when the caller already knows the slug (the list view does).
 */
export async function resolveProduct(
  deps: ResolveDeps,
  productId: string,
  slugHint?: string,
): Promise<ProductSource | null> {
  const draft = await getDraft(deps.drafts, productId);
  if (draft !== null) return { product: draft.product, source: 'draft' };

  const slug = slugHint ?? (await productSlugFor(deps.drafts, productId));
  if (slug === undefined) return null;

  const path = productContentPath(slug);
  if (path === null) return null;
  const file = await deps.client.readJson(path);
  if (file === null) return null;

  const parsed = ProductSchema.safeParse(file.value);
  if (!parsed.success) {
    console.error('[drafts] stored product failed schema validation');
    throw new AppError(ERROR_CODES.REPOSITORY_UNAVAILABLE, {
      message:
        'The stored product file does not match the current schema. Fix it in the repository and retry.',
    });
  }
  return { product: parsed.data, source: 'repo' };
}

/* -------------------------------------------------------------------------- */
/* The state → repository mapping                                             */
/* -------------------------------------------------------------------------- */

export interface SaveProductInput {
  drafts: KeyValueStore;
  client: GitHubContentClient;
  /** The product as it should be stored. */
  product: Product;
  /** The status it is moving from, or null on create. Decides `[skip ci]`. */
  from: ProductStatusValue | null;
  actor: InteractiveActor;
  /** Subject verb: `create`, `update`, `publish`, `unpublish`, … */
  action: string;
  scope?: CommitScope;
  savedAt?: string;
}

export interface SaveProductResult {
  path: string;
  commitSha: string;
  /** True when the commit will cause a rebuild — i.e. `[skip ci]` was not appended. */
  deployTriggered: boolean;
  /** True when a KV working copy is being kept for preview. */
  draftRetained: boolean;
}

/**
 * Persist a product according to its lifecycle state.
 *
 * Order matters and is not incidental: **KV first for draft states, repository always,
 * KV cleanup last.** Writing KV before the commit means the preview is live within a
 * second even if the GitHub call is slow (Requirement 12.4), and if the commit fails the
 * operator's work is already safe in KV — which is exactly what the "your changes are
 * kept locally — retry" recovery promises. Deleting the draft *after* a successful
 * publish means a failed publish leaves the working copy intact rather than destroying it.
 */
export async function saveProductState(input: SaveProductInput): Promise<SaveProductResult> {
  const { drafts, client, product, from, actor } = input;
  const savedAt = input.savedAt ?? new Date().toISOString();

  const path = productContentPath(product.slug);
  if (path === null) throw new AppError(ERROR_CODES.PATH_NOT_ALLOWED);

  const isDraftState = product.status === 'DRAFT' || product.status === 'REVIEW';
  const skipCi = shouldSkipCi(from, product.status);

  // 1. Working copy first, for draft states.
  if (isDraftState) await putDraft(drafts, product, savedAt);

  // 2. The repository, always — drafts get history too.
  const existing = await client.readJson(path);
  // Merge over the stored bytes so fields no schema knows about survive the write. The
  // product is the patch, not the whole document: keys it does not carry — including keys
  // no schema declares — are copied through from the stored file.
  const merged = applyFieldPatch(existing?.value ?? {}, { ...product });
  const message = buildCommitMessage({
    scope: input.scope ?? 'product',
    action: input.action,
    subject: { name: product.name, sku: product.sku },
    actor,
    ...(from === null
      ? {}
      : {
          transition: { from, to: product.status },
          actionCode: transitionAction(from, product.status),
        }),
    skipCi,
  });

  const result = await client.writeFile({
    path,
    content: serializeContentJson(merged),
    ...(existing === null ? {} : { sha: existing.sha }),
    message,
  });

  // 3. Cleanup, only after the commit succeeded. The index entry therefore implies a
  // commit landed, which is what lets the admin list be read from KV alone.
  await rememberProduct(drafts, product);
  if (!isDraftState) await deleteDraft(drafts, product.id);

  return {
    path,
    commitSha: result.commitSha,
    deployTriggered: !skipCi,
    draftRetained: isDraftState,
  };
}

/**
 * Remove a product: repository file gone, KV draft gone, build triggered.
 *
 * A deletion always rebuilds — Requirement 14.9 requires the detail page, catalogue
 * entry, search entry, and sitemap entry to disappear after the next deploy, and none of
 * that happens without one.
 */
export async function deleteProductState(input: {
  drafts: KeyValueStore;
  client: GitHubContentClient;
  product: Product;
  actor: InteractiveActor;
}): Promise<SaveProductResult> {
  const path = productContentPath(input.product.slug);
  if (path === null) throw new AppError(ERROR_CODES.PATH_NOT_ALLOWED);

  const existing = await input.client.readJson(path);
  const message = buildCommitMessage({
    scope: 'product',
    action: 'delete',
    subject: { name: input.product.name, sku: input.product.sku },
    actor: input.actor,
    actionCode: 'DELETE',
    // Never skipped: the live page has to come down.
    skipCi: false,
  });

  let commitSha = '';
  if (existing !== null) {
    const result = await input.client.deleteFile({ path, sha: existing.sha, message });
    commitSha = result.commitSha;
  }

  await deleteDraft(input.drafts, input.product.id);
  await forgetProduct(input.drafts, input.product.id);

  return { path, commitSha, deployTriggered: true, draftRetained: false };
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                */
/* -------------------------------------------------------------------------- */

export interface RehydrateResult {
  indexed: number;
  draftsRestored: number;
  skipped: string[];
}

/**
 * Rebuild KV from the repository.
 *
 * This is the operation that makes "KV is never the source of truth" a fact rather than
 * an intention: the entire KV working set can be discarded and reconstructed from
 * `data/products/`. Files that fail validation are reported by path rather than aborting
 * the run — one hand-edited file must not block recovery of the rest.
 */
export async function rehydrateFromRepository(deps: {
  drafts: KeyValueStore;
  client: GitHubContentClient;
  /** Slugs to rebuild from, from a directory listing. */
  slugs: readonly string[];
}): Promise<RehydrateResult> {
  const index: ProductIndex = {};
  const skipped: string[] = [];
  let draftsRestored = 0;

  for (const slug of deps.slugs) {
    const path = productContentPath(slug);
    if (path === null) {
      skipped.push(slug);
      continue;
    }
    let file: Awaited<ReturnType<GitHubContentClient['readJson']>>;
    try {
      file = await deps.client.readJson(path);
    } catch {
      skipped.push(slug);
      continue;
    }
    if (file === null) {
      skipped.push(slug);
      continue;
    }
    const parsed = ProductSchema.safeParse(file.value);
    if (!parsed.success) {
      skipped.push(slug);
      continue;
    }
    index[parsed.data.id] = summarize(parsed.data);
    if (parsed.data.status === 'DRAFT' || parsed.data.status === 'REVIEW') {
      await putDraft(deps.drafts, parsed.data);
      draftsRestored += 1;
    } else {
      await deleteDraft(deps.drafts, parsed.data.id);
    }
  }

  await writeProductIndex(deps.drafts, index);
  return { indexed: Object.keys(index).length, draftsRestored, skipped };
}

/* -------------------------------------------------------------------------- */
/* Reading the admin list with a repository fallback                          */
/* -------------------------------------------------------------------------- */

/**
 * The product summaries the admin dashboard and list render — with a self-healing read.
 *
 * The admin reads the KV `index:products` cache; the public site renders committed
 * `data/products/*.json`. Those are two stores, and nothing reconciles them at deploy
 * time. Two divergences follow, and this function closes both while keeping the documented
 * architecture — the repository is the source of truth, KV is a rebuildable cache:
 *
 *  1. **Empty index.** A recreated namespace, a fresh preview, or products committed outside
 *     this admin's own `saveProductState` left the index empty, so the admin showed "Add your
 *     first product" while the product was live on the public site. When the index is empty we
 *     rebuild it fully from the repository.
 *
 *  2. **Partial index.** A non-empty index is NOT assumed complete. A product committed to the
 *     repository through any path other than this admin — a hand commit, a second environment,
 *     a different operator's deploy — is public yet absent from this index. So the repository's
 *     product slugs are listed (one cheap directory call, not a read per row) and any slug the
 *     index does not already cover is pulled in. Slugs already represented are left untouched,
 *     which is what protects editable drafts and newer admin edits: this only *adds* the
 *     missing published records, it never re-reads, re-writes, or overwrites a row the index
 *     already holds, and the index is keyed by product id so a reconciled row cannot duplicate
 *     an existing one.
 *
 * **Cost.** The normal path is one KV read plus one lightweight slug listing; per-file GitHub
 * reads happen only for slugs that are actually missing (usually none). The reconciliation is
 * skipped entirely when it is not safe or not worth it — see the failure handling below.
 *
 * **Failure handling, which differs by case on purpose:**
 *  - Index EMPTY and the repository cannot be read: the error PROPAGATES. There is nothing to
 *    show and we must not claim "no products"; the caller renders "this environment is not
 *    configured". A genuinely empty repository rebuilds to an empty index — a true empty state.
 *  - Index NON-EMPTY and the reconciliation listing fails: the error is SWALLOWED and the index
 *    we already have is returned. A transient GitHub hiccup must not blank a working list; the
 *    worst case is one just-added product missing until the next load or a manual rehydrate.
 */
export async function listProductSummariesWithRepositoryFallback(deps: {
  drafts: KeyValueStore;
  client: GitHubContentClient;
}): Promise<ProductSummary[]> {
  const index = await readProductIndex(deps.drafts);
  const existing = Object.values(index);

  if (existing.length === 0) {
    // The cache is empty. Rebuild it fully from the repository before concluding the catalogue
    // is empty. A repository failure here propagates — see the header.
    const slugs = await deps.client.listProductSlugs();
    if (slugs.length === 0) return [];
    await rehydrateFromRepository({ drafts: deps.drafts, client: deps.client, slugs });
    return await listProductSummaries(deps.drafts);
  }

  // The cache is non-empty but not assumed complete. Reconcile only the repository slugs the
  // index does not already cover, best-effort: a listing failure returns what we have.
  try {
    const repoSlugs = await deps.client.listProductSlugs();
    const known = new Set(existing.map((summary) => summary.slug));
    const missing = repoSlugs.filter((slug) => !known.has(slug));
    if (missing.length === 0) return existing;

    const reconciled = await reconcileMissingProducts({
      drafts: deps.drafts,
      client: deps.client,
      index,
      missingSlugs: missing,
    });
    return Object.values(reconciled);
  } catch (error) {
    // Best-effort only. The index is a working list; a transient repository error must not
    // turn it into a false empty or an error page.
    console.error('[drafts] reconciliation against the repository was skipped', error);
    return existing;
  }
}

/**
 * Add the repository products the index is missing, without disturbing the rows it already has.
 *
 * Only the `missingSlugs` are read from the repository. Each parsed product is added to the
 * index under its id, and — exactly as `rehydrateFromRepository` does for a full rebuild — a
 * `DRAFT`/`REVIEW` product also gets its KV working copy restored so the editor and preview can
 * read it back. A row already present for that id is NOT re-read or overwritten: reconciliation
 * never clobbers a draft or a newer admin edit, it only fills gaps. A file that 404s or fails
 * schema validation is skipped, never allowed to abort the others.
 */
async function reconcileMissingProducts(deps: {
  drafts: KeyValueStore;
  client: GitHubContentClient;
  index: ProductIndex;
  missingSlugs: readonly string[];
}): Promise<ProductIndex> {
  const index: ProductIndex = { ...deps.index };
  const knownIds = new Set(Object.keys(index));

  for (const slug of deps.missingSlugs) {
    const path = productContentPath(slug);
    if (path === null) continue;
    let file: Awaited<ReturnType<GitHubContentClient['readJson']>>;
    try {
      file = await deps.client.readJson(path);
    } catch {
      continue;
    }
    if (file === null) continue;
    const parsed = ProductSchema.safeParse(file.value);
    if (!parsed.success) continue;

    // Guard against the race where the id (not just the slug) is already present — never
    // overwrite an existing row, which could be a newer admin edit or a draft.
    if (knownIds.has(parsed.data.id)) continue;

    index[parsed.data.id] = summarize(parsed.data);
    knownIds.add(parsed.data.id);
    if (parsed.data.status === 'DRAFT' || parsed.data.status === 'REVIEW') {
      await putDraft(deps.drafts, parsed.data);
    }
  }

  await writeProductIndex(deps.drafts, index);
  return index;
}
