-- 0002_leads.sql — enquiry leads.
--
-- Leads are personal data: a name, a phone number, and whatever the visitor chose to
-- tell us. They are therefore in D1 and **never** in the content repository — the path
-- allowlist (src/lib/github/paths.ts) admits only `data/**` *.json files, so there is no
-- code path that could commit one even by mistake (Requirement 6.16).
--
-- Leads are also the one dataset that must be readable the instant it is written: an
-- enquiry the operator cannot see until the next site build is a lost sale. That is the
-- other half of why they are here and not in Git.
--
-- `ua_hash` is a salted hash of the user agent, kept for bot filtering only. No IP
-- address is stored: `country` comes from the edge and is coarse enough not to identify
-- anyone.
--
-- Design: Conversion → Lead capture.
-- Requirements: 6.7, 6.10, 6.11, 6.12, 6.13, 6.14, 6.16, 25.7.

CREATE TABLE IF NOT EXISTS leads (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,               -- server clock, ISO 8601 (Requirement 6.7)
  type         TEXT NOT NULL,               -- QUICK_ENQUIRE|CALLBACK|QUOTE|CUSTOM|CONTACT
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,               -- canonical E.164 (Requirement 6.4)
  message      TEXT NOT NULL,
  product_slug TEXT,
  product_name TEXT,                        -- server-resolved, never client-supplied (6.6)
  product_sku  TEXT,
  product_url  TEXT,
  budget       TEXT,
  dimensions   TEXT,
  image_key    TEXT,                        -- quarantined R2 prefix; admin-only (6.11)
  source_path  TEXT,                        -- originating page path (6.7, 6.12)
  referrer     TEXT,
  ua_hash      TEXT,
  country      TEXT,
  status       TEXT NOT NULL DEFAULT 'NEW', -- NEW|CONTACTED|FOLLOW_UP|CONVERTED|CLOSED
  note         TEXT,
  spam_score   INTEGER DEFAULT 0            -- marked, not discarded (Requirement 6.10)
);

-- The leads admin lists by status and sorts newest first, and the dashboard counts NEW.
-- Both are covered by this one index.
CREATE INDEX IF NOT EXISTS leads_status_created ON leads(status, created_at DESC);

-- The unfiltered list is also newest-first, which the composite index above cannot serve
-- without a status prefix.
CREATE INDEX IF NOT EXISTS leads_created ON leads(created_at DESC);
