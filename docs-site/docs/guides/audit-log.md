---
title: Audit log
sidebar_position: 10.95
description: See who changed or removed what, and when, including removals that were refused.
guide: section
---

# Audit log

The **Audit log** records who did what in your account and when: what was created, changed and removed, and every removal that was refused, with the reason the person was given. Most people come here to find out who removed or changed something, or to export a record for a review.

![The Audit log page: filter buttons and search above a list of changes, newest first](/img/screens/audit-log.png)

## What it is for

- **Every removal**, whatever was removed, with who did it and what went with it.
- **Every refused removal**, with the reason. A refused attempt can matter as much as a successful one.
- **Changes and creations** that Volt records, such as a renamed channel, failover turned on, or a change to the account-wide geo rule, with what changed from and to.
- **Exports** of what you have filtered, as CSV.

It is open to owners and administrators.

## Before you start

- You must be an Owner or Administrator.
- Nothing else: Volt records as things happen.

## Step by step

### Find a change

1. Open **Admin** and choose **Audit log** (under **Access**).
2. The list shows the newest first: **When**, **Who**, **Action**, **What** and **Detail**. The detail line says, for example, which fields changed or what was removed with something.
3. Filter by action with **All**, **Deleted**, **Delete refused**, **Changed** or **Created**; each shows how many there are.
4. Narrow further: type in **Search names, people, reasons…**, choose a kind of thing in **Everything**, a person in **Anyone**, and dates in **From** and **To**. **Clear** removes every filter.
5. Choose a row to open it: the entity id, the exact time recorded, and the full detail. Choose it again to close it.
6. **Newer** and **Older** move through the list 50 at a time.

### Export it

1. Filter the list to what you need.
2. Choose **Export CSV**. The file has the same rows, up to 50,000.

### What removing a channel records

- Only **owners and administrators** can remove a channel or radio station. Anyone else is refused, and the attempt is logged as **Delete refused**.
- **Stop it first.** A channel that is on air or still running cannot be removed. The reason is shown and logged.
- **See what goes with it.** Before you confirm, Volt shows the recordings, clips, published clips, programmes, scheduled clips and sources that will be removed with it, and asks you to type the channel's name. The log row says what was removed with it.
- To remove several at once, tick their rows and choose **Remove** in the bar that appears. Volt lists what will go, what will be skipped and why, and asks you to type "remove N".

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | Creating, changing and removing them is recorded |
| [Channel Groups](channel-groups.md), [Plan & limits](plan-and-limits.md) | Group and plan changes are recorded |
| [Account settings](account-settings.md) | Branding and geo changes are recorded |
| [Users & Roles](users-and-roles.md) | Who the **Who** column names |
| [Permissions map](permissions-map.md) | Shows that reading the log is for Owners and Administrators |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| Read, filter and export the audit log | Owner or Administrator |

Nobody can change or remove entries. Other users do not see **Audit log** in the menu.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Nothing matches these filters** | No entry fits every filter chosen | Try a wider date range or choose **Clear** |
| **Nothing recorded yet** | Nothing has been created, changed or removed yet | Entries appear as they happen |
| **The audit log is for administrators.** | You are not an Owner or Administrator | Ask one to look for you |
| **Export CSV** is unavailable | The filtered list is empty | Widen the filters |
| **Export failed.** | The file could not be made | Try again, or narrow the filters |
| **system** in the Who column | Volt did it itself, for example an automatic removal | Open the row for the detail |

## Through the API

| Request | Answers |
|---|---|
| `GET /api/audit` | Entries, newest first. Filter with `action`, `entityType`, `entityId`, `userId`, `q`, `from`, `to`, `limit` and `offset`. |
| `GET /api/audit/facets` | The actions, kinds of thing and people in your log, with counts |
| `GET /api/audit/export.csv` | The same filters as a CSV file, up to 50,000 rows |
| `GET /api/channels/{id}/delete-impact` | What would be removed with a channel, and anything stopping the removal right now |

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/audit?action=delete&limit=20"
```

Every route is in the [API reference](/api-reference).
