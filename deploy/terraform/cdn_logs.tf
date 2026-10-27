# ============================================================================
#  CDN EDGE LOGS INTO REPORTING (build queue 2.9, QOE_REPORTING.md sections 3
#  and 9; volt-app/src/services/qoe/cdnLogs.ts and cdnStream.ts).
#
#  CloudFront real-time logs put one line per sampled request on a Kinesis
#  stream; the scheduler's leader reads the stream into the analytics
#  database. That is how report 6 (delivery: edge first byte, origin time,
#  cache hits, errors, segment delivery rate) is made, and how viewers whose
#  player sends no reports at all (a raw stream address in a third-party
#  player) are counted.
#
#  COST. Fixed: the on-demand stream's hour (about $29 a month). Per use:
#  $0.01 per million log lines plus the stream's $0.08 per GB. The control
#  plane keeps the sampling rate where about var.cdn_log_target_lines_per_sec
#  lines a second arrive (CloudFront allows 1 to 100 %), so the per-use part
#  stops growing with the audience; this config's sampling_rate is only the
#  starting value and Terraform leaves the rate the control plane set alone.
#
#  The query string is logged because players put CMCD in it (1.14d): the
#  session id, object type, buffer and starvation of the player that asked.
#  The cache policies never key on it (s3_cloudfront.tf), so logging it costs
#  nothing in cache hits. The viewer's address is in the stream (CloudFront
#  always sends c-ip when asked, and the anonymous session key needs it) but
#  never stored: cdnLogs.ts blanks it before the raw copy is kept. The stream
#  keeps records 24 hours, encrypted.
# ============================================================================

variable "cdn_realtime_logs_enabled" {
  description = "Send CloudFront real-time logs of the delivery distribution to Kinesis for playback reporting (report 6, and counting players that send no reports). About $29 a month fixed plus a capped per-line cost."
  type        = bool
  default     = true
}

variable "cdn_log_sampling_rate" {
  description = "Starting percentage of requests logged (1 to 100). The control plane adjusts it afterwards (CDN_LOG_ADAPTIVE); Terraform does not put it back."
  type        = number
  default     = 100
  validation {
    condition     = var.cdn_log_sampling_rate >= 1 && var.cdn_log_sampling_rate <= 100 && floor(var.cdn_log_sampling_rate) == var.cdn_log_sampling_rate
    error_message = "cdn_log_sampling_rate is a whole percentage from 1 to 100."
  }
}

variable "cdn_log_target_lines_per_sec" {
  description = "Log lines a second the control plane aims for when it adjusts the sampling rate. 1,000 is plenty for delivery statistics (QOE_REPORTING.md section 9)."
  type        = number
  default     = 1000
}

variable "cdn_log_adaptive" {
  description = "Let the control plane adjust the sampling rate toward cdn_log_target_lines_per_sec. Off: the rate stays at cdn_log_sampling_rate."
  type        = bool
  default     = true
}

locals {
  cdn_logs = var.cdn_realtime_logs_enabled
  # Must match CDN_LOG_FIELDS in volt-app/src/services/qoe/cdnLogs.ts, in
  # this order (AWS's documented order). The terraform-cdn-logs suite checks.
  cdn_log_fields = [
    "timestamp", "c-ip", "time-to-first-byte", "sc-status", "sc-bytes", "cs-uri-stem", "x-edge-location", "x-edge-request-id",
    "time-taken", "cs-protocol-version", "cs-user-agent", "cs-uri-query", "x-edge-result-type", "x-edge-detailed-result-type",
    "c-country", "origin-fbl", "origin-lbl", "asn",
  ]
  cdn_logs_env = local.cdn_logs ? [
    { name = "CDN_LOG_STREAM", value = aws_kinesis_stream.cdn_logs[0].name },
    { name = "CDN_LOG_STREAM_ARN", value = aws_kinesis_stream.cdn_logs[0].arn },
    { name = "CDN_LOG_REGION", value = var.region },
    { name = "CDN_LOG_CONFIG_ARN", value = aws_cloudfront_realtime_log_config.cdn[0].arn },
    { name = "CDN_LOG_ROLE_ARN", value = aws_iam_role.cdn_logs[0].arn },
    { name = "CDN_LOG_SAMPLING_RATE", value = tostring(var.cdn_log_sampling_rate) },
    { name = "CDN_LOG_TARGET_LPS", value = tostring(var.cdn_log_target_lines_per_sec) },
    { name = "CDN_LOG_ADAPTIVE", value = var.cdn_log_adaptive ? "on" : "off" },
  ] : []
}

