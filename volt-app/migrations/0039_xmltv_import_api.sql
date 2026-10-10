-- ===========================================================================
--  XMLTV IMPORT FROM A HOSTED GUIDE API: keep the guide topped up N days ahead.
--
--  A URL source can now be a guide API rather than a static file:
--   request_mode   'single'  one request per run for the whole window
--                  'per_day' one request per day, today .. today + days_ahead,
--                            for APIs that serve a day at a time ({date})
--   days_ahead     how far ahead the guide is kept (programmes beyond it are
--                  not imported, and {to} in the URL is this far out)
--   min_days_ahead the floor: when any mapped channel's guide ends sooner than
--                  this, the run says so and owners and admins are alerted once
--   date_format    how {date}, {from} and {to} are written into the URL
--   request_headers sealed JSON of headers the API needs (an API key, say);
--                  only the names are ever sent back to the console
--   etag/last_modified/conditional_url  a scheduled run of an unchanged
--                  single-request guide is a 304, not a re-import
--   coverage_until the earliest point any mapped channel's imported guide ends
--   coverage_low_since  set while coverage is below the floor (alerts once)
--   consecutive_failures  failed scheduled runs retry sooner than the refresh
--                  interval: 15 min, 30, 60 ... capped at the interval
-- ===========================================================================
ALTER TABLE epg_import_sources
  ADD COLUMN IF NOT EXISTS request_mode TEXT NOT NULL DEFAULT 'single',
  ADD COLUMN IF NOT EXISTS days_ahead INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS min_days_ahead INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS date_format TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
  ADD COLUMN IF NOT EXISTS request_headers TEXT,
  ADD COLUMN IF NOT EXISTS etag TEXT,
  ADD COLUMN IF NOT EXISTS last_modified TEXT,
  ADD COLUMN IF NOT EXISTS conditional_url TEXT,
  ADD COLUMN IF NOT EXISTS coverage_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS coverage_low_since TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE epg_import_sources ADD CONSTRAINT epg_import_sources_request_mode_chk CHECK (request_mode IN ('single', 'per_day'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE epg_import_sources ADD CONSTRAINT epg_import_sources_days_chk
    CHECK (days_ahead BETWEEN 1 AND 21 AND min_days_ahead BETWEEN 0 AND 21 AND min_days_ahead <= days_ahead);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE epg_import_sources ADD CONSTRAINT epg_import_sources_date_format_chk CHECK (date_format IN ('YYYY-MM-DD', 'YYYYMMDD', 'DD/MM/YYYY', 'unix'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
