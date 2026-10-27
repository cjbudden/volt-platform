# VOLT Stream Sizing and Placement

*Built 13 Oct 2026. Code: `volt-app/src/services/fleet/`. Migration `0045`. Terraform `ecs_capacity_large.tf`.*

## What it does

Running cost is set by how many servers are up. So every time a stream starts, Volt works
out what it will cost to run and puts it where it costs least, without the person
starting it ever seeing a CPU figure or an instance type.

1. **Size.** The load is worked out from the exact encoder job the stream is about to
   run: CPU, GPU, memory, network in and network out.
2. **Place.** The stream goes on the *fullest* running server that can take it without
   the streams already there noticing. Only when none can is a new server started, from
   the smallest pool that holds it.
3. **Reserve.** ECS is asked to reserve exactly that load plus 30% headroom, instead of
   the same half-server for every stream.
4. **Learn.** Once enough runs with the same settings have been measured, the
   measurement replaces the estimate.
5. **Tell people what matters.** Customers see *Running*, *Starting a server for this
   stream*, or a warning with a fix they can act on.

Placement never blocks a start. If anything in it fails, the stream launches exactly the
way it did before, and the reason is recorded.

## What drives the load

| Setting | Effect on load |
|---|---|
| Transcode | Decode the source once, then scale and encode every rung. Cost follows output pixels per second, so more rungs, higher resolution and higher frame rate all cost more. |
| Packaging only | No decode or encode. Relay, segment and upload each rendition. Light on CPU, heavy on network in *and* out. |
| GPU (NVENC) | Encode moves onto a GPU, leaving the CPU a little glue work. The stream needs a GPU server and reserves one GPU. |
| Watermark | An overlay per rung on transcode. On packaging-only it is not burned in at all, so it costs nothing, and the channel page says so. |
| Captions (Gladia) | Runs inside the encoder: a little CPU plus an upstream audio feed. |
| Captions (Whisper) | Its own GPU task, sized and placed separately. |
| Backup source | Every candidate source runs all the time (FAILOVER.md), so a backup doubles ingest. |
| DRM | Encryption on the way out. Small, counted anyway. |

Worked examples from the model (starting estimates, before calibration):

| Stream | CPU | Network in / out | Reservation | Server |
|---|---|---|---|---|
| Package-only, 3 renditions (9.5 Mbps) | about 0.6 vCPU | 9.5 / 10.1 Mbps | 0.9 vCPU | small, shared |
| Transcode, 1080/720/480/360 x264 at 25 fps | about 4.6 vCPU | 8 / 10.9 Mbps | 6 vCPU | large |

The second row is a finding in its own right: every encoder is currently given 2 vCPU,
so a full x264 ladder has been running well under-powered. On a busy source that shows
up as dropped frames.

The coefficients live in one table (`K` in `streamLoad.ts`), are deliberately
conservative (x264 *veryfast*, the preset the encoder uses), and are replaced by
measurement over time. A history only counts once it has 3 runs and 2 hours, it is read
from servers that were carrying that one stream alone (so the server reading *is* the
stream reading), and it can never shrink a stream below half its estimate. That stops a
run that sat on a slate for an hour from teaching the model that a ladder is free.

## Learning from every run (build queue 2.4a)

Per-signature history only helps a ladder that has already run three times, so a new
ladder used to be sized from the constants however wrong they had proved elsewhere.
Now the model also learns from **all** runs (`services/fleet/loadFit.ts`, read by
`loadLearning.ts`):

- Every estimate line carries a **component** (`encode:x264`, `encode:nvenc`,
  `decode:h264`, `decode:hevc`, `decode:gpu`, `ingest`, `audio`, `package`, `drm`,
  `graphics`, captions). Resolution and frame rate enter through output pixels per
  second, bitrate through the ingest and packaging lines.
- For every run of the last 30 days measured alone on its server, the estimate's lines
  (stored at launch, unfitted, in `placement_decision.baseLines`) are set against the
  measured p95 CPU, and a **multiplier per component** is fitted by least squares,
  pulled towards 1 with the weight of three runs, per instance family (c7i, c6i, c5,
  g4dn...) when the family has at least five runs and from all families together
  otherwise. Network gets one multiplier on in plus out.
