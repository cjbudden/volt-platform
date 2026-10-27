# ============================================================================
#  CHAOS EXPERIMENTS (Tier 3, build queue 2.8)
#
#  AWS Fault Injection Service templates the chaos harness starts
#  (deploy/loadtest/chaos.mjs, run sheet deploy/loadtest/CHAOS.md):
#    - one per availability zone that cuts that zone's private subnet off
#      (network disruption, scope all) for chaos_fault_seconds, then restores
#      it by itself, so a run that is abandoned half way still ends;
#    - one that sends a Spot interruption (two-minute notice) to one running
#      ECS encoder server.
#  Encoder tasks are stopped with the plain ECS API by the harness itself; it
#  needs the task ARN the control plane reports, which a template cannot know.
#
#  OFF BY DEFAULT. A template does nothing until someone starts it, but there
#  is no reason for a production stack to carry a button that cuts a zone off.
#  Turn it on in the staging stack only. Templates cost nothing at rest; an
#  experiment is billed per action-minute (about $0.10 a minute).
# ============================================================================

resource "aws_iam_role" "fis" {
  count = var.enable_chaos_experiments ? 1 : 0
  name  = "${local.name}-fis"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "fis.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# The AWS-managed FIS policies, scoped by AWS to exactly the calls each action
# makes (the network one creates and removes a deny-all network ACL).
resource "aws_iam_role_policy_attachment" "fis_network" {
  count      = var.enable_chaos_experiments ? 1 : 0
  role       = aws_iam_role.fis[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSFaultInjectionSimulatorNetworkAccess"
}

resource "aws_iam_role_policy_attachment" "fis_ec2" {
  count      = var.enable_chaos_experiments ? 1 : 0
  role       = aws_iam_role.fis[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSFaultInjectionSimulatorEC2Access"
}

resource "aws_fis_experiment_template" "az" {
  for_each = var.enable_chaos_experiments ? { for i, az in local.azs : az => aws_subnet.private[i].arn } : {}

  description = "Volt chaos: cut ${each.key} off (deploy/loadtest/CHAOS.md)"
  role_arn    = aws_iam_role.fis[0].arn

  stop_condition {
    source = "none"
  }

  action {
    name      = "disrupt-zone"
    action_id = "aws:network:disrupt-connectivity"
    parameter {
      key   = "duration"
      value = "PT${var.chaos_fault_seconds}S"
    }
    parameter {
      key   = "scope"
      value = "all"
    }
    target {
      key   = "Subnets"
      value = "private-subnet"
    }
  }

  target {
    name           = "private-subnet"
    resource_type  = "aws:ec2:subnet"
    selection_mode = "ALL"
    resource_arns  = [each.value]
  }

  tags = { Name = "${local.name}-chaos-${each.key}" }
}

resource "aws_fis_experiment_template" "spot" {
  count = var.enable_chaos_experiments ? 1 : 0

  description = "Volt chaos: interrupt one Spot encoder server (deploy/loadtest/CHAOS.md)"
  role_arn    = aws_iam_role.fis[0].arn

  stop_condition {
    source = "none"
  }

  action {
    name      = "interrupt"
    action_id = "aws:ec2:send-spot-instance-interruptions"
    parameter {
      key   = "durationBeforeInterruption"
      value = "PT2M"
    }
    target {
      key   = "SpotInstances"
      value = "encoder-server"
    }
  }

  target {
    name           = "encoder-server"
    resource_type  = "aws:ec2:spot-instance"
    selection_mode = "COUNT(1)"
    # the Name the ECS node launch template gives every encoder server
    resource_tag {
      key   = "Name"
      value = "${local.name}-ecs-node"
    }
    filter {
      path   = "State.Name"
      values = ["running"]
    }
  }

  tags = { Name = "${local.name}-chaos-spot" }
}

variable "enable_chaos_experiments" {
  type        = bool
  default     = false
  description = "Create the Fault Injection Service templates the chaos harness uses (deploy/loadtest/CHAOS.md). Staging only."
}

variable "chaos_fault_seconds" {
  type        = number
  default     = 600
  description = "How long a zone stays cut off before FIS restores it by itself."
  validation {
    condition     = var.chaos_fault_seconds >= 60 && var.chaos_fault_seconds <= 3600
    error_message = "chaos_fault_seconds must be between 60 and 3600."
  }
}

output "chaos_stack" {
  description = "What deploy/loadtest/chaos.mjs reads to find this stack (with ecs_cluster, control_plane_url and the edge outputs)."
  value = {
    stack_name     = local.name
    region         = var.region
    db_instance_id = aws_db_instance.pg.identifier
    db_multi_az    = var.db_multi_az
  }
}

output "chaos_experiment_templates" {
  description = "FIS template ids by scenario: az-<zone> for each zone, spot-interrupt. Empty unless enable_chaos_experiments."
  value = merge(
    { for az, t in aws_fis_experiment_template.az : "az-${az}" => t.id },
    var.enable_chaos_experiments ? { "spot-interrupt" = aws_fis_experiment_template.spot[0].id } : {},
  )
}
