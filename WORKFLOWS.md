# Workflows and add-on services

Volt's base workflow (ingest, encode, package, deliver, record, clip, QC,
review, publish) now fires **hooks** at real stage boundaries. An **add-on
service** is an external platform (an AI agent, a transcription house, a QC
vendor, a social cutter) that Volt sends work to when a hook fires, or when an
operator sends something by hand. Every run is tracked and shown on the
**Workflows** page in the console, which also traces where any recording or
asset has got to.

Status (12 Oct 2026): built and tested end to end (`test/workflows.check.ts`,
with the encoder engine checks, 72 passing). Console page at `/workflows`, with
a **Send to add-on** button on the recording page.

Design rule: add-ons are **side branches**. They never block or fail the base
workflow. A broken endpoint, a slow agent or a database hiccup in the hook bus
cannot stop a recording closing or a clip being cut.

## 1. The pieces

| Piece | Where | What |
|---|---|---|
| Base workflow map | `volt-app/src/services/workflows/map.ts` | Lanes, stages, edges and hooks as data. The dashboard draws it, and the hook bus refuses hooks not declared here |
| Hook bus | `services/workflows/hooks.ts` | `fireHook()` (fire-and-forget, used in the media path) and `emitHook()`. Writes `workflow_events`, starts runs for matching triggers |
| Runs | `services/workflows/runs.ts` | Create, dispatch through the durable job queue, signing, callback state machine, cancel, timeouts, the built-in demo agent |
| Subjects | `services/workflows/subjects.ts` | Resolves a recording, asset, channel or event to its account, title and media links |
| API | `modules/workflows.ts` | `/api/workflows` (operators), `/api/addons` (admins), `/api/addon-callbacks` (public, per-run token) |
| Schema | migration `0044` | `workflow_events`, `addon_services`, `addon_triggers`, `addon_runs`, `addon_run_events` |
| Console | `volt-web/src/pages/Workflows.tsx` | Map, Runs, Add-ons and triggers, run drawer, `SendToAddon` |

## 2. Hooks

| Hook | Stage | About | Fired from | Live |
|---|---|---|---|---|
| `stream.started` | Encode | channel or event | `orchestrator/service.ts`, after the start's bookkeeping commits | yes |
| `stream.stopped` | Encode | channel or event | `stopStream`, with `intent` (operator, schedule, fault, internal) | yes |
| `recording.completed` | Record | recording | `finalizeRecording` (event end, channel stop, UTC day roll) | yes |
| `clip.ready` | Clip | asset | `jobs/handlers/clipExtract.ts` | yes |
| `qc.completed` | QC | asset | `jobs/handlers/qcRun.ts`, with `state` | yes |
| `review.decided` | Review | asset | `review.ts decide()`, with `from`, `to`, `overrodeQc` | yes |
| `vod.encoded` | Encode (file) | asset | `jobs/handlers/vodEncode.ts` | yes |
| `upload.received` | Upload | asset | not yet | planned |
| `publication.published` | Publish | asset | not yet | planned |

Adding a hook: declare it in `map.ts` (with `live: false` until something
fires it), then call `fireHook('<id>', '<subjectType>', id, {detail})` at the
point in the code where the stage really finishes. Fire it after the work is
committed, never before, so an add-on never hears about something that was
rolled back.

## 3. Add-on services and triggers

An add-on service has a name, category (`ai_agent`, `transcription`, `qc`,
`metadata`, `distribution`, `other`), kind (`webhook` or the built-in `demo`),
an endpoint URL (https, or http for localhost while developing), the subject
types it **accepts**, optional step labels, a timeout and a retry count. Its
**signing secret** is shown once at creation and can be rotated.

A **trigger** attaches an add-on to a hook: "when `recording.completed` fires
for RTM News 24, run Newsroom AI". The filter can name channels, events or
groups. An empty filter means every stream in the account. Triggers carry
`options`, passed to the add-on untouched (a prompt, a language, a house
style id).

An operator can also **send by hand**: the recording page's *Send to add-on*
button, or `POST /api/workflows/runs`. Hand runs show as `hook: manual`.

## 4. The contract an add-on implements

### 4.1 Volt calls the add-on

`POST <endpoint_url>`, `content-type: application/json`, headers:

