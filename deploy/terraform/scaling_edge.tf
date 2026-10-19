# ============================================================================
#  API EDGE: CloudFront + WAF in front of the ALB
#
#  What it does for the 1M-viewer start:
#    * caches GET /api/availability (the anonymous play gate) per app key,
#      asset, page Origin and viewer country, for as long as the API says
#      (s-maxage, at most 15 s and never across a programme boundary)
#    * caches the /live manifest redirect for 2 s per channel
#    * supplies CloudFront-Viewer-Country, which the API trusts only with the
#      X-Volt-Edge secret this distribution adds (TRUST_EDGE_GEO)
#    * carries the WAF: per-IP rate limits, login brute-force limit, AWS IP
#      reputation and known-bad-input rules
#  Everything else (console, admin API, beacons, SSE) passes straight through.
#
#  Point players, the console and DNS at the `api_edge_domain` output (or your
#  alias). The ALB stays reachable for encoders (INTERNAL_API_BASE_URL).
# ============================================================================

# WAF for CloudFront lives in us-east-1 whatever the stack's region.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = merge({
      Project   = var.project
      Env       = var.env
      ManagedBy = "terraform"
      Product   = "Volt Streaming"
    }, var.tags)
  }
}

locals {
  edge = var.enable_api_edge ? 1 : 0
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_cache_policy" "availability" {
  count       = local.edge
  name        = "${local.name}-availability"
  comment     = "Play gate: key = appKey + assetId + Origin + viewer country (+ viewer session); TTL from the API s-maxage"
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 60
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config {
      header_behavior = "whitelist"
      # Authorization: a signed-in viewer's request is keyed (and answered
      # no-store) on its own; anonymous requests carry none and share entries.
      headers { items = ["Origin", "CloudFront-Viewer-Country", "Authorization"] }
    }
    query_strings_config {
      query_string_behavior = "whitelist"
      query_strings { items = ["appKey", "assetId"] }
    }
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
  }
}

resource "aws_cloudfront_cache_policy" "live_redirect" {
  count       = local.edge
  name        = "${local.name}-live-redirect"
  comment     = "/live manifest redirect: same for every viewer of a channel; TTL from the API (2 s)"
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 10
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
  }
}

# For the play gate's POST: the body, its type, and the Referer (web app
# allow-lists) reach the API; nothing here is in the cache key because POST is
# never cached.
resource "aws_cloudfront_origin_request_policy" "viewer_api" {
  count   = local.edge
  name    = "${local.name}-viewer-api"
  comment = "Play gate: forward what restriction checks and analytics read"
  cookies_config { cookie_behavior = "none" }
  headers_config {
    header_behavior = "whitelist"
    headers { items = ["Referer", "User-Agent", "Content-Type", "Accept"] }
  }
  query_strings_config { query_string_behavior = "all" }
}

# For /api/access/* (never cached): the same, plus CloudFront's own viewer
# country, which the API uses instead of anything the client claims.
resource "aws_cloudfront_origin_request_policy" "viewer_api_geo" {
  count   = local.edge
  name    = "${local.name}-viewer-api-geo"
  comment = "Access check: forward restriction headers and the viewer country"
  cookies_config { cookie_behavior = "none" }
  headers_config {
    header_behavior = "whitelist"
    headers { items = ["Origin", "Referer", "User-Agent", "Content-Type", "Accept", "CloudFront-Viewer-Country"] }
  }
  query_strings_config { query_string_behavior = "all" }
}

resource "aws_cloudfront_distribution" "api" {
  count           = local.edge
  enabled         = true
  comment         = "${local.name} API edge (play gate cache, WAF)"
  is_ipv6_enabled = true
  price_class     = var.api_edge_price_class
  aliases         = var.api_edge_aliases
  web_acl_id      = aws_wafv2_web_acl.api[0].arn

  origin {
    domain_name = aws_lb.cp.dns_name
    origin_id   = "alb"
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = var.alb_origin_protocol
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }
    # Proves to the API the request came through here (EDGE_SHARED_SECRET).
    custom_header {
      name  = "X-Volt-Edge"
      value = random_password.edge_shared.result
    }
  }

  # Anonymous play gate (GET cached; POST passes through). Same for the
  # /api/public namespace.
  ordered_cache_behavior {
    path_pattern             = "/api/public/availability*"
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = aws_cloudfront_cache_policy.availability[0].id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.viewer_api[0].id
    compress                 = true
  }

  ordered_cache_behavior {
    path_pattern             = "/api/public/access/*"
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.viewer_api_geo[0].id
    compress                 = true
  }

  ordered_cache_behavior {
    path_pattern             = "/api/availability*"
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = aws_cloudfront_cache_policy.availability[0].id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.viewer_api[0].id
    compress                 = true
  }

  # Access check (booleans, no token). Not cached; viewer country from CloudFront.
  ordered_cache_behavior {
    path_pattern             = "/api/access/*"
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.viewer_api_geo[0].id
    compress                 = true
  }

  # Public live manifests: a 302 per channel, held for 2 s.
  ordered_cache_behavior {
    path_pattern           = "/live/*"
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = aws_cloudfront_cache_policy.live_redirect[0].id
    compress               = true
  }

  # Everything else: console, admin API, beacons, SSE. No caching, all headers
  # (Authorization included) forwarded.
  default_cache_behavior {
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
    compress                 = true
  }

  restrictions {
    geo_restriction {
      restriction_type = var.cdn_geo_restriction_type
      locations        = var.cdn_geo_restriction_type == "none" ? [] : var.cdn_geo_countries
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = length(var.api_edge_aliases) == 0
    acm_certificate_arn            = length(var.api_edge_aliases) == 0 ? null : var.api_edge_certificate_arn
    ssl_support_method             = length(var.api_edge_aliases) == 0 ? null : "sni-only"
    minimum_protocol_version       = length(var.api_edge_aliases) == 0 ? "TLSv1" : "TLSv1.2_2021"
  }

  tags = { Name = "${local.name}-api-edge" }
}

# ---- WAF ---------------------------------------------------------------------

resource "aws_wafv2_web_acl" "api" {
  count    = local.edge
  provider = aws.us_east_1
  name     = "${local.name}-api"
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Password guessing on the operator login.
  rule {
    name     = "login-rate"
    priority = 1
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit                 = var.waf_auth_rate_limit_per_ip
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/auth/"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-login-rate"
      sampled_requests_enabled   = true
    }
  }

  # One IP hammering the API. Generous: a stadium or a mobile carrier puts many
  # real viewers behind one address.
  rule {
    name     = "ip-rate"
    priority = 2
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit                 = var.waf_rate_limit_per_ip
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-ip-rate"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-ip-reputation"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-ip-reputation"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 11
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-api"
    sampled_requests_enabled   = true
  }
}
