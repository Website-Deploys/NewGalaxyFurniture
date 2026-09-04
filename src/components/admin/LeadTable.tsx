/**
 * The leads admin: list, filter, follow up, export.
 *
 * This screen is the operator's inbox, so it is built around one question — "who do I call
 * next, and about what" — and every choice below serves it:
 *
 * - **The reply controls call the lead's own number**, not a business number. `buildTelUrl`
 *   and `buildWhatsAppUrl` are the same pure functions the public site uses, so the
 *   destination is constructed identically in both directions and encoded exactly once
 *   (Requirement 6.15). They are real `<a>` elements, so long-press and copy-link work.
 * - **The date and time shown is the server's record**, rendered from the stored ISO
 *   instant (Requirement 6.7/6.12). Nothing is derived from the browser clock, which would
 *   make two operators in two timezones disagree about when an enquiry arrived.
 * - **Filters live in the URL.** The export button links to the same query string with
 *   `format=csv`, which is what makes "the export matches what I am looking at" true by
 *   construction rather than by two code paths agreeing (Requirement 6.15).
 * - **An attached image is rendered here and nowhere else.** Requirement 6.11 confines enquiry
 *   images to this admin. The public delivery route (`/img/**`) resolves product image keys
 *   only, so it cannot serve one; `/api/admin/leads/:id/image` can, and it requires a session
 *   and `lead.read`, reads the object key from the lead row rather than from the URL, and sends
 *   `Cache-Control: private, no-store`.
 *
 * The empty state distinguishes "no leads at all" from "no leads matching this filter"
 * (Requirement 26.14). Those are different facts and a single "nothing here" would let an
 * operator conclude the first when the second is true.
 *
 * Requirements: 6.11, 6.12, 6.13, 6.14, 6.15, 6.16, 20.12, 26.9, 26.14.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';

import { adminFetch } from '@/lib/admin/client';
import { buildTelUrl, buildWhatsAppUrl } from '@/lib/whatsapp';
import { formatDisplayPhone } from '@/lib/phone';
import { LEAD_STATUSES, type Lead, type LeadQuery, type LeadStatus } from '@/lib/leads/store';
import EmptyState from '@/components/ui/EmptyState';

export interface LeadTableProps {
  leads: readonly Lead[];
  total: number;
  page: number;
  pageCount: number;
  /** True when any filter was applied to produce `leads`. */
  filtered: boolean;
  query: LeadQuery;
  canWrite: boolean;
}

/** What each status means for the operator, spelled out rather than left to the label. */
const STATUS_MEANING: Record<LeadStatus, string> = {
  NEW: 'Not yet contacted',
  CONTACTED: 'Reached out at least once',
  FOLLOW_UP: 'Waiting on a further conversation',
  CONVERTED: 'Resulted in an order — the only place a conversion is recorded',
  CLOSED: 'No further action',
};

/** The filter state as a query string, so the list and the export share one source. */
function toSearch(query: LeadQuery, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if (query.status !== undefined) params.set('status', query.status);
  if (query.q !== undefined) params.set('q', query.q);
  if (query.from !== undefined) params.set('from', query.from);
  if (query.to !== undefined) params.set('to', query.to);
  if (query.page !== undefined && query.page > 1) params.set('page', String(query.page));
  for (const [key, value] of Object.entries(extra)) {
    if (value === '') params.delete(key);
    else params.set(key, value);
  }
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
}

/** The stored ISO instant, in India time, labelled as the server's record. */
function formatReceived(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  });
}

/** The first line the operator sends. Neutral, and it names what was enquired about. */
function replyMessage(lead: Lead): string {
  const about =
    lead.productName === null
      ? 'your enquiry'
      : `your enquiry about the ${lead.productName}${lead.productSku === null ? '' : ` (SKU: ${lead.productSku})`}`;
  return `Hello ${lead.name}, this is New Galaxy Furniture replying to ${about}.`;
}

