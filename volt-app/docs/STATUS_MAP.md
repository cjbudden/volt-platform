# Status map: every status a stream can show, and what it means

One reference for the console, documentation and support. A channel, event
or radio station has **one overall status** (the badge next to its name, and
in every list) and **five gates** on its page, read left to right:
Server, Input, Encoder, Output, On air. A gate can only be healthy if the ones
before it are.

Each gate shows a **word** (what the state means for that gate) and a
**colour** (how serious it is). Code: `services/pipelineHealth.ts`
(`computePipelineHealth`, `applyBadges`), tests `test/stop-intent.check.ts`,
`test/qc-reset.check.ts`, `test/startup-settling.check.ts`.

Colours: **green** working, **blue** on its way or ready, **amber** working
but not right, **red** failed (needs a person), **grey** not running, nothing
wrong.

## 1. Overall status

| Status | Colour | Means | What to do |
|---|---|---|---|
| **IDLE** | grey | Never started, or nothing has run yet | Start it when needed |
| **STOPPED** | grey | Stopped on purpose (Stop, or the schedule), or ended cleanly | Nothing. Errors are not raised until it is started again |
| **STARTING** | blue | Started and coming up, or a fault in the first moments is being given a chance to clear (auto connect retries it) | Wait. If it lasts, open QC |
| **READY** | blue | Producing valid output, private: not on air | Check the output, then Go on air |
| **ON AIR** | green | Public and serving valid content | Nothing |
| **DEGRADED** | amber | Running but not right: output stalled for a moment, or on the backup source | Watch it; open QC if it does not clear |
| **ERROR** | red | A gate failed. The banner names the gate and the reason | Open QC (Diagnose) |

## 2. The gates

### Server: the encoder server this stream runs on

| Word | Colour | Means |
|---|---|---|
| **NO SERVER** | grey | Stopped. No encoder server is running at all; one starts when a stream starts (costs nothing meanwhile) |
| **UNASSIGNED** | grey | Stopped. A shared pool of servers is running, but none is assigned to this stream |
| **NOT CONNECTED** | grey | Stopped. One server runs everything (a single-server deployment); it is up, this stream is not running on it |
| **ASSIGNING** | blue | Started: being placed on a server and launched |
| **READY** | green | Assigned, launched, stream connected and reporting. Billable (the amber dot, top right of the box, marks the billed gate; hover it). The lower right shows the encoder's CPU (or the whole server's, marked "host CPU", where the encoder cannot measure itself) |
| **STOPPING** | blue | Stop issued; the encoder is shutting down |
| **CONNECTION LOST** | red | Running, but no report from the encoder for 90 s: the server or the link to it is gone |
| **STOP FAILED** | red | Stop issued 45 s ago and the encoder is still running |
| **FAILED** | red | The encoder exited with an error (the reason is under the word) |

### Input: is the source arriving?

| Word | Colour | Means |
|---|---|---|
| **NO SOURCE** | grey | No input address configured |
| **NOT CONNECTED** | grey | A source is configured; the stream is not running, so nothing is pulled |
| **CONNECTING** | blue | Started; waiting for the source to arrive |
| **RECEIVING** | green | Arriving. The lower right shows data received per second and in total since the start |
| **DEGRADED** | amber | One source lost and the backup on air, or the output stalled while the source may have dropped |
| **NO SIGNAL** | red | Nothing arriving, or every source lost (the slate or loop is on air) |

### Encoder: transcoding or packaging

| Word | Colour | Means |
|---|---|---|
| **NOT RUNNING** | grey | Stopped, or nothing to encode yet |
| **STARTING** | blue | Encoder and packager coming up |
| **RUNNING** | green | Transcoding or packaging; packager healthy |
| **STALLED** | amber | No new segments for a while |
| **STOPPING** | blue | Stop issued |
| **FAILED** | red | Encoder or packager failed |

### Output: segments being written

| Word | Colour | Means |
|---|---|---|
| **NONE** | grey | Not running |
| **STARTING** | blue | Waiting for the first segments |
| **PRODUCING** | green | New segments arriving on time |
| **STALLED** | amber | No new segments for 15 s or more |
| **FAILED** | red | No output because the pipeline failed |

### On air: the public URL

| Word | Colour | Means |
|---|---|---|
| **OFF AIR** | grey | Not public |
| **WARMING UP** | blue | Running, output not valid yet |
| **READY (PRIVATE)** | blue | Output valid; private until Go on air |
| **ON AIR** | green | Public, serving valid content |
| **ON AIR · NO CONTENT** | red | Public, but viewers get nothing: the stream is down or not producing |

## 3. Rules behind the words

* **Stopped on purpose is not an error.** From Stop (or a scheduled stop)
  until the next Start, whatever the shutdown throws off (a relay killed
  mid-read, a packager exiting non-zero) is not reported as a fault. The log
  shows "Stop command issued" and "Start command issued" around it. The only
  error a stop can have is STOP FAILED.
* **A fault stop is different.** When a stream dies by itself it reads ERROR,
  and auto connect tries to bring it back.
* **The first moments are forgiven.** A fault in the settling window just after
  a start shows as STARTING while auto connect retries; the reason is kept.
* **Clear QC** (the circular arrow in the header) starts the judgement afresh:
  earlier faults stay in the log, a fault that is still real comes straight back.
* **A missing reading is not a zero.** CPU and data received appear only when
  measured; nothing is shown rather than a made-up 0.

## 4. Readings on the gates

| Where | Reading | From |
|---|---|---|
| Server, lower right | `CPU 38%`: the encoder's own processes, as a share of the CPU it may use | The encoder's heartbeat (every 10 s), read from the kernel's process accounting |
| Server, lower right | `host CPU 61%`: the whole server | The fleet sampler, where the encoder cannot measure itself (a Mac running it natively) |
| Input, lower right | `2.7 Mbps · 1.24 GB`: received now, and since the start | Each relay's own progress counter (packaging, and any channel with a backup); for a transcode reading its source directly, the encoder container's network counter (all inputs together) |
| Output & source status card | the same per input | as above |
