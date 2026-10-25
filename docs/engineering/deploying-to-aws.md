# Deploying to AWS

The cloud deployment is Terraform in `deploy/terraform`. It is written but has
not been applied to a real account yet: the first apply waits on an AWS
account, credentials and a region from Christian (Set aside in
`BUILD_QUEUE.md`), and build queue item 2.1 makes the stack ready to apply
with an APPLY.md runbook. The step-by-step today is
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
| `deploy/terraform/ecr.tf` | the image repositories |
| `deploy/terraform/secrets.tf` | Secrets Manager entries the app reads by reference |
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

## The first apply, in outline

The commands are in `deploy/terraform/README.md`; the order matters:

1. **Configure.** Copy `deploy/terraform/terraform.tfvars.example` to
   `terraform.tfvars` and set project, environment, region and sizes. For
   anything beyond a throwaway environment, turn on the S3 state backend in
   `deploy/terraform/versions.tf` first.
2. **Apply.** About 40 resources, 15 to 20 minutes. The control plane service
   sits at zero healthy tasks until its image exists.
3. **Build and push the images** to the repositories the stack created: the
   control plane (`volt-app`), the encoder (`volt-encoder`, also tagged as the
   thumbnailer) and FAST playout (`volt-encoder/Dockerfile.fast`). Radio has
   its own image (`volt-encoder/Dockerfile.radio`) and the app launches it as
   the `volt-radio` task definition, but `deploy/terraform/ecr.tf` creates no
   repository for it and the stack no task definition, so radio does not run
   in AWS yet. Item 2.1 has to close that.
4. **Migrations.** The control plane applies every migration in
   `volt-app/migrations` on boot, under a lock, in the `api-admin` role. A
   one-off run uses the same runner (`npm run migrate` in `volt-app`). Step 4
   of `deploy/terraform/README.md` still shows applying only the first
   migration with psql; follow the app, not that step (item 2.1 corrects it).
5. **Secrets.** Put the integration secrets (DRM, social apps) into the
   Secrets Manager entry the stack created. The app stores only references;
   raw values never reach the database or the images.
6. **Smoke test.** `/health` on the control plane address, then create and
   start a channel and watch the encoder task land on Spot.

## The cost functions, and where they stand

What makes Volt cheap to run is mostly in phase 2 of the queue:

| Function | Where | Queue |
|---|---|---|
| Encoders on Spot with an on-demand base, launched per channel by RunTask | `volt-app/src/services/orchestrator/launcher.ts`, `deploy/terraform/ecs_cluster.tf` | built |
| Per-run S3 prefixes, so a recording is a time range over segments that move as a unit | encoder and origin pointer | 2.2 |
| Retention, cooling and archive of recordings on S3 | `volt-app/src/services/clips` for clips and extracts | 2.3 |
| Consolidation: move encoders off part-empty nodes, make before break | `CONSOLIDATION.md` | 2.4 |
| Watch folders picked up from S3 by event, not by a walk | | 2.6 |
| Edge rights decided in CloudFront, not at the origin | `deploy/edge/rights-viewer-request.js` | built (1.14a, 1.14b) |
| Scaling and chaos runs against the deployment | `deploy/loadtest` | 2.8 |
| CDN logs with CMCD counted at the edge | | 2.9 |

## Before you apply, check

- `terraform plan` shows what you expect and nothing in another environment.
- `env = "prod"` turns on deletion protection and a final database snapshot
  and stops the bucket being force-emptied on destroy. Staging tears down
  cleanly with `terraform destroy`.
- The ALB is HTTP only until a certificate and domain are added (see "Notes
  and prod hardening" in `deploy/terraform/README.md`).
