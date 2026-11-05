---
title: Watchfolders
sidebar_position: 9.3
description: Set up drop folders that Volt watches, sort what arrives with filename rules, and deal with the files no rule accepts.
guide: section
---

# Watchfolders

A watchfolder is a folder Volt keeps an eye on. Files dropped into it are sorted by the folder's rules into the Image Library, the Media Library or Loops & Fillers. A new folder starts with default rules by file type, so images and video are taken in from the first drop; a file that matches no rule is moved to a review folder and listed for a person, never deleted and never guessed at. Most people come here to add a rule, or to clear the files waiting for review.

![A watchfolder's page: its path and Scan now button, the numbered rules (one of the folder's own, then the two default rules by file type) with the one that would win highlighted, the Try a filename box, and the queue of files that need a person](/img/screens/watchfolders.png)

## What it is for

- **Regular deliveries.** Slates, posters, logos, programmes and loops that arrive from an agency, an edit suite or another system go into one folder and land in the right library on their own.
- **Sorting by type, out of the box.** Every new folder sends images to the Image Library and video to the Media Library with two default rules you can change or switch off.
- **Sorting by name.** Rules match the file name, such as `slate_*.png`, and say what kind of file it is. The first rule that matches wins.
- **Nothing lost on a guess.** A file no rule accepts, or that a rule refuses, is moved to the folder's review folder and listed in the **Queue** until someone deals with it.
- **Checking before you drop.** **Try a filename** shows what would happen to a file before it arrives.
- **Folders on your own storage.** With the Hybrid Sites add-on, a watchfolder can be on a NAS or server at one of your sites. The site's agent sorts it with the same rules, keeps refused files at the site and uploads the accepted video to Volt.

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
2. Pick the **Site**, type a **Name** and the folder's path **on the site's server**, such as `/mnt/nas/drop`, then choose **Create**. The folder starts with the default rule for video (only video crosses from a site for now).
3. Add rules as for any watchfolder.

![The New watchfolder form with On-prem, at a site chosen: the name, the site, and the folder's path on the site's server](/img/screens/watchfolders-on-prem.png)

What happens to a file in an on-prem folder:

- The agent waits until the file has stopped changing for 10 seconds, then decides it with the folder's rules.
- A file the rules refuse goes to the review folder **at the site** and is listed in the **Queue** here. It never leaves your network.
- An accepted video file is uploaded to Volt (**Upload and encode in the cloud**), then goes through your [Ingest Rules](ingest-rules.md) and is encoded like any upload. A dropped connection or a restarted server does not start the upload again: it carries on from where it stopped.
- Only video crosses to Volt from a site for now: a file whose rule sends it to the Image Library is marked **Failed** with the reason, and stays where it is.

The folder's page says which site it is on (**On** and the site's name) and when the agent last looked at it. There is no **Scan now**: the agent looks at the folder every few seconds. **Where it is encoded** shows **Upload and encode in the cloud**; **Encode at site**, with encoders at your site, comes with a later release of the add-on.

