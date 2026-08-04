output "control_plane_url" {
  value       = "http://${aws_lb.cp.dns_name}"
  description = "Public control-plane API endpoint (add HTTPS + a domain for prod)."
}

output "cdn_domain" {
  value       = aws_cloudfront_distribution.cdn.domain_name
  description = "CloudFront delivery domain — set as CDN_BASE_URL."
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
