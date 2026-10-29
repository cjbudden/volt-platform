---
title: Encoding Queue
sidebar_position: 3.85
description: See what is being encoded now, what is waiting and in which order, and why an encode failed, then retry or cancel it.
guide: section
---

# Encoding Queue

The Encoding Queue shows every on-demand encode in your account: what is being encoded now and how far it has got, what is waiting and in which order, and what finished recently. Open an encode to see each output it produced, its log and its attempts, and retry it if it failed.

![The Encoding Queue page: Encoding now, Waiting, and Finished recently with one encode done and one failed with its reason and a Retry button](/img/screens/encoding-queue.png)

## What it is for

- **Knowing when a title will be ready.** An uploaded or watch folder file is playable once its encode has finished; the queue says where it is.
- **Finding out why an encode failed,** with the reason in words and the log of every step.
- **Putting a failed encode right:** retry it once the cause is fixed, or cancel one you no longer need.

Media librarians and whoever adds files use it, usually after an upload or a watch folder drop.

## Before you start

- Files coming in: added in the [Media Library](media-library.md), dropped in a [watchfolder](watchfolders.md) or sent through the API. Each is encoded to the ladder in [Encoding Profiles](encoding-profiles.md).
- **Files, uploads & storage: View** to see the queue (see [Who can do it](#who-can-do-it)).

## Step by step

### See what is encoding and what waits

1. Open **Encoding Queue** in the sidebar (under Media).
2. **Encoding now** shows each running encode: the title, the file, a progress bar, the step it is on (for example encoding the renditions, packaging, or building the preview sheets), how far it has got and how long it has run.
3. **Waiting** lists the encodes still to start, in the order they will start. **Next** is the next one. Encoders are shared, so a line under the heading says how many other encodes on the platform are queued or running too; your place counts them.
4. An encode waiting to try again after an error says when it will retry, and which attempt it will be.

The page refreshes itself every few seconds while anything is encoding or waiting. **Refresh** reloads it at once.

### Find out why an encode failed

1. Under **Finished recently**, choose **Failed** to see only the ones that failed. The **Outcome** column gives the reason.
2. Choose the row to open the encode. The reason is at the top.
3. **Outputs** shows each rendition, the HLS and DASH packages, the thumbnails and the preview sheets, each **Done**, **Writing**, **Waiting**, **Failed**, **Skipped** or **Missing**, with any jobs that run after the encode (such as choosing the asset's image).
4. **Encoder log** shows what happened, step by step. **Steps only** hides the encoder's own detail; **Copy** and **Download** keep a copy to send to support.
5. **Attempts**, on the right, lists each try with its outcome.

### Retry a failed or cancelled encode

1. Fix the cause first if the reason names one (for example, upload the file again).
2. Choose **Retry** on the row under **Finished recently**, or on the encode's own page. A message says it is back in the queue, and it appears under **Waiting**.

### Cancel an encode

1. Choose **Cancel** on a waiting encode, or **Cancel encode** on the page of one that is running.
2. Confirm. The title stays in the Media Library without playable media until it is encoded again; **Retry** starts it again later.

### Go between a title and its encode

- From an encode's page, **Open the asset** opens the title in the Media Library.
- From a title's **Encode** tab in the Media Library, **Encode job and log** opens its encode here.

## How it connects

| Section | How it relates |
|---|---|
| [Media Library](media-library.md) | Every encode here makes a title there playable; each title links to its encode |
| [Encoding Profiles](encoding-profiles.md) | The ladder decides which renditions an encode makes |
| [Watchfolders](watchfolders.md) | Files dropped in a watchfolder are encoded through this queue |
| [Workflows](workflows.md) | The encode is one step of a file's workflow |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the queue, an encode's outputs, log and attempts | Files, uploads & storage: View |
| Retry and cancel encodes | Files, uploads & storage: Operate |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Nothing is encoding right now.** and **Nothing is waiting.** | No encodes are running or queued in your account | Nothing to do |
| An encode stays under **Waiting** with a high place | Encoders are busy with other encodes on the platform | Wait; it moves up as they finish |
| **retry at** a time, **after an error** | The last attempt failed and Volt will try again by itself | Wait, or open it to read the error |
| **Failed** with a reason about the source file | Volt could not read the file you gave it | Check the file plays on your computer, add it again, then **Retry** |
| **No log was kept for this job.** | The encode ran before encode logs were kept | Use the reason at the top and the attempts |
| **The asset this job encoded has been deleted.** | The title was deleted after the encode | Nothing to do; the outputs are shown as they were last seen |
| A message that a job "cannot be retried" | Only failed or cancelled encodes can be retried | Wait for it to finish |

## Through the API

| Request | Does |
|---|---|
| `GET /api/jobs/encode-queue` | Running encodes, waiting ones with their `position`, recently finished ones (`?recent=` up to 200) and the platform's backlog |
| `GET /api/jobs/{id}` | One encode with its attempts |
| `GET /api/jobs/{id}/outputs` | Its renditions, packages, thumbnails, preview sheets and the jobs it queued after |
| `GET /api/jobs/{id}/log?after={seq}` | Its log lines after a given line, to follow it while it runs |
| `POST /api/jobs/{id}/retry`, `POST /api/jobs/{id}/cancel` | Retries a failed or cancelled encode, or cancels one that has not finished |

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/jobs/encode-queue?recent=20"
```

Every route is in the [API reference](/api-reference).
