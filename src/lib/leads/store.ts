/**
 * Lead persistence and querying, over D1.
 *
 * Every SQL statement here is parameterised. That is not a style preference: `q` is a
 * free-text search box on a table of personal data, so string interpolation would put the
 * lead store one typo away from an injection (Requirement 25.2). The `LIKE` patterns are
 * bound as values, and the only thing this module ever concatenates into SQL is a fixed
 * number of `?` placeholders it generated itself.
 *
 * Two shapes are worth naming:
 *
 * - **`insertLead` takes an already-resolved record.** Requirement 6.6 says the product
 *   name, SKU and canonical URL attached to a lead are resolved on the server from the
 *   referenced identifier, never taken from the browser. Keeping that resolution *outside*
 *   this module and requiring the resolved values as arguments means the store has no
 *   parameter a client value could flow into unresolved.
 * - **The row type and the API type are the same shape.** The leads admin displays
 *   everything Requirement 6.12 lists, so there is nothing to project away, and a
 *   projection would be another place for a field to go missing.
 *
 * Design: Conversion → Lead capture.
 * Requirements: 6.6, 6.7, 6.10, 6.12, 6.13, 6.14, 6.15, 6.16, 25.2, 25.7.
 */

import { z } from 'zod';

import type { D1Database } from '@cloudflare/workers-types';

import { safeText } from '@/lib/security/sanitize';

export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'FOLLOW_UP', 'CONVERTED', 'CLOSED'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_TYPES = ['QUICK_ENQUIRE', 'CALLBACK', 'QUOTE', 'CUSTOM', 'CONTACT'] as const;
export type LeadType = (typeof LEAD_TYPES)[number];

export const LeadStatusSchema = z.enum(LEAD_STATUSES);

/** One stored lead, exactly as the admin list renders it. */
export interface Lead {
  id: string;
  createdAt: string;
  type: LeadType;
  name: string;
  phone: string;
  message: string;
  productSlug: string | null;
  productName: string | null;
  productSku: string | null;
  productUrl: string | null;
  budget: string | null;
  dimensions: string | null;
  /** R2 key under the quarantined prefix. Rendered in this admin only (6.11). */
  imageKey: string | null;
  sourcePath: string | null;
  referrer: string | null;
  country: string | null;
  status: LeadStatus;
  note: string | null;
  spamScore: number;
}

/** What `insertLead` needs. Product fields are server-resolved by the caller. */
export interface NewLead {
  id: string;
  createdAt: string;
  type: LeadType;
  name: string;
  phone: string;
  message: string;
  productSlug?: string | null;
  productName?: string | null;
  productSku?: string | null;
  productUrl?: string | null;
  budget?: string | null;
  dimensions?: string | null;
  imageKey?: string | null;
  sourcePath?: string | null;
  referrer?: string | null;
  uaHash?: string | null;
  country?: string | null;
  note?: string | null;
  spamScore?: number;
}

interface LeadRow {
  id: string;
  created_at: string;
  type: string;
  name: string;
  phone: string;
  message: string;
  product_slug: string | null;
  product_name: string | null;
  product_sku: string | null;
  product_url: string | null;
  budget: string | null;
  dimensions: string | null;
  image_key: string | null;
  source_path: string | null;
  referrer: string | null;
  country: string | null;
  status: string;
  note: string | null;
  spam_score: number | null;
}

function isLeadStatus(value: string): value is LeadStatus {
  return (LEAD_STATUSES as readonly string[]).includes(value);
}

function isLeadType(value: string): value is LeadType {
  return (LEAD_TYPES as readonly string[]).includes(value);
}

/** `safeText` over a nullable column, keeping `null` as `null`. */
function safeNullable(value: string | null): string | null {
  return value === null ? null : safeText(value);
}

