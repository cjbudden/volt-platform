---
title: Channel status
sidebar_position: 1
description: What every status on a channel, event or station means, and what to do about it.
---

# Channel status

A channel, event or radio station has **one overall status**: the badge next to its name and in every list. Its page also shows **five gates**, read left to right: **Server, Input, Encoder, Output, On air**. A gate can only be healthy if the ones before it are, so the first gate that is not green is usually where to look.

## Colours

| Colour | Means |
|---|---|
| Green | Working |
| Blue | On its way, or ready |
| Amber | Working, but not right |
| Red | Failed. Needs a person. |
| Grey | Not running. Nothing is wrong. |

## Overall status

| Status | Colour | Means | What to do |
|---|---|---|---|
| **IDLE** | Grey | Never started, or nothing has run yet | Start it when needed |
| **STOPPED** | Grey | Stopped on purpose (Stop, or the schedule), or ended cleanly | Nothing. Errors are not raised until it is started again. |
| **STARTING** | Blue | Started and coming up. A fault in the first moments is given a chance to clear while Volt retries. | Wait. If it lasts, open QC. |
| **READY** | Blue | Producing valid output, still private | Check the output, then **Go on air** |
| **ON AIR** | Green | Public and serving valid content | Nothing |
| **DEGRADED** | Amber | Running but not right: the output stalled for a moment, or the backup source is on air | Watch it. Open QC if it does not clear. |
| **ERROR** | Red | A gate failed. The banner names the gate and the reason. | Choose **Diagnose** to open QC |

## The gates

### Server

The encoder server the stream runs on.

| Word | Colour | Means |
|---|---|---|
| **NO SERVER** / **UNASSIGNED** / **NOT CONNECTED** | Grey | Stopped. No server is working on this stream. |
| **ASSIGNING** | Blue | Started. Being placed on a server and launched. |
| **READY** | Green | Launched, connected and reporting. The lower right shows the encoder's CPU use. |
| **STOPPING** | Blue | Stop issued, shutting down |
| **CONNECTION LOST** | Red | Running, but no report from the encoder for 90 seconds |
| **STOP FAILED** | Red | Stop was issued 45 seconds ago and the encoder is still running |
| **FAILED** | Red | The encoder exited with an error. The reason is shown under the word. |

### Input

Is the source arriving?

| Word | Colour | Means |
|---|---|---|
| **NO SOURCE** | Grey | No source address is set |
| **NOT CONNECTED** | Grey | A source is set, but the stream is not running |
| **CONNECTING** | Blue | Started, waiting for the source to arrive |
| **RECEIVING** | Green | Arriving. The lower right shows data received per second and in total. |
| **DEGRADED** | Amber | One source lost and the backup on air, or the output stalled while the source may have dropped |
| **NO SIGNAL** | Red | Nothing arriving, or every source lost (the slate or loop is on air) |

### Encoder

Transcoding or packaging.

| Word | Colour | Means |
|---|---|---|
| **NOT RUNNING** | Grey | Stopped, or nothing to encode yet |
| **STARTING** | Blue | Coming up |
| **RUNNING** | Green | Working normally |
| **STALLED** | Amber | No new output for a while |
| **STOPPING** | Blue | Stop issued |
| **FAILED** | Red | The encoder failed |

### Output

Is new content being produced?

| Word | Colour | Means |
|---|---|---|
| **NONE** | Grey | Not running |
| **STARTING** | Blue | Waiting for the first content |
| **PRODUCING** | Green | New content arriving on time |
| **STALLED** | Amber | Nothing new for 15 seconds or more |
| **FAILED** | Red | No output because something earlier failed |

### On air

The public URL.

| Word | Colour | Means |
|---|---|---|
| **OFF AIR** | Grey | Not public |
| **WARMING UP** | Blue | Running, output not valid yet |
| **READY (PRIVATE)** | Blue | Output valid, private until you go on air |
| **ON AIR** | Green | Public, serving valid content |
| **ON AIR · NO CONTENT** | Red | Public, but viewers get nothing: the stream is down or not producing |

## Rules worth knowing

- **Stopping on purpose is not an error.** From Stop (or a scheduled stop) until the next Start, nothing that happens during shutdown is reported as a fault. The event log shows "Stop command issued" and "Start command issued" around it. The only error a stop can have is **STOP FAILED**.
- **A fault stop is different.** When a stream stops by itself it shows **ERROR**, and automatic reconnection tries to bring it back if it is turned on.
- **The first moments are forgiven.** A fault just after a start shows as **STARTING** while Volt retries. The reason is kept in the log.
- **Clear QC** (the circular arrow in the channel header) judges the channel afresh. Earlier faults stay in the log, and a fault that is still real comes straight back.
- **A missing reading is not a zero.** CPU and data received are shown only when they are measured.

## Where to look when something is wrong

1. Read the banner under the channel header. It names the failed gate and the reason.
2. Choose **Diagnose** to open QC, which walks the pipeline from server to output.
3. Check **Connection issues and event log** further down the page for what happened and when.
