# ============================================================================
#  MEDIA JOBS, ONE TASK EACH (build queue 2.1a-4)
#
#  Clip extract, VOD encode, loop preparation, intro detection and the other
#  jobs that run ffmpeg, ffprobe, the packager or Python do not run in the
#  control plane: its image carries none of those tools (2.1a's decision).
#  The control plane's worker claims such a job and starts a task of this
#  definition for it (MEDIA_JOBS_MODE=ecs, volt-app/src/services/jobs/
#  mediaJobs.ts); the task runs that one job and exits.
#
#  Fargate rather than the encoder servers: each job gets its own scratch disk
#  (media_job_disk_gib) and can never fill a live encoder's disk. Fargate Spot
#  first (an interrupted job is retried by the queue), on-demand when Spot has
#  no room. It needs the database, so it runs in the control plane's security
#  group with the control plane's task role, settings and secrets.
# ============================================================================

variable "media_job_cpu" {
  type        = number
  default     = 2048
  description = "CPU units of each media-job task (1024 = one vCPU)."
}

variable "media_job_memory" {
  type        = number
  default     = 4096
  description = "Memory (MiB) of each media-job task."
}

variable "media_job_disk_gib" {
  type        = number
  default     = 100
  description = "Scratch disk (GiB) of each media-job task: an encode holds its original and its renditions while it runs. Fargate allows 21 to 200."
  validation {
    condition     = var.media_job_disk_gib >= 21 && var.media_job_disk_gib <= 200
    error_message = "media_job_disk_gib must be between 21 and 200 (Fargate ephemeral storage)."
  }
}

variable "media_job_max_tasks" {
  type        = number
  default     = 20
  description = "Most media-job tasks running at once; further media jobs wait in the queue (a cost ceiling)."
}

resource "aws_cloudwatch_log_group" "media_jobs" {
  name              = "/ecs/${local.name}/media-jobs"
  retention_in_days = 30
}

resource "aws_ecs_task_definition" "media_jobs" {
  family                   = "${local.name}-media-jobs"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.media_job_cpu)
  memory                   = tostring(var.media_job_memory)
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.control_plane.arn

  ephemeral_storage {
    size_in_gib = var.media_job_disk_gib
  }

  container_definitions = jsonencode([{
    # The name EcsTaskLauncher.mediaJobInput overrides (MEDIA_JOB_ID, MEDIA_JOB_WORKER).
    name      = "media-job"
    image     = "${aws_ecr_repository.repo["volt-media-jobs"].repository_url}:${var.control_plane_image_tag}"
    essential = true
    # The same settings and secrets as a worker of the control plane: the job's
    # handler is the control plane's own code.
    environment = concat(local.control_plane_env, local.scale_env, local.image_env, local.docs_env, local.qoe_env, local.app_settings_env, local.operator_env, [{ name = "ROLE", value = "worker" }])
    secrets     = concat(local.control_plane_secrets, local.scale_secrets, local.image_secrets, local.docs_secrets, local.app_settings_secrets, local.operator_secrets, local.clickhouse_secrets)
    stopTimeout = 30
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.media_jobs.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "job"
      }
    }
  }])
}
