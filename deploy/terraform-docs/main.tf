# ---- Bucket: private, read only through CloudFront --------------------------
resource "aws_s3_bucket" "docs" {
  bucket = local.name
}

resource "aws_s3_bucket_public_access_block" "docs" {
  bucket                  = aws_s3_bucket.docs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "docs" {
  bucket = aws_s3_bucket.docs.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# Versioning: every publish keeps the previous objects, so a bad publish can be
# rolled back by restoring versions (scripts/docs/publish-docs.sh --rollback prints how).
resource "aws_s3_bucket_versioning" "docs" {
  bucket = aws_s3_bucket.docs.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 90 }
    abort_incomplete_multipart_upload { days_after_initiation = 3 }
  }
}

resource "aws_cloudfront_origin_access_control" "docs" {
  name                              = local.name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "docs_bucket" {
  statement {
    sid       = "CloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.docs.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.docs.arn]
    }
  }
  # ListBucket lets a missing page answer 404 (the site's own 404 page) rather
  # than 403, which would otherwise look like "please sign in".
  statement {
    sid       = "CloudFrontList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.docs.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.docs.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "docs" {
  bucket = aws_s3_bucket.docs.id
  policy = data.aws_iam_policy_document.docs_bucket.json
}

# ---- Signing key: Volt issues signed cookies with the private half ----------
# Rotation: `terraform apply -replace=tls_private_key.docs`, then redeploy the
# platform so it reads the new key. People already reading the docs are asked
# to open them from Volt again; nothing else changes.
resource "tls_private_key" "docs" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "aws_cloudfront_public_key" "docs" {
  name        = "${local.name}-${substr(sha256(tls_private_key.docs.public_key_pem), 0, 8)}"
  encoded_key = tls_private_key.docs.public_key_pem
  comment     = "Volt docs sign-in cookies"
  lifecycle { create_before_destroy = true }
}

resource "aws_cloudfront_key_group" "docs" {
  name    = local.name
  items   = [aws_cloudfront_public_key.docs.id]
  comment = "Keys Volt signs docs cookies with"
}

resource "aws_secretsmanager_secret" "docs_signing_key" {
  name        = "${local.name}/signing-key"
  description = "PEM private key the Volt control plane uses to sign docs access cookies (DOCS_CF_PRIVATE_KEY)."
}

resource "aws_secretsmanager_secret_version" "docs_signing_key" {
  secret_id     = aws_secretsmanager_secret.docs_signing_key.id
  secret_string = tls_private_key.docs.private_key_pem
}

# ---- Clean URLs: /guides/epg -> /guides/epg.html ----------------------------
resource "aws_cloudfront_function" "rewrite" {
  name    = "${local.name}-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  comment = "Docusaurus clean URLs on S3"
  code    = <<-JS
    var ASSET = /\.(html|js|css|json|xml|txt|map|svg|png|jpe?g|gif|webp|ico|woff2?|ttf)$/i;
    function handler(event) {
      var r = event.request;
      if (r.uri.endsWith('/')) r.uri += 'index.html';
      else if (!ASSET.test(r.uri)) r.uri += '.html';
      return r;
    }
  JS
}

resource "aws_cloudfront_response_headers_policy" "docs" {
  name = local.name
  security_headers_config {
    content_type_options { override = true }
    frame_options {
      frame_option = "SAMEORIGIN"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = false
      override                   = true
    }
  }
  custom_headers_config {
    items {
      header   = "X-Robots-Tag"
      value    = "noindex, nofollow"
      override = true
    }
  }
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

# ---- Distribution -----------------------------------------------------------
resource "aws_cloudfront_distribution" "docs" {
  enabled             = true
  comment             = "Volt customer docs (${var.env})"
  aliases             = [var.docs_domain]
  default_root_object = "index.html"
  price_class         = var.price_class
  http_version        = "http2and3"

  origin {
    origin_id                = "docs-s3"
    domain_name              = aws_s3_bucket.docs.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.docs.id
  }

  # Everything needs a valid signed cookie from Volt...
  default_cache_behavior {
    target_origin_id           = "docs-s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.docs.id
    trusted_key_groups         = [aws_cloudfront_key_group.docs.id]
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.rewrite.arn
    }
  }

  # ...except the sign-in page, which must load without one.
  ordered_cache_behavior {
    path_pattern               = "/_public/*"
    target_origin_id           = "docs-s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.docs.id
  }

  # No (or an expired) cookie: CloudFront answers 403; show how to get in.
  custom_error_response {
    error_code            = 403
    response_code         = 403
    response_page_path    = "/_public/signin.html"
    error_caching_min_ttl = 0
  }
  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 60
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "docs" {
  count   = var.route53_zone_id == "" ? 0 : 1
  zone_id = var.route53_zone_id
  name    = var.docs_domain
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.docs.domain_name
    zone_id                = aws_cloudfront_distribution.docs.hosted_zone_id
    evaluate_target_health = false
  }
}

# ---- Who may publish: a narrow policy for the CI user / role -----------------
data "aws_iam_policy_document" "publish" {
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.docs.arn]
  }
  statement {
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.docs.arn}/*"]
  }
  statement {
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = [aws_cloudfront_distribution.docs.arn]
  }
}

resource "aws_iam_policy" "publish" {
  name        = "${local.name}-publish"
  description = "Publish the Volt docs site: sync the bucket and invalidate the CDN. Attach to the release role or CI user."
  policy      = data.aws_iam_policy_document.publish.json
}