| Header | Value |
|---|---|
| `X-Volt-Event` | `run.dispatch`, `run.cancel` or `ping` |
| `X-Volt-Run` | the run id |
| `X-Volt-Delivery` | unique per attempt (for idempotency on the add-on side) |
| `X-Volt-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the signing secret>` |

Body of `run.dispatch`:

```json
{
  "type": "run.dispatch",
  "version": 1,
  "run": {
    "id": "a7d3…",
    "hook": "recording.completed",
    "deadline": "2026-10-12T12:18:27Z",
    "callbackUrl": "https://volt.example.com/api/addon-callbacks/runs/a7d3…",
    "callbackToken": "vrt_…"
  },
  "addon":   { "id": "cfb0…", "name": "Newsroom AI" },
  "account": { "id": "3de2…" },
  "subject": {
    "type": "recording", "id": "5b0c…", "title": "RTM News 24 · 11 Oct",
    "channelId": "ae0e…", "eventId": null, "durationMs": 1800000,
    "media": { "hls": "https://…/api/recordings/5b0c…/range/master.m3u8?from=…&to=…", "auth": "account_key",
               "startEpochMs": 1760180400000, "endEpochMs": 1760182200000 },
    "apiUrl": "https://…/api/recordings/5b0c…"
  },
  "options": { "prompt": "summarise", "hook": { "durationMs": 1800000 } }
}
```

The add-on answers **2xx quickly** (do the work asynchronously). It may reply
with JSON to set things up front:

```json
{ "externalRef": "nx-2ae37b", "steps": ["Fetch media", "Speech to text", "Summary", "Deliver"] }
```

Retry behaviour: a network error, timeout (15 s), 408, 429 or 5xx is retried
with the job queue's backoff, up to the add-on's `max_attempts`. Any other 4xx
fails the run at once, because a retry cannot fix it. Every attempt is in the
run's event log.

