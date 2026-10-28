# ---- ClickHouse analytics store (build queue 2.11) ---------------------------
# QOE_REPORTING.md sections 9 and 9a. Below about a million viewer hours a
# month the playback reports run on a second database in the existing RDS
# Postgres; above it they move to ClickHouse, where a filter on any dimension
# over 13 months of view rows is a sub-second query. This file builds that
# store; the control plane moves to it by itself (QOE_STORE=auto,
# volt-app/src/services/qoe/storeSwitch.ts): from the switch minute it writes
# both stores, rebuilds the history in ClickHouse from the raw archive in S3
# (qoe_raw.tf), and once that is done the reports read ClickHouse.
#
# Off by default: a pilot pays nothing for it. Turned on, it is
#   - two replicas (r7g.large, Graviton, about $77 a month each on demand) in
#     two availability zones, ReplicatedMergeTree, so losing one loses no data
#     and the control plane carries on through the other (it is given both);
#   - three ClickHouse Keepers for the replication log: one on each replica
#     and a small third (t4g.small, about $12 a month) in another zone, so a
#     lost zone leaves a quorum;
#   - a nightly backup to S3 (full on Sundays, incremental on other nights),
#     kept clickhouse_backup_retention_days; and the raw archive can rebuild
#     everything anyway (the replay).
# About $200 a month in all at the default sizes, against the $215 the
# 1 M viewer hour row of QOE_REPORTING.md section 9 assumed.
#
# Only the control plane reaches the HTTP port (8123); there is no public
# address and no SSH: operators use SSM Session Manager.

variable "clickhouse_enabled" {
  description = "Build the ClickHouse analytics store and let the control plane move the playback reports to it once the audience passes qoe_clickhouse_above_vh viewer hours in 30 days."
  type        = bool
  default     = false
}

variable "clickhouse_instance_type" {
  description = "Instance type of each of the two ClickHouse replicas (Graviton). r7g.large (2 vCPU, 16 GB) holds about 100 M viewer hours a month; r7g.2xlarge for more (QOE_REPORTING.md section 9)."
  type        = string
  default     = "r7g.large"
}

variable "clickhouse_keeper_instance_type" {
  description = "Instance type of the third ClickHouse Keeper (it holds the replication log only)."
  type        = string
  default     = "t4g.small"
}

variable "clickhouse_volume_gb" {
  description = "Disk (gp3) on each replica. View rows are about 200 bytes compressed: 13 months at 100 M viewer hours a month is under 100 GB."
  type        = number
  default     = 200
}

variable "clickhouse_backup_retention_days" {
  description = "Days the nightly ClickHouse backups are kept in S3."
  type        = number
  default     = 35
}

variable "qoe_clickhouse_above_vh" {
  description = "QOE_CLICKHOUSE_ABOVE_VH: viewer hours in the last 30 days at which the control plane moves the playback reports from Postgres to ClickHouse (only with clickhouse_enabled)."
  type        = number
  default     = 1000000
}

