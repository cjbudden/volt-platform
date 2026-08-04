# Design — Frame-accurate media access

## Goal
Give Volt frame-accurate media access: instant, proxy-less access to source media
that stays in S3. Scrub any recording or asset, pull any single frame on demand, and
cut a frame-accurate clip, with no pre-generated proxies and no file movement. This
feeds the workflows we already built (faster clips for social publishing, richer
share-page previews) and opens a path to remote editing. Some commercial products
offer a similar capability; this design reaches the same outcome from open standards.

## The key realisation (frame vs chunk)
Frame-addressable products do not generally store one file per frame. The typical
approach is a stateless engine that reads frames via HTTP byte-range requests plus
frame-level just-in-time transcoding straight from source in S3. The media stays as
encoded files/chunks; a frame is produced on request by byte-range reading the right
span and decoding it. What is exposed at the frame level is the ADDRESSING plus a
just-in-time transcode, not the storage.

So we do NOT change our storage model. Our chunked CMAF/HLS origin is an advantage:
every segment starts on an IDR keyframe and is independently decodable, so to serve
frame N we find its segment (cheap, from the segment index), read only that small
segment, decode forward to N, and emit. No whole-file read, no cross-file GOP chase.

## Build entirely from open standards / prior art (patent design-around)
We reach the outcome using long-standing, published techniques, and deliberately do
not reproduce any specific commercial engine. This is standard design-around
practice. Before the deeper editing phase, run a freedom-to-operate review with
patent counsel. (Not legal advice.)

Components, all standards or prior art:
- **WebVTT thumbnail sprites** (and Roku's open BIF) for scrub preview — pull no
  real frames while dragging; a single sprite sheet + a VTT mapping time to a tile.
- **HLS I-frame trick-play playlist** (`EXT-X-I-FRAMES-ONLY`, in the HLS spec) for
  fast visual frame-stepping — the player pulls only keyframes by byte range from
  the same segments. DASH has an equivalent.
- **Decode-from-nearest-keyframe** (generic ffmpeg seek) to pull any exact frame —
  textbook, decades old.
- **Just-in-time clipping/packaging** with a CDN cache — a well-established category
  (Unified Streaming, AWS MediaPackage/MediaConvert JIT, Wowza) — so the user never
  waits for a full-file proxy; we render only the span they touch and cache it.

## Architecture
```
 client (browser scrubber / player / future NLE panel)
   │  GET frame?n= | clip?in&out | iframes.m3u8 | sprite.vtt   (playback-token auth)
   ▼
 frame-access service ── frame index (frame/timecode → segment + local offset)
   │  byte-range read ONE segment (or the covered few)         + CDN cache of results
   ▼
 S3 origin (the CMAF/HLS segments we already write)
```
- **Frame index**: per asset, map global frame / timecode → segment + local frame
  offset. Built once at ingest from the segment list + a PTS scan. Segment-granular
  today (DVR segment index); extended to frame granularity here.
- **JIT frame**: read the target segment, decode to the local frame, return an image
  at the requested width; cache by URL.
- **JIT clip**: frame-accurate in/out; segment-aligned spans copy, edges re-encode
  (smart-cut); this is vod-extractor extended to arbitrary in/out.
- **Auth**: the same short-lived playback tokens the availability gate mints.

## Phases
1. **Frame-accurate preview + clip (browser)** — frame index + frame/range URL API +
   sprite scrub + I-frame trick-play + JIT clip + a scrubber UI. Mostly composition
   of what we have (segment index, vod-extractor, thumbnailer, share pages).
   **Prototype built — see below.**
2. **Multi-resolution JIT renditions + edge caching** — the same addressable source
   serves preview, review and scrub cheaply (CMCD-tuned cache).
3. **NLE integration (Premiere/Resolve)** — cloud remote editing on the originals.
   Hardest, highest value. **Build-or-licence decision**: standard proxy-on-demand
   ourselves, or licence a third-party engine for this one piece, so we never
   reimplement a protected part.

## Prototype (built + proven)
`volt-frame-proto/` — a runnable phase-1 prototype over a real 500-frame / 25fps /
10-segment asset with burned frame numbers. Proves, with 15/15 assertions
(`test.mjs`):
- the frame index locates frames across segment boundaries (frame 137 → segment 2,
  local 37, 5.480s);
- a JIT single-frame pull returns the **exact** frame — the segment-derived frame 137
  matches a ground-truth decode of global frame 137 (MAD 0.02), and a neighbour is
  distinct;
- a JIT clip [110,185] renders a decodable H.264 MP4 with **exactly** 76 frames,
  spanning two segments;
- the WebVTT sprite has one tile per second; the HLS trick-play playlist is
  `EXT-X-I-FRAMES-ONLY` with one I-frame byte-range per segment.
- A browser scrubber shows the sprite hover-thumbnail and the JIT frame both at
  FRAME 262 / 10.480s, with a working "cut clip" action (screenshot delivered).

## What to productionise from the prototype
Point the origin at S3 (HTTP byte-range) instead of the local dir; put the frame
index on the asset at ingest; front the frame/clip endpoints with the CDN + playback
tokens; add multi-width renditions. Then wire a "scrub & clip" surface into the
console and reuse it inside the share page and the social-publishing clip step.
