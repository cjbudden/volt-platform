---
title: FAST
sidebar_position: 2.3
description: "Build a linear channel from your library: a run order that loops, the guide written for you, ad breaks, idents and filler, and each title's rights applied where viewers are."
guide: section
---

# FAST

A FAST channel is a linear channel built from what is already in your Media Library. You put films and series in a **run order**, and the channel plays it pass after pass, writes its own programme guide and signals ad breaks. No encoder runs: the channel is played out from media that is already packaged, so one small playout can run many channels.

![The New FAST channel form: name, kind of channel, group and time zone](/img/screens/fast-new.png)

## What it is for

- **Turning a library into a channel.** Films, shows and series, or audio, played on a loop.
- **Spreading titles across the week.** A run order is not a day long, so each pass starts at a different time of day and a film comes round at different hours without anyone scheduling it twice.
- **A guide without typing one.** Volt writes the programme guide from the run order, a week or more ahead, and keeps it topped up.
- **Ads.** Break markers for FAST platforms that sell their own ads, or ads from your own ad server stitched in for each viewer, with your house spots as the fallback.
- **A branded channel.** Idents between programmes, a brand loop for the gaps and your own slate.
- **Rights that follow the viewer.** Each title airs only where its rights allow. Viewers elsewhere see your geo replacement for that programme, then the channel again.

Programmers and channel managers use it.

## Before you start

- Titles in the Media Library whose rights allow **FAST**, packaged, or with their source still in Volt. The library only offers titles that can air.
- For a video channel, a **ladder** (the renditions viewers get). Titles are packaged to it in the background.
- Room in a channel group: a FAST channel counts towards the group's share of the plan like any channel.
- For stitched ads, the VAST tag URL of your ad server.
- For titles with territory rights, a loop or slate in **Loops & Fillers** to use as the geo replacement.

## How the page is laid out

A FAST channel has three tabs:

| Tab | What it holds |
|---|---|
| **Overview** | The output and its **Public** switch, what is on air now, the guide strip, **Going to air**, graphics, the channel URLs, the playout, the ladder and the media the channel uses |
| **Build** | **Run order**, **Week**, **Repeats**, **Ads** and **Brand & filler** |
| **Settings** | The channel's name and metadata, logo and artwork, **Where it can be watched**, the watermark, graphics and the ladder |

The buttons across the top are **QC** (a check of everything the channel needs), **Rewrite guide**, **Save draft**, **Activate**, **Share**, **Embed player**, live graphics, **Settings**, **Restart the playout**, **▶ Start** and **Go live** (or **Take off air**).

### Two kinds of change

| What you change | When it reaches air |
|---|---|
| The run order and its **Channel clock** | Only when you **Activate**. Until then it is a draft and the channel plays the active version |
| Break lengths, where breaks go, and **Idents between programmes** | On the next **Activate** or **Rewrite guide**, because breaks and ident time are written into the guide |
| House spots, the slate, the brand loop, idents that fill the gaps, the geo replacement | Within about a minute. They save as you change them |
| **Where it can be watched** | At once for new plays, within a minute at the CDN |

## Step by step

### Create the channel

1. Open **FAST** in the sidebar and choose **New FAST channel**.
2. Enter a **Name**.
3. Choose **What kind of channel?**: **Video channel** or **Audio channel (radio)**. It decides what the library offers and cannot be changed later. An audio channel is HLS only and has no ladder.
4. For a video channel, choose the **Ladder**. **Account default** is preselected. The library then offers only titles that fill the ladder's top rung (you can still show smaller ones, see below).
5. Choose the **Group** and the **Time zone**. The time zone is the guide's clock: grid rounding, the daily restart, prime time and dayparts are worked out in it.
6. Choose **Create and build lineup**. The channel opens on **Overview**, with an empty run order. Open **Build** to fill it.

**Example.** "Movies Plus", Video channel, ladder "HD 1080", time zone Australia/Sydney: the library offers 1080p titles, and the 15 minute grid and the 06:00 restart are worked out on Sydney time.

### Build the run order (Build > Run order)

The run order is a list of **slots** that loops. One time through the list is a **pass**, and each pass starts where the last one ended.

**Add slots from the library.** On the left, **Titles** and **Series** list what can air on this channel. Search, or pick a collection to list its titles in the collection's order (**Add all** adds each as its own slot). **Find media…** opens the Media Library's full search. Choose a title to add a **title slot**, or a series to add a **series slot**. When titles were left out for being smaller than the ladder, **Show anyway** lists them too, marked **below ladder** (they are scaled up to the top rung).

