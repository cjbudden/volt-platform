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
- **Finding things.** Search, sort and filter by asset type, source, public status (and what expires within a week), availability, how it was made, missing metadata, content type, resolution, codec, review state, date and length. The filters are part of the page address, so a filtered view can be bookmarked or sent to a colleague.
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
   | **Public status** | What a viewer gets now: **Draft**, **In review**, **Changes requested**, **Rejected**, **Processing**, **Scheduled**, **Available**, **Restricted**, **Expired**, **Archived** (only the ones in use are shown), and **Expires in 7 days**: available now and stops being available within a week |
   | **Availability** | **Not published**, **Scheduled**, **Available**, **Expired**, **Access removed** (only the ones in use are shown) |
   | **Created as** | **Recording**, **Clip**, **Upload**, **Watch folder** (only the ones in use are shown) |
   | **Metadata** | **Missing required**: a required field of its content type is empty, or it has no content type |

5. Choose **More filters** for **Content type**, **Top resolution**, **Codec**, **Review** (**Needs review**, **Approved**, **Published copy is old**), **Added** (a date range) and **Duration** (in minutes). **Clear filters** removes them all.
6. Switch between **List** and **Grid**. In the list, **Columns** adds or removes **Content type**, **Metadata**, **Top rendition**, **Codec**, **Renditions** and **Source blocks**. Your choice of view and columns is remembered in this browser.
7. The list shows 48 assets at a time. Use **Previous** and **Next** at the bottom to page through.

In the grid, an asset with no image yet is shown in its kind's colour: the key beside **Select all shown** says which colour is **Video**, **Audio** and **Song**.

### Upload files

1. Drop files, or a whole folder, on the band at the top of the page (**Drop files or a folder here**). Or choose **This device** or **Folder** to pick them. On a phone, **Camera roll** and **Record now** take their place.
2. To fetch a file from an address instead, choose **Link**, paste the address and choose **Import**. Volt's servers fetch it, so nothing passes through your computer. Cloud drive buttons beside it work when your Volt service has them set up; hover over a greyed one to see why.
3. Each file is listed with its size and what your [ingest rules](ingest-rules.md) decided before anything moves: the name it will be filed under, **looks like a duplicate** with what the rule says to do, or **refused** with the reason.
4. To give the files a content type and metadata, choose **Set type and metadata for all** beside **What are you adding?**, before you add them: with **Start as soon as added** on, a file starts uploading the moment it is added. Pick the **Content type**, fill in its fields, then **Done**. **Details** on one file sets them for that file only. Anything left empty is decided by the rules.
5. With **Start as soon as added** on (the usual setting), uploading starts at once. With it off, choose **Ingest 1 file** (or the number of files) when you are ready. **Clear** empties the list without uploading.
6. Progress shows under the band. A finished file appears in the library and starts encoding: its row shows **Queued to encode**, then **Encoding** with a percentage, then the renditions it made.

Uploads are resumable. While anything is uploading or waiting, a button in the top bar, beside the bell, follows you around the console (for example **40%** while files upload, or **1 waiting**). Choose it to open the **Ingest Queue**, where you can pause, resume or cancel a file, **Cancel all**, **Retry** failed files or **Clear** finished ones. Under **Needs you** it lists files the rules held back:

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

1. **Preview** plays the asset. Audio plays with an audio player. Under a video, the timecode (HH:MM:SS:FF) and the frame number show where you are.
   - **To step frame by frame,** pause, click the preview (or the timecode under it), then press the left and right arrows. Each press moves one frame, and **Exact frame** over the picture shows that exact frame, with its number and timecode, as Volt decodes it. Playing again, or moving the playhead another way, goes back to the player's own picture. While the video plays, the arrows jump 10 seconds.
   - A new asset needs a few seconds before its timecode appears, while Volt indexes its frames. At 29.97 and 59.94 frames per second the timecode is drop-frame (HH:MM:SS;FF).

   ![The Media Library preview paused on exact frame 5, with its frame number and timecode over the picture](/img/screens/media-library-exact-frame.png)

