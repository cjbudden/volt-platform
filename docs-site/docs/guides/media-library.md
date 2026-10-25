---
title: Media Library
sidebar_position: 3.5
description: Find, upload, describe, check and publish every clip, recording and file your account holds on demand.
guide: section
---

# Media Library

The Media Library holds everything on demand in your account: clips cut from recordings, programmes turned into assets from the guide, and files you upload. Each row says what the asset is, how it was encoded, whether it has been reviewed and checked, and where it has been published, so most questions are answered without opening it.

![The Media Library page: the upload band at the top, the search, sort and filter chips, then the list of assets with their review, QC and availability](/img/screens/media-library.png)

## What it is for

- **One library.** Clips from [Recordings](recordings.md), programmes converted from the [EPG](epg.md), and uploaded or watch-folder files all land here.
- **Finding things.** Search, sort and filter by asset type, source, availability, how it was made, missing metadata, content type, resolution, codec, review state, date and length. The filters are part of the page address, so a filtered view can be bookmarked or sent to a colleague.
- **Describing it.** Each asset has a content type and metadata, which can be filled from the guide programme it came from.
- **Checking it.** The encode, the renditions, the files you can download, QC results and the full history of what happened to it.
- **Publishing it.** Publish through the asset's publishing rules, take it off again, or post it to your linked social accounts.

Media librarians, clip editors and digital producers use it every day.

## Before you start

