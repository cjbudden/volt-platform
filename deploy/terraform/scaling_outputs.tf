output "api_edge_domain" {
  value       = var.enable_api_edge ? aws_cloudfront_distribution.api[0].domain_name : null
  description = "Point players, the console and your API DNS here (CloudFront + WAF in front of the ALB)."
}

output "valkey_endpoint" {
  value = var.enable_valkey ? aws_elasticache_replication_group.valkey[0].primary_endpoint_address : null
}

output "db_proxy_endpoint" {
  value = var.enable_rds_proxy ? aws_db_proxy.pg[0].endpoint : null
}

output "role_services" {
  value = {
    api_admin  = aws_ecs_service.control_plane.name
    api_public = var.enable_role_split ? aws_ecs_service.api_public[0].name : null
    scheduler  = var.enable_role_split ? aws_ecs_service.scheduler[0].name : null
    worker     = var.enable_role_split ? aws_ecs_service.worker[0].name : null
  }
  description = "ECS services per role. With enable_role_split = false the control-plane service runs every role."
}

output "beacons_bucket" {
  value = var.enable_analytics_firehose ? aws_s3_bucket.analytics[0].id : null
}
