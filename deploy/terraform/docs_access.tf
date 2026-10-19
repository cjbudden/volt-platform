# ---- Customer docs access ---------------------------------------------------
# The docs site is its own stack (deploy/terraform-docs). The platform's only
# part is issuing the signed cookie that lets a signed-in user read it
# (volt-app/src/modules/docsSession.ts). Copy these from the docs stack's
# outputs. Leave docs_url empty and the Documentation button says "not set up".
variable "docs_url" {
  type        = string
  default     = ""
  description = "docs stack output docs_url, e.g. https://docs.volt.example"
}

variable "docs_cookie_domain" {
  type        = string
  default     = ""
  description = "docs stack output cookie_domain, e.g. .volt.example (the app must be on this domain too)"
}

variable "docs_key_pair_id" {
  type        = string
  default     = ""
  description = "docs stack output cloudfront_key_pair_id"
}

variable "docs_signing_key_secret_arn" {
  type        = string
  default     = ""
  description = "docs stack output signing_key_secret_arn"
}

variable "docs_session_ttl" {
  type        = number
  default     = 43200
  description = "How long one docs pass lasts, in seconds (default 12 hours)."
}

locals {
  docs_env = var.docs_url == "" ? [] : [
    { name = "DOCS_URL", value = var.docs_url },
    { name = "DOCS_COOKIE_DOMAIN", value = var.docs_cookie_domain },
    { name = "DOCS_CF_KEY_PAIR_ID", value = var.docs_key_pair_id },
    { name = "DOCS_SESSION_TTL", value = tostring(var.docs_session_ttl) },
  ]
  docs_secrets = var.docs_signing_key_secret_arn == "" ? [] : [
    { name = "DOCS_CF_PRIVATE_KEY", valueFrom = var.docs_signing_key_secret_arn },
  ]
  docs_secret_arns = compact([var.docs_signing_key_secret_arn])
}
