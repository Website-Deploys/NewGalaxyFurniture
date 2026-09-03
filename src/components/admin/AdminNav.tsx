/**
 * Persistent admin navigation.
 *
 * All eleven admin areas the requirements name, in the order they are named
 * (Requirement 11.1). Each entry declares the permission it needs, and an entry the
 * session's role lacks is not rendered (Requirement 10.17).
 *
 * That hiding is presentation only, and the code says so explicitly rather than
 * leaving a reader to assume otherwise: the destination pages are gated by
 * `src/middleware.ts` and every mutation behind them is gated by `ADMIN_ROUTES`, so
 * a hand-typed URL is refused by the server whether or not the link was drawn.
 *
 * A React island rather than an Astro partial because the nav is shared by every
 * admin page and needs the current-path highlight to survive client-side navigation
 * once the admin app grows islands that navigate.
 *
 * Design: Pages, Navigation, and States → Route inventory; Admin Authentication.
 * Requirements: 10.17, 11.1, 24.8.
 */

import type { ReactElement } from 'react';

import { can, type Permission, type Role } from '@/lib/auth/permissions';

interface AdminArea {
  label: string;
  href: string;
  /** The permission required to see — and to use — this area. */
  permission: Permission;
}

/**
 * `product.read` is the general admin read permission; see the note in
 * `src/lib/auth/routes.ts` for why the design's `Permission` union has no
 * `settings.read` and what that means here.
 */
export const ADMIN_AREAS: readonly AdminArea[] = [
  { label: 'Dashboard', href: '/admin', permission: 'product.read' },
  { label: 'Products', href: '/admin/products', permission: 'product.read' },
  { label: 'Add Product', href: '/admin/products/new', permission: 'product.write' },
  { label: 'AI Product Assistant', href: '/admin/ai-assistant', permission: 'ai.generate' },
  { label: 'Categories', href: '/admin/categories', permission: 'product.read' },
  { label: 'Reviews', href: '/admin/reviews', permission: 'product.read' },
  { label: 'Leads', href: '/admin/leads', permission: 'lead.read' },
  { label: 'Homepage', href: '/admin/homepage', permission: 'product.read' },
  { label: 'Content', href: '/admin/content', permission: 'product.read' },
  { label: 'Analytics', href: '/admin/analytics', permission: 'analytics.read' },
  { label: 'Settings', href: '/admin/settings', permission: 'product.read' },
];

export interface AdminNavProps {
  role: Role;
  /** Used for `aria-current`; the nav does not derive authority from it. */
  currentPath: string;
  /** From the SSR bootstrap payload. Required on the logout POST. */
  csrfToken: string;
}

/** Longest-prefix match, so `/admin/products/new` does not also mark `Products`. */
function activeHref(currentPath: string, hrefs: readonly string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const matches = currentPath === href || currentPath.startsWith(`${href}/`);
    if (matches && (best === null || href.length > best.length)) best = href;
  }
  return best;
}

export default function AdminNav({ role, currentPath, csrfToken }: AdminNavProps): ReactElement {
  const visible = ADMIN_AREAS.filter((area) => can(role, area.permission));
  const active = activeHref(
    currentPath,
    visible.map((area) => area.href),
  );

  return (
    <nav aria-label="Admin navigation" className="text-body">
      <p className="mb-3 text-small tracking-[0.18em] text-walnut uppercase">
        {role} · New Galaxy Furniture
      </p>
      <ul className="flex flex-col gap-px border-t border-taupe">
        {visible.map((area) => {
          const isActive = area.href === active;
          return (
            <li key={area.href} className="border-b border-taupe">
              <a
                href={area.href}
                aria-current={isActive ? 'page' : undefined}
                className={[
                  // ≥ 44 px tap target (Requirement 24.x responsive strategy).
                  'flex min-h-[44px] items-center px-3 py-2 no-underline',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-champagne',
                  isActive ? 'bg-espresso text-ivory' : 'text-obsidian hover:bg-cream',
                ].join(' ')}
              >
                {area.label}
              </a>
            </li>
          );
        })}
      </ul>
      {/*
        A button rather than a plain link: logout is state-changing, so it must be a
        POST carrying the CSRF header. A GET link would be followable by any page on
        the internet and would log the operator out mid-edit.
      */}
      <button
        type="button"
        onClick={() => {
          void fetch('/api/admin/logout', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: '{}',
          }).then(() => {
            window.location.assign('/admin/login');
          });
        }}
        className="mt-4 min-h-[44px] w-full border border-espresso px-3 py-2 text-espresso hover:bg-espresso hover:text-ivory focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-champagne"
      >
        Sign out
      </button>
    </nav>
  );
}
