# Database resilience by deployment and tier (resilience.tf, build queue D5),
# planned against mocked providers so no AWS account is needed:
#   terraform init -backend=false && terraform test -filter=tests/resilience.tftest.hcl
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b", "us-east-1c"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111122223333:role/x" }
  }
  mock_resource "aws_db_instance" {
    defaults = { arn = "arn:aws:rds:us-east-1:111122223333:db:volt-prod-pg" }
  }
}
mock_provider "aws" {
  alias = "us_east_1"
}
mock_provider "aws" {
  alias = "backup_copy"
  mock_resource "aws_backup_vault" {
    defaults = { arn = "arn:aws:backup:us-west-2:111122223333:backup-vault:volt-prod-db-copy" }
  }
}
mock_provider "random" {}

# Prod runs name a domain, so the check that prod has one stays quiet.
variables {
  control_plane_image_tag = "v0.43.0-1a2b3c4"
}

# Staging, any deployment: the cheap defaults, as before.
run "staging_defaults" {
  command = plan
  assert {
    condition     = aws_db_instance.pg.multi_az == false && aws_db_instance.pg.backup_retention_period == 1
    error_message = "staging should stay single zone with one day of backups"
  }
  assert {
    condition     = length(aws_backup_plan.db) == 0 && length(aws_backup_vault.db_copy) == 0
    error_message = "staging should make no cross-region copies"
  }
  assert {
    condition     = output.db_resilience.tier == "standard" && output.db_resilience.snapshot_copy_region == null
    error_message = "staging tier wrong"
  }
}

# The SaaS service in prod: everything on, whatever was asked.
run "saas_prod_forces_dr" {
  command = plan
  variables {
    env             = "prod"
    domain_name     = "volt.example.com"
    deployment      = "saas"
    resilience      = "standard"
    db_multi_az     = false
    valkey_replicas = 0
  }
  assert {
    condition     = aws_db_instance.pg.multi_az == true
    error_message = "SaaS prod must be Multi-AZ"
  }
  assert {
    condition     = aws_db_instance.pg.backup_retention_period == 14
    error_message = "prod keeps 14 days of backups by default"
  }
  assert {
    condition     = aws_elasticache_replication_group.valkey[0].num_cache_clusters == 2 && aws_elasticache_replication_group.valkey[0].automatic_failover_enabled
    error_message = "SaaS prod must have a Valkey replica with fail-over"
  }
  assert {
    condition     = length(aws_backup_plan.db) == 1 && length(aws_backup_vault.db_copy) == 1 && length(aws_backup_selection.db) == 1
    error_message = "SaaS prod must copy snapshots to a second region"
  }
  assert {
    condition     = one([for r in aws_backup_plan.db[0].rule : r.schedule]) == "cron(0 4 * * ? *)"
    error_message = "the snapshot should be daily"
  }
  assert {
    condition     = length(flatten([for r in aws_backup_plan.db[0].rule : r.copy_action])) == 1
    error_message = "the daily snapshot should be copied once, to the second region's vault"
  }
  assert {
    condition     = one(flatten([for r in aws_backup_plan.db[0].rule : [for c in r.copy_action : [for l in c.lifecycle : l.delete_after]]])) == 14
    error_message = "the copies should be kept as long as the backups"
  }
  assert {
    condition     = output.db_resilience.tier == "dr" && output.db_resilience.snapshot_copy_region == "us-west-2"
    error_message = "us-east-1 should copy to us-west-2 by default"
  }
}

# A dedicated deployment in prod: standard by default (single zone, no copies),
# backups still 14 days or more.
run "dedicated_prod_standard" {
  command = plan
  variables {
    env             = "prod"
    domain_name     = "volt.example.com"
    deployment      = "single"
    valkey_replicas = 0
  }
  assert {
    condition     = aws_db_instance.pg.multi_az == false && aws_db_instance.pg.backup_retention_period == 14
    error_message = "dedicated standard: single zone, 14 days"
  }
  assert {
    condition     = aws_elasticache_replication_group.valkey[0].num_cache_clusters == 1 && length(aws_backup_plan.db) == 0
    error_message = "dedicated standard: no replica asked, no copies"
  }
}

run "dedicated_high" {
  command = plan
  variables {
    env             = "prod"
    domain_name     = "volt.example.com"
    deployment      = "single"
    resilience      = "high"
    valkey_replicas = 0
  }
  assert {
    condition     = aws_db_instance.pg.multi_az == true && aws_elasticache_replication_group.valkey[0].num_cache_clusters == 2
    error_message = "high: Multi-AZ and a cache replica"
  }
  assert {
    condition     = length(aws_backup_plan.db) == 0
    error_message = "high: no cross-region copies"
  }
}

run "dedicated_dr_own_region_and_days" {
  command = plan
  variables {
    env                      = "prod"
    domain_name              = "volt.example.com"
    deployment               = "single"
    resilience               = "dr"
    region                   = "eu-west-1"
    backup_copy_region       = "eu-west-2"
    db_backup_retention_days = 35
  }
  assert {
    condition     = aws_db_instance.pg.multi_az == true && aws_db_instance.pg.backup_retention_period == 35
    error_message = "dr: Multi-AZ, 35 days as asked"
  }
  assert {
    condition     = length(aws_backup_plan.db) == 1 && output.db_resilience.snapshot_copy_region == "eu-west-2"
    error_message = "dr: copies to the region asked for"
  }
  assert {
    condition     = one([for r in aws_backup_plan.db[0].rule : [for l in r.lifecycle : l.delete_after][0]]) == 35
    error_message = "dr: snapshots kept 35 days"
  }
}

# Prod refuses fewer than 14 days.
run "prod_refuses_short_backups" {
  command = plan
  variables {
    env                      = "prod"
    domain_name              = "volt.example.com"
    db_backup_retention_days = 7
  }
  expect_failures = [terraform_data.resilience_rules]
}

# The copy region must be another region.
run "dr_refuses_same_region" {
  command = plan
  variables {
    deployment         = "single"
    resilience         = "dr"
    backup_copy_region = "us-east-1"
  }
  expect_failures = [terraform_data.resilience_rules]
}

run "retention_over_rds_limit_refused" {
  command = plan
  variables {
    db_backup_retention_days = 36
  }
  expect_failures = [var.db_backup_retention_days]
}

run "unknown_tier_refused" {
  command = plan
  variables {
    resilience = "gold"
  }
  expect_failures = [var.resilience]
}
