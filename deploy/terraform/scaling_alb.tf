# ---- ALB: viewer paths -> api-public --------------------------------------------
# Same split as the staging nginx (deploy/staging/nginx.conf.template) and the
# api-public guard (PUBLIC_PATH_PREFIXES in src/scale/config.ts). Everything
# not listed stays on the default action: the control-plane (api-admin).
# ALB allows at most 5 values per path-pattern condition, hence three rules.

resource "aws_lb_target_group" "public" {
  count       = local.split
  name        = "${local.name}-pub"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  # Readiness, not liveness: a task that cannot reach the database leaves the
  # rotation and comes back by itself.
  health_check {
    path                = "/health/ready"
    healthy_threshold   = 2
    unhealthy_threshold = 2
    interval            = 10
    timeout             = 5
    matcher             = "200"
  }
  deregistration_delay = 30

  # Spread new connections to newly started tasks gradually.
  slow_start = 30
}

locals {
  public_path_groups = [
    ["/api/availability", "/api/availability/*", "/api/access/*", "/api/player/*", "/api/analytics/beacon*"],
    ["/live/*", "/share/*", "/api/share/*", "/xmltv/*", "/img/*"],
    ["/library/*", "/player", "/player/*", "/clips/*", "/api/payments/verify"],
    # /gfx/*: graphics template files the player loads (modules/graphics.ts)
    # /fast/*: the FAST ad stitcher's per-viewer playlists (modules/fast.ts)
    # /channel/*/v/*, /event/*/v/*: variant manifests (services/variantManifest.ts)
    ["/api/public/*", "/gfx/*", "/fast/*", "/channel/*/v/*", "/event/*/v/*"],
    # /api/cmcd: players' CMCD v2 event reports (modules/cmcd.ts)
    ["/api/cmcd", "/api/cmcd/*"],
  ]
}

resource "aws_lb_listener_rule" "public" {
  count        = var.enable_role_split ? length(local.public_path_groups) : 0
  listener_arn = aws_lb_listener.http.arn
  priority     = 10 + count.index

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.public[0].arn
  }

  condition {
    path_pattern {
      values = local.public_path_groups[count.index]
    }
  }
}
