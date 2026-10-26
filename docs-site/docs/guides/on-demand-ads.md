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

- **Where the breaks go.** A pre-roll (only for titles long enough to deserve one), mid-rolls at the title's own cue points or every few minutes, never in the first or last minutes, and a post-roll if you want one. Or let your ad server decide where the breaks go (VMAP), as Google Ad Manager's ad rules and FreeWheel do.
- **Catch-up without the broadcast's ads.** A recording of a live channel or event (a full replay, or a programme cut from it) plays without the ads that were on air: each broadcast break is left out and filled with ads decided for the viewer.
- **Who fills them.** Your ad server first, then your house spots. A break is never left empty and the title never waits for a slow ad server.
- **Who sees none.** Viewers who paid, and if you choose signed-in members, play without ads. A title can also opt out on its own.
- **How the ads reach the player.** Volt picks for each viewer. Where the player can fetch each break's ads itself (HLS Interstitials: the Volt player in any modern browser, Android and smart TVs, and Apple devices), it does; everywhere else the ads are stitched into the stream, in HLS and, for titles encoded with DASH, in DASH too. You can force one or the other.
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

### Let the ad server decide where the breaks go (VMAP)

Some ad servers decide the breaks themselves: Google Ad Manager with ad rules, FreeWheel, and others that answer with a VMAP schedule (a list of breaks: before the title, at a time or a percentage into it, at the title's nth cue point, after it). Volt can take the breaks from there instead of from its own settings.

1. On the rule, under **Where the breaks go**, choose **The ad server places them (VMAP)**.
2. In **VMAP address**, paste the ad server's VMAP request, or leave it empty if the ad server's own tag already asks for VMAP. It takes the same macros as a VAST tag (such as `[CONTENT_ID]`, `[IP]`, `[CLIENTUA]`), plus `[CONTENT_DURATION]` (the title's length in seconds) and `[CUE_POINTS]` (the title's cue points in seconds, comma separated, so the ad server can place mid-rolls on them).
3. Under **Ad server**, choose the ad server that sends the schedule. VMAP needs one.
4. Choose **Save**.

What happens then:

- Volt asks for the schedule once for each playback, with that viewer's details, and puts each break on the nearest point where the video can switch (a segment start), exactly as it does with its own mid-rolls. A break at the very start is the pre-roll, one at the end the post-roll.
- Each break plays what the ad server lists for it, in its order: a VAST tag Volt asks, or the ads written into the schedule itself. Several breaks at the same moment play as one. A break is as long as its ads.
- The ad server's break trackers (break start and break end) are sent with the break's first and last ad.
- Only breaks that play in the stream are used: overlay (non-linear) breaks and breaks with offsets Volt cannot read are left out. `GET /api/vod/ads/assets/{id}/plan` lists them under `vmap.problems`.
- A schedule with no breaks plays the title without ads.
- When the ad server is slow or down, the viewer is not held up: the title plays the breaks your **Pre-roll**, **Mid-rolls** and **Post-roll** settings describe, filled with your house spots, and the ad server is not asked again for that play. The report counts these breaks as `vmap-timeout` or `vmap-error`.
- The title's own say still wins: a title marked `adRule: none` gets no ads, and `no_mid` keeps only the ad server's pre-roll and post-roll.
- A player that fetches each break's ads itself (HLS Interstitials) is given one copy of the title's breaks, taken from the ad server's schedule asked without a viewer and kept for five minutes; when the viewer reaches a break, Volt fills it from that viewer's own schedule, and leaves it empty if the viewer's schedule has no break there.

### Keep one title free of ads

In the title's metadata, set **adRule** to `none`. To keep only the pre-roll (no mid-rolls), set it to `no_mid`. FAST channels read the same setting.

### Catch-up: the broadcast's ad breaks replaced

A recording of a live channel or event already knows where its ad breaks were: every break an operator started with **Go to break**, and every break signalled in the source (SCTE-35). When on-demand ads are on with mid-rolls, a replay of that recording, or a programme clipped from it, plays without those breaks: Volt leaves them out of the stream (nothing is re-encoded) and plays a break decided for the viewer in each place, as long as the broadcast break was. There is nothing to mark by hand.

- Breaks are cut where the video can switch (a segment start), so a cut can be a second or two from the moment the break was signalled.
- The catch-up title's own time is the programme without the broadcast's ads: a one hour recording with eight minutes of breaks is a 52 minute title, and resume and bookmarks use that time.
- The broadcast breaks are the title's mid-rolls: no others are added every few minutes. The pre-roll and post-roll follow the rule as usual.
- A break cancelled before it aired is not cut. Changing a break changes the stream for new plays.
- Without mid-rolls (off in the rule, or the title is marked `adRule: no_mid` or `none`), and for viewers who play without ads, the recording plays as it was broadcast, ads included.
- Highlights joined from several parts of a recording have no single broadcast clock and get the rule's ordinary mid-rolls.
- A catch-up title with ads plays as HLS; a DASH stream with ads is not offered for it yet.

### See where a title's breaks would go

`GET /api/vod/ads/assets/{id}/plan` lists the breaks a title would get under its rule, or says why it gets none. Under VMAP it shows the ad server's schedule for the title (asked without a viewer): `schedule` is `vmap`, each break has `source` `vmap` with the ad server's break ids and offsets, and `vmap` says whether asking worked. For a catch-up title, `replaced` lists the broadcast breaks it cuts out, and those breaks have `source` `replace`. Mid-rolls are moved to the nearest point where the video can switch (a segment start), so they may sit a second or two from the time you set.

### What viewers see

In the Volt player an ad shows **Ad 1 of 2 · 0:12** in the corner, with **Learn more** when the ad has a page. A viewer cannot seek inside an ad. The progress bar marks where the breaks are: yellow for a break still ahead, grey once it has been watched. These words follow the player's translations, so a site that translates the player shows the ad in the same language (see [Player SDK](player-sdk.md)).

When a viewer pauses, resumes, mutes or unmutes during an ad, Volt tells the ad server each time it happens, not just the first time. With **Snapback** on, a viewer who skips past mid-rolls they have not seen plays the last of them first, then lands where they asked; a break already played is not played again. When the player fetches the ads itself (in a browser, on Android, on a TV), it plays them in the same picture and then carries on with the title where it stopped; on iPhone, iPad, Apple TV and Safari the device does the same with its own player.

Captions carry on across a break: they go quiet during the ads and come back in step with the title. Titles protected with DRM play their ads in the clear, and the title's protection applies again as soon as it resumes.

## How it connects

| Section | How it relates |
|---|---|
| [Media Library](media-library.md) | The titles, their cue points and the `adRule` setting; the house spots |
| [Content Types](content-types.md) | A content type can have its own rule |
| [Publishing Rules](publishing-rules.md) | Paid access decides who plays ad-free |
| [FAST](fast.md) | Shares the ad servers, the house-spot fill and the reporting |
| [Analytics](analytics.md) | The playback reports count ad time apart from the title, and the ads played and watched to the end |

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
| Under VMAP, breaks play only house spots and the report shows `vmap-timeout` or `vmap-error` | The ad server did not send its schedule in time, or answered with an error | Check the **VMAP address** and the ad server's time budget; `GET /api/vod/ads/assets/{id}/plan` shows what the ad server answered |
| Under VMAP, a title plays without ads | The ad server's schedule has no breaks for it, or only breaks Volt cannot play | `vmap.problems` in `GET /api/vod/ads/assets/{id}/plan` lists what was left out |
| A replay still shows the broadcast's ads | The rule has no mid-rolls, the title is marked `no_mid` or `none`, the viewer plays without ads, the break was not recorded as a break on the channel or event, or the item is highlights joined from several parts | Check `replaced` in `GET /api/vod/ads/assets/{id}/plan` |
| No **Learn more** on an ad | The ad has no click-through page in the ad server | Add one in the ad server |
| A DASH player gets no stream with ads, HLS plays | One of the ads chosen for that viewer exists only as an older TS file, which cannot be part of a DASH stream | Play the HLS address the play gate gives; ads prepared by Volt are always ready for both |
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

To let the ad server place the breaks, set `policy.schedule` to `vmap`, give the ad server, and optionally its VMAP request:

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://your-volt-host/api/vod/ads/rules/default" \
  -d '{"mode":"on","adServerId":"<your ad server>","policy":{"schedule":"vmap","vmapUrl":"https://ads.example.com/vmap?cid=[CONTENT_ID]&dur=[CONTENT_DURATION]&cues=[CUE_POINTS]"},"houseAds":[{"assetId":"<a short promo>"}]}'
```

What the play gate returns for a title with ads, and how a player of your own handles them, is in [The play gate](../api/play-gate.md#on-demand-ads). Every route is in the [API reference](/api-reference).
