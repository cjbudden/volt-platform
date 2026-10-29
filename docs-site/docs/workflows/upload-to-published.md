---
title: From upload to published
sidebar_position: 8
description: A video file uploaded or dropped in a watchfolder, filed and described by your rules, encoded to your ladder and published to your catalogue and apps.
guide: workflow
---

# From upload to published

Programmes, promos and finished packages often arrive as files rather than from a live stream. This guide follows one file from the moment it reaches Volt, through the rules that name, type and check it, to an encoded asset in the Media Library that is published where your rules say.

## What it is for

Media librarians, digital producers and media operations staff use this flow for anything that is not cut from a recording: a delivered programme, an edit-suite export, an agency promo. Set up once, it saves you from:

- renaming and filing every file by hand: the ingest rules give each file its name, folder and content type as it arrives;
- encoding files to a different ladder from your channels: the account default ladder can mirror a live output profile;
- deciding where every asset goes and for how long: the publishing rules do that, with overrides for a content type or a single asset;
- uploading from a desk at all, for regular deliveries: a watchfolder picks files up by itself.

## Before you start

- An encoding ladder that is the **account default** ([Encoding Profiles](../guides/encoding-profiles.md)). Without one, files have nothing to be encoded to.
- A content type for the files, offered for **On-demand assets** ([Content Types](../guides/content-types.md)). The standard types work; make your own if you need other fields.
- Publishing rules that say where content goes ([Publishing Rules](../guides/publishing-rules.md)). With nothing ticked under **Publish to**, publishing does nothing.
- For files dropped rather than uploaded, a watchfolder on a path Volt can reach ([Watchfolders](../guides/watchfolders.md)). Ask your Volt contact which paths your account can use.
- The access each stage needs: see [Who can do it](#who-can-do-it). Uploading in the Media Library today needs **Account settings: Manage** as well as **Files, uploads & storage: Manage**.

## The flow

![A file passes the ingest rules, is encoded to a ladder, lands in the Media Library and is published through the publishing rules](/img/flows/upload-to-published.svg)

- **Files to Ingest Rules:** the file, from a Media Library upload, a link Volt fetches, or a watchfolder (with the folder as its source).
- **Content Types to Ingest Rules:** which fields the file's type has and which are required, so a rule can hold the file until they are filled.
- **Ingest Rules to Encoding Profiles:** the accepted file with its name, folder and content type.
- **Encoding Profiles to Media Library:** the renditions of the ladder: the account default for uploads, or the watchfolder's **Encode video to** ladder.
- **Media Library to Publishing Rules:** **Publish** on the asset, which follows its rule (and waits for an approved review if the rule's gate asks for one).
- **Publishing Rules to viewers:** the asset in the catalogue, your registered apps and social accounts, from and until the dates the rule sets.

| Step | Section | What happens |
|---|---|---|
| 1 | [Encoding Profiles](../guides/encoding-profiles.md) | Check the account default ladder files will be encoded to |
| 2 | [Content Types](../guides/content-types.md) | Choose or make the type the files will carry |
| 3 | [Publishing Rules](../guides/publishing-rules.md) | Check where a publish goes, for the account or for that type |
| 4 | [Ingest Rules](../guides/ingest-rules.md) | Decide each file's type, name, duplicates and whether metadata comes first |
| 5 | [Media Library](../guides/media-library.md) or [Watchfolders](../guides/watchfolders.md) | The file arrives and is checked against the rules |
| 6 | [Media Library](../guides/media-library.md) | The file is encoded and becomes an asset; fill in its metadata |
| 7 | [Media Library](../guides/media-library.md), [Review](../guides/review.md) | Publish it from its **Availability** tab, after a review if the rule requires one |

## Step by step

### 1. Check the ladder

1. Open **Admin** and choose **Encoding Profiles**.
2. One ladder should show **account default**. If none does, under **New ladder** open **Mirror a live output profile…**, pick the profile your channels use and choose **Mirror**.
3. Under **What would a source of this height get?**, type the height of the files you expect (for example 1080) to see which rungs they will get.

### 2. Choose the content type

1. Open **Admin** and choose **Content Types**, then **On-demand assets**.
2. Choose the type your files are, for example **Programme / episode**, and check its **Fields** and which are required (**Req.**).
3. To add fields of your own, choose **New type extending** that type, rename the copy, add the fields and choose **Save type**.

### 3. Check the publishing rule

1. Open **Admin** and choose **Publishing Rules**. Under **Account default**, check **Publish to** (at least **Catalogue (portal)** or an app), **Available from**, **Expires** and **Publish gate**.
2. To treat files of one type differently (for example, programmes expire after 30 days), open that type in **Content Types** and set **Publishing rule for this type**: tick each field to set, then **Save publishing rule**.

**Auto-publish** applies to clips and full-event replays made from recordings. An uploaded or dropped file is not published by itself when it finishes encoding: publish it in step 7.

### 4. Set the ingest rules

1. Open **Admin** and choose **Ingest Rules**. **Platform baseline** shows what happens when no rule says otherwise.
2. Choose **Add rule**, give it a **Name** and a **Rung**: **Account default** for every file, **Content type** for files of one type, or **Source or folder** for files from one place (**Console panel** for Media Library uploads, or **Folder:** and a watchfolder's name).
3. Under **When**, narrow it if you need to, for example **Extensions (comma separated)** `mp4, mov` or a **Name pattern (glob)**.
4. Under **Then**, set the **Content type**, the **Naming**, what to do with a **Duplicate** and whether **Metadata required** comes **Before ingest (bytes move first)**. Leave anything else on **Inherit**.
5. Choose **Save rule**.

How the rungs combine is explained in [Ingest Rules](../guides/ingest-rules.md#read-how-rules-combine).

### 5. Send the file

From your computer:

1. Open **Media Library**. Choose **Set type and metadata for all** beside **What are you adding?**, pick the **Content type** (your own types are marked **(custom)**), fill in its fields, at least the required ones marked **\***, and choose **Done**. Anything left empty is decided by the rules. Do this before adding the file: with **Start as soon as added** on, a file starts uploading the moment it is added.
2. Drop the file on **Drop files or a folder here**, or choose **This device** (or **Folder**, or **Link** to have Volt fetch it from an address).
3. Before anything moves, each file shows what the rules decided: how it will be named, **looks like a duplicate** with what the rule says to do, or **refused** with the reason.
4. With **Start as soon as added** on, the upload has started. With it off, choose **Ingest 1 file** (or the number of files).
5. A button in the top bar follows the upload. Choose it to open the **Ingest Queue**: files held for metadata or as duplicates are listed under **Needs you**, with **Fill in** for the missing fields.

From a watchfolder:

1. Open **Admin** and choose **Watchfolders**, then the folder (or **New watchfolder**, with a **Name** and the path).
2. Add a rule whose target kind is `vod` (or `programme`, `episode`, `video`), with a pattern such as `*.mp4`, and choose **Add rule**. **Try a filename** shows whether a name will be **Accepted as** `vod`.
3. Next to **Encode video to**, choose the ladder, or **The account default ladder**.
4. Copy the file into the folder. Volt scans every minute, or choose **Scan now**. The line under it says how many files were accepted, queued for encoding or held by the ingest rules. A held file waits in the **Ingest Queue** under **Needs you**, as an upload would.
5. A file no rule accepts goes to the folder's review folder and is listed in the **Queue**; fix the rule and choose **Reprocess**.

### 6. Let it encode and describe it

1. In the **Media Library**, the new asset's row shows **Queued to encode**, then **Encoding** with a percentage, then its renditions. Choose **Refresh** to update it. The **Upload** (or **Watch folder**) chip under **Created as** finds these files later.
2. Open the asset. The **Encode** tab shows the **Ladder profile** and every rendition made. **Preview** plays it and shows the **Source file**.
3. On the **Metadata** tab, check the **Content type** and fill in its fields; required ones still empty are marked **Required**. Choose **Save metadata**. (**Fill from EPG** is not offered for uploaded files: they have no guide slot.)

Encoding needs Volt's encoders, so how long it takes depends on your service and the file. The **Encode failed** state, with the reason on hover, means the file could not be read: check it plays, then upload it again.

### 7. Publish it

1. On the asset, open the **Availability** tab. **What a publish does for this item** shows the rule it follows; grey values are inherited from the account, its content type and its source.
2. To change something for this asset only, tick the field, set it and choose **Save publishing rule**.
3. If the rule's **Publish gate** requires an approved review, the asset must be sent for review and approved in **Review** first. The console has no button to send an asset for review yet: send it with the API (`POST /api/vod/{id}/review` with `{"to": "in_review"}`, see [Review](../guides/review.md#through-the-api)), then choose **Approve** on it in **Review**.
4. Choose **Publish**. Volt confirms **Published through its rules.** and **Publishing points** lists each place it went.
5. To take it down later, choose **Remove access**. The asset is kept.

## Who can do it

| Stage | Access needed |
|---|---|
| Ladders, content types, publishing rules for the account or a type, ingest rules | Account settings: Manage |
| Watchfolders: create one, add rules, choose its ladder, scan now, reprocess | Files, uploads & storage: Manage |
| Upload in the Media Library | Files, uploads & storage: Manage, and Account settings: Manage |
| Fill in an asset's metadata, change its own publishing rule | Media library & publishing: Manage |
| Approve in Review | Media library & publishing: Manage |
| Publish and remove access | Media library & publishing: Operate |

Usually an administrator sets up stages 1 to 4 once. After that a **Media Librarian** (from the role templates in Users & Roles) handles files day to day, but uploading in the console also needs Account settings: Manage today, so a librarian without it uses a watchfolder or asks an administrator. An **Event Manager** can publish assets but cannot change their metadata. See [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| "Your role does not allow manage on Account settings" when adding files | Adding a file checks your ingest rules, which needs Account settings: Manage | Ask an administrator to upload it or to give you that access, or use a watchfolder |
| A file shows **refused** when added | An ingest rule with **Refuse with reason** matched | Read the reason; change the file or the rule |
| **1 waiting** in the top bar | A rule held the file for metadata or as a duplicate | Open the **Ingest Queue** and deal with it under **Needs you** |
| A dropped file is in the watchfolder's **Queue** as **Needs review** | No watchfolder rule matched its name | Add a rule, then **Reprocess** |
| A file fails to encode, saying the account has no default ladder | No ladder is the account default | Choose **Make default** on a ladder in Encoding Profiles |
| The row stays on **Queued to encode** | The encoders have not picked the file up yet | Wait and choose **Refresh**; if it does not move, contact Volt support |
| An encoded asset stays **Not published** | Uploaded files are published by hand, even with **Auto-publish** on | Choose **Publish** on its **Availability** tab |
| "The publishing rule requires review, and this asset is…" | The **Publish gate** needs an approved review | Send it for review with the API, approve it in Review, then publish |
| **Publish to** reads **nowhere (publishing is a no-op)** | No publishing point is ticked on the rung that decides | Tick **Catalogue (portal)** or an app in the rule |

## Through the API

| Request | Does |
|---|---|
| `GET /api/encode-profiles/ladders` | The ladders, with the account default |
| `GET /api/metadata-schemas?appliesTo=vod` | The content types offered for on-demand assets |
| `GET /api/publishing-rules/resolve?schemaId=...` | What a publish of that type would do |
| `POST /api/ingest/rules` | Adds an ingest rule (`rung`, `scopeId`, `ordinal`, `name`, `when`, `then`) |
| `POST /api/ingest/preview` | What the rules will do to files with these names and sizes |
| `POST /api/watchfolders/{id}/scan` | Scans a watchfolder now |
| `GET /api/vod?sort=-created_at` | The new asset in the library, with its encode state |
| `PUT /api/vod/{id}` | Sets its title, content type (`schemaId`) and `metadata` |
| `POST /api/vod/{id}/review` | Sends it for review (`{"to": "in_review"}`) or approves it (`"approved"`), when the gate needs it |
| `POST /api/vod/{id}/publish` | Publishes it through its rules |

Files themselves are sent with the resumable uploads API, as the console does. This checks what the rules will do before you send a file:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"source": "api", "files": [{"name": "Episode 12.mp4", "bytes": 734003200}]}' \
  "https://your-volt-host/api/ingest/preview"
```

Every route is in the [API reference](/api-reference).