**A title slot**

| Option | What it does | Example |
|---|---|---|
| **+ Alternates (take turns)** | Adds more titles to the slot. They take turns, one per play of the slot | Alternates [Film A, Film B, Film C]: pass 1 airs A, pass 2 B, pass 3 C, pass 4 A |
| **+ Drop a turn** | Adds a **Skip this turn** entry: on that turn the slot airs nothing | [Film A, Skip]: Film A airs every other pass |

If a title in the slot is outside its rights window when its turn comes, the next alternate is tried, then the channel's backfill (see **Channel clock**), else the slot is skipped for that pass and a notice says so.

**A series slot**

| Option | Choices | What it does | Example |
|---|---|---|---|
| **Episodes each time** | 1 to 24 | That many episodes back to back each time the slot comes round | 3: each pass airs the next three episodes |
| **Order** | **In episode order**, **Shuffled, no repeats** | In order runs season then episode. Shuffled plays every episode once in a new order each time through, never starting a pass with the episode the last one ended on | Shuffled for a sketch show |
| **At the end** | **Start again from episode 1**, **Drop out** | What happens after the last episode. Drop out airs nothing more from the slot | Drop out for a limited series |
| **Repeat of** | **No (new episodes)**, **Slot N (encore)** | Replays exactly what another slot of the same series last aired, marked "encore" | Slot 4 as an encore of slot 1: the morning episodes again at night |

The position in a series is kept per series, not per slot: two slots of the same series continue each other's episodes.

**Both kinds of slot**

| Option | Choices | What it does | Example |
|---|---|---|---|
| How often | **Every pass**, **Every 2nd pass** … **Every 14th pass** | The slot plays on one pass in N | Every 3rd pass |
| **starting on pass** | 1 to N | Which of the N passes it plays on | Every 3rd, starting on pass 2: passes 2, 5, 8 |
| **want # / week**, then **Set** | A number | Works out the frequency for that many plays a week | want 4 a week with 12 passes a week sets Every 3rd pass |
| **Ads** | **As the channel**, **Only after, never inside**, **None (ad-free)** | Overrides the titles' own ad rule. None means no breaks in or after the slot and its grid pad is never sold | None for a sponsored programme |
| Move, **Duplicate slot**, **Remove slot** | | Changes the order, adds a second showing in the same pass, or removes the slot | |

**What this run order does to a week** shows how long one pass is, how many passes air this week, when the next pass starts (or the daily start time), the ad minutes an hour and the clock times slot 1 airs at. One pass leaves out ad breaks and ident time, so the real passes in **Week** are a little longer. Notices under it warn about things like a run order so short it repeats titles within a few hours, a title outside its rights or a series that has run out of episodes.

### Set the channel clock (Build > Run order > Channel clock)

| Option | Choices | What it does to the channel | Example |
|---|---|---|---|
| **Time zone** | Any zone | The zone the guide is planned in | Europe/Paris: a 06:00 restart is 06:00 Paris time |
| **Restart the run order daily** | **No, free-running**, **Yes, at a fixed time** (06:00 to start) | Each day the run order starts again from slot 1 at that time. A programme that would run past it is not started: the one before is padded in the guide to the restart. Over 15 minutes of padding raises a notice | 06:00: a film that would start at 04:30 and end at 06:25 waits; 04:30 to 06:00 is filler, slot 1 opens at 06:00 |
| **Round programmes up to** | **No rounding (back to back)**, 1, 2, 5, 15 or 30 minutes, **The hour** | Pads each programme's guide end to the next clock boundary, so the guide reads like a traditional grid. The pad is filled (see **What fills a gap**) | 15 minutes: a 47 minute film starting at 20:00 gets 20:00 to 21:00 in the guide; the 13 minutes play the ident, house spots, then the brand loop or slate |
| **Rotate the run order each pass** | **No**, **By 1 slot** … | Each pass opens further down the list, so a title does not keep landing in the same part of the pass | 5 slots, by 2: pass 1 plays 1-2-3-4-5, pass 2 plays 3-4-5-1-2 |
| **Keep the guide written ahead** | 3, 7, 10 or 14 days | How far ahead the guide, and so the public EPG, is written. Volt tops it up when less than a day under that is left | 14 days for partners who want two weeks of EPG |
| **When a title is outside its rights window, play instead** | Backfill titles | For title slots only: when no alternate is inside its rights, the backfill closest in length airs. Without one the slot is skipped | Film X loses its rights on 1 March; from then its slot airs your 52 minute nature documentary |