locals {
  ch_replicas = var.clickhouse_enabled ? 2 : 0
  ch_keepers  = var.clickhouse_enabled ? 1 : 0
  ch_cluster  = "volt"
  ch_database = "volt_qoe"
  ch_subnet_n = length(aws_subnet.private)
  # Fixed private addresses, so each server's configuration can name the
  # others without a dependency cycle.
  ch_replica_ips = [for i in range(2) : cidrhost(aws_subnet.private[i % local.ch_subnet_n].cidr_block, 20 + i)]
  # With az_count = 3 the third Keeper has a zone of its own; with 2 it shares
  # the first replica's zone, and losing that zone stops writes (Keeper has no
  # quorum) while reads go on: the collector holds its rows and the replay
  # restores anything it had to drop.
  ch_keeper_ip = cidrhost(aws_subnet.private[2 % local.ch_subnet_n].cidr_block, 30)
  # Keeper ids: 1 and 2 on the replicas, 3 on the small server.
  ch_raft = join("", concat(
    [for i, ip in local.ch_replica_ips : "<server><id>${i + 1}</id><hostname>${ip}</hostname><port>9234</port></server>"],
    ["<server><id>3</id><hostname>${local.ch_keeper_ip}</hostname><port>9234</port></server>"],
  ))
  ch_zk            = join("", [for ip in concat(local.ch_replica_ips, [local.ch_keeper_ip]) : "<node><host>${ip}</host><port>9181</port></node>"])
  ch_url           = join(",", [for ip in local.ch_replica_ips : "http://volt:${random_password.clickhouse.result}@${ip}:8123"])
  ch_backup_bucket = var.clickhouse_enabled ? aws_s3_bucket.clickhouse_backups[0].id : ""

  # What the control plane is told (qoe_raw.tf adds it to every control-plane role).
  clickhouse_env = var.clickhouse_enabled ? [
    { name = "QOE_STORE", value = "auto" },
    { name = "QOE_CLICKHOUSE_ABOVE_VH", value = tostring(var.qoe_clickhouse_above_vh) },
    { name = "CLICKHOUSE_CLUSTER", value = local.ch_cluster },
    { name = "CLICKHOUSE_DATABASE", value = local.ch_database },
    ] : [
    { name = "QOE_STORE", value = "postgres" },
  ]
  clickhouse_secrets = var.clickhouse_enabled ? [
    { name = "CLICKHOUSE_URL", valueFrom = "${aws_secretsmanager_secret.clickhouse[0].arn}:CLICKHOUSE_URL::" },
  ] : []
  clickhouse_secret_arns = var.clickhouse_enabled ? [aws_secretsmanager_secret.clickhouse[0].arn] : []
}