/**
 * A stored row as a `Lead`.
 *
 * **Every visitor-supplied field is sanitized on the way out** (Requirement 25.2, Property 55). This
 * is the highest-value application of it on the site: a lead's name, message, budget and dimensions
 * are the only strings on this system written by an anonymous member of the public, and they are
 * rendered into an *authenticated* surface — the admin lead table and detail panel — where a stored
 * payload would execute with an operator's session. Doing it here rather than in `LeadTable.tsx`
 * covers the CSV export and any future surface with the same guarantee.
 *
 * The phone number is not sanitized because it is already normalised to E.164 by the schema on the
 * way in, and `imageKey`/`sourcePath` are server-generated.
 */
function toLead(row: LeadRow): Lead {
  return {
    id: row.id,
    createdAt: row.created_at,
    // A row whose enum was written outside this module is reported as-is rather than
    // dropped: a lead is a person waiting for a call back, and hiding it would be worse
    // than showing an unexpected label.
    type: isLeadType(row.type) ? row.type : 'CONTACT',
    name: safeText(row.name),
    phone: row.phone,
    message: safeText(row.message),
    productSlug: row.product_slug,
    productName: safeNullable(row.product_name),
    productSku: safeNullable(row.product_sku),
    productUrl: row.product_url,
    budget: safeNullable(row.budget),
    dimensions: safeNullable(row.dimensions),
    imageKey: row.image_key,
    sourcePath: row.source_path,
    referrer: row.referrer,
    country: row.country,
    status: isLeadStatus(row.status) ? row.status : 'NEW',
    note: safeNullable(row.note),
    spamScore: row.spam_score ?? 0,
  };
}

/** `lead_` + 12 base36 characters. */
export function generateLeadId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (const byte of bytes) suffix += chars[byte % chars.length];
  return `lead_${suffix}`;
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/** Store exactly one lead with `NEW` status (Requirement 6.7). */
export async function insertLead(db: D1Database, lead: NewLead): Promise<void> {
  await db
    .prepare(
      'INSERT INTO leads (id, created_at, type, name, phone, message, product_slug, product_name, ' +
        'product_sku, product_url, budget, dimensions, image_key, source_path, referrer, ua_hash, ' +
        'country, status, note, spam_score) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      lead.id,
      lead.createdAt,
      lead.type,
      lead.name,
      lead.phone,
      lead.message,
      lead.productSlug ?? null,
      lead.productName ?? null,
      lead.productSku ?? null,
      lead.productUrl ?? null,
      lead.budget ?? null,
      lead.dimensions ?? null,
      lead.imageKey ?? null,
      lead.sourcePath ?? null,
      lead.referrer ?? null,
      lead.uaHash ?? null,
      lead.country ?? null,
      'NEW',
      lead.note ?? null,
      lead.spamScore ?? 0,
    )
    .run();
}

/**
 * Update a lead's status and/or note.
 *
 * Both are optional and a call with neither changes nothing rather than blanking the row.
 * The status is the **only** record of a conversion anywhere in this system
 * (Requirement 20.12): no visitor event infers one.
 */
