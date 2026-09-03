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

import type { KVNamespace } from '@cloudflare/workers-types';

import { AppError, ERROR_CODES } from '../errors';
import { applyFieldPatch, parseContentJson, serializeContentJson } from './serialize';
import { buildCommitMessage, type CommitScope } from './commit-message';
import { productContentPath } from './paths';
import {
  forgetProduct,
  rememberProduct,
  writeProductIndex,
  productSlugFor,
  summarize,
  type ProductIndex,
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
  drafts: KVNamespace,
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
  drafts: KVNamespace,
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

export async function deleteDraft(drafts: KVNamespace, productId: string): Promise<void> {
  await drafts.delete(draftKey(productId));
}

/**
 * Every draft, for the admin list.
 *
 * KV list pagination is followed to the end; a truncated first page would silently hide
 * drafts from the operator, which is worse than the extra round trips.
 */
export async function listDrafts(drafts: KVNamespace): Promise<DraftRecord[]> {
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
  drafts: KVNamespace;
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
  drafts: KVNamespace;
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
  drafts: KVNamespace;
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
  drafts: KVNamespace;
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
