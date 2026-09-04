/**
 * The public navigation model — one declaration, read by the desktop header, the mobile
 * panel, and the footer.
 *
 * Requirement 9.2 caps the header at nine top-level destinations, and Requirement 9.1 names
 * them exactly: Sofas, Beds, Dining, Chairs, Tables, Storage, Custom Furniture, Collection,
 * Contact. There are nine categories but only six category-shaped slots in that list, so
 * three of the entries (Dining, Chairs, Tables) are **groups** that open a dropdown rather
 * than top-level links, which is how all nine categories stay one action away without a
 * tenth item appearing in the bar.
 *
 * The `NAV_ASSERTION` below is not decoration: it runs at module load, so a future edit that
 * adds a tenth destination or points a group at a category slug that no longer exists fails
 * the build rather than shipping a broken header.
 *
 * Requirements: 9.1, 9.2, 9.7.
 * Design: Pages, Navigation, and States → Navigation.
 */

import { SEEDED_CATEGORY_SLUGS } from '@/schemas/category';

export interface NavLink {
  kind: 'link';
  label: string;
  href: string;
}

export interface NavGroup {
  kind: 'group';
  label: string;
  /** The panel's own "see everything in this group" destination. */
  href: string;
  /** Column one: the category routes this group gathers. */
  items: NavLink[];
  /** Column two: a short orienting line. No invented business facts. */
  note: string;
}

export type NavEntry = NavLink | NavGroup;

const categoryLink = (slug: (typeof SEEDED_CATEGORY_SLUGS)[number], label: string): NavLink => ({
  kind: 'link',
  label,
  href: `/collection/${slug}`,
});

/**
 * The nine top-level header destinations, in the order Requirement 9.1 lists them.
 *
 * Dining, Chairs, and Tables are groups. A category appears in more than one group where
 * that is how people shop — dining chairs are both a chair and part of dining — which is
 * fine because the destination is the same route either way.
 */
export const HEADER_NAV: readonly NavEntry[] = [
  categoryLink('sofas', 'Sofas'),
  categoryLink('beds', 'Beds'),
  {
    kind: 'group',
    label: 'Dining',
    href: '/collection/dining-tables',
    items: [
      categoryLink('dining-tables', 'Dining Tables'),
      categoryLink('dining-chairs', 'Dining Chairs'),
    ],
    note: 'Tables and chairs built to sit together, in sizes that fit the room you have.',
  },
  {
    kind: 'group',
    label: 'Chairs',
    href: '/collection/accent-chairs',
    items: [
      categoryLink('accent-chairs', 'Accent Chairs'),
      categoryLink('dining-chairs', 'Dining Chairs'),
      categoryLink('office', 'Office'),
    ],
    note: 'Seating for a corner, a table, or a desk.',
  },
  {
    kind: 'group',
    label: 'Tables',
    href: '/collection/coffee-side-tables',
    items: [
      categoryLink('coffee-side-tables', 'Coffee & Side Tables'),
      categoryLink('dining-tables', 'Dining Tables'),
      categoryLink('outdoor', 'Outdoor'),
    ],
    note: 'Surfaces for living rooms, dining rooms, and balconies.',
  },
  categoryLink('storage-display', 'Storage'),
  { kind: 'link', label: 'Custom Furniture', href: '/custom-furniture' },
  { kind: 'link', label: 'Collection', href: '/collection' },
  { kind: 'link', label: 'Contact', href: '/contact' },
];

/**
 * Every category route, flat. The footer lists all nine (Requirement 9.7) and the mobile
 * panel and the not-found state reuse the same list, so a new category file appears in all
 * three at once.
 */
export const CATEGORY_NAV: readonly NavLink[] = [
  categoryLink('sofas', 'Sofas & Sectionals'),
  categoryLink('beds', 'Beds'),
  categoryLink('dining-tables', 'Dining Tables'),
  categoryLink('dining-chairs', 'Dining Chairs'),
  categoryLink('accent-chairs', 'Accent Chairs'),
  categoryLink('coffee-side-tables', 'Coffee & Side Tables'),
  categoryLink('storage-display', 'Storage & Display'),
  categoryLink('office', 'Office'),
  categoryLink('outdoor', 'Outdoor'),
];

/** The supporting pages the footer carries alongside the categories. */
export const SUPPORT_NAV: readonly NavLink[] = [
  { kind: 'link', label: 'About', href: '/about' },
  { kind: 'link', label: 'Workshop', href: '/workshop' },
  { kind: 'link', label: 'Gallery', href: '/gallery' },
  { kind: 'link', label: 'Reviews', href: '/reviews' },
  { kind: 'link', label: 'Custom Furniture', href: '/custom-furniture' },
  { kind: 'link', label: 'Contact', href: '/contact' },
  { kind: 'link', label: 'FAQ', href: '/faq' },
];

export const POLICY_NAV: readonly NavLink[] = [
  { kind: 'link', label: 'Privacy', href: '/privacy' },
  { kind: 'link', label: 'Terms', href: '/terms' },
  { kind: 'link', label: 'Shipping & Delivery', href: '/shipping' },
  { kind: 'link', label: 'Returns', href: '/returns' },
  { kind: 'link', label: 'Warranty', href: '/warranty' },
];

/** Requirement 9.2's ceiling, as a constant rather than a comment. */
export const MAX_TOP_LEVEL_DESTINATIONS = 9;

/**
 * Load-time structural check.
 *
 * Kept as a function call rather than a test so it fails the *build*: a header with ten
 * items or a dead category link is a rendering defect, and there is no reason to let it
 * reach a preview deployment before a test catches it.
 */
function assertNavigation(): void {
  if (HEADER_NAV.length > MAX_TOP_LEVEL_DESTINATIONS) {
    throw new Error(
      `NAV_INVALID: header declares ${HEADER_NAV.length} top-level destinations, at most ${MAX_TOP_LEVEL_DESTINATIONS} are allowed (requirement 9.2)`,
    );
  }

  const known = new Set<string>(SEEDED_CATEGORY_SLUGS.map((slug) => `/collection/${slug}`));
  const categoryHrefs = [
    ...CATEGORY_NAV.map((link) => link.href),
    ...HEADER_NAV.flatMap((entry) =>
      entry.kind === 'group' ? entry.items.map((item) => item.href) : [],
    ),
  ];
  for (const href of categoryHrefs) {
    if (!known.has(href)) {
      throw new Error(`NAV_INVALID: ${href} is not one of the nine category routes`);
    }
  }

  if (CATEGORY_NAV.length !== SEEDED_CATEGORY_SLUGS.length) {
    throw new Error(
      `NAV_INVALID: footer lists ${CATEGORY_NAV.length} categories, expected ${SEEDED_CATEGORY_SLUGS.length} (requirement 9.7)`,
    );
  }
}

assertNavigation();
