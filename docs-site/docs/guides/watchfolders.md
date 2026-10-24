---
title: Watchfolders
sidebar_position: 9.3
description: Set up drop folders that Volt watches, sort what arrives with filename rules, and deal with the files no rule accepts.
guide: section
---

# Watchfolders

A watchfolder is a folder Volt keeps an eye on. Files dropped into it are sorted by the folder's rules into the Image Library, the Media Library or Loops & Fillers; a file that matches no rule is moved to a review folder and listed for a person, never deleted and never guessed at. Most people come here to add a rule, or to clear the files waiting for review.

![A watchfolder's page: its path and Scan now button, the numbered rules with the one that would win highlighted, the Try a filename box, and the queue of files that need a person](/img/screens/watchfolders.png)

## What it is for

- **Regular deliveries.** Slates, posters, logos, programmes and loops that arrive from an agency, an edit suite or another system go into one folder and land in the right library on their own.
- **Sorting by name.** Rules match the file name, such as `slate_*.png`, and say what kind of file it is. The first rule that matches wins.
- **Nothing lost on a guess.** A file no rule accepts, or that a rule refuses, is moved to the folder's review folder and listed in the **Queue** until someone deals with it.
- **Checking before you drop.** **Try a filename** shows what would happen to a file before it arrives.

Media operations staff and librarians use it day to day; an administrator usually sets the folders up.

## Before you start

- The folder's path as Volt sees it. Volt can only watch folders it can reach; ask your Volt contact which paths your account can use.
- For video files, the encoding ladder they should be encoded to ([Encoding Profiles](encoding-profiles.md)). Without one, the account default is used.
- **Files, uploads & storage: Manage** to create a watchfolder or change its rules (see [Who can do it](#who-can-do-it)).

## Step by step

### Create a watchfolder

1. Open **Admin** and choose **Watchfolders** (under **Media setup**).
2. Choose **New watchfolder**.
3. Type a **Name** and the folder's path, then choose **Create**. The new folder opens.

Volt scans every watchfolder automatically every minute. A file still being copied in is left until it has stopped changing.

### Add rules

1. On the folder's page, under **Rules**, fill in the row at the bottom:

   | Field | What to enter |
   |---|---|
   | **Rule name** | A name people will recognise, such as "Slates" |
   | Pattern | The file names it matches, such as `slate_*.png`. `*` stands for any characters and `?` for one character; capitals do not matter. Only the file name is matched, not the folders it is in |
   | Target kind | What the file is (see below). It starts as `slate` |
   | Workflow | A label kept with the file, and added as a tag to images. It starts as `register` and does not change where the file goes |

2. Choose **Add rule**. It is added to the bottom of the list, numbered.
3. Put specific rules above general ones: **↑** and **↓** move a rule. `slate_*.png` must be above `*.png`, or every slate is filed by the general rule.
4. **✕** deletes a rule straight away.

The target kind decides where an accepted file goes:

| Target kind | Goes to |
|---|---|
| `slate`, `poster`, `watermark`, `brand` or `logo`, `keyframe` or `thumbnail`, `image` or `still` | The Image Library, as that kind of image |
| `vod`, `video`, `programme`, `program` or `episode` | The Media Library, encoded to the folder's ladder |
| `loop` or `filler` | Loops & Fillers, as a loop |

A file accepted with any other target kind is left as **Waiting** for another part of Volt to pick up.

### Try a filename

1. Under **Try a filename**, type a file name, such as `slate_open.png`.
2. Volt answers with the same check the scanner uses: **Accepted as** the target kind and the number of the rule that wins (that rule is highlighted), or **Sent to** the review folder with the reason.
3. Change or reorder the rules until every name you expect is accepted the way you want.

### Choose how video is encoded

1. Next to **Encode video to**, choose a ladder from Encoding Profiles, or **The account default ladder**.
2. The change is saved at once. It applies to video files only: images and slates go straight to the library.

### Scan and read the result

1. Choose **Scan now** to look at the folder straight away instead of waiting for the next automatic scan.
2. The line under it says how many files it looked at, how many were accepted, sent to review, already known or still arriving, and then how many were ingested, queued for encoding, added to Loops & Fillers, held by the ingest rules, failed, or left for other workflows.

Video files go through your [Ingest Rules](ingest-rules.md), with this folder as their source, so a rule there can hold one for metadata or as a duplicate.

### Deal with files that need a person

1. The **Queue** starts on **Needs a person**: files that need review and files that failed. Choose another view to see **Needs review**, **Failed**, **Waiting**, **In library** or **Dismissed**. **Refresh** reloads it.
2. Each row shows the file, the reason it was stopped, where it is now (**now at** its place in the review folder), its status, size and when it was seen.

   | Status | Means |
   |---|---|
   | **Waiting** | Accepted, waiting for the next pass that adds it to a library |
   | **In library** | Added to the Image Library, the Media Library (where a video shows its encode) or Loops & Fillers |
   | **Needs review** | No rule matched, or a rule refused it. The file is in the review folder |
   | **Failed** | It matched a rule, but adding it to the library did not complete |
   | **Sent back** | Returned to the folder to be looked at again |
   | **Dismissed** | Closed by someone. The file was left where it was |

3. For a file in **Needs review**: fix or add the rule, then choose **Reprocess**. The file goes back into the watchfolder and the next scan looks at it again.
4. If the file was not wanted, choose **Dismiss**. The entry is closed and the file stays in the review folder; nothing on this page deletes a file.

Choose **← Watchfolders** to go back to the list. Each folder there shows its number of rules, how many files are **to review** (or **nothing waiting**) and when it was last scanned, or **scan failing**.

Renaming a watchfolder, switching it off or deleting it is done through the API.

## How it connects

| Section | How it relates |
|---|---|
| [Images and thumbnails](images-and-thumbnails.md) | Slates, posters, logos and other stills land in the Image Library |
| [Media Library](media-library.md) | Programmes and other video land here and are encoded |
| [Loops & Fillers](loops-and-fillers.md) | Files with the target kind `loop` or `filler` land here |
| [Ingest Rules](ingest-rules.md) | Video files are ingested through them; a source rule can name the folder (**Folder:** and its name) |
| [Encoding Profiles](encoding-profiles.md) | The ladders offered under **Encode video to** |
| [Storage](storage.md) | Where accepted files are kept |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See watchfolders, their rules and queues | Files, uploads & storage: View |
| Try a filename | Files, uploads & storage: Operate |
| Create a watchfolder, add, move and delete rules, choose the ladder, scan now, reprocess and dismiss | Files, uploads & storage: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **A watchfolder needs a name and a path.** | One of the two boxes is empty | Fill in both, then **Create** |
| **A rule needs a name and a pattern.** | The rule name or the pattern is empty | Fill in both, then **Add rule** |
| **No rules yet, so every file will go to review. That is the safe default, not a fault.** | The folder has no rules | Add rules for the files you expect |
| **Last scan failed:** and a reason, or **scan failing** in the list | Volt could not read the folder | Check the path is right and the folder is still there; contact Volt support if it is |
| "no rule matched and this folder has no default, so it needs a person to look at it" | No rule matches the file name | Add or change a rule, then **Reprocess** |
| "refused by rule" and a rule name | A rule refuses files like this | Expected; **Dismiss** it, or change the rule |
| "looks like a partial upload still being written" | The name ends like an unfinished copy (for example `.part` or `.tmp`) | Let the copy finish under its real name |
| "is zero bytes, so the copy did not finish" | The file is empty | Copy it in again |
| "is a filesystem artefact, not content" | A system file, not media | **Dismiss** it |
| A file stays **Waiting** | Its target kind is not one this page adds to a library | Use one of the target kinds in the table above |
| "this item is failed, not quarantined" after **Reprocess** or **Dismiss** | Those buttons only work on files in **Needs review** | Read the reason under the file; contact Volt support if it needs to be taken again |
| "the file is no longer in the review folder; somebody has already moved or deleted it" | Someone moved the file by hand | Put it back in the watchfolder yourself, or **Dismiss** the entry |
| **Try a filename** shows nothing | Your role cannot run a dry run | Ask for Files, uploads & storage: Operate |

## Through the API

| Request | Does |
|---|---|
| `GET /api/watchfolders`, `POST /api/watchfolders` | Lists watchfolders, or creates one (`name`, `config.path`) |
| `GET /api/watchfolders/{id}`, `PATCH /api/watchfolders/{id}`, `DELETE /api/watchfolders/{id}` | One watchfolder with its rules; rename it, switch it off (`enabled`), set a default target kind or the ladder; delete it |
| `GET /api/watchfolders/{id}/rules`, `POST /api/watchfolders/{id}/rules` | Lists or adds rules. The API can also match by `regex`, `extension`, `prefix` or `suffix`, and add refusing rules (`"action": "reject"` with a `rejectReason`) |
| `PATCH /api/watchfolders/{id}/rules/{ruleId}`, `DELETE /api/watchfolders/{id}/rules/{ruleId}` | Changes (including `ordinal` and `enabled`) or deletes a rule |
| `POST /api/watchfolders/{id}/dry-run` | What would happen to a file name |
| `POST /api/watchfolders/{id}/scan` | Scans now |
| `GET /api/watchfolders/{id}/items` | The queue; filter with `?status=quarantined`, `failed`, `seen`, `ingested`, `reprocessed` or `removed` |
| `POST /api/watchfolders/{id}/items/{itemId}/resolve` | `{"resolution": "reprocess"}` or `{"resolution": "remove"}` for a file in review |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"filename": "slate_open.png"}' \
  "https://your-volt-host/api/watchfolders/$FOLDER_ID/dry-run"
```

Every route is in the [API reference](/api-reference).
