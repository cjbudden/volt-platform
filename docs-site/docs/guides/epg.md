---
title: EPG
sidebar_position: 3
description: Build the programme guide for a channel, station or event, control each slot, and turn programmes into on-demand assets.
guide: section
---

# EPG

The programme guide (EPG) says what is on, and when. Each channel, radio station and event has its own guide. Beyond the schedule itself, each programme slot can limit where it can be watched, put a slate or loop in place of the live feed, and become an on-demand asset once it has aired. Guides can also come in from, and go out to, other systems as XMLTV.

![The EPG list: one row per channel, station and event guide, with how many programmes it has, how far ahead it is filled and what is next](/img/screens/epg.png)

## What it is for

- **The schedule.** Programmes with a title, description, genre, rating and tags, added one by one, copied from another day or repeated daily, on weekdays or weekly.
- **Now and next.** The guide feeds the now and next panel on the stream's page and in the player.
- **Per-slot control.** For the length of one programme: allow or block countries, or replace the live feed with a slate, a loop or an on-demand asset.
- **After it airs.** With **Auto VOD** on, Volt cuts an on-demand asset of exactly that programme from the recording when it finishes, named and tagged from the guide.
- **Other systems.** Import a guide your provider already has (XMLTV from a URL, a hosted guide API or a file), and give partners such as set-top boxes and guide providers their own XMLTV feed.

Schedulers and presentation staff use it day to day.

## Before you start

