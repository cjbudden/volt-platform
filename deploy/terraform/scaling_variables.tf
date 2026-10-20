# ============================================================================
#  SCALING: variables for the viewer-path / 1M-viewer configuration.
#  See SCALING.md at the repository root for what each one is for and the
#  values to use for staging vs a large event.
# ============================================================================

# ---- Service roles -------------------------------------------------------------

variable "enable_role_split" {
  type        = bool
  default     = false
  description = "Run api-public, api-admin, scheduler and worker as separate ECS services (same image, ROLE env). false = one control-plane service doing everything (ROLE=all), as before."
}

variable "api_public_cpu" {
  type    = number
  default = 1024
}

variable "api_public_memory" {
  type    = number
  default = 2048
}

variable "api_public_min" {
  type        = number
  default     = 2
  description = "Floor for the viewer tier. The scheduler raises it before big events (pre-warm)."
}

variable "api_public_max" {
  type    = number
  default = 60
}

variable "api_public_requests_per_target" {
  type        = number
  default     = 30000
  description = "Target-tracking value for ALBRequestCountPerTarget (requests per task per MINUTE). 30000 = 500/s, well under the ~1500-2000/s one 1-vCPU task sustains on the cached path."
}

variable "api_public_cpu_target" {
  type    = number
  default = 50
}

variable "api_admin_max" {
  type    = number
  default = 6
}

variable "scheduler_count" {
  type        = number
  default     = 2
  description = "Scheduler tasks. One leads (advisory lock); the rest are hot standbys that take over within ~10 s."
}

variable "worker_cpu" {
  type    = number
  default = 1024
}

variable "worker_memory" {
  type    = number
  default = 2048
}

variable "worker_min" {
  type    = number
  default = 1
}

variable "worker_max" {
  type    = number
  default = 10
}

variable "worker_concurrency" {
  type        = number
  default     = 2
  description = "Jobs per worker task at once."
}

variable "worker_scale_out_queue" {
  type        = number
  default     = 10
  description = "Ready jobs waiting (Volt/JobsQueued) above which a worker is added."
}

variable "db_pool_max_per_task" {
  type    = number
  default = 10
}

# ---- Valkey (ElastiCache) ---------------------------------------------------------

variable "enable_valkey" {
  type        = bool
  default     = true
  description = "Shared cache + exact concurrency counting. Without it each task caches on its own (works, less shared)."
}

variable "valkey_node_type" {
  type        = string
  default     = "cache.t4g.small"
  description = "cache.r7g.large or larger for 1M-viewer events."
}

variable "valkey_replicas" {
  type        = number
  default     = 1
  description = "Read replicas. >= 1 enables Multi-AZ automatic fail-over."
}

# ---- RDS Proxy ----------------------------------------------------------------------

variable "enable_rds_proxy" {
  type        = bool
  default     = false
  description = "Pool connections from many tasks through RDS Proxy. Turn on once api-public scales past ~20 tasks."
}

# ---- Edge (CloudFront + WAF in front of the API) -----------------------------------

variable "enable_api_edge" {
  type        = bool
  default     = true
  description = "CloudFront in front of the ALB: caches the anonymous play gate and /live redirects, supplies the trusted viewer country, carries the WAF."
}

variable "api_edge_aliases" {
  type        = list(string)
  default     = []
  description = "Custom domains for the API edge (e.g. [\"api.volt.example\"]). Needs api_edge_certificate_arn."
}

variable "api_edge_certificate_arn" {
  type        = string
  default     = ""
  description = "ACM certificate in us-east-1 covering api_edge_aliases."
}

variable "alb_origin_protocol" {
  type        = string
  default     = "http-only"
  description = "CloudFront to ALB. Use https-only once the ALB has an HTTPS listener and certificate."
}

variable "waf_rate_limit_per_ip" {
  type        = number
  default     = 6000
  description = "Requests per IP per 5 minutes across the API (households and mobile carriers share IPs: keep generous)."
}

variable "waf_auth_rate_limit_per_ip" {
  type        = number
  default     = 100
  description = "Login attempts per IP per 5 minutes."
}

variable "alb_lcu_reservation" {
  type        = number
  default     = null
  description = "Reserved ALB capacity units (LCU reservation) for a known big event. null = none. Billed while set; set before, unset after."
}

# ---- Analytics -------------------------------------------------------------------------

variable "analytics_sessions" {
  type        = string
  default     = "postgres"
  description = "postgres = batched per-session rows (to ~100k concurrent). none = rollups only in Postgres, raw beacons to Firehose (1M scale)."
  validation {
    condition     = contains(["postgres", "none"], var.analytics_sessions)
    error_message = "analytics_sessions must be postgres or none."
  }
}

variable "enable_analytics_firehose" {
  type        = bool
  default     = false
  description = "Stream every raw beacon to S3 through Kinesis Data Firehose (query with Athena)."
}

# ---- Pre-warm ---------------------------------------------------------------------------

variable "prewarm_mode" {
  type        = string
  default     = "aws"
  description = "aws = the scheduler raises api-public's minimum before events with expected_viewers. log = report only."
}

variable "prewarm_starts_per_task" {
  type        = number
  default     = 1500
  description = "Viewer starts/s one api-public task sustains. Set from your load test."
}

variable "prewarm_origin_fraction" {
  type        = number
  default     = 0.1
  description = "Share of starts that miss the edge cache and reach the API. ~0.05-0.1 with CloudFront for a big free event; 1 for signed-in-only content."
}

variable "api_edge_price_class" {
  type        = string
  default     = "PriceClass_All"
  description = "Edge locations for the API distribution. PriceClass_All covers APAC viewers best."
}

variable "public_base_url" {
  description = "Origin viewers use for the API (PUBLIC_BASE_URL). Empty: the first api_edge_aliases entry, else the API edge, else the ALB."
  type        = string
  default     = ""
}
