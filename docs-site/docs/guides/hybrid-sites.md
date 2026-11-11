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
- **The Volt site agent** installed on that server (Volt gives you the package with the add-on). Installing, running and upgrading it, and what to check when a site goes quiet, is in [Running a site](running-a-site.md).
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
2. Volt runs your [Ingest Rules](ingest-rules.md) on those facts (duplicates, holds, required metadata), makes the item in the Media Library and records where the original is: the site and its path there. While the site encodes it, the item reads **Building** with **At site** beside it, in the Media Library and on its page. The row says **Queued at site** until a server takes it, then **Encoding at site** with a percentage, and the item's page names the site that is encoding it.
3. A server of the site encodes it and sends only the finished streams. When Volt has checked them, the video is ready to play.

![A title from an Encode at site watchfolder on its asset page: Building with At site beside it, the sentence saying a server of the site Main broadcast centre is encoding it, and the Encoded row in Facts](/img/screens/hybrid-sites-at-site.png)

Once it is ready, the **Encoded** row in the item's **Facts** (and the top of its **Encode** tab) still says it was encoded at the site.

The original stays in the watchfolder at the site; Volt keeps no copy of it. A held duplicate is not encoded until someone chooses to keep it; it is then encoded at the site too. Images, captions, slates and loops in the same folder are still uploaded, as with **Upload and encode in the cloud**.

