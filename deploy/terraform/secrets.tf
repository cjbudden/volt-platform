# App secrets live in Secrets Manager and are injected into tasks by reference —
# never baked into images or the DB. DRM (Axinom) management keys + social OAuth
# tokens get their own secrets you populate out-of-band; the app stores only ARNs.
resource "random_password" "db" {
  length  = 24
  special = false
}

resource "random_password" "jwt_access" {
  length  = 40
  special = false
}

resource "random_password" "jwt_refresh" {
  length  = 40
  special = false
}

resource "random_password" "ingest" {
  length  = 32
  special = false
}

locals {
  jwt_access  = coalesce(var.jwt_access_secret, random_password.jwt_access.result)
  jwt_refresh = coalesce(var.jwt_refresh_secret, random_password.jwt_refresh.result)
  ingest      = coalesce(var.ingest_token, random_password.ingest.result)
  db_password = random_password.db.result
  # Queries go through RDS Proxy when enabled (scaling_rds_proxy.tf); the
  # LISTEN / leader-lock / migration connection always goes direct.
  db_url        = "postgres://${var.db_username}:${local.db_password}@${local.db_app_host}:5432/${var.db_name}"
  db_listen_url = "postgres://${var.db_username}:${local.db_password}@${local.db_direct_host}:5432/${var.db_name}"
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name}/app"
  description             = "Volt control-plane runtime secrets"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    DATABASE_URL       = local.db_url
    JWT_ACCESS_SECRET  = local.jwt_access
    JWT_REFRESH_SECRET = local.jwt_refresh
    INGEST_TOKEN       = local.ingest
    # Scale (SCALING.md)
    DATABASE_LISTEN_URL   = local.db_listen_url
    EDGE_SHARED_SECRET    = random_password.edge_shared.result
    PLAYBACK_TOKEN_SECRET = random_password.playback_token.result
    VIEWER_JWT_SECRET     = random_password.viewer_jwt.result
    # Seals authenticator-app seeds at rest (ACCESS_CONTROL.md section 12).
    MFA_ENCRYPTION_KEY = random_id.mfa_key.b64_std
  })
}

# Placeholder for DRM + social credentials — populate after apply. The app takes
# ARNs (drm auth_ref, publish_targets.credentials_ref), never the raw values.
resource "aws_secretsmanager_secret" "integrations" {
  name                    = "${local.name}/integrations"
  description             = "Axinom DRM management key + social OAuth tokens (populate out-of-band)"
  recovery_window_in_days = 0
}

# Scale: proves a request came through CloudFront (trusted viewer country), and
# signs playback tokens with a key separate from operator sessions.
resource "random_password" "edge_shared" {
  length  = 40
  special = false
}

resource "random_password" "playback_token" {
  length  = 40
  special = false
}

# Signs public-user (viewer) sessions: never the key that signs admin sessions.
resource "random_password" "viewer_jwt" {
  length  = 48
  special = false
}

# 32 random bytes: the AES-256-GCM key for authenticator-app seeds. Rotating it
# makes existing authenticator set-ups unreadable (people set them up again),
# so it is created once and kept.
resource "random_id" "mfa_key" {
  byte_length = 32
}
