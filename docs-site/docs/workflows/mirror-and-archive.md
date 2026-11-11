---
title: Copies of your media at your own sites
sidebar_position: 9
description: Keep checked copies of your originals, their sidecars, clips, packages and recordings on a folder, NAS share or S3-compatible store at one of your own sites, by rule and on a schedule.
guide: workflow
---

# Copies of your media at your own sites

Many broadcasters must keep their own copy of what they air and publish: for compliance, for their own archive or MAM, or simply so the media never exists in one place only. With the **Mirror and Archive** add-on, a server at one of your own sites writes those copies to storage you own, checks every one against the original, and checks them again on a schedule.

## What it is for

Archivists, media managers and the administrators who look after your sites use this flow. Set up once, it saves you from:

- downloading originals from Volt and copying them to your archive by hand;
- cutting each programme out of a channel's recording for compliance: each programme (or each clock hour) arrives at your storage as its own file with a metadata file beside it;
- wondering whether a copy is whole: a copy counts only once it has been read back and matched against the original, and it is read back again every 30 days unless you choose otherwise;
- archive traffic in busy hours: copies can wait for an off-peak window, and each storage target can have a speed cap.

Volt never replaces or deletes a verified copy at your storage. Keeping a target in step with deletes in Volt (mirror mode) is not available yet.

## Before you start