export async function updateLead(
  db: D1Database,
  id: string,
  patch: { status?: LeadStatus; note?: string | null },
): Promise<Lead | null> {
  const assignments: string[] = [];
  const values: (string | null)[] = [];
  if (patch.status !== undefined) {
    assignments.push('status = ?');
    values.push(patch.status);
  }
  if (patch.note !== undefined) {
    assignments.push('note = ?');
    values.push(patch.note);
  }
  if (assignments.length > 0) {
    await db
      .prepare(`UPDATE leads SET ${assignments.join(', ')} WHERE id = ?`)
      .bind(...values, id)
      .run();
  }
  return await getLead(db, id);
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function getLead(db: D1Database, id: string): Promise<Lead | null> {
  const row = await db.prepare('SELECT * FROM leads WHERE id = ?').bind(id).first<LeadRow>();
  return row === null ? null : toLead(row);
}

export interface LeadQuery {
  status?: LeadStatus;
  /** Free text over name, phone, message, product name and SKU. */
  q?: string;
  /** Inclusive `YYYY-MM-DD` bounds on the server-recorded date. */
  from?: string;
  to?: string;
  page?: number;
}

export const LEADS_PAGE_SIZE = 50;

/** Parse the query string, ignoring anything unrecognised or malformed. */
export function parseLeadQuery(params: URLSearchParams): LeadQuery {
  const query: LeadQuery = {};

  const status = params.get('status');
  if (status !== null && isLeadStatus(status)) query.status = status;

  const q = params.get('q')?.trim();
  if (q !== undefined && q !== '') query.q = q.slice(0, 120);

  const isDate = (value: string | null): value is string =>
    value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const from = params.get('from');
  if (isDate(from)) query.from = from;
  const to = params.get('to');
  if (isDate(to)) query.to = to;

  const page = Number.parseInt(params.get('page') ?? '', 10);
  if (Number.isFinite(page) && page > 0) query.page = page;

  return query;
}

interface WhereClause {
  sql: string;
  values: (string | number)[];
}

/**
 * The filter, as one clause shared by the list, the count and the export.
 *
 * Sharing it is what makes "the export is scoped to the current filters"
 * (Requirement 6.15) true by construction rather than by two implementations agreeing.
 */
function whereFor(query: LeadQuery): WhereClause {
  const conditions: string[] = [];
  const values: (string | number)[] = [];

  if (query.status !== undefined) {
    conditions.push('status = ?');
    values.push(query.status);
  }
  if (query.from !== undefined) {
    // `created_at` is an ISO 8601 instant, so a date comparison is a string comparison
    // against the start of that day.
    conditions.push('created_at >= ?');
    values.push(`${query.from}T00:00:00.000Z`);
  }
  if (query.to !== undefined) {
    conditions.push('created_at <= ?');
    values.push(`${query.to}T23:59:59.999Z`);
  }
  if (query.q !== undefined) {
    // Escape the LIKE metacharacters so a search for "100%" is not a wildcard.
    const pattern = `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    conditions.push(
      "(name LIKE ?1 ESCAPE '\\' OR phone LIKE ?1 ESCAPE '\\' OR message LIKE ?1 ESCAPE '\\' " +
        "OR COALESCE(product_name, '') LIKE ?1 ESCAPE '\\' OR COALESCE(product_sku, '') LIKE ?1 ESCAPE '\\')",
    );
    values.push(pattern);
  }

  return {
    sql: conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`,
    values,
  };
}

/**
 * Numbered placeholders and positional binding do not mix.
 *
 * The `q` condition reuses `?1` five times, which means every other placeholder in the
 * statement has to be numbered too — D1 binds `?1` to the first argument, and a bare `?`
 * alongside it would take the *next* position rather than the next argument. So the clause
 * is rendered with explicit indices, assigned in binding order.
 */
function numbered(clause: WhereClause): string {
  let index = 0;
  return clause.sql.replace(/\?(?!\d)/g, () => {
    index += 1;
    return `?${String(index)}`;
  });
}

export interface LeadPage {
  items: Lead[];
  total: number;
  page: number;
  pageCount: number;
  /** True when any filter is applied — the empty state depends on it. */
  filtered: boolean;
}

export async function queryLeads(db: D1Database, query: LeadQuery): Promise<LeadPage> {
  const clause = whereFor(query);
  const where = numbered(clause);

  const counted = await db
    .prepare(`SELECT COUNT(*) AS total FROM leads${where}`)
    .bind(...clause.values)
    .first<{ total: number }>();
  const total = counted?.total ?? 0;

  const pageCount = Math.max(1, Math.ceil(total / LEADS_PAGE_SIZE));
  const page = Math.min(Math.max(1, query.page ?? 1), pageCount);
  const offset = (page - 1) * LEADS_PAGE_SIZE;

  const limitIndex = clause.values.length + 1;
  const { results } = await db
    .prepare(
      `SELECT * FROM leads${where} ORDER BY created_at DESC, id DESC ` +
        `LIMIT ?${String(limitIndex)} OFFSET ?${String(limitIndex + 1)}`,
    )
    .bind(...clause.values, LEADS_PAGE_SIZE, offset)
    .all<LeadRow>();

  return {
    items: (results ?? []).map(toLead),
    total,
    page,
    pageCount,
    filtered:
      query.status !== undefined ||
      query.q !== undefined ||
      query.from !== undefined ||
      query.to !== undefined,
  };
}

/** Every lead matching the filter, for the export. Bounded so one query cannot run away. */
export async function queryLeadsForExport(
  db: D1Database,
  query: LeadQuery,
  limit = 5000,
): Promise<Lead[]> {
  const clause = whereFor(query);
  const where = numbered(clause);
  const limitIndex = clause.values.length + 1;
  const { results } = await db
    .prepare(
      `SELECT * FROM leads${where} ORDER BY created_at DESC, id DESC LIMIT ?${String(limitIndex)}`,
    )
    .bind(...clause.values, limit)
    .all<LeadRow>();
  return (results ?? []).map(toLead);
}

/** How many leads are in each status — the dashboard's `newLeads` card reads `NEW`. */
export async function countLeadsByStatus(db: D1Database): Promise<Record<LeadStatus, number>> {
  const counts: Record<LeadStatus, number> = {
    NEW: 0,
    CONTACTED: 0,
    FOLLOW_UP: 0,
    CONVERTED: 0,
    CLOSED: 0,
  };
  const { results } = await db
    .prepare('SELECT status, COUNT(*) AS total FROM leads GROUP BY status')
    .all<{ status: string; total: number }>();
  for (const row of results ?? []) {
    if (isLeadStatus(row.status)) counts[row.status] = row.total;
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

const CSV_COLUMNS: readonly (readonly [string, (lead: Lead) => string])[] = [
  ['id', (lead) => lead.id],
  ['received', (lead) => lead.createdAt],
  ['type', (lead) => lead.type],
  ['status', (lead) => lead.status],
  ['name', (lead) => lead.name],
  ['phone', (lead) => lead.phone],
  ['message', (lead) => lead.message],
  ['product', (lead) => lead.productName ?? ''],
  ['product_sku', (lead) => lead.productSku ?? ''],
  ['product_url', (lead) => lead.productUrl ?? ''],
  ['budget', (lead) => lead.budget ?? ''],
  ['dimensions', (lead) => lead.dimensions ?? ''],
  ['source_page', (lead) => lead.sourcePath ?? ''],
  ['note', (lead) => lead.note ?? ''],
  ['spam_score', (lead) => String(lead.spamScore)],
];

/**
 * One CSV field.
 *
 * The leading apostrophe on a value starting with `=`, `+`, `-` or `@` is deliberate and is
 * the reason this function exists rather than a `join(',')`. A lead's name and message are
 * attacker-controlled text, and the operator will open this file in a spreadsheet: a value
 * beginning `=` is a formula there, which is a real remote-code path through a CSV
 * (Requirement 25.10's spirit — untrusted text must not be executable wherever it lands).
 * Quoting alone does not prevent it; the prefix does, and the visible apostrophe is a
 * smaller cost than a spreadsheet that dials a URL.
 */
export function csvField(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** The filtered leads as CSV, newline-terminated, with a header row. */
export function leadsToCsv(leads: readonly Lead[]): string {
  const header = CSV_COLUMNS.map(([name]) => csvField(name)).join(',');
  const rows = leads.map((lead) => CSV_COLUMNS.map(([, read]) => csvField(read(lead))).join(','));
  // CRLF: the line ending every spreadsheet on the operator's desk agrees on.
  return `${[header, ...rows].join('\r\n')}\r\n`;
}

/** `leads-2026-03-14.csv` — dated so successive exports do not overwrite each other. */
export function csvFilename(now: Date = new Date()): string {
  return `leads-${now.toISOString().slice(0, 10)}.csv`;
}
