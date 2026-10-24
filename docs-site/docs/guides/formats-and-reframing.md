---
title: Formats & reframing
sidebar_position: 9.1
description: Choose which social formats Volt makes from your 16:9 media, what it keeps in frame, and which format each platform receives.
guide: section
---

# Formats & reframing

Volt can make vertical, square and portrait versions of your widescreen clips and assets for social platforms, following the people in each shot so they stay in frame. **Admin > Formats & reframing** sets this up for the whole account: which formats to make, what to keep in frame, how the framing may move, when it runs, and which format each platform receives. Operators check and adjust any one asset in its **Formats** tab in the Media Library.

![The Formats and reframing page: output formats and what to keep in frame on the left, publish targets and when it runs on the right](/img/screens/formats-and-reframing.png)

## What it is for

- **Social formats from one source.** **9:16 vertical** (TikTok, YouTube Shorts, Instagram Reels and Stories, Facebook Reels), **1:1 square** (Facebook, X and LinkedIn feeds) and **4:5 portrait** (Instagram and Facebook feeds), each made from the same tracking. The **16:9 source** is always kept as it is.
- **Keeping the subject in frame.** Volt finds faces, then people, shot by shot, and frames each format around them.
- **The right file for each platform.** When you publish, each platform can receive its own format instead of the 16:9 file.
- **A person in the loop.** Framing can wait for someone to approve it before it is published, or be approved automatically when Volt is sure.

Account administrators set it up; social and digital producers check and approve the framing per asset.

## Before you start

- Clips and assets in the Media Library, usually 16:9.
- For publish targets, social accounts linked under Admin > Social accounts. A platform with none says **No account linked**.
- Owner or Administrator to change these settings; anyone with access can read them (see [Who can do it](#who-can-do-it)).

## Step by step

### Choose the formats and what to keep in frame

1. Open **Admin** and choose **Formats & reframing**.
2. Under **Output formats**, tick the formats to make. Each is one extra encode per asset.
3. Under **What to keep in frame**, put the three choices in the order Volt should try them with the up and down arrows: **Faces** (the person on screen longest, then any face), **People** (bodies, when no face is found), and **The centre of the picture**.
4. Choose **Camera movement**: **Responsive** (follows the subject closely), **Steady** (holds still inside a shot and pans only when the subject would leave it) or **Locked per shot** (one framing per shot).
5. Choose **When the subjects will not fit**: **Whole picture on a blurred fill**, or **Follow the main subject**.
6. Leave **Keep faces clear of the platform's buttons** on to keep the subject clear of the buttons TikTok, Reels and Shorts draw on the right of a 9:16 video.
7. Choose **Save changes**. New analyses and renders use the settings; assets already framed keep their framing until they are analysed again.

### Send each platform its own format

1. Under **Publish targets**, turn on **Send each platform its own format**. When it is off, every platform receives the 16:9 file.
2. For each platform, choose **16:9 source**, **9:16 vertical**, **1:1 square** or **4:5 portrait**.
3. Choose **Save changes**. When you publish, a format not made yet is rendered first, and with approval required it is refused until approved.

### Decide when it runs and who approves

1. Under **When it runs**, turn on **Analyse every new clip and asset** to track every new one as it arrives (at a fraction of its running time), so its **Formats** tab is ready when you open it.
2. Turn on **A person approves the framing before publishing** to make every format wait for approval. Changing the framing takes the approval away.
3. With approval on, **Approve automatically when every shot's confidence is at least 0.90** lets Volt approve a format itself when it is that sure of every shot. Shots it is less sure of still wait for a person.
4. Choose **Save changes**.

### Check and adjust one asset

1. Open the asset in the Media Library and choose its **Formats** tab.
2. If it has not been analysed, choose **Analyse the picture**. Nothing is rendered until you ask.
3. Look at each format shot by shot, move the framing where needed, then render and approve it. **Back to Volt's framing** undoes your changes.

## How it connects

| Section | How it relates |
|---|---|
| Media Library | Each asset's **Formats** tab shows, adjusts and approves its framing |
| Social accounts | The platforms under **Publish targets**, and the accounts linked to them |
| Publishing Rules | Publishing to a platform sends the format chosen here |
| Recordings | Clips cut from recordings become assets that can be reframed |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the settings | Any signed-in administrator |
| Change the settings | Owner or Administrator |
| Analyse, adjust, render and approve an asset's formats | Media library & publishing: Manage |
| See an asset's formats | Media library & publishing: View |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Read only** at the top of the page | Only owners and administrators change these settings | Ask one of them |
| A platform's format cannot be chosen | **Send each platform its own format** is off | Turn it on |
| **No account linked** under a platform | No social account is linked for it | Link one under Social accounts |
| Publishing to a platform is refused | Approval is required and that format has not been approved | Approve it in the asset's **Formats** tab |
| A format shows **Out of date** | The framing changed after it was rendered | Render it again |
| An asset's framing did not change after saving here | Assets already framed keep their framing | Analyse the asset again in its **Formats** tab |

## Through the API

| Request | Does |
|---|---|
| `GET /api/account-settings/reframe` | The settings, the formats offered and the linked platforms |
| `PATCH /api/account-settings/reframe` | Changes them (owners and administrators) |
| `GET /api/vod/{id}/reframe` | One asset's formats and their state |
| `POST /api/vod/{id}/reframe/analyse` | Analyses an asset |
| `POST /api/vod/{id}/reframe/render` | Renders its formats |
| `POST /api/vod/{id}/reframe/formats/{format}/approve` | Approves one format |

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/account-settings/reframe"
```

Every route is in the [API reference](/api-reference).
