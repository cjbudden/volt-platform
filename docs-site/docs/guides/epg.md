---
title: Programme guide (EPG)
sidebar_position: 3
description: Build a schedule for a channel, event or station, control each slot, and turn programmes into on-demand assets.
---

# Programme guide (EPG)

The programme guide says what is on, and when. A guide belongs to one channel, event or radio station. It drives:

- the **now and next** panel on the channel page and in the player.
- **geo access** for a period, for example a programme you may only show in some countries.
- **replacement** for a period, for example a slate during a programme you have no rights to.
- **on-demand conversion**: each programme can become a VOD asset automatically once it has aired.

## Open a guide

- From **EPG** in the menu, open a guide from the list, or start one for a channel or event that has no programmes yet.
- From a channel page, choose **Add EPG** on the "No programme guide" panel. It opens that channel's guide.

You do not need to create a guide first. A guide exists as soon as it has a programme.

The list shows each guide's kind, how many programmes it has, how far ahead it is filled (coverage), what is next, and its automation status.

## Build the schedule

The guide is edited one day at a time. Use **Prev**, **Next**, **Today** or the date picker to move between days.

### Add a programme

Choose **Add programme** and fill in:

| Field | Notes |
|---|---|
| **Title** | Also names the asset if the programme is converted to on-demand |
| **Description**, **Genre**, **Rating**, **Tags** | Carried onto the on-demand asset. Tags become its keywords. |
| **Start** | Time on the selected day |
| **End** | Leave blank and the programme runs to the next one |

Choose a row to edit it, or the ✕ on a row to remove it.

### Copy a day

**Copy day** copies every programme on the current day onto other days, at the same times, as independent copies. Choose **Tomorrow**, **Each of the next 7 days**, or **Specific dates**.

### Clear a day

**Clear day** removes every programme on the current day.

### Overlaps

Two programmes may overlap. Volt allows it, but warns you: a banner counts the overlaps on the day, and the overlapping rows are highlighted with the name of the programme they clash with. Check them before the day airs.

## Control each slot

Every programme has its own **slot controls**.

### Geo access for this period

| Option | Means |
|---|---|
| **Worldwide** | No extra restriction for this programme |
| **Allow only listed countries** | Only viewers in these countries can watch during the programme |
| **Block listed countries** | Viewers in these countries cannot watch during the programme |

Countries are two-letter codes, separated by commas (for example `AU, NZ`). A programme's geo rule can only narrow access further. It never opens up what the account or channel restricts. See [account settings](account-settings.md).

### Replacement for this period

Play something else instead of the live feed for the length of the programme:

| Option | Plays |
|---|---|
| **None** | The live feed |
| **Slate image** | A still image |
| **Loop video** | A loop asset |
| **VOD asset** | An on-demand asset from your library |

### Post-broadcast VOD

Turn on **Convert to a VOD automatically** and, when the programme finishes airing, Volt cuts an on-demand asset of exactly that period from the recording. The asset is named from the programme title and carries its genre, tags and rating. Find it in the **Media Library**.

The **VOD** column shows where each programme is:

| You see | Means |
|---|---|
| Set to auto-convert | Will be converted once it has aired |
| Already a VOD | Converted. The asset name is shown. |
| Convertible | Aired and recorded, not converted yet. Choose **Convert** to do it now. The column shows how long the recording is kept. |
| Failed | Conversion failed. Choose **Retry**. |
| Unavailable | Not recorded, or the recording has already been removed under your retention settings |

## Guides from and to other systems (XMLTV)

XMLTV is the common file format for programme guides.

- **XMLTV export** gives each partner (a set-top box, IPTV middleware or guide provider) its own feed URL. Choose how many days back and ahead to include and the time zone. The URL needs no login, so treat it like a password: use one feed per partner and rotate it if it leaks. A compressed version is available for systems that ask for it.
- **XMLTV import** brings a guide in from a URL or a hosted guide API, kept up to date on a schedule, or from a file you upload. You can set how many days ahead to keep and be alerted when the guide is running short.

## Radio stations

For a radio station, the guide also holds the **log of what was played**: each now-playing change from the station's metadata becomes an entry with the time it started and ended. Entries are classed as a song, an advert or other content. You can search recordings by these entries and clip from them.
