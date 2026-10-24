---
title: Plan & limits
sidebar_position: 10.2
description: What your account is allowed, what is in use, and how your channel groups share it.
guide: section
---

# Plan & limits

**Plan & limits** shows what your account is allowed: how many channels and radio stations it may have in all, and how many may run at the same time. It shows what is in use against each, and how your channel groups share the plan out. Most people come here to see how much room is left before creating a new channel.

![The Plan & limits page: the plan name, three meters for channels and stations, shared out to groups and running at once, then the table of groups](/img/screens/plan-and-limits.png)

## What it is for

- **The plan.** Its name, the number of channels and stations allowed and the number that may run at once.
- **What is used.** TV channels and radio stations against the plan, what is running now, and how many events there are. Events are not counted in the plan.
- **How the groups share it.** Each [channel group](channel-groups.md) is given a share; the table shows how much of its share each one uses.

## Before you start

- Nothing is needed to read the page beyond the access below.
- Who changes the plan depends on how your Volt is run: where your platform provider sets the plan, ask them; where your organisation runs Volt for itself, the account owner changes it. The page says which applies under the plan name.

## Step by step

### See how much room is left

1. Open **Admin** and choose **Plan & limits**.
2. Under **Plan**, the name of your plan (for example **Standard**), and who sets it.
3. **Channels and stations** shows how many are **in use** of the plan, split into TV and radio, and how many are **free**.
4. **Shared out to groups** shows how much of the plan is **given out** to channel groups and how much is **not given out**.
5. **Running at once** shows how many are **running now** of the limit, and how many events there are (not counted in the plan).
6. **How the groups share the plan** lists each group with what it holds of its share and how many of its streams may run at once. **Manage groups** (or **View groups**) opens [Channel Groups](channel-groups.md).

### Change the plan

Only when **Change plan** is shown (see [Who can do it](#who-can-do-it)).

1. Choose **Change plan**.
2. Under **Plan**, choose **Standard**, **Pro**, **Enterprise** or **Custom…**. For a custom plan, type its name, for example "Broadcast 30".
3. Set **Channels and stations allowed**: TV channels and radio stations together. It cannot go below what already exists or what the groups are given.
4. Set **Running at once**: how many channels and stations may run at the same time across the account. It cannot go below what one group is allowed on its own.
5. Choose **Save plan**. The page confirms **Plan saved:** with the new figures. **Cancel** or Escape closes the form without saving.

Giving more of the plan to a group, or taking some back, is done on [Channel Groups](channel-groups.md).

## How it connects

| Section | How it relates |
|---|---|
| [Channel Groups](channel-groups.md) | Each group's share of the plan, which together never exceed it |
| [Channels](channels.md), [Radio](radio.md) | Each one counts towards the plan; **New channel** is unavailable when the plan or the group is full |
| [Events](events.md) | Listed here, not counted in the plan |
| [Account settings](account-settings.md) | Has a **Plan & limits** button that opens this page |
| [Audit log](audit-log.md) | Plan changes are recorded |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the plan, what is used and how it is shared | Account settings: View |
| Change the plan | The account owner, where your organisation runs Volt for itself; otherwise your platform provider |
| Share the plan between groups | Owner or Administrator, on Channel Groups |

Users who cannot change the plan see why, for example **The plan is set by your platform provider. Ask them to change it.**

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **The plan is used up.** | Every channel and station in the plan exists, so new ones cannot be created | Remove one you no longer need, or raise the plan |
| **At least ...: ... exist and the groups are given ...** | The number is below what exists or what is shared out | Use a higher number, or lower a group's share first |
| **At least ...: a group is allowed ... running at once.** | One group alone may run more than the number typed | Use a higher number, or lower that group's **Running at once** |
| **A whole number, 1 or more.** | A field is empty, zero or not a whole number | Type a whole number |
| **Check the highlighted fields.** | A field above has a problem | Fix the field marked in red |
| **Only the account owner or a system administrator changes the plan.** | You are not the owner | Ask the account owner |
| **Couldn't load the plan.** | The page could not reach Volt | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/plan` | The plan, what is used, and each group's share |
| `PATCH /api/plan` | Changes the plan (`planTier`, `maxChannels`, `maxConcurrent`), where you may |

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/plan"
```

Every route is in the [API reference](/api-reference).
