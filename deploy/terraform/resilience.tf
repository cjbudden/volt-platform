# ============================================================================
#  Database resilience (build queue D5)
#
#  What protects the database and the cache, by deployment and tier:
#
#  | Tier      | RDS Multi-AZ   | Valkey replica | Daily copy to a second region |
#  |-----------|----------------|----------------|-------------------------------|
#  | standard  | db_multi_az    | valkey_replicas| no                            |
#  | high      | on             | at least 1     | no                            |
#  | dr        | on             | at least 1     | yes (AWS Backup)              |
#
#  The SaaS service (`deployment = "saas"`, app_settings.tf) in prod is always
#  `dr`: every customer shares it, so it gets everything. A dedicated deployment
#  (`deployment = "single"`, one customer's own Volt) picks its tier with
#  `resilience` (standard by default), because Multi-AZ doubles the
#  database bill and the copies add storage in a second region: those are the
#  premium options. Staging keeps the cheap defaults unless a tier is asked for.
#
#  Backups: RDS keeps automated backups (point-in-time restore) for
#  `db_backup_retention_days`, 14 to 35 in prod, 1 by default elsewhere. With
#  `dr`, AWS Backup also takes a daily snapshot at 04:00 UTC and copies it to
#  `backup_copy_region`, keeping both for the same number of days.
#
#  Major version upgrades go through RDS Blue/Green (APPLY.md, "Upgrading
#  Postgres"), never an in-place `engine_version` change on prod.
# ============================================================================

variable "resilience" {
  type        = string
  default     = "standard"
  description = "Dedicated deployments (deployment = single): standard (single zone), high (Multi-AZ database, cache replica) or dr (high plus daily copies to a second region). The SaaS service in prod is always dr."
  validation {
    condition     = contains(["standard", "high", "dr"], var.resilience)
    error_message = "resilience must be standard, high or dr."
  }
}

variable "db_backup_retention_days" {
  type        = number
  default     = null
  description = "Days RDS keeps automated backups (and AWS Backup its copies). Prod: 14 to 35, 14 when unset. Elsewhere 1 when unset."
  validation {
    condition     = var.db_backup_retention_days == null ? true : (var.db_backup_retention_days >= 1 && var.db_backup_retention_days <= 35 && floor(var.db_backup_retention_days) == var.db_backup_retention_days)
    error_message = "db_backup_retention_days must be a whole number from 1 to 35 (RDS's limit)."
  }
}

variable "backup_copy_region" {
  type        = string
  default     = null
  description = "Where the dr tier copies its daily database snapshot. Unset: the usual pair of the stack's region (us-east-1 to us-west-2, eu-west-1 to eu-central-1, and so on)."
}

locals {
  is_prod = var.env == "prod"

  # The tier in force: the SaaS service in prod always gets everything.
  resilience = var.deployment == "saas" ? (local.is_prod ? "dr" : var.resilience) : var.resilience

  db_multi_az     = var.db_multi_az || contains(["high", "dr"], local.resilience)
  valkey_replicas = contains(["high", "dr"], local.resilience) ? max(1, var.valkey_replicas) : var.valkey_replicas
  db_cross_region = local.resilience == "dr"

  db_backup_days = var.db_backup_retention_days != null ? var.db_backup_retention_days : (local.is_prod ? 14 : 1)

  # A second region in the same geography, so a copy stays under the same
  # data rules as the original.
  paired_region = {
    "us-east-1"      = "us-west-2"
    "us-east-2"      = "us-west-2"
    "us-west-1"      = "us-east-1"
    "us-west-2"      = "us-east-1"
    "ca-central-1"   = "ca-west-1"
    "eu-west-1"      = "eu-central-1"
    "eu-west-2"      = "eu-west-1"
    "eu-west-3"      = "eu-central-1"
    "eu-central-1"   = "eu-west-1"
    "eu-north-1"     = "eu-west-1"
    "ap-southeast-1" = "ap-southeast-2"
    "ap-southeast-2" = "ap-southeast-1"
    "ap-northeast-1" = "ap-northeast-3"
    "ap-south-1"     = "ap-south-2"
    "sa-east-1"      = "us-east-1"
  }
  backup_copy_region = var.backup_copy_region != null ? var.backup_copy_region : lookup(local.paired_region, var.region, "")
}

# The second region's provider. Always declared (a provider cannot be switched
# off); nothing is made in it unless the tier is dr.
provider "aws" {
  alias  = "backup_copy"
  region = local.backup_copy_region != "" ? local.backup_copy_region : var.region
  default_tags {
    tags = merge({
      Project   = var.project
      Env       = var.env
      ManagedBy = "terraform"
      Product   = "Volt Streaming"
    }, var.tags)
  }
}

# The rules, checked at plan so a wrong setting never reaches AWS.
resource "terraform_data" "resilience_rules" {
  input = local.resilience
  lifecycle {
    precondition {
      condition     = !local.is_prod || local.db_backup_days >= 14
      error_message = "Prod keeps database backups 14 to 35 days: set db_backup_retention_days to 14 or more."
    }
    precondition {
      condition     = !local.db_cross_region || (local.backup_copy_region != "" && local.backup_copy_region != var.region)
      error_message = "The dr tier copies snapshots to a second region: set backup_copy_region to a region other than the stack's."
    }
  }
}

data "aws_iam_policy_document" "backup_assume" {
  count = local.db_cross_region ? 1 : 0
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  count              = local.db_cross_region ? 1 : 0
  name               = "${local.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume[0].json
}

resource "aws_iam_role_policy_attachment" "backup" {
  count      = local.db_cross_region ? 1 : 0
  role       = aws_iam_role.backup[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_vault" "db" {
  count = local.db_cross_region ? 1 : 0
  name  = "${local.name}-db"
}

resource "aws_backup_vault" "db_copy" {
  count    = local.db_cross_region ? 1 : 0
  provider = aws.backup_copy
  name     = "${local.name}-db-copy"
}

resource "aws_backup_plan" "db" {
  count = local.db_cross_region ? 1 : 0
  name  = "${local.name}-db"

  rule {
    rule_name         = "daily-with-copy"
    target_vault_name = aws_backup_vault.db[0].name
    schedule          = "cron(0 4 * * ? *)"
    lifecycle {
      delete_after = local.db_backup_days
    }
    copy_action {
      destination_vault_arn = aws_backup_vault.db_copy[0].arn
      lifecycle {
        delete_after = local.db_backup_days
      }
    }
  }
}

resource "aws_backup_selection" "db" {
  count        = local.db_cross_region ? 1 : 0
  name         = "${local.name}-db"
  plan_id      = aws_backup_plan.db[0].id
  iam_role_arn = aws_iam_role.backup[0].arn
  resources    = [aws_db_instance.pg.arn]
}

output "db_resilience" {
  description = "The database and cache protection in force (resilience.tf)."
  value = {
    tier                 = local.resilience
    db_multi_az          = local.db_multi_az
    valkey_replicas      = local.valkey_replicas
    backup_days          = local.db_backup_days
    snapshot_copy_region = local.db_cross_region ? local.backup_copy_region : null
  }
}
