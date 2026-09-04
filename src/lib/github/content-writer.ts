/**
 * The write path for content that is not a product: categories, reviews, and the two
 * `data/site/*.json` configuration files.
 *
 * Products have `saveProductState`, which additionally maintains the KV draft and the KV
 * index. Nothing else needs either — a category is not previewed and a review has no
 * working copy — so rather than widen the product pipeline, this module carries the three
 * behaviours those records *do* share with it, and carries them once:
 *
 * 1. **The path is derived server-side and re-validated.** Callers pass a
 *    `resolveContentPath`-derived path; `GitHubContentClient` refuses anything the
 *    allowlist does not admit, so there is no second, weaker write route to the repository
 *    (Requirements 17.3, 17.4).
 * 2. **Unknown fields survive.** Every write reads the stored bytes, applies the patch on
 *    top with `applyFieldPatch`, and re-serializes. A key no schema declares is copied
 *    through rather than dropped (Requirement 17.9).
 * 3. **Optimistic concurrency, never last-writer-wins.** The blob `sha` read alongside the
 *    content is sent with the write, so a file that moved underneath the operator comes
 *    back as `CONFLICT` carrying the current remote value (Requirements 17.10, 17.11).
 *
 * `skipCi` is the caller's decision because only the caller knows whether the change alters
 * what a visitor sees. A `DRAFT` review does not (Requirement 17.14); a category, a setting,
 * or a published review does (Requirement 17.15).
 *
 * Design: Write Pipeline → Principles, Commit strategy, Conflict handling.
 * Requirements: 17.3, 17.4, 17.7, 17.9, 17.10, 17.11, 17.12, 17.14, 17.15, 17.16.
 */

import type { z } from 'zod';

import { AppError, ERROR_CODES } from '../errors';
import { applyFieldPatch, serializeContentJson } from './serialize';
import { buildCommitMessage, type CommitScope } from './commit-message';
import type { GitHubContentClient, TreeChange } from './client';
import type { InteractiveActor } from '../auth/actor';

export interface ContentRecordRef<T> {
  /** An allowlisted `data/**` path, derived from a stored identifier. */
  path: string;
  value: T;
  /** The blob sha the value was read at; absent when the file does not exist yet. */
  sha?: string;
}

/**
 * Read and validate one content file.
 *
 * A file that exists but no longer satisfies its schema is an error rather than a `null`:
 * silently treating it as absent would let the next write create a fresh file and lose the
 * operator's data. The message says what to do — fix it in the repository.
 */
export async function readContentRecord<S extends z.ZodType>(
  client: GitHubContentClient,
  path: string,
  schema: S,
): Promise<ContentRecordRef<z.output<S>> | null> {
  const file = await client.readJson(path);
  if (file === null) return null;
  const parsed = schema.safeParse(file.value);
  if (!parsed.success) {
    console.error(`[content] stored file failed validation: ${path}`);
    throw new AppError(ERROR_CODES.REPOSITORY_UNAVAILABLE, {
      message:
        'The stored file does not match the current schema. It may have been edited by hand — fix it in the repository and retry.',
    });
  }
  return {
    path,
    value: parsed.data,
    sha: file.sha,
  };
}

export interface WriteContentInput {
  client: GitHubContentClient;
  path: string;
  /** The complete record to store. Merged over the stored bytes, never replacing them. */
  record: Record<string, unknown>;
  scope: CommitScope;
  /** Lowercase subject verb: `create`, `update`, `publish`, `reorder`, … */
  action: string;
  subject: { name: string; sku?: string };
  actor: InteractiveActor;
  /** `true` when the change cannot alter a public surface. */
  skipCi: boolean;
  /**
   * The sha the record was read at. Omitted for a create, which then uses
   * create-if-absent semantics: GitHub refuses a `PUT` without a sha over an existing
   * file, so a create can never silently overwrite.
   */
  sha?: string;
}

export interface WriteContentResult {
  path: string;
  commitSha: string;
  deployTriggered: boolean;
}

export async function writeContentRecord(input: WriteContentInput): Promise<WriteContentResult> {
  const existing = input.sha === undefined ? null : await input.client.readJson(input.path);
  const merged = applyFieldPatch(existing?.value ?? {}, input.record);

  const result = await input.client.writeFile({
    path: input.path,
    content: serializeContentJson(merged),
    ...(input.sha === undefined ? {} : { sha: input.sha }),
    message: buildCommitMessage({
      scope: input.scope,
      action: input.action,
      subject: input.subject,
      actor: input.actor,
      skipCi: input.skipCi,
    }),
  });

  return { path: result.path, commitSha: result.commitSha, deployTriggered: !input.skipCi };
}

export async function deleteContentRecord(input: {
  client: GitHubContentClient;
  path: string;
  sha: string;
  scope: CommitScope;
  subject: { name: string };
  actor: InteractiveActor;
}): Promise<WriteContentResult> {
  const result = await input.client.deleteFile({
    path: input.path,
    sha: input.sha,
    message: buildCommitMessage({
      scope: input.scope,
      action: 'delete',
      subject: input.subject,
      actor: input.actor,
      actionCode: 'DELETE',
      // A deletion always rebuilds: the entry has to come off the site.
      skipCi: false,
    }),
  });
  return { path: result.path, commitSha: result.commitSha, deployTriggered: true };
}

/**
 * Write several content files as one commit.
 *
 * Reordering is the reason this exists. A reorder changes `order` on two or more records,
 * and any prefix of that applied on its own is a repository whose ordering is
 * self-contradictory — two categories claiming position 3, or a gap where one was.
 * Requirement 17.16 asks for one commit; the Git Data API gives it (see
 * `GitHubContentClient.writeTree`).
 */
export async function writeContentRecords(input: {
  client: GitHubContentClient;
  records: readonly { path: string; record: Record<string, unknown> }[];
  scope: CommitScope;
  action: string;
  subject: { name: string };
  actor: InteractiveActor;
  skipCi: boolean;
}): Promise<WriteContentResult> {
  if (input.records.length === 0) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, { message: 'Nothing to commit.' });
  }

  const changes: TreeChange[] = [];
  for (const entry of input.records) {
    // Each file is merged over its own stored bytes, so a reorder touches `order` and
    // nothing else — including fields no schema knows about.
    const stored = await input.client.readJson(entry.path);
    const merged = applyFieldPatch(stored?.value ?? {}, entry.record);
    changes.push({ path: entry.path, content: serializeContentJson(merged) });
  }

  const result = await input.client.writeTree({
    changes,
    message: buildCommitMessage({
      scope: input.scope,
      action: input.action,
      subject: input.subject,
      actor: input.actor,
      skipCi: input.skipCi,
    }),
  });

  return { path: result.path, commitSha: result.commitSha, deployTriggered: !input.skipCi };
}
