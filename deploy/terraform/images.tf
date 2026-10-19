# ============================================================================
#  IMAGE SERVICE: bucket, derivative cache, image CDN, signing secret.
#  (volt-app/docs/IMAGES.md has the full picture.)
#
#  Request flow for https://<image cdn>/img/<sig>/<spec>/<key>:
#
#    viewer -> CloudFront edge (hit: done, 1 year immutable)
#           -> origin group, PRIMARY = S3 images bucket, prefix img-cache/
#                (hit: a size somebody already asked for, no API involved)
#           -> on 403/404, FAILOVER = the ALB -> api-public tasks
#                (verify signature, render with sharp, write img-cache/<path>,
#                 answer; the next edge miss anywhere is an S3 hit)
#
#  So each distinct derivative is rendered once, globally, and the API tasks
#  only ever see first requests and bad signatures.
#
#  The same bucket holds the image library originals (library/, derived/),
#  which stay private: CloudFront may read img-cache/* and nothing else.
# ============================================================================

variable "enable_image_edge" {
  type        = bool
  default     = true
  description = "Put the image CDN (CloudFront, S3-first origin group) in front of /img."
}

variable "image_edge_aliases" {
  type        = list(string)
  default     = []
  description = "Custom domain(s) for the image CDN, e.g. [\"img.example.com\"]. Needs image_edge_certificate_arn."
}

variable "image_edge_certificate_arn" {
  type        = string
  default     = ""
  description = "ACM certificate in us-east-1 for image_edge_aliases. Empty = the cloudfront.net domain."
}

variable "image_edge_price_class" {
  type        = string
  default     = "PriceClass_All"
  description = "CloudFront price class for the image CDN (PriceClass_100 / _200 / _All)."
}

variable "image_edge_origin_protocol" {
  type        = string
  default     = "http-only"
  description = "CloudFront to ALB for renders. Use https-only once the ALB has an HTTPS listener."
}

variable "image_cache_expire_days" {
  type        = number
  default     = 180
  description = "Rendered derivatives are deleted from S3 this many days after they were made (re-rendered on demand)."
}

variable "images_force_destroy" {
  type        = bool
  default     = false
  description = "Let terraform destroy delete a non-empty images bucket (customer originals). true only for throwaway environments."
}

variable "image_max_dimension" {
  type        = number
  default     = 4096
  description = "Largest width or height the image service will render (IMAGE_MAX_DIMENSION)."
}

variable "image_formats" {
  type        = string
  default     = "webp,avif,jpeg,png"
  description = "Output formats the image service accepts (IMAGE_FORMATS)."
}

locals {
  image_edge   = var.enable_image_edge ? 1 : 0
  image_prefix = "img-cache"
  image_public_base = var.enable_image_edge ? (
    length(var.image_edge_aliases) > 0 ? "https://${var.image_edge_aliases[0]}" : "https://${aws_cloudfront_distribution.images[0].domain_name}"
  ) : "http://${aws_lb.cp.dns_name}"
}

# ---- bucket: originals + derivative cache -------------------------------------
resource "aws_s3_bucket" "images" {
  bucket        = "${local.name}-images"
  force_destroy = var.images_force_destroy
  tags          = { Name = "${local.name}-images" }
}

