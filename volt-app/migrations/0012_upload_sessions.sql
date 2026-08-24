-- ============================================================================
--  RESUMABLE UPLOADS.
--
--  A browser upload dies the moment the page unloads: fetch and XHR are torn
--  down with the document. Nothing changes that. What CAN change is the cost of
--  it happening — and the answer is to make the upload a thing the SERVER knows
--  about, rather than a single request the client is holding open.
--
--  A file is cut into fixed-size chunks and each one is PUT to its own address.
--  The server records which chunk indices have arrived. Come back after a crash,
--  a tab close, or three days later, and the client asks which chunks are
--  already there and sends only the rest. A two-gigabyte loop interrupted at 90%
--  costs one chunk, not two gigabytes.
--
--  CHUNKS ARE INDEPENDENTLY ADDRESSED, and that is load-bearing rather than
--  incidental. Because chunk 47 means the same thing whenever it arrives, they
--  can be sent in any order and in parallel — which is exactly the shape the
--  Background Fetch API needs, since it takes a list of requests and gives no
--  ordering guarantee. A protocol that required sequential appends could not use
--  it at all.
--
--  THE SESSION IS ITS OWN CREDENTIAL. Chunks are uploaded by a service worker
--  that cannot see the user's access token, and a fifteen-minute JWT would
--  expire in the middle of a large file anyway. Each session carries a random
--  capability token instead: it authorises exactly one session, only chunk and
--  finish operations, and it dies with the session. This is what a presigned URL
--  is, spelled out.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE upload_state AS ENUM (
    'open',       -- accepting chunks
    'assembling', -- every chunk arrived; the file is being put together
    'complete',   -- the bytes are in the store and the asset row points at them
    'aborted',    -- abandoned by the client
    'expired'     -- left open too long and swept
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS upload_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Who opened it. Kept for the audit trail; the token is what authorises the
  -- chunks, not this.
  opened_by     uuid REFERENCES users(id) ON DELETE SET NULL,

  -- The capability token. Random, unguessable, scoped to this session alone.
  token         text NOT NULL,

  -- What is being uploaded, and what it becomes.
  purpose       text NOT NULL DEFAULT 'filler',   -- 'filler' today; the mechanism is general
  filler_kind   filler_kind,                      -- 'slate' | 'loop' when purpose = 'filler'
  filler_asset_id uuid REFERENCES filler_assets(id) ON DELETE CASCADE,

  filename      text NOT NULL,
  content_type  text NOT NULL DEFAULT 'application/octet-stream',
  total_bytes   bigint NOT NULL CHECK (total_bytes > 0),
  chunk_size    int    NOT NULL CHECK (chunk_size > 0),
  chunk_count   int    NOT NULL CHECK (chunk_count > 0),

  -- WHICH CHUNKS HAVE ARRIVED, as a sorted array of indices.
  --
  -- An array rather than a count, because a count cannot answer the only
  -- question resume actually asks: not "how many do you have" but "which ones
  -- are missing". With out-of-order and parallel chunk delivery those are
  -- different questions, and only the second one is useful.
  received      int[] NOT NULL DEFAULT '{}',
  received_bytes bigint NOT NULL DEFAULT 0,

  state         upload_state NOT NULL DEFAULT 'open',
  error         text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- An abandoned session holds disk. Swept after this, and extended by every
  -- chunk that arrives, so a slow upload is never swept out from under itself.
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '7 days',

  CONSTRAINT upload_sessions_token_unique UNIQUE (token)
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_account ON upload_sessions (account_id, created_at DESC);
-- The sweep's query: open sessions past their expiry, a set that is normally
-- empty.
CREATE INDEX IF NOT EXISTS idx_upload_sessions_expired
  ON upload_sessions (expires_at)
  WHERE state IN ('open', 'assembling');

-- ---------------------------------------------------------------------------
--  Filler assets grow the fields an upload actually knows.
--
--  `status` already exists but nothing ever moved it off 'uploading', because
--  the upload flow returned a stubbed S3 URL that nothing wrote to. These are
--  the facts a completed upload has, as opposed to the ones a probe would add.
-- ---------------------------------------------------------------------------
ALTER TABLE filler_assets
  ADD COLUMN IF NOT EXISTS bytes        bigint,
  ADD COLUMN IF NOT EXISTS content_type text,
  ADD COLUMN IF NOT EXISTS filename     text,
  ADD COLUMN IF NOT EXISTS uploaded_at  timestamptz,
  ADD COLUMN IF NOT EXISTS error        text;
