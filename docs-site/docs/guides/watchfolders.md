---
title: Watchfolders
sidebar_position: 9.3
description: Set up drop folders that Volt watches, sort what arrives with filename rules, and deal with the files no rule accepts.
guide: section
---

# Watchfolders

A watchfolder is a folder Volt keeps an eye on. Files dropped into it are sorted by the folder's rules into the Image Library, the Media Library or Loops & Fillers, and captions and metadata files are attached to the video they are named after. A new folder starts with default rules by file type, so images, video, audio, captions and metadata files are taken in from the first drop; a file that matches no rule is moved to a review folder and listed for a person, never deleted and never guessed at. Most people come here to add a rule, or to clear the files waiting for review.

![A watchfolder's page: its path and Scan now button, the numbered rules (two of the folder's own, one with an image type, then the four default rules by file type) with the one that would win highlighted, the Try a filename box, and the queue of files that need a person](/img/screens/watchfolders.png)

## What it is for

- **Regular deliveries.** Slates, posters, logos, programmes and loops that arrive from an agency, an edit suite or another system go into one folder and land in the right library on their own.
- **Sorting by type, out of the box.** Every new folder sends images to the Image Library, video and audio to the Media Library, and attaches captions and metadata files to their video, with five default rules you can change or switch off.
- **Artwork that finds its episode.** `Scrubs-s1-e1_poster.png` becomes the Poster of `Scrubs-s1-e1.mp4`, and `Scrubs-s1-e1-thumbnail.jpg` its Thumbnail, from the word at the end of the name or the image type on the rule.
- **Subtitles with their programme.** Drop `Scrubs-s1-e1_en.vtt` beside `Scrubs-s1-e1.mp4` and the episode gets an English subtitle track, in either order (see [Captions and metadata files by name](#captions-and-metadata-files-by-name)).
- **Sorting by name.** Rules match the file name, such as `slate_*.png`, and say what kind of file it is. The first rule that matches wins.
- **Nothing lost on a guess.** A file no rule accepts, or that a rule refuses, is moved to the folder's review folder and listed in the **Queue** until someone deals with it.
- **Checking before you drop.** **Try a filename** shows what would happen to a file before it arrives.
- **Folders on your own storage.** With the Hybrid Sites add-on, a watchfolder can be on a NAS or server at one of your sites. The site's agent sorts it with the same rules, keeps refused files at the site and uploads accepted files to Volt: video, audio, images, slates, captions and metadata files.

Media operations staff and librarians use it day to day; an administrator usually sets the folders up.

## Before you start

- The folder's path as Volt sees it. Volt can only watch folders it can reach; ask your Volt contact which paths your account can use.
- For video files, the encoding ladder they should be encoded to ([Encoding Profiles](encoding-profiles.md)). Without one, the account default is used.
- **Files, uploads & storage: Manage** to create a watchfolder or change its rules (see [Who can do it](#who-can-do-it)).

## Step by step

### Create a watchfolder

1. Open **Admin** and choose **Watchfolders** (under **Media setup**).
2. Choose **New watchfolder**.
3. Type a **Name** and the folder's path, then choose **Create**. The new folder opens, with the [default rules by file type](#default-rules-by-file-type) already in its list.

Volt scans every watchfolder automatically every minute. A file still being copied in is left until it has stopped changing.

### Create an on-prem watchfolder

With the Hybrid Sites add-on, a watchfolder can be on storage at one of your [sites](hybrid-sites.md), such as a NAS share in your broadcast centre. The site's agent scans it there, with the rules you set on this page.

1. Choose **New watchfolder**, then **On-prem, at a site**. (Without the add-on the form has no such choice.)
2. Pick the **Site**, type a **Name** and the folder's path **on the site's server**, such as `/mnt/nas/drop`, then choose **Create**. The folder starts with the same default rules by file type as any other watchfolder.
3. Add rules as for any watchfolder.

![The New watchfolder form with On-prem, at a site chosen: the name, the site, and the folder's path on the site's server](/img/screens/watchfolders-on-prem.png)

What happens to a file in an on-prem folder:

- The agent waits until the file has stopped changing for 10 seconds, then decides it with the folder's rules.
- A file the rules refuse goes to the review folder **at the site** and is listed in the **Queue** here. It never leaves your network.
- An accepted video file is uploaded to Volt (**Upload and encode in the cloud**), then goes through your [Ingest Rules](ingest-rules.md) and is encoded like any upload. A dropped connection or a restarted server does not start the upload again: it carries on from where it stopped.
- Audio is uploaded and becomes an audio asset in the Media Library, like an audio file you upload.
- Images, slates, captions and metadata files are uploaded too, then taken in exactly as from a watchfolder on Volt: images to the Image Library (and, by name, to their video as a poster or thumbnail), slates to Loops & Fillers, captions and metadata files to their video. The original always stays at the site.
- A caption that arrives before its video waits for it, up to 24 hours, without being uploaded twice. If it then goes to **Needs review**, the agent moves the file into the review folder **at the site**; until it has, the entry says "Waiting for the site agent to move it into the review folder".
- A file over its limit is not uploaded at all: an image over the folder's size limit is marked **Failed**, a caption or metadata file over 25 MB goes to **Needs review** at the site.

The folder's page says which site it is on (**On** and the site's name) and when the agent last looked at it. There is no **Scan now**: the agent looks at the folder every few seconds. **Where it is encoded** is **Upload and encode in the cloud** (the default, described above) or **Encode at site**: the site's servers encode its videos and audio, only the finished streams are uploaded, and the original stays at the site. Images, captions, slates and loops are uploaded either way. How it works and what the servers need is in [Hybrid Sites](hybrid-sites.md#encoding-at-the-site). With **Encode at site**, **If the site does not encode it** says what happens when no server of the site takes an encode: **Wait for the site** (the default; the original never leaves your storage), or **Encode in the cloud after** a time from 15 minutes to 1 day, when the agent sends the original and Volt encodes it ([how the fallback works](hybrid-sites.md#when-the-site-does-not-encode-it-fall-back-to-the-cloud)).

A watchfolder can also be a folder in a storage bucket instead of a path (set up through the API, see [Through the API](#through-the-api)). Where your Volt runs on AWS, a bucket folder under `watch/` in Volt's own bucket is taken in as soon as a file finishes uploading, usually within seconds, and Volt also looks through every bucket folder once an hour in case a file was missed.

### Default rules by file type

Every new watchfolder starts with one rule per file type, at the bottom of its list and marked **Default**:

| Rule | Matches | Goes to |
|---|---|---|
| **Images to the Image Library** | `png`, `jpg`, `jpeg`, `webp`, `gif`, `tif`, `tiff` | The Image Library, as an image (`image`) |
| **Video to the Media Library** | `mp4`, `mov`, `m4v`, `mxf`, `mkv`, `ts`, `webm` | The Media Library, encoded to the folder's ladder (`vod`) |
| **Audio to the Media Library** | `mp3`, `wav`, `m4a`, `aac`, `flac` | The Media Library as an audio asset, encoded to its sound alone and played with the audio player (`vod`) |
| **Captions to their video** | `srt`, `vtt`, `ttml`, `dfxp` | The video they are named after, as a subtitle track (`companion`) |
| **Metadata files to their video** | `json`, `xml`, `nfo`, `csv` | The video they are named after, as a metadata file to review (`companion`) |

They are ordinary rules: **Try a filename** shows them, and you can move, switch off or delete them like any other.

- **Your own rules come first.** A rule you add goes above the default rules, so `loop_*.mp4` to Loops & Fillers wins over the video default for those files, and every other video still goes to the Media Library.
- **On** and **Off** on a rule's row switch it off and on again. A file the rule would have caught goes to the rules below it, or to review. The rule keeps its place in the list.
- **A file nothing recognises still goes to review**, such as a project file or a PDF.
- **Folders made before the default rules** keep exactly the rules they have. **Add default rules**, next to **Rules**, adds the ones the folder lacks after its own rules, so nothing it does today changes. The button also appears when a default rule has been deleted, and adds it back.
- An on-prem folder starts with the same default rules. One made before images, audio and captions crossed from a site has the video rule only; **Add default rules** adds the rest.

### Captions and metadata files by name

A caption or metadata file is attached to the video whose file name, without its extension, its own name starts with. `Scrubs-s1-e1_en.vtt`, `Scrubs-s1-e1.fr.srt` and `Scrubs-s1-e1.json` all go with `Scrubs-s1-e1.mp4`.

- **The rest of the name sets the language and the flags**: `_en`, `.fr`, `-pt-BR`, `.eng` for the language, `.sdh` (or `.cc`) for subtitles for the deaf and hard of hearing, `.forced` for forced subtitles. A caption becomes a subtitle track in the video's HLS and DASH as soon as it is attached, and appears on the asset's **Companion files** tab like one you upload there.
- **The most specific name wins.** With `Show-e1.mp4` and `Show-e10.mp4` in the library, `Show-e10_en.vtt` goes with episode 10. The video's name must end where a separator (`_`, `.`, `-` or a space) or the end of the caption's name begins, so `Show-e1` never takes episode 10's subtitles.
- **Where Volt looks**: videos this watchfolder has taken into the Media Library, in the same subfolder first. A caption is never attached to a video from another folder.
- **Either order.** A caption that arrives before its video is **Waiting**, with "waiting for its video" under it, and is attached on the pass after the video lands. With no video after **24 hours** it goes to **Needs review** with the reason, and the file to the review folder. Drop the video and **Reprocess** it, or add the file on the asset page.
- **A metadata file is attached, not applied.** Its values wait on the asset's **Companion files** tab for someone to review and apply them.
- **Up to 25 MB each**, the same limit as on the asset page. A larger file goes to **Needs review** at once. A caption Volt cannot read is attached switched off, and the reason says so; the asset page shows what is wrong with it.
- On-prem folders work the same way: the site's agent uploads the file, and Volt attaches it.

### Artwork by name: thumbnails, posters and other image types

An image the Image Library takes in can also become one of a video's images: its Thumbnail, Poster, Hero backdrop and the other [image types](media-library.md#watch-it-and-choose-its-image-preview) your account uses. Volt reads a type word at the end of the image's name, after `-`, `_`, `.` or a space, with capitals ignored, and attaches the image to the video whose name the rest of it starts with, the same way as a caption.

| Word at the end of the name | Image type | Filed in the Image Library as |
|---|---|---|
| `thumbnail`, `thumb` | Thumbnail (the video's main image) | Keyframe |
| `poster` | Poster | Poster |
| `cover` | Cover | Image |
| `hero`, `backdrop`, `background`, `fanart` | Hero backdrop | Image |
| `banner` | Banner | Image |
| `social`, `share` | Social share card | Image |
| `title`, `titleart`, `clearlogo`, `logo-title` | Title art | Image |
| Your account's own type, by its key or its name | That type | Image |

- **Example**: with `Scrubs-s1-e1.mp4` in the folder, `Scrubs-s1-e1-thumbnail.jpg` becomes its Thumbnail (the image shown for the video everywhere) and `Scrubs-s1-e1_poster.png` its Poster, exactly as if you had chosen them under **Image** on the asset's **Preview**.
- **The image is in the Image Library at once**, whatever happens next. One that arrives before its video says "waiting for a video named like it" and is attached on the pass after the video lands. With no video after **24 hours** it stays in the Image Library on its own, and the entry says no asset was matched.
- **Never refused for its shape.** A poster that is not 2:3, or a thumbnail smaller than recommended, is attached anyway; the entry and **Image** on the asset's **Preview** say what does not fit.
- **Words that are not image types**: `brand` or `logo`, `watermark` and `slate` at the end of a name file the image in the Image Library as that kind (`Station-logo.png` is a brand image), attached to nothing.
- **No type word, or your own words**: give the rule an **Image type** (see [Add rules](#add-rules)). A rule for `*_key_art.jpg` with the image type Hero backdrop makes every matching image the Hero backdrop of its video. A type word in the name still wins, unless you clear **A type word in the name wins** on the rule.
- **Where Volt looks**: videos this watchfolder has taken into the Media Library, the longest matching name first, as for captions. Images from an on-prem folder are matched the same way.

### Add rules

1. On the folder's page, under **Rules**, fill in the row at the bottom:

   | Field | What to enter |
   |---|---|
   | **Rule name** | A name people will recognise, such as "Slates" |
   | Pattern | The file names it matches, such as `slate_*.png`. `*` stands for any characters and `?` for one character; capitals do not matter. Only the file name is matched, not the folders it is in |
   | Target kind | What the file is, picked from the list (see below). It starts as `slate`. The list holds only the kinds Volt takes in, grouped by the library each goes to. When the pattern ends in a file type, such as `.png` or `.mp4`, only the places that take that type are offered |
   | Workflow | A label kept with the file, and added as a tag to images. It starts as `register` and does not change where the file goes |
   | **Image type** | Shown when the target kind goes to the Image Library. **From the name only** (the default) reads the type word at the end of the name; pick a type to give every image this rule takes that type. See [Artwork by name](#artwork-by-name-thumbnails-posters-and-other-image-types) |
   | **A type word in the name wins** | On by default: a type word in the name, such as `_poster`, wins over the rule's image type. Clear it to always use the rule's type |

2. Choose **Add rule**. It is added after your other rules and above the default rules, numbered.
3. Put specific rules above general ones: **↑** and **↓** move a rule. `slate_*.png` must be above `*.png`, or every slate is filed by the general rule.
4. **✕** deletes a rule. Volt asks first; choose **Delete rule** to confirm. Files already taken in are not affected.

The target kind decides where an accepted file goes:

| Target kind | Goes to |
|---|---|
| `slate`, `poster`, `watermark`, `brand` or `logo`, `keyframe` or `thumbnail`, `image` or `still` | The Image Library, as that kind of image |
| `vod`, `video`, `programme`, `program` or `episode` | The Media Library, encoded to the folder's ladder |
| `loop` or `filler` | Loops & Fillers, as a loop, for video files |
| `filler-slate` | Loops & Fillers, as a slate a channel or event can show when its input drops, for image files. (`slate` files the image in the Image Library instead) |
| `companion` | Attached to the video it is named after, for caption and metadata files only. Offered under **Attach to its video** |

Those are the only kinds a rule that accepts files can use; Volt refuses any other. A rule must also send each type of file somewhere that takes it: a rule for `*.png` can send images to the Image Library but not to the Media Library, a rule for `*.mp4` can send video to the Media Library or Loops & Fillers but not to the Image Library, and a rule for `*.mp3` can send audio to the Media Library only. A pattern that could match any file, such as `promo_*`, is not checked this way. A rule saved before this check with another kind is marked **never taken in** in the list: the files it accepts would wait for ever, so delete it and add it again with a kind from the list.

### Try a filename

1. Under **Try a filename**, type a file name, such as `slate_open.png`.
2. Volt answers with the same check the scanner uses: **Accepted as** the target kind and the number of the rule that wins (that rule is highlighted), or **Sent to** the review folder with the reason. For an image it also says the image type it would be and why (from the word in the name, or from the rule), and the video it would be attached to, or that it would wait for one. For a caption it names the video too.
3. Change or reorder the rules until every name you expect is accepted the way you want.

If your role cannot try file names, the box is greyed out and says so: it needs Files, uploads & storage: Operate.

### Choose how video is encoded

1. Next to **Encode video to**, choose a ladder from Encoding Profiles, or **The account default ladder**.
2. The change is saved at once. It applies to video files only: images and slates go straight to the library.

### Scan and read the result

1. Choose **Scan now** to look at the folder straight away instead of waiting for the next automatic scan.
2. The line under it says how many files it looked at, how many were accepted, sent to review, already known or still arriving, and then how many were ingested, queued for encoding, added to Loops & Fillers, held by the ingest rules, failed, or left for other workflows.

Video files go through your [Ingest Rules](ingest-rules.md), with this folder as their source, so a rule there can hold one for metadata or as a duplicate.

### Deal with files that need a person

1. The **Queue** starts on **Needs a person**: files that need review and files that failed. Choose another view to see **Needs review**, **Failed**, **Waiting**, **In library**, **Sent back** or **Dismissed**. **Refresh** reloads it.
2. Each row shows the file, the reason it was stopped, where it is now (**now at** its place in the review folder), its status, size and when it was seen.

   | Status | Means |
   |---|---|
   | **Waiting** | Accepted, waiting for the next pass that adds it to a library. A caption or metadata file waits here for its video, up to 24 hours |
   | **In library** | Added to the Image Library, the Media Library (where a video shows its encode) or Loops & Fillers, or attached to its video (the reason names the video and the track) |
   | **Needs review** | No rule matched, or a rule refused it. The file is in the review folder |
   | **Failed** | It matched a rule, but adding it to the library did not complete |
   | **Sent back** | Returned to the folder to be looked at again. For an on-prem folder, "Waiting for the site agent to move it back into the folder" until the agent has done so |
   | **Dismissed** | Closed by someone. The file was left where it was |

3. For a file in **Needs review**: fix or add the rule, then choose **Reprocess**. The file goes back into the watchfolder and the next scan looks at it again. In an on-prem folder the site's agent moves it back on its next pass; if it cannot (someone moved the file away), the entry returns to **Needs review** and says why.
4. For a file that **Failed**: read the reason under it and fix the cause (for example, replace a damaged file under the same name), then choose **Retry**. The file never left the watchfolder; it goes back to **Waiting** and is taken in again on the next pass, within a minute. If it fails again, the new reason is shown.
5. If the file was not wanted, choose **Dismiss**. The entry is closed and the file stays where it is: in the review folder for a file that needed review, in the watchfolder for one that failed. Nothing on this page deletes a file.

Choose **← Watchfolders** to go back to the list. Each folder there shows its number of rules, how many files are **to review** (or **nothing waiting**) and when it was last scanned, or **scan failing**.

### Rename, switch off or delete a watchfolder

At the top of the folder's page:

1. **✎ Rename**: type the new name and choose **Save** (or press Enter).
2. **⏸ Switch off** stops Volt scanning the folder; its rules and queue are kept. The page and the list say **Switched off**, and **Scan now** is greyed out. **▶ Switch on** starts it again.
3. **✕ Delete** removes the watchfolder with its rules and queue. Volt asks you to type the folder's name, then **Delete watchfolder**. No file is deleted: everything in the folder and its review folder stays where it is, and what was taken in stays in the libraries.

## How it connects

| Section | How it relates |
|---|---|
| [Images and thumbnails](images-and-thumbnails.md) | Slates, posters, logos and other stills land in the Image Library |
| [Media Library](media-library.md) | Programmes and other video land here and are encoded; captions and metadata files are attached to them by name |
| [Loops & Fillers](loops-and-fillers.md) | Files with the target kind `loop` or `filler` land here |
| [Ingest Rules](ingest-rules.md) | Video files are ingested through them; a source rule can name the folder (**Folder:** and its name) |
| [Encoding Profiles](encoding-profiles.md) | The ladders offered under **Encode video to** |
| [Storage](storage.md) | Where accepted files are kept |
| [Sites](hybrid-sites.md) | With the Hybrid Sites add-on, the sites whose agents watch on-prem folders |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See watchfolders, their rules and queues | Files, uploads & storage: View |
| Try a filename | Files, uploads & storage: Operate |
| Create, rename, switch off and delete a watchfolder, add, move, switch off and delete rules, add the default rules, choose the ladder, scan now, reprocess, retry and dismiss | Files, uploads & storage: Manage |

Without Manage, the buttons for these are not shown.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **A watchfolder needs a name and a path.** | One of the two boxes is empty | Fill in both, then **Create** |
| **A rule needs a name and a pattern.** | The rule name or the pattern is empty | Fill in both, then **Add rule** |
| **No rules yet, so every file will go to review. That is the safe default, not a fault.** | The folder has no rules: it was made before the default rules, or they were deleted | Choose **Add default rules**, or add rules for the files you expect |
| A message that the pattern "matches an image" (or a video, or a caption file) "which" a library "does not take" | The rule would send a type of file somewhere that cannot take it in | Pick a target kind from the place the message names. The rule form offers only those |
| A message that the pattern "matches an audio file" when the rule sends it to Loops & Fillers | Loops & Fillers plays a picture under a stream, so it takes video only | Send audio to the Media Library (`vod`) |
| A caption stays **Waiting** with "waiting for its video" | No video of this folder is named like it yet, or its video is still arriving | Drop the video with the same start to its name. After 24 hours the caption goes to review |
| "no video in this folder is named like it ... after 24 hours" | Nothing matched the caption or metadata file's name within a day | Drop the video and **Reprocess**, or add the file on the asset's **Companion files** tab |
| "... over the 25 MB limit for companion files" | The caption or metadata file is too large | Split or compress it, then add it again |
| An image stays in the Image Library with "waiting for a video named like it" | No video of this folder is named like the start of the image's name yet | Drop the video. After 24 hours the image stays in the Image Library unattached; choose it under **Image** on the asset's **Preview** instead |
| "No asset in this folder is named like it after 24 hours, so no asset was matched" | Nothing matched the image's name within a day | Choose the image under **Image** on the asset's **Preview** |
| "Not 2:3" or "Smaller than the recommended" after an attached image | The image does not fit its type's shape or size | Nothing has to be done; portals crop it around its focus point. Deliver a better fitting file to replace it |
| A message that only a rule taking images into the Image Library can set an image type | The rule sends files somewhere else, or refuses them | Choose an Image Library target kind, or set the image type back to **From the name only** |
| A message that the image type "is not an image type of this account that is switched on" | Through the API, `imageType` named a type the account does not have, or has switched off | Use a key from `imageTypes` on the folder, or switch it on under **Image types…** on an asset's **Preview** |
| An image or video goes to review in a folder with the default rules | The default rule for it is switched **Off**, or its extension is not in the rule | Switch it **On**, or add the extension to the rule's pattern |
| **Last scan failed:** and a reason, or **scan failing** in the list | Volt could not read the folder | Check the path is right and the folder is still there; contact Volt support if it is |
| "no rule matched and this folder has no default, so it needs a person to look at it" | No rule matches the file name | Add or change a rule, then **Reprocess** |
| "refused by rule" and a rule name | A rule refuses files like this | Expected; **Dismiss** it, or change the rule |
| "looks like a partial upload still being written" | The name ends like an unfinished copy (for example `.part` or `.tmp`) | Let the copy finish under its real name |
| "is zero bytes, so the copy did not finish" | The file is empty | Copy it in again |
| "is a filesystem artefact, not content" | A system file, not media | **Dismiss** it |
| A rule is marked **never taken in** | It was saved with a target kind Volt does not take in | Delete it and add it again with a kind from the list |
| A message that the kind "is not a kind Volt takes in" | Through the API, a rule that accepts files named a kind outside the list | Use one of the kinds in the table above |
| A file stays **Failed** after **Retry** | The cause is still there; the reason under it says what it is | Fix the file (copy it in again under the same name), then **Retry**, or **Dismiss** it |
| "the file is no longer in the review folder; somebody has already moved or deleted it" | Someone moved the file by hand | Put it back in the watchfolder yourself, or **Dismiss** the entry |
| **Try a filename** is greyed out with "Your role cannot try file names here" | Your role cannot run a dry run | Ask for Files, uploads & storage: Operate |
| **Scan now** is greyed out | The watchfolder is switched off | Choose **▶ Switch on** |
| No **Scan now** on a folder that says **On** and a site | An on-prem folder: the site's agent scans it | Nothing to do. If **Last pass** is old, check the site's server on [Sites](hybrid-sites.md) |
| No **On-prem, at a site** in the New watchfolder form | The account does not have the Hybrid Sites add-on | Ask Volt about the add-on |
| "the file changed while it was uploading" | An on-prem file arrived different from the file the agent accepted (it was replaced during the upload) | Nothing to do: the new file is taken in as a new entry on the next pass |
| "the site agent could not move it to the review folder" | Volt sent an on-prem file to review, but it was no longer in the watchfolder at the site | Find the file at the site, or **Dismiss** the entry |
| "the site agent could not move it back" | After **Reprocess**, the file was no longer in the review folder at the site | Put the file back in the watchfolder at the site yourself, or **Dismiss** the entry |
| "the encode at the site could not be queued" on an item in an **Encode at site** folder | The site was disabled, or this Volt keeps finished streams in a storage bucket, where encoding at the site is not available yet | Enable the site, or set the folder to **Upload and encode in the cloud** and copy the file in again |
| An item in an **Encode at site** folder stays **Processing** | No approved, **Online** server of the site is taking the encode, or none has the encoder set up | Check the site's servers on [Sites](hybrid-sites.md) and start the agent with `VOLT_ENCODER_IMAGE`, or set **If the site does not encode it** to a time so it is encoded in the cloud instead |

## Through the API

| Request | Does |
|---|---|
| `GET /api/watchfolders`, `POST /api/watchfolders` | Lists watchfolders, or creates one (`name`, `config.path`; or `"kind": "s3"` with `config.bucket` and `config.prefix` for a folder in a bucket; or `"kind": "site"` with `siteId`, `config.path` on the site's server and `placement`, for an on-prem folder). A new folder starts with the default rules by file type, returned as `rules`; send `"defaultRules": false` to start with none |
| `GET /api/watchfolders/site-options` | Whether the account has the Hybrid Sites add-on, its sites, and which placements can be chosen |
| `GET /api/watchfolders/{id}`, `PATCH /api/watchfolders/{id}`, `DELETE /api/watchfolders/{id}` | One watchfolder with its rules (a default rule has `builtin` set to `images`, `video`, `audio`, `captions` or `sidecars`), `defaultsMissing` (the default rules it lacks), `targetKinds` (each kind a rule can take in, the library it goes to and the file types it `accepts`) and `imageTypes` (the account's image types a rule can name); rename it, switch it off (`enabled`), set a default target kind or the ladder; delete it |
| `GET /api/watchfolders/{id}/rules`, `POST /api/watchfolders/{id}/rules` | Lists or adds rules. The API can also match by `regex`, `extension` (one, or a list such as `"png, jpg"`), `prefix` or `suffix`, and add refusing rules (`"action": "reject"` with a `rejectReason`). A rule whose pattern names a file type and sends it somewhere that does not take that type is refused with `400` and the code `target_does_not_fit_type`. An Image Library rule may carry `imageType` (a key from `imageTypes`) and `imageTypeFromName` (`true` by default); `imageType` on any other rule is refused with `image_type_needs_image_rule`, an unknown or switched off type with `unknown_image_type` |
| `POST /api/watchfolders/{id}/rules/defaults` | Adds the default rules by file type the folder lacks, after its own rules: `201` with `added` and the folder's `rules`, or `200` with an empty `added` when it has them all |
| `PATCH /api/watchfolders/{id}/rules/{ruleId}`, `DELETE /api/watchfolders/{id}/rules/{ruleId}` | Changes (including `ordinal` and `enabled`) or deletes a rule |
| `POST /api/watchfolders/{id}/dry-run` | What would happen to a file name: the `decision`, and for an image `imageType` (`key`, `label`, `from` the `name` or the `rule`, the `word`) and `libraryKind`; for an image with a type or a caption, `asset` (the video it would go with, and `waiting` while that video is not taken in yet), or `null` |
| `POST /api/watchfolders/{id}/scan` | Scans now |
| `GET /api/watchfolders/{id}/items` | The queue; filter with `?status=quarantined`, `failed`, `seen`, `ingested`, `reprocessed` or `removed`. An image meant for a video has `image_type` and `image_attach` (`waiting`, `attached` or `unmatched`) |
| `POST /api/watchfolders/{id}/items/{itemId}/resolve` | `{"resolution": "reprocess"}` or `{"resolution": "remove"}` for a file in review or one that failed (reprocess on a failed file retries it) |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"filename": "slate_open.png"}' \
  "https://your-volt-host/api/watchfolders/$FOLDER_ID/dry-run"
```

A folder in a bucket. Give it a prefix under `watch/` when it is in Volt's own bucket, so each file is taken in as soon as it arrives; leave `config.bucket` out to use Volt's own bucket. A folder in a bucket of your own works the same way once your Volt contact has connected that bucket; until then it is looked through once an hour.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Agency drops", "kind": "s3", "config": {"prefix": "watch/agency/"}}' \
  "https://your-volt-host/api/watchfolders"
```

An on-prem folder (Hybrid Sites add-on). Without the add-on the answer is `403` with the code `licence_required`; `placement` is `upload_cloud` (the default: the agent uploads, Volt encodes) or `encode_site` (video and audio are encoded at the site and only the finished streams uploaded). With `encode_site`, `fallbackMinutes` (5 to 10080, or `null` to wait for the site, the default) is how long an encode may wait at the site before the original is sent and encoded in the cloud; set it when you create the folder or with `PATCH /api/watchfolders/{id}`. The folder returns it as `fallback_minutes`.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Newsroom NAS drop", "kind": "site", "siteId": "'$SITE_ID'", "placement": "upload_cloud", "config": {"path": "/mnt/nas/drop"}}' \
  "https://your-volt-host/api/watchfolders"
```

Every route is in the [API reference](/api-reference).
