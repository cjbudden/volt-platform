# The first apply

A runbook for standing Volt up in an AWS account for the first time with this
stack. It is for whoever holds the account (Christian): the build queue never
runs `terraform apply`, pushes images or touches credentials. The reference
for each command is `README.md` in this folder; this page is the order to do
them in and what to check at each step.

## 0. Checks that need no account

Run these first, from the repository root, and stop if any fails:

```bash
cd deploy/terraform
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
cd ../..
node scripts/deploy/check-terraform-env.mjs
```

The last one reads every setting the control plane reads and fails unless
Terraform sets it or `env-coverage.json` says why it does not need to (build
queue 2.1). It also catches a secret reference to a key the secret does not
have and a variable with no line in `terraform.tfvars.example`. On 27 Oct 2026
all four passed: 278 settings read, 75 set by Terraform, 203 covered.

tflint was not run: it could not be downloaded where the check ran. If you
have it, `tflint --init && tflint` in this folder is worth a look.

## 1. Decide before you start

| Decision | Where it goes |
|---|---|
| AWS account, region and an admin role to apply with | your AWS CLI profile; `region` in `terraform.tfvars` |
| Environment name (`staging`, `prod`) | `env`; `prod` turns on deletion protection and a final database snapshot |
| One customer or many | `deployment = "single"` (default) or `"saas"` |
| How well the database survives a zone or a region going down | `resilience`: the SaaS service in `prod` is always `dr`; one customer's own Volt picks `standard` (default), `high` or `dr` (step 6). `backup_copy_region` if the usual pair of your region does not suit |
| Email provider for invites, password resets, sign-in codes and alerts | `SMTP_URL` in the integrations secret and `app_secret_keys`, `NOTIFY_FROM` in `app_env` (step 7). Without them production cannot send email |
| The domain Volt is served under, and its Route 53 hosted zone if it has one | `domain_name`, `route53_zone_id` (step 3). Terraform makes the certificates, the HTTPS listener and the records from these two |
| Remote state | step 2 |

## 2. Remote state

For anything you will keep, create an S3 bucket and a DynamoDB lock table for
the state first, then uncomment the `backend "s3"` block in `versions.tf`
(or pass `-backend-config` to `terraform init`). A throwaway environment can
use local state.

