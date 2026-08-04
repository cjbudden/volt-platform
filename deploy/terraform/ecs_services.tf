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
    environment = [
      { name = "PORT", value = "8080" },
      { name = "S3_BUCKET", value = aws_s3_bucket.origin.id },
      { name = "CDN_BASE_URL", value = "https://${aws_cloudfront_distribution.cdn.domain_name}" },
      { name = "AWS_REGION", value = var.region },
      { name = "ECS_CLUSTER", value = aws_ecs_cluster.main.name },
      { name = "ORCH_LAUNCHER", value = "ecs" },
      { name = "ENCODER_TASK_DEF", value = "${local.name}-encoder" },
      { name = "THUMBNAILER_TASK_DEF", value = "${local.name}-thumbnailer" },
      { name = "ECS_SPOT_PROVIDER", value = aws_ecs_capacity_provider.spot.name },
      { name = "ECS_ONDEMAND_PROVIDER", value = aws_ecs_capacity_provider.ondemand.name },
      { name = "ECS_SUBNETS", value = join(",", aws_subnet.private[*].id) },
      { name = "ECS_SECURITY_GROUPS", value = aws_security_group.encoder.id },
      { name = "INTERNAL_API_BASE_URL", value = "http://${aws_lb.cp.dns_name}" },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.app.arn}:DATABASE_URL::" },
      { name = "JWT_ACCESS_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:JWT_ACCESS_SECRET::" },
      { name = "JWT_REFRESH_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:JWT_REFRESH_SECRET::" },
      { name = "INGEST_TOKEN", valueFrom = "${aws_secretsmanager_secret.app.arn}:INGEST_TOKEN::" },
    ]
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
