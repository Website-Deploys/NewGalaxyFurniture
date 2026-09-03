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

import { useEffect, useId, useRef, useState } from 'react';

import { MULTI_DIMENSIONS } from '@/lib/search/filter';
import type { AvailabilityFilter, Facets, MultiDimension } from '@/lib/search/filter';
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
  const shellId = useId();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

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
        Filters
      </button>

      {/*
        `hidden` drives the bottom sheet below 768 px. At 768 px and above the stylesheet
        overrides `[hidden]` back to `display: block`, so the sidebar is always present there
        regardless of this attribute — the sheet's open state is meaningless on a sidebar.
      */}
      <div
        id={shellId}
        ref={shellRef}
        className="ngf-filter-shell"
        hidden={!sheetOpen}
        role="group"
        aria-label="Filters"
      >
        <div className="ngf-filter-sheet-head">
          <p className="ngf-mobilenav-eyebrow">Filters</p>
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
                <p className="ngf-sort-basis">
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
      </div>
    </div>
  );
}
