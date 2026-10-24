---
title: Channel status
sidebar_position: 1
description: What every status on a channel, event or station means, and what to do about it.
guide: section
---

# Channel status

A channel, event or radio station has **one overall status**: the badge next to its name and in every list. Its page also shows **five gates**, read left to right: **Server, Input, Encoder, Output, On air**. A gate can only be healthy if the ones before it are, so the first gate that is not green is usually where to look.

![A channel page: the overall status beside the name, the five gates under it, then the source and output players](/img/screens/channel-status.png)

## What it is for

Status tells you, in one word, whether a stream is fine, and when it is not, which part of the pipeline to look at. The same words and colours are used on the channel, event and station pages, in every list, on [Live Streams](live-streams.md), [Monitoring](monitoring.md) and [Multiview](multiview.md).

### Colours

| Colour | Means |
|---|---|
| Green | Working |
| Blue | On its way, or ready |
| Amber | Working, but not right |
| Red | Failed. Needs a person. |
| Grey | Not running. Nothing is wrong. |

## Before you start

- A [channel](channels.md), [radio station](radio.md) or [event](events.md). Status appears once it exists; the gates fill in when it starts.
- Nothing to set up. Volt judges status for you.

## Step by step

### Read the overall status

| Status | Colour | Means | What to do |
|---|---|---|---|
| **IDLE** | Grey | Never started, or nothing has run yet | Start it when needed |
| **STOPPED** | Grey | Stopped on purpose (Stop, or the schedule), or ended cleanly | Nothing. Errors are not raised until it is started again. |
| **STARTING** | Blue | Started and coming up. A fault in the first moments is given a chance to clear while Volt retries. | Wait. If it lasts, open QC. |
| **READY** | Blue | Producing valid output, still private | Check the output, then **Go on air** |
| **ON AIR** | Green | Public and serving valid content | Nothing |
| **DEGRADED** | Amber | Running but not right: the output stalled for a moment, or the backup source is on air | Watch it. Open QC if it does not clear. |
| **ERROR** | Red | A gate failed. The banner names the gate and the reason. | Choose **Diagnose** to open QC |

### Read the gates

Read them left to right: the first gate that is not green is usually where the problem is.

#### Server

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

#### Input

Is the source arriving?

| Word | Colour | Means |
|---|---|---|
| **NO SOURCE** | Grey | No source address is set |
| **NOT CONNECTED** | Grey | A source is set, but the stream is not running |
| **CONNECTING** | Blue | Started, waiting for the source to arrive |
| **AWAITING SOURCE** | Blue | Started, and no source has arrived for 20 seconds or more. The time waited is shown. |
| **RECEIVING** | Green | Arriving. The lower right shows data received per second and in total. |
| **DEGRADED** | Amber | One source lost and the backup on air, or the output stalled while the source may have dropped |
| **NO SIGNAL** | Red | Nothing arriving, or every source lost (the slate or loop is on air) |

#### Encoder

Transcoding or packaging.

| Word | Colour | Means |
|---|---|---|
| **NOT RUNNING** | Grey | Stopped, or nothing to encode yet |
| **STARTING** | Blue | Coming up |
| **RUNNING** | Green | Working normally |
| **STALLED** | Amber | No new output for a while |
| **STOPPING** | Blue | Stop issued |
| **FAILED** | Red | The encoder failed |

#### Output

Is new content being produced?

| Word | Colour | Means |
|---|---|---|
| **NONE** | Grey | Not running |
| **STARTING** | Blue | Waiting for the first content |
| **PRODUCING** | Green | New content arriving on time |
| **STALLED** | Amber | Nothing new for 15 seconds or more |
| **FAILED** | Red | No output because something earlier failed |

#### On air

The public URL.

| Word | Colour | Means |
|---|---|---|
| **OFF AIR** | Grey | Not public |
| **WARMING UP** | Blue | Running, output not valid yet |
| **READY (PRIVATE)** | Blue | Output valid, private until you go on air |
| **ON AIR** | Green | Public, serving valid content |
| **ON AIR · NO CONTENT** | Red | Public, but viewers get nothing: the stream is down or not producing |

### Find what is wrong

1. Read the banner under the channel header. It names the failed gate and the reason.
2. Choose **Diagnose** to open QC, which walks the pipeline from server to output.
3. Check the stream's event log further down the page for what happened and when.
4. When it is fixed, **Clear QC** (the circular arrow in the header) judges the stream afresh.

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | Every stream has this status and these gates on its page |
| [Live Streams](live-streams.md) | One row per running stream, with the same gates |
| [Monitoring](monitoring.md) | Lists the streams whose status is a problem |
| [Input failover](failover.md) | A stream on its backup source shows **DEGRADED** |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See status | View on that kind of stream, or Live and monitoring: View |
| Diagnose and **Clear QC** | Operate on that kind of stream (for example TV channels: Operate) |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

### Rules worth knowing

- **Stopping on purpose is not an error.** From Stop (or a scheduled stop) until the next Start, nothing that happens during shutdown is reported as a fault. The event log shows "Stop command issued" and "Start command issued" around it. The only error a stop can have is **STOP FAILED**.
- **A fault stop is different.** When a stream stops by itself it shows **ERROR**, and automatic reconnection tries to bring it back if it is turned on.
- **The first moments are forgiven.** A fault just after a start shows as **STARTING** while Volt retries. The reason is kept in the log.
- **Clear QC** (the circular arrow in the channel header) judges the channel afresh. Earlier faults stay in the log, and a fault that is still real comes straight back.
- **A missing reading is not a zero.** CPU and data received are shown only when they are measured.

### Common cases

| You see | What it means | What to do |
|---|---|---|
| **STARTING** for minutes, Input **CONNECTING** or **AWAITING SOURCE** | Volt is waiting for the source | Check the sender is sending to the right address, port, stream ID and passphrase |
| Server **CONNECTION LOST** | No report from the encoder for 90 seconds | Wait a minute; if it stays, stop and start the stream |
| **ON AIR · NO CONTENT** | Viewers are given a public URL with nothing behind it | Choose **Diagnose**; take the stream off air if it will take time to fix |
| **DEGRADED** with the backup source on air | The primary failed and failover worked | Fix the primary; see [input failover](failover.md) |

## Through the API

| Request | Answers |
|---|---|
| `GET /api/status` | The status of every stream you can see |
| `GET /api/status/{kind}/{id}` | One stream's overall status and gates |
| `GET /api/status/{kind}/{id}/events` | Its event log |
| `GET /api/status/stream` | Status changes, pushed as they happen (server-sent events) |
| `POST /api/channels/{id}/reset-health` | **Clear QC** for a channel (`/api/events/{id}/reset-health` for an event) |

Every route is in the [API reference](/api-reference).
