/**
 * The admin Analytics view.
 *
 * The design constraint here is unusual: the screen's job is as much to say what it cannot tell
 * you as to show what it can. So:
 *
 * - **Every figure renders through `<Figure>`**, which takes a `Measurement` and prints its
 *   provenance badge — `Measured` or `Operator-set` — from the value itself. There is no code
 *   path that prints a number without one (Requirement 20.6).
 * - **The limits are shown, not linked.** `HONEST_LIMITS` is rendered at the top of the page
 *   where the numbers are read, because a caveat one click away is a caveat nobody reads
 *   (Requirements 20.7, 20.8).
 * - **The empty state is a designed state.** `hasData: false` produces a statement that metrics
 *   accrue after launch (Requirement 20.10) — not a grid of zeros, which would read as five
 *   measurements of nothing rather than as an absence of measurement (Requirement 20.9).
 *
 * There is no sample data, no demo mode, no projection, and no chart with an invented axis
 * anywhere in this component. Numbers arrive from the endpoint or they are not drawn.
 *
 * Requirements: 20.5, 20.6, 20.7, 20.8, 20.9, 20.10, 20.12, 26.14.
 */

import type { ReactElement } from 'react';
import EmptyState from '@/components/ui/EmptyState';

import type {
  AnalyticsSummary,
  Measurement,
  RankedEntity,
  RankedQuery,
} from '@/lib/analytics/queries';

export interface AnalyticsViewProps {
  summary: AnalyticsSummary;
  limits: readonly string[];
}

const PROVENANCE_LABEL: Record<Measurement['provenance'], string> = {
  measured: 'Measured',
  'operator-set': 'Operator-set',
};

const PROVENANCE_MEANING: Record<Measurement['provenance'], string> = {
  measured: 'Counted from visitor events. A lower bound.',
  'operator-set': 'Taken from records you maintain. Exact.',
};

function ProvenanceBadge({ provenance }: { provenance: Measurement['provenance'] }): ReactElement {
  return (
    <span
      title={PROVENANCE_MEANING[provenance]}
      className="border border-taupe px-2 py-0.5 text-small tracking-[0.12em] text-walnut uppercase"
    >
      {PROVENANCE_LABEL[provenance]}
    </span>
  );
}

function Figure({
  label,
  measurement,
  note,
}: {
  label: string;
  measurement: Measurement;
  note?: string;
}): ReactElement {
  return (
    <li className="border border-taupe bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-small tracking-[0.12em] text-walnut uppercase">{label}</p>
        <ProvenanceBadge provenance={measurement.provenance} />
      </div>
      <p className="font-display text-h2 text-espresso">{measurement.value}</p>
      {note !== undefined && <p className="mt-1 text-small text-walnut">{note}</p>}
    </li>
  );
}

