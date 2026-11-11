output "control_plane_url" {
  value       = local.https ? "https://${local.host.api}" : "http://${aws_lb.cp.dns_name}"
  description = "Public control-plane API endpoint: https://api.<domain> with domain_name set, else the ALB over HTTP."
}

output "cdn_domain" {
  value       = local.https ? local.host.cdn : aws_cloudfront_distribution.cdn.domain_name
  description = "Delivery domain (CDN_BASE_URL without the scheme): cdn.<domain> with domain_name set, else the cloudfront.net name."
}

output "origin_bucket" {
  value = aws_s3_bucket.origin.id
}

output "db_endpoint" {
  value = aws_db_instance.pg.address
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.repo : k => r.repository_url }
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "capacity_providers" {
  value = {
    spot     = aws_ecs_capacity_provider.spot.name
    ondemand = aws_ecs_capacity_provider.ondemand.name
  }
}

output "app_secret_arn" {
  value       = aws_secretsmanager_secret.app.arn
  description = "Secrets Manager ARN holding DATABASE_URL/JWT/INGEST_TOKEN."
}

output "integrations_secret_arn" {
  value       = aws_secretsmanager_secret.integrations.arn
  description = "Populate with Axinom DRM key + social OAuth tokens after apply."
}

output "image_tags" {
  value = {
    control_plane = var.control_plane_image_tag
    encoders      = local.encoder_image_tag
  }
  description = "Release tags the task definitions Terraform writes use. scripts/deploy/deploy.mjs moves services and per-stream families itself and records them in release/deployments.json."
}
