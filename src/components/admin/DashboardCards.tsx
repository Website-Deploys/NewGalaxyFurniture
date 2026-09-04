/**
 * The dashboard's figures.
 *
 * Every number here is a tally of stored records, passed in by the page that read them. There
 * is no sample, illustrative or placeholder figure anywhere in this component, and no
 * arithmetic that could invent one (Requirement 11.3).
 *
 * The distinction that matters is between **"no records"** and **"zero"**. A catalogue with no
 * products at all does not show five zeros — five zeros read as five measurements — it shows
 * one statement that nothing has been created yet, with the action that changes that
 * (Requirement 11.4). Once any product exists, a genuine zero in one status *is* a
 * measurement and is shown as one.
 *
 * The leads card is the same distinction over a different store: leads live in D1, not in the
 * content repository. A successful count of an empty table is a real zero and reads as one; a
 * failed read is passed as `null` and says "not available yet", because "nobody has enquired"
 * and "we could not ask" are different facts.
 *
 * Requirements: 11.2, 11.3, 11.4, 11.6, 26.14.
 */

import type { ReactElement } from 'react';

import type { CatalogueCounts } from '@/lib/products/query';
import EmptyState from '@/components/ui/EmptyState';

export interface RecentChange {
  /** Commit subject, e.g. `content(product): publish "…" [NGF-…]`. */
  subject: string;
  actor: string | null;
  at: string | null;
  sha: string | null;
}

export interface DashboardCardsProps {
  counts: CatalogueCounts;
  /**
   * New leads, or null when the lead store could not be read. Null renders as "not available
   * yet", never as 0.
   */
  newLeads: number | null;
  recent: readonly RecentChange[];
  /** Set when the recent-activity read failed; shown instead of an empty list. */
  recentUnavailable?: string;
  canWrite: boolean;
}

interface Metric {
  label: string;
  value: number;
  href?: string;
  note?: string;
}

export default function DashboardCards(props: DashboardCardsProps): ReactElement {
  const { counts } = props;

  if (counts.total === 0) {
    return (
      <div className="flex flex-col gap-6">
        <EmptyState
          heading="No products yet"
          message="Nothing has been created, so there is nothing to count. Product and enquiry figures appear here as soon as there are records behind them — no example numbers are shown in the meantime."
        >
          {props.canWrite && (
            <a
              href="/admin/products/new"
              className="min-h-[44px] bg-espresso px-5 py-3 text-ivory no-underline"
            >
              Add your first product
            </a>
          )}
        </EmptyState>
        <LeadsCard newLeads={props.newLeads} />
        <RecentActivity
          recent={props.recent}
          {...(props.recentUnavailable === undefined
            ? {}
            : { unavailable: props.recentUnavailable })}
        />
      </div>
    );
  }

  const metrics: Metric[] = [
    { label: 'Published', value: counts.published, href: '/admin/products?status=PUBLISHED' },
    { label: 'Drafts', value: counts.draft, href: '/admin/products?status=DRAFT' },
    { label: 'Awaiting review', value: counts.review, href: '/admin/products?status=REVIEW' },
    {
      label: 'Out of stock',
      value: counts.outOfStock,
      href: '/admin/products?status=OUT_OF_STOCK',
      note: 'Still visible to customers, with enquiry buttons in place of ordering.',
    },
    {
      label: 'Unpublished',
      value: counts.unpublished,
      href: '/admin/products?status=UNPUBLISHED',
      note: 'Removed from the site, kept in the catalogue.',
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="catalogue-heading">
        <h2 id="catalogue-heading" className="font-display text-h3 text-espresso">
          Catalogue
        </h2>
        <p className="mt-1 text-small text-walnut">
          {counts.total} product{counts.total === 1 ? '' : 's'} in total. Every figure is a count of
          stored products.
        </p>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {metrics.map((metric) => (
            <li key={metric.label} className="border border-taupe bg-white p-4">
              <p className="text-small tracking-[0.12em] text-walnut uppercase">{metric.label}</p>
              <p className="font-display text-h2 text-espresso">{metric.value}</p>
              {metric.note !== undefined && (
                <p className="mt-1 text-small text-walnut">{metric.note}</p>
              )}
              {metric.href !== undefined && metric.value > 0 && (
                <a href={metric.href} className="mt-2 inline-block text-small underline">
                  View
                </a>
              )}
            </li>
          ))}
        </ul>
      </section>

      <LeadsCard newLeads={props.newLeads} />
      <RecentActivity
        recent={props.recent}
        {...(props.recentUnavailable === undefined ? {} : { unavailable: props.recentUnavailable })}
      />
    </div>
  );
}

function LeadsCard({ newLeads }: { newLeads: number | null }): ReactElement {
  return (
    <section aria-labelledby="leads-heading" className="border border-taupe bg-white p-4">
      <h2 id="leads-heading" className="font-display text-h3 text-espresso">
        Enquiries
      </h2>
      {newLeads === null ? (
        <p className="mt-2 max-w-[60ch] text-small text-walnut">
          The enquiry store could not be read, so no count is shown. A number here would not be a
          measurement — and a zero would wrongly say nobody has been in touch.
        </p>
      ) : newLeads === 0 ? (
        <p className="mt-2 max-w-[60ch] text-small text-walnut">
          No new enquiries. Enquiries arrive through the WhatsApp and call buttons and the enquiry
          form, and appear under Leads.
        </p>
      ) : (
        <>
          <p className="font-display text-h2 text-espresso">{newLeads}</p>
          <a href="/admin/leads?status=NEW" className="mt-2 inline-block text-small underline">
            View new enquiries
          </a>
        </>
      )}
    </section>
  );
}

function RecentActivity({
  recent,
  unavailable,
}: {
  recent: readonly RecentChange[];
  unavailable?: string;
}): ReactElement {
  return (
    <section aria-labelledby="activity-heading">
      <h2 id="activity-heading" className="font-display text-h3 text-espresso">
        Recent content changes
      </h2>
      <p className="mt-1 text-small text-walnut">
        Read from the commit history of the content repository — the record of who changed what.
      </p>
      {unavailable !== undefined ? (
        <p className="mt-3 text-small text-walnut">{unavailable}</p>
      ) : recent.length === 0 ? (
        <p className="mt-3 text-small text-walnut">
          No content changes recorded yet. Every save, publish and deletion appears here.
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-2">
          {recent.map((change) => (
            <li key={`${change.sha ?? change.subject}`} className="border-b border-taupe pb-2">
              <p className="text-small text-obsidian">{change.subject}</p>
              <p className="text-small text-walnut">
                {change.actor ?? 'unknown operator'}
                {change.at === null
                  ? ''
                  : ` · ${new Date(change.at).toLocaleString('en-IN', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}`}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
