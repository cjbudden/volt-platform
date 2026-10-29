---
title: Encoding Profiles
sidebar_position: 9.2
description: Set the ladders that uploaded and watch-folder video is encoded to, ideally mirroring a live output profile so files match your channels.
guide: section
---

# Encoding Profiles

Encoding Profiles sets the **ladders** that uploaded and watch-folder video is encoded to: the set of heights and bitrates each file gets. The ladder most accounts want mirrors a live output profile, so files in the library play at the same renditions as the channels using that profile and never drift from them.

![The Encoding profiles page: the list of renditions with the form to add one, the New ladder card, and a ladder with its rungs and the preview of what a source would get](/img/screens/encoding-profiles.png)

## What it is for

- **Renditions.** One height and bitrate each, such as 720p at 3000 kbps. A standalone ladder is made of them.
- **Ladders that track live.** A mirrored ladder holds no renditions of its own. It reads the rungs of a live output profile each time a file is encoded, so if the live profile changes, the ladder follows.
- **Standalone ladders.** A ladder with its own renditions, independent of the live profiles. Right for an archive or a cut-down ladder, wrong for "the same as our channels".
- **The account default.** The ladder used when nothing names another one: uploads, and watch folders set to the default.
- **A preview.** Type the height of a source and see which rungs that file would get.

Rate control (preset, maximum rate, buffer, GOP) is not set here: it is the same for live and file encodes, so the two cannot drift apart.

The people who look after the media library's quality and storage use this page, usually once when the account is set up.

## Before you start