- **The Mirror and Archive add-on** on your account. Ask Volt to add it to your plan. Without it the Storage page has no **Mirror and Archive** section and Publishing Rules has no **Archive copies** field.
- **A site with at least one approved, Online server** running the Volt site agent ([Sites](../guides/hybrid-sites.md)). Mirror and Archive alone gives you sites; you do not need the Hybrid Sites add-on as well. Installing and running the agent is in [Running a site](../guides/running-a-site.md).
- **The storage itself, reachable from every server of the site:** a folder on the server, a NAS share mounted at the same path on each server, or an S3-compatible object store (MinIO, NetApp StorageGRID and similar) with its keys held on each server (see [Copies to an object store](#copies-to-an-object-store)).
- **Account administrator access** (owner or admin) for every step below.

## The flow

![Items in the Media Library and recordings are covered by copy rules in Publishing Rules, which send copy jobs to a server at your site; it copies each file to your storage and reads it back, and Storage shows the state of each copy](/img/flows/mirror-and-archive.svg)

- **Sites to your site's server:** only an approved server that is **Online** takes copy jobs, and only those of its own site.
- **Storage to Publishing Rules:** the storage targets you made, which copy rules name.
- **Media Library to Publishing Rules:** an item landing (an upload or watchfolder file), being published, the nightly pass, or a programme or hour of a recording ending.
- **Publishing Rules to your site's server:** a copy job for each file and each target, held back until the off-peak window opens if the rule has one.
- **Your site's server to your storage:** the file, downloaded from Volt through a link made for that one file, written to the target and read back.
- **Your storage to Storage:** each copy's state: **Verified** once it matches, **Corrupt** or **Missing** when a later check finds it changed or gone.

| Step | Section | What happens |
|---|---|---|
| 1 | [Sites](../guides/hybrid-sites.md) | A site with an approved server running the agent, which can reach your storage |
| 2 | [Storage](../guides/storage.md#keep-copies-at-your-own-sites-mirror-and-archive) | A storage target: a folder or NAS share on the site's server, or an S3-compatible store |
| 3 | [Publishing Rules](../guides/publishing-rules.md#copy-originals-to-your-own-storage) | Copy rules: which targets, what (original, sidecars, clips, package, recordings), when, and an off-peak window |
| 4 | [Storage](../guides/storage.md#keep-copies-at-your-own-sites-mirror-and-archive) | The copies with their state, the reason one waits, **Check now** |
| 5 | [Workflows](../guides/workflows.md) | **Archive copies** in the **Your sites** lane: runs, error rate, retries and the most common error |

## Step by step

### 1. Make the site ready

1. In **Admin**, **Sites**, create the site and add a server with an enrolment token, then approve it ([Sites](../guides/hybrid-sites.md#add-a-server)).
2. On every server of the site, mount the NAS share at the same path (for example `/mnt/nas/archive`), or put the object store's keys in place ([Copies to an object store](#copies-to-an-object-store)). Whichever server is free takes the next copy, so they must all see the same storage.
3. Check the site shows **Healthy** and the server **Online**.

### 2. Add a storage target

1. Open **Storage** and, under **Mirror and Archive**, choose **Add a storage target**.
2. Give it a **Name**, choose the **Site**, and choose the **Kind**: a folder or NAS share (the folder as the site's server sees it) or an S3-compatible store (its address as the server reaches it, the bucket, optionally a folder in the bucket, and the **Key name**).
3. Optionally set a **Speed cap (Mbit/s)** so copies leave room for live contribution, and how often copies are read back (every 30 days unless you change it).
4. Choose **Add target**.

The fields are described in full in [Storage](../guides/storage.md#keep-copies-at-your-own-sites-mirror-and-archive).

#### Copies to an object store

An object-store target names the store as the site's server reaches it (for example `http://minio.local:9000`), the **bucket**, and optionally a **folder** in it (the prefix, such as `Volt/Archive`). Copies land only inside that folder.

**The store's keys stay at the site.** Volt never asks for them and refuses them if they are sent. The target names its keys instead (`credentialRef`, for example `nas-minio`), and the server running the agent holds them:

1. On the server, make the file `archive-keys.json` beside the agent's state file (`~/.volt-agent/` unless you chose another place; or set `VOLT_ARCHIVE_KEYS` to its path):

   ```json
   {
     "nas-minio": {
       "accessKeyId": "your-access-key",
       "secretAccessKey": "your-secret-key"
     }
   }
   ```

2. Make it readable by its owner only (`chmod 600 archive-keys.json`). The agent refuses a key file others can read.
3. Or set the keys in the agent's environment instead: `VOLT_ARCHIVE_KEY_NAS_MINIO_ID` and `VOLT_ARCHIVE_KEY_NAS_MINIO_SECRET` (the name in capitals, other characters as `_`).

The agent reads the keys for every copy, so new keys take effect at once. Give every server of the site the same keys under the same name; whichever server is free makes the next copy. The keys need to write, read, list and delete in that folder: the agent deletes only a copy it has just written that did not check out.

As with a folder, every copy is read back from the store and matched against the original before it counts, and nothing in the store is ever replaced: a name already there gets `-2`, and the store is asked to refuse the write if the name is taken at the same moment. Large files go up in parts, one part in the server's memory at a time.

### 3. Decide what is copied, and when

1. Open **Publishing Rules** and the rung that should copy: the account default for everything, a content type, a channel, station or event, or one item.
2. Under **Archive copies**, tick the target and the moments: **When it lands**, **When it is published**, **Nightly**, and on a channel's, station's or event's rung (or the account default) **Recordings**.
3. Under **Copy**, choose what goes there: **Original**, **Sidecars**, **Clips**, **HLS/DASH package**, or a mix.
4. Optionally tick **Copy only between** and set an off-peak window.
5. Choose **Save publishing rule**.

The field is described in [Publishing Rules](../guides/publishing-rules.md#copy-originals-to-your-own-storage). What each choice copies:

#### Copy by rule

A **copy rule** copies originals without anyone asking. It lives in the [publishing rules](../guides/publishing-rules.md), so it can be set for the whole account, a content type, a channel, event or station, or one item, and the most specific level that says anything about copies decides.

- **Where and when:** each copy names a storage target and the moments to copy: **on ingest** (as soon as an upload or watch folder file has landed), **on publish** (when the item is published), **nightly** (once a day, anything the rule covers that the target does not hold yet, older items included) and **recordings** (as each programme or hour of a channel's or event's recording ends; see below).
- **What:** the **original**, its **sidecars**, **clips**, the **HLS/DASH package**, or any mix (the original alone unless you say otherwise). Sidecars sit beside the original under its name: `<name>.json` with the item's details and metadata, each caption file as it was delivered (`<name>.en.srt`, `<name>.fr.vtt`), any other file that came with the item (`<name>.news.xml`) and the poster (`<name>.jpg`). Each is copied and read back like the original. **Clips** covers items cut from a recording (clips, full-event replays, exports): the clip's file as made, for example `GoaloftheDay-Channel1-20261103-1414.mp4`, and a metadata file of the same name saying where it was cut from. A clip asked for as HLS only has no single file to copy; its package can be copied instead. The **HLS/DASH package** is the item as Volt streams it, as one folder named after the original (`MorningNews-package/`): the master playlist, the DASH manifest, every rendition's playlist and segments, laid out so the folder plays as it is. Every file is read back, and the package counts as archived only when every file is there and matches; a folder missing one file is not. Plan for the room: on our test library a package was about 1.7 times the size of its original at the median, from 0.1 times (a lightly compressed original) to 6 times (a small phone file), and a few hundred files. Packages go to folder targets (a server folder or NAS share) and to S3-compatible stores. In a store the package is one folder of objects under the target's folder in the bucket (`MorningNews-package/master.m3u8` and so on), each object read back. A folder name already in use there, even by a single object, gets `-2` for the whole package, and nothing already in the store is ever replaced. If a package cannot be finished, or does not read back whole, every object written for it is removed again, so no half package stays.
- **Off-peak window:** optionally, a window such as 22:00 to 06:00 in a time zone you choose. A copy asked for outside it waits until the window opens, so archive traffic stays out of busy hours.
- **Once per target:** an original, sidecar, clip or package already copied, or waiting to be, is not copied again. Copies are kept, never replaced or deleted by Volt (keeping a target in step with deletes is mirror mode, not available yet). A level that sets no copies switches copies off below a level that has them.
- **What is skipped, and why:** an item with no original kept, an item not packaged yet (for a package), or a disabled target or site, is skipped; the ingest or publish itself carries on.

#### Recordings in the archive

With **Recordings** ticked for a target, the recordings of the channels, stations and events the rule covers are archived as files your archive or MAM can take in without Volt:

- **One file per programme** when the channel has a guide, cut at the programme's start and end (as aired, when the as-run times are known). **One file per clock hour** in the channel's time zone when it has none (events use UTC). A programme or hour with nothing recorded makes no file.
- **The top rendition only, joined without re-encoding**: the picture and sound exactly as recorded. Cuts fall on the recording's segments, so a file starts and ends within about two seconds of the programme's edge.
- **Named** `Title-Channel-YYYYMMDD-HHMM.mp4` (an hour: `Channel-YYYYMMDD-HHMM.mp4`; a station: `.m4a`), in the channel's time zone. A name already taken at the target, such as the hour that repeats when the clocks go back, gets `-2`.
- **A metadata file beside it**, `<same name>.json`: the channel, the programme and its description, the start and end, the time zone, the file's size and SHA-256.
- **When:** a few minutes after the programme or hour ends, inside the rule's off-peak window if it has one. Both files are copied and checked like any other copy, and Volt's own working file is removed once every target holds a verified copy.
- **From when:** ticking **Recordings** starts with the next programme or hour that ends; recordings already kept are not copied.

### 4. Watch the copies

When a copy rule (or the API) asks for a file to be copied, the site's server makes the copy:

1. An approved, **Online** server of the site downloads the file through a link made for that one file, writes it to the target and reads it back.
2. The copy counts as **Verified** only when what the folder holds matches the original's checksum. A copy that does not match is removed from the folder and tried again; after its attempts it shows **Failed** with the reason.
3. Choose **Check now** on a copy to check it again whenever you like. The same checksum keeps it verified with a new date; a changed file shows **Corrupt**, and a file that is gone **Missing**. Copy it again to replace it: the new copy is written beside the damaged file, never over it.

Files are named after the original, with spaces and characters a storage device may not keep removed. A name already in the folder gets `-2`, `-3` added, so nothing at the target is ever overwritten.

Under **Copies** on the **Storage** page, every copy is listed with its target, its state, its size and when it was last confirmed. A copy that waits or failed shows the reason the site's server gave, and under it **What to do**.

#### Re-checks on a schedule

Every storage target reads its verified copies back on a cadence: every **30 days** unless you choose another (1 to 3650 days), or never on a schedule. A copy that still matches is confirmed again with today's date; one that changed shows **Corrupt** and one that is gone **Missing**, and neither is re-checked again until it is copied afresh. Disabling the target, or the site, pauses its re-checks.

### 5. Take originals out of the cloud

Once your originals are archived, the retention rule on the **Storage** page can remove each one from the cloud a number of days after it landed: under **Retention ladder**, in **Originals**, tick **Remove the original from the cloud** and set the days ([Storage](../guides/storage.md#take-originals-out-of-the-cloud-once-they-are-archived)). Only the original goes; the title keeps playing from its renditions.

An original is removed only once a **Verified** copy of that very file is at one of your targets, and never while another copy is still being made from it or a job is using it. Until then it stays, and **Originals out of the cloud** in this section says why and what to do.

To bring one back (for a re-encode, say), choose **Restore** on its row. A server at the site reads the copy, checks it against the checksum it was archived with and uploads it; Volt checks it again before the asset uses it. The site's servers need agent 0.12.0 or later for this.

### 6. See how the archive is doing over time

In **Workflows**, the **Your sites** lane has an **Archive copies** stage: how many copies and checks ran, how many failed, how long they took, retries and the most common error, on the map and in the report ([Workflows](../guides/workflows.md)).

## Who can do it

Every step needs an account administrator (owner or admin) on an account with the Mirror and Archive add-on: making sites and approving servers, storage targets and copies, **Check now**, and the **Archive copies** field of a publishing rule. Other roles do not see the **Mirror and Archive** section or the **Archive copies** field. Installing the agent and mounting storage on the site's servers is done by whoever runs those servers.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| No **Mirror and Archive** section on Storage | The account does not have the add-on, or you are not an account administrator | Ask Volt about the add-on, or an administrator for access |
| **Add a storage target** is missing and the section points to **Sites** | No site exists yet | Create a site and add a server in [Sites](../guides/hybrid-sites.md) |
| Copies stay **Queued** | No approved server of the site is **Online**, the site or target is disabled, or the off-peak window has not opened | Start the agent on a server of the site ([Running a site](../guides/running-a-site.md#when-a-site-goes-quiet)), enable the site or target, or wait for the window |
| An archive copy stays **Queued** with *the target folder is not there* | The folder is not on the server, or the NAS share is not mounted | Mount the share at the target's path; the copy is retried by itself |
| An archive copy shows **Failed** with a checksum mismatch | What arrived at the folder did not match the original, on every attempt | Check the storage at the site, then copy it again |
| An archive copy shows **Corrupt** or **Missing** | A check found the file changed or gone from the folder | Copy it again; look at what changes files on that storage |
| An original is **Kept, waiting** under **Originals out of the cloud** | Its retention rule is due but no verified copy of that file is held yet | Follow **What to do** on its row; it goes at the next sweep once the copy is verified |
| **The last restore failed** with *no longer matches* or *no longer at the target* | The copy at the site changed or went since it was archived | Check the copy again; the original has to come from elsewhere if the copy is gone |
| A restore stays **Being restored** | No server of the site with agent 0.12.0 or later is online | Update the agent and start it on a server of the site |
| A copy to an object store stays **Queued** with *No keys named ...* | The server running the agent has no keys under the target's key name | Add them to `archive-keys.json` on every server of the site, or set the environment variables the message names |
| A copy to an object store stays **Queued** with *can be read by others* | The key file is readable by other users of the server | `chmod 600` the key file |
| A copy to an object store stays **Queued** with *the store answered* and an error such as *AccessDenied* | The keys are wrong, or not allowed to write to that bucket | Check the keys and their permissions in the store |
| A copy to an object store stays **Queued** with *cannot be reached* | The server cannot reach the store's address | Check the endpoint is the address as the site's server sees it, and the network between them |
| A copy waits with a reason and **What to do** under it | The site's server could not make it yet; it is retried by itself | Follow **What to do**; the copy carries on once the cause is fixed |

## Through the API

The same flow from code. Every request needs an account administrator's session or the account secret key, on an account with Mirror and Archive; without the add-on the archive routes answer `403` with the code `licence_required`.

| Request | Does |
|---|---|
| `GET /api/sites`, `POST /api/sites`, `POST /api/sites/{id}/enrolment-tokens` | The sites, a new site, and a one-time enrolment token for a server (see [Sites](../guides/hybrid-sites.md#through-the-api)) |
| `GET /api/archive/targets`, `POST /api/archive/targets`, `PATCH /api/archive/targets/{id}` | Storage targets for Mirror and Archive: lists, makes and changes them (`recheckDays` sets the re-check cadence; `kind` `s3` with `s3` settings for an object store) |
| `PUT /api/publishing-rules/{scopeKind}/{scopeId}` with `archive` | A copy rule: `copies` of `{ "targetId", "on": ["ingest", "publish"] }` and an optional `offPeak` window |
| `POST /api/archive/copies` | Copies an asset's original to a target (`targetId`, `vodAssetId`) |
| `GET /api/archive/copies`, `GET /api/archive/copies/{id}` | Every copy with its state, where it is and when it was last confirmed |
| `POST /api/archive/copies/{id}/verify` | Checks a copy again now |
| `PUT /api/storage/retention` with `originalAfterDays` | Removes originals from the cloud that many days after they land, once a verified copy is held |
| `GET /api/archive/originals`, `GET /api/archive/originals/{assetId}` | What was removed and what waits, with why; where one asset's original is |
| `POST /api/archive/originals/{assetId}/restore` | Brings a removed original back from its archive copy |

1. Make a storage target on a site (a folder or NAS share):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Archive NAS", "siteId": "'$SITE_ID'", "path": "/mnt/nas/archive", "bandwidthMbps": 200}' \
  "https://your-volt-host/api/archive/targets"
```

   Or an S3-compatible store, naming the keys the site's servers hold:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Archive MinIO", "siteId": "'$SITE_ID'", "kind": "s3", "s3": {"endpoint": "http://minio.local:9000", "bucket": "archive", "prefix": "Volt/Archive", "credentialRef": "nas-minio"}}' \
  "https://your-volt-host/api/archive/targets"
```

2. Set a copy rule on the account default, copying originals as they land, between 22:00 and 06:00:

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"settings": {"archive": {"copies": [{"targetId": "'$TARGET_ID'", "on": ["ingest"]}], "offPeak": {"from": "22:00", "to": "06:00", "timeZone": "Europe/London"}}}}' \
  "https://your-volt-host/api/publishing-rules/account"
```

3. Follow the copies with `GET /api/archive/copies` (filter by target or state), and check one again with `POST /api/archive/copies/{id}/verify`.

Every route is in the [API reference](/api-reference).