- The channel, station or event the guide is for ([Channels](channels.md), [Radio](radio.md), [Events](events.md)).
- For **Auto VOD**, recording turned on for that stream: a programme can only become an asset if it was recorded.
- For a replacement, the slate or loop in [Loops & Fillers](loops-and-fillers.md) (you can also upload one while choosing it), or a ready asset in the Media Library.
- **EPG & schedules: Manage** to change a guide (see [Who can do it](#who-can-do-it)).

## Step by step

### Open a guide

1. Open **EPG** in the sidebar. Every channel, station and event is listed; filter with **All**, **Channels**, **Radio stations** or **Events**.
2. Choose **Open** on a guide that has programmes, or **Build** on one that has none yet. **New EPG** lists the streams without programmes and opens the one you pick.
3. From a channel's page you can also choose **Add EPG** on the "No programme guide yet" panel.

A channel or event page shows the guide from two hours back to eight hours ahead. When the guide has programmes but none in that window (it starts tomorrow, or ended last week), the page says **Nothing in the guide around now**, names the next programme (or the last one) and offers **Open EPG**. "No programme guide yet" appears only when the stream has no programmes at all.

A guide exists as soon as it has a programme; there is nothing to create first. The list shows each guide's programmes, **Coverage** (how far ahead it is filled) and **Next up**.

### Add a programme

1. In the guide, move to the day with **← Prev**, **Next →**, **Today** or the date box. **List** and **Timeline** switch between a table and the day on a time line; in the timeline, click empty time to add a programme there.
2. Choose **Add programme** and fill in:

   | Field | Notes |
   |---|---|
   | **Title** | Also names the on-demand asset if the programme is converted |
   | **Description**, **Genre**, **Rating**, **Tags** | Carried onto the on-demand asset. Tags become its keywords |
   | **Start** | Time on the selected day (HH:MM) |
   | **End** | Leave blank and the programme runs to the next one |

3. Under **Repeat**, leave **Does not repeat**, or choose **Daily**, **Weekdays** or **Weekly** and when it ends. A repeating programme shows **Repeats** in the list.
4. Set the slot controls if you need them (below), then choose **Add programme**.

To change a programme, choose **Edit** on its row (or click it in the timeline); **Delete** is in the same form, and **✕** on the row removes it straight away after you confirm. For a repeating programme, **Save and Delete apply to** **This one**, **This and following** or **All repeats**; one changed on its own shows **Repeat, edited**. **Stop repeating after this** ends the series at that programme.

### Copy or repeat a whole day

1. Open the day you want to copy and choose **Copy or repeat day…**.
2. Under **Copy to**, choose **Tomorrow**, **Next 7 days**, **Pick dates** or **Repeat**. Copies are independent: changing one later changes only that one.
3. Under **If a day already has programmes**, choose **Replace what is there** (recommended), **Only fill empty time** or **Keep both**. Replace never removes a programme that is on air or has aired, has an on-demand asset, or came from an imported guide: that slot is skipped instead.
4. Read **What will happen**, which says exactly what will be added or replaced, then confirm (for example **Copy to 1 day**). **Undo** is offered straight afterwards.

**Clear day** removes every programme on the day shown, after you confirm. It can be undone straight after.

Programmes may overlap. Volt allows it: saving one that overlaps shows **Saved, with a warning** and names the programme it overlaps, and the list highlights both rows. Check them before the day airs.

### Control a slot

In a programme's **Slot controls**:

| Control | Choices |
|---|---|
| **Geo access for this period** | **Worldwide** (no extra limit), **Allow only listed countries** or **Block listed countries**, with two-letter country codes separated by commas (for example `AU, NZ`) |
| **Replacement for this period** | **None** (air the live feed), **Slate image**, **Loop video** or **VOD asset**. Choose a slate or loop with **Choose from Loops & Fillers…** (a loop replacement also takes a slate, played as a gently moving loop), or upload one in the picker; choose a VOD asset from the assets that are ready to play. A slot saved before with an Image Library image shows it as **Not in Loops & Fillers**; it still works, and **Copy into Loops & Fillers** moves it over. Viewers the slot's countries leave out are given a replacement instead of the live feed for the slot: today that is the stream's own filler (the slate or loop under **Filler on total loss**, played as a loop) |

A programme's geo rule only narrows access further. It never opens up what the account or the stream already restricts ([Account settings](account-settings.md)).

### Turn programmes into on-demand assets

1. In the programme, turn on **Auto VOD** under **Post-broadcast VOD**.
2. When the programme finishes airing, Volt cuts an asset of exactly that period from the recording. It is named from the title and carries the genre, tags and rating. Find it in the Media Library.

The **VOD** column, and the box at the bottom of a programme's edit form, say where each slot is. A dash means the programme is not set to become an asset and has not aired yet.

| You see | Means | What you can do |
|---|---|---|
| **Auto VOD** | Set to become an asset once it has aired | Nothing; it happens on its own |
| **Converting** | The asset is being built | Wait |
| **VOD** | An asset exists for the slot | Choose it to open the asset; **Open VOD asset** in the edit form |
| **REC** with days left | Aired and recorded, not converted. The days are how long the recording is kept | **Convert now** in the edit form before then; **Play recording** to watch it |
| **VOD failed** | The conversion did not work | **Retry conversion** in the edit form |
| **Not recorded** | No recording covered it: recording was off, or the stream was down | Nothing can be cut from it |
| **Expired** | It was recorded, but the recording was removed at the end of its keep period | Nothing can be cut from it |
| **Unavailable** | A recording is listed but its media cannot be found | Nothing can be cut from it |

### Bring a guide in (XMLTV import)

1. On the EPG list, choose **XMLTV import**, then **New source**.
2. Give it a **Name** and choose **How the guide arrives**: **From a URL or hosted guide API, kept up to date**, or **Uploaded by hand**.
3. For a URL, choose whether it is **One request for the whole window** or **One request per day**, enter the **Guide URL** (the **Insert** buttons add the date placeholders an API needs), and set **Keep days ahead**, **Alert below (days)** and **Refresh every**. Add **Request headers** if the provider needs a key; they are stored encrypted and never shown again.
4. Set the **Source time zone** if the guide's times have no offset, then save.
5. Use **Try it** to load the provider's channel line-up without importing, and match each of their channels to a Volt channel (or **Don't use** it). **Import now** runs it straight away.

Each run updates what changed and removes what the provider no longer lists, so refreshes never pile up duplicates. If a guide runs shorter than the alert threshold, owners and administrators are alerted.

### Send the guide to partners (XMLTV export)

1. On the EPG list, choose **XMLTV export**.
2. To download once, set **Days back**, **Days ahead**, **Times** (**Scheduled**, or **As-run** for what actually aired) and **Time zone**, then **Download .xml**.
3. For a partner who polls a URL, choose **New feed**, name it after the partner, pick the channels (or all of them, including new ones) and the same options, then **Create feed**. The URL is shown once and needs no login, so treat it as a password: one feed per partner, and **New URL** or **Revoke** if it leaks.
4. Under **Channels in the guide**, give each channel a readable, stable **XMLTV ID** (for example `news.example.com`) and a **Guide icon**. Agree the ID with partners once: changing it later breaks their mapping.

### Radio stations

For a station, the guide also holds the log of what was played: each now-playing change becomes an entry with when it started and ended, classed as a song, an advert or other content. Recordings are searched and clipped by these entries ([Radio](radio.md)).

## How it connects

| Section | How it relates |
|---|---|
| [Channels](channels.md), [Radio](radio.md), [Events](events.md) | Each has its own guide; the stream's page shows now and next and opens its guide |
| [Loops & Fillers](loops-and-fillers.md) | What a stream falls back on when its source is lost, and where a programme's slate or loop replacement is chosen from |
| Recordings and Media Library | **Auto VOD** cuts an asset from the recording when a programme ends |
| [Graphics](graphics.md) | Graphics can run by rule or trigger from the guide (genre, title, programme start and end), and fields can show the current or next programme |
| [FAST](fast.md) | A FAST channel's guide is written for you from its run order |
| [Account settings](account-settings.md) | Account-wide geo rules; a programme's own rule only narrows them |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See guides, programmes, imports and feeds | EPG & schedules: View |
| Run and test an XMLTV import | EPG & schedules: Operate |
| Add, change, copy, repeat, clear and convert programmes; set up imports and partner feeds | EPG & schedules: Manage |
| Create Volt channels from an imported line-up | TV channels: Manage as well |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| Rows highlighted with the name of another programme | The two programmes overlap | Change one so they do not, unless the overlap is intended |
| **Not recorded** or **Expired** in the VOD column | The stream was not recording, or the recording was removed at the end of its keep period | Turn on recording for the stream, and **Auto VOD** for future programmes |
| **VOD failed** in the VOD column | The conversion did not work | Open the programme and choose **Retry conversion** |
| Copying a day skipped some slots | **Replace what is there** never removes programmes that are on air, aired, converted or imported | Expected; change those programmes on their own if needed |
| An import run says a channel is waiting | The provider added a channel you have not matched yet | In the import's line-up, match it to a Volt channel or choose **Don't use** |
| The guide runs out sooner than expected | The source sends fewer days than **Keep days ahead** | Check with the provider, or lower the alert threshold |

## Through the API

| Request | Does |
|---|---|
| `GET /api/epg?from=…&to=…` | Programmes in a window |
| `POST /api/epg` | Adds a programme |
| `PATCH /api/epg/{id}`, `DELETE /api/epg/{id}` | Changes or removes one |
| `POST /api/epg/copy-day`, `POST /api/epg/repeat`, `POST /api/epg/clear-day` | Copy, repeat and clear, as the console does |
| `POST /api/epg/{id}/convert` | Converts an aired programme to an on-demand asset |
| `GET /api/epg/now-next` | What is on now and next |
| `GET /api/epg/xmltv` | The whole guide as XMLTV |

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/epg/now-next"
```

Imports and partner feeds have their own routes under `/api/epg/import` and `/api/epg/xmltv/feeds`. Every route is in the [API reference](/api-reference).
