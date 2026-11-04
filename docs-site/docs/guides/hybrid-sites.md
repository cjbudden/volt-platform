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

An administrator sets a site up once and comes back when a server is added, replaced or stops reporting.

## Before you start

- **The Hybrid Sites add-on.** Sites appears under Admin only for an account that has it. Ask Volt to add it to your plan.
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

### Switch a site off

Choose **Disable site**. Its servers are refused until you choose **Enable site**; nothing is deleted.

## How it connects

| Section | How it relates |
|---|---|
| [Watchfolders](watchfolders.md) | Folders at a site, watched by the site's agent, follow (a later release of the add-on) |
| [Storage](storage.md) | Copies of media kept at a site will show there beside the cloud copies (a later release of the add-on) |
| [Workflows](workflows.md) | Work done at a site will appear on the map with its own success and error rates (a later release of the add-on) |
| [Audit log](audit-log.md) | Sites, enrolment tokens, approvals, rejections and new credentials are recorded |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the sites and their hosts | Account administrator (owner or admin) |
| Create, rename, disable and enable sites | Account administrator |
| Make and withdraw enrolment tokens, approve and reject servers, rotate credentials | Account administrator |

The page is not offered to other roles, and not at all without the Hybrid Sites add-on.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| No **Sites** under Admin | The account does not have the Hybrid Sites add-on, or you are not an administrator | Ask Volt about the add-on, or an administrator for access |
| The agent says the enrolment token is not valid | The token was used, withdrawn or is more than 24 hours old | Make a new one with **Make an enrolment token** |
| The agent says the site is disabled | The site was switched off | Choose **Enable site** |
| A server shows **Stale** or **Offline** | It has not reported for 90 seconds, or 10 minutes | Check the server is on, the agent is running and it can reach your Volt address over HTTPS |
| A server stays **Waiting for approval** | Nobody has approved it yet | Check its facts and choose **Approve** |
| **Make an enrolment token** is greyed out | The site is disabled | Choose **Enable site** first |
| **A site with this name already exists** | Names are unique in the account, ignoring capitals | Choose another name |

## Through the API

| Request | Does |
|---|---|
| `GET /api/sites`, `GET /api/sites/{id}` | The sites with their health, or one site with its hosts and unused tokens |
| `POST /api/sites`, `PATCH /api/sites/{id}` | Creates a site; renames, describes, disables or enables one |
| `POST /api/sites/{id}/enrolment-tokens` | A one-time enrolment token, returned once |
| `POST /api/sites/{id}/hosts/{hostId}/approve`, `.../reject` | Approves or rejects a server |
| `POST /api/sites/{id}/hosts/{hostId}/rotate-credential` | A new credential, handed to the agent on its next heartbeat |

Without the add-on these answer `403` with the code `licence_required`.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"expiresInHours": 24}' \
  "https://your-volt-host/api/sites/$SITE_ID/enrolment-tokens"
```

Every route is in the [API reference](/api-reference).
