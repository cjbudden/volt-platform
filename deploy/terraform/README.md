# Volt Streaming — Cloud Deployment (Tier‑2, Terraform)

This stack stands up a working Volt Streaming environment on AWS: a Fargate
control plane behind an ALB, an EC2 ECS cluster with **Spot + on‑demand**
capacity providers for the encoder/thumbnailer tasks, RDS Postgres, an S3 origin
fronted by CloudFront, ECR repos, and Secrets Manager. It is the Tier‑2 target
referenced by the test strategy in the main `RUNBOOK.md` (Tier‑1 = local e2e).

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

## 3. Build & push the three images
```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region || echo us-east-1)
aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com

# control plane
docker build -t volt-control-plane ../../volt-app
docker tag volt-control-plane $(terraform output -json ecr_repositories | jq -r '."volt-control-plane"'):latest
docker push $(terraform output -json ecr_repositories | jq -r '."volt-control-plane"'):latest

# encoder (also serves as the thumbnailer image build target)
docker build -t volt-encoder ../../volt-encoder
docker tag volt-encoder $(terraform output -json ecr_repositories | jq -r '."volt-encoder"'):latest
docker push $(terraform output -json ecr_repositories | jq -r '."volt-encoder"'):latest
docker tag volt-encoder $(terraform output -json ecr_repositories | jq -r '."volt-thumbnailer"'):latest
docker push $(terraform output -json ecr_repositories | jq -r '."volt-thumbnailer"'):latest

# roll the control-plane service onto the new image
aws ecs update-service --cluster $(terraform output -raw ecs_cluster) \
  --service $(terraform output -raw ecs_cluster)-* --force-new-deployment 2>/dev/null || true
```
(Encoder and thumbnailer task defs point at `:latest`; the orchestrator picks
them up on the next RunTask — no service to roll.)

## 4. Migrate the database (once)
The app applies `migrations/0001_init.sql`. Easiest is a one‑off task or a bastion;
for a throwaway env you can run it from anywhere that can reach RDS (it's in
private subnets, so use SSM port‑forward through a node, or temporarily allow your
IP on the RDS SG):
```bash
DB_URL=$(aws secretsmanager get-secret-value --secret-id $(terraform output -raw app_secret_arn) \
  --query SecretString --output text | jq -r .DATABASE_URL)
psql "$DB_URL" -f ../../volt-app/migrations/0001_init.sql
```

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
For a custom domain set `image_edge_aliases = ["img.example.com"]` and
`image_edge_certificate_arn` (ACM, us-east-1), then point DNS at the distribution. Smoke test:
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
- **HTTPS/domain.** The ALB is HTTP‑only here so it stands up without a domain.
  For prod add an ACM cert + an HTTPS listener and redirect 80→443; put a custom
  domain (Route 53) on both the ALB and the CloudFront distribution.
- **GPU transcode.** Default nodes are CPU (packaging + x264). For GPU density set
  `encoder_instance_types = ["g4dn.xlarge"]` and switch the ECS AMI SSM parameter
  in `ecs_cluster.tf` to the GPU‑recommended one.
- **NAT/HA.** One NAT gateway to keep staging cheap; use one per AZ and
  `db_multi_az = true` for prod.
- **Capacity provider names** (`volt-spot` / `volt-ondemand`) match the control‑
  plane config defaults, so the orchestrator's `capacityProviderStrategy`
  (Spot weight 4 + on‑demand base 1) lands tasks correctly. If you change
  `project`, the app's `ECS_SPOT_PROVIDER`/`ECS_ONDEMAND_PROVIDER` env (already
  wired by this stack) keeps them in sync.
- **Scaling & chaos (Tier‑3)** builds on this: launch N synthetic channels to find
  the per‑node ceiling; kill a node and confirm ECS reschedules + S3‑origin
  continuity; force a Spot interruption and confirm the on‑demand base absorbs it.

## Scaling for large audiences

The `scaling_*.tf` files add the role-split services (api-public, scheduler,
worker), autoscaling, CloudFront + WAF in front of the API, ElastiCache Valkey,
RDS Proxy and the optional Firehose beacon stream. Settings are in the
"Scaling" block of `terraform.tfvars.example`. The full guide, including the
pre-event checklist, is `SCALING.md` at the repository root.

Health checks changed with it: the ALB checks `/health/ready` (database
reachable) and the container checks `/health/live` (process up).
