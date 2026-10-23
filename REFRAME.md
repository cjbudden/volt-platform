# Social formats: reframing by following the picture

Volt makes 9:16, 1:1 and 4:5 versions of a 16:9 asset by following what is in the picture, lets an operator correct the framing, and sends each social platform the shape it wants. Built 23 Oct 2026.

## The formats

| Format | Size | For |
|---|---|---|
| 9:16 vertical | 1080×1920 | TikTok, YouTube Shorts, Instagram Reels and Stories, Facebook Reels |
| 1:1 square | 1080×1080 | Facebook, X and LinkedIn feeds |
| 4:5 portrait | 1080×1350 | Instagram and Facebook feeds |
| 16:9 source | as encoded | YouTube, portal, apps (never reframed) |

## How it works

1. **Analysis** (`volt-encoder/bin/reframe_analyse.py`, job `reframe.analyse`). The picture is decoded once at 640 wide, 5 frames a second. Shots: colour histogram plus picture difference. Faces: YuNet (OpenCV model zoo, MIT, vendored in `volt-encoder/models/`). People: OpenCV's HOG detector where the OpenCV build has it (OpenCV 5 does not), only on frames with no face. A tracker joins detections into tracks inside a shot (never across a cut), and tracks of the same person in different shots are joined into one subject by a colour signature of the face and collar (most alike pairs first, never two tracks on screen at once). About 15 times faster than real time on one CPU core.
2. **Track store**: a sidecar beside the asset, `clips/vod/<id>/reframe/tracks.json` (`kind: volt.tracks`, normalised coordinates, media time). The `vod_tracks` row holds the summary. Every later step reads this; nothing decodes the video for analysis again. It is also the position source for later templates (a blur or frost that follows a face, graphics that avoid one).
3. **Framing path** per format (`volt-app/src/services/reframe/framing.ts`, pure). Per shot: who to follow (the operator's choice, else the account's priority: faces, people, centre; a second face of similar size on screen most of the shot makes a group), whether they fit (else the fallback: the whole picture on a blurred fill, or follow the main face), and how the crop moves (steady holds unless the subject would leave the crop, responsive follows closely, locked is one framing per shot). Keys are `{t, cx, cy, w, h, ease, mode, shot}`, centre and size as fractions of the picture; ease `glide` (smoothstep), `linear` or `hold`; the last key of every shot holds, so the crop never slides across a cut. 9:16 keeps the subject left of the platform buttons when the safe area is on. Each shot has a confidence; below 0.75 it is flagged for review.
4. **Render** (`render.ts`, job `reframe.render`): one ffmpeg pass per format. The crop position is a per-frame expression of time built from the keys, with the same easing the console preview uses; fill shots come from a second branch of the same graph switched in by time. libx264 veryfast CRF 21, AAC 48 kHz, faststart. Output `clips/vod/<id>/reframe/<format>.mp4`.
5. **Publish**: with *Send each platform its own format* on (Admin > Formats and reframing, off by default), a social publication uploads the platform's format, rendering it then if it is missing or out of date, and stops with a reason when approval is required and the format is not approved. Off: every platform gets the 16:9 file as before.

A person's edit is never lost: re-analysis re-plans only formats nobody edited. Any change to a framing makes a rendered file *out of date* and, when approval is required, takes the approval away.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/vod/:id/reframe` | analysis state and summary, every format's path, review and render |
| GET | `/api/vod/:id/reframe/tracks` | the track store |
| POST | `/api/vod/:id/reframe/analyse` | queue analysis (409 for a sound-only asset) |
| PUT | `/api/vod/:id/reframe/formats/:format` | `{keys}` and/or `{overrides: {"<shot>": {follow: "<subject>|group|centre|fill"} or null}}` |
| POST | `/api/vod/:id/reframe/formats/:format/reset` | back to Volt's framing |
| POST | `/api/vod/:id/reframe/formats/:format/approve` | |
| POST | `/api/vod/:id/reframe/render` | `{formats?}` |
| GET, PATCH | `/api/account-settings/reframe` | settings (PATCH: admin) |

Access: the media library feature for the asset routes, settings for the account routes; tenancy as every VOD route.

## Console

- Media Library > asset > **Formats**: the picture with the crop and the followed faces drawn over it, a timeline of shots, subjects and crop keyframes, live previews of all three formats (sampled in the browser exactly as the render will), and the shot inspector: who the shot follows, how a keyframe moves, add or delete keyframes, approve, render, download. Drag the crop (or press the arrow keys on the picture) to set a keyframe at the playhead.
- Admin > **Formats & reframing**: formats made, what to keep in frame, camera movement, fallback, safe area, the format each platform receives, automatic analysis, approval and auto-approval.

## Cost (estimates, Sydney prices, October 2026)

Analysis about US$0.02 per source hour on a shared CPU; render about US$0.20 per output hour with our encoder (MediaConvert about US$0.90). A one-minute clip in three formats costs about a cent.

## Tests

- `python3 volt-encoder/bin/test_reframe_analyse.py`: 28 (shots, tracker, subjects incl. order independence, the store, a missing model, an unreadable source, a real face followed across the frame).
- `DATABASE_URL=... npx tsx test/reframe.check.ts` (volt-app): 76 (settings, framing rules, real renders read back pixel by pixel, the API through the job worker and the real analysis, tenancy, publish hand-off).

## Not yet

- Zoom: the crop is full height for narrower targets; a small subject in a wide shot is not enlarged.
- The person speaking is not detected (no active-speaker model); the face on screen longest is the main one.
- Ball and players for sport (needs a permissively licensed detector such as YOLOX, plus the sports data feed).
- Click-to-track any object (SAM 2, GPU).
- Redaction (a frosted or blurred box that follows a face) on the same tracks.
- Cloud: the analysis runs in the control plane's job worker, so its image needs Python with numpy and OpenCV like the encoder image now has (the same gap `vod.encode` has today).
- Changing the account settings does not re-plan assets already analysed; re-analyse them.
