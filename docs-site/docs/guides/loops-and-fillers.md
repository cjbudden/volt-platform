---
title: Loops & Fillers
sidebar_position: 3.1
description: Upload the slates and loops a stream shows when its source goes away or a programme is replaced.
guide: section
---

# Loops & Fillers

Loops & Fillers holds the pictures a stream falls back on: a **slate** (a still image) or a **loop** (a short video that repeats). They are the last thing between a lost feed and a black screen, so each one is checked before it is used: Volt builds a **house preview** of it as viewers will see it, QC measures that preview, and a person approves it. Only approved, active slates and loops can be chosen for a channel, radio station, event or FAST channel.

![The Loops & Fillers page: the upload area at the top, then the list of loops and slates with a preview, what uses each one, its size and status](/img/screens/loops-and-fillers.png)

## What it is for

- **Fallback on loss.** A channel or event can show a slate or play a loop when no source is available at all, instead of stopping.
- **One place for them.** Upload once and choose the same slate or loop on any number of streams. The list says which streams use each one.
- **Checked before air.** Watch each loop play round and round in the house format, see where its join is, read what QC found, then approve or reject it.
- **Kept in order.** Tag slates and loops to group them, search the list, and archive the ones you no longer want offered without deleting them.

Channel operators and the people who look after a channel's branding use it.

## Before you start

- A file: a still image (PNG, JPEG, WebP and other common formats) for a slate, or a video file for a loop. Make it the shape of your output, usually 16:9.
- **Files, uploads & storage: Manage** to upload, rename or delete. Choosing a fallback on a stream needs that stream's own Manage access (see [Who can do it](#who-can-do-it)).

## Step by step

### Upload a slate or a loop

