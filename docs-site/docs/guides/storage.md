---
title: Storage
sidebar_position: 9.4
description: See what recorded media your account holds and where, set how long it is kept, and hold or restore individual pieces.
guide: section
---

# Storage

Storage shows what recorded media your account holds, where it is kept, and what the retention ladder will do to it next. Most people come here to set the ladder: after how many days recordings move to cheaper storage, are archived or are deleted.

![The Storage page: what this service can do at the top, the retention ladder with its uploads option and the originals rung, event data retention, the dry run, and the list of media with its state, tier and size](/img/screens/storage.png)

## What it is for

- **Set how long media is kept.** The retention ladder is a short list of rungs, each an age in days and an action: keep, move to cheaper storage, archive or delete.
- **See it before it happens.** A dry run says how many pieces of media the next sweep would move, archive or delete.
- **Look after one piece of media.** Every recorded run and export is listed with its state, where its copies are, and its history. You can put one on hold so retention never touches it, or ask for an archived one to be restored.
- **Keep copies on your own storage.** With the Mirror and Archive add-on, extra copies of your originals are kept on a folder, a NAS share or an S3-compatible store at your own sites, and you can see here whether each one still matches.
- **Keep viewer data for as long as you need.** Raw viewing sessions and the reports made from them have different lifetimes, set here too.

Account administrators and whoever looks after storage costs or legal holds use it.

## Before you start

