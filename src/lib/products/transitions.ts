/**
 * The product status transition machine.
 *
 * Three independent gates stand between a draft and a live product, and all three
 * must pass:
 *
 * 1. **Reachability** — the target must be declared reachable from the current status
 *    in `TRANSITIONS`. Self-transitions are refused (Requirement 14.2).
 * 2. **Permission** — reaching a public status requires `product.publish`
 *    (Requirement 14.3).
 * 3. **Completeness** — reaching a public status requires `PublishReadySchema`
 *    (Requirements 14.4–14.6).
 *
 * `canTransition` covers 1 and 2 and is pure, which is what makes Properties 25–27
 * exhaustively checkable. `applyTransition` adds 3 and produces the updated product.
 *
 * **The fourth gate is the type signature.** Requirement 14.10 forbids publication
 * through any automated, scheduled, or non-interactive path. `applyTransition` demands
 * an `InteractiveActor`, which is only constructible from a live `Session`
 * (`src/lib/auth/actor.ts`). A cron trigger, a queue consumer, or a rehydrate loop
 * cannot call this function at all — not because it checks a flag, but because it
 * cannot produce the argument. The role also comes from that witness rather than from
 * a separate parameter, so an "publish as owner" call cannot be assembled by a caller
 * holding an editor session.
 *
 * Design: Write Pipeline → Status transition machine.
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.10, 14.11.
 */

import { can, type Role } from '../auth/permissions';
import { checkPublishGate, type PublishGateFailures } from '@/schemas/publish-gate';
import { ProductStatus, type Product, type ProductStatusValue } from '@/schemas/product';
import type { InteractiveActor } from '../auth/actor';

/**
 * The declared machine, verbatim from the design.
 *
 * `DRAFT -> PUBLISHED` is listed, and the design annotates it "direct publish allowed
 * for the owner only". That restriction is not encoded here as a special case: it
 * falls out of gate 2, because `owner` is the only role holding `product.publish`. If
 * a future role gained that permission it would gain direct publish too, which is the
 * correct coupling — the permission *is* the authority to publish.
 */
export const TRANSITIONS: Record<ProductStatusValue, readonly ProductStatusValue[]> = {
  DRAFT: ['REVIEW', 'PUBLISHED'],
  REVIEW: ['DRAFT', 'PUBLISHED'],
  PUBLISHED: ['UNPUBLISHED', 'OUT_OF_STOCK', 'DRAFT'],
  OUT_OF_STOCK: ['PUBLISHED', 'UNPUBLISHED'],
  UNPUBLISHED: ['PUBLISHED', 'DRAFT'],
};

/** The statuses that put a product in front of a visitor. */
export const PUBLIC_TARGET_STATUSES: readonly ProductStatusValue[] = ['PUBLISHED', 'OUT_OF_STOCK'];

export function isPublicStatus(status: ProductStatusValue): boolean {
  return PUBLIC_TARGET_STATUSES.includes(status);
}

/**
 * Is this one of the five declared statuses?
 *
 * Needed because `TRANSITIONS` is a plain object and a status arrives from stored JSON:
 * `TRANSITIONS['toString']` resolves up the prototype chain to a *function*, whose
 * `.includes` is `undefined`, so `TRANSITIONS[from].includes(to)` threw a `TypeError`
 * rather than refusing. The property suite produced that counterexample. Checking
 * membership first makes `canTransition` total, which matters because a throw from an
 * authorization predicate is a 500, not a denial.
 */
export function isProductStatus(value: unknown): value is ProductStatusValue {
  return typeof value === 'string' && (ProductStatus.options as readonly string[]).includes(value);
}

/**
 * Gates 1 and 2, pure.
 *
 * Returns false for a self-transition, for an undeclared target, and for a public
 * target when the role lacks `product.publish`. Unknown status strings are refused
 * rather than defaulted, so a corrupt stored status cannot be transitioned out of into
 * something public.
 */
export function canTransition(
  from: ProductStatusValue,
  to: ProductStatusValue,
  role: Role,
): boolean {
  if (!isProductStatus(from) || !isProductStatus(to)) return false;
  if (from === to) return false;
  if (!TRANSITIONS[from].includes(to)) return false;
  if (isPublicStatus(to) && !can(role, 'product.publish')) return false;
  return true;
}

/** Targets legal from `from` for `role` — what `PublishPanel` renders as buttons. */
export function availableTransitions(
  from: ProductStatusValue,
  role: Role,
): readonly ProductStatusValue[] {
  if (!isProductStatus(from)) return [];
  return TRANSITIONS[from].filter((to) => canTransition(from, to, role));
}

export type TransitionFailure =
  | { ok: false; code: 'TRANSITION_NOT_ALLOWED' }
  | { ok: false; code: 'PUBLISH_GATE_FAILED'; fields: PublishGateFailures };

export type TransitionResult = { ok: true; product: Product } | TransitionFailure;

export interface ApplyTransitionOptions {
  /** Timestamp for `updatedAt`. Injected so one request produces one instant. */
  at?: string;
}

