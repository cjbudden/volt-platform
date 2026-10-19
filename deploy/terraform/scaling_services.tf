# ============================================================================
#  ROLE SERVICES + AUTOSCALING
#
#  One image, four ECS services, chosen by ROLE (src/scale/config.ts):
#
#    control_plane  ROLE=api-admin   console + admin API; owns migrations
#                   (ROLE=all when enable_role_split = false: does everything)
#    api_public     ROLE=api-public  viewer surface only; scales 2 -> 60+
#    scheduler      ROLE=scheduler   one leader (advisory lock) + standby
#    worker         ROLE=worker      background jobs; scales on queue depth
#
#  The ALB sends viewer paths to api_public (scaling_alb.tf); CloudFront sits
#  in front of the ALB (scaling_edge.tf).
# ============================================================================

locals {
  split = var.enable_role_split ? 1 : 0

  # What pre-warm raises before a big event: the viewer tier, or the single
  # service when roles are not split.
  public_service_name = "${local.name}-api-public"
  prewarm_target      = var.enable_role_split ? "service/${var.project}/${local.public_service_name}" : "service/${var.project}/${local.name}-control-plane"

  # Settings every role gets, on top of local.control_plane_env.
  scale_env = [
    { name = "REDIS_URL", value = local.redis_url },
    # Sign-in codes by text message (scaling_identity.tf)
    { name = "SMS_PROVIDER", value = var.sms_provider },
    { name = "SMS_SENDER_ID", value = var.sms_sender_id },
    { name = "SMS_ORIGINATION_NUMBER", value = var.sms_origination_number },
    { name = "TRUST_EDGE_GEO", value = var.enable_api_edge ? "true" : "false" },
    { name = "DB_POOL_MAX", value = tostring(var.db_pool_max_per_task) },
    { name = "ANALYTICS_SESSIONS", value = var.analytics_sessions },
    { name = "ANALYTICS_FIREHOSE_STREAM", value = var.enable_analytics_firehose ? "${local.name}-beacons" : "" },
    { name = "CLOUDWATCH_METRICS", value = "true" },
    { name = "METRICS_SERVICE_NAME", value = local.name },
    { name = "PREWARM_MODE", value = var.prewarm_mode },
    { name = "PREWARM_BASE_MIN", value = tostring(var.enable_role_split ? var.api_public_min : var.control_plane_desired) },
    { name = "PREWARM_MAX_TASKS", value = tostring(var.enable_role_split ? var.api_public_max : var.api_admin_max) },
    { name = "PREWARM_STARTS_PER_TASK", value = tostring(var.prewarm_starts_per_task) },
    { name = "PREWARM_ORIGIN_FRACTION", value = tostring(var.enable_api_edge ? var.prewarm_origin_fraction : 1) },
  ]

  scale_secrets = [
    { name = "DATABASE_LISTEN_URL", valueFrom = "${aws_secretsmanager_secret.app.arn}:DATABASE_LISTEN_URL::" },
    { name = "EDGE_SHARED_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:EDGE_SHARED_SECRET::" },
    { name = "PLAYBACK_TOKEN_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:PLAYBACK_TOKEN_SECRET::" },
    { name = "VIEWER_JWT_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:VIEWER_JWT_SECRET::" },
    { name = "MFA_ENCRYPTION_KEY", valueFrom = "${aws_secretsmanager_secret.app.arn}:MFA_ENCRYPTION_KEY::" },
  ]

  live_check = ["CMD-SHELL", "node -e \"fetch('http://localhost:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]

  role_tasks = {
    api-public = { cpu = var.api_public_cpu, memory = var.api_public_memory, extra = [] }
    scheduler  = { cpu = 512, memory = 1024, extra = [{ name = "PREWARM_ECS_RESOURCE_IDS", value = local.prewarm_target }] }
    worker     = { cpu = var.worker_cpu, memory = var.worker_memory, extra = [{ name = "WORKER_CONCURRENCY", value = tostring(var.worker_concurrency) }] }
  }
}

resource "aws_ecs_task_definition" "role" {
  for_each                 = var.enable_role_split ? local.role_tasks : {}
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(each.value.cpu)
  memory                   = tostring(each.value.memory)
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.control_plane.arn

  container_definitions = jsonencode([{
    name         = "control-plane"
    image        = "${aws_ecr_repository.repo["volt-control-plane"].repository_url}:${var.control_plane_image_tag}"
    essential    = true
    portMappings = [{ containerPort = 8080, protocol = "tcp" }]
    environment  = concat(local.control_plane_env, local.scale_env, local.image_env, local.docs_env, [{ name = "ROLE", value = each.key }], each.value.extra)
    secrets      = concat(local.control_plane_secrets, local.scale_secrets, local.image_secrets, local.docs_secrets)
    healthCheck  = { command = local.live_check, interval = 15, timeout = 5, retries = 3, startPeriod = 90 }
    stopTimeout  = 30
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.control_plane.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = each.key
      }
    }
  }])
}

resource "aws_ecs_service" "api_public" {
  count           = local.split
  name            = local.public_service_name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.role["api-public"].arn
  desired_count   = var.api_public_min
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.control_plane.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.public[0].arn
    container_name   = "control-plane"
    container_port   = 8080
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 120

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener_rule.public]
}

resource "aws_ecs_service" "scheduler" {
  count           = local.split
  name            = "${local.name}-scheduler"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.role["scheduler"].arn
  desired_count   = var.scheduler_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.control_plane.id]
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  # Keep a leader during deploys: start the new tasks before stopping the old.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
}

