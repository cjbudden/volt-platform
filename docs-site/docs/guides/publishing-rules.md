---
title: Publishing Rules
sidebar_position: 9.7
description: Set where on-demand content goes when it is published and how it stays available, for the whole account and for each content type, stream or item.
guide: section
---

# Publishing Rules

Publishing Rules decides what a publish does: where on-demand content goes, when it becomes available and when it expires, who can watch it, and whether a review or a quality check must pass first. You set an **account default** here, and a content type, a channel, an event, a station or a single item can override any part of it.

![The Publishing Rules page: the publishing points, the account default with each of its fields, and the lists of content type and channel, event or station overrides](/img/screens/publishing-rules.png)

## What it is for

- **One default for everything.** Set once where published content goes (the catalogue, your registered apps, your social accounts), how long it stays up, and the access, geo and paywall settings it carries.
- **Overrides where they are needed.** A rule is a ladder of four rungs. Each rung stores only what it changes, and anything it leaves alone comes from the rung beneath:

  | Rung | Where you set it |
  |---|---|
  | Account default | Here, under **Account default** |
  | Content type | [Content Types](content-types.md), under **Publishing rule for this type** |
  | Channel, event or station | The stream's settings, on the **Access** tab |
  | A single item | The asset in the [Media Library](media-library.md), under **What a publish does for this item** |

  The higher rung wins: an item's own value beats its channel's, which beats its content type's, which beats the account default.
- **A gate before publishing.** Require an approved review, or block publishing while a quality check has failed.

Administrators set the default; the people who run a channel, an event or the library set the overrides.

## Before you start