## 3. Configure

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
```

Set `project`, `env`, `region` and the sizes at the top. Every other variable
is listed further down the file, commented out, with its default and what it
does; uncomment only what you change.

**The domain** (`dns_https.tf`, build queue D3). Set `domain_name`, for example
`volt.example.com`. Volt then answers on four names under it:

| Name | What it is |
|---|---|
| `api.<domain>` | the console and the API (the API edge, or the ALB when `enable_api_edge = false`) |
| `cdn.<domain>` | live and on-demand delivery |
| `img.<domain>` | the image CDN |
| `origin.<domain>` | the ALB, for CloudFront and the encoders only |

`hostnames` changes the first label of any of them. Terraform requests two
certificates validated through DNS (one in us-east-1 for CloudFront, one in
the stack's region for the ALB), adds an HTTPS listener on the ALB with port
80 redirecting to it, and has CloudFront and the encoders reach the ALB as
`origin.<domain>` over HTTPS. `env = "prod"` with no domain plans with a
warning. Names set by hand earlier (`api_edge_aliases`,
`image_edge_aliases` with their certificates) still win.

- **Route 53 hosts the domain:** also set `route53_zone_id`. The validation
  records and the A/AAAA records are made in that zone and step 4 needs
  nothing else.
- **The domain is elsewhere:** leave `route53_zone_id` empty. Create the
  certificates first, add their validation records at your DNS provider,
  then apply the rest (apply waits up to two hours for the certificates):

  ```bash
  terraform apply -target=aws_acm_certificate.edge -target=aws_acm_certificate.alb
  terraform output -json dns_records_to_create   # add every "validation" record
  terraform plan -out tfplan && terraform apply tfplan
  terraform output -json dns_records_to_create   # now add every "hosts" record (CNAME)
  ```

## 4. Plan, then apply

```bash
terraform init
terraform plan -out tfplan
```

Read the plan: everything is named `<project>-<env>-...`, nothing should
belong to another environment, and nothing should be destroyed on a first
apply. Then:

```bash
terraform apply tfplan
```

RDS and the CloudFront distributions take most of the 15 to 30 minutes. The
control-plane services sit at zero healthy tasks until their image exists;
that is expected.

## 5. Build and push the images

Six repositories: `volt-control-plane` (from `volt-app/Dockerfile`, built
from the repository root), `volt-encoder` (also pushed as `volt-thumbnailer`),
`volt-fast` (`volt-encoder/Dockerfile.fast`), `volt-radio`
(`volt-encoder/Dockerfile.radio`) and `volt-captions`
(`volt-encoder/Dockerfile.captions`, several GB with its models; push it only
if an account will use Whisper captions). `scripts/deploy/deploy.mjs <env>`
builds and pushes them tagged `v<version>-<sha>`, runs the migrations once,
moves the services, smoke-tests and rolls back on failure (section 3 of
`README.md`). Add the environment to `deploy/environments.json` first (copy
`_aws-example`), and set `control_plane_image_tag` in `terraform.tfvars` to a
release (`latest` is refused).

Whisper captions run on a GPU pool (`ecs_capacity_gpu.tf`, g4dn.xlarge by
default) that starts at zero servers and costs nothing until a captions task
waits for one. Your AWS account needs a G-instance vCPU quota of at least 4
per GPU server (`gpu_max`); new accounts often have 0, so request it before
the first captioned stream. `gpu_max = 0` leaves the pool out.
`captions_gpu_sharing = true` lets several captioned streams share one GPU
server instead of one server each (two `small` models on one g4dn.xlarge);
leave it off until the real-T4 check in `PLACEMENT.md` has passed.

Each encoder server has a 30 GiB gp3 root (`encoder_root_volume_gib`; GPU
servers `gpu_root_volume_gib`, 60) and each encoder keeps only
`encoder_local_keep_seconds` (1800) of its run on it once the segments are in
S3, which holds the whole run. Placement checks that disk
(`FLEET_TASK_DISK_GIB`, set from the same variable). Setting the window to 0
keeps whole runs on the disk and fills it in about six hours of a 1080p ladder.

## 6. The database

Nothing to run. The roles that own the schema (`all`, `api-admin`,
`scheduler`) apply every migration in `volt-app/migrations` on boot, under a
lock, before they serve; the others wait. The control plane's log shows each
migration as it runs.

**Resilience** (`resilience.tf`). The `db_resilience` output says what is in
force:

| Tier | Database | Cache (Valkey) | Second region |
|---|---|---|---|
| `standard` | one zone (or `db_multi_az = true`) | `valkey_replicas` as set | none |
| `high` | Multi-AZ | at least one replica, automatic fail-over | none |
| `dr` | Multi-AZ | at least one replica, automatic fail-over | a daily AWS Backup snapshot at 04:00 UTC, copied to `backup_copy_region` |

The SaaS service (`deployment = "saas"`) in `prod` is always `dr`, whatever
`resilience` says. A dedicated deployment (`deployment = "single"`) chooses:
`high` and `dr` are the premium options, because Multi-AZ doubles the
database's cost and the copies add storage in a second region. In `prod` RDS
keeps automated backups (point-in-time restore) for `db_backup_retention_days`,
14 to 35 days, 14 when unset; the snapshot copies are kept as long. Plan
refuses fewer than 14 days in prod, and a copy region equal to the stack's.

A Multi-AZ fail-over test (reboot with fail-over, the control plane
reconnecting) is part of the AWS staging run.

**Upgrading Postgres to a new major version** (16 to 17, say). Never change
`engine_version` in place on prod: the database is down for the whole
upgrade. Use an RDS Blue/Green deployment instead:

1. Take a manual snapshot.
2. Create the Blue/Green deployment from the console or
   `aws rds create-blue-green-deployment --source <the pg instance ARN> --target-engine-version 17 --target-db-parameter-group-name <a 17 group>`.
   RDS builds a copy (green) on the new version and keeps it in step with the
   live database (blue) by logical replication.
3. Point a staging control plane at the green endpoint and run the smoke
   test (step 8). Migrations still run on blue only.
4. Switch over (`aws rds switchover-blue-green-deployment`). It takes about a
   minute; the endpoint name stays the same, so the control plane reconnects
   by itself.
5. Set `engine_version` in `rds.tf` to the new version and run `terraform plan`:
   it should show no change to the instance. Then delete the Blue/Green
   deployment and, after a few days, the old blue instance.

## 7. Secrets you add

The stack generates its own secrets (database, session signing, ingest token,
playback tokens, MFA key, social token key, image signing) in
`<project>-<env>/app` and `.../images`. What only you can provide goes in the
integrations secret (`terraform output integrations_secret_arn`):

- DRM and social app credentials, which the app reads by reference.
- Any setting `env-coverage.json` marks as `operator` with
  `how: app_secret_keys`, for example `SMTP_URL`. Put it in the secret as a
  JSON key, then list its name in `app_secret_keys` and apply again. A name
  listed but missing from the secret stops the tasks from starting, so add
  the key first.

Plain operator settings (for example `NOTIFY_FROM`, and for a saas
deployment `SITE_BASE_URL`, `SIGNUP_MODE`, `TERMS_URL`) go in `app_env`. The
plan refuses a name the stack already sets.

## 8. Smoke test

```bash
curl -fsS "$(terraform output -raw control_plane_url)/health/ready"
```

Then in the console at the public address: sign in, create a channel with a
test source, start it, and check that an encoder task lands on Spot
(`aws ecs list-tasks --cluster $(terraform output -raw ecs_cluster)`) and
that the channel plays from the CDN address. Upload an image to the Image
Library and a short video to the Media Library: the video should arrive in
the origin bucket under `media/` (this is the check for the accelerate
endpoint and the bucket's upload rule).

S3 watch folders: create one through the API with `"kind": "s3"` and a
prefix under `watch/` (`watch_s3_prefix`), add a rule, and copy a matching
file to that prefix (`aws s3 cp slate_test.png s3://<origin bucket>/watch/test/`).
It should be in the library within seconds, the control plane's log should
show `[s3 watch] 1 message(s): 1 fetched`, and
`terraform output -raw watch_drops_dlq_url` should stay empty.

