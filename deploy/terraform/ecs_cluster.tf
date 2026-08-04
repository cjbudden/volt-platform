# ECS-optimised AMI (Amazon Linux 2023). For GPU transcode swap to the
# *-gpu recommended parameter and a g-family instance type.
data "aws_ssm_parameter" "ecs_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}

locals {
  ecs_user_data = base64encode(<<-EOT
    #!/bin/bash
    echo "ECS_CLUSTER=${var.project}" >> /etc/ecs/ecs.config
    echo "ECS_ENABLE_SPOT_INSTANCE_DRAINING=true" >> /etc/ecs/ecs.config
    echo "ECS_CONTAINER_STOP_TIMEOUT=120s" >> /etc/ecs/ecs.config
  EOT
  )
}

resource "aws_ecs_cluster" "main" {
  name = var.project # matches control-plane config `ecsCluster` default 'volt'
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# ---- Launch template shared by both node groups -----------------------------
resource "aws_launch_template" "ecs" {
  name_prefix   = "${local.name}-ecs-"
  image_id      = data.aws_ssm_parameter.ecs_ami.value
  instance_type = var.encoder_instance_types[0]
  user_data     = local.ecs_user_data

  iam_instance_profile {
    arn = aws_iam_instance_profile.ecs_instance.arn
  }
  vpc_security_group_ids = [aws_security_group.encoder.id]

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.name}-ecs-node" }
  }
}

# ---- Spot node group (primary; cheap) ---------------------------------------
resource "aws_autoscaling_group" "spot" {
  name                = "${local.name}-spot"
  vpc_zone_identifier = aws_subnet.private[*].id
  min_size            = var.spot_min
  max_size            = var.spot_max
  desired_capacity    = var.spot_min

  capacity_rebalance = true

  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = 0
      on_demand_percentage_above_base_capacity = 0
      spot_allocation_strategy                 = "capacity-optimized"
    }
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.ecs.id
        version            = "$Latest"
      }
      dynamic "override" {
        for_each = var.encoder_instance_types
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
  }
}

# ---- On-demand node group (base=1 fallback for Spot interruptions) ----------
resource "aws_autoscaling_group" "ondemand" {
  name                = "${local.name}-ondemand"
  vpc_zone_identifier = aws_subnet.private[*].id
  min_size            = var.ondemand_min
  max_size            = var.ondemand_max
  desired_capacity    = var.ondemand_min

  launch_template {
    id      = aws_launch_template.ecs.id
    version = "$Latest"
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }
  lifecycle {
    create_before_destroy = true
  }
}

# ---- Capacity providers (names match control-plane config) ------------------
resource "aws_ecs_capacity_provider" "spot" {
  name = "${var.project}-spot"
  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.spot.arn
    managed_termination_protection = "DISABLED"
    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 4
    }
  }
}

resource "aws_ecs_capacity_provider" "ondemand" {
  name = "${var.project}-ondemand"
  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.ondemand.arn
    managed_termination_protection = "DISABLED"
    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 2
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name
  capacity_providers = [
    aws_ecs_capacity_provider.spot.name,
    aws_ecs_capacity_provider.ondemand.name,
    "FARGATE",
  ]

  # Default for the encoder: Spot weight 4 + on-demand base 1 (mirrors the
  # orchestrator's EcsTaskLauncher capacityProviderStrategy).
  default_capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.ondemand.name
    base              = 1
    weight            = 1
  }
  default_capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.spot.name
    base              = 0
    weight            = 4
  }
}
