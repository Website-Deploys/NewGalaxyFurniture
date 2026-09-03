/**
 * The interactive-actor witness.
 *
 * Requirement 14.10 forbids publishing through "an automated, scheduled, or
 * non-interactive path". A comment saying so is not an enforcement mechanism, so
 * this module makes it a type-system one: `applyTransition` demands an
 * `InteractiveActor`, and the only way to obtain one is to hand `interactiveActor`
 * a live `Session` — which only `POST /api/admin/login` mints and only a browser
 * request carrying the cookie can retrieve.
 *
 * The brand is a `unique symbol` property that no object literal can declare, so a
 * cron handler, a queue consumer, or a rehydrate loop cannot assemble a plausible
 * actor and reach the publish path. The compiler rejects it at the call site.
 *
 * Design: Write Pipeline → Status transition machine.
 * Requirements: 10.14, 14.10.
 */

import type { Role } from './permissions';
import type { Session } from './session';

declare const interactiveBrand: unique symbol;

export interface InteractiveActor {
  /** Unforgeable outside this module. */
  readonly [interactiveBrand]: 'interactive';
  /** Recorded in the commit trailer, so `git log` names who acted. */
  readonly email: string;
  readonly role: Role;
  /** Ties the action to a specific live session record. */
  readonly sessionId: string;
}

/**
 * Build the witness from an authenticated session.
 *
 * `email` comes from the `admin_users` row the session's `userId` points at, not
 * from the request — the commit trailer is an audit record and must not be
 * client-supplied.
 */
export function interactiveActor(session: Session, email: string): InteractiveActor {
  return {
    email,
    role: session.role,
    sessionId: session.id,
  } as InteractiveActor;
}

/**
 * The one non-interactive writer.
 *
 * The nightly analytics snapshot is a repository write with no operator behind it, and the audit
 * trail has to say so rather than borrow somebody's name. It is a *separate type* from
 * `InteractiveActor` and not a fabricated one: `applyTransition` and the publish path still demand
 * the branded witness, so widening the commit trailer to name an automation does not widen what an
 * automation can do. Requirement 14.10 holds by construction, and `git log` reads honestly.
 */
export interface AutomatedActor {
  /** What ran, in words: `nightly analytics snapshot`. */
  readonly automated: string;
}

export type CommitActor = Pick<InteractiveActor, 'email' | 'role'> | AutomatedActor;

/** `admin@example.com (owner)`, or `nightly analytics snapshot (automated)`. */
export function actorLabel(actor: CommitActor): string {
  return 'automated' in actor ? `${actor.automated} (automated)` : `${actor.email} (${actor.role})`;
}
