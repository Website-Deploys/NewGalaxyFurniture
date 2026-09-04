/**
 * The sort control: exactly six options, each labelled with its honest basis.
 *
 * Requirements 3.13–3.16 are about not lying with a number. Two of the six sorts cannot be
 * measured with the data this system has, and the control says so:
 *
 * - A curated option reads **"Best Selling (curated)"** and carries **no** measurement date,
 *   because there is no measurement.
 * - A measured option carries the snapshot date, so a visitor can see how fresh "Most Viewed" is.
 *
 * Both strings come from `resolveRanking`/`sortOptionLabel`, which derive them from the same
 * value that decides the ordering — so the label cannot say "measured" while the comparator
 * falls back to the operator's manual list.
 *
 * Requirements: 3.10, 3.13, 3.14, 3.15, 3.16.
 */

import { resolveRanking, SORT_KEYS, sortOptionLabel } from '@/lib/search/sort';
import type { RankingContext, SortKey } from '@/lib/search/sort';
import type { SearchDoc } from '@/lib/search/types';

export interface SortControlProps {
  value: SortKey;
  onChange: (key: SortKey) => void;
  /** The documents currently on screen — the basis depends on whether they have measurements. */
  docs: readonly SearchDoc[];
  ranking: RankingContext;
  id?: string;
}

export default function SortControl({
  value,
  onChange,
  docs,
  ranking,
  id = 'ngf-sort',
}: SortControlProps): React.JSX.Element {
  const active = resolveRanking(value, docs, ranking);

  return (
    <div className="ngf-sort">
      <label htmlFor={id}>Sort</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value as SortKey)}>
        {SORT_KEYS.map((key) => (
          <option key={key} value={key}>
            {sortOptionLabel(resolveRanking(key, docs, ranking))}
          </option>
        ))}
      </select>
      {/*
        The basis line. `asOf` is only ever present on a measured source, so a curated sort
        physically cannot render a date here.
      */}
      <span className="ngf-sort-basis">
        {active.basis === 'measured'
          ? active.asOf === undefined
            ? 'Measured'
            : `Measured as of ${active.asOf}`
          : 'Curated by New Galaxy Furniture'}
      </span>
    </div>
  );
}
