-- ============================================================================
--  0119: A TUS UPLOAD SESSION HAS NO CHUNKS (found by build queue 2.1a-2).
--
--  tus uploads (modules/tus.ts), ingest rule uploads (modules/ingestRules.ts)
--  and server-side transfers (services/ingest/transfers.ts) are upload
--  sessions whose bytes do not arrive as numbered chunks, and mark that with
--  chunk_count = 0 so the chunk endpoint refuses every index for them. 0012
--  allowed only chunk_count > 0, so each of those three answered 500 on
--  Postgres: the tus endpoint had never created an upload outside the memory
--  store its protocol test uses.
-- ============================================================================
ALTER TABLE upload_sessions DROP CONSTRAINT IF EXISTS upload_sessions_chunk_count_check;
ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_chunk_count_check CHECK (chunk_count >= 0);
