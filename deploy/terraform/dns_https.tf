# ============================================================================
#  HTTPS, CERTIFICATES AND DNS (build queue D3)
#
#  The manual inputs are the domain and, when it is hosted in Route 53, its
#  hosted zone:
#
#    domain_name     = "volt.example.com"
#    route53_zone_id = "Z0123456789ABCDEFGHIJ"   # optional
#
#  From those Terraform makes:
#
#    api.<domain>     the console and the API (the API edge, or the ALB when
#                     enable_api_edge is off)
#    cdn.<domain>     on-demand and live delivery (the OTT CloudFront)
#    img.<domain>     the image CDN (when enable_image_edge is on)
#    origin.<domain>  the ALB itself: what CloudFront and the encoders talk to
#                     over HTTPS. Viewers never need it.
#
#  Two certificates, both validated through DNS: one in us-east-1 for the
#  CloudFront names (CloudFront only reads certificates from there) and one in
#  the stack's region for the ALB. The ALB gets an HTTPS listener and its port
#  80 answers with a redirect, so nothing reaches the API in the clear, and the
#  edge secret (X-Volt-Edge) no longer crosses the internet unencrypted.
#
#  With a hosted zone the validation records and the A/AAAA aliases are made
#  here and the first apply finishes by itself. Without one, apply the two
#  certificates first, create the records the `dns_validation_records` output
#  lists at your DNS provider, then apply the rest (APPLY.md, step 3).
#
#  domain_name empty (the default) leaves everything as before: cloudfront.net
#  names and a plain HTTP ALB, so a throwaway environment still stands up with
#  no domain at all.
# ============================================================================

variable "domain_name" {
  type        = string
  default     = ""
  description = "Domain Volt is served under, e.g. volt.example.com. Empty = cloudfront.net names and an HTTP-only ALB (throwaway environments)."
  validation {
    condition     = var.domain_name == "" || can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$", var.domain_name))
    error_message = "domain_name must be a lower-case DNS name such as volt.example.com: no scheme, no path, no trailing dot."
  }
}

variable "route53_zone_id" {
  type        = string
  default     = ""
  description = "Route 53 hosted zone that holds domain_name. Set: certificate validation and the host records are made by Terraform. Empty: create the records in the dns_validation_records and dns_host_records outputs at your DNS provider."
}