- **Guards:** runs far off the fit (more than 4 median absolute deviations on the log
  ratio) are set aside and the fit is repeated until that set is stable; every
  multiplier is clamped between 0.5x and 2x; a run counts at most 24 hours.
- At a start the fit for the family placement prefers (the first type of the first
  shared pool) is applied before the per-signature calibration, and the basis reads
  `fitted`. The fit is cached for ten minutes. `FLEET_LEARN=false` turns it off.

## Storage, and the task disk

Every estimate now projects storage from the bitrates (`storageProjection.ts`):
bytes per hour written to the task disk and to S3 (every rendition, the audio
tracks and the container overhead), and what S3 holds at steady state under the
recording retention (null when the run is kept until deleted). It is stored at
launch in `placement_decision.storage`.

**Finding.** On AWS the packager keeps the whole run on the task disk
(`--preserved_segments_outside_live_window 0`) while the sidecar mirrors it to S3, and
the launch template sets no root volume size, so the ECS AMI's 30 GiB root is shared
by every encoder on the server. A 4-rung 1080p ladder writes about 4.6 GiB an hour,
so it fills that disk in about six hours whatever server it is on.

Placement can now refuse a server whose task disk would run short: what each stream
on it will have written by the end of the horizon (`FLEET_DISK_HORIZON_HOURS`, 24;
a running event's own window when shorter), plus the new stream's share, must stay under
85 % of `FLEET_TASK_DISK_GIB`. The check is **off until that is set**, because with
today's encoder it would correctly refuse every full HD ladder on every server. Build
queue 2.4c bounds the encoder's local copy and sizes the volume, and then turns it on.

## Projection against actual

`GET /api/platform/fleet-plan` now also returns `loadModel` (the multipliers per
component and family, runs used and set aside, median error before and after) and
`projection`: per class of work (transcode, package-only, radio, captions), the
median actual/projected ratio, the median absolute error and the share of runs
under-projected by more than 10 %, for CPU, network and storage (bytes the server
sent per hour, which on an encoder host is what the uploader stored).

## Which server

The same fit test (`capacity.fits()`) is used here and by consolidation, so the two can
never disagree about what "fits" means. A server can take a stream only if **all** of
these hold:

- a free task slot (with `awsvpc`, ENIs minus one)
- the CPU, memory and GPU reservations fit
- CPU **and** network, after adding the stream's load times 1.25, stay at or under 65%

Among the servers that pass, the fullest wins. Eligibility comes from the stream and the
account plan, never from the person starting it:

- **GPU.** NVENC streams and the Whisper add-on only go to GPU servers, and CPU work
  never takes a GPU server, because a GPU server costs several times as much.
- **Isolation.** A dedicated-tier account only lands in its own pool, and a shared
  account never lands in someone else's.
- **Spot.** 24/7 channels run on on-demand servers. A Spot reclaim gives two minutes'
  notice, and today a restart is a visible interruption. Events, radio and thumbnails
  prefer Spot and fall back to on-demand.

A server that booted a few minutes ago has no full telemetry window yet. Placement still
fills it, using the stored estimates of what is already on it. Otherwise every start in a
busy hour would get its own new server. Each launch writes its estimate and chosen
server onto the instance row at once, so two starts a second apart see each other.

When nothing running fits, the stream goes to the smallest pool whose *every* instance
type holds it (an Auto Scaling group can launch any of its types). For a new, empty
server the test is the 80% sizing ceiling with no safety factor, since there are no
neighbours to protect.

## How it reaches ECS

`EcsTaskLauncher.runTaskInput` now:

- binpacks every task on CPU, so ECS fills running servers before scaling out
- sets task-level `cpu` and `memory` overrides from the reservation
- launches into the one capacity provider placement chose
- pins to the chosen server with `memberOf` on `ec2InstanceId`, and retries once unpinned
  in the same pool if that server filled up in the meantime
- reserves a GPU through `resourceRequirements` when the stream needs one

## Infrastructure

`ecs_capacity_large.tf` adds Spot and on-demand pools of `c7i/c6i/c5.2xlarge`. Both
start at zero servers and cost nothing until a stream needs them. Managed termination
protection is now **enabled** on every pool, with `protect_from_scale_in`. Before, it
was disabled, which let a scale-in pick a server still carrying a live stream. Now only
an empty server can be removed, which is also what makes consolidation safe: Volt
empties a server and ECS removes it.

`terraform validate` passes. The changes have not been applied to any environment.

## What people see

The channel page's billing strip no longer shows an instance type. It shows
**Server: Running** (or *Starting*, or *Starting a server for this stream*), with the
detail on hover. When something is wrong, a box says what and how to fix it:

| Situation | What the person is told |
|---|---|
| Settings need more than any one server provides | Remove the highest rendition or lower the frame rate, or switch to GPU encoding |
| GPU encoding chosen, no GPU servers on this deployment | Switch the profile to standard (CPU) encoding, or contact support |
| Dedicated plan, dedicated servers not set up | Ours to fix. Started on shared capacity meanwhile, contact support |
| A new server has not come up after 10 minutes | Ours to fix, and restarting will not speed it up |

The full reasoning (estimate lines, reservation, every server considered and why it
was or wasn't chosen) is for the platform team, at `/api/platform/fleet-plan`.

## Settings

All optional. With none set, placement is on for the ECS launcher, consolidation is in
advise mode, and nothing can move a running stream.

| Variable | Default | Meaning |
|---|---|---|
| `FLEET_PLACEMENT` | on with ECS | Choose a server per stream |
| `ECS_ONDEMAND_LARGE_PROVIDER`, `ECS_SPOT_LARGE_PROVIDER` | set by Terraform | Large pools. Without them, a ladder too big for a small server launches as before and the channel shows a warning |
| `ECS_GPU_PROVIDER`, `FLEET_GPU_TYPES` | none | GPU pool |
| `FLEET_DEDICATED_POOLS`, `FLEET_DEDICATED_TIERS` | none, `dedicated` | Per-account dedicated pools, and which plan tiers use them |
| `FLEET_SPOT_FOR_CHANNELS` | false | Allow 24/7 channels on Spot |
| `FLEET_CEILING`, `FLEET_SAFETY_FACTOR`, `FLEET_SOLO_CEILING` | 0.65, 1.25, 0.8 | Fit test |
| `FLEET_TASK_SLOTS` | ENIs minus 1 | Tasks per server once ENI trunking is enabled |
| `FLEET_LEARN` | true | Learn the load model's coefficients from every measured run |
| `FLEET_TASK_DISK_GIB` | not set (disk not checked) | Task disk per encoder server; turns on the disk check |
| `FLEET_DISK_HORIZON_HOURS` | 24 | How far ahead the disk check looks |
| `FLEET_CONSOLIDATE` | advise | `off` or `advise`. `act` is refused until the handoff exists |

## Checks

| Suite | Checks | Needs |
|---|---|---|
| `test/stream-load.check.ts` | 31 | nothing |
| `test/placement-planner.check.ts` | 26 | nothing |
| `test/consolidation-plan.check.ts` | 28 | nothing |
| `test/server-status.check.ts` | 10 | nothing |
| `test/placement-e2e.check.ts` | 21 | Postgres with migrations applied |
| `test/load-fit.check.ts` | 47 | nothing |
| `test/load-learning.check.ts` | 22 | Postgres with migrations applied |

The existing orchestrator, auto-connect, captions-orchestration, crash-loop and
relay-fleet suites still pass with these changes.

## Still to do

- **Real runs for the learning.** The fit is tested on synthetic histories; it starts
  correcting real coefficients once the Tier-2 cluster has runs measured alone on a
  server. Event windows are not yet passed to the disk check (it uses the horizon).
- **The task disk (2.4c):** keep only a short window on the task disk, size the root
  volume, then set `FLEET_TASK_DISK_GIB`.
- **Enable ENI trunking.** Without it a server carries at most three tasks however light
  they are, and that, not CPU, caps how many package-only channels share a server.
- **GPU sharing.** ECS reserves a whole GPU per task, so one NVENC stream occupies a
  GPU server. Sharing a GPU between tasks would need the NVIDIA runtime configured on
  the host instead of an ECS GPU reservation.
- **The consolidation handoff** (CONSOLIDATION.md), so that advice can be acted on.
