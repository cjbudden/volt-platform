# Encode engines: adding an external encoding vendor

Volt's own pipeline (FFmpeg and Shaka Packager in our container) is one **encode
engine**. This document explains how another one, such as AWS Elemental MediaLive,
Bitmovin Live Encoding or Wowza, is added through the vendor's API without
losing Volt features and without changing the orchestrator.

Status (12 Oct 2026): the hooks are built and tested. Only `builtin` is
installed. MediaLive, Bitmovin and Wowza are catalogued as *planned*, with the
capability sketches below, and appear in `GET /api/engines` so they can be
discussed with a customer before anyone writes an adapter.

## 1. The idea in one picture

```
            profile.encode_engine = 'builtin' (default)
 orchestrator ──> EngineAwareLauncher ──> TaskLauncher (mock/local/docker/ECS) ──> our encoder
                        │
                        │  profile.encode_engine = 'medialive' | 'bitmovin' | ...
                        ├── encode_only: vendor encodes, pushes renditions back ──> our packager (package_only)
                        └── full:        vendor encodes, packages, originates   ──> no container of ours
```

An **engine** is *what* encodes. A **TaskLauncher** is *where our container
runs*. They are separate on purpose. The engine-aware launcher implements the
existing `TaskLauncher` interface, so `orchestrator/service.ts`, auto connect,
reconcile and the fleet view work unchanged for every engine.

## 2. The two modes, and why encode only is the default

| | encode_only (recommended) | full |
|---|---|---|
| Vendor does | Encodes the ABR ladder | Encodes, packages, originates |
| Volt does | Packages (Shaka CMAF), origin, everything downstream | Control plane and catalogue only |
| Our container runs | Yes, a `package_only` packager | No |
| Captions on the single `tfdt` clock | Yes | No |
| Failover filler splice, geo slate | Yes | No |
| Recordings, DVR index, clipping, thumbnails, QC | Yes | Only if the vendor writes CMAF into our bucket |
| DRM through our SPEKE/Axinom path | Yes | No (vendor DRM instead) |
| Who bills per minute | Vendor (pass-through) plus our packager | Vendor |

Nearly every feature that makes Volt different reads the CMAF segments our
packager writes. In encode only mode the vendor is simply a managed source in
front of the `package_only` workflow that already exists, so nothing is lost.
Full mode is for a customer who insists on keeping their vendor's packaging,
and the capability check warns, loudly, about what goes away.

## 3. What is built (the hooks)

| Piece | File | What it does |
|---|---|---|
| Contract | `volt-app/src/services/engines/types.ts` | `EncodeEngine`, `EngineCaps`, `EngineDescriptor`, canonical event list |
| Catalogue | `engines/catalog.ts` | `builtin` plus planned MediaLive, Bitmovin, Wowza with capability sketches and a `todo` list each |
| Registry and capability check | `engines/registry.ts` | `registerEngine`, `listEngines`, `checkCapabilities`, `validateForEngine` |
| Built-in engine | `engines/builtin.ts` | Registered for listing and validation only. Never driven through the engine API |
| The seam | `engines/launcher.ts` | `EngineAwareLauncher`: builtin passes straight through, vendors are provisioned, bound and stopped |
| Registration point | `engines/index.ts` | `registerEngines()`. Vendor adapters are added here behind their own config switch |
| Profile choice | migration `0044` | `output_profiles.encode_engine` (default `builtin`) and `encode_engine_mode` |
| Job config | `services/jobConfig.ts` | Adds `engine: {id, mode, stream_kind}` **only** for a vendor engine, so the builtin job is byte-identical |
| Vendor handle | table `engine_bindings` | Which vendor resource sits behind which task arn |
| API | `modules/engines.ts` | `GET /api/engines`, `GET /api/engines/:id`, `POST /api/engines/:id/validate`, `PUT /api/engines/profiles/:profileId` |
| Webhooks | `POST /api/engine-hooks/:engineId` | Public, verified by the adapter, normalised into canonical events, applied through the same `applyReport` path as our encoder's own status POST |
| Tests | `test/workflows.check.ts` | A fake vendor exercises encode only, full, stop, liveness, rollback, webhook normalisation |

### What "no behaviour change" means here

With every profile on `builtin` (the default), `launchEncoder` hands the job
object straight to the deployment's launcher, unchanged, and no binding is
written. `test/orchestrator.check.ts` passes unchanged (60 checks).

## 4. Adding a vendor, step by step

### Step 1. Confirm the capability sketch

Open `engines/catalog.ts`, find the vendor's entry and work through its `todo`
list against the vendor's **current** API documentation. The values there are
sketches from general product knowledge, not a verified contract. Correct
anything that is wrong. The two questions that matter most:

