# ---- Security groups --------------------------------------------------------
resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public ingress to the control-plane ALB"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name}-alb" }
}

resource "aws_security_group" "control_plane" {
  name        = "${local.name}-control-plane"
  description = "Control-plane Fargate tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "From ALB"
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  # Collector tasks forward each viewer session's reports to the one task
  # that owns it (POST /api/cmcd/_peer, signed; volt-app
  # services/qoe/sidRoute.ts, build queue 2.11b), so the control-plane tasks
  # reach each other on 8080. Only from this same group. Inline like the
  # rule above: a separate aws_security_group_rule beside inline rules would
  # be removed again on the next apply.
  ingress {
    description = "Collector forwards between control-plane tasks"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    self        = true
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name}-control-plane" }
}

resource "aws_security_group" "encoder" {
  name        = "${local.name}-encoder"
  description = "Encoder/packager ECS EC2 nodes"
  vpc_id      = aws_vpc.main.id

  # Ingest ports (SRT/RTMP) — narrow these to known source IPs in prod.
  ingress {
    description = "SRT ingest"
    from_port   = 9000
    to_port     = 9100
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "RTMP ingest"
    from_port   = 1935
    to_port     = 1935
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name}-encoder" }
}

resource "aws_security_group" "rds" {
  name        = "${local.name}-rds"
  description = "Postgres — reachable only from control plane + encoder nodes"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from control plane"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.control_plane.id]
  }
  ingress {
    description     = "Postgres from encoder nodes"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.encoder.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name}-rds" }
}
