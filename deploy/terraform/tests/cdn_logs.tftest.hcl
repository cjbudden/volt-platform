# CloudFront real-time logs into playback reporting (cdn_logs.tf, build queue
# 2.9), planned against mocked providers so no AWS account is needed:
#   terraform init -backend=false && terraform test
# On by default: the stream, the log config with every field the reader
# parses, the control plane told where to read; off: none of it.
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
  mock_resource "aws_kinesis_stream" {
    defaults = { arn = "arn:aws:kinesis:eu-west-1:111122223333:stream/s" }
  }
  mock_resource "aws_cloudfront_realtime_log_config" {
    defaults = { arn = "arn:aws:cloudfront::111122223333:realtime-log-config/x" }
  }
}
mock_provider "aws" {
  alias = "us_east_1"
}
mock_provider "random" {}

run "on_by_default" {
  command = plan
  assert {
    condition     = length(aws_kinesis_stream.cdn_logs) == 1 && length(aws_cloudfront_realtime_log_config.cdn) == 1
    error_message = "expected the stream and the log config"
  }
  assert {
    condition     = aws_cloudfront_realtime_log_config.cdn[0].sampling_rate == 100 && length(aws_cloudfront_realtime_log_config.cdn[0].fields) == 18
    error_message = "log config: starting rate 100 and the 18 fields the reader parses"
  }
  assert {
    condition     = aws_kinesis_stream.cdn_logs[0].stream_mode_details[0].stream_mode == "ON_DEMAND" && aws_kinesis_stream.cdn_logs[0].retention_period == 24
    error_message = "stream: on demand, 24 hours"
  }
  assert {
    condition     = toset([for e in local.qoe_env : e.name if startswith(e.name, "CDN_LOG_")]) == toset(["CDN_LOG_STREAM", "CDN_LOG_STREAM_ARN", "CDN_LOG_REGION", "CDN_LOG_CONFIG_ARN", "CDN_LOG_ROLE_ARN", "CDN_LOG_SAMPLING_RATE", "CDN_LOG_TARGET_LPS", "CDN_LOG_ADAPTIVE"])
    error_message = "the control plane is not told where to read"
  }
}

run "off" {
  command = plan
  variables {
    cdn_realtime_logs_enabled = false
  }
  assert {
    condition     = length(aws_kinesis_stream.cdn_logs) == 0 && length(aws_cloudfront_realtime_log_config.cdn) == 0 && length(local.cdn_logs_env) == 0
    error_message = "CDN log resources exist with the switch off"
  }
}
