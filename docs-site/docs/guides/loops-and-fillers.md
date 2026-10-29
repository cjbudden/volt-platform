---
title: Loops & Fillers
sidebar_position: 3.1
description: Upload the slates and loops a stream shows when its source goes away or a programme is replaced.
guide: section
---

# Loops & Fillers

Loops & Fillers holds the pictures a stream falls back on: a **slate** (a still image) or a **loop** (a short video that repeats). They are the last thing between a lost feed and a black screen, so the list shows at a glance which streams use each one and whether it is ready to play.

![The Loops & Fillers page: the upload area at the top, then the list of loops and slates with a preview, what uses each one, its size and status](/img/screens/loops-and-fillers.png)

## What it is for

- **Fallback on loss.** A channel or event can show a slate or play a loop when no source is available at all, instead of stopping.
- **One place for them.** Upload once and choose the same slate or loop on any number of streams. The list says which streams use each one.

Channel operators and the people who look after a channel's branding use it.

## Before you start

- A file: a still image (PNG, JPEG, WebP and other common formats) for a slate, or a video file for a loop. Make it the shape of your output, usually 16:9.
- **Files, uploads & storage: Manage** to upload, rename or delete. Choosing a fallback on a stream needs that stream's own Manage access (see [Who can do it](#who-can-do-it)).

## Step by step

### Upload a slate or a loop

1. Open **Loops & Fillers** in the sidebar.
2. Drop one or more files on the upload area, or click it and choose them.
3. **Upload as** is set to **whatever the file is**: stills become slates and video becomes loops. Choose **Slate (a still)** or **Loop (a video)** first if you want to decide yourself.
4. Progress shows under **Uploading**. When the upload finishes, the file appears in the list as **ready** with a preview. If it still shows **uploading**, choose **Refresh**.

Large files are sent in pieces. If an upload is interrupted (the tab closed, the network dropped), it is listed under **Unfinished uploads** the next time you open the page: choose **Choose the file and resume**, pick the same file, and it carries on from where it stopped. Where the browser allows it, uploads carry on in the background even after you close the tab; the page says which applies.

### Find, check and rename

1. Use **All**, **Loops** or **Slates** to narrow the list.
2. Hover over a loop's preview to play it, or choose **Open** to see the file at full size.
3. **Used by** names every channel and event that falls back on it; choose a name to open that stream.
4. To rename, click the name, type the new one and press Enter (Escape cancels). The file name stays underneath.

### Use one on a channel

1. Open the channel and choose **Settings** (the gear button at the top of its page). Stop the channel first if its settings are locked.
2. Under **Filler on total loss**, set **When no source is available** to **Slate image** or **Loop video**.
3. Choose **Choose from Loops & Fillers…**, then pick the slate or loop. You can also upload one from there.
4. Save the settings. The channel now shows under **Used by** in Loops & Fillers.

Events have the same choice in their settings. With input failover on, a stream tries its backup source first and only then the filler ([Failover](failover.md)). The other choices, **Freeze last frame** and **Black**, need no file.

### Delete one

1. Choose **Delete** on its row.
2. If no stream uses it, confirm and it is gone. If it is in use, Volt names the streams and warns that they will be left with no fallback; confirm only if that is what you want, then choose another fallback on those streams.

### Bring in older fallbacks

Streams set up before Loops & Fillers existed may fall back on an image kept in the Image Library. They still work, and the page lists them under **Fallbacks not in Loops & Fillers yet**. Choose **Copy into Loops & Fillers** to manage one here: the streams that use it move over with it, and the Image Library copy is left as it was.

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md), [Events](events.md) | Each channel and event chooses its fallback in its settings, under **Filler on total loss** |
| [EPG](epg.md) | A programme's own slate or loop replacement for its slot is chosen from here, in the programme's **Replacement for this period**. **Used by** lists channels and events only, not the programmes that name a file |
| [Failover](failover.md) | The filler is what plays when neither the primary nor the backup source is available |
| Image Library | Older fallbacks are copied in from there |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the list and what uses each file | Files, uploads & storage: View |
| Upload, rename, delete, copy in from the Image Library | Files, uploads & storage: Manage |
| Choose a channel's fallback | TV channels: Manage |
| Choose an event's fallback | Events: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| A file stays at **uploading** | The page has not refreshed, or the upload was interrupted | Choose **Refresh**; if it is listed under **Unfinished uploads**, resume it with the same file |
| **error** in the Status column | The file could not be stored or used; the reason is shown under it | Delete it and upload it again, in a common format (PNG or JPEG for a slate, MP4 for a loop) |
| **no preview** | The file is not ready yet | Wait for **ready**, then choose **Refresh** |
| A stream's settings say the chosen slate or loop **is no longer in Loops & Fillers** | It was deleted while the stream still used it | Choose another one in the stream's settings |
| The loop picker on a stream is empty | No loops have been uploaded yet | Upload one from the picker, or here |

## Through the API

| Request | Does |
|---|---|
| `GET /api/filler-assets` | Lists slates and loops, each with `used_by` |
| `GET /api/filler-assets/{id}` | One slate or loop |
| `PATCH /api/filler-assets/{id}` | Renames it (`{"name": "Half-time loop"}`) |
| `DELETE /api/filler-assets/{id}` | Deletes it; add `?force=true` when streams still use it |
| `POST /api/filler-assets/copy-from-library` | Copies an Image Library image in and moves its streams over |
| `GET /api/channels/{id}/filler`, `GET /api/events/{id}/filler` | What a stream falls back on |

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/filler-assets"
```

Files themselves are sent with the uploads API, as the console does. Every route is in the [API reference](/api-reference).