resource "aws_kinesis_stream" "cdn_logs" {
  count            = local.cdn_logs ? 1 : 0
  name             = "${local.name}-cdn-logs"
  retention_period = 24
  encryption_type  = "KMS"
  kms_key_id       = "alias/aws/kinesis"
  stream_mode_details {
    stream_mode = "ON_DEMAND"
  }
}

# CloudFront writes to the stream with this role.
data "aws_iam_policy_document" "cdn_logs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cdn_logs" {
  count              = local.cdn_logs ? 1 : 0
  name               = "${local.name}-cdn-logs"
  assume_role_policy = data.aws_iam_policy_document.cdn_logs_assume.json
}

data "aws_iam_policy_document" "cdn_logs_write" {
  count = local.cdn_logs ? 1 : 0
  statement {
    actions   = ["kinesis:DescribeStreamSummary", "kinesis:DescribeStream", "kinesis:PutRecord", "kinesis:PutRecords"]
    resources = [aws_kinesis_stream.cdn_logs[0].arn]
  }
  # The stream is encrypted with the AWS managed key; writing needs a data key through Kinesis.
  statement {
    actions   = ["kms:GenerateDataKey"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["kinesis.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "cdn_logs_write" {
  count  = local.cdn_logs ? 1 : 0
  name   = "write-stream"
  role   = aws_iam_role.cdn_logs[0].id
  policy = data.aws_iam_policy_document.cdn_logs_write[0].json
}

resource "aws_cloudfront_realtime_log_config" "cdn" {
  count         = local.cdn_logs ? 1 : 0
  name          = "${local.name}-delivery"
  sampling_rate = var.cdn_log_sampling_rate
  fields        = local.cdn_log_fields
  endpoint {
    stream_type = "Kinesis"
    kinesis_stream_config {
      role_arn   = aws_iam_role.cdn_logs[0].arn
      stream_arn = aws_kinesis_stream.cdn_logs[0].arn
    }
  }
  depends_on = [aws_iam_role_policy.cdn_logs_write]
  lifecycle {
    # The control plane moves the rate to keep the line count near the target.
    ignore_changes = [sampling_rate]
  }
}

# The control plane reads the stream (the scheduler's leader only) and
# changes the sampling rate, restating the role (so it may pass it).
data "aws_iam_policy_document" "control_plane_cdn_logs" {
  count = local.cdn_logs ? 1 : 0
  statement {
    actions   = ["kinesis:ListShards", "kinesis:GetShardIterator", "kinesis:GetRecords", "kinesis:DescribeStreamSummary"]
    resources = [aws_kinesis_stream.cdn_logs[0].arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["kinesis.${var.region}.amazonaws.com"]
    }
  }
  statement {
    actions   = ["cloudfront:GetRealtimeLogConfig", "cloudfront:UpdateRealtimeLogConfig"]
    resources = [aws_cloudfront_realtime_log_config.cdn[0].arn]
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.cdn_logs[0].arn]
  }
}

resource "aws_iam_role_policy" "control_plane_cdn_logs" {
  count  = local.cdn_logs ? 1 : 0
  name   = "cdn-logs"
  role   = aws_iam_role.control_plane.id
  policy = data.aws_iam_policy_document.control_plane_cdn_logs[0].json
}

output "cdn_log_stream" {
  value       = local.cdn_logs ? aws_kinesis_stream.cdn_logs[0].name : null
  description = "The Kinesis stream CloudFront writes its real-time delivery logs to (read by the control plane)."
}
