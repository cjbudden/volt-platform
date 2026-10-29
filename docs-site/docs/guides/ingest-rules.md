---
title: Ingest Rules
sidebar_position: 9.8
description: Decide what happens to a file when it arrives in Volt, from naming and filing to duplicates, required metadata, sidecars and webhooks.
guide: section
---

# Ingest Rules

Ingest Rules decides what happens to a file when it arrives in Volt, whichever way it comes in: the name it is stored under, the folder it is filed in, what counts as a duplicate, whether metadata must be filled in first, and who is told. The account default applies to every file; a rule for a content type or for one source can override any part of it.

![The Ingest Rules page: the platform baseline, the account default, content type and source or folder rungs with their rules, then linked cloud accounts and webhooks](/img/screens/ingest-rules.png)

## What it is for

- **Consistent filing.** Every file gets a predictable name and place, whether it was added in the console, sent through the API, linked from cloud storage or dropped in a [watchfolder](watchfolders.md).
- **Duplicates.** Decide whether a file that looks like one already in the library is skipped, replaces the old one, is kept as a new version, is renamed, or waits for a person to decide.
- **Metadata first.** Hold a file until its required metadata is filled in, or let it in and fill the metadata later.
- **Refusing what you never want.** A rule can refuse matching files with a reason, such as project files that should never be uploaded.
- **Telling your systems.** Send a signed webhook when a file is ingested, and write a JSON or XML sidecar beside the stored file.

Library and media operations staff use it, usually set up once by an administrator.

## Before you start