Choose **Save draft** to keep your work. Nothing airs until you activate it.

![A FAST channel's Run order: the library of titles and series on the left, what the run order does to a week, then the series slot and the film slot](/img/screens/fast-run-order.png)

### Check the week before it airs (Build > Week and Repeats)

Both show the run order as you have it now, saved or not, so you can try a change before activating it.

- **Week** shows every programme of the coming seven days, hour by hour, with ad breaks marked. Choose a programme to see when it airs, its content, episode and pass, its ad breaks (including any made from the grid pad or shortened by the hourly cap) and its pad.
- **Repeats** lists how often each title airs this week, how many of those are in prime time (programmes starting 18:00 to 22:59), the closest repeat, whether a title airs at the same clock time twice, and when it airs.

![The Week tab: seven days side by side, every programme of the coming week at its start time on the half-hour grid](/img/screens/fast-week.png)

### Set up ads (Build > Ads)

**Ad breaks** decides the kind of ads:

| Choice | What viewers get | Example |
|---|---|---|
| **No ads** | Programmes back to back. The other ad settings are hidden | A promo channel |
| **Ad markers for a FAST platform** | Breaks carry SCTE-35 markers and play your house spots. The platform that carries the channel (Samsung TV Plus, Roku, Pluto, LG and others) puts its own ads in at the markers | A channel on Samsung TV Plus |
| **Stitched ads from your ad server** | Volt asks your ad server for each break and stitches the ads into each viewer's own playlist. House spots and the slate fill what is not sold, or the whole break when the ad server is slow or down | Your own app with your own ad sales |

**How much and where**

| Option | Default | What it does | Example |
|---|---|---|---|
| **Breaks go** | Inside programmes and between them | Or **Only between programmes** (content is never interrupted) or **Only inside programmes** | Only between, for a children's channel |
| **Ad load** | 8 min per hour | The ad time planned for each hour of content | 8 on a 100 minute film with 2 minute mid breaks and a 1 minute break after: six mid breaks and the break after, a 113 minute guide slot |
| **Never more than** | 0 (no cap) | A cap per clock hour. Breaks that would go over it are shortened, or dropped when under 15 s | 10: a 2 minute break at 20:50, when 9 minutes have already run since 20:00, airs as 1 minute |

**Inside programmes** (hidden when breaks go only between)

| Option | Default | What it does | Example |
|---|---|---|---|
| **Mid-programme break** | 120 s | The length of each mid break, which also sets how many there are | 90 s gives more, shorter breaks |
| **No break before** | 8 min | No break in the opening minutes | 15: nothing before 15 minutes in |
| **At least** | 10 min | The shortest time between two breaks | 20 on a 45 minute episode: two breaks at most |
| **None in the last** | 5 min | No break in the closing minutes | 10 for films with long endings |
| **Mid breaks only in titles over** | 20 min | Shorter titles get no mid break | 30: a 22 minute episode runs uninterrupted |
| **Use the title's own break points** | On | Act breaks marked on the asset are used first; otherwise breaks are spread evenly, always on a segment boundary | Breaks at the editor's cues at 24:10 and 51:30 |

**Between programmes** (hidden when breaks go only inside)

| Option | Default | What it does | Example |
|---|---|---|---|
| **Length of the break after a programme** | The same length every time | Or **Earned by the content before it**: ad load × the minutes since the last break, kept between **Shortest** and **Longest** and **Rounded to** a spot length | Earned at a load of 9: a 22 minute episode earns 195 s |
| **Break between programmes** | 60 s | The fixed length. 0 for none | 90 |
| **Only after at least** | 0 min | No break after a programme until this much content has played since the last one | 15 on a music video channel: a break after every few videos |
| **Sell grid pad as break time** | Off | When programmes are rounded up to the grid, a pad longer than **Only pads over** becomes ad time, up to **Sell at most** | On a 15 minute grid, 3 minutes of a 7 minute pad become an ad break; 4 minutes stay filler |

**Pod shape (stitched)**: **Most ads in a break** and **Longest single ad** (0 for no limit). Both are also sent to your ad server. A break never carries two ads from the same advertiser when the ad server names it.

**Dayparts** change the rules for programmes that start in a time window, for example more ads in prime time, fewer overnight, or between-only breaks on weekend mornings. Choose **Add daypart**, give it a name, the times and days, and fill only what changes: **Load**, **Cap**, **Mid break**, **After** and **Breaks**. Blank fields use the channel's setting. The first daypart that matches wins.

**Example.** "Prime time", 18:00 to 22:30, every day, Load 12, on a channel at 8: programmes starting in that window carry 12 minutes an hour.

**House spots and slate.** Add **House spots, in rotation** (titles of 2 minutes or less) and give each a **weight**: a spot with weight 3 comes round three times as often as one with weight 1. House spots fill unsold break time, the stitched breaks the ad server leaves short, and the gaps between programmes. The slate is set under **Brand & filler**.

**Ad server** (stitched ads). If the channel has none, the card opens when you choose stitched ads: fill in **Name**, **Vendor**, **VAST tag URL** (the macros it can use are listed under it) and **Time budget** (how long Volt waits for the whole answer before the break plays house spots), and choose **Add and use**. If your account already has ad servers, pick one under **Ask**. Then choose how to **Decide**: **For each viewer** (targeted, one request per viewer per break) or **Once per break for everyone** (cheapest). **Test** sends one real request for a break of your mid-break length and shows what came back; nothing is played.

The **Last 7 days** card (stitched ads only) shows decisions, paid fill, house spots, the ad server's response time, impressions, how many reached halfway and the end, and the creatives.

### Brand the channel and choose the filler (Build > Brand & filler)

**Idents between programmes** (needs at least one ident):

| Choice | What it does | Example |
|---|---|---|
| **No idents** | Gaps are house spots and the slate or loop | |
| **Idents fill the gaps** | The next ident opens any gap long enough for it (grid pad, the daily restart). The guide keeps its times. Without grid rounding or a daily restart there are no gaps, so no idents air | A 10 s sting at the start of every pad on a 15 minute grid |
| **Idents between programmes** | Room for the longest ident is kept after every programme (or after every few, with **Play an ident after every N programmes**), and the run order moves later by that much. Needs **Activate** or **Rewrite guide** | Idents of 8 s and 12 s: 12 s is kept after each programme. After every 3rd programme on a music channel: three videos, then the sting |

**Idents**: short stings and bumpers from the Media Library, up to 30 s each. They take turns, one per gap, in the same order every day.

**Filler**: what plays when nothing else does.

| Option | What it does | Example |
|---|---|---|
| **Brand loop** | Fills what is left of a gap between programmes, repeating as needed. Choose a loop from Loops & Fillers (any length) or a Media Library title of up to 3 minutes. Until it is prepared, the slate plays | A 20 s animated logo loop fills the end of every grid pad |
| **Slate** | Plays in ad breaks nobody sold, and in gaps when there is no brand loop. A still image becomes 10 s of picture with silence and repeats. Without one, a black slate plays | A "Movies Plus: back soon" still |
| **Play the brand loop in unsold ad breaks too** | In the channel's own feed, the loop replaces the slate in breaks. Viewers with stitched ads still get the slate in their unsold time | On a channel with ad markers |

**What fills a gap.** Every gap (grid pad, the pad before a daily restart, ident time) is played in this order: the next ident (if idents are on and it fits), then house spots (if you have any), then the brand loop, else the slate.

**Geo replacement**: what viewers outside a title's rights see. See **Rights and where viewers can watch** below.

### Put it on air

1. Choose **Activate**. The run order becomes the active version, the programmes and ad breaks are written to the guide for **Keep the guide written ahead**, anything not yet packaged for the ladder is prepared, and the playout starts. The channel is still **Private**: only the console can watch it.
2. Check it on **Overview**. **Preview as Console** shows the admin player with resolution, bitrate and distance from live; **Preview as Viewer** shows what viewers get, with the title, Up next and the watermark. **On air now** shows what the playout is sending this second, and **Going to air** lists the next hours exactly as the playout will play them: programmes, breaks, idents, house spots, the brand loop and the slate.
3. Choose **QC** for a check of the run order, the guide ahead, the media, the playout, the output and the public URL.
4. Choose **Go live** (or turn on **Public** on **Overview**). Viewers, the player, share links and embeds can now play the channel. **Take off air** makes it private again; the playout keeps running for the console.

**▶ Start** starts the playout without making the channel public (and activates the run order first if none is active). **Restart the playout** stops and starts it; it carries on from where the guide says it should be, and is needed after a ladder change for viewers to get the new renditions.

**Media** on Overview lists every title, house spot, ident, loop and slate the channel uses, with its role and whether it is ready. **Prepare N** packages any that are not. **Playout** shows where the channel runs, when it was last heard from, restarts and segments published.

**Trick-play.** When the output profile of the channel's group has **Trick-play for Apple and smart-TV players** on (see [Account settings](account-settings.md#turn-on-trick-play-for-apple-and-smart-tv-players)), the channel's HLS lists a keyframe list for each video size from its next start, and its DASH a trick-mode track, so Apple devices and smart TVs show pictures while viewers scrub. Nothing is re-encoded. Viewers who get their own ads (stitched per viewer) are not offered it, since the list shows the house fill rather than their ads.

### Change a channel that is on air

1. Edit the run order. Volt makes a draft; the channel keeps playing the active version.
2. Check **Week** and **Repeats**, then choose **Activate (carry on from now)**. The new version takes over when the programme on air ends, starting from its first slot. The pass count and each series' position carry on, so rotations and episodes continue where they were.
3. **Rewrite guide** (shown when no draft is open) writes the guide again from the active run order, from the end of the programme on air. Use it after changing break lengths or **Idents between programmes**. Programmes entered by hand in the EPG are never removed: they are reported as overlaps.

## Rights and where viewers can watch

A FAST channel is one output for everyone, but its titles carry their own rights. Volt applies them while the channel airs, programme by programme, from where each viewer is.

### Where the whole channel can be watched (Settings)

**Where it can be watched** sets who gets the channel at all:

| Choice | What it does | Example |
|---|---|---|
| **Everywhere** | No restriction (the account's own geo still applies) | |
| **Only in the countries listed** | Viewers elsewhere are refused the channel | AU, NZ for a channel licensed to Australia and New Zealand |
| **Everywhere except the countries listed** | Viewers in those countries are refused | Everywhere except US |

Countries are two-letter codes, separated by commas. Choose **Save**. New plays follow it at once, and the CDN within a minute. It is checked by the play gate, the public URL and the CDN, as for any channel.

### Each title's rights, while it airs

For every programme in the guide, Volt reads the title's rights:

- its **rights profile** (see [Rights](rights.md)): whether **FAST** is an allowed use, its territories (allowed, or blocked) and its rights window;
- the geo of its **publishing plan** (see [Publishing Rules](publishing-rules.md)), when it has one;
- whether access to it was removed.

Several lists combine to the strictest: a viewer must be in every allow list and in no block list. A viewer outside a title's rights sees the channel's **geo replacement** for the length of that programme, then the channel again. Everyone else sees the programme. A title whose rights window ends during a programme is replaced from that moment, for everyone.

Nothing is re-encoded and the channel's own output, guide and recordings do not change: Volt gives each audience its own version of the playlist, swapping that programme's segments for the replacement's.

**Example.** A film cleared for Australia and New Zealand airs at 20:00 to 21:40 Sydney time. Viewers in Australia and New Zealand watch the film. A viewer in the United Kingdom sees your "Not available in your region" loop until 21:40, then the next programme. If the film's rights end on 30 June, from that day a backfill title takes its slot (see **Channel clock**), or the slot is skipped.

### Choose the geo replacement (Build > Brand & filler)

1. Upload a loop or slate in **Loops & Fillers**: for example a branded loop that says the programme is not available in the viewer's region and what is on next.
2. Open **Build > Brand & filler** and, under **Geo replacement**, choose it in **Replace with**. Volt packages it for the channel's ladder (a few minutes), at the same segment length as the programmes, so it can stand in for them segment for segment.
3. **Restricted in the next two days** lists each programme whose title cannot be seen everywhere, when it airs and where it can be seen.

With **None** chosen, viewers outside a title's rights are refused for that programme: their player stops and reports that the programme is not available where they are. The card warns when restricted programmes are coming up without a replacement.

**Good to know**

- The replacement is shown in the channel's own playlists (HLS). DASH viewers outside a title's rights are refused for that programme.
- Viewers with stitched ads get the channel's playlists, without their own ads, while a programme is replaced for them.
- A rights or guide change reaches viewers within about 15 seconds.
- On Loops & Fillers, the item shows the channel under **Used by** with the role **Geo replacement**.

## How it connects

| Section | How it relates |
|---|---|
| [Media Library](media-library.md) | Where the titles come from; a title must be able to air to be offered |
| [Rights](rights.md) | Whether a title is cleared for FAST, where and until when |
| [Publishing Rules](publishing-rules.md) | A title's publishing plan; its geo applies on FAST too |
| [Loops & Fillers](loops-and-fillers.md) | The brand loop, the slate and the geo replacement |
| [EPG](epg.md) | The guide Volt writes for the channel; programmes entered by hand that overlap it are reported when you activate |
| [Live Streams](live-streams.md) | FAST channels are listed there with every other stream |
| [Analytics](analytics.md) | Viewing and ad delivery reports |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| Open FAST and see channels, run orders, previews and reports | TV channels: View |
| Put a channel on or off air, activate a run order, test a break decision | TV channels: Operate |
| Create a channel, edit run orders, ads, brand and filler, ad servers and where it can be watched, prepare titles, write the guide again | TV channels: Manage |
| Add or cancel an ad break on a FAST channel or live TV channel | TV channels: Operate |
| Add or cancel an ad break on an event or a radio station | Events: Operate or Radio stations: Operate |

FAST channels are TV channels, so FAST follows the TV channels level of your role. A role without TV channels does not see FAST and cannot use it through the API either. A role of the Viewer tier is held at View.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **No video assets can air yet** | Nothing in the library is packaged or has its source in Volt | Upload or package titles in the Media Library |
| **Not shown: N … with no usable source** | Those titles cannot be played out | Re-upload their source, or package them |
| **N smaller titles are not shown** | They are below the ladder's top rung | **Show anyway**, or use a smaller ladder |
| **Activate** is greyed out | The run order has no slots | Add at least one title or series |
| **A lineup this short repeats titles within a few hours** | One pass is short | Add titles, or accept the repeats |
| **N minutes of filler before the 06:00 restart** | The run order does not fit the day well | Add a shorter title, or move the restart |
| **Series … has run out of episodes** | The series slot is set to **Drop out** | Set it to start again, or remove the slot |
| **… is outside its rights window** | A title cannot air at that time | Add backfill under **Channel clock**, or renew its rights |
| **This group is full** | The group has no room left in the plan | Choose another group, or free a channel |
| Changes to break lengths or idents do not show | They are written into the guide | **Activate**, or **Rewrite guide** |
| Viewers get nothing after activating | The channel is still **Private** | **Go live**, or turn on **Public** on Overview |
| Some viewers get "not available where you are" for a programme | The title is not cleared where they are and there is no geo replacement | Choose one under **Brand & filler > Geo replacement** |
| A whole country gets nothing | **Where it can be watched** leaves it out, or the account's geo does | Check Settings, and the account's geo |

## Through the API

| Request | Does |
|---|---|
| `GET /api/fast/channels` | Lists FAST channels |
| `POST /api/fast/channels` | Creates one |
| `GET /api/fast/channels/{id}` | One channel with its lineups and output URLs |
| `GET /api/fast/library` | Titles and series that can air |
| `PUT /api/fast/lineups/{id}` | Saves a draft run order |
| `POST /api/fast/lineups/{id}/preview` | The week a run order would make, without saving it |
| `POST /api/fast/lineups/{id}/activate` | Activates it and writes the guide |
| `POST /api/fast/channels/{id}/on-air` | Opens or closes it to viewers (opening needs an active run order, 409 otherwise) |
| `PUT /api/fast/channels/{id}/ads` | Sets its ads, ident mode and brand loop |
| `PUT /api/fast/channels/{id}/filler` | Sets the slate, brand loop and geo replacement from Loops & Fillers (`slateFillerId`, `loopFillerId`, `geoFillerId`), and `breaksUseLoop` |
| `GET /api/fast/channels/{id}/rights` | The geo replacement, where the channel can be watched, and the restricted programmes of the next two days |
| `PUT /api/fast/channels/{id}/geo` | Where the channel can be watched: `{ "mode": "allow", "countries": ["AU", "NZ"] }` |
| `GET /api/fast/channels/{id}/readiness` | Whether each title, spot, ident, loop and slate is ready to air |
| `POST /api/fast/channels/{id}/prepare` | Packages what is not ready |
| `GET /api/fast/channels/{id}/rundown` | What goes to air next, as the playout plays it |
| `GET /api/fast/channels/{id}/ad-report` | Ad delivery for the last days |
| `GET /fast/{id}/s/{session}/ads.json` | For a player of your own: the paid ads in a viewer's recent breaks, when each plays and its `clickUrl` |
| `GET /fast/{id}/s/{session}/click/{break}/{ad}` | A viewer's click: Volt records it, tells the ad server and opens the advertiser's page |

Every route is in the [API reference](/api-reference).
