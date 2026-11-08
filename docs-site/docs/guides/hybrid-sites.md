---
title: Sites
sidebar_position: 9.45
description: Enrol your own servers at your own locations with Volt, approve them, and see each site's health, hosts and versions.
guide: section
---

# Sites

Sites is where you look after the Hybrid Sites add-on: your own locations, such as a broadcast centre, where your own servers run the Volt site agent. Volt stays in charge of the work from the cloud; your servers do the heavy work close to your files. Most people come here to add a new server and approve it.

![The Sites page: a site with its health, its hosts with what each server has and when it last reported, one approved and one waiting for approval, and the Add a host section](/img/screens/sites.png)

## What it is for

- **Sites:** one for each location of yours that will run the agent, with a name and a note on where it is.
- **Adding servers:** a one-time enrolment token for each new server. The server reports what it has (processor cores, memory, graphics cards and how many encodes each can run at once, free disk) and then waits for you.
- **Approving:** a server takes no work until an administrator approves it. Reject one you do not recognise.
- **Health at a glance:** each site's health, the agent and encoder versions its servers run, and when each was last heard from.
- **Watchfolders at the site:** folders on your own storage that the site's agent sorts with Volt's rules, uploading accepted video, audio, images and captions to Volt and keeping refused files at the site (see [Watchfolders](watchfolders.md#create-an-on-prem-watchfolder)).
- **Archive copies at the site:** with the Mirror and Archive add-on, copies of your originals on a folder, a NAS share or an S3-compatible object store at the site, each one checked against the original (see [Keep archive copies at the site](#keep-archive-copies-at-the-site)).

An administrator sets a site up once and comes back when a server is added, replaced or stops reporting.

## Before you start

- **The Hybrid Sites add-on, or Mirror and Archive.** Either add-on gives you sites and their servers. Sites appears under Admin for an account with either one. Ask Volt to add the add-on to your plan.
- **A server at the site** (Linux, a physical server or a virtual machine) that can reach your Volt address over HTTPS. The agent only calls out: open no inbound ports.
- **The Volt site agent** installed on that server (Volt gives you the package with the add-on).
- **Administrator access** (see [Who can do it](#who-can-do-it)).

## Step by step

### Create a site

1. Open **Admin**, then **Sites** under Media setup.
2. Choose **New site**, give it a **Name** (for example *Main broadcast centre*) and, if you like, a **Description**.
3. Choose **Create site**. It opens, with no hosts yet.

### Add a server

1. Open the site and choose **Make an enrolment token**.
2. Copy the command shown, with **Copy**. It holds the token, which works once, for 24 hours, and is not shown again.
3. Run the command on the server at the site. The agent reports the server's facts and the server appears under **Hosts** as **Waiting for approval**.

A token you no longer need can be withdrawn with **Withdraw** under **Unused tokens**.

### Approve or reject a server

1. Open the site. A new server shows **Waiting for approval**, with what it reported: cores, memory, graphics cards, free disk and its versions.
2. Check it is the server you enrolled, then choose **Approve**. It may now take work at this site.
3. If you do not recognise it, choose **Reject**. Its credential stops working at once.

A server waiting for approval does not count towards the site's health, and neither does a rejected one.

### See whether a site is healthy

The tag beside each site sums up its approved servers:

| Health | Means |
|---|---|
| **Healthy** | Every approved server reported in the last few heartbeats |
| **Degraded** | Some approved servers have stopped reporting |
| **Offline** | No approved server has reported recently |
| **No hosts** | No server has been approved yet |
| **Disabled** | The site is switched off and its servers are refused |

Each server reports every 30 seconds. One not heard from for 90 seconds is **Stale**, and after 10 minutes **Offline**. The page refreshes itself every 30 seconds.

### Give a server a new credential

1. Open the site and choose **Rotate credential** on the server.
2. The agent picks up the new credential on its next heartbeat, and the old one stops working as soon as the new one is used. Nothing needs doing on the server.

### Watch a folder at the site

1. Make sure at least one server at the site is approved and **Online**.
2. In **Admin**, **Watchfolders**, choose **New watchfolder**, then **On-prem, at a site**, pick this site and type the folder's path on the server (see [Watchfolders](watchfolders.md#create-an-on-prem-watchfolder)).
3. The agent on each approved server of the site picks the folder up within a minute. It needs to read the folder and write its review folder (`_review` inside it).

The agent keeps sending heartbeats while it uploads, so a long upload never makes a server look **Stale**. A server waiting for approval does not watch any folder.

### Work that runs at the site

Some work can be sent to a site instead of running in Volt's cloud (the copies and encodes of later releases of the add-on). The servers of the site fetch it themselves:

- An approved, **Online** server asks Volt for the next job of its own site over HTTPS. It never sees another site's work, and nothing reaches into your network.
- The server reports progress as it goes. If it stops reporting for about two minutes (it was switched off, or lost its connection), the job goes back to the site and another approved server takes it.
- Files move through short-lived links made for one job and one file, valid for 15 minutes. The server cannot ask for any other file.
- A failed job is retried after a pause, and fails for good after its attempts are used up, with the reason the server gave.

A server waiting for approval is given no work. Work for a disabled site waits until you enable it.

#### Encoding at the site

With Hybrid Sites, a file can be encoded on a server of the site, so the original never leaves your network and only the finished streams come to Volt. Volt still decides how it is encoded: the server looks at the file, Volt picks the renditions, and the server encodes with exactly those settings. Volt checks every file of the result (each rendition, playlist and segment, at the size the server reported) before the video is ready; a result that does not check out is thrown away and encoded again.

To have a watchfolder's videos encoded at the site, open the on-prem watchfolder in [Watchfolders](watchfolders.md#create-an-on-prem-watchfolder) and set **Where it is encoded** to **Encode at site**. Then, for each video or audio file the folder accepts:

1. The agent sends Volt the file's facts, not the file: its name, size and checksum, its first bytes and what the site's encoder read from it (length, picture size).
2. Volt runs your [Ingest Rules](ingest-rules.md) on those facts (duplicates, holds, required metadata), makes the item in the Media Library and records where the original is: the site and its path there. The item reads **Processing** while the site encodes it.
3. A server of the site encodes it and sends only the finished streams. When Volt has checked them, the video is ready to play.

The original stays in the watchfolder at the site; Volt keeps no copy of it. A held duplicate is not encoded until someone chooses to keep it; it is then encoded at the site too. Images, captions, slates and loops in the same folder are still uploaded, as with **Upload and encode in the cloud**.

Start the agent with the Volt encoder image it should use:

```
VOLT_ENCODER_IMAGE=volt-encoder:<version> volt-agent site run
```

The server needs Docker. The encoder runs with the file's folder mounted read only and no network. Encodes planned for an NVIDIA graphics card go only to servers that reported one. Each encode works in `~/.volt-agent/encode` (or the folder `VOLT_SITE_SCRATCH` names), which is emptied when the job ends, so leave room there for about twice the size of your largest file.

### Keep archive copies at the site

With the **Mirror and Archive** add-on, the site's servers keep extra copies of your media on storage you own: a folder on the server, a NAS share mounted on it, or an S3-compatible object store on your network (MinIO, NetApp StorageGRID and similar). Storage targets and copies are on the [Storage](storage.md#keep-copies-at-your-own-sites-mirror-and-archive) page, and copy rules in [Publishing Rules](publishing-rules.md#copy-originals-to-your-own-storage).

1. On the **Storage** page, under **Mirror and Archive**, choose **Add a storage target**: a name, the site, and the folder as the server sees it (for example `/mnt/nas/archive`), or an object store (see [Copies to an object store](#copies-to-an-object-store)). Give it a **bandwidth cap** if copies must leave room for live contribution.
2. Copy rules (or the API) ask for an asset's original to be copied there. An approved, **Online** server of the site downloads it through a link made for that one file, writes it into the folder and reads it back.
3. The copy counts as **Verified** only when what the folder holds matches the original's checksum. A copy that does not match is removed from the folder and tried again; after its attempts it shows **Failed** with the reason.
4. Choose **Check now** on a copy to check it again whenever you like. The same checksum keeps it verified with a new date; a changed file shows **Corrupt**, and a file that is gone **Missing**. Copy it again to replace it: the new copy is written beside the damaged file, never over it.

Files are named after the original, with spaces and characters a storage device may not keep removed. A name already in the folder gets `-2`, `-3` added, so nothing at the target is ever overwritten.

#### Copies to an object store

An object-store target names the store as the site's server reaches it (for example `http://minio.local:9000`), the **bucket**, and optionally a **folder** in it (the prefix, such as `Volt/Archive`). Copies land only inside that folder.

**The store's keys stay at the site.** Volt never asks for them and refuses them if they are sent. The target names its keys instead (`credentialRef`, for example `nas-minio`), and the server running the agent holds them:

1. On the server, make the file `archive-keys.json` beside the agent's state file (`~/.volt-agent/` unless you chose another place; or set `VOLT_ARCHIVE_KEYS` to its path):

   ```json
   { "nas-minio": { "accessKeyId": "your-access-key", "secretAccessKey": "your-secret-key" } }
   ```

2. Make it readable by its owner only (`chmod 600 archive-keys.json`). The agent refuses a key file others can read.
3. Or set the keys in the agent's environment instead: `VOLT_ARCHIVE_KEY_NAS_MINIO_ID` and `VOLT_ARCHIVE_KEY_NAS_MINIO_SECRET` (the name in capitals, other characters as `_`).

The agent reads the keys for every copy, so new keys take effect at once. Give every server of the site the same keys under the same name; whichever server is free makes the next copy. The keys need to write, read, list and delete in that folder: the agent deletes only a copy it has just written that did not check out.

As with a folder, every copy is read back from the store and matched against the original before it counts, and nothing in the store is ever replaced: a name already there gets `-2`, and the store is asked to refuse the write if the name is taken at the same moment. Large files go up in parts, one part in the server's memory at a time.

#### Copy by rule

A **copy rule** copies originals without anyone asking. It lives in the [publishing rules](publishing-rules.md), so it can be set for the whole account, a content type, a channel, event or station, or one item, and the most specific level that says anything about copies decides.

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

#### Re-checks on a schedule

Every storage target reads its verified copies back on a cadence: every **30 days** unless you choose another (1 to 3650 days), or never on a schedule. A copy that still matches is confirmed again with today's date; one that changed shows **Corrupt** and one that is gone **Missing**, and neither is re-checked again until it is copied afresh. Disabling the target, or the site, pauses its re-checks.

### Switch a site off

Choose **Disable site**. Its servers are refused until you choose **Enable site**; nothing is deleted.

## How it connects

| Section | How it relates |
|---|---|
| [Watchfolders](watchfolders.md) | Folders at a site, watched by the site's agent with the folder's rules; accepted files are uploaded and taken in by Volt |
| [Storage](storage.md) | Mirror and Archive storage targets at a site, and the copies kept on them, with their state |
| [Publishing Rules](publishing-rules.md) | Copy rules decide what is copied to a site's storage, and when |
| [Workflows](workflows.md) | Work done at a site will appear on the map with its own success and error rates (a later release of the add-on) |
| [Audit log](audit-log.md) | Sites, enrolment tokens, approvals, rejections and new credentials are recorded |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the sites and their hosts | Account administrator (owner or admin) |
| Create, rename, disable and enable sites | Account administrator |
| Make and withdraw enrolment tokens, approve and reject servers, rotate credentials | Account administrator |
| Make storage targets and archive copies, check copies (Mirror and Archive) | Account administrator |

The page is not offered to other roles, and not at all without the Hybrid Sites or Mirror and Archive add-on.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| No **Sites** under Admin | The account has neither the Hybrid Sites nor the Mirror and Archive add-on, or you are not an administrator | Ask Volt about the add-on, or an administrator for access |
| The agent says the enrolment token is not valid | The token was used, withdrawn or is more than 24 hours old | Make a new one with **Make an enrolment token** |
| The agent says the site is disabled | The site was switched off | Choose **Enable site** |
| A server shows **Stale** or **Offline** | It has not reported for 90 seconds, or 10 minutes | Check the server is on, the agent is running and it can reach your Volt address over HTTPS |
| A server stays **Waiting for approval** | Nobody has approved it yet | Check its facts and choose **Approve** |
| **Make an enrolment token** is greyed out | The site is disabled | Choose **Enable site** first |
| **A site with this name already exists** | Names are unique in the account, ignoring capitals | Choose another name |
| Work for a site waits and does not start | No approved server of the site is **Online**, or the site is disabled | Start the agent on a server of the site, or choose **Enable site** |
| An archive copy stays **Queued** with *the target folder is not there* | The folder is not on the server, or the NAS share is not mounted | Mount the share at the target's path; the copy is retried by itself |
| An archive copy shows **Failed** with a checksum mismatch | What arrived at the folder did not match the original, on every attempt | Check the storage at the site, then copy it again |
| An archive copy shows **Corrupt** or **Missing** | A check found the file changed or gone from the folder | Copy it again; look at what changes files on that storage |
| A copy to an object store stays **Queued** with *No keys named ...* | The server running the agent has no keys under the target's key name | Add them to `archive-keys.json` on every server of the site, or set the environment variables the message names |
| A copy to an object store stays **Queued** with *can be read by others* | The key file is readable by other users of the server | `chmod 600` the key file |
| A copy to an object store stays **Queued** with *the store answered SignatureDoesNotMatch*, *AccessDenied* or *InvalidAccessKeyId* | The keys are wrong, or not allowed to write to that bucket | Check the keys and their permissions in the store |
| A copy to an object store stays **Queued** with *cannot be reached* | The server cannot reach the store's address | Check the endpoint is the address as the site's server sees it, and the network between them |
| An encode at the site waits with *This host has no encoder* | The agent was started without `VOLT_ENCODER_IMAGE` | Restart the agent with the encoder image set |
| An encode at the site waits with *is not there (is the share mounted?)* | The folder holding the file is not mounted on the server that took the job | Mount the share on every server of the site; the encode is retried by itself |
| An encode at the site fails with *not at the site* | The file was moved or deleted before it was encoded | Put the file back and encode it again |
| An encode planned for a graphics card never starts | No server of the site reported an NVIDIA card | Run the agent on a server with one, or choose an encoding profile that does not use the graphics card |
| An on-prem watchfolder's **Last pass** stays old | No approved server of the site is running the agent, or it cannot read the folder | Check the server here; the folder's page shows the agent's last error under **Last scan failed** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/sites`, `GET /api/sites/{id}` | The sites with their health, or one site with its hosts and unused tokens |
| `POST /api/sites`, `PATCH /api/sites/{id}` | Creates a site; renames, describes, disables or enables one |
| `POST /api/sites/{id}/enrolment-tokens` | A one-time enrolment token, returned once |
| `POST /api/sites/{id}/hosts/{hostId}/approve`, `.../reject` | Approves or rejects a server |
| `POST /api/sites/{id}/hosts/{hostId}/rotate-credential` | A new credential, handed to the agent on its next heartbeat |
| `GET /api/archive/targets`, `POST /api/archive/targets`, `PATCH /api/archive/targets/{id}` | Storage targets for Mirror and Archive: lists, makes and changes them (`recheckDays` sets the re-check cadence; `kind` `s3` with `s3` settings for an object store) |
| `PUT /api/publishing-rules/{scopeKind}/{scopeId}` with `archive` | A copy rule: `copies` of `{ "targetId", "on": ["ingest", "publish"] }` and an optional `offPeak` window |
| `POST /api/archive/copies` | Copies an asset's original to a target (`targetId`, `vodAssetId`) |
| `GET /api/archive/copies`, `GET /api/archive/copies/{id}` | Every copy with its state, where it is and when it was last confirmed |
| `POST /api/archive/copies/{id}/verify` | Checks a copy again now |

Without either add-on the sites routes answer `403` with the code `licence_required`; the archive routes need Mirror and Archive.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Archive NAS", "siteId": "'$SITE_ID'", "path": "/mnt/nas/archive", "bandwidthMbps": 200}' \
  "https://your-volt-host/api/archive/targets"
```

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Archive MinIO", "siteId": "'$SITE_ID'", "kind": "s3", "s3": {"endpoint": "http://minio.local:9000", "bucket": "archive", "prefix": "Volt/Archive", "credentialRef": "nas-minio"}}' \
  "https://your-volt-host/api/archive/targets"
```

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"settings": {"archive": {"copies": [{"targetId": "'$TARGET_ID'", "on": ["ingest"]}], "offPeak": {"from": "22:00", "to": "06:00", "timeZone": "Europe/London"}}}}' \
  "https://your-volt-host/api/publishing-rules/account"
```

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"expiresInHours": 24}' \
  "https://your-volt-host/api/sites/$SITE_ID/enrolment-tokens"
```

Every route is in the [API reference](/api-reference).
