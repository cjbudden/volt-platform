# Encoding queue

Media > **Encoding Queue** in the console (`/encode-jobs`) shows the VOD encode jobs (`vod.encode`): what is
encoding now, what is waiting and in which order, and what finished recently. Each job opens a detail view
(`/encode-jobs/:id`) with its outputs, the encoder's log and its attempts. The asset's Encode tab links to it
(**Encode job and log**).

## The queue

| Section | What it shows |
|---|---|
| Encoding now | Running jobs with progress, the stage (`encoding 1080p 720p: 41% at 3.2x`, `packaging HLS and DASH`, `building the sprite sheets`) and the time so far |
| Waiting | Queued jobs in the order a worker takes them (priority, run_after, created_at, as `queue.ts` claims). The place counts every account's encodes ahead, because the workers are shared; only the account's own jobs are listed. A job waiting to retry after an error says when |
| Finished recently | The last 50 done, failed or cancelled, with the ladder summary or the error, and how long it took. Retry on failed and cancelled |

Polls every 3 s while anything is running or waiting, every 15 s otherwise.

## One job

* **Progress** and timing: queued, started, running for or took, attempts, the worker.
* **Outputs**, each with a state (done, writing, waiting, failed, skipped, missing):
  * every rendition (and the audio) with resolution, bitrate, codec, segment count and size, read from the
    disk while it is written, so a running encode shows its renditions filling up
  * HLS (`master.m3u8`) and DASH (`manifest.mpd`)
  * **thumbnails**: the candidate stills and whether the asset image was chosen
  * **sprite sheets**: sheets, hover previews and the interval
  * the jobs the encode queued after it: asset image, skip markers, social formats tracking
* **Encoder log**, tailed every 2 s while the job runs: the handler's steps (source, probe, ladder, packaging,
  thumbnails, sprites), the encoder's own output, and any step that failed without failing the encode. Filter to
  steps only, copy, download.
* **Attempts**, with each one's outcome and error.

## Job logs

`job_logs` (migration 0088) holds what a job printed, in the database so any server can show it while the job
runs. `services/jobs/jobLog.ts` writes it in batches. Encoder progress lines are thinned to one per 5% (the job's
progress has the rest). A job keeps at most 4000 lines: past that, only the last 200 are kept, behind a note,
because the last lines are the ones that say why an encode failed. A retry appends under its attempt number. The
log is deleted with its job.

Thumbnail and sprite failures used to go to the server console only. Each is now its own step: a failure is in
the log and in the job's `result.outputs`, and the next step still runs.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/jobs/encode-queue?recent=50` | `{ running, queued (with position), recent, platformBacklog }` |
| GET | `/api/jobs/:id/log?after=<seq>&limit=` | Log lines after a seq, for tailing |
| GET | `/api/jobs/:id/outputs` | Renditions, manifests, thumbnails, sprites, follow-on jobs (vod.encode only) |
| GET | `/api/jobs/:id` | The job and its attempts (existing) |
| POST | `/api/jobs/:id/retry`, `/api/jobs/:id/cancel` | (existing) |

All need the `media` permission (Files, uploads & storage), like the rest of `/api/jobs`.

## Checks

`test/job-log.check.ts` (the log writer against Postgres). The queue, log and outputs queries were run against a
fully migrated database with two accounts.
