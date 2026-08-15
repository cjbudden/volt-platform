# VOLT Stream — Encoding Workflow Plan

*The single reference for how a stream goes from "created" to "on air", what we
show at every step, how failures surface, and how local testing maps to cloud.*

---

## 1. The mental model: the pipeline is five gates

Every channel and every event is the same five-stage pipeline. Each stage is a
**gate**: the next stage can only be healthy if the one before it is. This is the
whole model — everything else (status, errors, billing, the QC page) hangs off it.

```
  ┌──────────┐   ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌──────────┐
  │ 1 SERVER │──▶│ 2 INPUT  │──▶│ 3 ENCODER │──▶│ 4 OUTPUT │──▶│ 5 PUBLIC │
  │ (compute)│   │ (source) │   │(pkg/trans)│   │ (origin) │   │ (on air) │
  └──────────┘   └──────────┘   └───────────┘   └──────────┘   └──────────┘
   billable          is it        is it          are segments    is it
   up? which         arriving?    running &       advancing?      pushed to
   instance?         codec/rate?  keeping up?     manifest live?  the public?
```

| # | Stage | What it means | Billable? | "Healthy" signal | How it fails | Real log source |
|---|-------|---------------|-----------|------------------|--------------|-----------------|
| 1 | **Server** | The encoder compute is up (local process / Docker container / ECS task) | **Yes — this is the meter** | task/container reports "up" | image pull fail, no capacity, OOM, crash | orchestrator + container boot log |
| 2 | **Input** | The source is reaching the encoder | No (compute already up) | ffmpeg opened the input; bytes flowing | 404/403, DNS, connection drop, wrong protocol, no SRT caller | ffmpeg stderr (`encoder.log`) |
| 3 | **Encoder** | Transcode/package running & keeping up in real time | Yes (it's the compute) | children alive; CPU keeping pace | ffmpeg dies, x264 can't hit realtime, Shaka rejects input | `encoder.log` + child exit code |
| 4 | **Output** | Packaged segments are advancing on the origin | No | manifest mtime advancing | packager down, stall (no new segment), disk full | stall watchdog + packager log |
| 5 | **Public** | Output is exposed to viewers (on air / published) | No (delivery = CDN) | master.m3u8 served to public edge | CDN/origin mismatch, geo block | edge/CDN |

**Why this matters:** today the UI collapses all of this into one green "Live"
dot and one red "OUTPUT ERROR". That's why a healthy encoder that got told to
stop looks identical to a real failure. The fix is to make each gate visible and
independently green/amber/red.

---

## 2. Status & error model (this is the QC system you asked for)

### Each gate has exactly one state
`idle → starting → healthy → degraded → failed` (plus `stopped` = operator ended it).

- **starting** is not an error. (Your current OUTPUT ERROR badge is firing on
  "starting" — bug #1 to fix.)
- **degraded** = still on air but not right (e.g. output stalled, running on backup).
- **failed** = this gate is down and blocking the ones after it.
- **stopped** = a person (or a schedule) ended it. Never shown as an error.

### One primary error message
When any gate is `failed` or `degraded`, we surface **one** headline built from
the *first* failing gate plus its **real underlying reason** (the actual ffmpeg /
packager log line — not a generic string). Example:

> **Input failed** — ffmpeg could not open the source: `HTTP 403 Forbidden`
> (`chunklist_b2596000_slENG.m3u8`). Encoder is up; nothing is being received.

That single line tells the admin *which gate*, *what happened*, and *what's still
OK*. Everything else is detail.

### The QC page
A dedicated "QC / diagnose" view for a stream: the five gates laid out left to
right, each green/amber/red, each expandable to its **real log lines**. It answers
"where in the workflow is it erroring, and why" in one screen — exactly the QC
validation you described. Reached from the primary error message ("Diagnose →")
and from a QC button on the detail page.

### Fixing the three honesty bugs (step 1, this is quick)
1. **Misleading `server_window_closed`.** The encoder uses that as the default
   shutdown reason, so *every* signal-triggered stop is mislabelled. Fix: capture
   the real trigger (`signal:SIGTERM`, `operator_stop`, `child_exit rc=…`,
   `output_stalled`). The log stops lying.
2. **False OUTPUT ERROR.** Stop treating "not yet Available" as an error; add a
   `starting`/warming state distinct from `failed`.
3. **No stop origin.** The control plane must log *who* asked for a stop and *why*
   (operator click vs scheduler vs failover). Then the recurring stop is
   self-explaining instead of a guess.

> **On the recurring stop you're seeing:** the encoder is healthy and the source
> is fine — it's receiving a stop signal (mislabelled "server_window_closed").
> The only thing that sends that signal is the control plane's stop path. Step 1
> makes the next run name the exact caller, so we stop guessing and kill it.

---

## 3. Local vs cloud — one image, one interface, three launchers

This is the reassurance you're after: **the cloud is not a different, scarier
system.** It's the same media pipeline with AWS provisioning bolted on the front.

### One encoder image (answering your Docker question directly)
- There is **one** encoder image, built from `volt-encoder/Dockerfile`. It carries
  ffmpeg (with SRT + drawtext), Shaka Packager, and the encoder code.
- It is **not** precreated or downloaded from anywhere — we build it. Locally
  `run-on-mac.sh` builds `volt-encoder:local` once on first run. In the cloud the
  **same** Dockerfile is built once and pushed to ECR, then every channel/event
  task pulls that one image.
- So "the Docker image" locally and "the ECS task image" in the cloud are the
  **same artifact**. Local Docker encoding behaves byte-for-byte like production.

### One interface, three launchers
```
        Orchestrator (identical logic everywhere)
                        │  TaskLauncher interface
        ┌───────────────┼────────────────┐
   LocalLauncher    DockerLauncher     EcsLauncher
   (on-box proc)    (local image)      (cloud Fargate/EC2)
        └── same encoder.py ──┘             │
                                     one ECR image
```
The orchestrator, status pipeline, event log, error model, and the entire UI are
**identical** across all three. Only the launcher differs.

### What local proves vs what only cloud adds
| Proven fully on your Mac (local/docker) | Added only in cloud (the "glue") |
|-----------------------------------------|----------------------------------|
| The whole media pipeline (ingest → transcode/package → CMAF HLS+DASH → DVR) | Instance provisioning + ECR image pull |
| Status snapshots, event log, error model, QC page | S3 origin + CloudFront edge |
| Auto-profile selection, ladder cap | Autoscaling + Spot/on-demand strategy |
| Failover to backup / filler; manual source switch | The billing meter (usage → invoice) |

So we harden the workflow locally, and the cloud step is provisioning + delivery,
not new media logic. That's why local-first is the right order, not a detour.

---

## 4. Provisioning & billing model

### The billable unit is the SERVER (stage 1). Everything else is free-ish.
Compute (the encoder task) is what costs money. Input, encode, output packaging
are just that compute doing its job. Delivery cost is CDN (per-GB), separate.

### Channel (24/7)
- The **server** is the billable unit. Recommend: bring it up on an **explicit
  action** ("Start channel" / "Bring server up"), **not** silently on create — so
  the person controls when the meter starts. On create, the channel is configured
  but cold (£0).
- Assume the input is always-on once the server is up.
- **On air** = output is being pushed to the public edge. For a 24/7 channel that's
  usually immediate once the server + encoder are healthy.
- Billing window = server-up → server-down.

### Event (scheduled)
Two datetimes in the event form make the money explicit:
- **Server start** — when we bring the encoder up to validate the input *ahead* of
  air (pre-flight). **Billing begins here.**
- **Publish / scheduled start** — when the output goes public (on air to viewers).
- **Server stop** — encoder down. **Billing ends here.**

This makes the billable window a thing you set and see, and lets you pre-flight the
source before the audience is watching.

### Instance selection
- **System chooses by default** from the auto-profile (§5) and shows you the pick
  and its rate. Manual override available for power users.
- Not a silent background spin-up on create: the instance is assigned when the
  server is brought up (channel start / event server-start).

### Billing awareness in the UI (subtle, not in-your-face)
- A small **"● billable"** chip + a running clock wherever a server is up (list
  row and detail header).
- The action that starts the meter gets a one-line confirm: *"This brings up an
  encoder — billing starts now."*
- The QC page shows the current billable window and elapsed time.

---

## 5. Auto-profile: the system picks transcode vs package (not the form)

You're right that the operator shouldn't hand-pick the workflow. The system decides
from the **probed source** (we already built `POST /api/sources/probe`).

**Decision:**
- Source is already a **multi-rendition ABR ladder** (several manifests / a master
  with variants) → **package-only** (cheap, no re-encode).
- Source is a **single mezzanine/contribution feed** → **transcode** to a ladder.
- **Ladder** is derived from the source resolution — never upscale, cap rungs to the
  source (your dynamic-cap request). A 720p source → max 720p ladder.
- **Instance size** from ladder depth + codec + fps (+ GPU for heavy ladders).
- **Event length** drives recording/retention, not encode type.

The form still **shows** the chosen profile (transparency) with an "advanced
override," but the default is computed, not asked.

---

## 6. Smaller items you called out

- **EPG strip under the player:** remove the fake status/EPG now; when there are no
  programmes show a **"No programmes yet — Create EPG"** call-to-action linking to
  the EPG page. (No hardcoded content anywhere — matches your standing rule.)
- **Transcription/captions:** it's its own lane in the pipeline with the same
  healthy/degraded/failed + real reason (e.g. "captions task up, model loaded" vs
  "whisper failed to start"). Shown next to the output gate, not blended into it.
- **Failover test (next round):** simulate primary failing → switch to backup →
  then to filler (loop/slate image) when all live inputs are down, with the switch
  visible in the event log. Plus a **manual "switch output source"** control for
  testing.

---

## 7. The information model — everything we convey, in one place

For each gate we always know and can show:

- **State** (idle/starting/healthy/degraded/failed/stopped)
- **Since** (timestamp of the current state)
- **Detail** (the real reason string — from ffmpeg/packager where relevant)
- **Metrics** (input: codec/res/fps/bitrate/audio; encoder: renditions, realtime
  margin; output: segment count, DVR depth, manifest age)
- **Billable?** (server gate only) + elapsed
- **Actions available** (start server / send source / go live / switch source / stop)

That table *is* the QC page, and a compressed version of it is the detail page.

---

## 8. Proposed build sequence

1. **Honesty + diagnosis (small, first).** Fix the misleading shutdown reason, log
   stop origin in the control plane, distinguish operator-stop from failure, kill
   the false OUTPUT ERROR. → your next run tells us exactly what stops the stream.
2. **Real error surfacing.** One primary error banner built from the real
   ffmpeg/packager reason; event log carries the detail.
3. **QC page v1.** The five gates, green/amber/red, expandable to real logs.
4. **Status model refactor.** The five-gate state machine backing list + detail + QC.
5. **Provisioning & billing.** Channel start action; event server-start/publish;
   billable chip + clock; instance auto-pick with override.
6. **Auto-profile.** Probe-driven transcode/package + ladder cap + instance sizing.
7. **EPG CTA + captions lane.**
8. **Failover + manual source switch tests.**

Steps 1–3 are what turn "it stops and I can't tell why" into "I can see exactly
which gate failed and read the real reason" — so I'd do those first.