variable "hostnames" {
  type = object({
    api    = optional(string, "api")
    cdn    = optional(string, "cdn")
    images = optional(string, "img")
    origin = optional(string, "origin")
  })
  default     = {}
  description = "The first label of each host under domain_name. The defaults give api., cdn., img. and origin.<domain>."
  validation {
    condition     = alltrue([for v in values(var.hostnames) : can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", v))]) && length(distinct(values(var.hostnames))) == length(values(var.hostnames))
    error_message = "Each hostname is one lower-case DNS label, and no two may be the same."
  }
}

locals {
  https       = var.domain_name != ""
  https_count = local.https ? 1 : 0
  # Route 53 records only when the zone is known; count needs a plan-time value.
  r53 = local.https && var.route53_zone_id != ""

  host = { for k, v in var.hostnames : k => "${v}.${var.domain_name}" }

  # Names on the CloudFront certificate: only distributions that exist. The
  # delivery CDN always exists, so the list is never empty.
  edge_cert_names = local.https ? compact([
    local.host.cdn,
    var.enable_api_edge ? local.host.api : "",
    var.enable_image_edge ? local.host.images : "",
  ]) : []
  # Names on the ALB certificate. Without the API edge, viewers and the console
  # come to the ALB directly under api.<domain>, so it needs that name too.
  alb_cert_names = local.https ? compact([
    local.host.origin,
    var.enable_api_edge ? "" : local.host.api,
  ]) : []

  # What each distribution and the ALB use. An alias set by hand
  # (api_edge_aliases, image_edge_aliases, with their certificates) wins over
  # the derived one, so stacks set up before D3 behave exactly as before.
  api_edge_aliases = length(var.api_edge_aliases) > 0 ? var.api_edge_aliases : (
    local.https && var.enable_api_edge ? [local.host.api] : []
  )
  api_edge_certificate_arn = length(var.api_edge_aliases) > 0 ? var.api_edge_certificate_arn : (
    local.https ? aws_acm_certificate_validation.edge[0].certificate_arn : ""
  )
  image_edge_aliases = length(var.image_edge_aliases) > 0 ? var.image_edge_aliases : (
    local.https && var.enable_image_edge ? [local.host.images] : []
  )
  image_edge_certificate_arn = length(var.image_edge_aliases) > 0 ? var.image_edge_certificate_arn : (
    local.https ? aws_acm_certificate_validation.edge[0].certificate_arn : ""
  )
  cdn_aliases         = local.https ? [local.host.cdn] : []
  cdn_certificate_arn = local.https ? aws_acm_certificate_validation.edge[0].certificate_arn : null

  # CloudFront reaches the ALB by a name its certificate covers, over HTTPS.
  # alb_origin_protocol / image_edge_origin_protocol set by hand still win.
  alb_origin_host       = local.https ? local.host.origin : aws_lb.cp.dns_name
  alb_origin_protocol   = var.alb_origin_protocol != "" ? var.alb_origin_protocol : (local.https ? "https-only" : "http-only")
  image_origin_protocol = var.image_edge_origin_protocol != "" ? var.image_edge_origin_protocol : (local.https ? "https-only" : "http-only")

  # Encoders, radio and FAST containers call the API here (INTERNAL_API_BASE_URL).
  alb_base_url = local.https ? "https://${local.host.origin}" : "http://${aws_lb.cp.dns_name}"
  # Viewers fetch delivered media here (CDN_BASE_URL).
  cdn_base_url = local.https ? "https://${local.host.cdn}" : "https://${aws_cloudfront_distribution.cdn.domain_name}"
}

# ---- certificates -----------------------------------------------------------

resource "aws_acm_certificate" "edge" {
  count                     = local.https_count
  provider                  = aws.us_east_1
  domain_name               = local.edge_cert_names[0]
  subject_alternative_names = slice(local.edge_cert_names, 1, length(local.edge_cert_names))
  validation_method         = "DNS"
  tags                      = { Name = "${local.name}-edge" }

  # A name change makes a new certificate; the distributions move to it before
  # the old one goes, so viewers never meet a missing certificate.
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate" "alb" {
  count                     = local.https_count
  domain_name               = local.alb_cert_names[0]
  subject_alternative_names = slice(local.alb_cert_names, 1, length(local.alb_cert_names))
  validation_method         = "DNS"
  tags                      = { Name = "${local.name}-alb" }

  lifecycle {
    create_before_destroy = true
  }
}

locals {
  # Validation records by certificate name. Keyed by our own names (known at
  # plan) rather than by the certificate's answer (known only after create).
  acm_dvo = local.https ? {
    for o in concat(
      tolist(aws_acm_certificate.edge[0].domain_validation_options),
      tolist(aws_acm_certificate.alb[0].domain_validation_options),
    ) : o.domain_name => o
  } : {}
}

resource "aws_route53_record" "cert_validation" {
  for_each        = local.r53 ? toset(concat(local.edge_cert_names, local.alb_cert_names)) : toset([])
  zone_id         = var.route53_zone_id
  name            = local.acm_dvo[each.key].resource_record_name
  type            = local.acm_dvo[each.key].resource_record_type
  records         = [local.acm_dvo[each.key].resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

# Apply waits here until each certificate is issued. With Route 53 that takes
# a few minutes; without it, until the records are created by hand.
resource "aws_acm_certificate_validation" "edge" {
  count                   = local.https_count
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.edge[0].arn
  validation_record_fqdns = local.r53 ? [for n in local.edge_cert_names : aws_route53_record.cert_validation[n].fqdn] : null
  timeouts {
    create = "2h"
  }
}

resource "aws_acm_certificate_validation" "alb" {
  count                   = local.https_count
  certificate_arn         = aws_acm_certificate.alb[0].arn
  validation_record_fqdns = local.r53 ? [for n in local.alb_cert_names : aws_route53_record.cert_validation[n].fqdn] : null
  timeouts {
    create = "2h"
  }
}

# ---- the ALB's HTTPS listener ------------------------------------------------
# Port 80 (alb.tf) answers with a redirect to here once a domain is set.

resource "aws_lb_listener" "https" {
  count             = local.https_count
  load_balancer_arn = aws_lb.cp.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.alb[0].certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.cp.arn
  }
}

# ---- host records ------------------------------------------------------------

locals {
  # Where each host points. The ALB is IPv4 only (aws_lb.cp has no dualstack),
  # so its names get an A record; CloudFront names get A and AAAA.
  dns_targets = local.https ? merge(
    {
      origin = { name = local.host.origin, target = aws_lb.cp.dns_name, zone = aws_lb.cp.zone_id, ipv6 = false }
      cdn    = { name = local.host.cdn, target = aws_cloudfront_distribution.cdn.domain_name, zone = aws_cloudfront_distribution.cdn.hosted_zone_id, ipv6 = true }
      api = var.enable_api_edge ? {
        name = local.host.api, target = aws_cloudfront_distribution.api[0].domain_name, zone = aws_cloudfront_distribution.api[0].hosted_zone_id, ipv6 = true
        } : {
        name = local.host.api, target = aws_lb.cp.dns_name, zone = aws_lb.cp.zone_id, ipv6 = false
      }
    },
    var.enable_image_edge ? {
      images = { name = local.host.images, target = aws_cloudfront_distribution.images[0].domain_name, zone = aws_cloudfront_distribution.images[0].hosted_zone_id, ipv6 = true }
    } : {},
  ) : {}

  dns_alias_records = merge([
    for k, t in local.dns_targets : merge(
      { "${k}/A" = merge(t, { type = "A" }) },
      t.ipv6 ? { "${k}/AAAA" = merge(t, { type = "AAAA" }) } : {},
    )
  ]...)
}

resource "aws_route53_record" "host" {
  for_each = local.r53 ? local.dns_alias_records : {}
  zone_id  = var.route53_zone_id
  name     = each.value.name
  type     = each.value.type

  alias {
    name                   = each.value.target
    zone_id                = each.value.zone
    evaluate_target_health = false
  }
}

# ---- guards ------------------------------------------------------------------

# Production without a domain still works, but viewers see cloudfront.net
# names and the ALB answers plain HTTP. Say so on every plan.
check "prod_has_a_domain" {
  assert {
    condition     = var.env != "prod" || local.https
    error_message = "env is prod but domain_name is empty: the API is served over plain HTTP from the ALB and viewers get cloudfront.net names. Set domain_name (and route53_zone_id when Route 53 hosts it)."
  }
}

# ---- outputs -----------------------------------------------------------------

output "hostnames" {
  value = local.https ? {
    api    = local.host.api
    cdn    = local.host.cdn
    images = var.enable_image_edge ? local.host.images : null
    origin = local.host.origin
  } : null
  description = "The names Volt answers on (null without domain_name). api is the console and API, cdn delivery, images the image CDN, origin the ALB for CloudFront and the encoders."
}

output "public_urls" {
  value = {
    api      = local.public_base_url
    cdn      = local.cdn_base_url
    images   = local.image_public_base
    internal = local.alb_base_url
  }
  description = "PUBLIC_BASE_URL, CDN_BASE_URL, IMAGE_PUBLIC_BASE_URL and INTERNAL_API_BASE_URL as the tasks get them."
}

# Without route53_zone_id: what to create at the DNS provider. Two outputs, so
# the validation records can be read after a targeted apply of the
# certificates alone, before any distribution exists (APPLY.md, step 3).
output "dns_validation_records" {
  value = local.https && !local.r53 ? [for n in concat(local.edge_cert_names, local.alb_cert_names) : {
    name  = local.acm_dvo[n].resource_record_name
    type  = local.acm_dvo[n].resource_record_type
    value = local.acm_dvo[n].resource_record_value
  }] : null
  description = "Without route53_zone_id: the certificate validation records to create at your DNS provider. Apply waits for them."
}

output "dns_host_records" {
  value = local.https && !local.r53 ? [for k, t in local.dns_targets : {
    name  = t.name
    type  = "CNAME"
    value = t.target
  }] : null
  description = "Without route53_zone_id: the CNAME for each host to create at your DNS provider once the distributions exist."
}
