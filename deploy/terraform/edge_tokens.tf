# ============================================================================
#  EDGE PLAY TOKENS FOR ON-DEMAND MEDIA (build queue P2,
#  volt-app/src/services/edgeTokens.ts, PUBLISHING_POLICIES.md).
#
#  The play gate hands out on-demand URLs as /t/<token>/vod/<id>/...; a
#  CloudFront Function (deploy/edge/vod-token-viewer-request.js) checks the
#  token on every manifest and segment request (signature, expiry, folder,
#  viewer country, the revocation set) and strips the prefix, so S3 and the
#  cache see the plain path. The signing key ("k:pt") and the revocations
#  ("r:<asset id>") live in the rights KeyValueStore, written by the control
#  plane's edge sync. Needs edge_rights_enabled (the store).
#
#  "issue" (default): tokens handed out and checked; plain paths still play.
#  "enforce": as issue, and plain on-demand paths (/vod/* and /clips/vod/*)
#  are refused by a second function (deploy/edge/vod-plain-refuse.js); the API
#  refuses plain /clips/vod/ on its own address too. The console's previews
#  and share pages carry tokens, so they keep playing (build queue P2-2b).
#  "off": the gate hands out plain URLs as before.
# ============================================================================

variable "edge_tokens" {
  description = "On-demand play tokens at the edge: issue (hand out /t/<token>/ URLs and check them), enforce (also refuse plain on-demand paths) or off."
  type        = string
  default     = "issue"
  validation {
    condition     = contains(["off", "issue", "enforce"], var.edge_tokens)
    error_message = "edge_tokens must be off, issue or enforce."
  }
}

locals {
  edge_tokens_on = var.edge_rights_enabled && var.edge_tokens != "off"
  # What the control plane is told (VOLT_EDGE_TOKENS): off without the store.
  edge_tokens_mode = local.edge_tokens_on ? var.edge_tokens : "off"
  # Under enforce: the plain on-demand paths, refused. Listed after the /t/
  # behaviours and before *.m3u8 and *.mpd, which would otherwise take them.
  edge_plain_vod_paths = local.edge_tokens_mode == "enforce" ? ["/vod/*", "/clips/vod/*"] : []
  # Manifests first (short cache), then everything else under /t/ (segments,
  # long cache). The function strips /t/<token>, so the cache key is the
  # plain path and every viewer shares one cached copy.
  edge_token_paths = local.edge_tokens_on ? [
    { path = "/t/*.m3u8", cache = "manifest" },
    { path = "/t/*.mpd", cache = "manifest" },
    { path = "/t/*", cache = "segment" },
  ] : []
}

resource "aws_cloudfront_function" "vod_token" {
  count   = local.edge_tokens_on ? 1 : 0
  name    = "${local.name}-vod-token"
  runtime = "cloudfront-js-2.0"
  comment = "Volt on-demand play tokens: check, then strip /t/<token>"
  publish = true
  code = templatefile("${path.module}/../edge/vod-token-viewer-request.js", {
    kvs_id = aws_cloudfront_key_value_store.rights[0].id
  })
  key_value_store_associations = [aws_cloudfront_key_value_store.rights[0].arn]
}

resource "aws_cloudfront_function" "vod_plain_refuse" {
  count   = local.edge_tokens_mode == "enforce" ? 1 : 0
  name    = "${local.name}-vod-plain-refuse"
  runtime = "cloudfront-js-2.0"
  comment = "Volt on-demand play tokens enforced: refuse a plain path unless the title is token-free"
  publish = true
  # Reads "f:<asset id>" (token-free titles, build queue P2-2c) from the same store.
  code = templatefile("${path.module}/../edge/vod-plain-refuse.js", {
    kvs_id = aws_cloudfront_key_value_store.rights[0].id
  })
  key_value_store_associations = [aws_cloudfront_key_value_store.rights[0].arn]
}

# The function compares the token's country with the viewer's, so the
# viewer-country header must reach it. Forwarded, never in the cache key.
resource "aws_cloudfront_origin_request_policy" "vod_token" {
  count   = local.edge_tokens_on ? 1 : 0
  name    = "${local.name}-vod-token"
  comment = "On-demand play tokens: the viewer country for the token check"
  cookies_config { cookie_behavior = "none" }
  headers_config {
    header_behavior = "whitelist"
    headers { items = ["CloudFront-Viewer-Country"] }
  }
  query_strings_config { query_string_behavior = "none" }
}
