-- ============================================================================
--  0096 PLAYER EVENTS ON AN ON-DEMAND AD CAN REPEAT (build queue 1.14k-5).
--
--  A viewer can pause, resume, mute and unmute an ad more than once, and the
--  ad server counts each one (VAST 4.1 tracking events). vod_ad_events kept one
--  row per session, break, ad, event and URL, so the second pause was never
--  sent. `seq` numbers the repeats (the player sends it as `n`): each one is
--  claimed once, so a request the player resends after a network error still
--  reaches the ad server once. Server-side events (impression, quartiles,
--  click) stay at seq 0, once each, as before.
-- ============================================================================
ALTER TABLE vod_ad_events ADD COLUMN IF NOT EXISTS seq INTEGER NOT NULL DEFAULT 0;

-- The old once-only key (created inline in 0086, so its name is Postgres's own).
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'vod_ad_events'::regclass AND contype = 'u' LOOP
    EXECUTE format('ALTER TABLE vod_ad_events DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vod_ad_events_once ON vod_ad_events(session_id, break_index, pod_index, event, url_index, seq);
