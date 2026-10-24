---
title: Audit log
sidebar_position: 8
description: See who changed or removed what, including removals that were refused.
---

# Audit log

The audit log records who did what in your account. It is open to owners and administrators.

## What is recorded

- **Every removal**, whatever was removed, with who did it and what went with it.
- **Every refused removal**, with the reason the person was given. A refused attempt can matter as much as a successful one.
- Changes and creations that Volt records, such as changes to the account-wide geo rule.

## Review it

Go to **Admin > Audit log** (under **Access**). Filter by action (**Deleted**, **Delete refused**, **Changed**, **Created**), by kind of thing, by person, by date range and by free text. Open a row for the full detail. **Export CSV** downloads what you have filtered.

![The Audit log page: filter buttons and search above a list of changes, newest first](/img/screens/audit-log.png)

## Removing a channel or station

- Only **owners and administrators** can remove a channel or radio station. Anyone else is refused, and the attempt is logged.
- **Stop it first.** A channel that is on air or still running cannot be removed. The reason is shown.
- **See what goes with it.** Before you confirm, Volt shows the recordings, clips, published clips, programmes, scheduled clips and sources that will be removed with it, and asks you to type the channel's name.
- To remove several at once, tick their rows and choose **Remove** in the bar that appears. Volt lists what will go, what will be skipped and why, and asks you to type "remove N".

## Channel limits

A group's limit counts **TV channels and radio stations together**. When a group is full, **New channel** (or **New station**) tells you why it is unavailable, and the create form will not let you pick a full group. If a group fills up while you are creating, the form says so, with the numbers, and suggests removing one, choosing another group or asking for a higher limit.

## Through the API

| Request | Answers |
|---|---|
| `GET /api/audit` | Entries, newest first. Filter with `action`, `entityType`, `entityId`, `userId`, `q`, `from`, `to`, `limit` and `offset`. |
| `GET /api/audit/facets` | The actions, kinds of thing and people in your log, with counts |
| `GET /api/audit/export.csv` | The same filters as a CSV file, up to 50,000 rows |
| `GET /api/channels/{id}/delete-impact` | What would be removed with a channel, and anything stopping the removal right now |
