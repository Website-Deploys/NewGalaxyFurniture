/**
 * Roles and permissions.
 *
 * The authorization decision is a pure function of `(role, permission)` and lives
 * here alone. Every privileged code path asks `can()`; nothing infers authority
 * from a URL, a cookie flag, a request body, or anything the browser sends. The
 * admin UI also hides forbidden controls, but that is cosmetic — Requirement 10.14
 * requires the server decision to stand on its own.
 *
 * The vocabulary is closed and exhaustive: `PERMISSIONS` is the single list, and
 * `MUTATING_PERMISSIONS`/`READ_ONLY_PERMISSIONS` partition it. Property 29 asserts
 * the partition is total, so adding a permission without classifying it fails the
 * suite instead of silently landing in a viewer's grant set.
 *
 * Design: Admin Authentication → Role model.
 * Requirements: 10.13, 10.14, 10.16, 10.18.
 */

export const ROLES = ['owner', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'product.read',
  'product.write',
  'product.publish',
  'product.delete',
  'review.write',
  'review.publish',
  'lead.read',
  'lead.write',
  'settings.write',
  'ai.generate',
  'analytics.read',
  'user.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Permissions that create, change, publish, or delete something, or that spend
 * money on the operator's behalf.
 *
 * `ai.generate` is classified as mutating even though it writes no record of its
 * own: it draws on a metered provider budget and its output becomes product copy.
 * A read-only role that can burn the AI quota is not read-only in any sense the
 * operator would recognise.
 */
export const MUTATING_PERMISSIONS: readonly Permission[] = [
  'product.write',
  'product.publish',
  'product.delete',
  'review.write',
  'review.publish',
  'lead.write',
  'settings.write',
  'ai.generate',
  'user.manage',
];

/** Permissions that only observe stored state. */
export const READ_ONLY_PERMISSIONS: readonly Permission[] = [
  'product.read',
  'lead.read',
  'analytics.read',
];

const ALL: ReadonlySet<Permission> = new Set(PERMISSIONS);

/**
 * Deliberately explicit rather than computed: a role table is exactly the kind of
 * thing where a clever derivation grants one permission too many, and it is read
 * far more often than it is edited.
 */
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  // The seeded account. Holds everything, including future account management.
  owner: ALL,
  // Full content authoring, no publishing and no deletion: an editor prepares work
  // and submits it for review, and an owner decides what goes live.
  editor: new Set<Permission>([
    'product.read',
    'product.write',
    'review.write',
    'lead.read',
    'lead.write',
    'ai.generate',
    'analytics.read',
  ]),
  // Read-only by construction: this set is asserted to be disjoint from
  // MUTATING_PERMISSIONS by Property 29.
  viewer: new Set<Permission>(['product.read', 'lead.read', 'analytics.read']),
};

/**
 * The authorization decision. Unknown roles and permissions are denied.
 *
 * The membership guards are load-bearing, not defensive padding. `role` arrives from a
 * stored session record, and a plain-object lookup resolves inherited keys: written as
 * `ROLE_PERMISSIONS[role]?.has(permission)`, a role of `'toString'` returns
 * `Object.prototype.toString`, whose `.has` is `undefined`, and calling it throws a
 * `TypeError` — so a corrupt role crashed the guard with a 500 instead of denying. The
 * property suite found exactly that counterexample. Denying up front makes `can` total
 * and keeps the failure mode "refused".
 */
export function can(role: Role, permission: Permission): boolean {
  if (!isRole(role) || !isPermission(permission)) return false;
  return ROLE_PERMISSIONS[role].has(permission);
}

/** Every permission a role holds, for the nav's control-hiding pass. */
export function permissionsOf(role: Role): readonly Permission[] {
  if (!isRole(role)) return [];
  const granted = ROLE_PERMISSIONS[role];
  return PERMISSIONS.filter((permission) => granted.has(permission));
}
