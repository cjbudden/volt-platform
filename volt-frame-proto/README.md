# volt-frame-proto — frame-addressable media (phase-1 prototype)

A runnable prototype of frame-accurate media access, built from open standards over
Volt's existing chunked (HLS/CMAF) origin. No per-frame storage, no proxies: every
frame is produced just-in-time by reading the one segment that contains it. See
`../volt-app/docs/DESIGN_frame_access.md` for the design + the patent design-around
rationale.

## What it demonstrates
- **Frame index** over a segmented origin: map any global frame → segment + local
  offset (`index.mjs`).
- **JIT single-frame pull** — read one segment, decode to the frame, return a JPEG
  (`/api/frame?n=`). Frame-accurate (verified against a ground-truth decode).
- **JIT frame-accurate clip** across segment boundaries (`/api/clip?in=&out=`).
- **WebVTT thumbnail sprite** for scrub preview (`/sprite.vtt` + `/sprite.jpg`).
- **HLS I-frame trick-play playlist** (`EXT-X-I-FRAMES-ONLY`) for fast scrubbing.
- **Browser scrubber** (`/scrub`) tying it together over an HLS preview.

## Run
```bash
cd volt-frame-proto
bash media/generate.sh    # make the test asset (500 frames, 25fps, 10 segments)
node test.mjs             # 15/15 assertions (frame-accuracy, clip, sprite, trick-play)
node server.mjs           # then open http://localhost:8790/scrub
```

## Files
- `index.mjs` — frame index (parse playlist, probe frame counts, locate frame, plan clip)
- `render.mjs` — JIT renderers (frame JPEG, clip MP4, sprite+VTT, I-frame playlist)
- `server.mjs` — tiny dependency-free HTTP server exposing the endpoints + scrubber
- `scrub.html` — the browser scrubber
- `test.mjs` — end-to-end assertions against real media
- `media/` — generated test asset (source.mp4 + HLS segments)

## Productionising
Point the origin at S3 (HTTP byte-range) instead of `media/`, attach the frame index
to the asset at ingest, front the endpoints with the CDN + playback tokens, add
multi-width renditions, then reuse the scrub-and-clip surface in the console, the
share page, and the social-publishing clip step.
