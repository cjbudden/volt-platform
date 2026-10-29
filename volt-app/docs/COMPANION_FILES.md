# Companion files: captions and metadata sidecars

Files that travel with a video or audio asset without being its media. Each asset has a **Companion files** tab in
the media library.

| Kind | Formats | What Volt does with it |
|---|---|---|
| Captions | SRT, WebVTT, TTML / DFXP / EBU-TT | Reads and checks the cues, keeps a clean WebVTT, offers it to viewers as a subtitle track in HLS and DASH |
| Metadata | JSON, XML (NFO, Dublin Core, partner XML), CSV / TSV | Reads the values and matches them to the asset's fields; a person reviews and applies them |
| Other | anything else | Kept with the asset for download |

Code: `services/companions/formats.ts` (reading, checking, matching: pure), `delivery.ts` (manifests and the segment
clock: pure), `store.ts` (storing, assigning, applying), `serve.ts` (the playback routes), `modules/assetFiles.ts`
(API), console `pages/vod/AssetFiles.tsx`. Migration `0091_asset_companion_files.sql`.
Tests: `test/companion-files.check.ts` (pure, 64), `test/asset-images-and-files.e2e.ts` (Postgres, real CMAF segments).

## 1. Adding files

Drop files on the tab, or `POST /api/vod/:id/files?name=<file name>` with the raw bytes as the body (up to 25 MB).
The same bytes twice on one asset are one file (the answer says `duplicate`).

The **format** is read from the contents first and the name second. Text is read as UTF-8, else as Windows-1252
(older subtitling tools write SRT that way).

The **language and flags** come from the file name, the way people and playout systems name them, unless given:

| Name | Language | Flags |
|---|---|---|
| `episode.en.srt` | en | |
| `Movie_FR.vtt` | fr | |
| `film.pt-BR.forced.srt` | pt-BR | forced |
| `show.eng.sdh.srt` | en (three-letter codes become two-letter ones) | SDH |
| `de.srt` | de | |
| `de-bruges.srt` | none (a title that starts with a code is not a language) | |

The track name viewers see defaults to the language in English ("French", "English (SDH)") and can be changed.

## 2. Checking captions

| Check | Level |
|---|---|
| No cues could be read | error: kept, not offered |
| A cue ends before it starts | warning (left out); error when every cue does |
| A cue with no text | warning, left out |
| A cue overlaps the one before | warning |
| A line over 42 characters | warning |
| Faster than 20 characters a second | warning |
| A cue after the asset ends | warning |
| The first cue is past an hour and past the end | warning: timed to a timecode (10:00:00:00); set an offset |

**Offset** (seconds, can be negative) is added to every cue; changing it rebuilds the WebVTT from the original file.
SRT styling becomes WebVTT: `<i> <b> <u>` are kept, `<font>` and `{\an8}` codes dropped. TTML: clock times, frames
(`ttp:frameRate`, default 25), offsets (`1.5s`, `90000t` at `ttp:tickRate`), `<div begin>` offsets, `<br/>`, italic and
bold spans.

## 3. Metadata sidecars

A sidecar is flattened to path and value (`programme.title`, `genre` as a list when repeated, `uniqueid@type` for an
attribute; XML namespace prefixes dropped, so `dc:title` is `title`). Each field of the asset's content type takes
the best path: its key, then its label, then common synonyms both ways (`plot`, `synopsis` and `summary` fill
Description; `<episode>` fills Episode number; `aired`, `premiered` and `year` fill a release date; `showtitle` fills
Series). Values are shaped to the field: numbers, booleans, dates, an enum's own option in any case, lists for
multiple fields. Image fields are never filled from a sidecar.

**Review and apply** shows each match next to what the asset has now. Empty fields are ticked; a value already there
changes only if ticked (one a person entered is flagged); values can be edited before applying. Applying writes only
the ticked fields, with provenance (`source: sidecar`, the file, who approved, the old value). Values with no
matching field are listed.

## 4. Subtitle tracks for viewers

Offered caption files are written into the asset's playlists when a player asks for them, like skip markers, so a new
or corrected file reaches viewers at once and nothing is re-packaged.

* **HLS**: the master gains `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="volt-subs"` per track (NAME, LANGUAGE, DEFAULT,
  AUTOSELECT, FORCED, and the accessibility CHARACTERISTICS for SDH) and every variant `SUBTITLES="volt-subs"`. Each
  track is `subs/<id>.m3u8`, one segment over `subs/<id>.vtt`.
* **DASH**: each Period gains an `AdaptationSet contentType="text" mimeType="text/vtt"` per track with a subtitle,
  caption or forced-subtitle Role and `subs/<id>.dash.vtt` as its BaseURL.

**The one clock** (CAPTIONS.md). Cue times are asset time: 0 is the asset's first frame. HLS places WebVTT against
the video by `X-TIMESTAMP-MAP`, so its MPEGTS is read from the media viewers get: the `tfdt` of the first segment of
the first variant, at the timescale in its init segment. An encoded file starts near 0; a clip copied from a live
recording starts wherever the live timeline was, and without the map its captions would be minutes or hours out.
Verified end to end with a segment at 1000 s. DASH WebVTT is served without the map.

**Limits.** Tracks are added to playlists served by the control plane (`/clips/...`, local and single-server
deployments). Playlists the CDN serves straight from S3 need the same edge treatment as skip markers before captions
show there. A clip whose `master_key` is a single media playlist (no master) cannot carry a subtitle track.

## 5. API

| | |
|---|---|
| `GET /api/vod/:id/files` | the asset's files, with each check and how it is used |
| `POST /api/vod/:id/files?name=&kind=&language=&label=&default=&forced=&sdh=&offsetMs=` | add a file (raw bytes) |
| `GET /api/vod/:id/files/:fileId/content[?as=vtt]` | the original, or the clean WebVTT |
| `PATCH /api/vod/:id/files/:fileId` `{ language?, label?, isDefault?, forced?, sdh?, enabled?, offsetMs? }` | change how it is used; one default track per asset |
| `DELETE /api/vod/:id/files/:fileId` | remove it (and its track) |
| `GET /api/vod/:id/files/:fileId/proposal` | a sidecar: each match, the value now, the path it came from, unmatched values |
| `POST /api/vod/:id/files/:fileId/apply` `{ fields[], values? }` | write the approved fields |

Feature `vod`: reading needs view, changes need manage. Every change is in the audit log.

## 6. Next

* Pairing at ingest: a watchfolder or upload batch that holds `episode.mp4` with `episode.en.srt` and
  `episode.nfo` attaches them automatically (the ingest rule decides whether sidecar values apply on arrival).
* Burned-in or embedded caption extraction (CEA-608/708 in the source) into the same tracks.
* The CDN edge for S3-served playlists (section 4).