1. Open **Loops & Fillers** in the sidebar.
2. Drop one or more files on the upload area, or click it and choose them.
3. **Upload as** is set to **whatever the file is**: stills become slates and video becomes loops. Choose **Slate (a still)** or **Loop (a video)** first if you want to decide yourself.
4. Progress shows under **Uploading**. When the upload finishes, the file appears in the list as **ready**, **Awaiting approval**, while Volt builds its house preview (about a minute). If it still shows **uploading**, choose **Refresh**.
5. Choose **Review** on its row to watch the preview and approve it (see [Review and approve](#review-and-approve)).

Large files are sent in pieces. If an upload is interrupted (the tab closed, the network dropped), it is listed under **Unfinished uploads** the next time you open the page: choose **Choose the file and resume**, pick the same file, and it carries on from where it stopped. Where the browser allows it, uploads carry on in the background even after you close the tab; the page says which applies.

### Find, check and rename

1. Type in **Search names and files** to find one by its name or file name.
2. Use **All kinds**, **Loops** or **Slates**, the approval filter (**Awaiting approval**, **Approved**, **Rejected**) and **Active** or **Archived** to narrow the list. Archived items are hidden until you choose **Archived** or **Active and archived**.
3. Choose a tag under the filters (or on a row) to show only the slates and loops with that tag; **Any** clears it.
4. The list shows 25 at a time; **Previous** and **Next** move between pages.
5. Hover over a loop's thumbnail for a quick moving sketch made from its frames. It is only a sketch: to judge a loop, open it and watch its house preview.
6. **Used by** names every channel, station, event and FAST channel that uses it; choose a name to open that stream.
7. To rename, click the name, type the new one and press Enter (Escape cancels). The file name stays underneath.

### Review and approve

Choose **Review** (or **Details**) to open one slate or loop. **House preview** is at the top.

- **The player** plays the slate or loop as it airs: built by the same encoder and packager the streams use, in your **house format** (the output profile most of your channels use, or 1080p and 720p H.264 when you have none). A loop plays continuously, three times over and then round again, exactly as it repeats on air, so a join that is not seamless shows itself. The bar under the player marks each join; **Watch the loop point** jumps to three seconds before the next one. Choose a rendition to see each quality.
- **QC** lists what Volt measured in that preview. Each finding says what was measured and what was expected, and shows stills from the preview at that moment: for a jump or click where the loop restarts, the loop's **Last frame** beside its **First frame (after the join)**, so you see both sides of the join at once. Choose a still, or **Play from** (**Play across the join** for a join), to play that moment in the player above.
- **Accept a finding.** When you have looked at a finding and are content with it (a sting that is meant to cut, a quiet ambient loop), choose **Accept this finding**, add why if you like, and confirm. The list says how many are accepted, and who accepted each and when; **Undo** takes it back. Acceptances stay when QC runs again, as long as the same finding is at the same place. QC looks for: a preview that will not play; black; silence (a loop with no sound is noted, not a fault); loudness far from -23 LUFS or peaks above -1 dBFS; the loop cut to whole segments (a 13.4 s file with 4 s segments plays 12 s, so its end is never seen and the picture jumps); a jump in the picture or a click in the sound where the loop restarts; a file smaller than the house format (upscaled); not 16:9 (shown with bars); a frame rate that is converted; and an interlaced file.
- **Approval.** Watch it, then choose **Approve** or **Reject**, with a note if you like. Approving while a QC error is not accepted, or with no preview, needs a note that says why; accept the errors first and no note is needed. **Back to waiting** undoes a decision.
- **Availability.** **Archive** keeps it but takes it off every picker. A slate or loop that a stream uses cannot be archived: choose another one for those streams first. **Make available** brings it back.
- **Tags** sit under the name: type one and press Enter to add it, choose ✕ to remove it.
- **Build the preview again** rebuilds it, for example after you change your output profiles; **Run QC again** measures it again.

Slates and loops that existed before approval was added count as approved, so nothing on air changes.

### Check the file and its thumbnail

Further down the same page:

### Check the file and its thumbnail

Choose **Details** to open one slate or loop.

- **As uploaded** plays the file as you uploaded it (when your browser can play its format; for ProRes, MXF and similar it says so and shows the hover preview instead) and lists what it is: resolution, length and frame rate, the video codec with its profile, level and bitrate, the audio (codec, channels, sample rate, bitrate) and the container. A loop with no sound shows **None**: a fallback adds silence. Hover over the player's timeline to preview any moment.
- **Thumbnail** is the picture the list and the stream pickers show. For a loop, Volt takes a dozen frames from it and uses the best one (not black, not blurred, not colour bars). To use another, choose one of the frames; **Pick automatically** goes back to Volt's choice. A slate's thumbnail is the image itself. **Make again** reads the file again, for example after a failure.
- **Renditions made from this file** lists every rendition built from it, and for which stream. Each stream that falls back on the file gets its own copy, encoded to that stream's ladder, so one file can have several sets.

Thumbnails are made a few seconds after an upload finishes. Slates and loops added before this existed get theirs automatically.

### Use one on a channel

1. Open the channel and choose **Settings** (the gear button at the top of its page). Stop the channel first if its settings are locked.
2. Under **Filler on total loss**, set **When no source is available** to **Slate image** or **Loop video**.
3. Choose **Choose from Loops & Fillers…**, then pick the slate or loop. Only approved, active ones are offered; the picker says how many are waiting for approval. You can also upload one from there, but it has to be approved before it can be chosen.
4. Save the settings. The channel now shows under **Used by** in Loops & Fillers.

Events have the same choice in their settings. With input failover on, a stream tries its backup source first and only then the filler ([Failover](failover.md)). The other choices, **Freeze last frame** and **Black**, need no file.

### Archive or delete one

Choose **Archive** on its row to keep it but stop it being offered anywhere; **Make available** brings it back. It cannot be archived while a stream uses it.


To remove it for good:

1. Choose **Delete** on its row.
2. If no stream uses it, confirm and it is gone. (The row's buttons are icons: the eye opens **Details**, a tick opens **Review** for one awaiting approval, the box **Archive**s it, the box with an arrow makes it available again, and the bin deletes it. Hover over one for its name.) If it is in use, Volt names the streams and warns that they will be left with no fallback; confirm only if that is what you want, then choose another fallback on those streams.

### Bring in older fallbacks

Streams set up before Loops & Fillers existed may fall back on an image kept in the Image Library. They still work, and the page lists them under **Fallbacks not in Loops & Fillers yet**. Choose **Copy into Loops & Fillers** to manage one here: the streams that use it move over with it, and the Image Library copy is left as it was. Because it was already on air, the copy counts as approved.

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
| See the list, previews, QC and what uses each file | Files, uploads & storage: View |
| Upload, rename, tag, approve or reject, archive, delete, copy in from the Image Library | Files, uploads & storage: Manage |
| Choose a channel's fallback | TV channels: Manage |
| Choose an event's fallback | Events: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| A file stays at **uploading** | The page has not refreshed, or the upload was interrupted | Choose **Refresh**; if it is listed under **Unfinished uploads**, resume it with the same file |
| **error** in the Status column | The file could not be stored or used; the reason is shown under it | Delete it and upload it again, in a common format (PNG or JPEG for a slate, MP4 for a loop) |
| **no preview** | The file is not ready yet | Wait for **ready**, then choose **Refresh** |
| **Could not make thumbnails** on the details page | The file could not be read (the reason is shown) | Choose **Make again**; if it fails again, upload the file again in a common format |
| A stream's settings say the chosen slate or loop **is no longer in Loops & Fillers** | It was deleted while the stream still used it | Choose another one in the stream's settings |
| The loop picker on a stream is empty | No loops are approved and active | Approve one here (filter by **Awaiting approval**), or make an archived one available |
| A stream's settings will not save: **waiting for approval**, **rejected** or **archived** | Only approved, active slates and loops can be newly chosen | Approve it or make it available, or choose another. A stream keeps the one it already has |
| **Archive** is greyed out | Streams use it | Choose another slate or loop for them first |
| **Preview failed** | The house preview could not be built (the reason is on its page) | Choose **Build the preview again**; if it fails again, upload the file again in a common format |
| The loop jumps or clicks each time it repeats | The file's last frame or sound does not lead back into its first; or it is not a whole number of segments long | QC says which. Edit the file to the length QC suggests, cut on a matching frame and fade the sound, then upload it again |
| The hover sketch in the list flashed black where it wrapped | Fixed on 11 Nov 2026; older loops' sketches are made again automatically | Nothing, or choose **Make again** on its page |

## Through the API

| Request | Does |
|---|---|
| `GET /api/filler-assets` | Lists slates and loops, each with `used_by`. Search with `q`, filter by `kind`, `review_state`, `availability` and `tag` (comma list: all of them), page with `limit` and `offset` (`count=true` for the total) |
| `GET /api/filler-assets/tags` | Every tag in use, with how many carry it |
| `PUT /api/filler-assets/{id}/tags` | Replaces its tags: `{"tags": ["Sport", "Brand A"]}` |
| `GET /api/filler-assets/{id}/house` | Its house preview (`preview.url` plays it), QC findings, approval and availability |
| `POST /api/filler-assets/{id}/house` | Builds the house preview again (and QC) |
| `POST /api/filler-assets/{id}/qc` | Runs QC again over the preview |
| `POST /api/filler-assets/{id}/qc/accept` | Accepts one finding: `{"key": "<the finding's key>", "accepted": true, "note": "..."}`; `"accepted": false` takes it back |
| `POST /api/filler-assets/{id}/review` | `{"decision": "approve" \| "reject" \| "reset", "note": "..."}`; approving with an error nobody has accepted, or without a preview, needs a note (400) |
| `POST /api/filler-assets/{id}/availability` | `{"state": "archived" \| "available"}`; archiving one that streams use is refused (409) with `inUseBy` |
| `GET /api/filler-assets/{id}` | One slate or loop |
| `PATCH /api/filler-assets/{id}` | Renames it (`{"name": "Half-time loop"}`) |
| `DELETE /api/filler-assets/{id}` | Deletes it; add `?force=true` when streams still use it |
| `POST /api/filler-assets/copy-from-library` | Copies an Image Library image in and moves its streams over |
| `GET /api/channels/{id}/filler`, `GET /api/events/{id}/filler` | What a stream falls back on |
| `GET /api/filler-assets/{id}/details` | One slate or loop with its format (`asset.probe`), thumbnail, frames and the copies built for each stream |
| `PUT /api/filler-assets/{id}/poster` | Chooses a loop's thumbnail: `{"key": "<a frame from poster_candidates>"}`, or `{"auto": true}` |
| `POST /api/filler-assets/{id}/thumbnails` | Makes the thumbnails again |
| `GET /api/filler-assets/{id}/thumbnails.vtt` | A loop's preview thumbnails as WebVTT, for a player's scrub bar |

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/filler-assets"
```

Files themselves are sent with the uploads API, as the console does. Every route is in the [API reference](/api-reference).