/**
 * Derive the inventory fields a target status implies.
 *
 * The product schema couples status and stock status in both directions
 * (`status OUT_OF_STOCK ⟺ stockStatus OUT_OF_STOCK`), so a transition that changed only
 * `status` would produce a record its own schema rejects. Rather than let that surface
 * as an opaque validation error, the coupling is resolved here:
 *
 * - Going **to** `OUT_OF_STOCK` sets `stockStatus` to match.
 * - Coming **from** `OUT_OF_STOCK` back to `PUBLISHED` must move `stockStatus` off
 *   `OUT_OF_STOCK`; `IN_STOCK` is the only sensible default, and it is safe because a
 *   made-to-order product cannot have been `OUT_OF_STOCK` in the first place
 *   (`madeToOrder ⟹ MADE_TO_ORDER` forbids it).
 *
 * The one case that is *not* silently resolved is a made-to-order product being marked
 * out of stock: setting `madeToOrder` to false on the operator's behalf would discard a
 * fact they entered. That returns a field-level failure instead.
 */
function inventoryFor(
  product: Product,
  to: ProductStatusValue,
): { ok: true; patch: Partial<Product> } | { ok: false; fields: PublishGateFailures } {
  if (to === 'OUT_OF_STOCK') {
    if (product.madeToOrder) {
      return {
        ok: false,
        fields: {
          madeToOrder: [
            'A made-to-order product cannot be marked out of stock. Turn off made-to-order first.',
          ],
        },
      };
    }
    return { ok: true, patch: { stockStatus: 'OUT_OF_STOCK' } };
  }
  if (product.stockStatus === 'OUT_OF_STOCK') {
    return { ok: true, patch: { stockStatus: 'IN_STOCK' } };
  }
  return { ok: true, patch: {} };
}

/**
 * Apply a transition, or explain why not.
 *
 * The gate runs against the **candidate** product — the one that would be written —
 * not against the current one. Checking the pre-transition record would let a product
 * that is complete as a draft but incomplete as published slip through, and would also
 * reject the reverse.
 *
 * Never throws and never mutates `product`: the caller keeps the operator's values on
 * failure, which is what Requirement 17.17 needs.
 */
export function applyTransition(
  product: Product,
  to: ProductStatusValue,
  actor: InteractiveActor,
  options: ApplyTransitionOptions = {},
): TransitionResult {
  const parsedTo = ProductStatus.safeParse(to);
  if (!parsedTo.success) return { ok: false, code: 'TRANSITION_NOT_ALLOWED' };

  const from = ProductStatus.safeParse(product.status);
  if (!from.success) return { ok: false, code: 'TRANSITION_NOT_ALLOWED' };

  if (!canTransition(from.data, parsedTo.data, actor.role)) {
    return { ok: false, code: 'TRANSITION_NOT_ALLOWED' };
  }

  const inventory = inventoryFor(product, parsedTo.data);
  if (!inventory.ok) return { ok: false, code: 'PUBLISH_GATE_FAILED', fields: inventory.fields };

  const candidate: Product = {
    ...product,
    ...inventory.patch,
    status: parsedTo.data,
    // `published` is a derived mirror of status; the schema enforces the equality, and
    // deriving it here means no caller can set the two inconsistently.
    published: isPublicStatus(parsedTo.data),
    updatedAt: options.at ?? new Date().toISOString(),
  };

  if (isPublicStatus(parsedTo.data)) {
    const gate = checkPublishGate(candidate);
    if (!gate.ok) return { ok: false, code: 'PUBLISH_GATE_FAILED', fields: gate.fields };
  }

  return { ok: true, product: candidate };
}

/**
 * Whether a commit for this transition should carry ` [skip ci]`.
 *
 * "Draft/review-only" is read as a statement about the change, not just its
 * destination: a move *from* a public status into `DRAFT` has to rebuild, because the
 * live page must come down (Requirement 14.9). The design's state table lists `DRAFT`
 * as "no build", which is right for a draft that was never public and wrong for one
 * that was; taking `from` into account satisfies both rows.
 */
export function shouldSkipCi(from: ProductStatusValue | null, to: ProductStatusValue): boolean {
  const draftish = (status: ProductStatusValue): boolean =>
    status === 'DRAFT' || status === 'REVIEW';
  if (!draftish(to)) return false;
  return from === null || draftish(from);
}

/** The inverse: does this change need a deploy to become visible? */
export function triggersDeploy(from: ProductStatusValue | null, to: ProductStatusValue): boolean {
  return !shouldSkipCi(from, to);
}

/** `PUBLISH`, `SEND_BACK`, … — the `Action:` commit trailer. */
export function transitionAction(from: ProductStatusValue, to: ProductStatusValue): string {
  if (to === 'PUBLISHED') return 'PUBLISH';
  if (to === 'UNPUBLISHED') return 'UNPUBLISH';
  if (to === 'OUT_OF_STOCK') return 'MARK_OUT_OF_STOCK';
  if (to === 'REVIEW') return 'SUBMIT_FOR_REVIEW';
  if (to === 'DRAFT') return from === 'REVIEW' ? 'SEND_BACK_FOR_EDITS' : 'RETURN_TO_DRAFT';
  return 'UPDATE';
}
