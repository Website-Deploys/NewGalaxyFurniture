/**
 * The filter panel: all seven dimensions, visible at once, with live counts.
 *
 * Requirement 3.1 asks for the seven dimensions "simultaneously", which rules out an accordion
 * that hides six of them. Requirement 3.8 asks for zero-count options to be **disabled showing
 * 0** rather than removed — more layout stability and a clearer mental model than options that
 * appear and vanish as other filters change.
 *
 * At ≥ 768 px this is a sidebar; below 768 px the same markup becomes a bottom sheet with focus
 * trapping and Escape-to-close (design → Responsive strategy; Requirements 24.5, 24.7). The
 * layout switch is CSS; only the trap and the toggle are JavaScript.
 *
 * Counts come from `facetCounts`, which recomputes every option in the same pass as the results,
 * so a count can never describe a previous state (Requirement 3.7).
 *
 * Requirements: 3.1, 3.2, 3.3, 3.7, 3.8, 3.17, 24.2, 24.5, 24.7.
 */

import { useEffect, useRef, useState } from 'react';

import { useScopedId } from '@/lib/ui/ids';

import { MULTI_DIMENSIONS } from '@/lib/search/filter';
import type { AvailabilityFilter, FacetOption, Facets, MultiDimension } from '@/lib/search/filter';
import type { PriceBandFilter } from '@/lib/money';
import { activateTrap } from '@/lib/ui/focus-trap';

const DIMENSION_LABELS: Readonly<Record<MultiDimension, string>> = {
  category: 'Category',
  material: 'Material',
  colour: 'Colour',
  size: 'Size',
  style: 'Style',
};

export interface FilterPanelProps {
  /**
   * Every option's `selected` and `count` already come from `facetCounts`, which is computed from
   * the state — so the panel is a pure rendering of `facets` and does not read the state itself.
   * One source for "is this option on" rather than two that can disagree.
   */
  facets: Facets;
  onToggle: (dimension: MultiDimension, value: string) => void;
  onPriceBand: (band: PriceBandFilter) => void;
  onAvailability: (availability: AvailabilityFilter) => void;
  onClear: () => void;
  /** True when any dimension is constrained — controls whether "Clear" is offered. */
  hasFilters: boolean;
}

