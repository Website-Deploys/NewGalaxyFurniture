/**
 * The breadcrumb trails, as data.
 *
 * Requirement 23.10 asks that the `BreadcrumbList` structured data match the visible breadcrumb
 * *exactly*. The only way to guarantee that is for there to be one trail: these functions return
 * the array, `Breadcrumbs.astro` renders it, and `breadcrumbJsonLd` serialises the same array. A
 * second hand-written copy in either place would be a second thing to keep in step, which is how
 * the two drift.
 *
 * The final crumb carries no `href` — it is the page you are already on. That is what makes the
 * rendered crumb plain text with `aria-current="page"` and the JSON-LD `ListItem` a named position
 * without an `item`.
 *
 * Requirements: 4.2, 23.10, 24.1.
 */

export interface Crumb {
  label: string;
  /** Absent on the final crumb — the current page. */
  href?: string;
}

/** `Collection / {Category} / {Product}` — the trail Requirement 4.2 names. */
export function productCrumbs(
  product: { name: string; category: string },
  categoryName?: string,
): Crumb[] {
  return [
    { label: 'Collection', href: '/collection' },
    { label: categoryName ?? product.category, href: `/collection/${product.category}` },
    { label: product.name },
  ];
}

/** `Collection / {Category}` — the category listing's own trail. */
export function categoryCrumbs(category: { slug: string; name: string }): Crumb[] {
  return [{ label: 'Collection', href: '/collection' }, { label: category.name }];
}
