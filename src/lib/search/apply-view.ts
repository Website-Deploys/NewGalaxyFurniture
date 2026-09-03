/**
 * Applying a filtered, sorted result set to the already-rendered card grid.
 *
 * This is the mechanism that lets the catalogue satisfy two requirements that pull in opposite
 * directions: the search index must **not** be in the initial payload (22.8), yet filter and
 * sort changes must repaint results **within 300 ms with no page reload** (3.5).
 *
 * The resolution is to have exactly one renderer. The cards are prerendered by
 * `ProductCard.astro` — real HTML, no JS, indexable, correct with hydration disabled — and the
 * island reorders and hides those same nodes once the index arrives. The alternative, a React
 * card component that re-renders the grid, would mean two card implementations that must stay
 * pixel-identical forever, and would put the whole catalogue behind hydration.
 *
 * Ordering uses the CSS `order` property, which grid honours for explicit item order. Hiding
 * uses `hidden`, so a hidden card leaves the accessibility tree as well as the layout.
 *
 * Requirements: 3.4, 3.5, 3.10, 3.12, 22.8.
 */

export const CARD_SELECTOR = '[data-product-card]';
export const CARD_SLUG_ATTRIBUTE = 'data-slug';

/** The grid item that wraps a card — `hidden` and `order` go on the wrapper, not the card. */
function itemFor(card: HTMLElement): HTMLElement {
  const parent = card.parentElement;
  return parent !== null && parent.tagName === 'LI' ? parent : card;
}

/**
 * Show `slugs` in the given order and hide everything else in `root`.
 *
 * Returns the number of cards shown, which is what the caller announces and what decides
 * whether the no-match state is displayed.
 */
export function applyResults(root: ParentNode, slugs: readonly string[]): number {
  const position = new Map<string, number>();
  slugs.forEach((slug, index) => position.set(slug, index));

  let shown = 0;
  for (const card of root.querySelectorAll<HTMLElement>(CARD_SELECTOR)) {
    const slug = card.getAttribute(CARD_SLUG_ATTRIBUTE);
    const item = itemFor(card);
    const index = slug === null ? undefined : position.get(slug);
    if (index === undefined) {
      item.hidden = true;
      item.style.removeProperty('order');
      continue;
    }
    item.hidden = false;
    item.style.order = String(index);
    shown += 1;
  }
  return shown;
}

/** The slugs of the cards the server rendered — the set the island is allowed to reorder. */
export function renderedSlugs(root: ParentNode): string[] {
  return [...root.querySelectorAll<HTMLElement>(CARD_SELECTOR)]
    .map((card) => card.getAttribute(CARD_SLUG_ATTRIBUTE))
    .filter((slug): slug is string => slug !== null);
}
