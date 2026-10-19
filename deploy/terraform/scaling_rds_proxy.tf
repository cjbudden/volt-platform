# ---- RDS Proxy ------------------------------------------------------------------
# Each task keeps DB_POOL_MAX connections (default 10). Sixty viewer tasks plus
# admin, scheduler and workers would open 700+ connections, more than a
# mid-size Postgres accepts. RDS Proxy multiplexes them onto a bounded pool and
# also shortens fail-over (it holds client connections while the database
# fails over to its Multi-AZ standby).
#
# DATABASE_URL points at the proxy when this is on. DATABASE_LISTEN_URL (the
# LISTEN/NOTIFY connection, the scheduler leader lock, boot migrations) always
# points straight at the database: those hold a session, which a proxy would
# have to pin anyway.

resource "aws_security_group" "db_proxy" {
  count       = var.enable_rds_proxy ? 1 : 0
  name        = "${local.name}-db-proxy"
  description = "RDS Proxy: reachable from control plane and encoder nodes"
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
  tags = { Name = "${local.name}-db-proxy" }
}

resource "aws_secretsmanager_secret" "db_proxy" {
  count                   = var.enable_rds_proxy ? 1 : 0
  name                    = "${local.name}/db-proxy"
  description             = "Database credentials RDS Proxy uses to connect"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db_proxy" {
  count     = var.enable_rds_proxy ? 1 : 0
  secret_id = aws_secretsmanager_secret.db_proxy[0].id
  secret_string = jsonencode({
    username = var.db_username
    password = local.db_password
  })
}

data "aws_iam_policy_document" "rds_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "db_proxy" {
  count              = var.enable_rds_proxy ? 1 : 0
  name               = "${local.name}-db-proxy"
  assume_role_policy = data.aws_iam_policy_document.rds_assume.json
}

resource "aws_iam_role_policy" "db_proxy" {
  count = var.enable_rds_proxy ? 1 : 0
  name  = "read-db-secret"
  role  = aws_iam_role.db_proxy[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.db_proxy[0].arn]
    }]
  })
}

resource "aws_db_proxy" "pg" {
  count          = var.enable_rds_proxy ? 1 : 0
  name           = "${local.name}-pg"
  engine_family  = "POSTGRESQL"
  role_arn       = aws_iam_role.db_proxy[0].arn
  vpc_subnet_ids = aws_subnet.private[*].id
  # The proxy also sits in the control-plane group, which the RDS security
  # group already admits, so no change to the database's rules is needed.
  vpc_security_group_ids = [aws_security_group.db_proxy[0].id, aws_security_group.control_plane.id]
  # The app connects without TLS inside the VPC, as it does to RDS today.
  # Set true together with ?sslmode=require in DATABASE_URL to enforce TLS.
  require_tls         = false
  idle_client_timeout = 1800

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_secretsmanager_secret.db_proxy[0].arn
  }

  depends_on = [aws_secretsmanager_secret_version.db_proxy]
}

resource "aws_db_proxy_default_target_group" "pg" {
  count         = var.enable_rds_proxy ? 1 : 0
  db_proxy_name = aws_db_proxy.pg[0].name
  connection_pool_config {
    max_connections_percent      = 90
    max_idle_connections_percent = 50
    connection_borrow_timeout    = 10
  }
}

resource "aws_db_proxy_target" "pg" {
  count                  = var.enable_rds_proxy ? 1 : 0
  db_proxy_name          = aws_db_proxy.pg[0].name
  target_group_name      = aws_db_proxy_default_target_group.pg[0].name
  db_instance_identifier = aws_db_instance.pg.identifier
}

locals {
  # Where ordinary queries go (the proxy when on), and where session-holding
  # connections go (always the database itself).
  db_app_host    = var.enable_rds_proxy ? aws_db_proxy.pg[0].endpoint : aws_db_instance.pg.address
  db_direct_host = aws_db_instance.pg.address
}
