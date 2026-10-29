# The public guide API (read only)

`/api/public/epg/*` is the programme guide for viewer apps: web, mobile, TV
and set-top front ends. It answers the questions every guide screen asks
(what is on now, what is next, what was just on, what is on today, what is on
across these channels tonight) and nothing else. It never writes.

Code: `src/modules/epgPublic.ts` (routes), `src/services/epgPublic.ts`
(public shape, now/next maths, cache). Tests: `test/epg-public.check.ts`.

## Where the guide comes from

One table, `programmes`, written three ways:

| Writer | How rows get there | `origin` in the API |
|---|---|---|
| Console schedule | EPG page, series, copy day | `schedule` |
| XMLTV import | import sources and channel mapping | `import` |
| FAST lineup | activating or topping up a lineup (`services/fast/store.ts`, `source_ref = 'fast:...'`) | `fast` |

So a FAST channel needs no separate "publish guide" step. Building and
activating the lineup creates the playback schedule, the playback schedule
is the guide, and this API reads it. Re-applying or editing the lineup
replaces the future rows, and the guide shows the change at once.

For FAST rows the description, image, genre, rating and captions flag come
from the VOD asset the slot plays (anything set on the programme itself
wins), and `onDemand.assetId` is set when that asset is published, so an app
can offer "watch from the start".

## Credential

The app's publishable key, as `?appKey=pk_...` or the `X-Volt-App-Key`
header, held to the app's restrictions (allowed origins for web apps, IP
allow-list for server apps) like every viewer route. A secret account key
(`sk_...`) is accepted too, for server-side rendering. The key names the
account; channels of other accounts and channels with the guide turned off
(`epg_enabled = false`) do not exist as far as this API is concerned.

## Routes

`{ref}` is a channel's Volt id or its XMLTV id. Every route accepts `at`
(any ISO instant, default now) where time matters.

| Route | Answers | Main parameters |
|---|---|---|
| `GET /api/public/epg/channels` | the guide's channel list | |
| `GET /api/public/epg/now` | previous / now / next for every guide channel (an "On now" row) | `channels`, `previous` (0), `next` (1), `at` |
| `GET /api/public/epg/channels/{ref}/now` | previous / now / next on one channel | `previous` (1), `next` (3), `at` |
| `GET /api/public/epg/channels/{ref}/schedule` | a channel's programmes in a local day or a window | `date` + `tz`, or `from` / `to`, up to 14 days |
| `GET /api/public/epg/grid` | several channels over a window (the EPG grid) | `from` / `to` or `hours`, `channels`, up to 48 h |
| `GET /api/public/epg/programmes/{id}` | one programme with its neighbours on the channel | |

`previous` and `next` go up to 20. Counts beyond what is scheduled simply
return fewer items.

## Programme shape

```json
{
  "id": "…", "channelId": "…",
  "title": "Pilot", "subTitle": null, "description": "The first one",
  "start": "2026-10-27T06:00:00.000Z", "end": "2026-10-27T06:30:00.000Z", "durationSec": 1800,
  "categories": ["Drama"], "series": "Show", "season": 2, "episode": 3,
  "rating": "PG", "language": null, "image": "https://cdn…/posters/pilot.jpg",
  "flags": { "live": false, "premiere": false, "new": false, "repeat": true, "lastChance": false, "captions": false },
  "origin": "fast",
  "onDemand": { "assetId": "…" },
  "links": { "self": "/api/public/epg/programmes/…", "channel": "/api/public/epg/channels/…" },
  "state": "on-now",
  "progress": { "elapsedSec": 600, "remainingSec": 1200, "percent": 33.3 }
}
```

`state` is `aired`, `on-now` or `upcoming` against `at`; `progress` is only
on the programme that is on. The shape is a whitelist: lineup and slot ids,
pad seconds, ad breaks, geo lists and clip bookkeeping never leave the
server, and a column added to `programmes` later stays private until it is
added to `toPublicProgramme` on purpose.

Times are always UTC ISO strings. The channel object carries its IANA
`timezone` so an app can label days the way the channel does.

## Standard front-end workflow

1. **Start up.** `GET /channels` once, cache it for the session. Use
   `channel.id` (or `xmltvId` if the app already keys channels that way).
2. **Home / "On now" row.** `GET /now?next=1`. Draw `now` with its progress
   bar; show `next[0]` as "Up next". Where `now` is null the channel has a gap:
   draw `base` (the channel's own title, description and image) instead of an
   empty tile (`nowIsBase: true`).
3. **Channel page / player overlay.** `GET /channels/{ref}/now?previous=1&next=3`.
4. **Keep it current without polling hard.** Every now answer has
   `nextChangeAt`: the moment `now` ends or the next programme starts.
   Schedule one refresh for that moment (plus a second of slack), not a
   timer every few seconds. Advance the progress bar locally from `start` and
   `end` in between.
5. **Day view.** `GET /channels/{ref}/schedule?date=2026-10-27` (the
   channel's own zone unless `tz` is given). `links.previous` /
   `links.next` page by the same length.
6. **EPG grid.** `GET /grid?from=…&to=…&channels=…` per visible page of
   channels and hours (3 to 6 hours is typical). Prefetch the next page from
   `links.next` as the viewer scrolls.
7. **Programme detail.** `GET /programmes/{id}`: the programme, the channel
   and the programme before and after it (for "previous / next" buttons).
   When `onDemand` is set, play it through `POST /api/public/availability`
   with that asset id.
8. **Look back or ahead.** Any of the above with `at=` answers for that
   moment ("what was on at 8 pm yesterday").

## Caching and load

The guide is read far more than it is written, so reads come from a cache
that writes keep fresh, not from a clock:

- Each channel's programmes from a day back to about three days ahead are
  held as one shaped **slab** (`scale/cache.ts`: in-process L1, Valkey L2).
- The `programmes`, `channels` and `vod_assets` change triggers (migration
  0046) announce every insert, update and delete on `volt_cache`; every API
  process drops that channel's slab within milliseconds. A console edit, an
  XMLTV import run or a FAST re-apply is visible on the next read. The TTL
  (10 minutes) is only the backstop for a missed notification.
- Now / next roll over by arithmetic on the slab: time passing never costs a
  database query.
- Windows outside the slab (a far past day, a 14 day schedule) are read from
  the table once and cached under the same tags.

HTTP:

- `ETag` on every answer; `If-None-Match` returns 304. The tag ignores the
  echoed `at` and `progress`, so polls between programme changes are 304s.
- `Cache-Control: public, max-age=N` where N never runs past the next
  programme change (30 s ceiling for now answers, 60 s for windows), so a CDN
  in front can hold responses without ever serving a stale "now".
- `Vary: Origin, X-Volt-App-Key`.

## Not in this API (yet)

- Event schedules (an event's day of proceedings) are not listed; the admin
  `GET /api/epg` covers them. Adding `events` to the channel list is a small
  change if apps need it.
- Geo and rights: the guide lists what is scheduled. Whether a viewer may
  watch it is still answered by `POST /api/public/availability`.
- XMLTV for set-top boxes and aggregators stays at `/xmltv/<token>.xml`
  (partner feeds, `modules/xmltv.ts`).
