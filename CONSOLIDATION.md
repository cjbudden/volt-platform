# VOLT Fleet Consolidation

*Review and design, 13 Oct 2026. Planner built and running in advise mode on the fleet pass. The handoff is designed, not built. Placement at launch: see PLACEMENT.md.*

## The question

When several media servers are running well below capacity, can their streams be
combined onto fewer servers to cut running cost, automatically, with no downtime and no
change in quality or experience for the viewer?

Yes, under five rules. These come from your brief and are enforced in code
(`services/fleet/consolidation.ts`):

| Rule | What it means in practice |
|---|---|
| **Multiple** | Nothing moves unless at least two servers in the same class are under the threshold at the same time. One quiet server alone is never touched. |
| **Similar** | Streams only move between servers of the same class: same node group and isolation tier, same purchasing model (Spot or on-demand), same instance family, GPU or CPU, same AZ. A stream never lands on different hardware than it had. |
| **No impact on what is already there** | A target must fit the incoming streams on two counts: the ECS reservation (CPU units, memory, task slots) and the *observed* p95 load. Target p95 plus the incoming streams' own p95 times 1.25 must stay at or under 65%. That is below the 80% sizing ceiling and below the scale-out trigger, so the move cannot cause a scale-out either. |
| **All or none** | A server is only drained if every stream on it can be placed elsewhere. Moving half a server saves nothing and still carries risk. |
| **No downtime** | A stream only moves if it can be handed over without the viewer noticing (see *The move*). Anything else waits for a natural boundary: a restart, a stop, or an event ending. |

Missing telemetry never counts as idle. A server with any gap in its sample window is
neither a candidate nor a target.

## What the review found

The building blocks are already there: the host registry (`compute_hosts`), host and
task telemetry (`host_samples`, CPU, memory, network in and out), placement capture on
every tick, `StopIntent` so the platform can stop a task without disarming auto connect,
and the delivered-playlist splice in `playout.py`, which measured 0 frozen seconds on
HLS and DASH. Six things in the current setup affect consolidation. Four of them would
make a live move unsafe today.

**Blockers for moving a running stream**

1. **Cloud output has no per-run namespace.** In local mode each run writes to
   `runs/<runId>/` and a pointer selects the live one. In cloud mode the encoder
   mirrors straight to `s3://bucket/<kind>/<id>/`. Two encoders for one channel, even
   for a minute, would overwrite each other's `seg_N.m4s` on S3. Cloud has to adopt the
   same `runs/<runId>/` layout before any handoff.
2. **The delivered playlist is written inside the encoder container.**
   `_write_companion` / `playout.py` hold the media sequence, discontinuity sequence and
   PDT shift in process. A new container on another server starts that state from zero,
   which is exactly the media-sequence reset that the 2 Aug stall test identified as the
   cause of stalls. The state has to be handed from the old writer to the new one.
3. **Push ingest is tied to the task.** With `awsvpc`, an SRT or RTMP source pushes to
   the task's own network interface. A new task means a new address, so the source
   would have to be re-pointed. Until there is a stable ingest address (an NLB per
   ingest port, or a small SRT/RTMP relay tier that fans out to two consumers), only
   pull-ingest streams (HLS, DASH, SRT caller, NDI, 2110) can move.
4. **Servers can be removed while a stream is still on them.** Both capacity providers
   set `managed_termination_protection = "DISABLED"` with managed scaling on. When the
   cluster scales in, the Auto Scaling group picks which instance to terminate, and that
   can be one still carrying an encoder. This affects playback today, regardless of
   consolidation. Fix: `ENABLED`, with `protect_from_scale_in = true` on both groups.
   ECS then only removes servers that are empty. That is also what makes consolidation
   simple: we empty a server, and ECS removes it. We never terminate anything ourselves.

**Cost findings**

5. **New streams are not steered onto part-full servers.** `runTaskInput()` sets no
   `placementStrategy`, so a new task can land on a fresh server while others sit half
   empty. Adding `binpack` on memory to RunTask is a one-line change. It prevents most
   fragmentation at the cheapest possible point, launch, and should come first.
