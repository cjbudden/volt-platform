# Volt — local end-to-end test harness

Proves the **core encoding** path, the **control plane**, and the **admin data**
work together on a laptop — no cloud, no GPU. This is Tier 1 of the test
strategy; Tier 2 (cloud staging via **Terraform**) and Tier 3 (scaling & chaos)
build on top of it.

```
FFmpeg test-pattern ladder ──SRT──▶ Volt encoder ──CMAF / HLS + DASH──▶ MinIO (S3)
                                        │
                                        └── status + events ──▶ control-plane API ──▶ admin
```

MinIO stands in for S3 (the encoder writes exactly as it would to real S3), so
everything downstream of the encode — packaging, the DVR/recording layout, the
manifests — is exercised for real. What this tier deliberately does **not** cover
is scale and infra behaviour (GPU NVENC density, Spot/ECS autoscaling, CloudFront,
RDS, multi-AZ) — that's Tier 2/3, in the cloud.

## Two ways to run

### 1. Full stack (Docker) — `./run-e2e.sh`
Requires Docker + Docker Compose. Brings up Postgres (seeded with a fixed
account/channel), MinIO, the control-plane API, a **source** container emitting a
2-rung SRT ladder, and the **encoder** under test. Lets it run ~30s, then asserts:

- HLS `master.m3u8` and DASH `manifest.mpd` and CMAF `seg_*.m4s` landed in MinIO,
- the control plane reports `output_available:true` for the channel,
- the event log contains `channel.start` and `packager.up`.

```bash
cd e2e
./run-e2e.sh          # exit 0 = pass; RUN_SECONDS=60 ./run-e2e.sh to run longer
```

Poke around while it's up: MinIO console at http://localhost:9001 (volt / voltsecret),
API at http://localhost:8080, e.g.
`GET /api/status/channel/00000000-0000-0000-0000-0000000000c1`.

### 2. Core encode only (no Docker) — `./local-pipeline-test.sh`
The tight inner loop while working on the encoder. Needs only `ffmpeg`, Shaka
`packager` on PATH, and `python3`. Runs the encoder's own `build_shaka()` against
an FFmpeg test ladder and asserts the manifests + segments are produced and the
output decodes. ~20s.

```bash
cd e2e
./local-pipeline-test.sh
```

> Get Shaka Packager the same way the encoder image does — download
> `packager-linux-x64` from the Shaka releases (see `volt-encoder/Dockerfile`) and
> put it on your PATH as `packager`.

## What's exercised

| Area | Covered here | Where else |
|---|---|---|
| Ingest (SRT) → package → CMAF → HLS+DASH → S3 | ✅ (real, CPU) | — |
| Packaging (`package_only`) | ✅ | — |
| CPU transcode (x264 ladder) | ✅ (swap the job to `transcode`) | GPU density → cloud |
| Status + events → control plane, admin reads | ✅ | — |
| Recordings / VOD / metadata / compose-clip APIs | control-plane unit/smoke | — |
| Input failover / filler switching | source-selector unit tests | live soak → cloud |
| Thumbnailer (poster/storyboard/VTT) | thumbnailer unit + real ffmpeg | — |
| Spot / ECS autoscaling / bin-packing | ❌ | Tier 2/3 cloud |
| CloudFront delivery, RDS, multi-AZ | ❌ | Tier 2 cloud |
| Per-node channel ceiling (D2), chaos | ❌ | Tier 3 load harness |

## Files
```
docker-compose.e2e.yml   db (seeded) + minio + createbucket + api + source + encoder
seed.sql                 fixed account/group/channel (IDs referenced everywhere)
job.e2e.json             encoder job: package_only, 2-rung SRT ladder → MinIO, status→API
source-ladder.sh         FFmpeg: 2-rung keyframe-aligned SRT ladder (the "client")
run-e2e.sh               up → wait → assert (MinIO manifests + control-plane status/events)
local-pipeline-test.sh   no-Docker core-encode check via the encoder's own build_shaka()
```

## Next (Tier 2 / Tier 3)
- **Tier 2 — cloud staging (Terraform).** `deploy/terraform/`: VPC, ECS + capacity
  providers (Spot + on-demand), RDS, S3 origin, CloudFront, ECR, ALB, Secrets
  Manager. `terraform plan` is the validation gate; one command to a throwaway env.
- **Tier 3 — scaling & chaos.** Launch N synthetic channels to find the per-node
  ceiling (D2: cap where S3 PUT + CPU hit 80%); chaos tests (kill node → ECS
  reschedule + S3-origin continuity; Spot interruption → drain/fallback).
