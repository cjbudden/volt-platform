# ============================================================================
#  EDGE RIGHTS: per-stream geo and programme blackout on every manifest
#  request, behind the one stable play URL (no MediaTailor).
#
#  A CloudFront Function (viewer-request, cloudfront-js-2.0) reads the
#  viewer's country and the stream's rules from a CloudFront KeyValueStore;
#  the control plane keeps the store current (volt-app/src/services/
#  edgeRights.ts, EDGE_RIGHTS_KVS_ARN). Code: deploy/edge/rights-viewer-request.js.
#  Associated with the manifest behaviours only: segments never run it.
#
#  var.edge_rights_enabled = false leaves the distribution exactly as before.
# ============================================================================

variable "edge_rights_enabled" {
  description = "Run the rights function on HLS and DASH manifests (per-stream geo and programme blackout at the edge)."
  type        = bool
  default     = true
}

resource "aws_cloudfront_key_value_store" "rights" {
  count   = var.edge_rights_enabled ? 1 : 0
  name    = "${local.name}-rights"
  comment = "Volt edge rights: one key per stream (s:<id>), written by the control plane"
}

resource "aws_cloudfront_function" "rights" {
  count   = var.edge_rights_enabled ? 1 : 0
  name    = "${local.name}-rights"
  runtime = "cloudfront-js-2.0"
  comment = "Volt edge rights on manifests: allow, 451, or the replacement playlists"
  publish = true
  code = templatefile("${path.module}/../edge/rights-viewer-request.js", {
    kvs_id = aws_cloudfront_key_value_store.rights[0].id
  })
  key_value_store_associations = [aws_cloudfront_key_value_store.rights[0].arn]
}

# The control plane writes the keys (SigV4A data API).
data "aws_iam_policy_document" "edge_rights_writer" {
  count = var.edge_rights_enabled ? 1 : 0
  statement {
    actions = [
      "cloudfront-keyvaluestore:DescribeKeyValueStore",
      "cloudfront-keyvaluestore:GetKey",
      "cloudfront-keyvaluestore:PutKey",
      "cloudfront-keyvaluestore:DeleteKey",
      "cloudfront-keyvaluestore:ListKeys",
    ]
    resources = [aws_cloudfront_key_value_store.rights[0].arn]
  }
}

resource "aws_iam_role_policy" "edge_rights_writer" {
  count  = var.edge_rights_enabled ? 1 : 0
  name   = "${local.name}-edge-rights-writer"
  role   = aws_iam_role.control_plane.id
  policy = data.aws_iam_policy_document.edge_rights_writer[0].json
}

output "edge_rights_kvs_arn" {
  description = "Set as EDGE_RIGHTS_KVS_ARN on the control plane."
  value       = var.edge_rights_enabled ? aws_cloudfront_key_value_store.rights[0].arn : null
}
