# On-demand play tokens at the edge, issue and enforce (build queue P2 and
# P2-2b, edge_tokens.tf, s3_cloudfront.tf). Planned against mocked providers:
#   terraform init -backend=false && terraform test -filter=tests/edge_tokens.tftest.hcl
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
mock_provider "random" {}

variables {
  control_plane_image_tag = "v0.87.0"
}

# issue (the default): tokens checked on /t/*, plain paths still play.
run "issue_by_default" {
  command = plan
  assert {
    condition     = length(aws_cloudfront_function.vod_token) == 1 && length(aws_cloudfront_function.vod_plain_refuse) == 0
    error_message = "issue should have the token function and no refuse function"
  }
  assert {
    condition     = length([for b in aws_cloudfront_distribution.cdn.ordered_cache_behavior : b if contains(["/vod/*", "/clips/vod/*", "/clips/*"], b.path_pattern)]) == 0
    error_message = "issue must not refuse plain on-demand paths"
  }
  assert {
    condition     = one([for e in local.control_plane_env : e.value if e.name == "VOLT_EDGE_TOKENS"]) == "issue"
    error_message = "the control plane should be told issue"
  }
}

# enforce: plain /vod/* and /clips/vod/* refused at CloudFront, before the
# *.m3u8 and *.mpd behaviours, and the control plane told enforce.
run "enforce_refuses_plain_paths" {
  command = plan
  variables {
    edge_tokens = "enforce"
  }
  assert {
    condition     = length(aws_cloudfront_function.vod_plain_refuse) == 1 && length(aws_cloudfront_function.vod_token) == 1
    error_message = "enforce needs the token function and the refuse function"
  }
  # Token-free titles (build queue P2-2c): the refuse function reads "f:<id>" from the store.
  assert {
    condition     = length(aws_cloudfront_function.vod_plain_refuse[0].key_value_store_associations) == 1
    error_message = "the refuse function needs the store to let token-free titles through"
  }
  assert {
    condition     = [for b in aws_cloudfront_distribution.cdn.ordered_cache_behavior : b.path_pattern if contains(["/vod/*", "/clips/vod/*"], b.path_pattern)] == ["/vod/*", "/clips/vod/*"]
    error_message = "enforce should add the two plain behaviours"
  }
  assert {
    condition     = index([for b in aws_cloudfront_distribution.cdn.ordered_cache_behavior : b.path_pattern], "/clips/vod/*") < index([for b in aws_cloudfront_distribution.cdn.ordered_cache_behavior : b.path_pattern], "*.m3u8")
    error_message = "the plain behaviours must come before *.m3u8"
  }
  # Clip output folders (build queue P2-2d): /clips/<asset id>/* refused too,
  # after /clips/vod/* and before *.m3u8, with the same refuse function.
  assert {
    condition     = length([for b in aws_cloudfront_distribution.cdn.ordered_cache_behavior : b if b.path_pattern == "/clips/*"]) == 1
    error_message = "enforce should add a /clips/* behaviour for clip output folders"
  }
  assert {
    condition     = index([for b in aws_cloudfront_distribution.cdn.ordered_cache_behavior : b.path_pattern], "/clips/vod/*") < index([for b in aws_cloudfront_distribution.cdn.ordered_cache_behavior : b.path_pattern], "/clips/*") && index([for b in aws_cloudfront_distribution.cdn.ordered_cache_behavior : b.path_pattern], "/clips/*") < index([for b in aws_cloudfront_distribution.cdn.ordered_cache_behavior : b.path_pattern], "*.m3u8")
    error_message = "/clips/* must come after /clips/vod/* and before *.m3u8"
  }
  assert {
    condition     = one([for e in local.control_plane_env : e.value if e.name == "VOLT_EDGE_TOKENS"]) == "enforce"
    error_message = "the control plane should be told enforce"
  }
}

# Without the rights store there are no tokens, whatever edge_tokens says.
run "enforce_without_store_is_off" {
  command = plan
  variables {
    edge_tokens         = "enforce"
    edge_rights_enabled = false
  }
  assert {
    condition     = length(aws_cloudfront_function.vod_plain_refuse) == 0 && length([for b in aws_cloudfront_distribution.cdn.ordered_cache_behavior : b if b.path_pattern == "/vod/*"]) == 0
    error_message = "no store: nothing to enforce"
  }
  assert {
    condition     = one([for e in local.control_plane_env : e.value if e.name == "VOLT_EDGE_TOKENS"]) == "off"
    error_message = "no store: the control plane should be told off"
  }
}

run "edge_tokens_must_be_known" {
  command = plan
  variables {
    edge_tokens = "strict"
  }
  expect_failures = [var.edge_tokens]
}