# ---- The password the control plane uses (never in the code) -----------------
resource "random_password" "clickhouse" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "clickhouse" {
  count                   = var.clickhouse_enabled ? 1 : 0
  name                    = "${local.name}/clickhouse"
  description             = "Volt ClickHouse analytics store: the replicas' addresses with the volt user's password"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "clickhouse" {
  count         = var.clickhouse_enabled ? 1 : 0
  secret_id     = aws_secretsmanager_secret.clickhouse[0].id
  secret_string = jsonencode({ CLICKHOUSE_URL = local.ch_url })
}

# ---- Network ------------------------------------------------------------------
resource "aws_security_group" "clickhouse" {
  count       = var.clickhouse_enabled ? 1 : 0
  name        = "${local.name}-clickhouse"
  description = "ClickHouse analytics store"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "HTTP interface, from the control plane only"
    from_port       = 8123
    to_port         = 8123
    protocol        = "tcp"
    security_groups = [aws_security_group.control_plane.id]
  }
  ingress {
    description = "Native protocol, interserver replication, Keeper client and Keeper raft, between the ClickHouse servers"
    from_port   = 9000
    to_port     = 9234
    protocol    = "tcp"
    self        = true
  }
  egress {
    description = "Packages, S3 backups"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${local.name}-clickhouse" }
}

# ---- Backups ------------------------------------------------------------------
resource "aws_s3_bucket" "clickhouse_backups" {
  count         = var.clickhouse_enabled ? 1 : 0
  bucket_prefix = "${local.name}-ch-backups-"
}

resource "aws_s3_bucket_public_access_block" "clickhouse_backups" {
  count                   = var.clickhouse_enabled ? 1 : 0
  bucket                  = aws_s3_bucket.clickhouse_backups[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "clickhouse_backups" {
  count  = var.clickhouse_enabled ? 1 : 0
  bucket = aws_s3_bucket.clickhouse_backups[0].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "clickhouse_backups" {
  count  = var.clickhouse_enabled ? 1 : 0
  bucket = aws_s3_bucket.clickhouse_backups[0].id
  rule {
    id     = "expire-backups"
    status = "Enabled"
    filter {}
    expiration {
      days = var.clickhouse_backup_retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }
}

# ---- The servers' role: backups to their bucket, Session Manager --------------
resource "aws_iam_role" "clickhouse" {
  count              = var.clickhouse_enabled ? 1 : 0
  name               = "${local.name}-clickhouse"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "clickhouse_ssm" {
  count      = var.clickhouse_enabled ? 1 : 0
  role       = aws_iam_role.clickhouse[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "clickhouse_backups" {
  count = var.clickhouse_enabled ? 1 : 0
  name  = "backups"
  role  = aws_iam_role.clickhouse[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"], Resource = "${aws_s3_bucket.clickhouse_backups[0].arn}/*" },
      { Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketLocation"], Resource = aws_s3_bucket.clickhouse_backups[0].arn },
    ]
  })
}

resource "aws_iam_instance_profile" "clickhouse" {
  count = var.clickhouse_enabled ? 1 : 0
  name  = "${local.name}-clickhouse"
  role  = aws_iam_role.clickhouse[0].name
}

data "aws_ssm_parameter" "al2023_arm" {
  count = var.clickhouse_enabled ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# ---- The two replicas ---------------------------------------------------------
resource "aws_instance" "clickhouse" {
  count                  = local.ch_replicas
  ami                    = data.aws_ssm_parameter.al2023_arm[0].value
  instance_type          = var.clickhouse_instance_type
  subnet_id              = aws_subnet.private[count.index % length(aws_subnet.private)].id
  private_ip             = local.ch_replica_ips[count.index]
  vpc_security_group_ids = [aws_security_group.clickhouse[0].id]
  iam_instance_profile   = aws_iam_instance_profile.clickhouse[0].name
  monitoring             = true

  metadata_options {
    http_tokens = "required"
  }
  root_block_device {
    volume_type = "gp3"
    volume_size = var.clickhouse_volume_gb
    encrypted   = true
  }

  user_data = <<-EOT
    #!/bin/bash
    set -euo pipefail
    dnf install -y dnf-plugins-core
    dnf config-manager --add-repo https://packages.clickhouse.com/rpm/lts/clickhouse.repo
    dnf install -y clickhouse-server clickhouse-client
    mkdir -p /etc/clickhouse-server/config.d /etc/clickhouse-server/users.d
    cat > /etc/clickhouse-server/config.d/volt.xml <<'XML'
    <clickhouse>
      <listen_host>0.0.0.0</listen_host>
      <interserver_http_host>${local.ch_replica_ips[count.index]}</interserver_http_host>
      <macros><shard>01</shard><replica>replica-${count.index + 1}</replica><cluster>${local.ch_cluster}</cluster></macros>
      <!-- the app makes plain Replicated*MergeTree tables ON CLUSTER; these give their Keeper paths -->
      <default_replica_path>/clickhouse/tables/{shard}/{database}/{table}</default_replica_path>
      <default_replica_name>{replica}</default_replica_name>
      <remote_servers><${local.ch_cluster}><shard><internal_replication>true</internal_replication>${join("", [for ip in local.ch_replica_ips : "<replica><host>${ip}</host><port>9000</port></replica>"])}</shard></${local.ch_cluster}></remote_servers>
      <zookeeper>${local.ch_zk}</zookeeper>
      <distributed_ddl><path>/clickhouse/task_queue/ddl</path></distributed_ddl>
      <keeper_server>
        <tcp_port>9181</tcp_port>
        <server_id>${count.index + 1}</server_id>
        <log_storage_path>/var/lib/clickhouse/coordination/log</log_storage_path>
        <snapshot_storage_path>/var/lib/clickhouse/coordination/snapshots</snapshot_storage_path>
        <raft_configuration>${local.ch_raft}</raft_configuration>
      </keeper_server>
      <!-- backups go to S3 with the instance role's credentials -->
      <s3><use_environment_credentials>true</use_environment_credentials></s3>
    </clickhouse>
    XML
    cat > /etc/clickhouse-server/users.d/volt.xml <<'XML'
    <clickhouse>
      <users>
        <default><networks replace="replace"><ip>::1</ip><ip>127.0.0.1</ip></networks></default>
        <volt>
          <password_sha256_hex>${sha256(random_password.clickhouse.result)}</password_sha256_hex>
          <networks><ip>${var.vpc_cidr}</ip></networks>
          <profile>default</profile>
          <quota>default</quota>
          <access_management>0</access_management>
        </volt>
      </users>
    </clickhouse>
    XML
    # Nightly backup: full on Sundays, incremental on its Sunday the other nights.
    # Run by replica 1; replica 2 runs it only when replica 1 does not answer.
    cat > /usr/local/bin/volt-ch-backup <<'SH'
    #!/bin/bash
    set -euo pipefail
    if [ "${count.index}" != "0" ] && curl -sf --max-time 5 http://${local.ch_replica_ips[0]}:8123/ping >/dev/null; then exit 0; fi
    base="https://${local.ch_backup_bucket}.s3.${var.region}.amazonaws.com/${local.ch_database}"
    today=$(date -u +%F)
    if [ "$(date -u +%u)" = "7" ]; then
      clickhouse-client -q "BACKUP DATABASE ${local.ch_database} TO S3('$base/full-$today/')"
    else
      sunday=$(date -u -d "last sunday" +%F)
      clickhouse-client -q "BACKUP DATABASE ${local.ch_database} TO S3('$base/incr-$today/') SETTINGS base_backup = S3('$base/full-$sunday/')" \
        || clickhouse-client -q "BACKUP DATABASE ${local.ch_database} TO S3('$base/full-$today/')"
    fi
    SH
    chmod 755 /usr/local/bin/volt-ch-backup
    cat > /etc/systemd/system/volt-ch-backup.service <<'UNIT'
    [Unit]
    Description=Volt ClickHouse nightly backup to S3
    [Service]
    Type=oneshot
    ExecStart=/usr/local/bin/volt-ch-backup
    UNIT
    cat > /etc/systemd/system/volt-ch-backup.timer <<'UNIT'
    [Unit]
    Description=Volt ClickHouse nightly backup
    [Timer]
    OnCalendar=*-*-* 03:17:00
    Persistent=true
    [Install]
    WantedBy=timers.target
    UNIT
    systemctl daemon-reload
    systemctl enable --now clickhouse-server volt-ch-backup.timer
  EOT

  user_data_replace_on_change = false
  tags                        = { Name = "${local.name}-clickhouse-${count.index + 1}", Role = "clickhouse" }
}

# ---- The third Keeper ---------------------------------------------------------
resource "aws_instance" "clickhouse_keeper" {
  count                  = local.ch_keepers
  ami                    = data.aws_ssm_parameter.al2023_arm[0].value
  instance_type          = var.clickhouse_keeper_instance_type
  subnet_id              = aws_subnet.private[2 % length(aws_subnet.private)].id
  private_ip             = local.ch_keeper_ip
  vpc_security_group_ids = [aws_security_group.clickhouse[0].id]
  iam_instance_profile   = aws_iam_instance_profile.clickhouse[0].name

  metadata_options {
    http_tokens = "required"
  }
  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
  }

  user_data = <<-EOT
    #!/bin/bash
    set -euo pipefail
    dnf install -y dnf-plugins-core
    dnf config-manager --add-repo https://packages.clickhouse.com/rpm/lts/clickhouse.repo
    dnf install -y clickhouse-keeper
    mkdir -p /etc/clickhouse-keeper
    cat > /etc/clickhouse-keeper/keeper_config.xml <<'XML'
    <clickhouse>
      <listen_host>0.0.0.0</listen_host>
      <keeper_server>
        <tcp_port>9181</tcp_port>
        <server_id>3</server_id>
        <log_storage_path>/var/lib/clickhouse-keeper/log</log_storage_path>
        <snapshot_storage_path>/var/lib/clickhouse-keeper/snapshots</snapshot_storage_path>
        <raft_configuration>${local.ch_raft}</raft_configuration>
      </keeper_server>
    </clickhouse>
    XML
    systemctl enable --now clickhouse-keeper
  EOT

  tags = { Name = "${local.name}-clickhouse-keeper", Role = "clickhouse-keeper" }
}

output "clickhouse_replicas" {
  description = "Private addresses of the ClickHouse replicas (empty when clickhouse_enabled is false)."
  value       = var.clickhouse_enabled ? local.ch_replica_ips : []
}
