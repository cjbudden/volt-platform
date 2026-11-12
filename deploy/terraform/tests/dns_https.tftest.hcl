# HTTPS, certificates and DNS from the domain and its hosted zone (build queue
# D3, dns_https.tf). Planned against mocked providers:
#   terraform init -backend=false && terraform test -filter=tests/dns_https.tftest.hcl
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
# The second region for the dr tier's snapshot copies (resilience.tf).
mock_provider "aws" {
  alias = "backup_copy"
}
mock_provider "random" {}

variables {
  control_plane_image_tag = "v0.87.0"
}

# No domain: exactly the stack before D3. cloudfront.net names, a serving
# HTTP listener, CloudFront to the ALB over HTTP, nothing in Route 53.
run "no_domain_unchanged" {
  command = plan
  assert {
    condition     = length(aws_acm_certificate.edge) == 0 && length(aws_acm_certificate.alb) == 0 && length(aws_lb_listener.https) == 0
    error_message = "certificates or an HTTPS listener without a domain"
  }
  assert {
    condition     = length(aws_route53_record.cert_validation) == 0 && length(aws_route53_record.host) == 0
    error_message = "Route 53 records without a domain"
  }
  assert {
    condition     = aws_lb_listener.http.default_action[0].type == "forward"
    error_message = "the HTTP listener must serve when there is no HTTPS one"
  }
  assert {
    condition     = aws_cloudfront_distribution.cdn.viewer_certificate[0].cloudfront_default_certificate && length(aws_cloudfront_distribution.cdn.aliases) == 0
    error_message = "the delivery CDN must keep its cloudfront.net name"
  }
  assert {
    condition     = length(aws_cloudfront_distribution.api[0].aliases) == 0 && aws_cloudfront_distribution.api[0].viewer_certificate[0].cloudfront_default_certificate
    error_message = "the API edge must keep its cloudfront.net name"
  }
  assert {
    condition     = one([for o in aws_cloudfront_distribution.api[0].origin : o.custom_origin_config[0].origin_protocol_policy if o.origin_id == "alb"]) == "http-only"
    error_message = "CloudFront must reach an HTTP-only ALB over HTTP"
  }
  assert {
    condition     = output.hostnames == null && output.dns_validation_records == null && output.dns_host_records == null
    error_message = "hostnames or records to create without a domain"
  }
}