2. **Facts** lists its kind, length, how it was built, how much of the source it covers, and its **Review** and **QC** state. For an uploaded file it also shows the **Source file**, the **Ladder** it was encoded with and the **Formats** made. When a retention rule has taken the original out of the cloud, **Original** says where its archive copy is; when an encode or a FAST channel needs it, it says **Coming back from the archive** and what runs once it lands ([Storage](storage.md#take-originals-out-of-the-cloud-once-they-are-archived)). Beside **Review**, **Send for review** puts a draft or rejected clip into the [Review](review.md) queue (**Send back for review** for an approved one), and **Open in Review** opens a clip that is already waiting.
3. **HLS manifest** opens the streaming address. The **Download** buttons (for example **Download MP4**) appear if your role includes downloads.
4. Under **Image**, Volt picks a picture for the asset by itself: the best frame, a programme image, station artwork or an album cover, and says why. To change it, click one of the **Frames considered, best first**, or choose **Choose from library**. **Pick again** (or **Pick automatically**, after you chose one by hand) lets Volt choose again.
   To use a frame you can see in the player, pause on it (the arrow keys step one frame at a time) and choose **Use this frame as the image** under the player. That exact frame is saved to the Image Library in the asset's folder and becomes the image; Volt does not replace it with an automatic pick.
   How Volt chooses: it reads about three dozen frames across the video and keeps the best dozen, no two from the same shot. A clear, well-lit, good-sized face counts for most, so in a video with people a frame of hands or an empty room is passed over; a face in deep shadow counts for less. A well-exposed frame beats a dim one, and a dark, moody frame with lit highlights is marked **low light** rather than thrown away as black. To apply this to an asset added before, choose **Rebuild from source** under **Image**.
5. For an uploaded file, **Rebuild from source** takes the stills and preview sprite sheets again from the original file.
6. For a song or a music video, **Find song details** searches music catalogues by **Artist** and **Song**, or reads a page or cover link you paste. Tick what to change in the results and choose **Apply**. Nothing changes until you do. A music video stays a music video, and its picture stays a frame of the video: the album cover is offered, not ticked.

### Describe it (Metadata)

1. Open the **Metadata** tab. **Target metadata** shows the asset's content type, how complete it is (a percentage, and how many fields are filled, such as 3 of 5), and each field as filled, **Empty**, or **Required** and still empty. A field marked **EPG** was filled from the guide.
2. To fill fields from the programme the asset was cut from, choose **Fill from EPG**. Check the **Programme** (Volt picks the one that covers most of the clip), tick the fields to **Use**, and choose **Apply**. Empty fields are ticked for you; a value someone typed is only replaced if you tick it. If the guide describes the programme as a different content type, you can tick **Change the content type to** that type.
3. To fill fields from the file's name, choose **Read from file name**. Each part of the name is shown with what it was read as (for example `S01E03` as season and episode, `1080p` as resolution, `Official Trailer` as a promo marker), followed by what would change: the **Content type** with how sure Volt is and why, the **Asset title**, and fields such as **Series**, **Season**, **Episode number**, **Year** and **Kind**. Empty fields are ticked for you; a value someone typed is marked **Typed by a person** and is only replaced if you tick it. For a trailer or promo you also choose what it promotes: the records Volt found, each with how alike it is and why, **Let Volt decide**, or **Leave the link as it is**. Choose **Apply**. A field marked **File name** was filled this way.
   When the reading misses something, **Parts of the name** splits the name where its strongest separator is (`21_josh-woodward_saboteurs_1080p.mp4` becomes `21`, `josh-woodward`, `saboteurs` and `1080p`) and lets you choose a field for each part under **Use as**. A number is marked as one (often a track number or a count) and a recognised part such as `1080p` says what it is; both start as **Not used**. For a song or music video Volt guesses the artist and then the title from the last two text parts; check the guess before you apply. A field set from a part replaces what the reading or the field held, the reading's row for it says **Set from the parts below**, and a Title set this way also names an asset that is still called by its file name. Mapping parts is only ever done by a person: files being added are never mapped this way.
4. Below, change the **Content type** if this asset should be described differently from its channel or event, fill in its fields, and choose **Save metadata**.
   **Find details…**, under the content type, looks the title up for you and shows what it found beside what the asset has:
   - For a **Song** or a **Music video** it opens **Find song details** (above).
   - For any other content type, including one you made yourself, it searches **Wikidata**, the free, open knowledge base behind Wikipedia. **Search for** starts with the title field's value; change it if the title is spelled differently there (an original title, or the year after the name). Choose the right item: items of the kind your content type describes, such as films for a Movie, come first, each with Wikidata's short description. Tick what to use and choose **Apply**. Empty fields are ticked for you; a value already there changes only if you tick it, and one someone typed is marked **entered by a person**. You can correct a found value before you apply it. A found image is copied into the Image Library. Each field you apply remembers that it came from Wikidata and which item.
   - **Or paste a link to a page about it** takes the title's own page on another site, such as a studio's or festival's page for a film, a broadcaster's page for an episode, a news article or a podcast episode's page. Choose **Read page**: Volt reads that one page, once, for the details it publishes about itself for search engines and link previews (schema.org data and Open Graph tags), and shows it first among the results as **From the page on** its site, with the kind of thing the page says it is. Choose it and tick what to use as for a Wikidata item. Each field you apply remembers the page it came from. A pasted image address fills the image field only.
   - Not sure where the title's own page is? **Search the web**, beside **Search**, opens a web search for what is in **Search for** in a new tab of your browser. Open the result that is the title's own page, copy its address, paste it into **Or paste a link to a page about it** and choose **Read page**. Volt does not run the web search itself or see what you search for; it only reads the page you paste.
   - **Read with AI**, beside **Read page**, is there when your account has the **AI Find details** add-on (an account administrator turns it on in [Billing](billing.md#add-ons-and-packs)). Use it for a page that publishes no details for search engines, such as a film's page on a small studio's or festival's site. An AI model reads the page's text and suggests values for the fields it can fill from text (not images); each suggestion shows, in italics under it, the sentence of the page it came from, so you can check it. A suggestion whose sentence is not on the page is left out, and the panel says how many were. Tick what to use and choose **Apply**, as for a Wikidata item: nothing is saved until you do, and each field you apply remembers the page, that it was read by AI, and its sentence.
     Each page read with AI counts one lookup of the month's allowance, shown under the button (for example **499 of 500 AI lookups left this month**). Reading the same page again for the same title that day shows the earlier answer and is not counted, and a reading the AI model could not finish is not counted either. When the month's lookups are used up, Volt says so, names the next pack, and sends nothing more to the AI model until a bigger pack is chosen in **Billing** or the 1st comes round. Without the add-on, the panel says it exists and where it is turned on.
   - Some sites do not let programs read their pages; Volt says so, and you can copy the details from the page yourself. A page that publishes no details (a search page, a home page) is said to have nothing to read.
   - Fields are matched by their **schema.org** property (set on the field in [Content Types](content-types.md)). A field with none, or one Wikidata knows nothing about, is listed under **Not filled from Wikidata** (for a page, **No schema.org name, so never filled from a page**).

   ![Find details with a pasted link: the film's page on its site shown first, then the Wikidata result, and the fields to tick beside what the asset has](/img/screens/media-library-find-details-link.png)
   - Save or discard your own changes first: **Find details…** works on what is saved.

   ![Find details on a film: the search, the items Wikidata found with the film first, and the fields to tick beside what the asset has](/img/screens/media-library-find-details.png)
5. A field that points at another record, such as a trailer's **Trailer for**, is a search box. Type part of the name and choose the record; it shows as **Linked**, with the record's type, and **Change** or the cross to remove it. If the record is not in the library yet, choose **Keep "…" as a name, not linked to a record**: it shows in a dashed box as **Not linked to a record**, with any records Volt suggests under **Is it one of these?**. A link Volt made itself says **Linked automatically** and how sure it was; open **Why this record** for the reasons.
6. **Related content** lists what the asset links to and, for a film or episode, its **Trailers and promos**. **Open** goes to that record.

**Fill from EPG** is not offered for uploaded files, which have no guide slot.

When a file is added, Volt reads its name in the same way and applies only what is clear: the content type when nobody chose one and Volt is at least 80% sure with no conflicting signal, empty fields, and a trailer's link when exactly one record matches clearly. Anything less certain is left for you under **Read from file name**. What is applied automatically is set under **File names** in [Ingest Rules](ingest-rules.md).

### See how it was encoded (Encode)

The **Encode** tab shows the **Workflow** and **Ladder profile**, the **Source / mezzanine** it was made from, every rendition with its resolution, bitrate, codec, profile and frame rate, the audio tracks and the captions. For audio it shows the audio encode instead.

An uploaded or dropped file with no picture, such as an MP3, WAV, M4A, AAC or FLAC file, becomes an **audio asset**: Volt encodes its sound alone to one AAC track (128 kb/s stereo, 48 kHz), packaged as HLS and DASH, and the asset plays with the audio player. Cover art inside an MP3 is not a picture, so it does not make the file a video. An audio asset has no stills, previews or social formats; give it a **Cover** image on its page. A file with neither picture nor sound is refused, with the reason on the asset.

**Deliveries** lists each format (HLS, DASH, downloadable files) as **Ready**, **Being made**, **Requested, not made** or **Not requested**; it reports, it does not make files. **Download** lists the files you can take a copy of, with a **Download** button on each. A clip gets an MP4, MP3 or AAC file when it is cut in [Recordings](recordings.md) with an **Output** that includes one. An uploaded file gets an MP4 when it is already H.264 video with AAC sound in an MP4 or MOV file; any other upload plays as HLS and DASH only. Anything Volt has not recorded says **Not recorded**, and **What is not recorded** lists the gaps, so nothing is guessed.

### Mark the intro, recap and credits (Skip markers)

1. Open the **Skip markers** tab. Volt finds intros and credits by itself after each build, by comparing the asset with other episodes of its series. A marker it is not sure of is shown as **Suggested**.
2. Play to the right place and choose **Add at playhead** for **Intro**, **Recap** or **Credits**. Then adjust it: type the start and end times, choose **Start here** or **End here** at the playhead, or drag the marker's edges on the bar.
3. **Preview** plays from just before the marker so you can see the skip button viewers get. **Use it** accepts a suggestion; **Remove** deletes a marker.
4. **Detect now** runs the detection again. It never changes a marker set or accepted by hand.

Changes reach viewers the next time their player loads the playlist; nothing is rebuilt.

### Make social formats (Formats)

The **Formats** tab frames a 9:16, 1:1 and 4:5 version of the asset by following the people in the picture. Choose **Analyse the picture**, check and adjust the framing, then **Approve** and **Render** each format. See [Formats & reframing](formats-and-reframing.md#check-and-adjust-one-asset).

### See what viewers get, and when (Availability)

The top of the **Availability** tab says what a viewer gets right now and why.

![The Availability tab: the public status and its reason, the lifecycle with today marked, the dates, Listing, Archive and Who can watch](/img/screens/media-library-availability.png)

1. Open the **Availability** tab. The first line is the asset's **public status** with the reason, for example **Available** and "Available until 16 Dec 18:00 UTC", and when it changes on its own.

   | Public status | What a viewer gets |
   |---|---|
   | **Draft**, **In review**, **Changes requested**, **Rejected** | Nothing: it is not published. Viewers' apps get the same answer as for a title that does not exist |
   | **Processing** | Nothing yet: it is published but the media is still being made. It goes live on its own when ready |
   | **Scheduled** | Nothing yet: its window has not opened. With a **Listed from** date that has passed, apps show it as a teaser (title, artwork and when) with no way to play |
   | **Available** | It can be found and played, inside its rules (regions, sign-in, payment) |
   | **Restricted** | Nothing: it is published, but its [rights](rights.md) do not allow it now |
   | **Expired** | Nothing: its window has closed. Extending the window brings it back |
   | **Archived** | Nothing: it is off the catalogue. The media is kept and it can be restored |

2. The steps **Draft**, **Scheduled**, **Available**, **Expired** and **Archived** show where it is in its life, and the bar below shows those stretches in proportion with today marked. The window a viewer gets is the publish window inside the rights window, so the rights can shorten it.
3. Below are **Available from**, **Available until**, **Listed from** and whether it is **In browse and search** now (**No, by link only** when it is unlisted).

### Show it early, or keep it out of browse (Listing)

1. Under **Listing**, set **Listed from** to a date before it becomes available to show it early as a teaser. Clear the date to list it when it becomes available.
2. Tick **Unlisted** to keep it out of browse and search for good. It still plays for anyone with the link.
3. Choose **Save listing**. It takes effect at once; nothing is encoded again.

### Archive it, and restore it

1. Choose **Archive…**, then **Archive**. The title leaves the catalogue and stops playing at once, including for viewers who already started it; its publishing points are withdrawn. The media is kept.
2. To bring it back, open the archived asset's **Availability** tab and choose **Restore as draft** (its dates are kept, nothing is published) or **Restore and publish** (it is published again through its rules, with every check). If publishing is refused, it is restored as a draft and the message says why.

### Check who can watch

1. Under **Who can watch**, enter a **Country** (two letters, for example **GB**), choose a **Viewer** (**Not signed in**, **Signed in**, or **Signed in and has paid**) and, to ask about another moment, a date under **When**.
2. Choose **Test**. The answer is the play gate's own decision: **Plays**, **Teaser, no play**, **Not found**, **Paywall**, **Sign in** or **Blocked**, the reason, the step that decided it and the status at that moment.
3. It cannot know the page the player is on (a rule's **Allowed referrer domains**) or a real viewer's purchases, so it says so under the answer.

### Publish it, or take it off (Availability)

1. Further down the **Availability** tab, **Publishing** shows the publishing state and, if published, from and until when.
2. **What a publish does for this item** shows the publishing rule it follows: **Publish to**, **Auto-publish**, **Available from**, **Expires**, **Geo access**, **Access**, **Paywall**, **Publish gate** and **Access rules**. Grey values are inherited from the account, its content type and its channel, event or station ([Publishing Rules](publishing-rules.md)).
3. To change a value for this asset only, tick the field, set it, and choose **Save publishing rule**. **Before you save** checks it as on any rule: **This title** says whether it is published and whether the save changes anything, and a red line blocks the save. A field locked by the account, the content type, the channel, event or station, or a metadata rule cannot be set here; if the asset was given a value of its own before the lock, its row says **Save is refused until it is cleared**: choose **Clear it**. Turning **DRM** on or off for a published asset asks first, because its files must be packaged again; a saved change to a published asset applies at once.
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

### Delete an asset

1. Open the asset and its **Metadata** tab. At the bottom, **Delete this asset** says what deleting does; choose **Delete asset**.
2. The window lists what goes with it (its metadata, markers, formats, reviews and publishing points) and says if it is playing to viewers now, which stops. If something prevents the delete (for example the asset is in a FAST channel's active run order), it says so and **Delete asset** stays unavailable.
3. Type the asset's title to confirm, then choose **Delete asset**.

The asset and its media go to **Storage > Recently removed** for a number of days, which the message names. **Undo** on that message, or **Restore** in [Storage](storage.md), puts it back with its metadata and media. Posts already on social platforms stay there. The delete is in the [audit log](audit-log.md) with your name. Uploaded and watch folder files are deleted the same way.

### Work on several assets at once

1. Tick the boxes on the rows (or **Select all shown**). A bar shows how many are selected.
2. Choose **Fill from EPG** to fill the empty fields of every selected clip from its guide programme, **Read from file name** to apply what each file's name makes clear (nothing a person typed or chose is replaced; the message says how many need a look), or **Publish** to publish the ones not yet published. A number in brackets shows when an action applies to only some of the selection; hover over it to see why.
3. **Clear** deselects them.

## How it connects

| Section | How it relates |
|---|---|
| [Recordings](recordings.md) | Clips cut from a recording become assets here; **Open the recording** goes back to the source |
| [EPG](epg.md) | Programmes set to **Auto VOD** become assets, and **Fill from EPG** copies the programme's details |
| [Review](review.md) | Send a clip there with **Send for review** on its **Preview** tab; the decision shows in the **Review** column |
| [Content Types](content-types.md) | Decide which metadata fields an asset has and which are required |
| [Publishing Rules](publishing-rules.md) | Decide where a publish goes, for how long, and whether review or QC must pass first |
| [Ingest Rules](ingest-rules.md), [Watchfolders](watchfolders.md) | Decide how uploaded and dropped files are named, typed and checked for duplicates |
| [Encoding Profiles](encoding-profiles.md) | The ladders uploaded files are encoded with |
| [Encoding Queue](encoding-queue.md) | Where each upload's encode waits and runs; **Encode job and log** on the **Encode** tab opens it |
| [Collections](collections.md) | Tick assets and choose **Add to collection**; the **Collections** rail beside the list narrows the library to one collection |
| [Formats & reframing](formats-and-reframing.md) | Account settings for the **Formats** tab |
| [Images and thumbnails](images-and-thumbnails.md) | **Choose from library** picks from the Image Library |
| [Share links](share-links.md) | Private previews for people outside your organisation |
| [Storage](storage.md) | Where the files are kept |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the library, open assets and read every tab | Media library & publishing: View |
| Test who can watch | Media library & publishing: View |
| Publish, publish again, remove access, archive and restore, publish to social, retry a social post | Media library & publishing: Operate |
| Set Listed from and Unlisted, save metadata, fill from the guide, change the image, set skip markers, send for review, re-run QC, change the asset's publishing rule, work its formats | Media library & publishing: Manage |
| See which files can be downloaded | Downloads: View |
| Download a file | Downloads: Operate |
| Delete an asset | Media library & publishing: Manage |
| Upload files, import a link, and fill in or settle held files | Files, uploads & storage: Manage (the **Media Librarian** template has it) |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Nothing here yet** | No clips have been cut and no files uploaded | Cut a clip in [Recordings](recordings.md) or upload a file |
| **No assets match these filters** | The filters leave nothing | Choose **Clear filters** |
| **Queued to encode** or **Encoding** with a percentage | An uploaded file is still being encoded | Wait; the row updates when you choose **Refresh** |
| **Queued at site** or **Encoding at site**, with **At site** beside **Building** | The file came from an **Encode at site** watchfolder and a server at your site is encoding it; the original stays there | Wait. If it stays queued, check the site's servers in [Hybrid Sites](hybrid-sites.md); the item's page says which site |
| **Sending to cloud** or **In the cloud** beside **Building** | The site did not take the encode within the watchfolder's fallback time, so the original is being sent to Volt and encoded in the cloud | Nothing to do; the item's page says why. See [Hybrid Sites](hybrid-sites.md#when-the-site-does-not-encode-it-fall-back-to-the-cloud) |
| **Encode failed** | The file could not be encoded; hover over it for the reason | Check the file plays, then upload it again |
| **Encode failed** with *the original is in the archive: it is being brought back* | The original was taken out of the cloud and the encode needed it | Nothing: the original is restored from the archive and the encode is queued again once it lands |
| **No rendered file for this asset.** or **Still being extracted…** on **Preview** | The asset is still being made | Wait and choose **Refresh** |
| **This asset has no playlist yet, so there is nothing to mark.** on **Skip markers** | Markers need the built asset | Wait until it is built |
| **Fill from EPG** is greyed out | It is an uploaded file (no guide slot), or it has no content type yet | Choose a **Content type** and save first; uploaded files are filled by hand |
| **No programme to fill from.** | No guide programme covers the clip | Fill the fields by hand |
| **Not linked to a record** on a trailer's **Trailer for** | The name did not match one record clearly: none was alike enough, or two were too close to tell apart | Choose one under **Is it one of these?**, or **Find the record**. When the film is added later, Volt links a name it filled in itself, and suggests the film for a name you typed |
| The content type did not change after an upload whose name says trailer or S01E03 | A type was chosen when it was added, an ingest rule names the type, or the name points two ways (for example **Interview** and **Clip**) | Open **Read from file name** to see the reasons, and tick **Change the content type to** if it is right |
| "a record cannot be linked to itself" or "linking back would make a loop" | The record chosen is this one, or it already links to this one the same way | Choose another record |
| "The publishing rule requires review, and this asset is…" when publishing | Its **Publish gate** needs an approved review | Have it approved in [Review](review.md), or change the rule |
| "The publishing rule blocks publishing while QC has failed." | Its **Publish gate** blocks on a failed QC | Re-cut or replace it, then **Re-run QC** |
| A file shows **refused** when added | An ingest rule will not take it | Read the reason; change the file or the rule in [Ingest Rules](ingest-rules.md) |
| **No downloadable file.** on **Encode** | No MP4, MP3 or AAC file was made: the clip was cut without one, or the uploaded file is not H.264 with AAC sound in MP4 or MOV | For a clip, cut it again in [Recordings](recordings.md) with an **Output** that includes a downloadable file. For an upload, upload it again in that form |
| A cloud drive button is greyed out when adding files | Your Volt service has not set that drive up | Upload from your device or a link, or ask your Volt provider |
| A **Download** button is greyed out | Your role can see the files but not download them | Ask for Downloads: Operate |
| **No social accounts are linked.** in **Publish to social** | No social account has been linked | Choose **Link one**, or ask an administrator |
| **copy is old** in the Public status column | The asset changed after it was published | Publish it again so the published copy matches |
| **Restricted** although it is published | Its rights do not allow on-demand use now: the use, the territories or the rights window | Open the **Rights** tab; the reason on **Availability** names the profile |
| **Restored as a draft. It could not be published: …** | **Restore and publish** brought it out of the archive, but its rules or rights refuse publishing | Fix what the message names, then choose **Publish** |
| **Not found** in **Who can watch** for a title you can see | It is not public for that moment (draft, processing, scheduled without a teaser, restricted, expired or archived) | Read the status line under the answer |
| **Couldn't load this asset.** | The asset could not be read | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/vod` | Lists assets, with the same filters as the page (for example `public_status`, `expires_within_days=7`, `availability_state`, `review_state`, `media_type`, `q`, `sort`, `limit`). Each row carries `public_status`, `status_reason`, `status_until` and `editorial_state` |
| `GET /api/vod/facets` | The counts behind the filter chips |
| `GET /api/vod/{id}`, `PUT /api/vod/{id}` | One asset, with its public status computed at that moment (`public_status`, `status_reason`, `status_until`, `editorial_state`, `effective_from`, `effective_until`, `publicly_visible`, `publicly_listed`); change its title, content type (`schemaId`) and `metadata` |
| `GET /api/vod/{id}/target-metadata`, `GET /api/vod/{id}/encode` | The **Metadata** and **Encode** tabs |
| `GET /api/vod/{id}/epg-fill`, `POST /api/vod/{id}/epg-fill` | Preview and apply **Fill from EPG**; `POST /api/vod/epg-fill` does several at once |
| `GET /api/vod/{id}/from-filename`, `POST /api/vod/{id}/from-filename` | Preview and apply **Read from file name**; `POST /api/vod/from-filename` applies only what is clear to several at once |
| `GET /api/vod/{id}/finder` | Which **Find details…** the asset's content type uses (`song` or `general`), the default search term, and `ai`: whether AI Find details is offered and on for the account, with this month's allowance |
| `POST /api/vod/{id}/details/find`, `POST /api/vod/{id}/details/use` | Search Wikidata (`{"q"}`, default the title) and see each item mapped onto the type's fields; then write the fields you choose (`{"source":"wikidata","itemId","values"}`), each recorded in `metadata_provenance` |
| `POST /api/vod/{id}/details/page` | Read one page you name (`{"url"}`) for its schema.org and Open Graph details, mapped onto the type's fields the same way; use them with `{"source":"page","link","values"}` on `details/use` |
| `POST /api/vod/{id}/details/ai` | With the AI Find details add-on: read one page (`{"url"}`) with an AI model; each value in `result.proposed` has its sentence in `result.from`. One lookup of the month's allowance (`403 addon_required` without the add-on, `409 allowance_exceeded` when used up). Use them with `{"source":"ai","link","lookupId","values"}` on `details/use` |
| `GET /api/vod/{id}/schema.org` | The asset as schema.org JSON-LD (a `VideoObject`, or a `Clip`) for search engines and partners, always with its watch page in `embedUrl`. Its plain video addresses (`contentUrl`, `associatedMedia`) are included only for a token-free title or, where play tokens are not enforced, a title nothing about the viewer decides (see [Publishing Rules](publishing-rules.md#play-without-tokens-token-free-playback)) |
| `GET /api/vod/{id}?include=linkedContent` | The asset with the records it links to and the ones linking to it, one level deep |
| `GET /api/vod/{id}/links`, `PUT /api/vod/{id}/links/{field}`, `DELETE /api/vod/{id}/links/{field}` | Its links; link a record with `{"assetId"}`, keep a name with `{"name"}`, or remove it |
| `GET /api/vod/link-candidates?q=` | Records a link field can point at, best match first |
| `GET /api/vod/{id}/history`, `GET /api/vod/{id}/provenance` | Its history and where it came from |
| `GET /api/vod/{id}/availability`, `PATCH /api/vod/{id}/availability` | Its publishing rule for this item: `{"override": {...}}`, `{}` to follow the rules again. Refused with `422 policy_conflict` for a field locked beneath it or a conflict it brings; `409 confirm_repackage` until sent with `"confirm": true` when it changes DRM on a published item; `?dryRun=1` checks without saving |
| `POST /api/vod/{id}/publish`, `POST /api/vod/{id}/withdraw` | Publish, and remove access |
| `PUT /api/vod/{id}/availability` | **Listed from** and **Unlisted**: `{"listedFrom": "2026-12-01T09:00:00Z", "unlisted": false}` (`null` for the default) |
| `POST /api/vod/{id}/archive`, `POST /api/vod/{id}/unarchive` | Archive (optional `reason`), and restore with `{"to": "draft"}` or `{"to": "published"}` |
| `POST /api/vod/{id}/evaluate` | **Who can watch**: `{"country": "GB", "viewer": "anonymous", "at": "2026-12-01T12:00:00Z"}` in, the play gate's answer (`outcome`, `http`, `message`, `decidedBy`, `status`) out |
| `GET /api/vod/{id}/markers`, `PUT /api/vod/{id}/markers/{kind}` | Skip markers (`intro`, `recap`, `credits`) |
| `GET /api/vod/{id}/frame-index`, `GET /api/vod/{id}/frame` | The asset's frame rate and frame count, and one exact frame as an image (by `n`, `tc` or `ms`) |
| `GET /api/vod/{id}/image`, `PUT /api/vod/{id}/image`, `POST /api/vod/{id}/image/auto` | Its image |
| `POST /api/vod/{id}/qc` | Runs QC again |
| `GET /api/downloads/vod/{id}`, `POST /api/downloads/vod/{id}/link` | The downloadable files, and a short-lived link to one |

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-volt-host/api/vod?availability_state=draft&sort=-created_at&limit=20"
```

Files themselves are sent with the uploads API, as the console does. Every route is in the [API reference](/api-reference).