- Something to work with: a recording to cut clips from ([Recordings](recordings.md)), a programme set to **Auto VOD** in the [EPG](epg.md), or a video or audio file to upload.
- Content types for your metadata ([Content Types](content-types.md)) and publishing rules for where assets go ([Publishing Rules](publishing-rules.md)). Without your own, the account defaults apply.
- The right access for each task: see [Who can do it](#who-can-do-it).

## Step by step

### Find an asset

1. Open **Media Library** in the sidebar.
2. Type in **Search title, source or type**. The list updates after a short pause, or straight away when you press Enter.
3. Choose a **Sort**: **Newest first**, **Oldest first**, **Title A to Z**, **Longest first**, **Shortest first**, **Least complete metadata** or **Highest resolution**.
4. Narrow the list with the chips. Each shows how many assets it would match.

   | Group | Chips |
   |---|---|
   | **Asset type** | **Video**, **Audio**, **Song** |
   | **Source** | **Channel**, **Event**, **Radio**, **Upload**, **No source** (its channel or event no longer exists) |
   | **Availability** | **Not published**, **Scheduled**, **Available**, **Expired**, **Access removed** (only the ones in use are shown) |
   | **Created as** | **Recording**, **Clip**, **Upload**, **Watch folder** (only the ones in use are shown) |
   | **Metadata** | **Missing required**: a required field of its content type is empty, or it has no content type |

5. Choose **More filters** for **Content type**, **Top resolution**, **Codec**, **Review** (**Needs review**, **Approved**, **Published copy is old**), **Added** (a date range) and **Duration** (in minutes). **Clear filters** removes them all.
6. Switch between **List** and **Grid**. In the list, **Columns** adds or removes **Content type**, **Metadata**, **Top rendition**, **Codec**, **Renditions** and **Source blocks**. Your choice of view and columns is remembered in this browser.
7. The list shows 48 assets at a time. Use **Previous** and **Next** at the bottom to page through.

In the grid, an asset with no image yet is shown in its kind's colour: the key beside **Select all shown** says which colour is **Video**, **Audio** and **Song**.

### Upload files

1. Drop files, or a whole folder, on the band at the top of the page (**Drop files or a folder here**). Or choose **This device** or **Folder** to pick them. On a phone, **Camera roll** and **Record now** take their place.
2. To fetch a file from an address instead, choose **Link**, paste the address and choose **Import**. Volt's servers fetch it, so nothing passes through your computer. Cloud drive buttons beside it work when your account has them set up.
3. Each file is listed with its size and what your [ingest rules](ingest-rules.md) decided before anything moves: the name it will be filed under, **looks like a duplicate** with what the rule says to do, or **refused** with the reason.
4. To give the files a content type and metadata, first turn off **Start as soon as added** (with it on, a file starts uploading the moment it is added, before you can set its type), then choose **Set type and metadata for all**, pick the **Content type** and fill in its fields, then **Done**. **Details** on one file sets them for that file only. Anything left empty is decided by the rules.
5. With **Start as soon as added** on (the usual setting), uploading starts at once. With it off, choose **Ingest 1 file** (or the number of files) when you are ready. **Clear** empties the list without uploading.
6. Progress shows under the band. A finished file appears in the library and starts encoding: its row shows **Queued to encode**, then **Encoding** with a percentage, then the renditions it made.

Uploads are resumable. While anything is uploading or waiting, a button at the bottom of the screen follows you around the console (for example **Uploading 2 · 40%** or **1 waiting on you**). Choose it to open the **Ingest Queue**, where you can pause, resume or cancel a file, **Cancel all**, **Retry** failed files or **Clear** finished ones. Under **Needs you** it lists files the rules held back:

| Shown in the queue | Choose |
|---|---|
| **needs** and the missing fields | **Fill in**, complete the fields, then **Save and ingest** |
| **same content as a library asset**, or **same name and size as a library asset** | **Skip it**, **Keep both** or **Replace old** |
| **refused by** and the rule's name | Nothing here: change the file or the rule in [Ingest Rules](ingest-rules.md) |

Files dropped in a watch folder arrive the same way, without the upload band ([Watchfolders](watchfolders.md)).

### Open an asset

1. Click a row, or choose **Open** on it (in the grid, click the card). The asset opens under the row, or in a panel in grid view.
2. Its tabs are **Preview**, **Skip markers**, **Metadata**, **Encode**, **Formats**, **Availability** and **History**. Beside them is where it stands: **Not published**, **Scheduled**, **Available**, **Expired** or **Access removed**.
3. **Open the recording** goes to the recording a clip was cut from. **Re-run QC** checks it again; the result appears in the **QC** column when it finishes.
4. Choose **Close** (or the row again) to fold it away.

### Watch it and choose its image (Preview)

1. **Preview** plays the asset. Audio plays with an audio player.
2. **Facts** lists its kind, length, how it was built, how much of the source it covers, and its **Review** and **QC** state. For an uploaded file it also shows the **Source file**, the **Ladder** it was encoded with and the **Formats** made.
3. **HLS manifest** opens the streaming address. The **Download** buttons (for example **Download MP4**) appear if your role includes downloads.
4. Under **Image**, Volt picks a picture for the asset by itself: the best frame, a programme image, station artwork or an album cover, and says why. To change it, click one of the **Frames considered, best first**, or choose **Choose from library**. **Pick again** (or **Pick automatically**, after you chose one by hand) lets Volt choose again.
5. For an uploaded file, **Rebuild from source** takes the stills and preview sprite sheets again from the original file.
6. For a song, **Find song details** searches music catalogues by **Artist** and **Song**, or reads a page or cover link you paste. Tick what to change in the results and choose **Apply**. Nothing changes until you do.

### Describe it (Metadata)

1. Open the **Metadata** tab. **Target metadata** shows the asset's content type, how complete it is (a percentage, and how many fields are filled, such as 3 of 5), and each field as filled, **Empty**, or **Required** and still empty. A field marked **EPG** was filled from the guide.
2. To fill fields from the programme the asset was cut from, choose **Fill from EPG**. Check the **Programme** (Volt picks the one that covers most of the clip), tick the fields to **Use**, and choose **Apply**. Empty fields are ticked for you; a value someone typed is only replaced if you tick it. If the guide describes the programme as a different content type, you can tick **Change the content type to** that type.
3. Below, change the **Content type** if this asset should be described differently from its channel or event, fill in its fields, and choose **Save metadata**.

**Fill from EPG** is not offered for uploaded files, which have no guide slot.

### See how it was encoded (Encode)

The **Encode** tab shows the **Workflow** and **Ladder profile**, the **Source / mezzanine** it was made from, every rendition with its resolution, bitrate, codec, profile and frame rate, the audio tracks and the captions. For audio it shows the audio encode instead.

**Deliveries** lists each format (HLS, DASH, downloadable files) as **Ready**, **Being made**, **Requested, not made** or **Not requested**. **Download** lists the files you can take a copy of, with a **Download** button on each. Anything Volt has not recorded says **Not recorded**, and **What is not recorded** lists the gaps, so nothing is guessed.

### Mark the intro, recap and credits (Skip markers)

1. Open the **Skip markers** tab. Volt finds intros and credits by itself after each build, by comparing the asset with other episodes of its series. A marker it is not sure of is shown as **Suggested**.
2. Play to the right place and choose **Add at playhead** for **Intro**, **Recap** or **Credits**. Then adjust it: type the start and end times, choose **Start here** or **End here** at the playhead, or drag the marker's edges on the bar.
3. **Preview** plays from just before the marker so you can see the skip button viewers get. **Use it** accepts a suggestion; **Remove** deletes a marker.
4. **Detect now** runs the detection again. It never changes a marker set or accepted by hand.

Changes reach viewers the next time their player loads the playlist; nothing is rebuilt.

### Make social formats (Formats)

The **Formats** tab frames a 9:16, 1:1 and 4:5 version of the asset by following the people in the picture. Choose **Analyse the picture**, check and adjust the framing, then **Approve** and **Render** each format. See [Formats & reframing](formats-and-reframing.md#check-and-adjust-one-asset).

### Publish it, or take it off (Availability)

1. Open the **Availability** tab. It shows where the asset stands and, if published, from and until when.
2. **What a publish does for this item** shows the publishing rule it follows: **Publish to**, **Auto-publish**, **Available from**, **Expires**, **Geo access**, **Access**, **Paywall**, **Publish gate** and **Access rules**. Grey values are inherited from the account, its content type and its channel, event or station ([Publishing Rules](publishing-rules.md)).
3. To change a value for this asset only, tick the field, set it, and choose **Save publishing rule**.
4. Choose **Publish**. Volt publishes it to every point the rule names and confirms **Published through its rules.** An asset that has expired or had its access removed offers **Publish again**.
5. To take it off, choose **Remove access** and give a reason if you like. The asset is kept; nothing serves it until you publish it again.

**Publishing points** lists where it went (the catalogue, apps, social accounts) and the state at each.

### Post it to social accounts

1. Open the **History** tab and choose **Publish to social**.
2. Under **Publish to**, tick the accounts. Accounts are linked under **Social accounts**; one marked **reconnect needed** cannot be picked.
3. Write the post on the **Shared** tab: **Title**, **Description**, **Tags** and **Visibility**. Choose a platform's own tab to change its version; a count shows when a field is too long.
4. Choose **Publish to** (with the number of accounts). Each post is listed under **Social** with its progress: **Publishing**, **Published**, **Failed**, **Taken down**. **Retry** a failed one, **Take down** removes a published one from the platform (the asset stays in Volt), and **Refresh views** updates the view counts.

### Check its history

1. Open the **History** tab. The timeline lists what happened to the asset, newest first: when it was made, built and encoded, its image, review and QC, where it was published, and changes people made. **Show all** shows more than the latest twelve.
2. **Published to** lists the catalogue and app publications with their status, date and views. **As approved** shows the review and QC state at the time; **re-cut since** means the asset changed after it went out, so the published copy is older.
3. **Where it came from: the recordings, files and segments it was made from** opens the chain of sources, and **Re-cuttable** says whether those sources are still kept.

### Work on several assets at once

1. Tick the boxes on the rows (or **Select all shown**). A bar shows how many are selected.
2. Choose **Fill from EPG** to fill the empty fields of every selected clip from its guide programme, or **Publish** to publish the ones not yet published. A number in brackets shows when an action applies to only some of the selection; hover over it to see why.
3. **Clear** deselects them.

## How it connects

| Section | How it relates |
|---|---|
| [Recordings](recordings.md) | Clips cut from a recording become assets here; **Open the recording** goes back to the source |
| [EPG](epg.md) | Programmes set to **Auto VOD** become assets, and **Fill from EPG** copies the programme's details |
| [Review](review.md) | Clips sent for review are decided there; the decision shows in the **Review** column |
| [Content Types](content-types.md) | Decide which metadata fields an asset has and which are required |
| [Publishing Rules](publishing-rules.md) | Decide where a publish goes, for how long, and whether review or QC must pass first |
| [Ingest Rules](ingest-rules.md), [Watchfolders](watchfolders.md) | Decide how uploaded and dropped files are named, typed and checked for duplicates |
| [Encoding Profiles](encoding-profiles.md) | The ladders uploaded files are encoded with |
| [Formats & reframing](formats-and-reframing.md) | Account settings for the **Formats** tab |
| [Images and thumbnails](images-and-thumbnails.md) | **Choose from library** picks from the Image Library |
| [Share links](share-links.md) | Private previews for people outside your organisation |
| [Storage](storage.md) | Where the files are kept |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the library, open assets and read every tab | Media library & publishing: View |
| Publish, publish again, remove access, publish to social, retry a social post | Media library & publishing: Operate |
| Save metadata, fill from the guide, change the image, set skip markers, re-run QC, change the asset's publishing rule, work its formats | Media library & publishing: Manage |
| See which files can be downloaded | Downloads: View |
| Download a file | Downloads: Operate |
| Upload files | Files, uploads & storage: Manage, and Account settings: Manage (see [Troubleshooting](#troubleshooting)) |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Nothing here yet** | No clips have been cut and no files uploaded | Cut a clip in [Recordings](recordings.md) or upload a file |
| **No assets match these filters** | The filters leave nothing | Choose **Clear filters** |
| **Queued to encode** or **Encoding** with a percentage | An uploaded file is still being encoded | Wait; the row updates when you choose **Refresh** |
| **Encode failed** | The file could not be encoded; hover over it for the reason | Check the file plays, then upload it again |
| **No rendered file for this asset.** or **Still being extracted…** on **Preview** | The asset is still being made | Wait and choose **Refresh** |
| **This asset has no playlist yet, so there is nothing to mark.** on **Skip markers** | Markers need the built asset | Wait until it is built |
| **Fill from EPG** is greyed out | It is an uploaded file (no guide slot), or it has no content type yet | Choose a **Content type** and save first; uploaded files are filled by hand |
| **No programme to fill from.** | No guide programme covers the clip | Fill the fields by hand |
| "The publishing rule requires review, and this asset is…" when publishing | Its **Publish gate** needs an approved review | Have it approved in [Review](review.md), or change the rule |
| "The publishing rule blocks publishing while QC has failed." | Its **Publish gate** blocks on a failed QC | Re-cut or replace it, then **Re-run QC** |
| A file shows **refused** when added | An ingest rule will not take it | Read the reason; change the file or the rule in [Ingest Rules](ingest-rules.md) |
| "Your role does not allow manage on Account settings" when adding files | Adding a file checks your ingest rules, which today needs Account settings: Manage | Ask an administrator to upload it, or to give you that access |
| **No downloadable file yet.** on **Encode** | No MP4, MP3 or AAC file was made | When cutting the clip in [Recordings](recordings.md), choose an **Output** that includes a downloadable file |
| A **Download** button is greyed out | Your role can see the files but not download them | Ask for Downloads: Operate |
| **No social accounts are linked.** in **Publish to social** | No social account has been linked | Choose **Link one**, or ask an administrator |
| **copy is old** in the Availability column | The asset changed after it was published | Publish it again so the published copy matches |
| **Couldn't load this asset.** | The asset could not be read | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/vod` | Lists assets, with the same filters as the page (for example `availability_state`, `review_state`, `media_type`, `q`, `sort`, `limit`) |
| `GET /api/vod/facets` | The counts behind the filter chips |
| `GET /api/vod/{id}`, `PUT /api/vod/{id}` | One asset; change its title, content type (`schemaId`) and `metadata` |
| `GET /api/vod/{id}/target-metadata`, `GET /api/vod/{id}/encode` | The **Metadata** and **Encode** tabs |
| `GET /api/vod/{id}/epg-fill`, `POST /api/vod/{id}/epg-fill` | Preview and apply **Fill from EPG**; `POST /api/vod/epg-fill` does several at once |
| `GET /api/vod/{id}/history`, `GET /api/vod/{id}/provenance` | Its history and where it came from |
| `GET /api/vod/{id}/availability`, `PATCH /api/vod/{id}/availability` | Its publishing rule for this item |
| `POST /api/vod/{id}/publish`, `POST /api/vod/{id}/withdraw` | Publish, and remove access |
| `GET /api/vod/{id}/markers`, `PUT /api/vod/{id}/markers/{kind}` | Skip markers (`intro`, `recap`, `credits`) |
| `GET /api/vod/{id}/image`, `PUT /api/vod/{id}/image`, `POST /api/vod/{id}/image/auto` | Its image |
| `POST /api/vod/{id}/qc` | Runs QC again |
| `GET /api/downloads/vod/{id}`, `POST /api/downloads/vod/{id}/link` | The downloadable files, and a short-lived link to one |

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-volt-host/api/vod?availability_state=draft&sort=-created_at&limit=20"
```

Files themselves are sent with the uploads API, as the console does. Every route is in the [API reference](/api-reference).
