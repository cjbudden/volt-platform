---
title: Workflows
sidebar_position: 9.5
description: See the path every stream, recording and file follows, attach add-on services to its hooks and follow each run.
guide: section
---

# Workflows

Workflows shows the path every channel, recording and uploaded file follows through Volt, the **hooks** along that path where outside services can join in, and where each piece of work is right now. Most people come here to connect an **add-on service**, such as an AI agent that summarises recordings, a transcription house or a QC vendor, so that it runs on its own when, for example, a recording completes.

![The Workflows page: the counts of runs, the Map, Runs and Add-ons and triggers tabs, and the pipeline map with its three lanes, stages and hooks](/img/screens/workflows.png)

## What it is for

- **The map.** The pipeline in three lanes: **Live** (Source, Encode, Package, Deliver, Record), **Post-production** (Thumbnails, Clip, QC, Review, Publish) and **File ingest** (Upload, Ingest rules, Encode). Hover over a stage to read what it does.
- **Hooks.** Moments along the way when Volt can call an add-on:

  | Hook | On the stage | Fires when |
  |---|---|---|
  | **Stream started** | Encode | A channel or event goes live |
  | **Stream stopped** | Encode | A run ends, by an operator, the schedule or a fault |
  | **Recording completed** | Record | A recording closes (the end of an event, a channel stop, or the end of the day) |
  | **Clip ready** | Clip | A clip or full-event video finishes and can be played |
  | **QC completed** | QC | Automatic QC finishes |
  | **Review decided** | Review | A reviewer approves, rejects or asks for changes |
  | **VOD encoded** | Encode (file ingest) | An uploaded file finishes encoding and packaging |
  | **Published**, **Upload received** | Publish, Upload | Planned: shown on the map but not fired yet |

- **Add-on services and triggers.** An add-on is an outside platform Volt sends work to. A trigger attaches it to a hook, for every channel and event or only some.
- **Runs.** Every piece of work sent to an add-on, with its progress, steps, result and log, whether a hook started it or someone sent it by hand.
- **Tracing.** Pick a recording and the map lights up the stages it has passed and outlines the one it is at.

Administrators set up add-ons and triggers; operators and producers follow runs and trace recordings.

## Before you start

