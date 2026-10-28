# ============================================================================
#  THE RAW PLAYBACK REPORTS ARCHIVE (QOE_REPORTING.md section 9a).
#
#  The CMCD reports the collector accepts are the record: every view row,
#  minute aggregate and report is rebuilt from them (replay), so they are kept
#  safe and cheap rather than fast:
#
#    - versioning plus Object Lock in GOVERNANCE mode, so nobody (or a bug)
#      deletes or overwrites raw data inside its retention;
#    - 0 to 30 days S3 Standard (session timelines, recent replays),
#      30 to 90 days Glacier Instant Retrieval (investigations, a replay in
#      minutes), then Deep Archive (rebuilding history; bulk restore 12 to 48 h);
#    - expired after var.qoe_raw_retention_days (25 months by default).
#
#  The collector writes large gzipped NDJSON objects every 10 s per task
#  (services/qoe/rawStore.ts), so per-object charges stay negligible. No IP
#  addresses are in it: only the viewer's country, region and network (ASN)
#  from CloudFront's own headers, and the user agent.
# ============================================================================

resource "aws_s3_bucket" "qoe_raw" {
  bucket              = "${local.name}-qoe-raw"
  object_lock_enabled = true
  # Never destroyed by terraform with data in it: it is the record.
  force_destroy = false
  tags          = { Name = "${local.name}-qoe-raw" }
}

resource "aws_s3_bucket_public_access_block" "qoe_raw" {
  bucket                  = aws_s3_bucket.qoe_raw.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "qoe_raw" {
  bucket = aws_s3_bucket.qoe_raw.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "qoe_raw" {
  bucket = aws_s3_bucket.qoe_raw.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_versioning" "qoe_raw" {
  bucket = aws_s3_bucket.qoe_raw.id
  versioning_configuration { status = "Enabled" }
}

# Governance, not compliance: an administrator with s3:BypassGovernanceRetention
# can still remove data (a customer's deletion request, a bad write), nobody else.
resource "aws_s3_bucket_object_lock_configuration" "qoe_raw" {
  bucket     = aws_s3_bucket.qoe_raw.id
  depends_on = [aws_s3_bucket_versioning.qoe_raw]
  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = var.qoe_raw_lock_days
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "qoe_raw" {
  bucket     = aws_s3_bucket.qoe_raw.id
  depends_on = [aws_s3_bucket_versioning.qoe_raw]

  rule {
    id     = "raw-reports-archive"
    status = "Enabled"
    filter { prefix = "qoe-raw/" }
    transition {
      days          = 30
      storage_class = "GLACIER_IR"
    }
    transition {
      days          = 90
      storage_class = "DEEP_ARCHIVE"
    }
    expiration {
      days = var.qoe_raw_retention_days
    }
    noncurrent_version_expiration { noncurrent_days = 1 }
  }

  rule {
    id     = "abort-incomplete-mpu"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 2 }
  }
}

data "aws_iam_policy_document" "control_plane_qoe_raw" {
  statement {
    sid       = "QoeRawWriteRead"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.qoe_raw.arn}/qoe-raw/*"]
  }
  statement {
    sid       = "QoeRawList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.qoe_raw.arn]
  }
}

resource "aws_iam_role_policy" "control_plane_qoe_raw" {
  name   = "qoe-raw"
  role   = aws_iam_role.control_plane.id
  policy = data.aws_iam_policy_document.control_plane_qoe_raw.json
}

# What every control-plane role runs with (ecs_services.tf, scaling_services.tf).
locals {
  qoe_env = concat([
    { name = "QOE_RAW_BUCKET", value = aws_s3_bucket.qoe_raw.id },
    { name = "QOE_RAW_PREFIX", value = "qoe-raw" },
    { name = "QOE_RAW_REGION", value = var.region },
    # Each session derived by the one task that owns it (sidRoute.ts); the
    # task finds its own address from the ECS task metadata.
    { name = "QOE_ROUTE", value = "auto" },
  ], local.cdn_logs_env, local.clickhouse_env) # the CDN's real-time logs (cdn_logs.tf); which analytics store (clickhouse.tf)
}