## 8a. The ClickHouse analytics store (when you turn it on)

`clickhouse_enabled = true` (off by default, build queue 2.11) builds two
ClickHouse replicas in two zones, a third Keeper and a backup bucket
(`clickhouse.tf`, about $200 a month), and tells the control plane
`QOE_STORE=auto`. Nothing moves at apply: the playback reports stay on the
Postgres analytics database until the last 30 days pass
`qoe_clickhouse_above_vh` viewer hours (1 M by default). Then, by itself, the
leader writes both stores from the next whole minute, rebuilds up to 400 days
in ClickHouse from the raw archive (20 minutes of it an hour), copies the
play gate's log and the collector's counts, replays the switch day once it is
over, and moves the reports. `GET /api/analytics/qoe/collector` shows the
phase (`store.phase`: postgres, moving, clickhouse) and how far the rebuild is
(`store.backfilledTo`).

After the apply:

```bash
aws ssm start-session --target <replica instance id>
clickhouse-client -q "SELECT * FROM system.clusters WHERE cluster = 'volt'"
clickhouse-client -q "SELECT * FROM system.zookeeper WHERE path = '/'"
systemctl list-timers volt-ch-backup.timer
```

Two replicas listed, Keeper answering, the backup timer set for 03:17 UTC.
The control plane makes the tables itself (ON CLUSTER) the first time it
writes to ClickHouse.