1. **Return path.** How do renditions get back to Volt in encode only mode?
   SRT push per rendition is best (our listeners already exist). RTMP push
   works. CMAF written to our S3 bucket works if segment duration and timescale
   match the channel exactly.
2. **Events.** Does the vendor push webhooks (or EventBridge), or must we poll?

### Step 2. Write the adapter

Create `volt-app/src/services/engines/vendors/<id>.ts` and implement
`EncodeEngine`:

```ts
import { MEDIALIVE } from '../catalog';
import type { EncodeEngine, EngineHandle, JobSpec, EngineMode } from '../types';

export function makeMediaLiveEngine(): EncodeEngine {
  return {
    descriptor: { ...MEDIALIVE, availability: 'installed' },

    // Vendor-specific refusals on top of the generic capability check.
    validate(job: JobSpec, mode: EngineMode) {
      return []; // e.g. a ladder rung the vendor's output group cannot express
    },

    // encode_only: the job OUR packager runs. One SRT listener per rendition
    // the vendor will push to. Keep segment_seconds and fps from the job.
    packagerJob(job: JobSpec): JobSpec {
      return {
        ...job,
        workflow: 'package_only',
        inputs: job.ladder.map((r: any, i: number) => ({
          rendition_label: `${r.height}p`, role: 'primary', protocol: 'srt',
          url: `srt://0.0.0.0:${9000 + i}?mode=listener&streamid=${job.channel_id}-${r.height}p`,
          bitrate_kbps: r.bitrate_kbps, has_audio: i === 0,
        })),
      };
    },

    // Create (or reuse) the vendor channel. MUST be idempotent per stream:
    // a retry after a timeout must not create a second billable channel.
    async provision(streamId, job, mode): Promise<EngineHandle> {
      // translate the neutral job: inputs, ladder, overlay, outputs (return path)
      return { externalRef: '<vendor channel id>', meta: { region: '...' } };
    },
    async start(h) { /* StartChannel */ },
    async stop(h, reason) { /* StopChannel; tolerate "already stopped" and "not found" */ },
    async isRunning(h) { /* 'alive' | 'dead' | 'unknown'. Never 'dead' on a network error */ return 'unknown'; },

    verifyWebhook(headers, rawBody) { /* signature or shared secret check */ return false; },

    // Vendor payload -> canonical events (section 5).
    normalize(raw, binding) { return []; },

    async usage(h, fromMs, toMs) { return null; },
  };
}
```

Rules every adapter follows:

- **Translate from the neutral job.** The job is what `buildEncoderJobConfig`
  already produces. Do not add vendor fields to profiles or channels.
- **Secrets by reference.** Credentials come from configuration or Secrets
  Manager refs, never from the job, the database or a log line.
- **Idempotent provision, tolerant stop.** The launcher stops the vendor job
  first on every teardown path, including failed launches.
- **Three-valued liveness.** Only a definite `dead` lets reconcile tear a
  stream down. "I could not reach the vendor" is `unknown`.

### Step 3. Register it behind its own switch

In `engines/index.ts`:

```ts
if (process.env.MEDIALIVE_ROLE_ARN) registerEngine(makeMediaLiveEngine());
```

A deployment without the vendor's credentials then never offers it, and the
catalogue entry keeps showing it as planned.

### Step 4. Choose it for a profile

```
PUT /api/engines/profiles/:profileId   {"engine": "medialive", "mode": "encode_only"}
```

The capability check runs first. If the profile asks for something the engine
cannot honour in that mode (captions or DRM in full mode, a rung above its
maximum height, package only on a vendor that cannot take a ready ladder), the
call returns **422 with the list of issues** and nothing changes. The same
check runs again at launch, so a profile edited after assignment cannot slip
through.

### Step 5. Test it

Copy the fake vendor pattern in `test/workflows.check.ts` (`fakeVendor`) for
unit checks, then run one real channel end to end on a test account:

1. Start: vendor channel created, our packager running, binding row written.
2. Kill the vendor input: a `source.down` arrives through the webhook and our
   filler takes over (encode only mode).
3. Stop: vendor channel stopped (check the vendor console), binding closed.
4. Restart the control plane mid-run: auto connect and reconcile behave as for
   a builtin stream.

### Step 6. Flip it to installed

Set `availability: 'installed'` in the adapter's descriptor (the catalogue
entry stays as documentation), update `VOLT_BUILD_STATUS.md` and the feature
tracker in the same session.

## 5. Mapping vendor events to Volt events

Adapters translate vendor signals into the vocabulary our encoder already
speaks (`volt-encoder/bin/events.py`), so the event log, the five health gates,
the console and auto connect need no per-vendor code. The canonical list is
`CANONICAL_EVENTS` in `types.ts`:

`channel.start`, `channel.stop`, `source.up`, `source.down`, `input.error`,
`failover.switch`, `filler.engaged`, `filler.cleared`, `packager.up`,
`packager.down`, `output.degraded`, `output.stalled`, `engine.provisioned`,
`engine.state`, `engine.alert`, `engine.error`.

Sketch of the mapping (confirm names against vendor docs when writing the adapter):

| Vendor signal | Volt event |
|---|---|
| MediaLive state change to RUNNING | `engine.state` (detail.state) |
| MediaLive input loss / input switch alerts (EventBridge) | `source.down`, `failover.switch` |
| MediaLive output or pipeline failure alerts | `engine.alert`, or `channel.stop` with a reason when fatal |
| Bitmovin live encoding status RUNNING / ERROR | `engine.state`, `engine.error` |
| Bitmovin ingest point lost (poll) | `source.down` |
| Wowza incoming stream stats missing for N polls | `source.down` |
| Any vendor: billing resource confirmed created | `engine.provisioned` |

Notes:

- In **encode only** mode our own packager still reports `packager.up/down`,
  `filler.engaged` and the rest itself. The vendor only adds what happens
  upstream of us.
- A vendor's `channel.stop` while Volt thinks the stream is live triggers the
  real teardown with fault intent, exactly as our encoder's does, so auto
  connect still works.
- The webhook route looks the stream up by the vendor's own reference in
  `engine_bindings`. It never trusts a stream id in the body.

## 6. Capability sketch

`true` the engine does it. **volt**: the vendor does not (or we do not use
theirs) and Volt does it downstream, which only works in encode only mode.
**vendor**: the vendor's own implementation, so Volt's guarantees do not apply.
`false` unavailable.

| Capability | Volt built-in | MediaLive | Bitmovin | Wowza |
|---|---|---|---|---|
| Modes | full | encode only, full | encode only, full | encode only |
| Transcode ladder from mezzanine | yes | yes | yes | yes |
| Accept a ready ladder (package only) | yes | no | no | no |
| Video codecs | H.264 | H.264, HEVC | H.264, HEVC, AV1 | H.264, HEVC |
| Max height | 2160 | 2160 | 2160 | 2160 |
| Vendor ingest | SRT, RTMP, HLS, UDP | SRT, RTMP, RTP, HLS, MediaConnect | SRT, RTMP, Zixi | SRT, RTMP, RTSP, WebRTC |
| Return path to Volt | n/a | RTMP or SRT push, CMAF to S3 | CMAF to S3, RTMP push | SRT or RTMP push |
| Input failover | yes | vendor | vendor | volt |
| Slate or loop on input loss | yes | volt | volt | volt |
| Burned-in watermark | yes | vendor | vendor | vendor |
| Live captions and translation | yes | volt | volt | volt |
| SCTE-35 passthrough | yes | yes | vendor | vendor |
| DRM | yes | volt | volt | volt |
| Recording, DVR, clipping, thumbnails, geo slate | yes | volt | volt | volt |
| Pushes events | yes | yes (EventBridge) | partly (webhooks, poll for live health) | no (poll) |
| Cost model | our compute | per channel hour pass-through | per minute pass-through | customer licence or per hour |

Commercially, treat every vendor engine as **pass-through cost plus a
management fee**. It is a premium or compatibility tier, not a replacement for
the built-in engine's margin. `usage()` on the adapter exists so metering can
carry the vendor minutes onto the bill.

## 7. API reference

| Call | Who | Notes |
|---|---|---|
| `GET /api/engines` | any signed-in user | Installed first, then planned, each with `caps` and `todo` |
| `GET /api/engines/:id` | any signed-in user | One descriptor |
| `POST /api/engines/:id/validate` | admin | Body `{profileId}` or `{job}`, optional `mode`. Returns `{ok, issues[]}` |
| `PUT /api/engines/profiles/:profileId` | admin | Body `{engine, mode}`. 422 with issues when it cannot run |
| `POST /api/engine-hooks/:engineId?ref=<externalRef>` | vendor | Raw body, verified by the adapter. 202 `{applied}` |

## 8. Known limits of the hooks today

- No vendor adapter exists yet, so a vendor engine cannot be selected (the
  assign call refuses a planned engine). That is intended.
- The console does not yet have an engine picker on the output profile form.
  The API above is complete, and the picker is a small addition once the first
  adapter lands.
- Dual pipeline vendors (MediaLive standard class) return two feeds. Map them
  to our primary and backup inputs in `packagerJob()` so `source_selector`
  handles the switch.