A watchfolder can also be a folder in a storage bucket instead of a path (set up through the API, see [Through the API](#through-the-api)). Where your Volt runs on AWS, a bucket folder under `watch/` in Volt's own bucket is taken in as soon as a file finishes uploading, usually within seconds, and Volt also looks through every bucket folder once an hour in case a file was missed.

### Default rules by file type

Every new watchfolder starts with one rule per file type, at the bottom of its list and marked **Default**:

| Rule | Matches | Goes to |
|---|---|---|
| **Images to the Image Library** | `png`, `jpg`, `jpeg`, `webp`, `gif`, `tif`, `tiff` | The Image Library, as an image (`image`) |
| **Video to the Media Library** | `mp4`, `mov`, `m4v`, `mxf`, `mkv`, `ts`, `webm` | The Media Library, encoded to the folder's ladder (`vod`) |

They are ordinary rules: **Try a filename** shows them, and you can move, switch off or delete them like any other.

- **Your own rules come first.** A rule you add goes above the default rules, so `loop_*.mp4` to Loops & Fillers wins over the video default for those files, and every other video still goes to the Media Library.
- **On** and **Off** on a rule's row switch it off and on again. A file the rule would have caught goes to the rules below it, or to review. The rule keeps its place in the list.
- **A file nothing recognises still goes to review**, such as a project file or a PDF. Audio files and caption or metadata files go to review for now too.
- **Folders made before the default rules** keep exactly the rules they have. **Add default rules**, next to **Rules**, adds the ones the folder lacks after its own rules, so nothing it does today changes. The button also appears when a default rule has been deleted, and adds it back.
- An on-prem folder starts with the video rule only.

### Add rules

1. On the folder's page, under **Rules**, fill in the row at the bottom:

   | Field | What to enter |
   |---|---|
   | **Rule name** | A name people will recognise, such as "Slates" |
   | Pattern | The file names it matches, such as `slate_*.png`. `*` stands for any characters and `?` for one character; capitals do not matter. Only the file name is matched, not the folders it is in |
   | Target kind | What the file is, picked from the list (see below). It starts as `slate`. The list holds only the kinds Volt takes in, grouped by the library each goes to. When the pattern ends in a file type, such as `.png` or `.mp4`, only the places that take that type are offered |
   | Workflow | A label kept with the file, and added as a tag to images. It starts as `register` and does not change where the file goes |

2. Choose **Add rule**. It is added after your other rules and above the default rules, numbered.
3. Put specific rules above general ones: **↑** and **↓** move a rule. `slate_*.png` must be above `*.png`, or every slate is filed by the general rule.
4. **✕** deletes a rule. Volt asks first; choose **Delete rule** to confirm. Files already taken in are not affected.

The target kind decides where an accepted file goes:

| Target kind | Goes to |
|---|---|
| `slate`, `poster`, `watermark`, `brand` or `logo`, `keyframe` or `thumbnail`, `image` or `still` | The Image Library, as that kind of image |
| `vod`, `video`, `programme`, `program` or `episode` | The Media Library, encoded to the folder's ladder |
| `loop` or `filler` | Loops & Fillers, as a loop |

Those are the only kinds a rule that accepts files can use; Volt refuses any other. A rule must also send each type of file somewhere that takes it: a rule for `*.png` can send images to the Image Library but not to the Media Library, and a rule for `*.mp4` can send video to the Media Library or Loops & Fillers but not to the Image Library. A pattern that could match any file, such as `promo_*`, is not checked this way. A rule saved before this check with another kind is marked **never taken in** in the list: the files it accepts would wait for ever, so delete it and add it again with a kind from the list.

### Try a filename

1. Under **Try a filename**, type a file name, such as `slate_open.png`.
2. Volt answers with the same check the scanner uses: **Accepted as** the target kind and the number of the rule that wins (that rule is highlighted), or **Sent to** the review folder with the reason.
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
   | **Waiting** | Accepted, waiting for the next pass that adds it to a library |
   | **In library** | Added to the Image Library, the Media Library (where a video shows its encode) or Loops & Fillers |
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
| [Media Library](media-library.md) | Programmes and other video land here and are encoded |
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
| **This pattern matches** caption files (or audio files) and no target kind is offered | Volt does not take those in through a rule yet | Leave them to go to review |
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
| "goes to the Image Library, which an on-prem folder does not feed yet" | A file in an on-prem folder matched a rule for images | Put images in a watchfolder on Volt, or upload them |
| "the site agent could not move it back" | After **Reprocess**, the file was no longer in the review folder at the site | Put the file back in the watchfolder at the site yourself, or **Dismiss** the entry |
| "Encode at site arrives with site encoders" | Through the API, an on-prem folder was given the placement `encode_site` | Use `upload_cloud` for now |

## Through the API

| Request | Does |
|---|---|
| `GET /api/watchfolders`, `POST /api/watchfolders` | Lists watchfolders, or creates one (`name`, `config.path`; or `"kind": "s3"` with `config.bucket` and `config.prefix` for a folder in a bucket; or `"kind": "site"` with `siteId`, `config.path` on the site's server and `placement`, for an on-prem folder). A new folder starts with the default rules by file type, returned as `rules`; send `"defaultRules": false` to start with none |
| `GET /api/watchfolders/site-options` | Whether the account has the Hybrid Sites add-on, its sites, and which placements can be chosen |
| `GET /api/watchfolders/{id}`, `PATCH /api/watchfolders/{id}`, `DELETE /api/watchfolders/{id}` | One watchfolder with its rules (a default rule has `builtin` set to `images` or `video`), `defaultsMissing` (the default rules it lacks) and `targetKinds` (each kind a rule can take in, the library it goes to and the file types it `accepts`); rename it, switch it off (`enabled`), set a default target kind or the ladder; delete it |
| `GET /api/watchfolders/{id}/rules`, `POST /api/watchfolders/{id}/rules` | Lists or adds rules. The API can also match by `regex`, `extension` (one, or a list such as `"png, jpg"`), `prefix` or `suffix`, and add refusing rules (`"action": "reject"` with a `rejectReason`). A rule whose pattern names a file type and sends it somewhere that does not take that type is refused with `400` and the code `target_does_not_fit_type` |
| `POST /api/watchfolders/{id}/rules/defaults` | Adds the default rules by file type the folder lacks, after its own rules: `201` with `added` and the folder's `rules`, or `200` with an empty `added` when it has them all |
| `PATCH /api/watchfolders/{id}/rules/{ruleId}`, `DELETE /api/watchfolders/{id}/rules/{ruleId}` | Changes (including `ordinal` and `enabled`) or deletes a rule |
| `POST /api/watchfolders/{id}/dry-run` | What would happen to a file name |
| `POST /api/watchfolders/{id}/scan` | Scans now |
| `GET /api/watchfolders/{id}/items` | The queue; filter with `?status=quarantined`, `failed`, `seen`, `ingested`, `reprocessed` or `removed` |
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

An on-prem folder (Hybrid Sites add-on). Without the add-on the answer is `403` with the code `licence_required`; `placement` is `upload_cloud` for now.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Newsroom NAS drop", "kind": "site", "siteId": "'$SITE_ID'", "placement": "upload_cloud", "config": {"path": "/mnt/nas/drop"}}' \
  "https://your-volt-host/api/watchfolders"
```

Every route is in the [API reference](/api-reference).
