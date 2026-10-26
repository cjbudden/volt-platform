---
title: On-demand ads
sidebar_position: 9.6
description: Put ad breaks in on-demand titles, filled by your ad server and your house spots, with ad-free viewing for viewers who paid.
guide: section
---

# On-demand ads

**On-demand ads** puts ad breaks in your on-demand titles: a pre-roll before the title, mid-rolls inside it, a post-roll after it. Volt asks your ad server (any VAST server: Google Ad Manager, FreeWheel, SpringServe, Magnite and others) what goes in each break and plays your own house spots in whatever it leaves empty, or when it is slow or down. Viewers who paid for a title can play it without ads. Most people set it up once for the account, and add a different rule for a content type that needs one, such as a kids series with no ads.

![The On-demand ads page: the last seven days at the top, then the account default with a pre-roll and mid-rolls every 10 minutes, house spots and the ad server](/img/screens/on-demand-ads.png)

## What it is for

- **Where the breaks go.** A pre-roll (only for titles long enough to deserve one), mid-rolls at the title's own cue points or every few minutes, never in the first or last minutes, and a post-roll if you want one.
- **Who fills them.** Your ad server first, then your house spots. A break is never left empty and the title never waits for a slow ad server.
- **Who sees none.** Viewers who paid, and if you choose signed-in members, play without ads. A title can also opt out on its own.
- **How the ads reach the player.** Volt picks for each viewer: on Apple devices the player fetches each break's ads itself (HLS Interstitials), everywhere else the ads are stitched into the stream. You can force one or the other.
- **Measuring.** Volt tells your ad server what was seen (impression, start, quarters, complete), and when a viewer clicks **Learn more**, it records the click, tells the ad server, and opens the advertiser's page.

## Before you start

- On-demand titles in the [Media Library](media-library.md), published.
- For paid ads, your ad server's VAST tag URL. Without one, breaks play your house spots only.
- For house spots, short items in the Media Library (up to two minutes): promos or sponsor spots.
- Access: see [Who can do it](#who-can-do-it).

## Step by step

### Turn on ads for the account

1. Open **Admin** and choose **On-demand ads**.
2. On **Account default**, turn on **Ads in on-demand titles**.
3. Set **Pre-roll** (length, and the shortest title that gets one), **Mid-rolls** (length, every how many minutes, not in the first and last minutes, and whether to use a title's own cue points) and **Post-roll** if you want one.
4. Under **Ad server**, choose your ad server, or add one under **Ad servers** with **+ Add ad server** (a name and the VAST tag URL). Ad servers are shared with FAST channels.
5. Under **House spots**, add one or more short items from the Media Library.
6. Leave **No ads for viewers who paid** and **Snapback** on unless you have a reason not to, and choose **Save**.

New plays follow the rule at once. Plays already started keep the ads they were given.

### A different rule for a content type

1. At the bottom of the rules, choose **+ A different rule for a content type** and pick the content type.
2. A copy of the account default appears for it. Change what differs (for a kids series, turn ads off) and choose **Save**.
3. **Use the account default** removes the content type's own rule.

### Keep one title free of ads

In the title's metadata, set **adRule** to `none`. To keep only the pre-roll (no mid-rolls), set it to `no_mid`. FAST channels read the same setting.

### See where a title's breaks would go

`GET /api/vod/ads/assets/{id}/plan` lists the breaks a title would get under its rule, or says why it gets none. Mid-rolls are moved to the nearest point where the video can switch (a segment start), so they may sit a second or two from the time you set.

### What viewers see

In the Volt player an ad shows **Ad 1 of 2 · 0:12** in the corner, with **Learn more** when the ad has a page. A viewer cannot seek inside an ad. With **Snapback** on, a viewer who skips past mid-rolls they have not seen plays the last of them first, then lands where they asked; a break already played is not played again. On iPhone, iPad, Apple TV and Safari the device plays the ads itself and keeps them in place.

## How it connects

| Section | How it relates |
|---|---|
| [Media Library](media-library.md) | The titles, their cue points and the `adRule` setting; the house spots |
| [Content Types](content-types.md) | A content type can have its own rule |
| [Publishing Rules](publishing-rules.md) | Paid access decides who plays ad-free |
| [FAST](fast.md) | Shares the ad servers, the house-spot fill and the reporting |
| [Analytics](analytics.md) | The playback reports count ad time apart from the title |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the rules and the last seven days | Media library & publishing: View |
| Change a rule, add an ad server | Media library & publishing: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| A title plays without ads | Ads are off for its content type, the title is marked `adRule: none`, it is shorter than the pre-roll needs and has no mid-roll, or the viewer paid | Check with `GET /api/vod/ads/assets/{id}/plan`, which says why |
| Breaks play only house spots | The ad server did not answer in time, returned nothing, or offered an ad Volt has not prepared yet. A new ad is prepared the first time it is offered and plays from the next time on | Check **Fill rate**; check the ad server's tag in **Ad servers** |
| **Fill rate** is low and timeouts are high | The ad server is slow | Ask your ad server to answer faster, or raise its time budget on the FAST page |
| No **Learn more** on an ad | The ad has no click-through page in the ad server | Add one in the ad server |
| **Couldn't load on-demand ads.** | The page could not reach Volt | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/vod/ads/rules` | The account default and each content type's rule |
| `PUT /api/vod/ads/rules/default` | Sets the account default |
| `PUT /api/vod/ads/rules/content-type/{id}` | Sets a content type's rule; `DELETE` removes it |
| `GET /api/vod/ads/assets/{id}/plan` | Where a title's breaks would go |
| `GET /api/vod/ads/report?days=7` | Plays with ads, fill rate, house share, completion, clicks |
| `GET /api/vod/ads/ad-servers` | The account's ad servers; `POST` adds one |

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://your-volt-host/api/vod/ads/rules/default" \
  -d '{"mode":"on","policy":{"preroll":{"on":true,"sec":15},"midroll":{"on":true,"sec":60,"everyMin":10}},"houseAds":[{"assetId":"<a short promo>"}]}'
```

What the play gate returns for a title with ads, and how a player of your own handles them, is in [The play gate](../api/play-gate.md#on-demand-ads). Every route is in the [API reference](/api-reference).
