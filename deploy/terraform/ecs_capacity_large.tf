# ---- Large node groups (heavy transcode ladders) ----------------------------
# Placement (volt-app/src/services/fleet/placementPlanner.ts) sends a stream to
# the SMALLEST pool whose every instance type can run it, so package-only
# channels, radio and light transcodes stay on the small groups and only a
# ladder that needs more than a 4-vCPU server (a full 1080p x264 ladder is
# about 4.6 vCPU) comes here. Both groups start at zero servers and cost
# nothing until a stream needs them; managed scaling adds a server when a task
# is waiting for one and removes it once it is empty.

resource "aws_autoscaling_group" "spot_large" {
  name                  = "${local.name}-spot-large"
  vpc_zone_identifier   = aws_subnet.private[*].id
  min_size              = 0
  max_size              = var.large_spot_max
  desired_capacity      = 0
  capacity_rebalance    = true
  protect_from_scale_in = true

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
        for_each = var.encoder_large_instance_types
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

resource "aws_autoscaling_group" "ondemand_large" {
  name                  = "${local.name}-ondemand-large"
  vpc_zone_identifier   = aws_subnet.private[*].id
  min_size              = 0
  max_size              = var.large_ondemand_max
  desired_capacity      = 0
  protect_from_scale_in = true

  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = 0
      on_demand_percentage_above_base_capacity = 100
    }
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.ecs.id
        version            = "$Latest"
      }
      dynamic "override" {
        for_each = var.encoder_large_instance_types
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

resource "aws_ecs_capacity_provider" "spot_large" {
  name = "${var.project}-spot-large"
  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.spot_large.arn
    managed_termination_protection = "ENABLED"
    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 2
    }
  }
}

resource "aws_ecs_capacity_provider" "ondemand_large" {
  name = "${var.project}-ondemand-large"
  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.ondemand_large.arn
    managed_termination_protection = "ENABLED"
    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 2
    }
  }
}