function RankedList({
  heading,
  description,
  items,
  emptyMessage,
}: {
  heading: string;
  description: string;
  items: readonly RankedEntity[];
  emptyMessage: string;
}): ReactElement {
  const id = heading.toLowerCase().replace(/[^a-z]+/g, '-');
  return (
    <section aria-labelledby={id} className="border border-taupe bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={id} className="font-display text-h3 text-espresso">
          {heading}
        </h2>
        <ProvenanceBadge provenance="measured" />
      </div>
      <p className="mt-1 max-w-[70ch] text-small text-walnut">{description}</p>
      {items.length === 0 ? (
        <p className="mt-3 text-small text-walnut">{emptyMessage}</p>
      ) : (
        <ol className="mt-3 flex flex-col gap-1">
          {items.map((item, index) => (
            <li key={item.entity} className="flex justify-between gap-4 border-b border-taupe py-1">
              <span className="text-body text-obsidian">
                {index + 1}. {item.entity}
              </span>
              <span className="text-body text-espresso">{item.count.value}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function QueryList({
  heading,
  description,
  items,
  emptyMessage,
  showResults,
}: {
  heading: string;
  description: string;
  items: readonly RankedQuery[];
  emptyMessage: string;
  showResults: boolean;
}): ReactElement {
  const id = heading.toLowerCase().replace(/[^a-z]+/g, '-');
  return (
    <section aria-labelledby={id} className="border border-taupe bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={id} className="font-display text-h3 text-espresso">
          {heading}
        </h2>
        <ProvenanceBadge provenance="measured" />
      </div>
      <p className="mt-1 max-w-[70ch] text-small text-walnut">{description}</p>
      {items.length === 0 ? (
        <p className="mt-3 text-small text-walnut">{emptyMessage}</p>
      ) : (
        <ol className="mt-3 flex flex-col gap-1">
          {items.map((item, index) => (
            <li key={item.query} className="flex justify-between gap-4 border-b border-taupe py-1">
              <span className="text-body text-obsidian">
                {index + 1}. {item.query}
              </span>
              <span className="text-body text-espresso">
                {item.count.value} search{item.count.value === 1 ? '' : 'es'}
                {showResults && item.results !== null
                  ? ` · ${item.results} result${item.results === 1 ? '' : 's'}`
                  : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function AnalyticsView(props: AnalyticsViewProps): ReactElement {
  const { summary } = props;

  return (
    <div className="flex flex-col gap-6">
      {/* --- Range. A GET form: the range is in the URL. ----------------------- */}
      <form
        method="get"
        action="/admin/analytics"
        aria-label="Select a date range"
        className="flex flex-wrap items-end gap-3 border border-taupe bg-white p-4"
      >
        <label className="flex flex-col gap-1 text-small text-espresso">
          From
          <input
            type="date"
            name="from"
            defaultValue={summary.range.from}
            className="min-h-[44px] border border-taupe px-3 py-2 text-body"
          />
        </label>
        <label className="flex flex-col gap-1 text-small text-espresso">
          To
          <input
            type="date"
            name="to"
            defaultValue={summary.range.to}
            className="min-h-[44px] border border-taupe px-3 py-2 text-body"
          />
        </label>
        <button type="submit" className="min-h-[44px] bg-espresso px-5 py-2 text-ivory">
          Show this range
        </button>
      </form>

      {/* --- What these numbers can and cannot tell you. ----------------------- */}
      <section aria-labelledby="limits" className="border border-espresso bg-white p-4">
        <h2 id="limits" className="font-display text-h3 text-espresso">
          What these figures can and cannot tell you
        </h2>
        <ul className="mt-2 flex flex-col gap-2">
          {props.limits.map((limit) => (
            <li key={limit} className="max-w-[75ch] text-small text-walnut">
              {limit}
            </li>
          ))}
        </ul>
      </section>

      {!summary.hasData ? (
        <EmptyState
          heading="No data yet"
          message={`No events and no enquiries were recorded between ${summary.range.from} and ${summary.range.to}. Metrics begin accruing after launch, once visitors reach the site. Nothing is shown here in the meantime — a screen of zeros would look like a measurement, and there is nothing to measure yet.`}
        >
          <a
            href="/admin/products"
            className="min-h-[44px] border border-espresso px-4 py-2 text-espresso no-underline"
          >
            Publish something to measure
          </a>
        </EmptyState>
      ) : (
        <>
          <p className="text-small text-walnut">
            {summary.range.from} to {summary.range.to}, inclusive. Days are counted in UTC.
          </p>

          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Figure
              label="WhatsApp clicks"
              measurement={summary.whatsappClicks}
              note="Times a visitor opened WhatsApp. Not conversations, and not orders."
            />
            <Figure
              label="Call clicks"
              measurement={summary.callClicks}
              note="Times a visitor opened a phone dialler. Whether the call connected is not knowable here."
            />
            <Figure
              label="Quick Enquire opened"
              measurement={summary.quickEnquireOpens}
              note="The form was opened. Opening is not submitting."
            />
            <Figure
              label="Enquiry submissions reported"
              measurement={summary.enquiryEvents}
              note="Reported by the browser after a submission."
            />
            <Figure
              label="Enquiries stored"
              measurement={summary.enquiryRecords}
              note="Rows in your leads inbox. This is the number to act on."
            />
            <Figure
              label="Conversions"
              measurement={summary.conversions}
              note="Leads you marked as converted. Nothing else in the site can set this."
            />
          </ul>

          <RankedList
            heading="Most viewed products"
            description="Product pages, by recorded views in this range."
            items={summary.mostViewedProducts}
            emptyMessage="No product views were recorded in this range."
          />

          <RankedList
            heading="Most viewed categories"
            description="Category listings, by recorded views in this range."
            items={summary.mostViewedCategories}
            emptyMessage="No category views were recorded in this range."
          />

          <QueryList
            heading="Most frequent searches"
            description="What visitors typed into the catalogue search, normalised to lower case."
            items={summary.topSearches}
            emptyMessage="No searches were recorded in this range."
            showResults
          />

          <QueryList
            heading="Searches that found nothing"
            description="Every one of these is a visitor who wanted something and was shown an empty result. The most direct list of what to make or list next."
            items={summary.zeroResultSearches}
            emptyMessage="No search in this range returned an empty result."
            showResults={false}
          />
        </>
      )}
    </div>
  );
}