resource "aws_ecs_service" "worker" {
  count           = local.split
  name            = "${local.name}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.role["worker"].arn
  desired_count   = var.worker_min
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.control_plane.id]
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}

# ---- Autoscaling: viewer tier --------------------------------------------------
# Target tracking on requests per task AND CPU (whichever asks for more wins).
# Reactive scaling needs 1-2 minutes per step, so big starts are pre-warmed by
# the scheduler from the EPG (src/scale/prewarm.ts) on top of this.

resource "aws_appautoscaling_target" "api_public" {
  count              = local.split
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api_public[0].name}"
  min_capacity       = var.api_public_min
  max_capacity       = var.api_public_max
}

resource "aws_appautoscaling_policy" "api_public_requests" {
  count              = local.split
  name               = "${local.name}-api-public-requests"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api_public[0].service_namespace
  scalable_dimension = aws_appautoscaling_target.api_public[0].scalable_dimension
  resource_id        = aws_appautoscaling_target.api_public[0].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.api_public_requests_per_target
    scale_out_cooldown = 30
    scale_in_cooldown  = 300
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.cp.arn_suffix}/${aws_lb_target_group.public[0].arn_suffix}"
    }
  }
}

resource "aws_appautoscaling_policy" "api_public_cpu" {
  count              = local.split
  name               = "${local.name}-api-public-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api_public[0].service_namespace
  scalable_dimension = aws_appautoscaling_target.api_public[0].scalable_dimension
  resource_id        = aws_appautoscaling_target.api_public[0].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.api_public_cpu_target
    scale_out_cooldown = 30
    scale_in_cooldown  = 300
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# ---- Autoscaling: admin / single control plane ------------------------------------

resource "aws_appautoscaling_target" "control_plane" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.control_plane.name}"
  min_capacity       = var.control_plane_desired
  max_capacity       = var.api_admin_max
}

resource "aws_appautoscaling_policy" "control_plane_cpu" {
  name               = "${local.name}-control-plane-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.control_plane.service_namespace
  scalable_dimension = aws_appautoscaling_target.control_plane.scalable_dimension
  resource_id        = aws_appautoscaling_target.control_plane.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_out_cooldown = 60
    scale_in_cooldown  = 300
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# ---- Autoscaling: workers on queue depth --------------------------------------------
# Volt/JobsQueued is published by the scheduler leader (src/scale/metrics.ts).

resource "aws_appautoscaling_target" "worker" {
  count              = local.split
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.worker[0].name}"
  min_capacity       = var.worker_min
  max_capacity       = var.worker_max
}

resource "aws_appautoscaling_policy" "worker_out" {
  count              = local.split
  name               = "${local.name}-worker-out"
  policy_type        = "StepScaling"
  service_namespace  = aws_appautoscaling_target.worker[0].service_namespace
  scalable_dimension = aws_appautoscaling_target.worker[0].scalable_dimension
  resource_id        = aws_appautoscaling_target.worker[0].resource_id

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 60
    metric_aggregation_type = "Average"
    step_adjustment {
      metric_interval_lower_bound = 0
      metric_interval_upper_bound = var.worker_scale_out_queue * 4
      scaling_adjustment          = 1
    }
    step_adjustment {
      metric_interval_lower_bound = var.worker_scale_out_queue * 4
      scaling_adjustment          = 3
    }
  }
}

resource "aws_appautoscaling_policy" "worker_in" {
  count              = local.split
  name               = "${local.name}-worker-in"
  policy_type        = "StepScaling"
  service_namespace  = aws_appautoscaling_target.worker[0].service_namespace
  scalable_dimension = aws_appautoscaling_target.worker[0].scalable_dimension
  resource_id        = aws_appautoscaling_target.worker[0].resource_id

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 300
    metric_aggregation_type = "Average"
    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = -1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "jobs_backlog" {
  count               = local.split
  alarm_name          = "${local.name}-jobs-backlog"
  namespace           = "Volt"
  metric_name         = "JobsQueued"
  dimensions          = { Service = local.name }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 2
  threshold           = var.worker_scale_out_queue
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.worker_out[0].arn]
}

resource "aws_cloudwatch_metric_alarm" "jobs_idle" {
  count               = local.split
  alarm_name          = "${local.name}-jobs-idle"
  namespace           = "Volt"
  metric_name         = "JobsQueued"
  dimensions          = { Service = local.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_appautoscaling_policy.worker_in[0].arn]
}

# ---- Runtime permissions the scale features need -----------------------------------

data "aws_iam_policy_document" "control_plane_scale" {
  # Pre-warm: raise / restore the viewer tier's minimum capacity.
  statement {
    actions = [
      "application-autoscaling:RegisterScalableTarget",
      "application-autoscaling:DescribeScalableTargets",
      "ecs:DescribeServices",
      "ecs:UpdateService",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:PutMetricAlarm",
    ]
    resources = ["*"]
  }
  statement {
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["arn:aws:iam::*:role/aws-service-role/ecs.application-autoscaling.amazonaws.com/*"]
  }
  # Queue-depth metrics for worker autoscaling.
  statement {
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["Volt"]
    }
  }
  # Raw beacons to Firehose (only used when enable_analytics_firehose).
  statement {
    actions   = ["firehose:PutRecordBatch", "firehose:PutRecord"]
    resources = ["arn:aws:firehose:${var.region}:*:deliverystream/${local.name}-beacons"]
  }
}

resource "aws_iam_role_policy" "control_plane_scale" {
  name   = "scale"
  role   = aws_iam_role.control_plane.id
  policy = data.aws_iam_policy_document.control_plane_scale.json
}
