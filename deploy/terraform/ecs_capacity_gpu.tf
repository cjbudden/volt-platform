# ---- GPU node group (live captions: Whisper and translation) -----------------
# Only the captions add-on (volt-encoder/Dockerfile.captions, task definition
# below in ecs_services.tf) needs a GPU, and only while a stream runs with the
# whisper engine. So the group starts at zero servers and costs nothing until a
# captions task is waiting for one; managed scaling adds a server then and
# removes it once it is empty. Placement (services/fleet/placementPlanner.ts)
# sends GPU work here and keeps every other task off it (ECS_GPU_PROVIDER).
#
# On demand only: the planner never puts captions on Spot (lifecyclesFor), and
# a Spot reclaim would cut the words mid-programme.
#
# gpu_max = 0 turns the pool off: no capacity provider is created and the
# control plane is not told about one, so a whisper channel runs without its
# captions task (the planner says "no GPU server pool is configured").

data "aws_ssm_parameter" "ecs_gpu_ami" {
  count = var.gpu_max > 0 ? 1 : 0
  name  = "/aws/service/ecs/optimized-ami/amazon-linux-2023/gpu/recommended/image_id"
}

resource "aws_launch_template" "ecs_gpu" {
  count         = var.gpu_max > 0 ? 1 : 0
  name_prefix   = "${local.name}-ecs-gpu-"
  image_id      = data.aws_ssm_parameter.ecs_gpu_ami[0].value
  instance_type = var.gpu_instance_types[0]
  # The GPU AMI turns GPU support on by itself; saying it here as well means a
  # custom AMI swapped in later cannot quietly hide the GPU from ECS.
  user_data = base64encode(<<-EOT
    #!/bin/bash
    echo "ECS_CLUSTER=${var.project}" >> /etc/ecs/ecs.config
    echo "ECS_ENABLE_GPU_SUPPORT=true" >> /etc/ecs/ecs.config
    echo "ECS_CONTAINER_STOP_TIMEOUT=120s" >> /etc/ecs/ecs.config
    echo "ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION=15m" >> /etc/ecs/ecs.config
    %{if var.captions_gpu_sharing~}
    # Captions sharing the GPU reserve none of it, so they reach it through
    # Docker's default runtime. The GPU AMI already makes that NVIDIA's; this
    # makes sure, and restarts Docker before the ECS agent starts any task.
    if command -v nvidia-ctk >/dev/null && ! grep -q '"default-runtime": *"nvidia"' /etc/docker/daemon.json 2>/dev/null; then
      nvidia-ctk runtime configure --runtime=docker --set-as-default && systemctl restart docker
    fi
    %{endif~}
  EOT
  )

  # Sized for the CUDA captions images (gpu_root_volume_gib); see ecs_cluster.tf.
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = var.gpu_root_volume_gib
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  iam_instance_profile {
    arn = aws_iam_instance_profile.ecs_instance.arn
  }
  vpc_security_group_ids = [aws_security_group.encoder.id]

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.name}-ecs-gpu-node" }
  }
}

resource "aws_autoscaling_group" "gpu" {
  count                 = var.gpu_max > 0 ? 1 : 0
  name                  = "${local.name}-gpu"
  vpc_zone_identifier   = aws_subnet.private[*].id
  min_size              = 0
  max_size              = var.gpu_max
  desired_capacity      = 0
  protect_from_scale_in = true

  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = 0
      on_demand_percentage_above_base_capacity = 100
    }
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.ecs_gpu[0].id
        version            = "$Latest"
      }
      dynamic "override" {
        for_each = var.gpu_instance_types
        content {
          instance_type = override.value
        }
      }
    }
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }
  lifecycle {
    create_before_destroy = true
    ignore_changes        = [desired_capacity]
  }
}

resource "aws_ecs_capacity_provider" "gpu" {
  count = var.gpu_max > 0 ? 1 : 0
  name  = "${var.project}-gpu"
  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.gpu[0].arn
    managed_termination_protection = "ENABLED"
    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 1
    }
  }
}
