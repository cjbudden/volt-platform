# The chaos experiment templates (chaos.tf, build queue 2.8), planned against
# mocked providers so no AWS account is needed:
#   terraform init -backend=false && terraform test
# Off by default; when on, one zone template per zone and one Spot template,
# and the outputs the harness (deploy/loadtest/chaos.mjs) reads.
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["eu-west-1a", "eu-west-1b", "eu-west-1c"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_resource "aws_subnet" {
    defaults = { arn = "arn:aws:ec2:eu-west-1:111122223333:subnet/subnet-1" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111122223333:role/x" }
  }
}
mock_provider "aws" {
  alias = "us_east_1"
}
mock_provider "random" {}

run "off_by_default" {
  command = plan
  assert {
    condition     = length(aws_fis_experiment_template.az) == 0 && length(aws_fis_experiment_template.spot) == 0 && length(aws_iam_role.fis) == 0
    error_message = "chaos resources exist with the switch off"
  }
}

run "on" {
  command = plan
  variables {
    enable_chaos_experiments = true
    az_count                 = 2
  }
  assert {
    condition     = length(aws_fis_experiment_template.az) == 2 && length(aws_fis_experiment_template.spot) == 1
    error_message = "expected one template per zone and one Spot template"
  }
  assert {
    condition     = toset(keys(output.chaos_experiment_templates)) == toset(["az-eu-west-1a", "az-eu-west-1b", "spot-interrupt"])
    error_message = "template output keys wrong"
  }
  assert {
    condition     = output.chaos_stack.stack_name == "${var.project}-${var.env}"
    error_message = "stack name wrong"
  }
}
