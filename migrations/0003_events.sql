-- 0003_events.sql — analytics, stored as daily aggregates only.
--
-- There is no `events` table here, and that absence is the design rather than an omission.
-- Requirement 20.2 forbids storing any per-visitor identifier — no cookie id, no fingerprint,
-- no retained client address — so there is nothing a raw event row could be keyed by that
-- would make it more useful than the aggregate. Incrementing a counter per (day, type, entity)
-- means the most a compromised database can reveal is "on 14 March, 37 people viewed this
-- sofa", which is a fact about a product and not about a person.
--
-- It also keeps D1 inside the free tier indefinitely: the row count grows with the catalogue
-- and the calendar, not with traffic.
--
-- The primary keys are the upsert targets. `ON CONFLICT (day, type, entity) DO UPDATE SET
-- count = count + excluded.count` is what makes a rollup write idempotent-by-addition and
-- safe under concurrency, so two Workers flushing the same batch second cannot lose a count.
--
-- Design: Conversion → Analytics.
-- Requirements: 20.1, 20.2, 20.3, 20.5, 20.11.

CREATE TABLE IF NOT EXISTS event_daily (
  day    TEXT    NOT NULL,               -- 'YYYY-MM-DD', server clock, UTC
  type   TEXT    NOT NULL,               -- product_view|category_view|whatsapp_click|call_click|search|enquiry_submit|quick_enquire_open|gallery_open
  entity TEXT    NOT NULL DEFAULT '',    -- product slug, category slug, or '' where the type has no subject
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, type, entity)
);

CREATE TABLE IF NOT EXISTS search_queries (
  day     TEXT    NOT NULL,
  query   TEXT    NOT NULL,              -- normalised (trimmed, lowercased) query text
  count   INTEGER NOT NULL DEFAULT 0,
  -- The result count from the most recent occurrence that day. Nullable because a batch may
  -- report a search without one; a zero-result search is `results = 0`, which is a different
  -- and much more interesting fact than "unknown" (Requirement 20.5).
  results INTEGER,
  PRIMARY KEY (day, query)
);

-- The analytics view always reads a date range and ranks within it. Both indexes serve the
-- leading `day` bound; without them every range read is a full scan of the whole history.
CREATE INDEX IF NOT EXISTS event_daily_day_type ON event_daily(day, type);
CREATE INDEX IF NOT EXISTS search_queries_day ON search_queries(day);
