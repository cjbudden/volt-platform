resource "aws_db_subnet_group" "pg" {
  name       = "${local.name}-pg"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "${local.name}-pg" }
}

resource "aws_db_instance" "pg" {
  identifier     = "${local.name}-pg"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_allocated_storage * 5
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.pg.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  multi_az               = var.db_multi_az

  backup_retention_period = var.env == "prod" ? 7 : 1
  deletion_protection     = var.env == "prod"
  skip_final_snapshot     = var.env != "prod"
  apply_immediately       = var.env != "prod"

  tags = { Name = "${local.name}-pg" }
}
