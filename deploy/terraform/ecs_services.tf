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
    environment = concat(local.control_plane_env, local.scale_env, local.image_env, local.docs_env, local.qoe_env, local.app_settings_env, local.operator_env, [
      { name = "ROLE", value = var.enable_role_split ? "api-admin" : "all" },
      { name = "PREWARM_ECS_RESOURCE_IDS", value = local.prewarm_target },
    ])
    secrets = concat(local.control_plane_secrets, local.scale_secrets, local.image_secrets, local.docs_secrets, local.app_settings_secrets, local.operator_secrets, local.clickhouse_secrets)
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

  lifecycle {
    precondition {
      condition     = length(setintersection(concat(keys(var.app_env), var.app_secret_keys), local.stack_env_names)) == 0
      error_message = "app_env and app_secret_keys cannot set a name the stack already sets: ${join(", ", setintersection(concat(keys(var.app_env), var.app_secret_keys), local.stack_env_names))}."
    }
    precondition {
      condition     = length(setintersection(keys(var.app_env), var.app_secret_keys)) == 0
      error_message = "A name is in both app_env and app_secret_keys: ${join(", ", setintersection(keys(var.app_env), var.app_secret_keys))}."
    }
  }
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
      # volt-encoder/bin/health_server.py: /healthz /readyz /metrics /status
      { name = "HEALTH_PORT", value = "9090" },
      # s3-uploader.sh: keep only this much of the run on the task disk once it
      # is in S3 (build queue 2.4c); S3 holds the whole run.
      { name = "LOCAL_KEEP_SECONDS", value = tostring(var.encoder_local_keep_seconds) },
    ]
    portMappings = [{ containerPort = 9090, protocol = "tcp" }]
    # LIVENESS only: a dead packager or a stalled supervisor. A lost source is
    # /readyz's business, and restarting the container would not fix it.
    healthCheck = {
      command     = ["CMD-SHELL", "curl -fsS http://127.0.0.1:9090/healthz || exit 1"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
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

# ---- Radio station task definition (one per station; launched by the orchestrator)
# volt-encoder/Dockerfile.radio: ffmpeg alone, audio in, HLS and DASH into the
# station's origin prefix and, when an Icecast relay is configured, MP3 pushed
# to it. With no relay reachable radio.py drops the MP3 output and the HLS and
# DASH carry on. Container name `radio` is what EcsTaskLauncher.launchRadio
# overrides. The reservation here is the floor; placement sizes each station
# with a task-level override (estimateRadioLoad).
resource "aws_ecs_task_definition" "radio" {
  family                   = "${local.name}-radio"
  requires_compatibilities = ["EC2"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.encoder_task.arn

  container_definitions = jsonencode([{
    name        = "radio"
    image       = "${aws_ecr_repository.repo["volt-radio"].repository_url}:latest"
    essential   = true
    stopTimeout = 30
    environment = [
      { name = "AWS_DEFAULT_REGION", value = var.region },
      { name = "S3_BUCKET", value = aws_s3_bucket.origin.id },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.encoder.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "radio"
      }
    }
  }])
}

# ---- Live captions task definition (Whisper add-on; launched with its stream)
# volt-encoder/Dockerfile.captions: reads the stream's audio playlist from the
# bucket and writes WebVTT renditions beside it. One GPU, so ECS can only place
# it on the GPU pool (ecs_capacity_gpu.tf); the orchestrator also launches it
# into that pool by name. Container name `captions` is what
# EcsTaskLauncher.launchCaptions overrides.
resource "aws_ecs_task_definition" "captions" {
  family                   = "${local.name}-captions"
  requires_compatibilities = ["EC2"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "4096"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.encoder_task.arn

  container_definitions = jsonencode([{
    name                 = "captions"
    image                = "${aws_ecr_repository.repo["volt-captions"].repository_url}:latest"
    essential            = true
    resourceRequirements = [{ type = "GPU", value = "1" }]
    stopTimeout          = 30
    environment = [
      { name = "AWS_DEFAULT_REGION", value = var.region },
      { name = "S3_BUCKET", value = aws_s3_bucket.origin.id },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.encoder.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "captions"
      }
    }
  }])
}

# ---- The same captions task, sharing its GPU (captions_gpu_sharing) ----------
# ECS can only reserve whole GPUs, so a task that asks for one has the server's
# T4 to itself, and two captioned channels pay for two servers. This one asks
# for none: placement (services/fleet/capacity.ts) packs captions tasks onto a
# GPU server while their GPU memory and GPU time fit, and the GPU AMI's NVIDIA
# runtime (the Docker default there, ensured in ecs_capacity_gpu.tf) gives the
# container the GPU when NVIDIA_VISIBLE_DEVICES asks for it. The launcher falls
# back to the task definition above when ECS will not start this one.
resource "aws_ecs_task_definition" "captions_shared" {
  family                   = "${local.name}-captions-shared"
  requires_compatibilities = ["EC2"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "4096"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.encoder_task.arn

  container_definitions = jsonencode([{
    name        = "captions"
    image       = "${aws_ecr_repository.repo["volt-captions"].repository_url}:latest"
    essential   = true
    stopTimeout = 30
    environment = [
      { name = "AWS_DEFAULT_REGION", value = var.region },
      { name = "S3_BUCKET", value = aws_s3_bucket.origin.id },
      { name = "NVIDIA_VISIBLE_DEVICES", value = "all" },
      { name = "NVIDIA_DRIVER_CAPABILITIES", value = "compute,utility" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.encoder.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "captions"
      }
    }
  }])
}

# ---- Control-plane settings shared by every role ------------------------------
locals {
  control_plane_env = [
    { name = "PORT", value = "8080" },
    # edge_rights.tf: the KeyValueStore the rights function reads; empty = off
    { name = "EDGE_RIGHTS_KVS_ARN", value = var.edge_rights_enabled ? aws_cloudfront_key_value_store.rights[0].arn : "" },
    # services/variantManifest.ts: the CDN sends replaced viewers to this
    # service (the "variants" origin in s3_cloudfront.tf); off with edge rights
    { name = "EDGE_VARIANT_SERVICE", value = var.edge_rights_enabled ? "1" : "0" },
    { name = "S3_BUCKET", value = aws_s3_bucket.origin.id },
    { name = "CDN_BASE_URL", value = "https://${aws_cloudfront_distribution.cdn.domain_name}" },
    { name = "AWS_REGION", value = var.region },
    { name = "ECS_CLUSTER", value = aws_ecs_cluster.main.name },
    { name = "ORCH_LAUNCHER", value = "ecs" },
    { name = "ENCODER_TASK_DEF", value = "${local.name}-encoder" },
    { name = "THUMBNAILER_TASK_DEF", value = "${local.name}-thumbnailer" },
    # Radio stations and the live captions add-on, each its own task definition.
    { name = "RADIO_TASK_DEF", value = "${local.name}-radio" },
    { name = "CAPTIONS_TASK_DEF", value = "${local.name}-captions" },
    # Captions sharing a GPU server (variables.tf captions_gpu_sharing): the task
    # definition that reserves no GPU, and the switch that lets placement use it.
    { name = "CAPTIONS_SHARED_TASK_DEF", value = "${local.name}-captions-shared" },
    { name = "FLEET_CAPTIONS_GPU_SHARING", value = var.captions_gpu_sharing ? "true" : "false" },
    # FAST channels (services/fast): playouts on ECS writing to the bucket, library
    # media packaged to the bucket so any task can read it, and the origin viewers
    # reach the ad stitcher on (per-viewer playlists, never cached).
    { name = "FAST_TASK_DEF", value = "${local.name}-fast" },
    { name = "FAST_OUTPUT", value = "s3" },
    { name = "VOD_STORE", value = "s3" },
    # Loops & Fillers (services/media/fillerStore.ts): slates and loops in the
    # bucket under filler/, served by whichever task is asked (build queue 2.1a).
    { name = "FILLER_STORE_DRIVER", value = "s3" },
    # Resumable uploads (services/uploadStaging.ts): chunks and tus parts wait in
    # the bucket under upload-staging/, because the load balancer sends one
    # upload's requests to any task (build queue 2.1a-2).
    { name = "UPLOAD_STAGING_DRIVER", value = "s3" },
    { name = "PUBLIC_BASE_URL", value = local.public_base_url },
    { name = "ECS_SPOT_PROVIDER", value = aws_ecs_capacity_provider.spot.name },
    { name = "ECS_ONDEMAND_PROVIDER", value = aws_ecs_capacity_provider.ondemand.name },
    # Placement (services/fleet): small and large pools, chosen per stream from its load.
    { name = "ECS_SPOT_LARGE_PROVIDER", value = aws_ecs_capacity_provider.spot_large.name },
    { name = "ECS_ONDEMAND_LARGE_PROVIDER", value = aws_ecs_capacity_provider.ondemand_large.name },
    { name = "FLEET_SMALL_TYPES", value = join(",", var.encoder_instance_types) },
    { name = "FLEET_LARGE_TYPES", value = join(",", var.encoder_large_instance_types) },
    # The GPU pool for captions (ecs_capacity_gpu.tf). Empty with gpu_max = 0:
    # placementConfig.ts then configures no GPU pool and says so per stream.
    { name = "ECS_GPU_PROVIDER", value = join("", aws_ecs_capacity_provider.gpu[*].name) },
    { name = "FLEET_GPU_TYPES", value = join(",", var.gpu_instance_types) },
    # The encoder servers' task disk (ecs_cluster.tf) and the window each
    # encoder keeps on it: placement's disk check counts that window, not the
    # whole run (services/fleet/storageProjection.ts). 0 keeps whole runs.
    { name = "FLEET_TASK_DISK_GIB", value = tostring(var.encoder_root_volume_gib) },
    { name = "ENCODER_LOCAL_KEEP_SECONDS", value = tostring(var.encoder_local_keep_seconds) },
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
