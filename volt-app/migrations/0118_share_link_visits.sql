-- ============================================================================
--  0118: A SHARE LINK VIEW IS COUNTED ONCE PER VISIT (build queue 1.14-G3a-3).
--
--  The preview page asked the server for the stream on every load, on Check
--  again and when its playback token ran out, and each of those counted as a
--  view. A link limited to one view was used up by a reload, and the view
--  count told the sender nothing. The page now sends a visit id it keeps for
--  as long as its browser tab is open; the first open of a visit counts, and
--  a visit that has already counted is let back in under the view limit it
--  used. A client that sends no visit id is counted every time, as before.
--
--  One row per counted visit. The rows go with their link.
-- ============================================================================
CREATE TABLE IF NOT EXISTS share_link_visits (
  share_link_id UUID NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  visit_id      TEXT NOT NULL,
  first_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (share_link_id, visit_id)
);