# Domain in a Route 53 zone: everything made here, nothing by hand.
run "domain_with_route53" {
  command = plan
  variables {
    domain_name     = "volt.example.com"
    route53_zone_id = "Z0123456789ABCDEFGHIJ"
  }
  assert {
    condition     = aws_acm_certificate.edge[0].domain_name == "cdn.volt.example.com" && toset(aws_acm_certificate.edge[0].subject_alternative_names) == toset(["api.volt.example.com", "img.volt.example.com"])
    error_message = "the CloudFront certificate must name cdn, api and img"
  }
  assert {
    condition     = aws_acm_certificate.alb[0].domain_name == "origin.volt.example.com" && length(aws_acm_certificate.alb[0].subject_alternative_names) == 0
    error_message = "the ALB certificate must name origin only while the API edge is on"
  }
  assert {
    condition     = aws_acm_certificate.edge[0].validation_method == "DNS" && aws_acm_certificate.alb[0].validation_method == "DNS"
    error_message = "certificates must validate through DNS"
  }
  assert {
    condition     = toset(keys(aws_route53_record.cert_validation)) == toset(["cdn.volt.example.com", "api.volt.example.com", "img.volt.example.com", "origin.volt.example.com"])
    error_message = "one validation record per certificate name"
  }
  assert {
    condition     = alltrue([for r in aws_route53_record.cert_validation : r.zone_id == "Z0123456789ABCDEFGHIJ"])
    error_message = "validation records must go in the given zone"
  }
  assert {
    condition     = toset(keys(aws_route53_record.host)) == toset(["origin/A", "cdn/A", "cdn/AAAA", "api/A", "api/AAAA", "images/A", "images/AAAA"])
    error_message = "host records: A for the ALB name, A and AAAA for each CloudFront name"
  }
  assert {
    condition     = aws_route53_record.host["api/A"].name == "api.volt.example.com" && aws_route53_record.host["origin/A"].name == "origin.volt.example.com"
    error_message = "host record names"
  }
  assert {
    condition     = length(aws_lb_listener.https) == 1 && aws_lb_listener.https[0].port == 443 && aws_lb_listener.https[0].protocol == "HTTPS" && aws_lb_listener.https[0].ssl_policy == "ELBSecurityPolicy-TLS13-1-2-2021-06"
    error_message = "the ALB needs an HTTPS listener with a TLS 1.2+ policy"
  }
  assert {
    condition     = aws_lb_listener.http.default_action[0].type == "redirect" && aws_lb_listener.http.default_action[0].redirect[0].protocol == "HTTPS" && aws_lb_listener.http.default_action[0].redirect[0].port == "443" && aws_lb_listener.http.default_action[0].redirect[0].status_code == "HTTP_301"
    error_message = "port 80 must redirect to HTTPS"
  }
  assert {
    condition     = aws_cloudfront_distribution.cdn.aliases == toset(["cdn.volt.example.com"]) && aws_cloudfront_distribution.cdn.viewer_certificate[0].ssl_support_method == "sni-only" && aws_cloudfront_distribution.cdn.viewer_certificate[0].minimum_protocol_version == "TLSv1.2_2021"
    error_message = "the delivery CDN must answer on cdn.<domain> with TLS 1.2+"
  }
  assert {
    condition     = aws_cloudfront_distribution.api[0].aliases == toset(["api.volt.example.com"]) && aws_cloudfront_distribution.images[0].aliases == toset(["img.volt.example.com"])
    error_message = "the API edge and image CDN must answer on api. and img.<domain>"
  }
  assert {
    condition     = one([for o in aws_cloudfront_distribution.api[0].origin : o.domain_name if o.origin_id == "alb"]) == "origin.volt.example.com" && one([for o in aws_cloudfront_distribution.api[0].origin : o.custom_origin_config[0].origin_protocol_policy if o.origin_id == "alb"]) == "https-only"
    error_message = "the API edge must reach the ALB as origin.<domain> over HTTPS"
  }
  assert {
    condition     = one([for o in aws_cloudfront_distribution.images[0].origin : o.domain_name if o.origin_id == "renderer"]) == "origin.volt.example.com" && one([for o in aws_cloudfront_distribution.images[0].origin : o.custom_origin_config[0].origin_protocol_policy if o.origin_id == "renderer"]) == "https-only"
    error_message = "the image CDN must reach the renderer as origin.<domain> over HTTPS"
  }
  assert {
    condition     = output.public_urls.api == "https://api.volt.example.com" && output.public_urls.cdn == "https://cdn.volt.example.com" && output.public_urls.images == "https://img.volt.example.com" && output.public_urls.internal == "https://origin.volt.example.com"
    error_message = "the URLs the tasks get must use the domain"
  }
  assert {
    condition     = output.control_plane_url == "https://api.volt.example.com" && output.cdn_domain == "cdn.volt.example.com"
    error_message = "control_plane_url and cdn_domain must follow the domain"
  }
  assert {
    condition     = output.dns_validation_records == null && output.dns_host_records == null
    error_message = "nothing to create by hand when Route 53 holds the zone"
  }
}

# Domain hosted elsewhere: certificates and listener as above, no Route 53,
# and the records to create listed in an output.
run "domain_elsewhere" {
  command = plan
  variables {
    domain_name = "volt.example.com"
  }
  assert {
    condition     = length(aws_route53_record.cert_validation) == 0 && length(aws_route53_record.host) == 0
    error_message = "no Route 53 records without a zone"
  }
  assert {
    condition     = length(aws_acm_certificate_validation.edge) == 1 && aws_acm_certificate_validation.edge[0].validation_record_fqdns == null
    error_message = "apply must wait for the hand-made validation records"
  }
  assert {
    condition     = length(output.dns_validation_records) == 4
    error_message = "one validation record to create per certificate name"
  }
  assert {
    condition     = toset([for h in output.dns_host_records : h.name]) == toset(["api.volt.example.com", "cdn.volt.example.com", "img.volt.example.com", "origin.volt.example.com"]) && alltrue([for h in output.dns_host_records : h.type == "CNAME"])
    error_message = "a CNAME to create for each host"
  }
  assert {
    condition     = length(aws_lb_listener.https) == 1 && aws_lb_listener.http.default_action[0].type == "redirect"
    error_message = "HTTPS on the ALB does not depend on Route 53"
  }
}

# No API edge: viewers reach the ALB as api.<domain>, so its certificate and
# record carry that name; no image CDN means no img. name anywhere.
run "domain_without_edges" {
  command = plan
  variables {
    domain_name       = "volt.example.com"
    route53_zone_id   = "Z0123456789ABCDEFGHIJ"
    enable_api_edge   = false
    enable_image_edge = false
  }
  assert {
    condition     = aws_acm_certificate.edge[0].domain_name == "cdn.volt.example.com" && length(aws_acm_certificate.edge[0].subject_alternative_names) == 0
    error_message = "the CloudFront certificate must name only distributions that exist"
  }
  assert {
    condition     = aws_acm_certificate.alb[0].subject_alternative_names == toset(["api.volt.example.com"])
    error_message = "the ALB certificate must cover api.<domain> when viewers reach it directly"
  }
  assert {
    condition     = toset(keys(aws_route53_record.host)) == toset(["origin/A", "cdn/A", "cdn/AAAA", "api/A"])
    error_message = "api.<domain> points at the ALB (IPv4) and there is no img record"
  }
  assert {
    condition     = output.public_urls.api == "https://api.volt.example.com" && output.hostnames.images == null
    error_message = "PUBLIC_BASE_URL is api.<domain> over HTTPS without the edge"
  }
}

