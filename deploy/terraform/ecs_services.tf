# ---- Log groups -------------------------------------------------------------
resource "aws_cloudwatch_log_group" "control_plane" {
  name              = "/ecs/${local.name}/control-plane"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "encoder" {
  name              = "/ecs/${local.name}/encoder"
  retention_in_days = 14
}

# ---- Control-plane task + service (Fargate, behind the ALB) -----------------
resource "aws_ecs_task_definition" "control_plane" {
  family                   = "${local.name}-control-plane"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.control_plane_cpu)
  memory                   = tostring(var.control_plane_memory)
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.control_plane.arn

  container_definitions = jsonencode([{
    name         = "control-plane"
    image        = "${aws_ecr_repository.repo["volt-control-plane"].repository_url}:${var.control_plane_image_tag}"
    essential    = true
    portMappings = [{ containerPort = 8080, protocol = "tcp" }]
    # The env list lives in local.control_plane_env (bottom of this file) so the
    # role services in scaling_services.tf run with exactly the same settings.
    environment = concat(local.control_plane_env, local.scale_env, local.image_env, local.docs_env, [
      { name = "ROLE", value = var.enable_role_split ? "api-admin" : "all" },
      { name = "PREWARM_ECS_RESOURCE_IDS", value = local.prewarm_target },
    ])
    secrets = concat(local.control_plane_secrets, local.scale_secrets, local.image_secrets, local.docs_secrets)
    # Liveness only (no database): a database blip must not restart every task.
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://localhost:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 90
    }
    stopTimeout = 30
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.control_plane.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "cp"
      }
    }
  }])
}

resource "aws_ecs_service" "control_plane" {
  name            = "${local.name}-control-plane"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.control_plane.arn
  desired_count   = var.control_plane_desired
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.control_plane.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.cp.arn
    container_name   = "control-plane"
    container_port   = 8080
  }

  # A deploy whose tasks never turn healthy rolls itself back.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 120

  # Autoscaling owns the running count (scaling_services.tf).
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.http]
}

# ---- Encoder/packager task definition (launched on demand by the orchestrator)
# No long-running service: the control plane RunTask's this per channel/event
# onto the Spot/on-demand capacity providers.
resource "aws_ecs_task_definition" "encoder" {
  family                   = "${local.name}-encoder"
  requires_compatibilities = ["EC2"]
  network_mode             = "awsvpc"
  cpu                      = "2048"
  memory                   = "4096"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.encoder_task.arn

  container_definitions = jsonencode([{
    name      = "encoder"
    image     = "${aws_ecr_repository.repo["volt-encoder"].repository_url}:latest"
    essential = true
    environment = [
      { name = "AWS_DEFAULT_REGION", value = var.region },
      { name = "S3_BUCKET", value = aws_s3_bucket.origin.id },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.encoder.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "enc"
      }
    }
  }])
}

# ---- Thumbnailer task definition (CPU keyscreen job; launched by orchestrator)
resource "aws_ecs_task_definition" "thumbnailer" {
  family                   = "${local.name}-thumbnailer"
  requires_compatibilities = ["EC2"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.encoder_task.arn

  container_definitions = jsonencode([{
    name      = "thumbnailer"
    image     = "${aws_ecr_repository.repo["volt-thumbnailer"].repository_url}:latest"
    essential = true
    environment = [
      { name = "AWS_DEFAULT_REGION", value = var.region },
      { name = "S3_BUCKET", value = aws_s3_bucket.origin.id },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.encoder.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "thumb"
      }
    }
  }])
}

# ---- FAST playout task definition (one per FAST channel; launched by the control plane)
# volt-encoder/Dockerfile.fast. Writes the channel's live playlists to the origin
# bucket (channel/<id>/fast/) and heartbeats to INTERNAL_API_BASE_URL. Small:
# it only reads playlists and writes text, the media is never touched.
# Same task role as the encoder (origin bucket read/write), so PassRole is unchanged.
resource "aws_ecs_task_definition" "fast" {
  family                   = "${local.name}-fast"
  requires_compatibilities = ["EC2"]
  network_mode             = "awsvpc"
  cpu                      = "128"
  memory                   = "256"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.encoder_task.arn

  container_definitions = jsonencode([{
    name      = "fast"
    image     = "${aws_ecr_repository.repo["volt-fast"].repository_url}:latest"
    essential = true
    # SIGTERM: final heartbeat with its state, then exit (fast_playout.py)
    stopTimeout = 10
    environment = [
      { name = "AWS_DEFAULT_REGION", value = var.region },
      { name = "S3_BUCKET", value = aws_s3_bucket.origin.id },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.encoder.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "fast"
      }
    }
  }])
}

# ---- Control-plane settings shared by every role ------------------------------
locals {
  control_plane_env = [
    { name = "PORT", value = "8080" },
    { name = "S3_BUCKET", value = aws_s3_bucket.origin.id },
    { name = "CDN_BASE_URL", value = "https://${aws_cloudfront_distribution.cdn.domain_name}" },
    { name = "AWS_REGION", value = var.region },
    { name = "ECS_CLUSTER", value = aws_ecs_cluster.main.name },
    { name = "ORCH_LAUNCHER", value = "ecs" },
    { name = "ENCODER_TASK_DEF", value = "${local.name}-encoder" },
    { name = "THUMBNAILER_TASK_DEF", value = "${local.name}-thumbnailer" },
    # FAST channels (services/fast): playouts on ECS writing to the bucket, library
    # media packaged to the bucket so any task can read it, and the origin viewers
    # reach the ad stitcher on (per-viewer playlists, never cached).
    { name = "FAST_TASK_DEF", value = "${local.name}-fast" },
    { name = "FAST_OUTPUT", value = "s3" },
    { name = "VOD_STORE", value = "s3" },
    { name = "PUBLIC_BASE_URL", value = local.public_base_url },
    { name = "ECS_SPOT_PROVIDER", value = aws_ecs_capacity_provider.spot.name },
    { name = "ECS_ONDEMAND_PROVIDER", value = aws_ecs_capacity_provider.ondemand.name },
    # Placement (services/fleet): small and large pools, chosen per stream from its load.
    { name = "ECS_SPOT_LARGE_PROVIDER", value = aws_ecs_capacity_provider.spot_large.name },
    { name = "ECS_ONDEMAND_LARGE_PROVIDER", value = aws_ecs_capacity_provider.ondemand_large.name },
    { name = "FLEET_SMALL_TYPES", value = join(",", var.encoder_instance_types) },
    { name = "FLEET_LARGE_TYPES", value = join(",", var.encoder_large_instance_types) },
    { name = "ECS_SUBNETS", value = join(",", aws_subnet.private[*].id) },
    { name = "ECS_SECURITY_GROUPS", value = aws_security_group.encoder.id },
    { name = "INTERNAL_API_BASE_URL", value = "http://${aws_lb.cp.dns_name}" },
  ]

  control_plane_secrets = [
    { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.app.arn}:DATABASE_URL::" },
    { name = "JWT_ACCESS_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:JWT_ACCESS_SECRET::" },
    { name = "JWT_REFRESH_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:JWT_REFRESH_SECRET::" },
    { name = "INGEST_TOKEN", valueFrom = "${aws_secretsmanager_secret.app.arn}:INGEST_TOKEN::" },
  ]
}
