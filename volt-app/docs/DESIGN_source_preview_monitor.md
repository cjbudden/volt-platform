# Source monitor + received-details (design)

Goal: as a hosted web app, preview ANY source type and show live what is being received.

## Preview playback of any source type
Browsers play only HLS, DASH, MP4/WebM, or WebRTC; never SRT/RTMP/TS directly. So the
platform always repackages the incoming source into a browser-playable stream. The encoder
already produces HLS into the origin, so preview is a byproduct of ingest.

### Source monitor output (separate + toggleable)
Add a dedicated SOURCE MONITOR output, separate from the delivery ladder:
- A single low-resolution rendition (e.g. 360p LL-HLS) produced from the ingest, written to
  a separate path (e.g. /origin/<id>/monitor/), used only for the operator preview.
- Toggleable: only runs when a monitor is requested (viewing the channel), so you do not pay
  to run the full 1080/720/480 ladder just to confirm a source. The delivery ladder is
  produced only when the channel is taken to air.
- Default transport: low-latency HLS (universal, CDN-cacheable, ~2s). Optional later:
  a WebRTC/WHEP low-latency monitor (<500ms) via a media server, as an add-on toggle only.
- Push vs pull: SRT/RTMP are push (cloud listener endpoints + stream keys; monitor starts
  when the feed arrives). HLS/DASH are pulled. The monitor output is the same HLS regardless.
- Access: monitor URLs are signed/short-lived (a raw ingest is not public).

## Source status
Basic state: offline | receiving | stopped (from the ingest/stream_status report).
Received broadcast details, two feeds:
- On connect (pull sources): ffprobe the source once -> container, video (dimensions, codec,
  fps, pixel format, profile, bitrate), audio track(s) (codec, channels, sample rate,
  bitrate, language), and ADDITIONAL packages carried in the source (in-band timed metadata
  e.g. timed-ID3, subtitle/caption tracks, extra audio tracks, data/SCTE). Endpoint:
  POST /api/sources/probe { url, protocol } (BUILT + verified).
- While receiving: the ingest ffmpeg emits live progress (bitrate in, fps, dropped/duplicated
  frames, bytes). The relay posts these to the existing /api/streams/:id/report, which fans
  out to the UI over SSE. The SOURCE panel then shows live: dimensions, codec, incoming
  bitrate, audio details, dropped frames, and the additional packages detected.

Push sources cannot be probed on demand (nothing is pushing yet); their details come from the
live receiving feed once a push arrives.

## Build order
1. POST /api/sources/probe (DONE) + show it in the create form + detail SOURCE panel.
2. Live receive-stats: ingest ffmpeg -progress -> report -> SSE -> SOURCE panel.
3. Source monitor output (cheap 360p LL-HLS, toggleable) separate from the delivery ladder.
4. Optional: WebRTC/WHEP low-latency monitor toggle.
