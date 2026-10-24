---
title: Channel Groups
sidebar_position: 9.9
description: Group your channels, radio stations and events, choose each group's output profile and share out the plan between groups.
guide: section
---

# Channel Groups

Every channel, radio station and event in Volt sits in a **group**. A group decides whether what is in it transcodes or packages, which output profile it uses, and how much of your plan it may take: how many channels and stations it can hold and how many can run at once. Most people come here to add a group for a new kind of stream, or to move some of the plan from one group to another.

![The Channel groups page: the plan strip with what is shared out, then the table of groups with their workflow, output profile, share of the plan and events](/img/screens/channel-groups.png)

## What it is for

- **Choosing the workflow.** A group is either **Transcode** (one source in, Volt builds the ladder) or **Packaging** (a pre-encoded ladder, packaged as sent; radio stations use this). A channel or event takes its type from the group it is created in.
- **Choosing the output profile.** The group's output profile sets the renditions its streams produce. New streams in the group use it.
- **Sharing out the plan.** Your plan allows a number of channels and stations in total and a number running at once. Each group is given a share, and the shares never add up to more than the plan.
- **The default group.** One group is the default: new channels, stations and events start there.

The group's name is the grey line under each channel, station and event in the lists. A group is not a server or a pool: where a stream runs is decided by Volt, not by its group.

Account owners and administrators use this page when the account is set up and when the mix of streams changes.

## Before you start

- To create a group, room in the plan: the strip at the top says how much is **not yet shared**. If it is 0, lower another group's share first, or raise the plan under **Admin > Plan & limits**.
- To give a group an existing output profile, the profile must be of the same workflow type. Otherwise choose a new profile with the default ladder when you create the group.
- New groups, shares of the plan, the default group and removing a group need an Owner or Administrator. Renaming a group and changing its output profile need **Account settings: Manage** (see [Who can do it](#who-can-do-it)).

## Step by step

### Read the page

1. Open **Admin** and choose **Channel Groups**.
2. The strip at the top shows how many channels and stations are **in the plan**, how many are **shared out** to groups and how many are **not yet shared**. **Plan & limits** opens the plan itself.
3. Each row is a group:

   | Column | Shows |
   |---|---|
   | **Group** | Its name, with a **Default** tag on the default group |
   | **Workflow** | **Transcode** or **Packaging** |
   | **Output profile** | The profile its streams use |
   | **Share of the plan** | How many channels and stations it holds of its share, with a bar split into TV and radio |
   | **Running at once** | How many of its streams may run at the same time |
   | **Events** | How many events are in it |

### Create a group

1. Choose **New group**.
2. Type a **Name**. It is shown under each channel, station and event in the lists.
3. Under **Workflow**, choose **Transcode** or **Packaging**. This cannot be changed later.
4. Under **Output profile**, keep **New profile with the default ladder (1080p, 720p, 480p)** or choose an existing profile of the same type.
5. Under **Share of the plan**, set **Channels and stations** (the hint says how many the plan has not yet shared) and **Running at once** (up to the plan's limit for the whole account).
6. Tick **Make this the default group** if new channels, stations and events should start here.
7. Choose **Create group**. The page confirms **was created** and the group appears in the table.

### Change a group

1. Choose **Edit** on the group's row.
2. Change the **Name** or the **Output profile**. Only profiles of the group's own workflow are offered; the workflow itself is fixed, because a running channel never changes workflow.
3. Owners and administrators can also change **Channels and stations** and **Running at once**. A share cannot go below what the group already holds, or above what the plan has left for it.
4. Choose **Save changes**. The page confirms **was saved**.

### Make another group the default

1. Open the row's **More actions** menu and choose **Make default**.
2. The page confirms **is now the default group** and the **Default** tag moves to it.

### Remove a group

1. Open the row's **More actions** menu and choose **Remove**. The default group cannot be removed.
2. The dialog checks what is in the group. If it holds TV channels, radio stations or events, it lists them and the group cannot be removed yet: remove them first.
3. If the group is empty, type its name to confirm and choose **Remove group**. Its share of the plan becomes free to give to another group. This cannot be undone, and the removal is in the audit log.

**View its channels** in the same menu opens the Channels list.

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | Each is created in a group, takes its type from it and counts towards its share |
| [Encoding Profiles](encoding-profiles.md) | A file ladder can mirror a group's output profile, so uploaded files match the channels |
| [Plan & limits](plan-and-limits.md) | The account's total, which the groups' shares add up to no more than |
| [Audit log](audit-log.md) | Creating, changing and removing groups is recorded there |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the groups and the plan strip | Account settings: View |
| Rename a group, change its output profile | Account settings: Manage |
| Create a group, change a share of the plan, make a group the default, remove a group | Owner or Administrator |

Users who can only see the page are told **You can see the groups. Changes are made by account administrators.** Users with Account settings: Manage who are not administrators see the share fields greyed out.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **New group** is unavailable and **The whole plan (... channels and stations) is shared out.** | Every channel and station in the plan is given to a group | Lower a group's share with **Edit**, or raise the plan under **Plan & limits** |
| **At least ...: the group holds ...** | The share is lower than what is already in the group | Keep the share at or above that number, or remove some of its streams first |
| **At most ...: that is all the plan has left for it.** | Other groups hold the rest of the plan | Lower another group's share first |
| **At most ...: the plan's limit.** | **Running at once** is above the account's limit | Use a lower number, or raise the plan |
| **A whole number, 1 or more.** | A share field is empty, zero or not a whole number | Type a whole number |
| **Check the highlighted fields.** | A field above has a problem | Fix the field marked in red |
| **There is already a group called "..."** | Group names are unique in the account | Choose another name |
| **This is the default group.** when removing | The default group cannot be removed | Make another group the default first |
| **This group is in use.** when removing | Channels, stations or events are still in it | Remove the ones listed, then try again |
| **Couldn't load channel groups.** | The page could not reach Volt | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/groups` | Lists the groups with their profile, share and counts |
| `POST /api/groups` | Creates a group (`name`, `workflowType`, `maxChannels`, `maxConcurrent`, optional `outputProfileId` and `makeDefault`) |
| `PATCH /api/groups/{id}` | Renames it, changes its profile or share, or makes it the default (`{"isDefault": true}`) |
| `GET /api/groups/{id}/usage` | What is in a group and whether it can be removed |
| `DELETE /api/groups/{id}` | Removes an empty group that is not the default |
| `GET /api/plan` | The plan, what is used and how it is shared out |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Sport", "workflowType": "transcode", "maxChannels": 3, "maxConcurrent": 2}' \
  "https://your-volt-host/api/groups"
```

Every route is in the [API reference](/api-reference).
