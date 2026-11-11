-- BULK REMOVE, A SHORTER HOLD FOR LIBRARY DELETES, AND MANAGEMENT CONFIRMATION
-- FOR BULK ACTIONS (9 Nov 2026). docs/RETENTION.md, docs/BULK_ACTIONS.md.
--
-- 1. The restore bin also holds packaged media from the S3 origin bucket
--    (vod/<id>/: HLS, DASH, FAST ladder variants), moved inside the bucket to
--    trash/<item>/. Before this the bucket copy was never moved or deleted.
-- 2. An account can require a second person, an administrator or owner, to
--    confirm a bulk action before it runs. Off by default.
-- 3. A bulk action waiting for that confirmation is a request: what, which
--    items, who asked, who decided, and how it went.

ALTER TABLE trash_items ADD COLUMN IF NOT EXISTS objects JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bulk_needs_approval BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS bulk_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  action          TEXT NOT NULL,                       -- 'vod.remove'
  item_ids        TEXT[] NOT NULL,
  -- what the requester saw when asking: [{ "id", "name" }], so the approver
  -- reads the same list even if titles change meanwhile
  items           JSONB NOT NULL DEFAULT '[]'::jsonb,
  note            TEXT,
  state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'failed')),
  requested_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_label TEXT,
  decided_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_label   TEXT,
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT,
  -- what running it did: { "done": [...], "refused": [...] }
  result          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX IF NOT EXISTS bulk_requests_pending ON bulk_requests (account_id, created_at DESC) WHERE state = 'pending';