- The places content can go. Only the catalogue, the apps registered to your account and the social accounts set up for it can be chosen. Apps are registered in API Keys & Apps; social accounts are added under Social accounts in the Admin area.
- **Account settings: Manage** to change the account default, a content type's rule or a stream's rule (see [Who can do it](#who-can-do-it)).

## Step by step

### Check your publishing points

1. Open **Admin** and choose **Publishing Rules** (under **Media setup**).
2. **Publishing points** lists where content can be published: **Catalogue** is always there, then each registered app (**App:**, its name and type) and each social account (the platform and its name). A faded one is switched off.
3. To add one, choose **Register an app or add a social account**.

### Set the account default

1. Under **Account default**, every field shows its current value. On this rung there is nothing to tick: change the values directly.

   | Field | Choices |
   |---|---|
   | **Publish to** | **Catalogue (portal)**, and each registered app and social account. With nothing ticked, publishing does nothing |
   | **Auto-publish** | **Publish automatically once built and gated**, or leave it off to publish by hand |
   | **Available from** | **When published**, or **At a set time** with a date and time |
   | **Expires** | **Never**, **After a number of days** (counted from when it becomes available), or **On a date** |
   | **Access rules** | Rules by viewer location, explained below. With none, the simpler fields below decide |
   | **Geo access** | **Worldwide**, **Only in these countries** or **Blocked in these countries**, with two-letter country codes such as `AU, NZ, GB` |
   | **Access** | **Free**, **Entitlement required** or **Paid (paywall)** |
   | **Paywall** | Tick **Paywall**, then a tier, a price in cents and a three-letter currency |
   | **Publish gate** | **Require an approved review before publishing** and **Block publishing while QC has failed** |

2. Choose **Save publishing rule**. **Saved.** appears beside the button.

### Override it for a content type, a stream or an item

1. Open the rule where it lives (see the table above). On a channel, event or station, open its settings and choose the **Access** tab. An event or station has to be created before its rule can be set.
2. Grey values are inherited; under each field name it says where the value comes from, for example **inherits: account default** or **inherits: content type rule**.
3. Tick a field to set it here. It changes to **set here** and its controls appear. The line at the top counts how many fields are set on this rung.
4. Choose **Save publishing rule**.
5. To go back to inheriting everything, untick the fields and save, or choose **Remove this rule (inherit everything)** (on a content type or a stream).

### See every override

1. On **Publishing Rules**, **By content type** lists the types that have their own rule and **By channel, event or station** lists the streams that do. Each row shows what it **sets** and its version.
2. Choose a row to open its rule underneath (**Rule for** and the name). Change it as above, or choose **Close**.
3. New content type rules are made in Content Types: choose **Open Content Types**. New stream rules are made in each stream's settings.

### Add access rules

Access rules give different access to viewers in different places, for example free at home and premium abroad.

1. Under **Access rules** (tick it first on a rung other than the account default), choose **+ Add rule**.
2. Under **For**, choose what the rule covers: the channel, event or station itself (or **This item** on an asset), **Linked live content (live streams carried by it)**, and **Linked on-demand content (VOD / AOD made from its recordings)**. **+ Add content type** limits it to content of chosen types.
3. Under **If**, choose **Viewer is located in** or **Viewer is not located in**, and type country codes. **WORLD** means everywhere.
4. Under **Then**, choose **Access is free**, **Access for members only** or **Access is premium**. For members and premium, list the user groups who get access. For premium, set the **Terms**: **Period** or **Published dates**, the length, price, tax and product key. **+ Add term** adds another.
5. **↑** and **↓** change the order of the rules; **✕** removes one. Save the publishing rule.

Rules are read from the top: the first rule that covers the content and matches the viewer's location decides. If rules cover the content but none matches where the viewer is, the viewer is told it is not available in their region. **Access for members only** means the viewer must be signed in to your app (and in one of the listed groups, if you name any).

Each premium term is kept in step with your products for payments when the rule is saved.

## How it connects

| Section | How it relates |
|---|---|
| [Media Library](media-library.md) | Publishing an asset follows its rule; each asset can override it for itself |
| [Content Types](content-types.md) | Each type can have its own rung of the rule |
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | Each stream can have its own rung, on the **Access** tab of its settings; it applies to what is recorded or cut from it |
| [Review](review.md) | **Require an approved review before publishing** waits for an approval there |
| [API Keys & Apps](api-keys-and-apps.md) | Registered apps are the publishing points you can choose |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See Publishing Rules and every override | Account settings: View |
| Change the account default, a content type's rule or a channel, event or station's rule | Account settings: Manage |
| Change a single asset's rule | Media library & publishing: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Couldn't load publishing rules.** | The page could not read the rules | Choose **Retry** |
| **Publish to** reads **nowhere (publishing is a no-op)** | No publishing point is ticked on the rung that decides | Tick **Catalogue (portal)** or an app, and save |
| **No registered apps yet. Register one under API Keys & Apps to publish to it.** | There are no apps to publish to | Register an app in API Keys & Apps, or publish to the catalogue only |
| **No social accounts configured for this account.** | No social account has been added | Add one under Social accounts |
| An app shows **disabled** | The app is switched off in API Keys & Apps | Switch it on there if it should receive content |
| A stream's **Access** tab says to create the event (or station) first | Rules belong to a stream that exists | Create it, then open its settings again |
| A stream's **Access** tab shows a message about your role instead of the rule | Stream rules are part of Account settings | Ask an administrator for Account settings access, or to set the rule |
| A country you typed disappears from **Geo access** | Only two-letter codes are kept | Use codes such as `AU`, `NZ`, `GB` |
| Viewers are told "Not available in your region." | Access rules cover the content, but none matches the viewer's country | Add a rule for that country, or a last rule for **WORLD** |
| Publishing an asset is refused because of the publish gate | **Publish gate** requires an approved review, or QC has failed | See [Review](review.md), or change the gate |

## Through the API

| Request | Does |
|---|---|
| `GET /api/publishing-rules` | Every rung that has been set, with its name |
| `GET /api/publishing-rules/points` | The catalogue, apps and social accounts you can publish to |
| `GET /api/publishing-rules/resolve` | What an item would get: pass `assetId`, or `schemaId` with `channelId` or `eventId` |
| `GET /api/publishing-rules/{scopeKind}/{scopeId}` | One rung: `account` (no id), `schema` (a content type) or `owner` (a channel, event or station) |
| `PUT /api/publishing-rules/{scopeKind}/{scopeId}` | Sets a rung (`{"settings": {...}}`) |
| `DELETE /api/publishing-rules/{scopeKind}/{scopeId}` | Removes a content type or stream rung; the account default cannot be removed |
| `GET /api/vod/{id}/availability`, `PATCH /api/vod/{id}/availability` | A single asset's own rung |

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"settings": {"targets": [{"kind": "portal"}], "expire": {"mode": "days", "days": 30}}}' \
  "https://your-volt-host/api/publishing-rules/account"
```

Every route is in the [API reference](/api-reference).
