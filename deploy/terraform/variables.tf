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
