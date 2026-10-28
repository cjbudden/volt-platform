# Deploying to AWS

The cloud deployment is Terraform in `deploy/terraform`. It is written but has
not been applied to a real account yet: the first apply waits on an AWS
account, credentials and a region from Christian (Set aside in
`BUILD_QUEUE.md`). The runbook for that first apply is
`deploy/terraform/APPLY.md`; the reference for each command is
`deploy/terraform/README.md`; scaling settings are in `SCALING.md`.

Nothing in this guide is run by the build queue: it never runs `terraform
apply`, pushes images or touches credentials.

## What the stack builds

| File | Builds |
|---|---|
| `deploy/terraform/vpc.tf`, `deploy/terraform/security.tf` | the network and security groups |
| `deploy/terraform/ecs_cluster.tf` | the EC2 ECS cluster with Spot and on-demand capacity providers for encoders |
| `deploy/terraform/ecs_services.tf` | the control plane on Fargate behind the ALB (`deploy/terraform/alb.tf`) |
| `deploy/terraform/scaling_services.tf` | the role split: public API, scheduler and worker as their own services (`enable_role_split`) |
| `deploy/terraform/rds.tf`, `deploy/terraform/scaling_rds_proxy.tf` | Postgres on RDS, optionally behind RDS Proxy |
| `deploy/terraform/s3_cloudfront.tf` | the S3 origin and the CloudFront distribution viewers use |
| `deploy/terraform/edge_rights.tf` | the CloudFront Function and KeyValueStore for edge rights variants |
| `deploy/terraform/images.tf` | the image library bucket, image CDN and signing secret |
| `deploy/terraform/qoe_raw.tf` | the raw player-report store for QoE |
| `deploy/terraform/clickhouse.tf` | the ClickHouse analytics store, off by default: two replicas, three keepers, nightly backups (build queue 2.11) |
| `deploy/terraform/ecr.tf` | the image repositories |
| `deploy/terraform/secrets.tf` | Secrets Manager entries the app reads by reference |
| `deploy/terraform/app_settings.tf` | control-plane settings that are not infrastructure (deployment shape, media in the bucket, the operator's own settings) |
| `deploy/terraform/scaling_cache.tf`, `deploy/terraform/scaling_edge.tf` | Valkey and the CloudFront and WAF edge in front of the API |

The customer docs are a separate stack, `deploy/terraform-docs`, with its own
state (see [The docs site](docs-site.md)).

## Checking the Terraform without an account

These need the Terraform CLI (1.6 or later) and nothing else:

```bash
cd deploy/terraform
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

`init -backend=false` downloads the providers without touching any state, so
it is safe anywhere.

Then, from the repository root (needs Node only):

```bash
node scripts/deploy/check-terraform-env.mjs
```

It reads every environment variable the control plane reads and fails unless
Terraform sets it or `deploy/terraform/env-coverage.json` says why it does not
need to, with a class: `default` (the built-in value is right on AWS), `local`
(Mac and tests only), `operator` (set through `app_env` or `app_secret_keys`
when the feature is used) or `not-on-aws-yet` (with the queue item that fixes
it). A new setting in the app therefore fails this check until someone decides
what it should be on AWS. It also fails on a secret reference to a key the
secret does not have, on a setting that must have one value on AWS (the media,
upload and image stores on S3, encoders on ECS) and on a variable with no line
in `deploy/terraform/terraform.tfvars.example`. The suite
`volt-app/test/terraform-env.check.ts` runs it.

## The first apply, in outline

The full runbook is `deploy/terraform/APPLY.md`; in outline:

1. **Configure.** Copy `deploy/terraform/terraform.tfvars.example` to
   `terraform.tfvars` and set project, environment, region and sizes. For
   anything beyond a throwaway environment, turn on the S3 state backend in
   `deploy/terraform/versions.tf` first.
2. **Apply.** About 40 resources, 15 to 20 minutes. The control plane service
   sits at zero healthy tasks until its image exists.
3. **Build and push the images** to the repositories the stack created: the
   control plane (`volt-app`), the encoder (`volt-encoder`, also tagged as the
   thumbnailer), FAST playout (`volt-encoder/Dockerfile.fast`), radio
   (`volt-encoder/Dockerfile.radio`) and, if accounts use Whisper captions,
   the captions add-on (`volt-encoder/Dockerfile.captions`). Captions run on
   a GPU pool that starts at zero servers (`deploy/terraform/ecs_capacity_gpu.tf`).
   With `captions_gpu_sharing = true` several captioned streams share one GPU
   server; leave it off until the real-T4 check in `PLACEMENT.md` has passed.
   Encoders keep only `encoder_local_keep_seconds` of a run on their server's
   disk once it is in S3 (`volt-encoder/bin/s3-uploader.sh`), and placement
   checks that disk (`FLEET_TASK_DISK_GIB`); see `PLACEMENT.md`, "Storage, and
   the task disk".
   Radio's MP3 output needs an Icecast relay, which has no home on AWS yet
   (queue item 2.1c); stations still deliver HLS and DASH.
4. **Migrations.** The control plane applies every migration in
   `volt-app/migrations` on boot, under a lock, in the `api-admin` role. A
   one-off run uses the same runner (`npm run migrate` in `volt-app`).
5. **Secrets.** Put the integration secrets (DRM, social apps) into the
   Secrets Manager entry the stack created. The app stores only references;
   raw values never reach the database or the images. Operator settings that
   are secret (email's `SMTP_URL`, sign-in app secrets) go in the same entry
   and are named in `app_secret_keys`; plain ones go in `app_env`.
6. **Smoke test.** `/health` on the control plane address, then create and
   start a channel and watch the encoder task land on Spot.

## The cost functions, and where they stand

What makes Volt cheap to run is mostly in phase 2 of the queue:

| Function | Where | Queue |
|---|---|---|
| Control-plane work off the task's own disk, and the tools its jobs need | `deploy/terraform/env-coverage.json` (not-on-aws-yet, 2.1a) | 2.1a |
| Encoders on Spot with an on-demand base, launched per channel by RunTask | `volt-app/src/services/orchestrator/launcher.ts`, `deploy/terraform/ecs_cluster.tf` | built |
| Per-run S3 prefixes, so a recording is a time range over segments that move as a unit | encoder and origin pointer | 2.2 |
| Retention, cooling and archive of recordings on S3 | `volt-app/src/services/clips` for clips and extracts | 2.3 |
| Consolidation: move encoders off part-empty nodes, make before break | `CONSOLIDATION.md` | 2.4 |
| Sizing that learns from every run, storage projected, placement that checks the task disk | `volt-app/src/services/fleet/loadFit.ts`, `volt-app/src/services/fleet/storageProjection.ts`, `PLACEMENT.md` | built (2.4a); disk check waits on 2.4c |
| Watch folders picked up from S3 by event, not by a walk | `volt-app/src/services/watchfolder/s3events.ts`, `deploy/terraform/watchfolders.tf` | built (2.6) |
| Edge rights decided in CloudFront, not at the origin | `deploy/edge/rights-viewer-request.js` | built (1.14a, 1.14b) |
| Scaling and chaos runs against the deployment | `deploy/loadtest/chaos.mjs`, run sheet `deploy/loadtest/CHAOS.md`, `deploy/terraform/chaos.tf` (`enable_chaos_experiments`, staging only) | built (2.8); the real run waits on the AWS account |
| CDN logs with CMCD counted at the edge | | 2.9 |
| Server-guided quality (CMSD) and content steering between delivery paths | `volt-app/src/services/delivery/cmsd.ts`, `volt-app/src/services/delivery/steering.ts` | built on the Mac origin and the manifest service (2.10); CMSD on CDN-served media playlists and a second CDN not yet |

### The analytics store (build queue 2.11)

The playback reports start on a second database in the RDS Postgres. With
`clickhouse_enabled = true` the control plane is told `QOE_STORE=auto` and
moves them to ClickHouse by itself once the last 30 days pass
`qoe_clickhouse_above_vh` viewer hours (1 M): both stores are written from the
switch minute, the history is rebuilt from the raw archive, then the reports
read ClickHouse. About $200 a month at the default sizes, nothing while off.
The code is `volt-app/src/services/qoe/clickhouse.ts` and
`volt-app/src/services/qoe/storeSwitch.ts`; `deploy/terraform/APPLY.md`
section 8a has the checks after apply, the replica drill and restoring a
backup.

### Several collector tasks (build queue 2.11b)

Players' reports (`POST /api/cmcd`) reach whichever control-plane task the
load balancer picks. Each task keeps the batch raw first, then derives only
the viewer sessions it owns and forwards the rest to their owner, so every
session has one state and one live view row and a task holds about 1/n of
the audience. The tasks that take reports list themselves in the analytics
database (`qoe_collectors`, a heartbeat every 5 s) and pick each owner by
rendezvous hashing of the sid, so a task starting or stopping moves only its
own sessions. Forwards go task to task on 8080 (the control-plane security
group's own rule), signed with a key derived from `JWT_ACCESS_SECRET`;
`QOE_ROUTE=auto` is set by `deploy/terraform/qoe_raw.tf` and each task reads its address from
the ECS task metadata. A forward that fails is derived where it arrived, and
yesterday is replayed from the raw archive once a night (02:30 UTC,
`QOE_NIGHTLY_REPLAY_AT`), so what a task change left provisional is exact by
the next morning. The code is `volt-app/src/services/qoe/sidRoute.ts` and
`volt-app/src/services/qoe/nightly.ts`; the suite is `qoe-sid-route`.

## Before you apply, check

- `terraform plan` shows what you expect and nothing in another environment.
- `env = "prod"` turns on deletion protection and a final database snapshot
  and stops the bucket being force-emptied on destroy. Staging tears down
  cleanly with `terraform destroy`.
- The ALB is HTTP only until a certificate and domain are added (see "Notes
  and prod hardening" in `deploy/terraform/README.md`).
