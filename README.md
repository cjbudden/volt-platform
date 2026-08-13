# Volt Streaming - platform monorepo

Cost-effective, AWS-based, multi-protocol OTT live streaming platform. A Node/TypeScript
control plane on Postgres, an FFmpeg + Shaka Packager encoder, an S3-origin delivery
model, a React admin app, and runnable prototypes.

## Layout
- `volt-app/` - control plane: REST + JSON-LD/Hydra API, auth + multi-tenancy,
  channels/events/EPG/VOD, analytics, SaaS-admin, share links, edit + audit.
  Migrations in `volt-app/migrations/`, docs in `volt-app/docs/`, tests in
  `volt-app/test/` and `volt-app/api/` (Postman + Newman `verify.sh`).
- `volt-web/` - React + Vite admin app (channels, channel detail with live players,
  image library, settings).
- `volt-encoder/` - encoder/packager: ingest relay + x264/Shaka transcode/package,
  source failover, thumbnailer, status events, captions sidecar. Local run + test
  tooling: `run-local.sh`, `validate.sh`, `validate-docker.sh` (see `RUN_LOCAL.md`).
- `volt-frame-proto/`, `volt-image-proto/` - prototypes (frame-accurate media; image service).
- `feature-tracker/` - product feature tracker (test + approve workflow).
- `deploy/terraform/` - Tier-2 cloud stack (VPC/ECS/RDS/S3/CloudFront/ECR/ALB) + its own README.
- `e2e/` - end-to-end media pipeline harness.
- `VOLT_BUILD_STATUS.md` - build status board.

## Prerequisites
- Node 20+ (22 recommended) and npm.
- Postgres 16 on localhost:5432, OR Docker Desktop (run-on-mac.sh will start a container).
- `python3`.
- `ffmpeg`. macOS: `brew install ffmpeg`. NOTE: to ingest real SRT feeds you need an
  ffmpeg built WITH SRT (`ffmpeg -protocols | grep -w srt`). HLS/RTMP pull sources work
  on any ffmpeg. See `volt-encoder/RUN_LOCAL.md` for an SRT-enabled build.
- Shaka Packager: auto-downloaded on first encoder run; or `brew install --cask shaka-packager`.

## Run the full app locally (the development build)
```bash
cd volt
bash run-on-mac.sh
```
This brings up Postgres (Docker if needed), starts the control-plane API on :8080 and the
React app on :5173, and enables the real on-box encoder when ffmpeg + python3 + Shaka are
present (`ORCH_LAUNCHER=local`). Open http://localhost:5173 and sign in:
`admin@rtm.example` / `volt1234`.

Test data PERSISTS between runs (channels, sources you create stay). To wipe and reload
the demo snapshot: `RESET_DB=1 bash run-on-mac.sh`.

### Test a working stream end to end
1. Channels -> New channel. Type = Transcode. Primary source = an HLS pull URL, e.g.
   `https://d1sq2slp9afh7o.cloudfront.net/smil:jr/chunklist_b2596000_slENG.m3u8`.
   Pick the output rungs (e.g. 1080p/720p/480p). Create.
2. Open the channel -> Send source. The control plane launches the real encoder, which
   ingests the source, transcodes the ABR ladder, and packages CMAF (HLS + DASH) into the
   origin the app serves at `/origin/<channelId>/`.
3. The Source and Output panels play the real stream; the status board and event log show
   real state (the log surfaces real encoder/ffmpeg errors if a source fails). Stop with
   Drop source / the list Stop button.

Encoder output is written under `volt-encoder/_local_out` (standalone) or the control
plane's origin dir; nothing is faked.

## Test cases
Encoder pipeline (no cloud):
```bash
cd volt-encoder
bash validate.sh          # real encoder vs a synthetic source, HLS ingest, PASS/FAIL per function
bash validate-docker.sh   # TEST ALL: HLS + SRT ingest inside the Linux runtime (needs Docker)
```
Control plane + API:
```bash
cd volt-app
DATABASE_URL=postgres://volt:volt@localhost:5432/volt bash api/verify.sh   # API (Newman)
npx tsx test/orchestrator.check.ts                                         # orchestrator
bash test/edit-audit.check.sh                                              # edit + audit
```
End-to-end media pipeline (Docker):
```bash
cd e2e && bash run-e2e.sh   # source -> encoder -> HLS/DASH/CMAF asserted
```
Prototypes: `cd volt-frame-proto && node test.mjs`; `cd volt-image-proto && node test.mjs`.

## Local builds
```bash
cd volt-app && npm install && npx tsc --noEmit        # control plane typecheck
cd volt-web && npm install && npm run build           # admin app production build
cd volt-encoder && docker build -t volt-encoder .     # encoder image (ffmpeg+SRT+Shaka)
```

## Deploy to cloud (Tier-2, AWS)
Full step-by-step is in `deploy/terraform/README.md`. Summary:
```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars     # set region, db creds, domain, etc.
terraform init
terraform plan
terraform apply                                  # VPC, ECS + capacity providers, RDS,
                                                 # S3 + CloudFront, ECR, ALB, Secrets Manager
# build + push the 3 images to the ECR repos it created:
#   volt-control-plane, volt-encoder, volt-thumbnailer  (encoder image also tagged thumbnailer)
# then apply DB migrations and put the integrations secret; see the deploy README.
```
The control plane runs with `ORCH_LAUNCHER=ecs`, launching encoder/thumbnailer tasks on
Spot with on-demand fallback. GPU transcode: set `encoder_instance_types` to g4dn and switch
the AMI SSM param (see deploy README). `terraform destroy` tears it all down.

Private repository. Do not distribute.
