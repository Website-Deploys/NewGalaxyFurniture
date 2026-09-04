/**
 * Structured commit messages.
 *
 * The trailers are not cosmetic: because every content change records the acting
 * operator, the action, and the status transition, `git log data/products/` *is* the
 * audit trail (Requirement 17.12). There is no separate audit log to keep in sync, and
 * the record is tamper-evident for free — rewriting it means rewriting history.
 *
 * ```text
 * content(product): publish "Luxury L-Shape Sofa" [NGF-SOF-4F2K9C]
 *
 * Actor: admin@example.com (owner)
 * Action: PUBLISH
 * Status: REVIEW -> PUBLISHED
 * ```
 *
 * ` [skip ci]` on the subject line is what keeps a draft save from spending a
 * production build. Which changes qualify is decided by `shouldSkipCi` in
 * `src/lib/products/transitions.ts`, not here — this module only renders the decision.
 *
 * Design: Write Pipeline → Commit strategy.
 * Requirements: 17.12, 17.14, 17.15.
 */

import { actorLabel } from '../auth/actor';
import type { CommitActor } from '../auth/actor';
import type { ProductStatusValue } from '@/schemas/product';

export const SKIP_CI_MARKER = '[skip ci]';

export type CommitScope = 'product' | 'category' | 'review' | 'site' | 'analytics';

export interface CommitContext {
  scope: CommitScope;
  /** Lowercase verb for the subject: `publish`, `update`, `create`, `delete`, `rename`. */
  action: string;
  /** The record's display name and, for products, its SKU. */
  subject?: { name: string; sku?: string };
  /** An operator, or the one automated writer — see `CommitActor`. */
  actor: CommitActor;
  /** Present for a lifecycle change; omitted for a plain content edit. */
  transition?: { from: ProductStatusValue; to: ProductStatusValue };
  /** Overrides the `Action:` trailer when it differs from the subject verb. */
  actionCode?: string;
  skipCi: boolean;
}

/**
 * Collapse anything that would break a one-line subject.
 *
 * A product name is operator-supplied free text and may contain newlines, quotes, or
 * hundreds of characters. Newlines would silently turn the rest of the subject into
 * body text and lose the SKU from the log summary, so they are folded to spaces and the
 * name is truncated — but only the *name*: the SKU is never abbreviated, because it is
 * the stable identifier the audit trail is searched by.
 */
function oneLine(value: string, maxLength: number): string {
  const flattened = value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length <= maxLength) return flattened;
  return `${flattened.slice(0, maxLength - 1)}…`;
}

export function buildCommitMessage(context: CommitContext): string {
  const parts = [`content(${context.scope}): ${context.action}`];
  if (context.subject !== undefined) {
    parts.push(`"${oneLine(context.subject.name, 72)}"`);
    if (context.subject.sku !== undefined && context.subject.sku !== '') {
      parts.push(`[${context.subject.sku}]`);
    }
  }
  let subject = parts.join(' ');
  if (context.skipCi) subject = `${subject} ${SKIP_CI_MARKER}`;

  const trailers = [`Actor: ${actorLabel(context.actor)}`];
  trailers.push(`Action: ${context.actionCode ?? context.action.toUpperCase()}`);
  if (context.transition !== undefined) {
    trailers.push(`Status: ${context.transition.from} -> ${context.transition.to}`);
  }

  return `${subject}\n\n${trailers.join('\n')}\n`;
}

/** Read the trailers back out of a commit message — used by the pipeline tests. */
export function parseCommitTrailers(message: string): Record<string, string> {
  const trailers: Record<string, string> = {};
  for (const line of message.split('\n').slice(1)) {
    const match = /^([A-Za-z][A-Za-z-]*): (.*)$/.exec(line.trim());
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      trailers[match[1]] = match[2];
    }
  }
  return trailers;
}

export function commitSubject(message: string): string {
  return message.split('\n', 1)[0] ?? '';
}
