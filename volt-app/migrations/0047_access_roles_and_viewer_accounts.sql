-- 0047  Access roles, multi-role membership, viewer (public) accounts.
--
-- See ACCESS_CONTROL.md at the repository root for the model this supports.
--
-- 1. ROLES. user_groups become "access roles": a named set of per-feature
--    levels (none / view / operate / manage). System roles (is_system) are the
--    defaults every account gets (Administrator, Report & Analytics Manager,
--    Event Manager, Radio Manager, System Viewer); they can be copied but not
--    edited, so "Administrator" always means the same thing. `tier` is the
--    users.role a member is given (admin / operator / viewer).
-- 2. MEMBERSHIP. A user can hold several roles; effective access is the
--    highest level per feature across them. users.user_group_id is kept and
--    mirrored into the membership table for older clients.
-- 3. VIEWER ACCOUNTS. viewers gains what a hosted public account needs:
--    password, profile, status, verification, reset codes. A viewer is never a
--    users row and can never hold an admin session (separate token audience
--    and signing key, see src/auth/viewerTokens.ts).
-- 4. CHANGE NOTIFICATIONS for access data, so every API process drops cached
--    access the moment a role, membership or user changes (src/scale/cache.ts).

-- ---- 1. roles ------------------------------------------------------------------
ALTER TABLE user_groups ADD COLUMN IF NOT EXISTS is_system   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE user_groups ADD COLUMN IF NOT EXISTS role_key    TEXT;
ALTER TABLE user_groups ADD COLUMN IF NOT EXISTS tier        user_role NOT NULL DEFAULT 'operator';
ALTER TABLE user_groups ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_groups_role_key ON user_groups(account_id, role_key) WHERE role_key IS NOT NULL;

-- Groups written before 'monitoring' and 'fleet' existed: those screens were
-- open to every signed-in user, so keep them visible to existing members.
UPDATE user_groups
   SET permissions = permissions || '{"monitoring":"view","fleet":"view"}'::jsonb
 WHERE NOT is_system AND NOT (permissions ? 'monitoring');

-- ---- 2. membership ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_group_members (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id    UUID NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    granted_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_ugm_group ON user_group_members(group_id);

INSERT INTO user_group_members(user_id, group_id)
SELECT id, user_group_id FROM users WHERE user_group_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ---- 3. viewer accounts ------------------------------------------------------------
ALTER TABLE viewers ADD COLUMN IF NOT EXISTS password_hash       TEXT;
ALTER TABLE viewers ADD COLUMN IF NOT EXISTS display_name        TEXT;
ALTER TABLE viewers ADD COLUMN IF NOT EXISTS avatar_ref          TEXT;
ALTER TABLE viewers ADD COLUMN IF NOT EXISTS profile             JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE viewers ADD COLUMN IF NOT EXISTS status              TEXT NOT NULL DEFAULT 'active';
ALTER TABLE viewers ADD COLUMN IF NOT EXISTS source              TEXT NOT NULL DEFAULT 'external';
ALTER TABLE viewers ADD COLUMN IF NOT EXISTS email_verified_at   TIMESTAMPTZ;
ALTER TABLE viewers ADD COLUMN IF NOT EXISTS reset_code_hash     TEXT;
ALTER TABLE viewers ADD COLUMN IF NOT EXISTS reset_expires_at    TIMESTAMPTZ;
ALTER TABLE viewers ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
ALTER TABLE viewers ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT now();
DO $$ BEGIN
  ALTER TABLE viewers ADD CONSTRAINT viewers_status_chk CHECK (status IN ('active', 'disabled', 'deleted'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE viewers ADD CONSTRAINT viewers_source_chk CHECK (source IN ('hosted', 'external'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- One hosted login per email per account.
CREATE UNIQUE INDEX IF NOT EXISTS uq_viewers_hosted_email
    ON viewers(account_id, lower(email)) WHERE source = 'hosted' AND status <> 'deleted';

CREATE TABLE IF NOT EXISTS viewer_refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    viewer_id   UUID NOT NULL REFERENCES viewers(id) ON DELETE CASCADE,
    app_id      UUID REFERENCES apps(id) ON DELETE SET NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_vrt_viewer ON viewer_refresh_tokens(viewer_id) WHERE revoked_at IS NULL;

-- ---- 4. change notifications ---------------------------------------------------------
-- (volt_cache_notify() is defined in 0046.)
DROP TRIGGER IF EXISTS trg_cache_users ON users;
CREATE TRIGGER trg_cache_users
  AFTER DELETE OR UPDATE OF role, status, user_group_id, platform_role, account_id ON users
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('user', 'id');

DROP TRIGGER IF EXISTS trg_cache_user_groups ON user_groups;
CREATE TRIGGER trg_cache_user_groups
  AFTER INSERT OR UPDATE OR DELETE ON user_groups
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('ugroup', 'id');

DROP TRIGGER IF EXISTS trg_cache_user_group_members ON user_group_members;
CREATE TRIGGER trg_cache_user_group_members
  AFTER INSERT OR UPDATE OR DELETE ON user_group_members
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('user', 'user_id');

-- A viewer disabled or deleted: every process rejects that viewer's access
-- tokens at once (src/auth/viewerTokens.ts keeps the revocation list).
CREATE OR REPLACE FUNCTION volt_viewer_revoke_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'viewers' THEN
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.password_changed_at IS DISTINCT FROM OLD.password_changed_at THEN
      PERFORM pg_notify('volt_viewer_revoke', NEW.id::text);
    END IF;
  ELSE
    -- entitlements: a revoke or a shortened validity
    IF TG_OP = 'DELETE' THEN
      PERFORM pg_notify('volt_viewer_revoke', OLD.viewer_id::text);
    ELSIF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
      PERFORM pg_notify('volt_viewer_revoke', NEW.viewer_id::text);
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_viewer_revoke ON viewers;
CREATE TRIGGER trg_viewer_revoke AFTER UPDATE ON viewers
  FOR EACH ROW EXECUTE FUNCTION volt_viewer_revoke_notify();

DROP TRIGGER IF EXISTS trg_viewer_revoke_ent ON entitlements;
CREATE TRIGGER trg_viewer_revoke_ent AFTER UPDATE OR DELETE ON entitlements
  FOR EACH ROW EXECUTE FUNCTION volt_viewer_revoke_notify();
