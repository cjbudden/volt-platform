# Volt Streaming — Cloud Deployment (Tier‑2, Terraform)

This stack stands up a working Volt Streaming environment on AWS: a Fargate
control plane behind an ALB, an EC2 ECS cluster with **Spot + on‑demand**
capacity providers for the encoder/thumbnailer tasks, RDS Postgres, an S3 origin
fronted by CloudFront, ECR repos, and Secrets Manager. It is the Tier‑2 target
referenced by the test strategy in the main `RUNBOOK.md` (Tier‑1 = local e2e).

> **First time?** Follow `APPLY.md` in this folder: the order of these steps,
> the checks to run before you apply, and what does not work on AWS yet.

> **What Terraform does vs what you do.** Terraform builds the infrastructure and
> wires the control plane's env to it. You still (1) build & push the three
> container images to ECR, (2) run the DB migration once, and (3) populate the
> DRM/social secret. All three are one‑liners below.

```
                              ┌────────────── CloudFront (HLS/DASH TTLs) ───────────┐
 viewers ─────────────────────┤                                                     │
                              └──────────────▶ S3 origin ◀── PUT segments ──┐       │
                                                                            │       │
 SRT/RTMP source ──▶ ECS EC2 (Spot▸on‑demand) : volt‑encoder task ──────────┘       │
                          ▲            │ status/events                               │
                          │ RunTask    ▼                                             │
 admin/API ──▶ ALB ──▶ Fargate : volt‑control‑plane ──▶ RDS Postgres ◀──────────────┘
                                        │
                                        └── reads secrets (DB URL, JWT, ingest, DRM) from Secrets Manager
```

## 0. Prerequisites
- Terraform ≥ 1.6, AWS CLI v2, Docker.
- AWS credentials with permission to create the above (an admin role for a
  throwaway env; scope down for prod).
- Choose a region (`us-east-1` default).

## 1. Configure
```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
# edit project/env/region, instance sizes, prod flags
```
For anything beyond a throwaway env, enable the S3 remote state backend in
`versions.tf` (create the state bucket + lock table first) so state is shared and
locked.

## 2. Stand up the infrastructure
```bash
terraform init
terraform plan      # review — ~40 resources
terraform apply
```
Apply takes ~15–20 min (RDS + CloudFront dominate). Outputs you'll use:
```bash
terraform output           # control_plane_url, cdn_domain, ecr_repositories,
                           # ecs_cluster, capacity_providers, db_endpoint, *secret_arn
```

The control plane comes up **before** its image exists in ECR, so its ECS
service will sit at 0 healthy tasks until step 3. That's expected.

## 3. Deploy a release: images, migrations, services
One command does it, from the repository root, with the release checked out:
```bash
node scripts/deploy/deploy.mjs <env>                    # the version in VERSION
node scripts/deploy/deploy.mjs <env> --dry-run          # every change printed, none made
node scripts/deploy/deploy.mjs <env> --version v0.43.0  # a given release
node scripts/deploy/deploy.mjs <env> --rollback         # back to what ran before
```
`<env>` is an entry in `deploy/environments.json` with `driver: "ecs"` and the
same `project`, `env` and `region` as `terraform.tfvars` (copy `_aws-example`).
It needs the AWS CLI v2 and Docker, with your own AWS credentials. In order it:

1. runs the release checks and finds the release's git tag and commit;
2. builds and pushes every image as `v<version>-<sha>` (and `v<version>`):
   `volt-control-plane`, `volt-encoder` (also as `volt-thumbnailer`), `volt-fast`,
   `volt-radio`, and `volt-captions` only if the environment lists `captions`.
   Never `latest`. Images already in ECR for that tag are not rebuilt;
3. registers each service's new task definition revision from the newest one
   Terraform wrote (only the image changes) and runs the migrations **once** as
   a one-off Fargate task of the new image (`node dist/migrateOnly.js`), before
   any service moves;
4. moves the services (control plane, and api-public, scheduler and worker with
   the role split) and waits for steady state;
5. smoke test: `/health/ready`, a play gate call, a manifest fetch (set
   `smoke.appKey` and `smoke.assetId` for a channel or title that always plays);
6. if a service never settles or the smoke test fails, puts back the exact
   revisions that ran before and exits 1. Otherwise registers the new encoder,
   thumbnailer, FAST, radio and captions revisions: **new streams take the new
   version, running streams keep theirs until they stop** (nothing is restarted);
7. records what runs where in `release/deployments.json`. Commit it.

Terraform no longer moves the services' revision (`ignore_changes =
[task_definition]`): the deploy script does, so an apply can never undo a
rollback. Image tags must name a release: apply with the one that runs,
```bash
terraform apply -var control_plane_image_tag=$(node ../../scripts/deploy/deploy.mjs <env> --current)
```
so the task definitions Terraform registers stay on the running images. A
settings-only apply writes new revisions; the next deploy (the same version
again is fine) rolls them out.

**The first deploy** after the first apply: the services sit at 0 healthy tasks
(their tag is not in ECR yet), and the deploy has nothing to roll back to.

## 4. The database
The deploy runs the migrations as a one-off task before the services move
(step 3 above). The roles that own the schema (`all`, `api-admin`,
`scheduler`) still apply every migration in `volt-app/migrations` on boot,
under a lock (`volt-app/src/scale/boot.ts`), and find nothing left to do; the
other roles wait for them. Because old and new tasks run side by side during a
rolling deploy, and a rollback does not undo migrations, a release may only
add to the schema (see `RELEASING.md`, "Deploying").

## 5. Populate integration secrets
```bash
aws secretsmanager put-secret-value --secret-id $(terraform output -raw integrations_secret_arn) \
  --secret-string '{"AXINOM_MGMT_KEY":"...","YOUTUBE_OAUTH":"...","FACEBOOK_OAUTH":"..."}'
