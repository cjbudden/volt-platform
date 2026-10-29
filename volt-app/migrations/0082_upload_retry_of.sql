-- RE-UPLOADING A FILE WHOSE ENCODE FAILED (25 Oct 2026).
-- The panel spots that a file about to be uploaded matches a library record whose encode
-- failed and asks what to do; the answer rides on the upload session and is applied when
-- the bytes land (services/uploads.ts completeLanded):
--   { "assetId": "<failed record>", "action": "reattach" | "replace" | "new" }
--   reattach  the new file becomes the source of the existing record (id, metadata, links
--             kept), which is encoded again; the placeholder record of the upload is dropped
--   replace   the failed record is deleted and the upload becomes a new record
--   new       both stay
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS retry_of JSONB;
