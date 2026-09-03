/**
 * Slug rename as one atomic commit.
 *
 * A rename is three file changes that are only correct together: write
 * `data/products/{new}.json`, delete `data/products/{old}.json`, and add
 * `/product/{old} → /product/{new}` to `data/site/redirects.json`. Any prefix of that
 * applied on its own is a broken site — two products claiming one identity, or a live URL
 * with nothing behind it and no redirect. So it goes through the Git Data API as a single
 * commit (Requirement 17.16) rather than as three Contents API calls.
 *
 * Two details that are easy to get wrong and are handled here:
 *
 * - **Redirect chains are collapsed.** If `a → b` already exists and `b` is now renamed to
 *   `c`, the stored map is rewritten so `a → c` and `b → c`. Left alone it would be
 *   `a → b → c`, which costs the visitor a second round trip and, after enough renames,
 *   trips the browser's redirect limit.
 * - **A self-redirect is never written.** A rename that lands back on a slug that already
 *   redirects elsewhere removes that stale entry instead of pointing a URL at itself.
 *
 * The build turns each map entry into a 301 (Requirement 12.11).
 *
 * Design: Write Pipeline → Commit strategy.
 * Requirements: 12.11, 12.12, 17.16.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import { AppError, ERROR_CODES } from '../errors';
import { applyFieldPatch, serializeContentJson } from './serialize';
import { buildCommitMessage } from './commit-message';
import { deleteDraft, putDraft } from './drafts';
import { productContentPath, siteContentPath } from './paths';
import { rememberProduct } from '../products/index-store';
import { shouldSkipCi } from '../products/transitions';
import type { GitHubContentClient, TreeChange } from './client';
import type { InteractiveActor } from '../auth/actor';
import type { Product } from '@/schemas/product';

/** `/product/{slug}` — the one place the public product URL shape is written. */
export function productUrlPath(slug: string): string {
  return `/product/${slug}`;
}

export interface RenameProductInput {
  drafts: KVNamespace;
  client: GitHubContentClient;
  /** The product as stored, before the rename. */
  current: Product;
  /** The product as it should be stored, carrying the new slug. */
  next: Product;
  actor: InteractiveActor;
  savedAt?: string;
}

export interface RenameProductResult {
  commitSha: string;
  fromSlug: string;
  toSlug: string;
  redirect: { from: string; to: string };
  deployTriggered: boolean;
}

/** Merge one rename into the stored redirect map, collapsing chains. */
export function withRenameRedirect(
  stored: unknown,
  fromSlug: string,
  toSlug: string,
): Record<string, string> {
  const from = productUrlPath(fromSlug);
  const to = productUrlPath(toSlug);
  const merged: Record<string, string> = {};

  if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      // Anything that pointed at the old address now points at the new one.
      merged[key] = value === from ? to : value;
    }
  }
  merged[from] = to;
  // The destination must not redirect: a URL that both serves a page and redirects is
  // ambiguous, and after a round-trip rename (a → b → a) that is exactly what would
  // otherwise be left behind.
  delete merged[to];
  for (const [key, value] of Object.entries(merged)) {
    if (key === value) delete merged[key];
  }
  return merged;
}

export async function renameProductState(input: RenameProductInput): Promise<RenameProductResult> {
  const { client, current, next } = input;
  const savedAt = input.savedAt ?? new Date().toISOString();

  const oldPath = productContentPath(current.slug);
  const newPath = productContentPath(next.slug);
  const redirectsPath = siteContentPath('redirects');
  if (oldPath === null || newPath === null || redirectsPath === null) {
    throw new AppError(ERROR_CODES.PATH_NOT_ALLOWED);
  }
  if (oldPath === newPath) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, { message: 'Nothing to rename.' });
  }

  // Merge over the stored bytes so unknown fields survive the move (Requirement 17.9).
  const existing = await client.readJson(oldPath);
  const merged = applyFieldPatch(existing?.value ?? {}, { ...next });

  const storedRedirects = await client.readJson(redirectsPath);
  const redirects = withRenameRedirect(storedRedirects?.value ?? {}, current.slug, next.slug);

  const skipCi = shouldSkipCi(current.status, next.status);
  const message = buildCommitMessage({
    scope: 'product',
    action: 'rename',
    subject: { name: next.name, sku: next.sku },
    actor: input.actor,
    actionCode: 'RENAME',
    // A rename of a public product must rebuild: the old URL has to start redirecting and
    // the new one has to start serving. A draft rename changes no live URL.
    skipCi,
  });

  const changes: TreeChange[] = [
    { path: newPath, content: serializeContentJson(merged) },
    { path: oldPath, delete: true },
    { path: redirectsPath, content: serializeContentJson(redirects) },
  ];

  const result = await client.writeTree({ changes, message });

  const isDraftState = next.status === 'DRAFT' || next.status === 'REVIEW';
  if (isDraftState) await putDraft(input.drafts, next, savedAt);
  else await deleteDraft(input.drafts, next.id);
  await rememberProduct(input.drafts, next);

  return {
    commitSha: result.commitSha,
    fromSlug: current.slug,
    toSlug: next.slug,
    redirect: { from: productUrlPath(current.slug), to: productUrlPath(next.slug) },
    deployTriggered: !skipCi,
  };
}
