# Volt Streaming — Encoder / Packager

The Volt Streaming data-plane container. **One running container == one channel/event** —
all of that channel's renditions, packaged together and kept in lockstep. The
control plane (the Node/TS API) launches one of these on ECS/EC2 when a channel
or event activates and terminates it when the server window closes.

It runs one of two workflows, chosen by the job config:

| Workflow | Client sends | We do | Node |
|---|---|---|---|
| `package_only` | the full pre-encoded ABR ladder (one input per rendition) | package only — no transcode | CPU (c5) |
| `transcode` | one mezzanine feed | build the ladder with FFmpeg, then package | GPU (g5/g6) |

Both produce **CMAF single-file segments** and **synchronised HLS + DASH
manifests**, optionally `cbcs`-encrypted with keys fetched live from a **SPEKE
v2 / CPIX** key server (Axinom for RTM). Output is written to a local dir and
mirrored to **S3** by a sidecar; **CloudFront serves viewers from S3**, so
viewer traffic never touches this box. The live segments on S3 **are** the
recording — live-to-VOD needs no reprocessing.

## Pieces

```
Dockerfile              ffmpeg + Shaka Packager (v3) + awscli + python3, tini as PID 1
bin/encoder.py          orchestrator: reads job config, wires FFmpeg -> Shaka -> S3, supervises
bin/speke_client.py     CPIX POST to the SPEKE server; returns content keys as JSON (stdlib only)
bin/s3-uploader.sh      aws s3 sync loop; segments immutable+long-TTL, manifests no-cache; final sync on stop
job.example.json        the RTM packaging job (+ an inline transcode example)
```

## Data flow (package_only)

```
client rendition N  --SRT/RTMP/HLS-->  ffmpeg relay (-c copy)  --MPEG-TS/UDP-->  \
                                                                                  Shaka Packager
client rendition 1  --SRT/RTMP/HLS-->  ffmpeg relay (-c copy)  --MPEG-TS/UDP-->  /   |
                                                                                     v
                                                        CMAF segments + HLS/DASH manifests (+ cbcs DRM)
                                                                                     |
                                                             s3-uploader.sh  --sync-->  S3  --> CloudFront --> viewers
```

Each rendition gets its own local UDP port (`127.0.0.1:20000+i`). The relay does
**no re-encode** — it preserves the client's GOPs, which is why the [Ingest
Requirements](../docs/Volt_Ingest_Requirements.docx) insist every rendition is
keyframe- and timestamp-aligned: Shaka trusts those boundaries to cut aligned
segments across the ladder.

For `transcode`, one FFmpeg process pulls the mezzanine and fans out the whole
ladder with forced, aligned closed GOPs (`-force_key_frames expr:gte(t,...)`,
`-sc_threshold 0`), NVENC when `gpu: true`.

## Job config

See `job.example.json`. Required: `channel_id`, `workflow`, `segment_seconds`,
`s3.bucket`, `inputs`. `package_only` reads renditions from `inputs`; `transcode`
reads `inputs[0]` as the mezzanine and builds the `ladder`. Rendition count is
capped at 8 (mirrors `accounts.max_renditions`). DRM is optional — omit `drm`
or set `mode: "none"` for clear.

The control plane injects the config one of two ways:

```bash
# mounted file (default: /job/config.json)
docker run -v $PWD/job.json:/job/config.json:ro \
  -e AWS_REGION=ap-southeast-2 volt-encoder

# or inline
docker run -e JOB_CONFIG_JSON="$(cat job.json)" volt-encoder
```

## Build & run locally

```bash
docker build -t volt-encoder .

# clear (no DRM), point at a local SRT source, write to a test bucket
docker run --rm \
  -e AWS_REGION=ap-southeast-2 \
  -e AWS_ACCESS_KEY_ID=... -e AWS_SECRET_ACCESS_KEY=... \
  -v $PWD/job.example.json:/job/config.json:ro \
  volt-encoder
```

On ECS use a **task role** (not keys) scoped to `s3:PutObject` on the origin
bucket prefix, and pull the SPEKE `auth` (Axinom management key) from **Secrets
Manager** — never bake it into the image or the config.

## Redundancy (optional)

Redundancy is **off by default** and configured per channel/event via the
`redundancy` block in the job config. It protects the **input** side only —
there is no backup output (the output is ours; node/container loss is covered by
ECS restart against the S3 origin buffer, not a parallel output).

Two independent options:

The **source-selector** (`bin/source_selector.py`) implements this. When
`redundancy.input_failover` is on it *owns the bus ports Shaka reads*:

```
primary ladder --relay--> udp 21000+i  \
backup  ladder --relay--> udp 22000+i   >--[forwarder i]--> udp 20000+i (bus -> Shaka)
filler         --encode-> udp 23000+i  /
```

Every candidate runs continuously to its own private ports; a per-rendition
forwarder copies the *active group* to the bus. Everything reaches Shaka as an
ordinary TS on one timeline, so **Shaka is the single continuity engine** and
segment numbering never breaks regardless of which group is live — the switch
happens upstream of it.

**Input failover.** Inputs carry a `role` (`primary` | `backup`). A `Health`
tracker debounces each group's liveness (from FFmpeg `-progress` out_time) with
up/down hold so a blip doesn't flap. A group is healthy only when *all* its
renditions flow (the whole ladder switches together — you never split renditions
across groups). `SelectorPolicy` picks primary → backup → filler; `auto_failback`
returns to primary once it's been stably healthy for `failback_hold`. A switch
repoints the forwarders (fast, local UDP — no network handshake), so the gap is
sub-second; because primary and backup are time-aligned per the ingest spec, a
primary↔backup switch is near-seamless.

