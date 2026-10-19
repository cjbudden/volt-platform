-- Audit log report (docs/AUDIT_LOG.md): filters by action, entity and person
-- over an account's history stay index-backed as the log grows.
CREATE INDEX IF NOT EXISTS idx_audit_account_action ON audit_log(account_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_account_entity ON audit_log(account_id, entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_account_user   ON audit_log(account_id, user_id, created_at DESC);