If your ingest rules write a sidecar (a `.json` or `.xml` file with the item's details, written beside an uploaded file), the agent writes it beside the original at the site: `Evening News.mp4.json` next to `Evening News.mp4`. It names the file as it is at the site (nothing is renamed there) and has the same content as the webhook. The watchfolder does not take it in as a new file. If a file of that name is already there, the agent leaves it as it is. If you edit the sidecar, the folder's rules decide the edited file like any other.

When a FAST channel needs one of these videos encoded again (aligned for splicing between programmes, at broadcast loudness for a house spot or ident, or in 1 second segments for a slate), **Prepare** sends that encode to the site that keeps the original, never to the cloud. The title shows as preparing while the site works and keeps airing its current version until the new one has been checked. If the site is disabled, Prepare says so and leaves the title as it is. On a channel with its own ladder, the copy packaged to that ladder (every rendition at the channel's picture sizes and frame rate) is made at the site too: Prepare sends it there, the readiness list shows the title as packaging to the ladder, and the title keeps airing its own encode until the site's copy has been checked. If the site's packaging fails, the readiness list says why and **Prepare** tries again; the video itself is not affected.

#### When the site does not encode it: fall back to the cloud

By default an item in an **Encode at site** folder waits for the site, however long that takes: the original never leaves your storage. If you would rather have it encoded in the cloud when the site cannot do it in time, set **If the site does not encode it** on the watchfolder's page (it shows when **Where it is encoded** is **Encode at site**) to one of the times offered, from 15 minutes to 1 day. Then:

1. Volt counts how long the item's encode has waited at the site with no server taking it. An encode a server is working on never falls back, however long it takes. A server that stopped reporting gives its job back, and the count starts again from then.
2. When the time has passed, Volt takes the encode back from the site and asks the site's agent for the original. The item still reads **Building**, now with **Sending to cloud** beside it, and its page says it is encoded in the cloud because no server of the site took the encode within the folder's fallback time. The audit log says it fell back, after how long, and why.
3. On its next pass the agent sends the original to Volt on the same resumable upload as an **Upload and encode in the cloud** folder (it carries on where it stopped if the connection drops). Volt checks it is the file that was registered, keeps it as the item's original and encodes it in the cloud like any upload; the item shows **In the cloud** beside **Building** while it is encoded. Afterwards the **Encoded** row in its **Facts** keeps saying it was encoded in the cloud, and why. The original stays in the folder at the site as well, and the folder's queue says the item was encoded in the cloud.

The agent can only send the file while a server of the site is running it. If the whole site is offline, the item waits until it is back, and the file goes then. If the file was replaced or deleted at the site in the meantime, the item shows **Failed** with the reason; a replaced file is taken in as a new item by the folder.

Start the agent with the Volt encoder image it should use:

```bash
VOLT_ENCODER_IMAGE=volt-encoder:<version> volt-agent site run
```

The server needs Docker. The encoder runs with the file's folder mounted read only and no network. Encodes planned for an NVIDIA graphics card go only to servers that reported one. Each encode works in `~/.volt-agent/encode` (or the folder `VOLT_SITE_SCRATCH` names), which is emptied when the job ends, so leave room there for about twice the size of your largest file.

The finished streams go from the site's server straight to Volt's storage, over HTTPS, one file at a time, each with a link that is good for that file only and for 15 minutes. Each file is checked against the checksum the server reported for it, so anything changed on the way is refused and sent again. Large files are sent from disk as they are read, so the agent does not need memory for them. The server needs outbound HTTPS to your Volt address and, on Volt's cloud, to Amazon S3 in the region your Volt runs in; allow both through your firewall.

### Keep archive copies at the site

With the **Mirror and Archive** add-on, the site's servers keep checked copies of your originals, their sidecars, clips, HLS/DASH packages and your channels' recordings on storage you own: a folder on the server, a NAS share mounted on it, or an S3-compatible object store on your network. Storage targets are made on the [Storage](storage.md#keep-copies-at-your-own-sites-mirror-and-archive) page and copy rules in [Publishing Rules](publishing-rules.md#copy-originals-to-your-own-storage). The whole flow, from the site to a verified copy, with object-store keys, recordings in the archive and re-checks, is in [Copies of your media at your own sites](../workflows/mirror-and-archive.md).

### Switch a site off

Choose **Disable site**. Its servers are refused until you choose **Enable site**; nothing is deleted.

## How it connects

| Section | How it relates |
|---|---|
| [Watchfolders](watchfolders.md) | Folders at a site, watched by the site's agent with the folder's rules; accepted files are uploaded and taken in by Volt |
| [Storage](storage.md) | Mirror and Archive storage targets at a site, and the copies kept on them, with their state |
| [Copies of your media at your own sites](../workflows/mirror-and-archive.md) | The Mirror and Archive flow end to end: site, storage target, copy rules, verified copies |
| [Running a site](running-a-site.md) | Installing, running and upgrading the agent on the site's servers |
| [Publishing Rules](publishing-rules.md) | Copy rules decide what is copied to a site's storage, and when |
| [Workflows](workflows.md) | Work done at a site has its own lane, **Your sites**, on the map and in the report: **Encode at site** and **Archive copies**, each with its runs, error rate, times, retries and most common error |
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
| An archive copy stays **Queued**, or shows **Failed**, **Corrupt** or **Missing** | The site's server could not make or confirm the copy | See the reason and what to do in [Copies of your media at your own sites](../workflows/mirror-and-archive.md#troubleshooting) |
| An encode at the site waits with *This host has no encoder* | The agent was started without `VOLT_ENCODER_IMAGE` | Restart the agent with the encoder image set |
| An encode at the site waits with *is not there (is the share mounted?)* | The folder holding the file is not mounted on the server that took the job | Mount the share on every server of the site; the encode is retried by itself |
| An encode at the site fails with *not at the site* | The file was moved or deleted before it was encoded | Put the file back and encode it again |
| An encode planned for a graphics card never starts | No server of the site reported an NVIDIA card | Run the agent on a server with one, or choose an encoding profile that does not use the graphics card |
| An encode at the site waits with *uploading ... failed (HTTP 403)* | The upload was refused by Volt's storage: often a proxy on the site's network that changes or strips the request's headers | Let the server reach Amazon S3 in Volt's region directly over HTTPS, without a proxy that rewrites requests; the encode is retried by itself |
| An encode at the site is encoded again with *does not match its declared SHA-256* | A file changed between the encoder and Volt (a proxy or antivirus that rewrites files, or failing storage) | Exclude the agent's encode folder from such software and check the storage; after its attempts the item says why |
| An item shows *the site could not send the original for the cloud encode* | The folder falls back to the cloud, but the file was no longer in the folder at the site (or had changed size) when the agent went to send it | Copy the file into the watchfolder again |
| An item shows *the original sent from the site is not the file that was registered* | The file at the site was replaced with other content before it was sent | Nothing to do: the folder takes the new content in as a new item |
| An item in an **Encode at site** folder stays **Building** with **Sending to cloud** beside it | The time has not passed yet, or the site is wholly offline, so its agent cannot send the original | Start the agent on a server of the site; the file is sent on its next pass |
| An on-prem watchfolder's **Last pass** stays old | No approved server of the site is running the agent, or it cannot read the folder | Check the server here; the folder's page shows the agent's last error under **Last scan failed** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/sites`, `GET /api/sites/{id}` | The sites with their health, or one site with its hosts and unused tokens |
| `POST /api/sites`, `PATCH /api/sites/{id}` | Creates a site; renames, describes, disables or enables one |
| `POST /api/sites/{id}/enrolment-tokens` | A one-time enrolment token, returned once |
| `POST /api/sites/{id}/hosts/{hostId}/approve`, `.../reject` | Approves or rejects a server |
| `POST /api/sites/{id}/hosts/{hostId}/rotate-credential` | A new credential, handed to the agent on its next heartbeat |

Without either add-on the sites routes answer `403` with the code `licence_required`; the archive routes need Mirror and Archive.

The Mirror and Archive routes (storage targets, copies, copy rules) are in [Copies of your media at your own sites](../workflows/mirror-and-archive.md#through-the-api).

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"expiresInHours": 24}' \
  "https://your-volt-host/api/sites/$SITE_ID/enrolment-tokens"
```

Every route is in the [API reference](/api-reference).
