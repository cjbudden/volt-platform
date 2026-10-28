# The ClickHouse analytics store (clickhouse.tf, build queue 2.11), planned
# against mocked providers so no AWS account is needed:
#   terraform init -backend=false && terraform test
# Off by default: nothing built and the control plane told QOE_STORE=postgres.
# On: two replicas in two zones at fixed addresses, the third Keeper, the
# backup bucket, and the control plane told QOE_STORE=auto with the URL as a
# secret.
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["eu-west-1a", "eu-west-1b", "eu-west-1c"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
  mock_resource "aws_subnet" {
    defaults = { arn = "arn:aws:ec2:eu-west-1:111122223333:subnet/subnet-1" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111122223333:role/x" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:eu-west-1:111122223333:secret:volt/clickhouse-abc" }
  }
}
mock_provider "aws" {
  alias = "us_east_1"
}
mock_provider "random" {}

run "off_by_default" {
  command = plan
  assert {
    condition     = length(aws_instance.clickhouse) == 0 && length(aws_instance.clickhouse_keeper) == 0 && length(aws_s3_bucket.clickhouse_backups) == 0 && length(aws_secretsmanager_secret.clickhouse) == 0
    error_message = "ClickHouse resources exist with the switch off"
  }
  assert {
    condition     = contains([for e in local.qoe_env : "${e.name}=${e.value}"], "QOE_STORE=postgres") && length(local.clickhouse_secrets) == 0
    error_message = "with ClickHouse off the control plane must stay on Postgres"
  }
}

run "on" {
  command = plan
  variables {
    clickhouse_enabled = true
    az_count           = 3
  }
  assert {
    condition     = length(aws_instance.clickhouse) == 2 && length(aws_instance.clickhouse_keeper) == 1
    error_message = "expected two replicas and the third keeper"
  }
  assert {
    condition     = aws_instance.clickhouse[0].instance_type == "r7g.large" && aws_instance.clickhouse_keeper[0].instance_type == "t4g.small"
    error_message = "instance types wrong"
  }
  assert {
    condition     = length(toset([local.ch_replica_ips[0], local.ch_replica_ips[1], local.ch_keeper_ip])) == 3
    error_message = "the three servers need three different addresses"
  }
  assert {
    condition     = contains([for e in local.qoe_env : "${e.name}=${e.value}"], "QOE_STORE=auto") && contains([for e in local.qoe_env : "${e.name}=${e.value}"], "CLICKHOUSE_CLUSTER=volt")
    error_message = "the control plane must be told QOE_STORE=auto and the cluster"
  }
  assert {
    condition     = length(local.clickhouse_secrets) == 1 && local.clickhouse_secrets[0].name == "CLICKHOUSE_URL"
    error_message = "CLICKHOUSE_URL must reach the control plane as a secret"
  }
  assert {
    condition     = aws_instance.clickhouse[0].private_ip == local.ch_replica_ips[0] && aws_instance.clickhouse[1].private_ip == local.ch_replica_ips[1] && aws_instance.clickhouse_keeper[0].private_ip == local.ch_keeper_ip
    error_message = "each server must sit at the address the others are configured with"
  }
}
