---
title: Storage
sidebar_position: 9.4
description: See what recorded media your account holds and where, set how long it is kept, and hold or restore individual pieces.
guide: section
---

# Storage

Storage shows what recorded media your account holds, where it is kept, and what the retention ladder will do to it next. Most people come here to set the ladder: after how many days recordings move to cheaper storage, are archived or are deleted.

![The Storage page: what this service can do at the top, the retention ladder, event data retention, the dry run, and the list of media with its state, tier and size](/img/screens/storage.png)

## What it is for

- **Set how long media is kept.** The retention ladder is a short list of rungs, each an age in days and an action: keep, move to cheaper storage, archive or delete.
- **See it before it happens.** A dry run says how many pieces of media the next sweep would move, archive or delete.
- **Look after one piece of media.** Every recorded run and export is listed with its state, where its copies are, and its history. You can put one on hold so retention never touches it, or ask for an archived one to be restored.
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
4. Choose **Save ladder**. **Saved.** confirms it.

Each rung fires once, at the age you set, counted from when the recording closed. Media that is already older than a rung goes straight to the last rung that applies. A ladder only moves one way: keep, then cheaper storage, then archive, then delete.

Recordings also have their own keep period, set on each channel, station or event (**Keep recordings for**). Both apply, so a recording goes when the first of them says so.

### See what the next sweep would do

1. Under **What the next sweep would do**, choose **Run a dry run**.
2. Volt counts what it looked at (**considered**) and how many would go **to cheaper storage**, be **archived** or be **deleted**. It also counts any **skipped on hold**, and any the ladder asks for that your service **cannot do**.

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

## How it connects

| Section | How it relates |
|---|---|
| [Recordings](recordings.md) | Every recording is media here; the ladder decides when it moves or goes, and **Removed** on a recording shows its keep period |
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | Each sets its own **Keep recordings for**, which applies alongside the ladder |
| [Media Library](media-library.md) | Clips and exports made from recordings are tracked here too |
| [Analytics](analytics.md) | Reports are built from the viewer data that **Event data** keeps |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the page, the ladder and the media list | Files, uploads & storage: View |
| Save the ladder, run a dry run, hold, release or restore media | Files, uploads & storage: Manage |
| See event data retention | Analytics & reports: View |
| Change event data retention, **Seal and prune now** | Analytics & reports: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **No media is tracked yet. It is registered as recordings are written.** | Nothing has been recorded yet | Turn on recording for a channel, station or event and run it |
| Only **Keep** and **Delete** in **Action** | Your service has one tier of storage, so there is nothing cheaper to move to | Use a keep-then-delete ladder; the first card says why |
| **Two stages both fire at** a number of **days** | Two rungs have the same age | Give each rung its own age |
| **A ladder cannot go backwards** | A later rung undoes an earlier one, for example cheaper storage after archive | Order the actions keep, cheaper storage, archive, delete |
| A message that an action is already the stage at an earlier age | The same action appears twice | Remove the repeated rung |
| **This media is archived. Request a restore before playing it; archived tiers take minutes to hours to become readable.** | The media is in the archive | Choose **Request restore** and wait |
| **A restore is in progress.** | A restore was asked for | Wait for the expected time, then choose **Refresh** |
| **This media has been deleted under a retention rule. It cannot be restored.** | The ladder deleted it; the row is kept as a record | Nothing to recover. Hold media you need before its delete rung |
| **This media is still being recorded.** | The recording is open | Wait until it closes |
| **Couldn't load event data retention.** | Your role cannot see analytics, or the request failed | Choose **Retry**, or ask for Analytics & reports access |
| **Couldn't load storage.** | The page could not be read | Choose **Retry** or **Refresh** |

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
| `PUT /api/storage/retention` | Saves a rule; add `channelId` or `eventId` for a rule that applies to one stream only |
| `POST /api/storage/retention/preview` | The dry run |
| `GET /api/analytics/retention`, `PUT /api/analytics/retention` | Event data retention |

A rule for one channel or event replaces the account ladder for that stream completely; the console sets the account ladder only.

```bash
curl -X PUT "https://your-volt-host/api/storage/retention" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"Default retention","accountScope":true,"stages":[{"afterDays":90,"action":"delete"}]}'
```

Every route is in the [API reference](/api-reference).
