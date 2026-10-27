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
| Email provider for invites, password resets, sign-in codes and alerts | `SMTP_URL` in the integrations secret and `app_secret_keys`, `NOTIFY_FROM` in `app_env` (step 7). Without them production cannot send email |
| A domain and an ACM certificate for the API and the console | `api_edge_aliases`, `api_edge_certificate_arn`, or `public_base_url` |
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
if an account will use Whisper captions). The commands are section 3 of
`README.md`. Then force a new deployment of the control-plane service(s).

Whisper captions run on a GPU pool (`ecs_capacity_gpu.tf`, g4dn.xlarge by
default) that starts at zero servers and costs nothing until a captions task
waits for one. Your AWS account needs a G-instance vCPU quota of at least 4
per GPU server (`gpu_max`); new accounts often have 0, so request it before
the first captioned stream. `gpu_max = 0` leaves the pool out.

## 6. The database

Nothing to run. The roles that own the schema (`all`, `api-admin`,
`scheduler`) apply every migration in `volt-app/migrations` on boot, under a
lock, before they serve; the others wait. The control plane's log shows each
migration as it runs.

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

## 9. What does not work on AWS yet

These are queued, not forgotten (`BUILD_QUEUE.md`, and class
`not-on-aws-yet` in `env-coverage.json`):

- **2.1a.** Uploaded slates and loops, prebuilt loop segments, clip and VOD
  work and the trash live on a control-plane task's own disk, and the
  control-plane image has no ffmpeg, packager or Python for the jobs that
  run in it (clip extract, VOD encode, loop preparation, intro detection).
  On AWS today those jobs fail and an uploaded loop is lost with its task.
- **2.1c.** Radio's Icecast relay: stations run (HLS and DASH), but their
  MP3 output is dropped because no relay is configured. Where it should run
  is waiting on a decision.

The rest of phase 2 (per-run S3 prefixes, recording retention,
consolidation, S3 watch folders, WAF blocking, CDN logs) builds on this
stack; each item says what it adds.

## 10. Undo

`terraform destroy` tears a non-prod environment down, apart from two buckets
that are never emptied for you: the QoE raw reports (kept under Object Lock)
and the image library unless `images_force_destroy = true`. For
`env = "prod"` the database keeps deletion protection and a final snapshot,
and the origin bucket is not force-emptied either: that is deliberate.