# Other names under the domain.
run "own_hostnames" {
  command = plan
  variables {
    domain_name     = "tv.example.org"
    route53_zone_id = "Z0123456789ABCDEFGHIJ"
    hostnames       = { api = "app", cdn = "media" }
  }
  assert {
    condition     = output.hostnames.api == "app.tv.example.org" && output.hostnames.cdn == "media.tv.example.org" && output.hostnames.images == "img.tv.example.org" && output.hostnames.origin == "origin.tv.example.org"
    error_message = "hostnames must override only the labels given"
  }
}

# Aliases set by hand before D3 keep working and win over the derived name.
run "hand_set_aliases_kept" {
  command = plan
  variables {
    api_edge_aliases         = ["api.legacy.example"]
    api_edge_certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate/legacy"
    alb_origin_protocol      = "http-only"
  }
  assert {
    condition     = aws_cloudfront_distribution.api[0].aliases == toset(["api.legacy.example"]) && aws_cloudfront_distribution.api[0].viewer_certificate[0].acm_certificate_arn == "arn:aws:acm:us-east-1:111122223333:certificate/legacy"
    error_message = "a hand-set API alias and certificate must be used as before"
  }
  assert {
    condition     = output.public_urls.api == "https://api.legacy.example" && length(aws_acm_certificate.edge) == 0
    error_message = "the hand-set alias is PUBLIC_BASE_URL and no certificate is made"
  }
}

# A redirecting ALB behind CloudFront over HTTP would bounce every viewer.
run "http_origin_refused_with_domain" {
  command = plan
  variables {
    domain_name         = "volt.example.com"
    alb_origin_protocol = "http-only"
  }
  expect_failures = [aws_lb_listener.http]
}

run "domain_with_scheme_refused" {
  command = plan
  variables {
    domain_name = "https://volt.example.com/"
  }
  expect_failures = [var.domain_name]
}

run "duplicate_hostnames_refused" {
  command = plan
  variables {
    domain_name = "volt.example.com"
    hostnames   = { api = "cdn" }
  }
  expect_failures = [var.hostnames]
}

# Production with no domain plans, with a warning (check block).
run "prod_without_domain_warns" {
  command = plan
  variables {
    env = "prod"
  }
  expect_failures = [check.prod_has_a_domain]
}

# The domain-elsewhere procedure in APPLY.md, step 3: apply the certificates
# alone, then read the validation records before any distribution exists.
run "domain_elsewhere_targeted_certificates" {
  command = apply
  variables {
    domain_name = "volt.example.com"
  }
  plan_options {
    target = [aws_acm_certificate.edge, aws_acm_certificate.alb]
  }
  override_resource {
    target = aws_acm_certificate.edge[0]
    values = {
      arn = "arn:aws:acm:us-east-1:111122223333:certificate/edge"
      domain_validation_options = [
        { domain_name = "cdn.volt.example.com", resource_record_name = "_a1.cdn.volt.example.com.", resource_record_type = "CNAME", resource_record_value = "_v1.acm-validations.aws." },
        { domain_name = "api.volt.example.com", resource_record_name = "_a2.api.volt.example.com.", resource_record_type = "CNAME", resource_record_value = "_v2.acm-validations.aws." },
        { domain_name = "img.volt.example.com", resource_record_name = "_a3.img.volt.example.com.", resource_record_type = "CNAME", resource_record_value = "_v3.acm-validations.aws." },
      ]
    }
  }
  override_resource {
    target = aws_acm_certificate.alb[0]
    values = {
      arn = "arn:aws:acm:eu-west-1:111122223333:certificate/alb"
      domain_validation_options = [
        { domain_name = "origin.volt.example.com", resource_record_name = "_a4.origin.volt.example.com.", resource_record_type = "CNAME", resource_record_value = "_v4.acm-validations.aws." },
      ]
    }
  }
  assert {
    condition = toset(output.dns_validation_records) == toset([
      { name = "_a1.cdn.volt.example.com.", type = "CNAME", value = "_v1.acm-validations.aws." },
      { name = "_a2.api.volt.example.com.", type = "CNAME", value = "_v2.acm-validations.aws." },
      { name = "_a3.img.volt.example.com.", type = "CNAME", value = "_v3.acm-validations.aws." },
      { name = "_a4.origin.volt.example.com.", type = "CNAME", value = "_v4.acm-validations.aws." },
    ])
    error_message = "after the targeted apply the validation records must be readable"
  }
}
