# ---- Valkey (ElastiCache) ------------------------------------------------------
# Shared cache for the viewer path (keys, apps, rights inputs) and exact
# concurrent-viewer counting. The app works without it (per-task caches); this
# makes a freshly scaled-out task warm from its first request and keeps viewer
# counts exact across tasks. REDIS_URL is wired into every role in
# scaling_services.tf.

resource "aws_security_group" "valkey" {
  count       = var.enable_valkey ? 1 : 0
  name        = "${local.name}-valkey"
  description = "Valkey: reachable from control-plane tasks only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Valkey from control plane"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.control_plane.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name}-valkey" }
}

resource "aws_elasticache_subnet_group" "valkey" {
  count      = var.enable_valkey ? 1 : 0
  name       = "${local.name}-valkey"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_replication_group" "valkey" {
  count                = var.enable_valkey ? 1 : 0
  replication_group_id = "${local.name}-valkey"
  description          = "Volt viewer-path cache and concurrency"
  engine               = "valkey"
  engine_version       = "8.0"
  node_type            = var.valkey_node_type
  port                 = 6379
  parameter_group_name = "default.valkey8"

  num_cache_clusters         = 1 + var.valkey_replicas
  automatic_failover_enabled = var.valkey_replicas > 0
  multi_az_enabled           = var.valkey_replicas > 0

  # TLS in transit (the app connects with rediss://), encrypted at rest.
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true

  subnet_group_name  = aws_elasticache_subnet_group.valkey[0].name
  security_group_ids = [aws_security_group.valkey[0].id]

  apply_immediately = var.env != "prod"
  tags              = { Name = "${local.name}-valkey" }
}

locals {
  redis_url = var.enable_valkey ? "rediss://${aws_elasticache_replication_group.valkey[0].primary_endpoint_address}:6379" : ""
}
