# ---- Control-plane settings that are not infrastructure ----------------------
# Build queue 2.1. Every environment variable the control plane reads is either
# set by this stack (the env lists in ecs_services.tf, scaling_services.tf,
# images.tf, docs_access.tf, qoe_raw.tf and here) or listed in
# env-coverage.json with the reason its built-in default is right on AWS.
# scripts/deploy/check-terraform-env.mjs holds the code and this file together,
# so a new setting in the app cannot quietly run on its Mac default in AWS.

variable "deployment" {
  description = "VOLT_DEPLOYMENT. single: one customer runs its own Volt and the account owner sets the plan. saas: many customers on one platform and only platform staff change plans (PLAN_AND_GROUPS.md)."
  type        = string
  default     = "single"
  validation {
    condition     = contains(["single", "saas"], var.deployment)
    error_message = "deployment must be single or saas."
  }
}

variable "ingest_s3_accelerate" {
  description = "Uploads from the console go straight to the origin bucket through S3 Transfer Acceleration (faster from far away, billed per GB accelerated). false: the regional endpoint."
  type        = bool
  default     = true
}

variable "media_archive_enabled" {
  description = "MEDIA_ARCHIVE_ENABLED. Lets the storage ladder move media to the cold and archive tiers (Glacier Instant Retrieval, then Glacier Flexible Retrieval). Off: media stays in S3 Standard until deleted."
  type        = bool
  default     = false
}

variable "upload_cors_origins" {
  description = "Browser origins allowed to PUT uploads into the origin bucket. Empty: the console's own address (public_base_url, else the API edge, else the ALB)."
  type        = list(string)
  default     = []
}

variable "app_env" {
  description = "Extra control-plane settings that are not secret, as NAME = value (for example NOTIFY_FROM, SITE_BASE_URL, SIGNUP_MODE). env-coverage.json lists which ones are meant to be set this way. Cannot override a setting this stack already sets."
  type        = map(string)
  default     = {}
  validation {
    condition     = alltrue([for k in keys(var.app_env) : can(regex("^[A-Z][A-Z0-9_]*$", k))])
    error_message = "app_env names must be upper case environment variable names."
  }
}

variable "app_secret_keys" {
  description = "Extra control-plane secrets (for example SMTP_URL, GOOGLE_CLIENT_SECRET). Put each as a JSON key in the integrations secret first, then list its name here; a listed key missing from the secret stops the tasks from starting."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for k in var.app_secret_keys : can(regex("^[A-Z][A-Z0-9_]*$", k))])
    error_message = "app_secret_keys must be upper case environment variable names."
  }
}

# Seals linked social accounts' tokens at rest (services/social/crypto.ts). Its
# own key, so rotating the session signing secret does not make every linked
# account unreadable. Created once and kept, like the MFA key.
resource "random_id" "social_token_key" {
  byte_length = 32
}

# Presigned uploads on the accelerate endpoint fail unless the bucket has
# acceleration on (services/ingest/providers/s3accel.ts).
resource "aws_s3_bucket_accelerate_configuration" "origin" {
  count  = var.ingest_s3_accelerate ? 1 : 0
  bucket = aws_s3_bucket.origin.id
  status = "Enabled"
}

locals {
  app_settings_env = [
    { name = "VOLT_DEPLOYMENT", value = var.deployment },
    # On AWS media lives in the bucket: with the local driver clips and uploads
    # would sit on a Fargate task's disk and vanish with the task.
    { name = "MEDIA_STORE_DRIVER", value = "s3" },
    { name = "MEDIA_ARCHIVE_ENABLED", value = var.media_archive_enabled ? "true" : "false" },
    { name = "INGEST_DESTINATION", value = "s3" },
    { name = "INGEST_S3_ACCELERATE", value = var.ingest_s3_accelerate ? "true" : "false" },
    # S3 watch folders hear about drops from the bucket (watchfolders.tf).
    { name = "WATCH_S3_QUEUE_URL", value = aws_sqs_queue.watch_drops.url },
  ]

  app_settings_secrets = [
    { name = "SOCIAL_TOKEN_KEY", valueFrom = "${aws_secretsmanager_secret.app.arn}:SOCIAL_TOKEN_KEY::" },
  ]

  operator_env     = [for k in sort(keys(var.app_env)) : { name = k, value = var.app_env[k] }]
  operator_secrets = [for k in var.app_secret_keys : { name = k, valueFrom = "${aws_secretsmanager_secret.integrations.arn}:${k}::" }]

  # Everything the stack itself sets, so app_env and app_secret_keys can be
  # refused when they would set a name twice (ECS keeps one of the two, and
  # which one is not something to leave to chance).
  stack_env_names = [for e in concat(
    local.control_plane_env, local.scale_env, local.image_env, local.docs_env, local.qoe_env, local.app_settings_env,
    local.control_plane_secrets, local.scale_secrets, local.image_secrets, local.docs_secrets, local.app_settings_secrets,
    [{ name = "ROLE" }, { name = "PREWARM_ECS_RESOURCE_IDS" }, { name = "WORKER_CONCURRENCY" }],
  ) : e.name]

  upload_cors_origins = length(var.upload_cors_origins) > 0 ? var.upload_cors_origins : [local.public_base_url]
}