**The replica drill** (the 2.11 acceptance the checks cannot run without a
real cluster): `volt-app/scripts/clickhouse-drill.ts` loses the second
replica's data, keeps the reports and the collector running through the
first, starts it again with `force_restore_data` and checks that it caught up
and holds exactly the same rows. The header of the script has the SSM
commands. Run it on staging before the store holds anything that matters.

**Restoring a backup** (both replicas lost): on a fresh replica,
`clickhouse-client -q "RESTORE DATABASE volt_qoe FROM S3('https://<bucket>.s3.<region>.amazonaws.com/volt_qoe/<latest backup folder>/')"`.
An incremental backup names its Sunday's full one as its base and ClickHouse
reads both, so the latest folder is enough. Or rebuild from the raw archive
instead: `npx tsx src/tools/qoe-replay.ts --day <first> --to <last>` in a
control-plane task replays into the store the reports read. The raw reports
are the record; ClickHouse holds nothing that cannot be rebuilt from them
apart from the play gate's log and the collector's counts, which the backup
has.

## 9. What does not work on AWS yet

These are queued, not forgotten (`BUILD_QUEUE.md`, and class
`not-on-aws-yet` in `env-coverage.json`):

- **2.1a-2b-4, 2.1a-2c, 2.1a-3, 2.1a-4.** Uploaded slates and loops now live
  in the origin bucket under `filler/` (2.1a, `FILLER_STORE_DRIVER=s3`), so
  every control-plane task serves them and none is lost with its task. A
  resumable upload's chunks and tus parts wait in the bucket under
  `upload-staging/` (2.1a-2, `UPLOAD_STAGING_DRIVER=s3`), so an upload whose
  requests the load balancer spreads over several tasks assembles on any of
  them; the bucket's lifecycle rule removes parts left after 8 days. The
  original of an upload or watch folder drop lands in the bucket under
  `vod-src/` once the ingest rules have named it (2.1a-2b,
  `VOD_SOURCE_DRIVER=s3`), so whichever task takes its encode fetches it; the
  bucket policy keeps `vod-src/` and `upload-staging/` away from the CDN. Clip
  and VOD encode files and downloads are served by any task: a file the task
  does not hold is read from the copy the job made under `clips/` or `vod/`
  (2.1a-2b-2). An ad creative's download and the FAST render of a slate or
  loop land under `vod-src/` like any original, and a caption track's clock is
  read through the bucket copy (2.1a-2b-3), so `CLIPS_DIR` is only working
  space. Encodes played from the CDN carry no caption tracks yet, and FAST
  does not yet count a bucket original as on the server (2.1a-2b-4). Still on
  a task's own disk: the trash (2.1a-2c), and the prebuilt loop segments (2.1a-3). The control-plane image has no
  ffmpeg, packager or Python for the jobs that run in it (clip extract, VOD
  encode, loop preparation, intro detection, the FAST render of a slate or
  loop), so on AWS those jobs fail until they run as their own tasks (2.1a-4).
- **2.1c.** Decided (3 Nov 2026): no relay. Stations run HLS and DASH; the
  relay and its settings are removed (2.1c-2).

The rest of phase 2 (per-run S3 prefixes, recording retention,
consolidation, S3 watch folders, WAF blocking, CDN logs) builds on this
stack; each item says what it adds.

## 10. Undo

`terraform destroy` tears a non-prod environment down, apart from two buckets
that are never emptied for you: the QoE raw reports (kept under Object Lock)
and the image library unless `images_force_destroy = true`. For
`env = "prod"` the database keeps deletion protection and a final snapshot,
and the origin bucket is not force-emptied either: that is deliberate.
