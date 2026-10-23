# ---- S3 origin --------------------------------------------------------------
resource "aws_s3_bucket" "origin" {
  bucket        = "${local.name}-origin"
  force_destroy = true
  tags          = { Name = "${local.name}-origin" }
}

resource "aws_s3_bucket_public_access_block" "origin" {
  bucket                  = aws_s3_bucket.origin.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "origin" {
  bucket = aws_s3_bucket.origin.id
  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = ["*"]
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

# Expire raw recording segments per the platform's retention model is done in
# the app (per-recording expires_at). This lifecycle sweeps aborted uploads.
resource "aws_s3_bucket_lifecycle_configuration" "origin" {
  bucket = aws_s3_bucket.origin.id
  rule {
    id     = "abort-incomplete-mpu"
    status = "Enabled"
    abort_incomplete_multipart_upload {
      days_after_initiation = 3
    }
  }
}

# ---- CloudFront -------------------------------------------------------------
resource "aws_cloudfront_origin_access_control" "origin" {
  name                              = "${local.name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Manifests: short TTL (they mutate every segment). Segments: immutable, long TTL.
resource "aws_cloudfront_cache_policy" "manifest" {
  name        = "${local.name}-manifest"
  default_ttl = 2
  min_ttl     = 0
  max_ttl     = 6
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
  }
}

resource "aws_cloudfront_cache_policy" "segment" {
  name        = "${local.name}-segment"
  default_ttl = 86400
  min_ttl     = 86400
  max_ttl     = 31536000
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
    enable_accept_encoding_gzip   = false
    enable_accept_encoding_brotli = false
  }
}

resource "aws_cloudfront_distribution" "cdn" {
  enabled         = true
  comment         = "${local.name} OTT delivery"
  is_ipv6_enabled = true
  price_class     = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.origin.bucket_regional_domain_name
    origin_id                = "s3-origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.origin.id
  }

  # The variant manifest service (EDGE_RIGHTS_VARIANTS.md): a replaced
  # viewer's playlist is made by the control plane from the delivered one,
  # not stored. The rights function rewrites such a request to
  # /<kind>/<id>/v/<key>/<file> and picks this origin by its id. Origin
  # Shield collapses every edge location's misses into one request per
  # variant playlist per cache period, so the service's load follows the
  # number of variants, never the audience.
  dynamic "origin" {
    for_each = var.edge_rights_enabled ? [1] : []
    content {
      domain_name = aws_lb.cp.dns_name
      origin_id   = "variants"
      custom_origin_config {
        http_port                = 80
        https_port               = 443
        origin_protocol_policy   = var.alb_origin_protocol
        origin_ssl_protocols     = ["TLSv1.2"]
        origin_read_timeout      = 30
        origin_keepalive_timeout = 60
      }
      origin_shield {
        enabled              = true
        origin_shield_region = var.region
      }
      # Proves to the API the viewer country came from here (TRUST_EDGE_GEO).
      custom_header {
        name  = "X-Volt-Edge"
        value = random_password.edge_shared.result
      }
    }
  }

  # A variant asked for by its own path: the rights function still decides
  # (only its own audience gets it), the variants origin answers. Listed
  # before the *.m3u8 and *.mpd behaviours so they never send it to S3.
  dynamic "ordered_cache_behavior" {
    for_each = var.edge_rights_enabled ? ["/channel/*/v/*", "/event/*/v/*"] : []
    content {
      path_pattern             = ordered_cache_behavior.value
      target_origin_id         = "variants"
      viewer_protocol_policy   = "redirect-to-https"
      allowed_methods          = ["GET", "HEAD", "OPTIONS"]
      cached_methods           = ["GET", "HEAD"]
      cache_policy_id          = aws_cloudfront_cache_policy.manifest.id
      origin_request_policy_id = aws_cloudfront_origin_request_policy.variants[0].id
      compress                 = true
      function_association {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.rights[0].arn
      }
    }
  }

  # Default: treat as segments (immutable, long cache).
  default_cache_behavior {
    target_origin_id       = "s3-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = aws_cloudfront_cache_policy.segment.id
    compress               = true
  }

  # HLS manifests — short TTL.
  ordered_cache_behavior {
    path_pattern           = "*.m3u8"
    target_origin_id       = "s3-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = aws_cloudfront_cache_policy.manifest.id
    compress               = true
    # edge_rights.tf: per-stream geo and blackout, decided per manifest request
    dynamic "function_association" {
      for_each = var.edge_rights_enabled ? [1] : []
      content {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.rights[0].arn
      }
    }
  }

  # DASH manifests — short TTL.
  ordered_cache_behavior {
    path_pattern           = "*.mpd"
    target_origin_id       = "s3-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = aws_cloudfront_cache_policy.manifest.id
    compress               = true
    # edge_rights.tf: per-stream geo and blackout, decided per manifest request
    dynamic "function_association" {
      for_each = var.edge_rights_enabled ? [1] : []
      content {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.rights[0].arn
      }
    }
  }

  restrictions {
    # See variables.tf: this is the blunt, whole-distribution edge stop. The
    # per-programme blackout lives in the play gate, not here.
    geo_restriction {
      restriction_type = var.cdn_geo_restriction_type
      locations        = var.cdn_geo_restriction_type == "none" ? [] : var.cdn_geo_countries
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = { Name = "${local.name}-cdn" }
}

# Bucket policy: only this CloudFront distribution may read the origin.
data "aws_iam_policy_document" "origin_bucket" {
  statement {
    sid       = "AllowCloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.origin.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.cdn.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "origin" {
  bucket = aws_s3_bucket.origin.id
  policy = data.aws_iam_policy_document.origin_bucket.json
}