export default function FilterPanel({
  facets,
  onToggle,
  onPriceBand,
  onAvailability,
  onClear,
  hasFilters,
}: FilterPanelProps): React.JSX.Element {
  const [sheetOpen, setSheetOpen] = useState(false);
  const shellId = useScopedId('ngf-filter-shell');
  const shellRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  /**
   * The number of active filters, derived from the facets the panel already renders rather than
   * from the state it is deliberately not given. Every selected option counts once — a selected
   * price band or availability that is not the neutral "any", and each selected value across the
   * five multi-select dimensions. It drives the count badge on the mobile toggle and in the sheet
   * head so a visitor who has scrolled the sheet closed still sees how many filters are narrowing
   * the listing.
   */
  const activeCount = (Object.values(facets) as FacetOption[][])
    .flat()
    .filter((option) => option.selected && option.value !== 'any').length;

  useEffect(() => {
    const shell = shellRef.current;
    if (!sheetOpen || shell === null) return;
    return activateTrap(shell, {
      onEscape: () => {
        setSheetOpen(false);
        toggleRef.current?.focus();
      },
    });
  }, [sheetOpen]);

  return (
    <div className="ngf-filters">
      <button
        type="button"
        ref={toggleRef}
        className="ngf-filter-toggle"
        aria-expanded={sheetOpen}
        aria-controls={shellId}
        onClick={() => setSheetOpen((open) => !open)}
      >
        <span>Filters</span>
        {activeCount > 0 && (
          <span className="ngf-filter-toggle-count" aria-hidden="true">
            {activeCount}
          </span>
        )}
        {activeCount > 0 && (
          <span className="sr-only">
            {activeCount === 1 ? ', 1 active' : `, ${String(activeCount)} active`}
          </span>
        )}
      </button>

      {/*
        `data-sheet`, not the `hidden` attribute.

        `hidden` was the obvious choice and it silently broke the filters on every desktop viewport.
        The intent was "closed below 768 px, always open above it", expressed as `hidden` plus a
        `@media (min-width: 768px) { .ngf-filter-shell[hidden] { display: block } }` override — but
        the browser's own stylesheet declares `[hidden] { display: none !important }`, so no author
        rule can bring it back. The sidebar was `display: none` at every width, and the only way to
        reach a filter was the sheet opener, which the same breakpoint hides. The whole filter panel
        was unreachable at 768 px and wider.

        Driving the state from a data attribute leaves `display` entirely to the stylesheet, which is
        where the breakpoint lives. Below 768 px the closed sheet is `display: none`, so it is out of
        the accessibility tree exactly as `hidden` intended; at and above it, it is a visible
        sidebar.
      */}
      <div
        id={shellId}
        ref={shellRef}
        className="ngf-filter-shell"
        data-sheet={sheetOpen ? 'open' : 'closed'}
        role="group"
        aria-label="Filters"
      >
        <div className="ngf-filter-sheet-head">
          <p className="ngf-mobilenav-eyebrow">
            Filters
            {activeCount > 0 && (
              <span className="ngf-filter-sheet-count">
                {activeCount === 1 ? '1 active' : `${String(activeCount)} active`}
              </span>
            )}
          </p>
          <button
            type="button"
            className="ngf-mobilenav-close"
            onClick={() => {
              setSheetOpen(false);
              toggleRef.current?.focus();
            }}
          >
            <span aria-hidden="true">×</span>
            <span className="sr-only">Close filters</span>
          </button>
        </div>

        <div className="ngf-filter-panel">
          {/* Price band — single select, "Any" default (Requirement 3.2). */}
          <fieldset className="ngf-filter-group">
            <legend>Price</legend>
            <ul className="ngf-filter-options">
              {facets.priceBand.map((option) => (
                <li
                  key={option.value}
                  className="ngf-filter-option"
                  data-disabled={option.disabled ? 'true' : 'false'}
                >
                  <input
                    type="radio"
                    name="ngf-price"
                    id={`ngf-price-${option.value}`}
                    value={option.value}
                    checked={option.selected}
                    disabled={option.disabled}
                    onChange={() => onPriceBand(option.value as PriceBandFilter)}
                  />
                  <label htmlFor={`ngf-price-${option.value}`}>{option.label}</label>
                  <span className="ngf-filter-count">{option.count}</span>
                </li>
              ))}
            </ul>
          </fieldset>

          {/* Availability — single select, exactly three options (Requirement 3.3). */}
          <fieldset className="ngf-filter-group">
            <legend>Availability</legend>
            <ul className="ngf-filter-options">
              {facets.availability.map((option) => (
                <li
                  key={option.value}
                  className="ngf-filter-option"
                  data-disabled={option.disabled ? 'true' : 'false'}
                >
                  <input
                    type="radio"
                    name="ngf-availability"
                    id={`ngf-availability-${option.value}`}
                    value={option.value}
                    checked={option.selected}
                    disabled={option.disabled}
                    onChange={() => onAvailability(option.value as AvailabilityFilter)}
                  />
                  <label htmlFor={`ngf-availability-${option.value}`}>{option.label}</label>
                  <span className="ngf-filter-count">{option.count}</span>
                </li>
              ))}
            </ul>
          </fieldset>

          {/* The five multi-select dimensions, values derived from the data at runtime. */}
          {MULTI_DIMENSIONS.map((dimension) => (
            <fieldset className="ngf-filter-group" key={dimension}>
              <legend>{DIMENSION_LABELS[dimension]}</legend>
              {facets[dimension].length === 0 ? (
                <p className="ngf-filter-note">
                  No {DIMENSION_LABELS[dimension].toLowerCase()} values in the catalogue yet.
                </p>
              ) : (
                <ul className="ngf-filter-options">
                  {facets[dimension].map((option) => (
                    <li
                      key={option.value}
                      className="ngf-filter-option"
                      data-disabled={option.disabled ? 'true' : 'false'}
                    >
                      <input
                        type="checkbox"
                        id={`ngf-${dimension}-${option.value}`}
                        checked={option.selected}
                        disabled={option.disabled}
                        onChange={() => onToggle(dimension, option.value)}
                      />
                      <label htmlFor={`ngf-${dimension}-${option.value}`}>{option.label}</label>
                      <span className="ngf-filter-count">{option.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          ))}

          {hasFilters && (
            <button type="button" className="ngf-filter-clear" onClick={onClear}>
              Clear all filters
            </button>
          )}
        </div>

        {/*
          The mobile sheet's action row. It is only ever visible below 768 px (CSS hides it in the
          sidebar), and neither control changes what is applied — filtering is already live on
          every toggle. "Done" simply closes the sheet and returns focus to the toggle, the same
          contract as Escape and the × so `responsive.spec.ts`'s focus-return assertion holds; the
          reset mirrors the in-panel clear so a visitor at the bottom of a long sheet does not have
          to scroll back up to it.
        */}
        <div className="ngf-filter-sheet-actions">
          {hasFilters && (
            <button type="button" className="ngf-filter-sheet-reset" onClick={onClear}>
              Reset
            </button>
          )}
          <button
            type="button"
            className="ngf-filter-sheet-done"
            onClick={() => {
              setSheetOpen(false);
              toggleRef.current?.focus();
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
