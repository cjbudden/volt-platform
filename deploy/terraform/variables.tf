variable "project" {
  type        = string
  default     = "volt"
  description = "Name prefix for all resources (matches the control-plane config defaults: cluster 'volt', providers 'volt-spot'/'volt-ondemand')."
}

variable "env" {
  type        = string
  default     = "staging"
  description = "Environment name (staging | prod). Part of resource names and tags."
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.60.0.0/16"
}

variable "az_count" {
  type        = number
  default     = 2
  description = "Number of AZs to spread public/private subnets across."
}

# ---- ECS capacity (EC2 for the encoder; Spot + on-demand fallback) ----------
variable "encoder_instance_types" {
  type        = list(string)
  default     = ["c7i.xlarge", "c6i.xlarge", "c5.xlarge"]
  description = "CPU packaging/transcode nodes. For GPU transcode density use a g-family type (e.g. g4dn.xlarge) and a GPU-enabled ECS AMI."
}

variable "encoder_large_instance_types" {
  type        = list(string)
  default     = ["c7i.2xlarge", "c6i.2xlarge", "c5.2xlarge"]
  description = "Large CPU nodes for ladders that need more than a 4-vCPU server can give within the sizing ceiling (e.g. a full 1080p x264 ladder). Placement picks small or large per stream from its output settings."
}

variable "large_spot_max" {
  type    = number
  default = 4
}

variable "large_ondemand_max" {
  type    = number
  default = 4
}

variable "spot_min" {
  type    = number
  default = 0
}

variable "spot_max" {
  type    = number
  default = 6
}

variable "ondemand_min" {
  type        = number
  default     = 1
  description = "On-demand base capacity — the orchestrator's capacityProviderStrategy keeps base=1 here as the Spot-interruption fallback."
}

variable "ondemand_max" {
  type    = number
  default = 2
}

# ---- Control plane (Fargate service behind the ALB) -------------------------
variable "control_plane_cpu" {
  type    = number
  default = 512
}

variable "control_plane_memory" {
  type    = number
  default = 1024
}

variable "control_plane_desired" {
  type    = number
  default = 2
}

variable "control_plane_image_tag" {
  type        = string
  default     = "latest"
  description = "Tag pushed to the volt-control-plane ECR repo."
}

# ---- Data ------------------------------------------------------------------
variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_name" {
  type    = string
  default = "volt"
}

variable "db_username" {
  type    = string
  default = "volt"
}

variable "db_multi_az" {
  type    = bool
  default = false # true for prod
}

# ---- JWT / ingest secrets ---------------------------------------------------
# Left empty → a random value is generated and stored in Secrets Manager.
variable "jwt_access_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "jwt_refresh_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "ingest_token" {
  type      = string
  default   = ""
  sensitive = true
}

variable "tags" {
  type    = map(string)
  default = {}
}

# CDN-LEVEL GEO RESTRICTION.
#
# Deliberately COARSE and deliberately secondary. CloudFront can only apply one
# country list to the whole distribution, so it cannot express "this programme
# is blacked out in these markets" -- that is what the play gate already does
# per-programme in `rights.ts`, with a replacement asset for a blocked viewer.
# What this buys is a hard edge stop for a country we must not serve AT ALL
# (a sanctions list, a licence we do not hold anywhere): enforced before a
# request reaches the origin, and not dependent on our token logic being right.
#
# Left as "none" by default so behaviour is unchanged until somebody sets it.
variable "cdn_geo_restriction_type" {
  type        = string
  default     = "none"
  description = "CloudFront geo restriction: none | whitelist | blacklist"
  validation {
    condition     = contains(["none", "whitelist", "blacklist"], var.cdn_geo_restriction_type)
    error_message = "cdn_geo_restriction_type must be none, whitelist or blacklist."
  }
}

variable "cdn_geo_countries" {
  type        = list(string)
  default     = []
  description = "ISO 3166-1 alpha-2 codes for the whitelist/blacklist. Ignored when the type is none."
}

# ---- playback experience (QoE) raw reports (qoe_raw.tf, QOE_REPORTING.md 9a)
variable "qoe_raw_retention_days" {
  description = "Days the raw CMCD playback reports are kept before they expire (760 = 25 months: the engagement reports' retention). Raw data is the record every report is rebuilt from."
  type        = number
  default     = 760
}

variable "qoe_raw_lock_days" {
  description = "Object Lock (governance) retention on each raw report object: nobody without the bypass permission can delete or overwrite it inside this many days. Not more than qoe_raw_retention_days."
  type        = number
  default     = 90
}