Verifying the signature (Node):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret, header, rawBody, toleranceSec = 300) {
  const p = Object.fromEntries(header.split(',').map(s => s.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(p.t)) > toleranceSec) return false;
  const want = createHmac('sha256', secret).update(`${p.t}.${rawBody}`).digest();
  const got = Buffer.from(p.v1 ?? '', 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}
```

Python:

```python
import hmac, hashlib, time
def verify(secret: str, header: str, raw: bytes, tolerance=300) -> bool:
    p = dict(kv.split('=', 1) for kv in header.split(','))
    if abs(time.time() - int(p['t'])) > tolerance: return False
    want = hmac.new(secret.encode(), f"{p['t']}.".encode() + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, p.get('v1', ''))
```

### 4.2 The add-on reports back

`POST run.callbackUrl` with `Authorization: Bearer <run.callbackToken>`. Any
subset of:

```json
{ "progress": 40, "step": "Speech to text", "message": "optional log line",
  "state": "running | succeeded | failed",
  "externalRef": "…", "steps": ["…"], "result": { }, "error": "…" }
```

- Progress or a step alone moves the run to `running`.
- `succeeded` sets progress to 100 and stores `result` (up to 256 KB: store
  anything bigger and return a link).
- `failed` stores `error`.
- The token is valid for **that run only**. A wrong token is 401.
- Once a run is final (`succeeded`, `failed`, `cancelled`, `timed_out`), later
  callbacks get 409 and are logged on the run, not applied.

### 4.3 States

```
queued -> dispatched -> running -> succeeded
   \          \            \----> failed
    \          \----------------> cancelled (operator) | timed_out (deadline)
```

The deadline is `created + timeout_sec`. A sweeper marks overdue runs
`timed_out` every minute. Cancel sends a signed `run.cancel` to the endpoint,
best effort, so the vendor can stop spending.

## 5. The dashboard

`/workflows` in the console (Overview, Workflows):

- **Map.** Three lanes (Live, Post-production, File ingest). Each stage shows
  its hooks underneath, each hook shows the add-ons attached to it with badges
  for running and failed runs. Dashed hooks are planned. Click a hook to see
  what it carries, who is attached, and to attach an add-on (admins).
- **Trace.** From any run (*Show on map*), any stage activity row (*trace*), or
  `/workflows/trace/recording/<id>`: the stages the subject has been through
  light up, upstream stages are implied, the current stage is outlined, and the
  add-on chips show that subject's runs with live progress.
- **In flight / Recently finished / Stage activity.** Live run cards with a
  step tracker and progress bar, and the feed of hooks as they fire.
- **Runs.** Every run, filterable, opening the run drawer: details, vendor
  reference, step tracker, result (summary and chapters rendered, raw JSON on
  demand), event log, Cancel or Run again.
- **Add-ons and triggers.** Service cards with Test (signed ping), Edit, New
  secret, Delete (two presses), on/off, and the trigger list.

The page polls every 4 seconds while the tab is visible. Moving it onto the
existing SSE stream (the hub already publishes an `addon` event on every run
change) is a small follow-up shared with the Monitoring page.

## 6. Example: send recordings to an AI agent

1. Admin, *Add-ons and triggers*, *New add-on*: External service, name
   "Newsroom AI", category AI agent, endpoint `https://agent.example.com/volt`,
   accepts Recordings and Assets. Copy the secret into the agent.
2. *Test* sends a signed ping. Green means it is reachable and verifies.
3. Map, click *Record → Completed*, attach Newsroom AI, optionally only for
   RTM News 24.
4. When the next recording closes, the run appears under *In flight* and on
   the Record stage's chip, moving through the agent's steps. The result
   (summary, topics, chapters) is on the run.
5. Or open any recording and use *Send to add-on* to do it by hand.

To try it with nothing external, create a *Demo agent (simulated)* add-on. It
runs inside Volt, walks five steps in about fifteen seconds and returns a
labelled sample result.

## 7. API reference

| Call | Role | Notes |
|---|---|---|
| `GET /api/workflows/map` | any | Lanes, stages, edges, hooks with triggers, 24h fired counts and run counts |
| `GET /api/workflows/runs` | any | `?state&addonId&subjectType&subjectId&open=1&limit` |
| `GET /api/workflows/runs/:id` | any | Run, result, options, event log |
| `POST /api/workflows/runs` | operator | `{addonId, subjectType: recording or vod_asset, subjectId, options?}` |
| `POST /api/workflows/runs/:id/cancel` | operator | |
| `POST /api/workflows/runs/:id/retry` | operator | New run, same add-on, subject and options |
| `GET /api/workflows/trace` | any | `?subjectType&subjectId`. Includes the recording's assets, or the asset's recording |
| `GET /api/workflows/events` | any | Recent hook events |
| `GET /api/addons` | any (read) | Never returns secrets |
| `POST /api/addons` | admin | Returns `signingSecret` once |
| `PATCH`, `DELETE /api/addons/:id` | admin | Deleting removes its runs and triggers |
| `POST /api/addons/:id/rotate-secret` | admin | |
| `POST /api/addons/:id/test` | admin | Signed `ping` |
| `GET`, `POST /api/addons/triggers` | admin (read open) | Trigger must name a declared hook the add-on can accept |
| `PATCH`, `DELETE /api/addons/triggers/:id` | admin | |
| `POST /api/addon-callbacks/runs/:id` | add-on | Bearer per-run token |

## 8. Known limits and what comes next

- **Media access for recordings.** The recording link in the payload is the
  console's range manifest, which needs an account key (`sk_live…`). Assets
  use the public origin. Next: a short-lived, run-scoped media token so an
  add-on can fetch exactly that subject's media with the callback token alone.
- **Results are stored, not yet written back.** Next: result handlers per
  add-on, for example merge `result.metadata` into the asset's metadata,
  turn `result.chapters` into timed metadata markers, attach a transcript as
  a caption track, or create a clip from a returned range.
- **Blocking steps (gates).** Today every add-on is a side branch. The next
  step for "alternate workflow" control is a trigger `mode: gate` on chosen
  hooks, for example *publish waits for Subtitle QC to succeed*, using the
  same run state machine. This needs a decision on what happens on failure
  and timeout per gate, so it is deliberately not guessed at here.
- **Engine-related hooks.** Vendor encode engines (see `ENGINES.md`) feed the
  stream event log, not the workflow hooks. `stream.started` carries the
  engine id so an add-on can tell them apart.