**Filler on total input loss.** When *all* live inputs are down,
`input_loss_behavior` (`slate` | `vod_loop` | `last_frame` | `black`) decides what
plays, held until a live input returns. Filler is generated as a **ladder-matched
TS** — FFmpeg encodes the nominated slate image or looping VOD into each
rendition's exact height/bitrate, GOP-aligned to the segment duration — and fed
onto the bus like any other source, so Shaka segments it on the same continuous
timeline (continuous numbering comes for free; no manual CMAF splicing). This
keeps the live packaging path encode-free while still guaranteeing the output
never stalls; the same mechanism serves transcode.

> Status: **built and unit-tested** for `package_only` (health hysteresis,
> failover order, auto-failback, flap-resistance, and all command builders —
> `bin/test_source_selector.py`, 43 assertions). The selector's children are
> non-critical so an expected relay death triggers failover, not teardown. Still
> open: a zero-gap primary↔backup splice (today's repoint costs a sub-second
> gap the player buffer absorbs), transcode-workflow failover (needs the selector
> to feed one chosen mezzanine into the encoder — an extra source-bus hop), and a
> live soak test to validate frame-level continuity across real switches.

## Thumbnailer — keyscreen images without a GPU encode

`bin/thumbnailer.py` produces the keyscreen still, storyboard sprite sheets, and
a WebVTT thumbnails track for a recording or VOD asset. Generating stills is
decode-and-scale, not encoding, so it runs as a **CPU-only** job: one FFmpeg pass
with `-skip_frame nokey` decodes only keyframes of the hi-res source (very fast at
~1 frame / 10 s), `scale` + `tile` pack them into sheets, and `build_webvtt`
emits `#xywh=` cues for the player scrub bar. Outputs go to S3 and the keys are
POSTed to `/api/media/thumbnails`. No GPU, no video re-encode — an animated
hover-preview (MP4/GIF) is the only thing that would need an encode, and it's an
optional extra we haven't built.

Runs on event end / recording completion as a separate task (override the image
command to `python3 /app/bin/thumbnailer.py`, `THUMB_CONFIG=/job/thumb.json` —
see `thumb.example.json`). Builders + WebVTT are unit-tested (`bin/test_thumbnailer.py`,
22 assertions) and verified end-to-end against real FFmpeg (poster 320×180,
3×2 sheet 960×360, sheet numbering aligned to the VTT).

## Event log & live status

`bin/events.py` gives every channel a per-stream **event log** and a live
**status snapshot**. Each core event — `channel.start/stop`, `source.up/down`,
`failover.switch`, `filler.engaged/cleared`, `packager.up/down` — is emitted as
one JSON line to stdout (CloudWatch captures it, giving a durable queryable log
per stream) and, on every change, the current snapshot is (a) written to
`/work/status.json` and (b) POSTed to the control plane's ingest endpoint
(`status_report.url` in the job config, `X-Volt-Ingest-Token` auth). Reporting is
fire-and-forget on a daemon thread — the media path never blocks on the control
plane.

The snapshot is what the admin shows: `output_available` (is the manifest still
advancing?), `active_source` (primary/backup/filler), `fallback_in_use`,
`filler_in_use`, `packager_ok`, and a per-source state map. `output_available`
stays true through a failover or filler engagement — it only goes false if the
packager is down or even filler can't feed. The source-selector drives these
transitions; `bin/test_events.py` (16 assertions) covers the derivations. See
the control-plane README for the API and the polling-vs-SSE decision.

## Lifecycle & failure

`tini` is PID 1 and reaps children. On `SIGTERM` (ECS stop at the server-window
close) the orchestrator terminates FFmpeg/Shaka and the uploader runs one final
sync so the closing manifest and last segments land. If any critical child dies
mid-stream the orchestrator tears the **whole** container down, so ECS restarts
a clean one — renditions must never drift out of sync, so partial recovery is
worse than a fast full restart. Input redundancy (a full backup ladder) is
handled upstream per the Ingest Requirements.

## Status / next

- [x] package_only: per-rendition SRT/RTMP/HLS relay → Shaka → CMAF/HLS/DASH → S3
- [x] transcode: mezzanine → aligned ladder (x264 / NVENC) → Shaka
- [x] SPEKE v2 / CPIX key fetch → Shaka raw-key `cbcs`
- [x] redundancy config shape + primary/backup input routing
- [x] source-selector: health hysteresis, failover primary→backup→filler, auto-failback (package_only, unit-tested)
- [x] filler generation: slate / VOD-loop → ladder-matched TS on the bus, GOP-aligned
- [x] event log + live status snapshot (stdout/CloudWatch + control-plane report + local file)
- [ ] zero-gap primary↔backup splice (today: sub-second repoint gap) + live soak test
- [ ] transcode-workflow failover (selector feeds one chosen mezzanine into the encoder)
- [ ] watermark / bug overlay filter (FFmpeg `overlay`) on the transcode path
- [ ] Gladia caption sidecar → segmented WebVTT + playout offset
- [ ] health/metrics endpoint the control plane scrapes for monitoring
- [ ] FairPlay HLS signaling (`hls_key_uri` / EXT-X-KEY) wiring end-to-end
```