- To mirror a live output profile, the account needs one. Each channel group has an output profile (see [Channel Groups](channel-groups.md)).
- **Encoding profiles & ladders: Manage** to add, change or delete anything here (see [Who can do it](#who-can-do-it)).

## Step by step

### Mirror a live output profile (recommended)

1. Open **Admin** and choose **Encoding Profiles**.
2. Under **New ladder**, open **Mirror a live output profile…** and pick a profile. Each is listed with its heights, such as **HD (1080p/720p)**.
3. Choose **Mirror**. A ladder called **Same as** followed by the profile's name appears below. If the account had no default ladder, this one becomes the **account default**.
4. The ladder says which live output profile it tracks and shows the rungs it reads from it today, with the segment length, frame rate and packaging.

### Build a standalone ladder

1. Under **Renditions**, type a name if you want one (it defaults to the height and bitrate, such as **720p 3000k**), the height in pixels and the bitrate in kbps, then choose **Add rendition**. Repeat for each rung.
2. Under **New ladder**, type a name in **Or a standalone ladder, by name** and choose **Create**.
3. On the new ladder, under **Renditions**, type a height and a bitrate and choose **Add rendition**, or pick one of **Start from a standard set…**. **Remove** takes a rendition out of the ladder. Volt orders the rungs from the tallest down, one rendition per height.

A mirrored ladder has no rendition list to edit: its rungs come from the live profile.

### Change a rendition

1. Under **Renditions**, choose **Edit** on the rendition. Its name, height and bitrate become fields.
2. Change them and choose **Save** (or press Enter in the bitrate). **Cancel** leaves it as it was.
3. A rendition used by ladders changes in all of them; the row says how many. FAST channels on those ladders re-package what they air on their own.

Volt refuses a height that another rendition in one of its ladders already has, because a ladder has one rendition per height.

### Choose the default and the picture sizes

1. Choose **Make default** on the ladder that files should use when nothing else is named. It then shows **account default** and its button reads **Default**.
2. Under **Picture sizes**, choose **Follow the source: never upscale** to skip rungs taller than the source, so a 720p file does not get a 1080p rendition that carries no extra detail; **Follow the source: every rendition** to encode every rung whatever the source; or **Fixed sizes** to make every title at exactly the ladder's 16:9 sizes.

### Check what a file would get

1. On a ladder, under **What would a source of this height get?**, type the source's height in pixels.
2. The rungs it would get are shown in bold. Below them Volt says which rungs are **Not encoded** because they are above the source, whether the lowest rung is encoded at the source's own height because the source is smaller than every rung, and whether the frame rate is capped.
3. Leave the height empty to see what happens to a source Volt could not measure: the full ladder is encoded.

### Use a ladder for a watch folder

Each watch folder has **Encode video to**, set to **The account default ladder** or to a named ladder (mirrored ones say **(tracks live)**). See [Watchfolders](watchfolders.md). Uploads to the [Media Library](media-library.md) use the account default.

### Delete a rendition or a ladder

1. Choose **Delete** on the rendition or the ladder. There is no confirmation step.
2. A rendition that a ladder uses cannot be deleted: its **Delete** is unavailable, and pointing at it says to take it out of the ladder first. A ladder used by a watch folder or by assets is refused with a message that names what uses it; change those first.

## How it connects

| Section | How it relates |
|---|---|
| [Channel Groups](channel-groups.md) | Each group's output profile is a live profile a ladder can mirror |
| [Watchfolders](watchfolders.md) | Each folder encodes video to the default ladder or the one it names |
| [Media Library](media-library.md) | Uploaded video is encoded to the account default ladder |
| [Workflows](workflows.md) | File encoding is the **Encode** stage of the file ingest lane |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See renditions, ladders and the preview | Encoding profiles & ladders: View |
| Add, change or delete renditions, create, mirror, change or delete ladders, set the default | Encoding profiles & ladders: Manage |
| Choose a watch folder's ladder | Files, uploads & storage: Manage |

Without Manage, the page says **You can see the renditions and ladders. Changes need Encoding profiles & ladders: Manage.** and shows them without the buttons and fields that change them. A role saved before Encoding profiles became its own permission keeps its Account settings level here.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **A rendition needs a height and a bitrate.** | One of the two boxes is empty or not a number | Type both as whole numbers |
| **a rendition called "..." already exists** or **a ladder called "..." already exists** | Names are unique in the account | Choose another name |
| **Delete** on a rendition is unavailable | A ladder still contains it (the row says **in ... ladder**) | Choose **Remove** on it in the ladder's **Renditions**, then delete it |
| **... already has a ...p rendition, and a ladder has one rendition per height** | Another rendition in one of its ladders has that height | Choose another height, or take the other one out of the ladder first |
| **A height between 90 and 4320 lines.** or **A bitrate between 50 and 200000 kbps.** | The edited value is out of range | Type a value in range |
| **Someone else changed this rendition while you were editing. Reload to see their change.** | It was changed since you opened it | Reload the page and edit again |
| **this ladder is in use by ...; point them at another ladder first** | A watch folder or assets use the ladder | Change the folder's **Encode video to**, then delete the ladder |
| **This ladder cannot be used:** followed by a reason | The ladder has nothing it can encode, for example its live profile is gone | Mirror another live profile, or add renditions to a standalone ladder |
| **No ladders yet. Mirror one of your live output profiles to get started.** | The account has no ladder, so files have nothing to be encoded to | Mirror a live output profile |
| **Mirror a live output profile…** offers nothing | The account has no output profiles yet | Create a channel group first |
| A file fails to encode, saying the account has no default ladder | Nothing named a ladder and no ladder is the default | Choose **Make default** on a ladder |

## Through the API

| Request | Does |
|---|---|
| `GET /api/encode-profiles` | Lists renditions, each with how many ladders use it |
| `POST /api/encode-profiles` | Adds a rendition (`name`, `height`, `bitrateKbps`) |
| `PATCH /api/encode-profiles/{id}`, `DELETE /api/encode-profiles/{id}` | Changes a rendition (`name`, `height`, `bitrateKbps`, optional `version`) or deletes one no ladder uses |
| `GET /api/encode-profiles/ladders` | Lists ladders with the rungs each one resolves to now |
| `POST /api/encode-profiles/ladders/mirror` | Creates (or finds) the ladder that tracks a live output profile (`outputProfileId`) |
| `POST /api/encode-profiles/ladders` | Creates a standalone ladder |
| `PATCH /api/encode-profiles/ladders/{id}`, `DELETE /api/encode-profiles/ladders/{id}` | Changes a ladder (for example `{"isDefault": true}` or `{"capToSource": false}`) or deletes it |
| `PUT /api/encode-profiles/ladders/{id}/members` | Sets a standalone ladder's renditions (`profileIds`) |
| `GET /api/encode-profiles/ladders/{id}/preview?height=720` | What a source of that height would get |
| `GET /api/encode-profiles/live-profiles` | The live output profiles a ladder can mirror |

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-volt-host/api/encode-profiles/ladders/LADDER_ID/preview?height=720"
```

Every route is in the [API reference](/api-reference).
