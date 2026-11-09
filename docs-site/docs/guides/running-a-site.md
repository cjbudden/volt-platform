---
title: Running a site
sidebar_position: 9.46
description: For whoever runs the servers at a site. Installing the Volt site agent, keeping it running, upgrading it, its credentials and storage, its logs, and what to check when a site goes quiet.
---

# Running a site

This page is for whoever looks after the servers at one of your [sites](hybrid-sites.md): your IT or broadcast engineering team. It covers the Volt site agent on each server, from installing it to finding out why a site has stopped reporting. Setting up sites, approving servers and choosing what runs there is done in the console, in [Sites](hybrid-sites.md).

## What the agent does

The agent is one program on each server of the site. Once the server is approved it:

- reports in every 30 seconds with what the server has (processor cores, memory, graphics cards, free disk, its own version and the encoder's);
- watches the site's on-prem watchfolders and uploads or registers what they accept ([Watchfolders](watchfolders.md#create-an-on-prem-watchfolder));
- with Hybrid Sites, encodes files whose original stays at the site ([Encoding at the site](hybrid-sites.md#encoding-at-the-site));
- with Mirror and Archive, makes and checks archive copies on your storage ([Copies of your media at your own sites](../workflows/mirror-and-archive.md)).

It only calls out, over HTTPS, to your Volt address. It listens on no port, so open no inbound ports for it.

## What a server needs

| Need | For |
|---|---|
| Linux, on a physical server or a virtual machine | Everything |
| Node.js 20 or later | Running the agent |
| Outbound HTTPS to your Volt address | Everything: reports, jobs, uploads |
| Outbound HTTPS to Amazon S3 in the region your Volt runs in, without a proxy that rewrites requests | Encodes at the site on Volt's cloud: the finished streams go straight to Volt's storage |
| Docker, usable by the agent's user, and the Volt encoder image | Encode at site |
| An NVIDIA graphics card with its driver (`nvidia-smi` working) | Encodes planned for a graphics card; optional |
| The watchfolders and storage targets mounted at the same path on every server of the site | Watchfolders and archive copies: whichever server is free takes the next job |
| Free disk in the agent's encode folder of about twice your largest file | Encode at site |

## Install and enrol a server

1. Install the agent package Volt gave you with the add-on. It provides the `volt-agent` command.
2. Choose the user the agent runs as (for example a `volt` user of its own). It needs to read your watchfolders, write their review folder (`_review`) and, for sidecars beside site-kept originals, write in the watchfolder; and to write to your archive folders.
3. In the console, open the site and choose **Make an enrolment token**. Copy the command shown and run it as that user:

   ```bash
   volt-agent site enrol https://your-volt-host vsenrol_...
   ```

   The agent reports the server's facts and saves its credential in `~/.volt-agent/site.json` (or the file you name after the token), readable by its owner only.
4. Back in the console, check the server's facts and choose **Approve**.

A token works once, for 24 hours. Each server gets its own token and its own credential.

## Keep it running

Start the agent with:

```bash
volt-agent site run
```

For encodes at the site, also name the encoder image (and its version, so Sites shows it):

```bash
VOLT_ENCODER_IMAGE=volt-encoder:<version> VOLT_ENCODER_VERSION=<version> volt-agent site run
```

Run it as a service, so it starts with the server and after your shares are mounted. With systemd, for example `/etc/systemd/system/volt-agent.service`:

```ini
[Unit]
Description=Volt site agent
Wants=network-online.target
After=network-online.target remote-fs.target docker.service

[Service]
User=volt
Environment=VOLT_ENCODER_IMAGE=volt-encoder:<version>
Environment=VOLT_ENCODER_VERSION=<version>
ExecStart=/usr/bin/env volt-agent site run
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

Then `systemctl enable --now volt-agent`. The agent retries by itself when the network or Volt cannot be reached; it stops only when Volt refuses it (see [Read the logs](#read-the-logs)). The service then starts it again every 30 seconds, and it is refused again until the cause is fixed.

Other settings, all optional, in the agent's environment:

| Setting | Does |
|---|---|
| `VOLT_SITE_SCRATCH` | The folder encodes work in (default `~/.volt-agent/encode`), emptied when each job ends |
| `VOLT_NVENC_SESSIONS` | How many encodes each NVIDIA card may run at once, reported to Volt; left unknown if not set |
| `VOLT_ARCHIVE_KEYS` | Where the object-store key file is, if not `archive-keys.json` beside the state file |

## Upgrade

1. Install the new agent package over the old one.
2. Restart the service (`systemctl restart volt-agent`). The state file is kept, so the server does not enrol again.
3. In **Sites**, check the server shows the new agent version.

For a new encoder image, pull it, change `VOLT_ENCODER_IMAGE` and `VOLT_ENCODER_VERSION`, and restart.

Work in progress is not lost. A job the server was running goes back to the site about two minutes after the agent stops and is taken again, by this server once it is back or by another. An upload that was cut off carries on where it stopped. To upgrade without any pause, upgrade one server of the site at a time.

## Credentials

- **The server's credential** is in its state file (`~/.volt-agent/site.json` unless you chose another). Keep the file readable by the agent's user only; anyone with it can act as that server.
- **Rotating** it is done in the console (**Rotate credential** on the server). The agent takes the new one on its next heartbeat; nothing needs doing on the server.
- **A server lost, stolen or retired:** choose **Reject** on it in Sites. Its credential stops working at once. To replace it, enrol the new server with a new token.
- **Object-store keys** for archive copies stay on the servers, never in Volt: `archive-keys.json` beside the state file, mode 600, or environment variables. Give every server of the site the same keys under the same name. See [Copies to an object store](../workflows/mirror-and-archive.md#copies-to-an-object-store).

## Shares and storage

- Mount each NAS share at the **same path on every server** of the site, and at boot, before the agent starts (`remote-fs.target` in the service above). The path is what the console names: the watchfolder's path, the storage target's folder.
- The agent's user needs to read the watchfolders and write in them (the review folder and sidecars), and to write, read and, for a copy that failed its check, delete in the archive folders. It never deletes a verified copy or any file it did not just write.
- For encodes, the file's folder is mounted into the encoder read only, with no network.
- Keep room in the encode folder for about twice your largest file. The free disk each server reports is shown in Sites.
- Exclude the encode folder from antivirus or anything else that rewrites files: a file changed on the way is refused and encoded again.

## Read the logs

The agent writes one line per event to its output (with systemd: `journalctl -u volt-agent`). Each line starts with what it is about:

| Starts with | About |
|---|---|
| `[site]` | Reports to Volt: `host approved` on each heartbeat, a rotated credential, a new configuration |
| `[watch]` | Watchfolders: each file accepted, refused, uploaded, registered or sent to review |
| `[encode]` | Encodes at the site: each job done, failed or refused |
| `[archive]` | Archive copies: each copy or check done or failed |

Lines that need you:

| Line | What it means | What to do |
|---|---|---|
| `[site] heartbeat failed, retrying: ...` | Volt could not be reached: network, DNS, proxy or firewall | Check outbound HTTPS from the server to your Volt address; the agent keeps trying |
| `[site] refused: ...` and the agent stops | Volt refused this server: it was rejected, the site is disabled, the add-on was taken away, or the credential is no longer valid | Look at the server and site in Sites. A rejected server needs a new enrolment token |
| `[site] ...: host pending` | The server is waiting for approval and takes no work | Approve it in Sites |
| `[watch] ... pass failed: ...` | A watchfolder could not be read | Check the share is mounted and readable by the agent's user |
| `[encode] ... failed: This host has no encoder ...` | The agent was started without the encoder image | Set `VOLT_ENCODER_IMAGE` and restart |
| `[archive] ... failed: ...` | A copy or check did not work; it is retried | The reason is also on the copy in Storage, with what to do |

## When a site goes quiet

When Sites shows a site **Degraded** or **Offline**, or a server **Stale** (no report for 90 seconds) or **Offline** (10 minutes):

1. **Is the server on, and the agent running?** `systemctl status volt-agent`. If it stopped, read the last lines of its log for `refused`.
2. **Can it reach Volt?** From the server, `curl -sI https://your-volt-host` should answer. A `heartbeat failed` line names the error.
3. **Is it still allowed?** In Sites: is the server approved, the site enabled? A rejected server must be enrolled again.
4. **Are the shares there?** `ls` the watchfolder and archive paths as the agent's user. A missing mount shows as a pass or copy failing, not as a quiet server.
5. **Is there disk?** Free disk under the agent's home and the encode folder.

While the site is quiet, nothing is lost:

- Files in watchfolders wait at the site and are taken in once the agent is back.
- Encodes wait for the site. A server that stopped mid-encode gives the job back after about two minutes. A watchfolder with a fallback time sends the original to the cloud once that time has passed, but only while some server of the site is running the agent ([fall back to the cloud](hybrid-sites.md#when-the-site-does-not-encode-it-fall-back-to-the-cloud)).
- Archive copies stay **Queued** and scheduled re-checks wait.
- Other servers of the same site carry on with all of it.