- For a real service: its address (it must start with https) and a person on its side who can store the signing secret Volt gives you. To try the flow first, use the built-in **Demo agent (simulated)**.
- **Account settings: Manage** to create add-ons and attach them; **Account settings: Operate** to cancel a run, run it again or send a recording by hand (see [Who can do it](#who-can-do-it)).

## Step by step

### Read the page

1. Open **Admin** and choose **Workflows**.
2. Along the top: **Running now**, **Completed, 24h**, **Failed or timed out, 24h** and **Hooks fired, 24h**.
3. The **Map** tab shows the pipeline. Under each stage are its hooks, by a short name (under **Record**, **Completed** is **Recording completed**); a lit dot means the hook fired in the last 24 hours. Under each hook are the add-ons attached to it, with a count of runs going and runs failed. Click an add-on to open its latest run.
4. Below the map: **In flight** (runs going now, with progress), **Recently finished** and **Stage activity** (each hook as it fires).

### Add an add-on service

1. Choose **Add-on services** at the top of the page, or open the **Add-ons and triggers** tab, then choose **New add-on**. (With no add-ons yet, choose **Create one, or start with the demo agent**.)
2. Under **Type**, choose **External service** for a real platform, or **Demo agent (simulated)**, which runs inside Volt, walks through five steps in about fifteen seconds and returns a sample summary and chapters.
3. Give it a **Name** and, under **What it does**, one line for operators. Pick a **Category**: **AI agent**, **Transcription**, **Quality control**, **Metadata**, **Distribution** or **Other**.
4. For an external service, type the **Endpoint URL**. It must be https (http is accepted for localhost while developing).
5. Under **Accepts**, choose what it can work on: **Recordings**, **Assets**, **Channels**, **Events**.
6. Optionally list **Steps (optional)**, separated by commas, to show as a step tracker. Set **Give up after (minutes)**: a run with no outcome by then is marked timed out.
7. Choose **Create**. For an external service, Volt shows **Signing secret for** the add-on: choose **Copy**, give it to the service, then **Done, I saved it**. It is shown only once.
8. Choose **Test** on the add-on's card to send it a signed ping; the answer appears on the card.

### Attach an add-on to a hook

1. On the **Map** tab, click a hook under its stage. A panel opens with what the hook is about, how often it fired in 24 hours and the add-ons already attached.
2. Under **Attach an add-on**, open **Choose an add-on…**. Only add-ons that accept what the hook is about are listed.
3. To limit it, select channels in the list beside it (Ctrl or Cmd to pick several). Leave the list empty and it runs for every channel and event.
4. Choose **Attach**. The add-on now hangs under the hook on the map, and the **Add-ons and triggers** tab lists the trigger as **When** the hook **fires, run** the add-on.
5. Use the switch beside an attached add-on to turn the trigger off and on, or **Detach** to remove it.

Planned hooks carry a **Planned** tag and cannot have add-ons attached yet.

### Follow a run

1. Click a run card under **In flight**, a row under **Recently finished**, or a row on the **Runs** tab. Filter the **Runs** tab with **All**, **In flight**, **Done** or **Failed, timed out, cancelled**.
2. The **Add-on run** drawer shows what it is **About**, what **Started by** it (a hook, or **Sent by hand**), when it started, how long it has taken, the service's reference, and the deadline while it is open.
3. **Progress** shows the current step and percentage; **Result** shows a summary and chapters when the service returns them (**Raw result** shows everything); **Event log** lists each update.
4. Choose **Cancel run** to stop an open run, or **Run again** to start a new run of a finished one with the same add-on and subject.

| State | Means |
|---|---|
| **Queued** | Waiting to be sent |
| **Sent** | The service accepted it; waiting for progress |
| **Running** | The service is reporting progress |
| **Done** | Finished with a result |
| **Failed** | The service reported an error (shown under the state) |
| **Cancelled** | Someone cancelled it |
| **Timed out** | No outcome before **Give up after** |

### Trace a recording on the map

1. On a run of a recording or asset, choose **Show on map** (or **Map** on the **Runs** tab, or **trace** under **Stage activity**).
2. The bar above the map reads **Tracing recording:** and its title. Stages it has passed are ticked, the stage it is at says **Here now**, and its add-on runs show their progress.
3. Choose **Open recording** to go to it, or **Clear trace** to go back to the plain map.

### Send a recording to an add-on by hand

1. Open the recording (see [Recordings](recordings.md)) and choose **Send to add-on**.
2. Pick an add-on. Only add-ons that are on and accept recordings are listed.
3. The page says **Sent to** the add-on; choose **Track it** to open the run. **Show this recording on the workflow map** in the same menu traces it.

### Change or remove an add-on

On its card, use the switch to turn it off (its triggers stop starting runs), **Edit** to change it, **New secret** to issue a new signing secret for an external service, or **Delete**. Delete asks for a second click, **Delete it and its runs**, because its run history goes with it.

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md), [Events](events.md) | Starting and stopping them fires **Stream started** and **Stream stopped** |
| [Recordings](recordings.md) | **Recording completed** fires as each closes; a recording can be sent to an add-on by hand and traced |
| [Review](review.md) | A decision fires **Review decided** |
| [Ingest Rules](ingest-rules.md), [Encoding Profiles](encoding-profiles.md) | The file ingest lane: rules decide what a file becomes, then it is encoded to a ladder |
| [Publishing Rules](publishing-rules.md) | The **Publish** stage at the end of post-production |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the map, runs, add-ons and triggers; trace a recording | Account settings: View |
| Cancel a run, run it again, send a recording to an add-on | Account settings: Operate |
| Create, edit, test, turn off or delete add-ons; issue a new secret; attach and detach triggers | Account settings: Manage |

Sending a recording by hand also needs **Recordings & clips: View** to open the recording.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **No add-on accepts a ... yet. Create one under Add-ons and triggers.** in a hook's panel | No add-on accepts what this hook is about | Edit an add-on and add it under **Accepts**, or create one |
| **No add-on accepts a recording. An admin can add one under Workflows.** in **Send to add-on** | No add-on that is on accepts recordings | Ask an administrator to add or turn one on |
| **Endpoints must be https (http is allowed only for localhost while developing).** | The endpoint address is plain http | Use the service's https address |
| **add-on off** beside an attached add-on | The add-on itself is switched off, so the trigger starts nothing | Turn the add-on on, on the **Add-ons and triggers** tab |
| **this hook is planned and does not fire yet** under a trigger | The hook is on the map but Volt does not fire it yet | Attach the add-on to a live hook instead |
| A run stays at **Sent** and then shows **Timed out** | The service accepted the job but never reported back | Check the service received the callback address; raise **Give up after** if its jobs are long |
| **Failed** with a reason under it | The service reported an error | Read the **Event log**, fix it on the service side, then **Run again** |
| **The recording no longer exists** after **Run again** | The recording was deleted | Nothing to rerun |
| **Couldn't load the workflow map.** | The page could not reach Volt | It clears itself when Volt answers again; reload if it stays |

## Through the API

| Request | Does |
|---|---|
| `GET /api/workflows/map` | Lanes, stages, hooks, what is attached and 24-hour counts |
| `GET /api/workflows/runs` | Runs, filtered with `state`, `addonId`, `subjectType`, `subjectId` |
| `GET /api/workflows/runs/{id}` | One run with its event log |
| `POST /api/workflows/runs` | Sends a recording or asset to an add-on by hand |
| `POST /api/workflows/runs/{id}/cancel`, `POST /api/workflows/runs/{id}/retry` | Cancels a run, or starts it again |
| `GET /api/workflows/trace?subjectType=recording&subjectId=...` | Hooks fired and runs for one recording or asset |
| `GET /api/workflows/events` | Recent hook events across the account |
| `GET /api/addons`, `POST /api/addons`, `PATCH /api/addons/{id}`, `DELETE /api/addons/{id}` | Add-on services |
| `POST /api/addons/{id}/rotate-secret`, `POST /api/addons/{id}/test` | A new signing secret; a signed test ping |
| `GET /api/addons/triggers`, `POST /api/addons/triggers`, `PATCH /api/addons/triggers/{id}`, `DELETE /api/addons/triggers/{id}` | Triggers that attach add-ons to hooks |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"addonId": "ADDON_ID", "subjectType": "recording", "subjectId": "RECORDING_ID"}' \
  "https://your-volt-host/api/workflows/runs"
```

For the service itself: Volt sends each run as a signed POST to its endpoint, with the signature in the `X-Volt-Signature` header (an HMAC SHA-256 of the timestamp and body, made with the add-on's signing secret). The request carries the subject, links to the media, the options, and a `callbackUrl` and `callbackToken` for that run. The service reports progress, steps, state and the result by posting to `callbackUrl` with `Authorization: Bearer` and the callback token.

Every route is in the [API reference](/api-reference).