- Media appears here as recordings are written, so at least one channel, station or event must record. See [Recordings](recordings.md).
- What the ladder can do depends on your Volt service. Where only one tier of storage is available, the ladder offers **Keep** and **Delete** and says why the other actions are missing.
- **Files, uploads & storage: View** to see the page, **Manage** to change anything (see [Who can do it](#who-can-do-it)).

## Step by step

### Check what your service offers

1. Open **Admin** and choose **Storage**.
2. The first card says how media is stored, which storage **Tiers** there are, whether **Archiving** is **available** or **not available**, and how much media is **Tracked**. When archiving is not available, the card says why.

### Set the retention ladder

1. Under **Retention ladder**, give the rule a name (it starts as **Default retention**).
2. For each rung, set **After** (a number of days) and an **Action**: **Keep**, **Move to cheaper storage**, **Archive** or **Delete**. For the two moving actions you can choose a **Tier**, or leave **deployment default**.
3. Choose **Add a rung** for another stage, or **×** to remove one (a ladder always has at least one).
4. Leave **Include uploads and watch folder files** ticked for the rule to cover media that has no channel or event too (see below).
5. With the Mirror and Archive add-on, tick **Remove the original from the cloud** under **Originals** and set the days if you want originals to leave the cloud once they are archived (see [Take originals out of the cloud](#take-originals-out-of-the-cloud-once-they-are-archived)).
6. Choose **Save ladder**. **Saved.** confirms it.

Each rung fires once, at the age you set, counted from when the recording closed. Media that is already older than a rung goes straight to the last rung that applies. A ladder only moves one way: keep, then cheaper storage, then archive, then delete.

**Include uploads and watch folder files.** The account's rule also covers files that were uploaded or picked up from a watch folder, which belong to no channel or event. A rule made before this option existed has it off, so it keeps covering exactly what it did; tick it to include them.

Recordings also have their own keep period, set on each channel, station or event (**Keep recordings for**). Both apply, so a recording goes when the first of them says so.

Exact-frame stills, the single frames Volt makes when someone asks for one frame of an asset or a recording, follow the same ladder, but only its **Delete** rung: they are made again in a moment, so they are never moved to cheaper storage or archived. They also go 7 days after they were last made, as soon as the recording they were taken from is removed, and when their asset is deleted. Each folder of them is listed here as **frames/...**.

### See what the next sweep would do

1. Under **What the next sweep would do**, choose **Run a dry run**.
2. Volt counts what it looked at (**considered**) and how many would go **to cheaper storage**, be **archived** or be **deleted**. It also counts any **skipped on hold**, and any the ladder asks for that your service **cannot do**. With an originals rung it also says how many **originals out of the cloud** the sweep would remove, and how many are **waiting for an archive copy**.

Nothing is changed by a dry run.

### Find and inspect media

1. Type in **Filter by run or source…** to narrow the list. The counts beside it show how many pieces are in each state.
2. Each row shows the **Media** (its name), **Source**, **State**, **Tier**, **Size** and **Length**. Hover over a state to see what it means.
3. Choose **Details** (or click the row) to open it. The top line says whether the media can be read now, for example **Readable.** or **This media is archived. Request a restore before playing it; archived tiers take minutes to hours to become readable.**
4. **Where the bytes are** lists every copy with its **Tier**, **Size** and when it was **Last confirmed**. **What has happened to it** lists each change, who or what made it, and when.
5. Choose **Hide** to close it.

| State | Means |
|---|---|
| pending | declared, nothing written yet |
| writing | being recorded right now |
| available | readable immediately |
| archiving | moving to an archive tier |
| archived | needs a restore before it can be read |
| restoring | a restore is in progress |
| restored | temporarily readable; will lapse back |
| deleting | deletion in flight |
| deleted | the bytes are gone; this row is the record |

**Where the bytes are**, in the details, lists each copy with its **Tier**, size and when it was last confirmed. The tiers your service can offer:

| Tier | Means |
|---|---|
| Server disk | Volt's own disk: one tier, no archive |
| Standard | Read immediately |
| Infrequent access | Read immediately, cheaper to keep, a little dearer to read |
| Archive, instant read | Read immediately, cheaper still for media rarely watched |
| Archive, restore in hours | Needs a restore, which takes minutes to hours |
| Deep archive, restore within two days | Needs a restore, which can take up to two days |

### Hold media so retention leaves it alone

1. Open the media with **Details**.
2. Choose **Hold**. The row is marked **held**, and **On hold:** says that retention rules will not touch it.
3. To let retention act on it again, choose **Release hold**.

A hold outranks every rung of the ladder, including **Delete**. Use it for a legal hold or an investigation.

### Restore archived media

1. Open archived media with **Details**.
2. Choose **Request restore**. The state changes to **restoring** and the top line says when it is expected.
3. When the restore finishes, the media is **restored** and readable for a limited time, then it lapses back to the archive.

**Request restore** only appears for archived media, and only where archiving is available.

### Bring back something deleted

1. Under **Recently removed**, find it in the list: **Removed** (when), **What** (a Media Library asset, an Image Library image or recorded media), **Why**, **Size** and **Gone for good** (when it will be purged).
2. Choose **Restore** to put it back with its metadata and files, or **Delete now** to purge it at once.

A Media Library asset deleted from its **Metadata** tab lands here ([Media Library](media-library.md#delete-an-asset)). Media a retention rule deleted does not come here and cannot be restored.

### Set how long viewer data is kept

1. Under **Event data**, read how many **Raw sessions** and **Report days** you have.
2. Tick **Keep raw events forever**, or enter a number of days.
3. Choose **Save**.
4. To apply it now rather than waiting, choose **Seal and prune now**. Volt says how many days it sealed into reports and how many sessions it pruned.

Reports stay after the raw sessions they were made from are pruned.

### Keep copies at your own sites (Mirror and Archive)

With the **Mirror and Archive** add-on, account administrators see a **Mirror and Archive** section on this page. Copies are written by a server at one of your [sites](hybrid-sites.md), so make a site and add a server first; the section links to **Sites** until there is one.

![The Mirror and Archive section of the Storage page: a NAS folder and an S3-compatible store as storage targets with their speed caps and read-back cadence, and the copies (originals, and a programme's recording with its metadata file) with their state, the reason a copy waits and what to do about it, and below them the originals out of the cloud: one in the archive only with its Restore button, one kept and waiting with why](/img/screens/storage-mirror-archive.png)

**Add a storage target**

1. Choose **Add a storage target**.
2. Give it a **Name** and choose the **Site** whose servers write the copies.
3. Choose the **Kind**:
   - **A folder or NAS share**: the **Folder on the site's server**, as that server sees it, for example `/mnt/nas/archive`.
   - **An S3-compatible store (MinIO and similar)**: the **Store address** as the site's server reaches it, the **Bucket**, optionally a **Folder in the bucket** and a **Region**, and the **Key name**. The store's keys are never typed into Volt: they stay on the site's server under that name (see [Copies to an object store](../workflows/mirror-and-archive.md#copies-to-an-object-store)).
4. Optionally set a **Speed cap (Mbit/s)** so copies leave room for live contribution, how often copies are **read back** (every 30 days unless you change it; empty means only when you ask), and how long **Mirror deletes wait (days)**: for copy rules set to **Mirror**, how long a copy stays after its item has left Volt for good (7 unless you change it, 0 to 90). See [Mirror: follow deletes](../workflows/mirror-and-archive.md#mirror-follow-deletes).
5. Choose **Add target**.

To change a target, choose **Change** on its row. A target that holds copies keeps its folder, or its store, bucket and folder; make a new target to write somewhere else. Set **Status** to **Disabled** to stop new copies while keeping the ones it has.

**Check the copies**

Under **Copies**, every copy is listed with its target, its **State**, its size and when it was **Last confirmed**. Filter by target or state with the two lists above it.

| State | Means |
|---|---|
| **Queued** | Waiting for a server at the site, or for the off-peak window |
| **Copying** | A server at the site is making the copy now |
| **Verified** | Read back from the target and matched the original |
| **Failed** | Could not be made after every retry |
| **Corrupt** | A check found the copy changed since it was made |
| **Missing** | A check found the copy gone from the target |
| **Removed** | A copy under a **Mirror** rule, deleted at the target after its item left Volt and the waiting period was over |

A copy of a recording says which channel and which programme or hour it is (**Recording of** the channel, from when to when) with **Open the recording**, and its metadata file says **Metadata of the recording of** the channel. A copy that waits or failed shows the reason the site's server gave, and under it **What to do**. Each target's **Mirror deletes** column says how long they wait and how many are waiting; a copy waiting to be deleted says **The asset has left Volt: deleted here on** a date. Choose **Check now** to have a verified, corrupt or missing copy read back again at once.

**Originals out of the cloud** lists the originals a retention rule has removed from the cloud (**In the archive only**, with the target and file of the copy) and those whose rule is due but which are **Kept, waiting**, with the reason and **What to do** (see below).

What is copied, and when, is set by copy rules in [Publishing Rules](publishing-rules.md#copy-originals-to-your-own-storage): originals and their sidecars (metadata, captions, poster), clips cut from recordings and each item's HLS/DASH package as a folder (in an S3-compatible store, a folder of objects), when they land, when they are published or nightly, and recordings as each programme or hour ends.

### Take originals out of the cloud once they are archived

With the Mirror and Archive add-on, the retention rule can remove each asset's **original file** from the cloud a number of days after it landed, so you stop paying to keep it in two places. Only the original goes: the renditions, images and metadata stay, so the title keeps playing.

1. Under **Retention ladder**, in **Originals**, tick **Remove the original from the cloud** and set how many **days after it lands**.
2. Make sure a copy rule copies originals to one of your storage targets ([Publishing Rules](publishing-rules.md#copy-originals-to-your-own-storage)).
3. Choose **Save ladder**.

An original leaves the cloud only once a **Verified** copy of that very file is held at one of your storage targets. Until then it stays, and **Originals out of the cloud** in the Mirror and Archive section says why:

| Reason | What to do |
|---|---|
| No archive copy of the original has been made | Add a copy rule for originals, or copy the asset |
| The archive copy is not finished yet | Nothing: it goes once the copy is verified |
| The copy failed, no longer matches, or is no longer there | Fix the cause at the site and copy it again |
| The copy is of an earlier original | The file was replaced: copy the new one |
| A job is using the original | Nothing: it goes after the job finishes |

A rule on a channel or event decides for that stream's media before the account's rule does.

**Bring an original back.** To re-encode a title whose original is in the archive only, choose **Restore** on its row under **Originals out of the cloud**. A server at the copy's site reads the copy, checks it is still the file that was archived and uploads it; Volt checks what arrived against the archived checksum before the asset uses it again. While it runs the row says **Being restored**; if it fails, the row says why (for example the copy no longer matches). A restored original stays in the cloud for the rule's number of days again, counted from the restore. **Restore** needs a verified copy: check a missing or corrupt one again first.

You do not have to restore by hand before a re-encode. When an encode, or a FAST channel's **Prepare**, needs an original that is in the archive only, Volt starts the restore itself and runs that work once the original lands. The asset's page says **Coming back from the archive** under **Original**, with what waits for it, and the FAST channel shows the title as being prepared. If the restore cannot start (the copy is no longer verified, or the target or site is disabled), the encode or the channel says why.

**Recordings wait for their archive file.** When a channel's, station's or event's copy rule archives **Recordings**, retention never deletes one of its recordings (by the ladder or on a date you set by hand) until every archive file covering it is **Verified** at your storage target. Until then the **Retention list** shows **Waiting for its archive copy** with the reason (the file is not made yet, is being made or copied, or its copy failed or went missing), and so does the recording's page. Recordings from before the rule began archiving, and those of streams no copy rule archives, are deleted as before.

## How it connects

| Section | How it relates |
|---|---|
| [Recordings](recordings.md) | Every recording is media here; the ladder decides when it moves or goes, and **Removed** on a recording shows its keep period |
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | Each sets its own **Keep recordings for**, which applies alongside the ladder |
| [Media Library](media-library.md) | Clips and exports made from recordings are tracked here too |
| [Analytics](analytics.md) | Reports are built from the viewer data that **Event data** keeps |
| [Sites](hybrid-sites.md) | Mirror and Archive copies are written by the servers at your sites |
| [Publishing Rules](publishing-rules.md) | Copy rules decide which originals are copied to which storage target, and when |
| [Copies of your media at your own sites](../workflows/mirror-and-archive.md) | The Mirror and Archive flow end to end, from a site to a verified copy |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the page, the ladder and the media list | Files, uploads & storage: View |
| Save the ladder, run a dry run, hold, release or restore media | Files, uploads & storage: Manage |
| See event data retention | Analytics & reports: View |
| Change event data retention, **Seal and prune now** | Analytics & reports: Manage |
| See and change Mirror and Archive storage targets, check copies | Account administrator (owner or admin), with the Mirror and Archive add-on |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **No media is tracked yet. It is registered as recordings are written.** | Nothing has been recorded yet | Turn on recording for a channel, station or event and run it |
| Only **Keep** and **Delete** in **Action** | Your service has one tier of storage, so there is nothing cheaper to move to | Use a keep-then-delete ladder; the first card says why |
| **Waiting for its archive copy** on a recording in the **Retention list** | Its stream's copy rule archives recordings and the archive file covering it is not verified yet | Read the reason beside it: wait for the file to be made and copied, or copy a failed or missing file again under Mirror and Archive |
| **Two stages both fire at** a number of **days** | Two rungs have the same age | Give each rung its own age |
| **A ladder cannot go backwards** | A later rung undoes an earlier one, for example cheaper storage after archive | Order the actions keep, cheaper storage, archive, delete |
| A message that an action is already the stage at an earlier age | The same action appears twice | Remove the repeated rung |
| **This media is archived. Request a restore before playing it; archived tiers take minutes to hours to become readable.** | The media is in the archive | Choose **Request restore** and wait |
| **A restore is in progress.** | A restore was asked for | Wait for the expected time, then choose **Refresh** |
| **This media has been deleted under a retention rule. It cannot be restored.** | The ladder deleted it; the row is kept as a record | Nothing to recover. Hold media you need before its delete rung |
| **This media is still being recorded.** | The recording is open | Wait until it closes |
| **Couldn't load event data retention.** | Your role cannot see analytics, or the request failed | Choose **Retry**, or ask for Analytics & reports access |
| **Couldn't load storage.** | The page could not be read | Choose **Retry** or **Refresh** |
| No **Mirror and Archive** section | The account does not have the add-on, or you are not an account administrator | Ask Volt about the add-on, or an administrator for access |
| **Add a storage target** is missing and the section points to **Sites** | No site exists yet | Create a site and add a server in [Sites](hybrid-sites.md) |
| A copy stays **Queued** with *No keys named ...* | The site's server has no keys under the target's key name | Add them on every server of the site ([how](../workflows/mirror-and-archive.md#copies-to-an-object-store)); the copy retries by itself |
| A copy stays **Queued** with *is not there (is the share mounted?)* | The folder is not on the site's server, or the share is not mounted | Mount it at the target's folder; the copy retries by itself |
| A copy shows **Corrupt** or **Missing** | A check found it changed or gone at the target | Find what changed it at the site; copy it again |

## Through the API

| Request | Does |
|---|---|
| `GET /api/storage/capabilities` | What your service can do, with the default ladder |
| `GET /api/storage/objects` | Lists media; filter with `state`, `channelId`, `recordingId`, `limit` |
| `GET /api/storage/objects/{id}` | One piece of media, with its copies, history and whether it can be read |
| `POST /api/storage/objects/{id}/hold` | Holds or releases it (`{"hold": true, "reason": "Legal hold"}`; a hold needs a reason) |
| `POST /api/storage/objects/{id}/restore` | Asks for an archived piece to be restored |
| `GET /api/storage/retention` | The retention rules |
| `GET /api/storage/retention/effective?channelId={id}` | Which rule governs a channel (or `eventId`), and where it comes from |
| `PUT /api/storage/retention` | Saves a rule; add `channelId` or `eventId` for a rule that applies to one stream only. `originalAfterDays` takes originals out of the cloud once archived (Mirror and Archive); `includeUploads` covers uploads and watch folder files |
| `GET /api/archive/originals`, `GET /api/archive/originals/{assetId}` | Originals removed from the cloud or waiting for their copy, and where one asset's original is |
| `POST /api/archive/originals/{assetId}/restore` | Brings a removed original back from its archive copy |
| `POST /api/storage/retention/preview` | The dry run |
| `GET /api/analytics/retention`, `PUT /api/analytics/retention` | Event data retention |
| `GET /api/archive/targets`, `POST /api/archive/targets`, `PATCH /api/archive/targets/{id}` | Mirror and Archive storage targets |
| `GET /api/archive/copies`, `POST /api/archive/copies/{id}/verify` | The copies with their state; checks one again now |

A rule for one channel or event replaces the account ladder for that stream completely; the console sets the account ladder only.

```bash
curl -X PUT "https://your-volt-host/api/storage/retention" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"Default retention","accountScope":true,"stages":[{"afterDays":90,"action":"delete"}]}'
```

Every route is in the [API reference](/api-reference).