- Content types for the files you ingest, if a rule should give them one ([Content Types](content-types.md)).
- A watchfolder, if a rule should apply only to files dropped there ([Watchfolders](watchfolders.md)).
- **Account settings: Manage** to add or change rules (see [Who can do it](#who-can-do-it)).

## Step by step

### Read how rules combine

1. Open **Admin** and choose **Ingest Rules** (under **Media setup**).
2. **Platform baseline (what "inherit" means when nothing else says)** shows what Volt does when no rule says otherwise: the naming, folder structure, duplicate handling, metadata requirement, transfer, sidecar and auto upload it uses.
3. Below it are three rungs: **Account default**, **Content type** and **Source or folder**. For each file, Volt looks at each rung in turn, takes the first switched-on rule on that rung whose conditions match (lowest **Order** first), and uses the values it sets. A value set on a higher rung replaces the one from below; anything a rule leaves on **Inherit** comes from the rung beneath. Choices made for a single file when it is added (in the Media Library) win over all of them.

### Add a rule

1. Choose **Add rule**.
2. Give it a **Name** and choose its **Rung**:

   | Rung | Applies to |
   |---|---|
   | **Account default** | Every file |
   | **Content type** | Files of the **Content type** you choose, or **Any type** |
   | **Source or folder** | Files from the **Source** you choose: **Console panel**, **API and tus clients**, **tus (no source named)**, **Links**, a cloud storage service, a transfer service, **Desktop agent**, one of your watchfolders (**Folder:** and its name), or **Any source** |

3. Set **Order (lower wins first)**. On the same rung, a rule with a lower number is checked first.
4. Under **When (all that are set must hold; leave empty to always match)**, set any of: **Extensions (comma separated)**, **Kind** (**Video**, **Audio**, **Image**, **Other** or **Any**), **Name pattern (glob)** such as `slate_*.png`, **Path starts with** (the folder path inside a dropped folder), **Min duration (minutes)**, **Min size (MB)** and **Min height (px)**.
5. Under **Then**, set what should happen. Each list starts with **Inherit** and the value it would inherit:

   | Field | Choices |
   |---|---|
   | **Content type** | The type the file is given |
   | **Naming** | **Keep the name (sanitised)**, **GUID** (a unique code), **GUID + name**, or **Template** with a **Name template** such as `{type}_{name}.{ext}` |
   | **Folder structure** | **Flat**, **Keep the folder tree**, **kind / year / month**, or **Template** with a **Path template** such as `{kind}/{yyyy}/{mm}/{path}` |
   | **Duplicate** | **Ask**, **Skip**, **Replace**, **Keep both (version)** or **Rename** |
   | **Metadata required** | **Not required**, **Before ingest (bytes move first)** (the file is uploaded and waits until its required fields are filled), or **Before upload** |
   | **Transfer** | **Auto (cloud to cloud when possible)**, **From this device** or **Cloud to cloud only** |
   | **Sidecar** | **None**, **JSON beside the object** or **XML beside the object** |
   | **Read the file name** | **Apply what is clear**, **Only suggest** (the reading is kept on the asset for a person, nothing is applied), or **Off** |
   | **Auto upload** | **On** or **Off** |
   | **Webhooks** | The webhooks to call (hold Ctrl or Cmd to choose several) |
   | **Refuse with reason (instead of ingesting)** | A reason; matching files are refused instead of ingested |

6. Choose **Save rule**, or **Cancel**. The rule appears on its rung with its order, name, what it applies to and a summary of what it does (**always:** when it has no conditions, or **inherits everything** when it sets nothing).

### Teach Volt your file names

The **File names: content type, title and links** card decides what a file's name may set when it arrives. A name is read as signals, not facts: a type a person or an ingest rule chose is never changed, values people typed are kept, and anything uncertain is left on the asset for a person to choose.

1. **Title case**: **Every word capitalised (7th Voyage Of Sinbad)** or **Headline style (7th Voyage of Sinbad)**.
2. **Episode title when the name has none**: the title an episode gets when its name has no episode title, such as `Episode {episode} (S{season})`.
3. **Set the content type when the name is clear (80% or more, no conflict)** and **Link a trailer to its film when one record matches clearly**: untick either to have Volt only suggest.
4. Under **Try a file name**, type a name and choose **Test** to see each part and what it was read as, the type it suggests and why, the fields it would fill, and what a trailer would look for.
5. **Add rule** adds your own rule: give it a **Name**, then under **If the file name has**, any of **Any of these words (comma separated)**, **A signal** (such as **Season and episode (S01E03)** or **A promotional marker**) and **Pattern (regular expression on the lower-case name)**; under **Then suggest**, the **Content type** (and for **Trailer / promo**, its **Kind**). **How sure a match is** sets its weight. The words a rule recognises are also taken out of the title. Your rules outrank the built-in ones.
6. **Built-in rules** lists the rules Volt starts with (promotional markers, season and episode markers, interview, highlights, music videos, full movies, sponsor bugs). **Switch off** stops one for your account.

When two signals point at different types (for example "interview" and "highlights"), nothing is set and both are shown on the asset. A promotional marker at the end of a name outranks season and episode markers: `Show_S01E03_Promo` is a promo, linked to that episode when it is in the library.

### Change, switch off or delete a rule

1. On the rule's row, choose **Edit**, change it, and **Save rule**.
2. **Disable** switches a rule off without deleting it; it is shown dimmed and **Enable** switches it back on.
3. **Delete** removes it after you confirm.

### Send a webhook when files arrive

1. Under **Webhooks (signed POST of the ingest payload)**, type a **Name** and the address of your system, then choose **Add webhook**.
2. The **Signing secret (shown once)** appears with how to check the signature. Copy it now: it is not shown again.
3. Choose the webhook under **Webhooks** in the rules that should call it.
4. Each webhook row shows its address, the events it is sent for, and the result of its last call. **Disable** pauses it; **Delete** removes it at once.

### Link cloud storage and transfer services

1. Under **Linked cloud accounts**, choose **Link** and the service. Sign in in the window that opens; the account then appears in the list. **Unlink** removes it. A **Link** button that is greyed out means that service has not been set up for your Volt service yet.
2. Under **Accelerated transfer providers**, choose the provider, give it a label (for example the office it serves), fill in its connection details in the box, and choose **Add provider**.

Linked accounts let Volt copy files from cloud to cloud instead of through your computer, and recognise a file that is already in your cloud storage.

## How it connects

| Section | How it relates |
|---|---|
| [Media Library](media-library.md) | Adding files there shows what these rules will do to each one before anything moves, and lists files held for metadata or as duplicates |
| [Watchfolders](watchfolders.md) | Video files a watchfolder accepts are ingested through these rules, with the folder as their source |
| [Content Types](content-types.md) | A rule can give files a type, or apply only to files of one type |
| [Encoding Profiles](encoding-profiles.md) | How accepted video is encoded |
| [Storage](storage.md) | Where the stored files are kept |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the rules, webhooks and linked accounts | Account settings: View |
| Add, change, switch off or delete rules, webhooks and providers | Account settings: Manage |
| Add files in the Media Library (this checks the rules) | Files, uploads & storage: Manage, and Account settings: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Couldn't load ingest rules.** | The page could not read the rules | Choose **Retry** |
| **No rules on this rung.** | Nothing overrides the rung beneath here | Expected; the baseline or a lower rung decides |
| A rule does not seem to apply | Only one rule per rung is used: a rule with a lower **Order** on the same rung matched first, or the rule is disabled | Check the order and the **When** conditions, and **Enable** it |
| A rule is called **Untitled rule** | It was saved without a name | **Edit** it and give it a name |
| A **Link** button is greyed out | The service has not been set up for your Volt service | Contact Volt support |
| **Add provider** shows an error | The connection details are not valid JSON | Keep the quotes and braces from the example and fill in the values |
| A webhook row shows an error after **last** | Your system did not accept the last call | Check the address and that your system answers; the error text says what came back |
| Files added in the Media Library show **refused** | A rule with **Refuse with reason** matched | Read the reason; change the file or the rule |
| "The pattern is not a valid regular expression" | The **Pattern** of a file-name rule cannot be read | Correct it, and check it with **Try a file name** |
| A word in your titles keeps disappearing | A file-name rule lists it under **Any of these words** | Take the word out of the rule, or switch the rule off |

## Through the API

| Request | Does |
|---|---|
| `GET /api/ingest/baseline` | The platform baseline |
| `GET /api/ingest/rules`, `POST /api/ingest/rules` | Lists rules, or adds one (`rung`, `scopeId`, `ordinal`, `name`, `when`, `then`) |
| `PATCH /api/ingest/rules/{id}`, `DELETE /api/ingest/rules/{id}` | Changes, switches off (`{"enabled": false}`) or deletes a rule |
| `POST /api/ingest/preview` | What would happen to files with these names and sizes, before sending them |
| `POST /api/ingest/sanitise` | How names would be cleaned up and named |
| `GET /api/ingest/held` | Files held for metadata or as duplicates |
| `GET /api/ingest/webhooks`, `POST /api/ingest/webhooks` | Lists webhooks, or adds one (the signing secret is in the reply, once) |
| `PATCH /api/ingest/webhooks/{id}`, `DELETE /api/ingest/webhooks/{id}` | Changes or deletes a webhook |
| `GET /api/ingest/filename-rules` | The built-in file-name rules, yours, and the settings |
| `POST /api/ingest/filename-rules`, `PATCH /api/ingest/filename-rules/{id}`, `DELETE /api/ingest/filename-rules/{id}` | Adds, changes or deletes a file-name rule (`name`, `when`: `words`, `signal`, `pattern`; `then`: `typeKey` or `typeId`, `kind`; `confidence`) |
| `PUT /api/ingest/filename-rules/builtin/{id}`, `PUT /api/ingest/filename-rules/settings` | Switches a built-in rule off or on; sets title case, the episode template and what is applied automatically |
| `POST /api/ingest/filename-rules/test` | What the rules make of a file name (`{"filename"}`) |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"source": "api", "files": [{"name": "Match highlights.mov", "bytes": 52428800}]}' \
  "https://your-volt-host/api/ingest/preview"
```

Webhook calls carry an `x-volt-signature` header of the form `t=<timestamp>,v1=<signature>`, where the signature is an HMAC-SHA256 of the timestamp, a full stop and the body, keyed with the signing secret. Every route is in the [API reference](/api-reference).
