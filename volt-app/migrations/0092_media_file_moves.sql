-- ============================================================================
--  0092: MOVED LIBRARY IMAGES FORWARD (docs/IMAGES.md section 18).
--
--  Moving an image to another folder changes its store key. References in the
--  database are rewritten (services/media/libraryMoves.ts); this table keeps
--  the old key so reads from outside the database (a link in a web page, a
--  partner feed, a signed image URL) still find the image: the image store
--  follows old_key -> new_key when the old key is not there. Chains collapse to
--  the newest place; moving an image back removes its forwarding.
-- ============================================================================
CREATE TABLE IF NOT EXISTS media_file_moves (
  old_key     TEXT PRIMARY KEY,          -- library/<account>/<old path>
  new_key     TEXT NOT NULL,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  moved_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_file_moves_new ON media_file_moves (new_key);
