resource "aws_lb" "cp" {
  name               = "${local.name}-cp"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
  tags               = { Name = "${local.name}-cp" }

  # Reserved capacity for a known big event (scaling_variables.tf). An ALB
  # otherwise scales up over minutes; a kick-off arrives in seconds.
  dynamic "minimum_load_balancer_capacity" {
    for_each = var.alb_lcu_reservation == null ? [] : [var.alb_lcu_reservation]
    content {
      capacity_units = minimum_load_balancer_capacity.value
    }
  }
}

resource "aws_lb_target_group" "cp" {
  name        = "${local.name}-cp"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  # /health/ready: in rotation only once migrations ran and the database
  # answers (src/scale/health.ts). /health still exists for humans.
  health_check {
    path                = "/health/ready"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }
  deregistration_delay = 30
}

# HTTP listener. With domain_name set (dns_https.tf) it only redirects to the
# HTTPS listener; without one it serves, so a throwaway env stands up with no
# domain at all.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.cp.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = local.https ? "redirect" : "forward"
    target_group_arn = local.https ? null : aws_lb_target_group.cp.arn

    dynamic "redirect" {
      for_each = local.https ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }

  # CloudFront does not follow redirects: an edge talking HTTP to a
  # redirecting ALB would hand every viewer a 301 to itself.
  lifecycle {
    precondition {
      condition     = !local.https || (local.alb_origin_protocol != "http-only" && local.image_origin_protocol != "http-only")
      error_message = "With domain_name set the ALB redirects HTTP to HTTPS, so alb_origin_protocol and image_edge_origin_protocol cannot be http-only. Leave them empty to follow the domain."
    }
  }
}