6. **Reservations, not usage, cap the density.** The encoder task reserves 2048 CPU
   units and 4096 MiB on a c7i/c6i/c5 `.xlarge` (4 vCPU, 8 GiB), so at most two encoders
   fit on a server however lightly they run. `awsvpc` also caps an `.xlarge` at three
   tasks without ENI trunking. Under those limits consolidation can only merge servers
   that each carry one stream. Bigger savings come from sizing reservations per workflow
   from measured usage (package-only is network-bound and uses a fraction of a
   transcode's CPU), enabling ENI trunking, and offering `.2xlarge` / `c5n` sizes.
   The planner reads real reservations, so it benefits automatically.

## The trigger (built)

`planConsolidation(hosts, policy)` is pure: no database, clock or IO. Each pass:

1. Groups servers into classes (above).
2. Marks a server under-used when its p95 CPU and p95 network are both under 30% over a
   window of at least 30 minutes, with at least 90% sample coverage.
3. Fires for a class only when two or more of its servers are under-used.
4. Takes the emptiest under-used server first and places each stream, largest first,
   on the *fullest* server that still fits (best fit). The fleet ends up with a few
   well-used servers rather than many half-used ones.
5. Rejects the server if any stream cannot be moved invisibly: dedicated tier, push
   ingest, DRM (v1), not fully healthy, on backup or filler, an event ending within 45
   minutes (it frees the server by itself), moved in the last 6 hours, or a
   short-lived job.
6. Drains at most one server per pass, and never drains a server that is receiving
   streams in the same pass.

Every server it looks at and does not drain gets a stated reason, for the fleet screen
and the audit log.

Defaults (all in `DEFAULT_POLICY`):

| Setting | Default |
|---|---|
| Under-used: p95 CPU and p95 network below | 30% |
| Under-used servers needed in one class | 2 |
| Sample window / coverage | 30 min / 90% |
| Target ceiling after the move (p95) | 65% |
| Safety factor on moved streams' load | 1.25 |
| Leave events ending within | 45 min |
| Cooldown before a stream can move again | 6 h |
| Servers drained per pass | 1 |

Tests: `test/consolidation-plan.check.ts`, 28 checks pass, covering each rule above.

The planner uses the same fit test as placement (`capacity.fits()`), but only on a server's *measured* load, never an estimate, because it moves live streams. It runs on every fleet pass in advise mode: the plan, with a reason for every server it leaves alone, goes to `fleet_plans` and `GET /api/platform/fleet-plan`. Nothing is moved.

## The move (designed): make before break

The viewer keeps the same play URL throughout. Every step before cutover can be
abandoned with zero viewer effect, because the old encoder is untouched until the new
one is proven.

1. **Shadow.** Launch an identical encoder on the target server: the same job config,
   so the same ladder, codecs, bitrates, GOP and segment duration. It uses an ECS
   `memberOf` placement constraint pinned to the target's container instance, and writes
   to a new `runs/<runId>/` prefix in **standby**: it packages and uploads segments but
   does not write the delivered playlists. Both encoders pull the same source.
2. **Prove.** Before going further, the shadow must show the same evidence auto connect
   uses to arm a stream (server, input, encoder and output healthy), every rendition
   advancing for at least six segments, and init segments whose codec strings and
   resolutions match the live run exactly. The target's own streams must stay under the
   ceiling with the shadow running. If any of this fails, the shadow is stopped and
   nothing else happens.
3. **Cut over at a segment boundary.** The old writer splices the new run in, using the
   same mechanism as the loop splice: `EXT-X-DISCONTINUITY` plus the new run's
   `EXT-X-MAP`, with continuous `EXT-X-MEDIA-SEQUENCE` and continuous PDT (from the
   encoder's one clock, epoch + tfdt). The join is placed where the new run's first
   segment starts at or after the old run's last segment ends, so no content is
   repeated. On DASH it is a new Period, as `playout.py` already does per run. Subtitles
   take the same shift.
4. **Hand over the pen.** The old writer saves its playlist state (window, sequences,
   PDT shift) to `playout_state.json` under a single-writer lease. The new writer adopts
   it and carries on appending. There is only ever one writer.
5. **Verify, then stop.** Once the delivered playlists list only new-run segments past
   a player's buffer (about three segments), the old task is stopped with a platform
   `StopIntent`. `desired_state` and auto connect stay as they were, and the source
   server is now one stream lighter.
6. **ECS removes the empty server.** With termination protection on, the empty server is
   the only kind that can be scaled in.

**Why the viewer sees nothing.** The URL does not change, the ladder is identical, the
playlist never stops growing and its sequence never resets. The splice is the one
already measured at 0 frozen seconds in Chrome with the console's own hls.js and
dash.js. Two things still need testing before this is switched on: playback on the
real device list (smart TVs and Safari handle a discontinuity differently from hls.js),
and the size of the join on transcode channels. Two transcoders on one source cut on the
same source timestamps, but not always on the same frame. Package-only channels cut on
the source's own keyframes, so their join is exact.

**Also to wire.** The day's recording must stitch both runs into one recording. The
recording index already walks runs, but a recording spanning a handoff needs a test.
The minute or two of overlap should be accrued as platform cost, not billed to the
customer.

## Recommended order

1. **Done (13 Oct):** managed termination protection is on (finding 4), every launch
   binpacks (finding 5), and reservations are sized per stream from its output settings
   (finding 6). See PLACEMENT.md. Terraform validated, not yet applied.
2. **Done (13 Oct):** advisory mode. The planner runs on the fleet tick and its plan and
   reasons are at `/api/platform/fleet-plan`. A Fleet page view of it is still to build.
3. **Next:** calibrate the load model on the Tier-2 cluster, and enable ENI trunking so
   light streams are not capped at three per server.
4. **Then:** build the handoff (blockers 1 and 2) and enable it for pull-ingest,
   non-DRM, shared-tier channels behind a per-pool switch.
5. **Then:** a stable ingest address (blocker 3) to bring push-ingest channels in scope.