```
The app references these by ARN (`drm auth_ref`, `publish_targets.credentials_ref`)
— raw values never touch the DB or the images.

## 6. Smoke test
```bash
curl -fsS $(terraform output -raw control_plane_url)/health        # {"ok":true,...}
# mint a token against the account you seed, then hit /api/status, create a channel,
# and start it — the orchestrator RunTask's the encoder onto Spot. Watch:
aws ecs list-tasks --cluster $(terraform output -raw ecs_cluster)
```
Playback: manifests/segments land in the S3 origin and serve via
`https://<cdn_domain>/…`. The same Postman collection / `api-playground.html`
work against the ALB URL — set `baseUrl` to `control_plane_url`.

### Image service
`images.tf` adds the image library bucket (`<project>-<env>-images`), the image CDN and the
URL-signing secret, and passes `IMAGE_*` settings to every control-plane role. After apply:
```bash
terraform output -raw image_cdn_base_url     # where signed image URLs point
```
With `domain_name` set the image CDN answers on `img.<domain>` by itself. To use another
name set `image_edge_aliases = ["img.example.com"]` and `image_edge_certificate_arn` (ACM,
us-east-1), then point DNS at the distribution. Smoke test:
upload an image in the console, copy a URL from the URL builder, fetch it twice and check
`X-Image-Cache` (`MISS`, then `MEMORY`, `HIT` or a CloudFront `Hit`). The images bucket is not
force-emptied on destroy unless `images_force_destroy = true`. Full guide, secret rotation and
purging: `volt-app/docs/IMAGES.md` sections 14 and 15.

## 7. Teardown
```bash
terraform destroy
```
`force_destroy`/`skip_final_snapshot` are on for non‑prod, so a staging env tears
down cleanly. For `env = "prod"` the DB gets deletion protection + a final
snapshot and the bucket won't force‑empty — intentional guard rails.

## Notes & prod hardening
- **HTTPS/domain.** Set `domain_name` (and `route53_zone_id` when Route 53
  hosts it): `dns_https.tf` makes the certificates, the ALB's HTTPS listener
  with port 80 redirecting, the CloudFront aliases and the DNS records
  (APPLY.md, step 3). Without a domain the ALB stays HTTP-only, so a throwaway
  env stands up with none.
- **GPU captions.** Whisper captions run on their own GPU pool
  (`ecs_capacity_gpu.tf`: `gpu_instance_types`, `gpu_max`), on demand, from
  zero servers. Check the account's G-instance vCPU quota first.
- **GPU transcode.** Default nodes are CPU (packaging + x264). For GPU density set
  `encoder_instance_types = ["g4dn.xlarge"]` and switch the ECS AMI SSM parameter
  in `ecs_cluster.tf` to the GPU‑recommended one.
- **NAT/HA.** One NAT gateway to keep staging cheap; use one per AZ for prod.
- **Database resilience** (`resilience.tf`). The SaaS service in prod is always
  Multi-AZ, with a Valkey replica, 14 to 35 days of backups and daily snapshot
  copies to a second region; a dedicated deployment picks `resilience`
  (`standard`, `high`, `dr`). Major Postgres upgrades go through RDS Blue/Green
  (APPLY.md, step 6).
- **Capacity provider names** (`volt-spot` / `volt-ondemand`) match the control‑
  plane config defaults, so the orchestrator's `capacityProviderStrategy`
  (Spot weight 4 + on‑demand base 1) lands tasks correctly. If you change
  `project`, the app's `ECS_SPOT_PROVIDER`/`ECS_ONDEMAND_PROVIDER` env (already
  wired by this stack) keeps them in sync.
- **Scaling & chaos (Tier‑3)** builds on this: launch N synthetic channels to find
  the per‑node ceiling; kill a node and confirm ECS reschedules + S3‑origin
  continuity; force a Spot interruption and confirm the on‑demand base absorbs it.
  The harness and run sheet are `deploy/loadtest/chaos.mjs` and
  `deploy/loadtest/CHAOS.md`; set `enable_chaos_experiments = true` in the
  staging stack for its Fault Injection Service templates (`chaos.tf`).

## Scaling for large audiences

The `scaling_*.tf` files add the role-split services (api-public, scheduler,
worker), autoscaling, CloudFront + WAF in front of the API, ElastiCache Valkey,
RDS Proxy and the optional Firehose beacon stream. Settings are in the
"Scaling" block of `terraform.tfvars.example`. The full guide, including the
pre-event checklist, is `SCALING.md` at the repository root.

Health checks changed with it: the ALB checks `/health/ready` (database
reachable) and the container checks `/health/live` (process up).