export default function LeadTable(props: LeadTableProps): ReactElement {
  const [rows, setRows] = useState<readonly Lead[]>(props.leads);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});

  function patchRow(updated: Lead): void {
    setRows((current) => current.map((lead) => (lead.id === updated.id ? updated : lead)));
  }

  async function save(
    id: string,
    patch: { status?: LeadStatus; note?: string | null },
  ): Promise<void> {
    setBusy(id);
    const result = await adminFetch<{ lead: Lead }>(`/api/admin/leads/${id}`, {
      method: 'PATCH',
      body: patch,
    });
    setBusy(null);
    if (!result.ok) {
      setStatus(result.error.message);
      return;
    }
    patchRow(result.value.lead);
    setStatus(
      patch.status === undefined
        ? 'Note saved.'
        : `Status set to ${patch.status.replace('_', ' ').toLowerCase()}.`,
    );
  }

  const exportHref = `/api/admin/leads${toSearch(props.query, { format: 'csv', page: '' })}`;

  return (
    <div className="flex flex-col gap-6">
      {/* --- Filters. A plain GET form: the URL is the filter state. ----------- */}
      <form
        method="get"
        action="/admin/leads"
        aria-label="Filter leads"
        className="grid gap-3 border border-taupe bg-white p-4 md:grid-cols-4"
      >
        <label className="flex flex-col gap-1 text-small text-espresso">
          Search name, phone, message or product
          <input
            type="search"
            name="q"
            defaultValue={props.query.q ?? ''}
            className="min-h-[44px] border border-taupe px-3 py-2 text-body"
          />
        </label>
        <label className="flex flex-col gap-1 text-small text-espresso">
          Status
          <select
            name="status"
            defaultValue={props.query.status ?? ''}
            className="min-h-[44px] border border-taupe px-3 py-2 text-body"
          >
            <option value="">Any status</option>
            {LEAD_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-small text-espresso">
          Received from
          <input
            type="date"
            name="from"
            defaultValue={props.query.from ?? ''}
            className="min-h-[44px] border border-taupe px-3 py-2 text-body"
          />
        </label>
        <label className="flex flex-col gap-1 text-small text-espresso">
          Received to
          <input
            type="date"
            name="to"
            defaultValue={props.query.to ?? ''}
            className="min-h-[44px] border border-taupe px-3 py-2 text-body"
          />
        </label>
        <div className="flex flex-wrap items-end gap-3 md:col-span-4">
          <button type="submit" className="min-h-[44px] bg-espresso px-5 py-2 text-ivory">
            Apply filters
          </button>
          <a
            href="/admin/leads"
            className="min-h-[44px] border border-espresso px-4 py-2 text-espresso no-underline"
          >
            Clear
          </a>
          <a
            href={exportHref}
            className="min-h-[44px] border border-espresso px-4 py-2 text-espresso no-underline"
          >
            Export these {props.total} lead{props.total === 1 ? '' : 's'} as CSV
          </a>
        </div>
      </form>

      {status !== null && (
        <p role="status" className="border border-taupe bg-white px-4 py-3 text-small">
          {status}
        </p>
      )}

      {/* --- The list, or the right empty state. ------------------------------- */}
      {rows.length === 0 ? (
        <EmptyState
          heading={props.filtered ? 'No leads match these filters' : 'No enquiries yet'}
          message={
            props.filtered
              ? 'Clear the filters to see every enquiry. Nothing has been hidden or deleted.'
              : 'Enquiries submitted through the site’s forms appear here as soon as they are received. WhatsApp and phone conversations started from the site’s buttons do not — those happen entirely outside it.'
          }
        >
          {/*
            The next action differs by cause, and both are real: a filtered empty list needs the
            filters cleared, an unfiltered one needs the form the enquiries come from — which is the
            one thing an operator can check to satisfy themselves that nothing is being lost.
          */}
          {props.filtered ? (
            <a
              href="/admin/leads"
              className="min-h-[44px] border border-espresso px-4 py-2 text-espresso no-underline"
            >
              Clear filters
            </a>
          ) : (
            <a
              href="/contact"
              target="_blank"
              rel="noopener"
              className="min-h-[44px] border border-espresso px-4 py-2 text-espresso no-underline"
            >
              Open the enquiry form visitors use
            </a>
          )}
        </EmptyState>
      ) : (
        <>
          <p className="text-small text-walnut">
            {props.total} lead{props.total === 1 ? '' : 's'}
            {props.filtered ? ' matching these filters' : ''} · page {props.page} of{' '}
            {props.pageCount} · newest first. Dates and times are the server’s record of when each
            enquiry arrived, shown in India Standard Time.
          </p>

          <ul className="flex flex-col gap-4">
            {rows.map((lead) => {
              const noteDraft = noteDrafts[lead.id] ?? lead.note ?? '';
              return (
                <li key={lead.id} className="border border-taupe bg-white p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="font-display text-h3 text-espresso">{lead.name}</h2>
                    <p className="text-small text-walnut">
                      {formatReceived(lead.createdAt)} · {lead.type.replace('_', ' ').toLowerCase()}
                    </p>
                  </div>

                  <dl className="mt-2 grid gap-x-6 gap-y-1 text-body sm:grid-cols-2">
                    <div>
                      <dt className="text-small text-walnut">Phone</dt>
                      <dd>{formatDisplayPhone(lead.phone)}</dd>
                    </div>
                    <div>
                      <dt className="text-small text-walnut">Product</dt>
                      <dd>
                        {lead.productName ?? 'No product referenced'}
                        {lead.productSku === null ? '' : ` (${lead.productSku})`}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-small text-walnut">Originating page</dt>
                      <dd>{lead.sourcePath ?? 'Not recorded'}</dd>
                    </div>
                    <div>
                      <dt className="text-small text-walnut">Status</dt>
                      <dd>{STATUS_MEANING[lead.status]}</dd>
                    </div>
                    {lead.budget !== null && (
                      <div>
                        <dt className="text-small text-walnut">Approximate budget</dt>
                        <dd>{lead.budget}</dd>
                      </div>
                    )}
                    {lead.dimensions !== null && (
                      <div>
                        <dt className="text-small text-walnut">Dimensions</dt>
                        <dd>{lead.dimensions}</dd>
                      </div>
                    )}
                  </dl>

                  <p className="mt-3 border-l-2 border-taupe pl-3 text-body whitespace-pre-wrap">
                    {lead.message}
                  </p>

                  {lead.spamScore > 0 && (
                    <p className="mt-2 text-small text-espresso">
                      Marked by a spam heuristic (score {lead.spamScore}). It was kept rather than
                      discarded — read it and judge for yourself.
                    </p>
                  )}

                  {lead.imageKey !== null && (
                    <figure className="mt-3">
                      {/*
                        The attachment, served by `/api/admin/leads/:id/image` — the only route
                        that reads the quarantined prefix, and one that requires a session and
                        `lead.read`. `loading="lazy"` because a filtered page can carry fifty of
                        these and none of them is why the operator opened the screen.
                      */}
                      <a
                        href={`/api/admin/leads/${lead.id}/image`}
                        target="_blank"
                        rel="noopener"
                        className="inline-block"
                      >
                        <img
                          src={`/api/admin/leads/${lead.id}/image`}
                          alt={`Image attached by ${lead.name}`}
                          loading="lazy"
                          decoding="async"
                          className="max-h-64 w-auto border border-taupe"
                        />
                      </a>
                      <figcaption className="mt-1 text-small text-walnut">
                        Attached by the visitor. Held in the quarantined media store, visible only
                        here, and never shown on the public site.
                      </figcaption>
                    </figure>
                  )}

                  {/* Reply controls: the lead's own number, one action each. */}
                  <div className="mt-4 flex flex-wrap gap-3">
                    <a
                      href={buildWhatsAppUrl(lead.phone, replyMessage(lead))}
                      target="_blank"
                      rel="noopener"
                      className="min-h-[44px] bg-espresso px-4 py-2 text-ivory no-underline"
                    >
                      WhatsApp {formatDisplayPhone(lead.phone)}
                    </a>
                    <a
                      href={buildTelUrl(lead.phone)}
                      className="min-h-[44px] border border-espresso px-4 py-2 text-espresso no-underline"
                    >
                      Call {formatDisplayPhone(lead.phone)}
                    </a>
                    {lead.productUrl !== null && (
                      <a
                        href={lead.productUrl}
                        target="_blank"
                        rel="noopener"
                        className="min-h-[44px] border border-taupe px-4 py-2 text-espresso no-underline"
                      >
                        Open the product page
                      </a>
                    )}
                  </div>

                  {props.canWrite && (
                    <div className="mt-4 grid gap-3 border-t border-taupe pt-4 md:grid-cols-2">
                      <div className="flex flex-col gap-1">
                        <label
                          htmlFor={`status-${lead.id}`}
                          className="text-small font-medium text-espresso"
                        >
                          Status
                        </label>
                        <select
                          id={`status-${lead.id}`}
                          value={lead.status}
                          disabled={busy === lead.id}
                          onChange={(event) => {
                            const next = event.target.value as LeadStatus;
                            void save(lead.id, { status: next });
                          }}
                          className="min-h-[44px] border border-taupe px-3 py-2 text-body"
                        >
                          {LEAD_STATUSES.map((value) => (
                            <option key={value} value={value}>
                              {value.replace('_', ' ')} — {STATUS_MEANING[value]}
                            </option>
                          ))}
                        </select>
                        <p className="text-small text-walnut">
                          Converted is set here and nowhere else. No visitor event can infer it.
                        </p>
                      </div>

                      <div className="flex flex-col gap-1">
                        <label
                          htmlFor={`note-${lead.id}`}
                          className="text-small font-medium text-espresso"
                        >
                          Note
                        </label>
                        <textarea
                          id={`note-${lead.id}`}
                          rows={3}
                          value={noteDraft}
                          maxLength={2000}
                          disabled={busy === lead.id}
                          onChange={(event) => {
                            setNoteDrafts((current) => ({
                              ...current,
                              [lead.id]: event.target.value,
                            }));
                          }}
                          className="border border-taupe px-3 py-2 text-body"
                        />
                        <button
                          type="button"
                          disabled={busy === lead.id}
                          onClick={() => void save(lead.id, { note: noteDraft })}
                          className="mt-1 min-h-[44px] self-start border border-espresso px-4 py-2 text-espresso disabled:opacity-50"
                        >
                          Save note
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {props.pageCount > 1 && (
            <nav aria-label="Lead pages" className="flex gap-3">
              {props.page > 1 && (
                <a
                  href={`/admin/leads${toSearch(props.query, { page: String(props.page - 1) })}`}
                  className="min-h-[44px] border border-espresso px-4 py-2 text-espresso no-underline"
                >
                  Previous
                </a>
              )}
              {props.page < props.pageCount && (
                <a
                  href={`/admin/leads${toSearch(props.query, { page: String(props.page + 1) })}`}
                  className="min-h-[44px] border border-espresso px-4 py-2 text-espresso no-underline"
                >
                  Next
                </a>
              )}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
