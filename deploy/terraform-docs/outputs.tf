output "docs_url" {
  value = "https://${var.docs_domain}"
}

output "bucket" {
  value       = aws_s3_bucket.docs.id
  description = "scripts/docs/publish-docs.sh DOCS_BUCKET"
}

output "distribution_id" {
  value       = aws_cloudfront_distribution.docs.id
  description = "scripts/docs/publish-docs.sh DOCS_DISTRIBUTION_ID"
}

output "distribution_domain" {
  value = aws_cloudfront_distribution.docs.domain_name
}

# ---- For the platform stack (deploy/terraform): docs_* variables ------------
output "cloudfront_key_pair_id" {
  value       = aws_cloudfront_public_key.docs.id
  description = "platform var docs_key_pair_id (DOCS_CF_KEY_PAIR_ID)"
}

output "signing_key_secret_arn" {
  value       = aws_secretsmanager_secret.docs_signing_key.arn
  description = "platform var docs_signing_key_secret_arn (DOCS_CF_PRIVATE_KEY)"
}

output "cookie_domain" {
  value = var.cookie_domain
}

output "publish_policy_arn" {
  value = aws_iam_policy.publish.arn
}

output "app_url" {
  value       = var.app_url
  description = "scripts/docs/publish-docs.sh VOLT_APP_URL (the sign-in page's link back to Volt)"
}
