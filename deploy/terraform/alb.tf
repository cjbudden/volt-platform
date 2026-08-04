resource "aws_lb" "cp" {
  name               = "${local.name}-cp"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
  tags               = { Name = "${local.name}-cp" }
}

resource "aws_lb_target_group" "cp" {
  name        = "${local.name}-cp"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }
}

# HTTP listener. Add an HTTPS (443) listener + ACM cert for prod, and redirect
# 80→443; left HTTP-only here so a throwaway env stands up without a domain.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.cp.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.cp.arn
  }
}