resource "aws_s3_bucket_public_access_block" "images" {
  bucket                  = aws_s3_bucket.images.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "images" {
  bucket = aws_s3_bucket.images.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "images" {
  bucket = aws_s3_bucket.images.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# Originals are the customer's library: keep old versions for recovery.
resource "aws_s3_bucket_versioning" "images" {
  bucket = aws_s3_bucket.images.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "images" {
  bucket     = aws_s3_bucket.images.id
  depends_on = [aws_s3_bucket_versioning.images]

  # Derivatives are disposable: any one can be rebuilt from its URL.
  rule {
    id     = "expire-derivatives"
    status = "Enabled"
    filter { prefix = "${local.image_prefix}/" }
    expiration { days = var.image_cache_expire_days }
    noncurrent_version_expiration { noncurrent_days = 1 }
  }

  # Replaced or deleted originals stay recoverable for 30 days.
  rule {
    id     = "library-noncurrent"
    status = "Enabled"
    filter { prefix = "library/" }
    noncurrent_version_expiration { noncurrent_days = 30 }
  }

  rule {
    id     = "abort-incomplete-mpu"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 3 }
  }
}

# ---- CloudFront ------------------------------------------------------------------
resource "aws_cloudfront_origin_access_control" "images" {
  count                             = local.image_edge
  name                              = "${local.name}-images-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# The URL is the whole identity of a derivative (the signature covers the size,
# filters and key), so the cache key is the path alone: no query string, no
# cookies, no headers. TTLs come from the origin's Cache-Control (1 year).
resource "aws_cloudfront_cache_policy" "images" {
  count       = local.image_edge
  name        = "${local.name}-images"
  comment     = "Image derivatives: key = path only; TTL from origin (immutable, 1 year)"
  min_ttl     = 0
  default_ttl = 86400
  max_ttl     = 31536000
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
    # Images are already compressed; never vary on Accept-Encoding.
    enable_accept_encoding_gzip   = false
    enable_accept_encoding_brotli = false
  }
}

resource "aws_cloudfront_response_headers_policy" "images" {
  count   = local.image_edge
  name    = "${local.name}-images"
  comment = "CORS open for <img>/canvas, nosniff, no script"
  cors_config {
    access_control_allow_credentials = false
    access_control_allow_headers { items = ["*"] }
    access_control_allow_methods { items = ["GET", "HEAD", "OPTIONS"] }
    access_control_allow_origins { items = ["*"] }
    access_control_max_age_sec = 86400
    origin_override            = true
  }
  security_headers_config {
    content_type_options { override = true }
    content_security_policy {
      content_security_policy = "default-src 'none'"
      override                = true
    }
  }
  custom_headers_config {
    items {
      header   = "Cross-Origin-Resource-Policy"
      value    = "cross-origin"
      override = true
    }
    items {
      header   = "Timing-Allow-Origin"
      value    = "*"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "images" {
  count           = local.image_edge
  enabled         = true
  comment         = "${local.name} image service (S3 cache first, render on miss)"
  is_ipv6_enabled = true
  http_version    = "http2and3"
  price_class     = var.image_edge_price_class
  aliases         = var.image_edge_aliases

  # PRIMARY: rendered derivatives. CloudFront asks for <origin_path>/img/...,
  # which is exactly where the API writes them (IMAGE_CACHE_S3_PREFIX).
  origin {
    origin_id                = "img-cache"
    domain_name              = aws_s3_bucket.images.bucket_regional_domain_name
    origin_path              = "/${local.image_prefix}"
    origin_access_control_id = aws_cloudfront_origin_access_control.images[0].id
    connection_attempts      = 3
    connection_timeout       = 5
  }

  # FAILOVER: the API renders, caches to S3, answers.
  origin {
    origin_id   = "renderer"
    domain_name = aws_lb.cp.dns_name
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = var.image_edge_origin_protocol
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 30
      origin_keepalive_timeout = 60
    }
  }

  origin_group {
    origin_id = "images"
    failover_criteria {
      # S3 says 403 for a missing key when the reader cannot list the bucket.
      status_codes = [403, 404, 500, 502, 503, 504]
    }
    member { origin_id = "img-cache" }
    member { origin_id = "renderer" }
  }

  default_cache_behavior {
    target_origin_id           = "images"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = aws_cloudfront_cache_policy.images[0].id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.images[0].id
    compress                   = false
  }

  # Refusals are cached briefly so a flood of bad URLs cannot reach the API;
  # an overloaded renderer (503) is never cached.
  custom_error_response {
    error_code            = 400
    error_caching_min_ttl = 300
  }
  custom_error_response {
    error_code            = 403
    error_caching_min_ttl = 60
  }
  custom_error_response {
    error_code            = 404
    error_caching_min_ttl = 60
  }
  custom_error_response {
    error_code            = 503
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.image_edge_certificate_arn == ""
    acm_certificate_arn            = var.image_edge_certificate_arn == "" ? null : var.image_edge_certificate_arn
    ssl_support_method             = var.image_edge_certificate_arn == "" ? null : "sni-only"
    minimum_protocol_version       = var.image_edge_certificate_arn == "" ? "TLSv1" : "TLSv1.2_2021"
  }

  tags = { Name = "${local.name}-images" }
}

# CloudFront may read the derivative cache and nothing else in the bucket.
data "aws_iam_policy_document" "images_bucket" {
  count = local.image_edge
  statement {
    sid       = "CloudFrontReadsDerivatives"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.images.arn}/${local.image_prefix}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.images[0].arn]
    }
  }
}

resource "aws_s3_bucket_policy" "images" {
  count  = local.image_edge
  bucket = aws_s3_bucket.images.id
  policy = data.aws_iam_policy_document.images_bucket[0].json
}

# ---- runtime permissions ---------------------------------------------------------
data "aws_iam_policy_document" "control_plane_images" {
  statement {
    sid       = "ImageLibraryAndCache"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.images.arn}/*"]
  }
  statement {
    sid       = "ImageLibraryList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.images.arn]
  }
}

resource "aws_iam_role_policy" "control_plane_images" {
  name   = "images"
  role   = aws_iam_role.control_plane.id
  policy = data.aws_iam_policy_document.control_plane_images.json
}

# ---- signing secret -----------------------------------------------------------------
# Master secret for image URL signatures. Per-account keys are derived from it,
# so rotating it changes every image URL (they re-render once). To rotate
# without broken images: copy the current value to IMAGE_SIGNING_SECRET_PREVIOUS
# in this secret, set a new IMAGE_SIGNING_SECRET, redeploy, and clear PREVIOUS
# once pages and feeds have picked up the new URLs.
resource "random_password" "image_signing" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "images" {
  name                    = "${local.name}/images"
  description             = "Image service URL-signing master secret"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "images" {
  secret_id = aws_secretsmanager_secret.images.id
  secret_string = jsonencode({
    IMAGE_SIGNING_SECRET          = random_password.image_signing.result
    IMAGE_SIGNING_SECRET_PREVIOUS = ""
  })
  # Rotation is done in the console or CLI (see above); do not undo it here.
  lifecycle { ignore_changes = [secret_string] }
}

data "aws_iam_policy_document" "exec_images_secret" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.images.arn]
  }
}

resource "aws_iam_role_policy" "exec_images_secret" {
  name   = "read-images-secret"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.exec_images_secret.json
}

# ---- what every control-plane role runs with (ecs_services.tf, scaling_services.tf)
locals {
  image_env = [
    { name = "IMAGE_STORE_DRIVER", value = "s3" },
    { name = "IMAGE_S3_BUCKET", value = aws_s3_bucket.images.id },
    { name = "IMAGE_S3_PREFIX", value = "" },
    { name = "IMAGE_CACHE_DRIVER", value = "s3" },
    { name = "IMAGE_CACHE_S3_BUCKET", value = aws_s3_bucket.images.id },
    { name = "IMAGE_CACHE_S3_PREFIX", value = local.image_prefix },
    { name = "IMAGE_PUBLIC_BASE_URL", value = local.image_public_base },
    { name = "IMAGE_MAX_DIMENSION", value = tostring(var.image_max_dimension) },
    { name = "IMAGE_FORMATS", value = var.image_formats },
  ]
  image_secrets = [
    { name = "IMAGE_SIGNING_SECRET", valueFrom = "${aws_secretsmanager_secret.images.arn}:IMAGE_SIGNING_SECRET::" },
    { name = "IMAGE_SIGNING_SECRET_PREVIOUS", valueFrom = "${aws_secretsmanager_secret.images.arn}:IMAGE_SIGNING_SECRET_PREVIOUS::" },
  ]
}

output "image_cdn_base_url" {
  value       = local.image_public_base
  description = "Base of every signed image URL (IMAGE_PUBLIC_BASE_URL). Point your image domain's DNS here."
}

output "images_bucket" {
  value       = aws_s3_bucket.images.id
  description = "Image library originals (library/, derived/) and the derivative cache (img-cache/)."
}
