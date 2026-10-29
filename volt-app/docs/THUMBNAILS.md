# Encoder thumbnails: stills, sprite sheets and hover previews

Every TV channel and event with video gets pictures of itself, built from the
encoder's own segments while it runs:

- **Stills in the image library**, one a minute at 640 × 360, named after the
  programme on air (from the EPG) or the channel, and searchable like any image.
- **Sprite sheets and WebVTT**, one sheet per 10 minutes and one VTT per hour,
  for scrub-bar previews in any player.
- **Hover previews** in the console: the recording timeline, the source
  timeline and the VOD player show the frame under the pointer.
- **Clip VTTs**: every clip gets its own VTT, re-timed to the clip and
  pointing at the same sheets. Nothing is re-rendered.

Code: `src/services/thumbnails/` (naming, builder, clips, spriteStore),
`src/modules/thumbnails.ts` (API), migrations `0049` and `0112`. Image metadata and library
search, which these stills also use, are in [IMAGES.md](IMAGES.md) section 17.

- [1. Where the files go](#1-where-the-files-go)
- [2. How 24x7 channels are split](#2-how-24x7-channels-are-split)
- [3. When they are made](#3-when-they-are-made)
- [4. Hover previews](#4-hover-previews)
- [5. Clips and recordings](#5-clips-and-recordings)
- [6. API](#6-api)
- [7. Configuration](#7-configuration)
- [8. Storage, retention and cost](#8-storage-retention-and-cost)
- [9. Running and testing](#9-running-and-testing)

---

## 1. Where the files go

Two places in the image store (a local folder in development, the images S3
bucket in the cloud), both served by the signed image service:

* **Stills** go to the account's **Image Library** (`library/{account}/`), so
  people can browse, search and pick them as posters.
* **Sprite sheets and VTTs** go to the **sprite store**
  (`derived/{account}/sprites/`). They are system files: the player's hover
  previews, the recording and clip timelines and the asset actions read them,
  nobody picks one as an image, so they are kept out of the library.

```
library/{account}/thumbnails/                  IMAGE LIBRARY: stills
  Sport-One/                                   the channel (or event) name
    2026-10-16/                                the channel's local date
      18/                                      the channel's local hour
        Sport-One-20261016-180000.jpg          a still, no programme on air
        Morning-Match-20261016-180100.jpg      a still during "Morning Match" (EPG)
        ...                                    one a minute

derived/{account}/sprites/                     SPRITE STORE: sheets and VTTs
  streams/Sport-One/2026-10-16/18/             the same channel / date / hour
    Sport-One-20261016-18-m00.jpg              sprite sheet 18:00-18:09:59
    Sport-One-20261016-18-m10.jpg              sprite sheet 18:10-18:19:59
    ...                                        six sheets an hour
    Sport-One-20261016-18.vtt                  the hour's WebVTT
  assets/{asset}/
    sheet-000.jpg ...                          an uploaded file's own sheets (section 5)
    thumbs.vtt                                 a clip's VTT (section 5)
```

### Where sprites live: the sprite store and `sprite_sheets`

Every object in the sprite store has a `sprite_sheets` row (migration `0112`):
its owner (`stream`, with the storyboard hour it belongs to, or `asset`), its
kind (`sheet` or `vtt`), first tile, interval, layout, tiles and bytes. That
table is the inventory: sprites are counted (`GET /api/thumbnails/sprites`),
listed per asset or stream, removed with their hour or asset, and go to the
restore bin with them. Rows cascade when their storyboard hour or asset row is
deleted. The layout the readers use is unchanged: `storyboards.sheets` for live
hours, `vod_assets.sprite` for uploaded files.

**Sheets made before the sprite store** (under `library/.../storyboard/`,
`thumbnails/files/{asset}/` and `thumbnails/{channel}/clips/`, each with an
Image Library row) are moved automatically
(`spriteStore.ts relocateLegacySprites`): a batch at the start of each
thumbnail pass (or, with thumbnails off, a minute after start-up) until none
are left. Files move to the new keys, `storyboards.sheets`, `vtt_key`,
`vod_assets.sprite`, `storyboard_key` and `thumbs_vtt_key` are rewritten, clip
VTTs are written again (their cues held the old sheet URLs), the sheets'
library rows are dropped, and library sheet rows nothing points at go with
their files. Running it again changes nothing. Hours being built at that moment
are left for the next pass; a sheet still on an old key also moves itself the
next time it gains tiles.

**Names.** `{programme or channel}-{YYYYMMDD}-{HHMMSS}.jpg`. When the EPG has
a programme on air at that instant (as-run times preferred), the still is
named after it. Otherwise it is named after the channel. Names are made file
safe (`"Évening News: Live!"` becomes `Evening-News-Live`). Two channels with
the same name in one account get the first 8 characters of their id added to
the folder name so they never share a folder.

**Time zone.** Dates and hours are the channel's own time zone (`channels.tz`),
so the folder an operator opens matches the clock in the gallery. Events use
`THUMBS_DEFAULT_TZ` (UTC unless set). When clocks go back and an hour repeats,
the second one is folder `01b`. Zones with half-hour offsets work: an hour is
always the local hour.

**What the rows say.** Each still is a `media_files` row with
`source = 'encoder'`, `kind = 'keyframe'`, `channel_id`, `captured_at` (the
instant the frame shows) and, in `metadata`, the channel name and programme. So
"Morning Match" or "Sport One" finds them in the library search, and the library
can filter by channel and time. Sheets have no library row; they are in
`sprite_sheets` (above).

## 2. How 24x7 channels are split

A 24x7 channel never ends, so there is no "whole recording" to make one VTT
for. Sheets and VTTs are cut by the clock instead:

| Unit | Size | Per day |
|---|---|---|
| Tile | 160 × 90, one every 10 s | 8,640 |
| Sprite sheet | 10 × 6 tiles = 10 minutes, 1600 × 540 JPEG, about 100 to 200 KB | 144 |
| WebVTT | one per hour, 360 cues | 24 |
| Library still | one a minute, 640 × 360 JPEG | 1,440 |

Why these sizes:
- **A player loads one sheet per 10 minutes** of timeline it shows. A hover
  over a 24-hour view touches at most a few dozen small images, never one
  giant one.
- **Sheet boundaries line up with the clock** (m00, m10 ... m50), so finding
  the picture for any instant is arithmetic, and a clip that spans two hours
  simply uses cues from both hours.
- **An hour is the unit of work and of storage.** A finished hour is never
  touched again, and retention deletes whole hours.

All four sizes are settings (section 7). Changing them applies to hours built
afterwards; each hour records the layout it was built with, so old and new
hours keep working side by side.

## 3. When they are made

The scheduler (the leader process) runs a thumbnail pass every
`THUMBS_PASS_SEC` (2 minutes):

1. For every TV channel and event with recorded runs on the origin, it looks
   at the last `THUMBS_LOOKBACK_MIN` (2 hours), hour by hour, newest first.
2. For each hour that is not complete, it decodes **only the tiles it does not
   have yet**. Each tile is the opening keyframe of the segment covering that
   instant: our encoder cuts a closed GOP exactly one segment long, so a frame
   is one small read and one picture decode, from the lightest rendition at
   least 360 px tall. Tiles newer than `THUMBS_LAG_SEC` (20 s) wait for the
   next pass, so a segment still being written is never read.
3. New tiles are composited onto the sheet's previous image, the minute's
   still is written to the library, and the hour's VTT is rewritten.
4. When an hour is over and every tile is either filled or a gap (no material,
   older than 10 minutes), the hour is marked complete.

A pass has a time budget (`THUMBS_PASS_BUDGET_SEC`, 90 s) and decodes at most
`THUMBS_CONCURRENCY` frames at once. Whatever it does not reach, the next pass
picks up, because progress is recorded per tile. Hover previews therefore trail
live by about one pass.

Older hours (beyond the look-back, or from before this feature) are built when
someone asks: hovering over them in the console asks for them, or call
`POST /api/thumbnails/build`.

Measured on 2 vCPU: a 10-minute fixture (60 tiles, 10 stills) builds in
about 3.7 s, so a live channel costs a few seconds of CPU per pass.

## 4. Hover previews

| Where | What you see |
|---|---|
| Recordings > source (the long timeline) | The frame under the pointer, with its time, above the timeline |
| Recordings > a recording (clipping timeline) | The frame under the pointer over the waveform, while you hover the waveform or the scrub bar |
| Media Library > a clip > Preview | A scrub strip under the player: hover for the frame and its time, click to seek |

The console asks `GET /api/thumbnails/storyboard` for the hours in view
(rounded out to whole hours, refreshed every minute while the view includes the
live hour) and draws each tile with CSS background positioning: one image
request per sheet, however many tiles you hover. Sheet URLs are signed image
service URLs carrying the sheet's tile count as a version (`v=54`), so the CDN
can cache every version for a year and a filling sheet is never shown stale.
When the exact tile is missing (a gap), the nearest earlier tile on the same
sheet is shown.

## 5. Clips and recordings

When a clip is built, `clip.extract` writes its VTT: the stream's cues for the
clip's source ranges (from `clip_segments`, so clips stitched from several
pieces are mapped piece by piece), re-timed to start at 0, trimmed at both
ends, pointing at the existing sheets. The file goes to the asset's sprite
folder, `derived/{account}/sprites/assets/{asset}/thumbs.vtt`, and the asset's
`thumbs_vtt_key` points at it. `poster_key` is set to the library still
nearest the clip's start, and `storyboard_key` to its first sheet.

The API also builds VTTs on request, always from the current storyboards:

- `GET /api/thumbnails/vod/{id}.vtt` for a clip (used by the Media Library
  player);
- `GET /api/thumbnails/recordings/{id}.vtt` for a recording;
- `GET /api/thumbnails/vtt?stream&from&to` for any span.

A clip cut from the last few minutes of a live channel may have a short VTT
when it is built (the hour is still filling). The on-request VTT is complete as
soon as the pass has caught up.

### Uploaded files

An uploaded or watchfolder file has no stream, so its sprite sheets are made from the file at the end of its encode
(`services/thumbnails/fileSprites.ts`): the same tile layout, about 200 previews whatever its length, stored in the
sprite store under `derived/{account}/sprites/assets/<asset>/` (a `sprite_sheets` row each, no library row) and
described in `vod_assets.sprite`. A rebuild that makes fewer sheets removes the ones left over. Removing the asset
puts its sheets in the restore bin with it. `GET /api/thumbnails/vod/:id.vtt` serves them first
when they exist. Its poster is picked from stills of the file (`docs/ASSET_IMAGES.md`).

## 6. API

All routes need an admin session or an account secret key, and only answer for
the caller's own channels and events.

| Route | Answers |
|---|---|
| `GET /api/thumbnails/storyboard?stream={id}[&from={ms}&to={ms}][&prime=1]` (default: the last hour) | `{tileW, tileH, intervalMs, units: [{start, end, status, folder}], sheets: [{url, startMs, endMs, intervalMs, cols, tileW, tileH, filled}]}`. At most 48 hours. `prime=1` builds missing hours in the background. |
| `GET /api/thumbnails/sprites[?asset={id} \| ?stream={id}&from&to]` | The sprite inventory: `usage` (files and bytes by owner and kind), `totals`, and for an asset or a stream's span the `items` (key, owner, kind, start, tiles, size, bytes, and a signed `url` for sheets). At most 7 days and 2,000 rows for a stream. |
| `GET /api/thumbnails/vtt?stream&from&to` | WebVTT for the span, timed from `from`. At most 7 days. |
| `GET /api/thumbnails/recordings/{id}.vtt` | A recording's WebVTT. |
| `GET /api/thumbnails/vod/{id}.vtt` | A clip's WebVTT. |
| `GET /api/thumbnails/status?stream&from&to` | Hours with their status, tiles, gaps and folder. Default: the last 24 hours. |
| `POST /api/thumbnails/build` `{stream, from, to}` | 202. Builds (or finishes) the hours in the span in the background, one build per stream at a time. At most 7 days. |

Finding the tile for instant `t` in a storyboard answer: take the sheet with
`startMs <= t < endMs`, `i = floor((t - startMs) / intervalMs)`; if `i` is in
`filled`, the tile is at `x = (i % cols) * tileW`, `y = floor(i / cols) * tileH`.

VTT cue format (the WebVTT thumbnails convention most web players read,
natively or through a plugin):

```
WEBVTT

00:30:00.000 --> 00:30:10.000
https://img.example.com/img/{sig}/1600x540,fill,fmt=jpeg,q=85,v=60/derived/{acct}/sprites/streams/Sport-One/2026-10-16/18/Sport-One-20261016-18-m30.jpg#xywh=0,0,160,90
```

## 7. Configuration

| Variable | Default | What it does |
|---|---|---|
| `THUMBS_ENABLED` | `1` | `0` turns the pass off (the API still serves what exists). |
| `THUMBS_PASS_SEC` | `120` | How often the current hour is filled in. |
| `THUMBS_LOOKBACK_MIN` | `120` | How far back each pass looks for unfinished hours. |
| `THUMBS_LAG_SEC` | `20` | Never read segments newer than this. |
| `THUMBS_PASS_BUDGET_SEC` | `90` | Wall-clock budget per pass. |
| `THUMBS_CONCURRENCY` | `3` | Frames decoded at once. |
| `THUMBS_TILE_INTERVAL_SEC` | `10` | One tile every this many seconds. |
| `THUMBS_TILE_WIDTH`, `THUMBS_TILE_HEIGHT` | `160`, `90` | Tile size. |
| `THUMBS_SHEET_COLS`, `THUMBS_SHEET_ROWS` | `10`, `6` | Tiles per sheet (10 × 6 × 10 s = 10 minutes). |
| `THUMBS_SHEET_QUALITY` | `70` | Sheet JPEG quality. |
| `THUMBS_FRAME_INTERVAL_SEC` | `60` | One library still every this many seconds (`0` = none). Best as a multiple of the tile interval. |
| `THUMBS_FRAME_HEIGHT` | `360` | Still height (width follows the picture). |
| `THUMBS_FRAME_QUALITY` | `82` | Still JPEG quality. |
| `THUMBS_RETENTION_DAYS` | `30` | Delete stills, sheets and VTTs for hours older than this (`0` = keep). |
| `THUMBS_DEFAULT_TZ` | `UTC` | Folder time zone for events. |

## 8. Storage, retention and cost

Per channel, at the defaults, with real broadcast pictures:

| | Per day | 30 days |
|---|---|---|
| Stills (1,440 × 25 to 40 KB) | 35 to 60 MB | 1 to 1.8 GB |
| Sheets (144 × 100 to 200 KB) | 15 to 30 MB | 0.4 to 0.9 GB |
| Library rows (stills) | about 1,440 | about 43,200 |
| Sprite rows (sheets + VTT) | about 170 | about 5,000 |

Retention runs with the pass, at most once an hour, and deletes whole hours:
the stills and their library rows, the sheets and VTT and their sprite rows,
and the storyboard row. Clip VTTs are kept (they
are tiny), but once their hours are deleted their cues point at sheets that no
longer exist, so a clip that must keep its previews should be kept inside the
retention period or have its own thumbnails made.

Sheets reach viewers through the image service and CDN, so a sheet is rendered
once per version and then served from S3 or the edge (IMAGES.md section 11).

**In the cloud.** The pass runs on the scheduler leader and reads segments from
the origin the control plane can see, the same source the recording timeline,
waveform and keyframe strip use. Outputs go to the images S3 bucket through the
image store. Where encoders write only to S3 and nothing local, run the pass
next to the origin, or point `ORIGIN_DIR` at a mounted copy.

## 9. Running and testing

Nothing to set up: `run-on-mac.sh` runs the pass in the API process. Start a
channel, wait two minutes, then open **Image Library > thumbnails** or hover a
recording's timeline.

| Command (from `volt-app/`) | Covers |
|---|---|
| `npx tsx test/thumbnails.check.ts` | Naming (zones, repeated hours, half-hour zones, slugs), cue and VTT maths (trimming, composed clips), image metadata extraction, the search SQL, and a real build: it encodes 3 minutes of moving test picture into an origin run, builds the hour, and checks stills, programme names, sheets (1600 × 540), the hour VTT, library rows, folders, search, idempotency, a clip VTT and retention |
| `bash test/media-library.check.sh` | Through the real API: thumbnails routes, tenancy and limits (plus the library metadata and search, IMAGES.md section 17) |
| `node scripts/check.js thumbnails media-library` | Both, each on its own database |
