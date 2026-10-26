-- When a refresh token was spent by ROTATION (not revoked by sign-out or a
-- password change). Two console tabs share one cookie, so both can present
-- the same token within a moment of each other; the second is allowed a short
-- grace instead of signing that tab out (auth/routes.ts /refresh).
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;
