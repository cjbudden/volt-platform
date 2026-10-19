# ---- Raw beacons to S3 (Kinesis Data Firehose) -----------------------------------
# With analytics_sessions = "none" Postgres keeps only the rollups and live
# concurrency; every raw beacon lands here as gzipped JSON lines, partitioned
# by day, for Athena / the data lake. Optional in "postgres" mode too.

resource "aws_s3_bucket" "analytics" {
  count         = var.enable_analytics_firehose ? 1 : 0
  bucket        = "${local.name}-analytics"
  force_destroy = var.env != "prod"
  tags          = { Name = "${local.name}-analytics" }
}

resource "aws_s3_bucket_public_access_block" "analytics" {
  count                   = var.enable_analytics_firehose ? 1 : 0
  bucket                  = aws_s3_bucket.analytics[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "firehose_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["firehose.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "firehose" {
  count              = var.enable_analytics_firehose ? 1 : 0
  name               = "${local.name}-firehose"
  assume_role_policy = data.aws_iam_policy_document.firehose_assume.json
}

resource "aws_iam_role_policy" "firehose" {
  count = var.enable_analytics_firehose ? 1 : 0
  name  = "write-analytics"
  role  = aws_iam_role.firehose[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:AbortMultipartUpload", "s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads"]
      Resource = [aws_s3_bucket.analytics[0].arn, "${aws_s3_bucket.analytics[0].arn}/*"]
    }]
  })
}

resource "aws_kinesis_firehose_delivery_stream" "beacons" {
  count       = var.enable_analytics_firehose ? 1 : 0
  name        = "${local.name}-beacons"
  destination = "extended_s3"

  extended_s3_configuration {
    role_arn            = aws_iam_role.firehose[0].arn
    bucket_arn          = aws_s3_bucket.analytics[0].arn
    prefix              = "beacons/dt=!{timestamp:yyyy-MM-dd}/"
    error_output_prefix = "errors/!{firehose:error-output-type}/dt=!{timestamp:yyyy-MM-dd}/"
    buffering_interval  = 60
    buffering_size      = 64
    compression_format  = "GZIP"
  }
}
