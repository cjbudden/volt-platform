# Volt Streaming — platform monorepo

Cost-effective, AWS-based, multi-protocol OTT live streaming SaaS platform.
Node/TypeScript control plane on Postgres, an FFmpeg + Shaka Packager encoder,
an S3-origin delivery model, and a set of runnable prototypes.

## Layout
- `volt-app/` — control plane: REST + JSON-LD/Hydra API, auth + multi-tenancy,
  channels/events/EPG/VOD, analytics, SaaS-admin, share links, edit + audit
  foundation. Migrations in `volt-app/migrations/`, docs in `volt-app/docs/`,
  tests in `volt-app/test/` and `volt-app/api/` (Postman + Newman `verify.sh`).
- `volt-encoder/` — encoder/packager container: source failover, thumbnailer,
  status events, and the captions sidecar (whisper + NLLB + Gladia).
- `volt-frame-proto/` — prototype: frame-accurate media access (frame index +
  JIT frame/clip + WebVTT sprite + HLS I-frame trick-play + browser scrubber).
- `volt-image-proto/` — prototype: on-the-fly image service on **sharp**
  (fit-in/fill/stretch + focus + filters, signed URLs, cached) + test views.
- `feature-tracker/` — product feature tracker (test + approve workflow).
- `deploy/terraform/` — Tier-2 cloud stack (VPC/ECS/RDS/S3/CloudFront/ECR/ALB).
- `e2e/` — end-to-end media pipeline harness.
- `VOLT_BUILD_STATUS.md` / `volt_build_status.html` — the build status board.

## Quick start (control plane)
```bash
cd volt-app
npm install
./run-local.sh          # resets + seeds a demo DB, boots API + console on :8080
```
Then open http://localhost:8080/console (see `volt-app/TEST_TONIGHT.md`).

## Tests
```bash
cd volt-app
DATABASE_URL=postgres://…/volt_verify bash api/verify.sh   # API 38/38 (Newman)
bash test/edit-audit.check.sh                              # edit + audit 23/23
npx tsx test/orchestrator.check.ts                         # orchestrator
# prototypes:
cd ../volt-frame-proto && node test.mjs                    # 15/15
cd ../volt-image-proto && node test.mjs                    # 14/14
```

Private repository. Do not distribute.
