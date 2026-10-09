# HTML graphics overlays: scorebugs, sponsor graphics, VoD intros

**Assessment only. No production code was changed to write this.** The numbers
below are measured, not estimated, and the method for each is given so they can
be re-run.

The question: is an HTML template system for stream graphics worth building into
this platform, how do you composite animated HTML into live and on-demand output
without the cost getting silly, and should we just plug into an existing graphics
platform instead?

**Short answer: yes, worth building, but split into three products with three
different answers, and the cheapest one is the one to ship first. The one thing
not to build is the one you led with: burning banner ads into the picture.**

---

## The thing that changes the answer: half of this already exists

This is not a green field. The map, with file paths:

| Piece | Where it already lives |
|---|---|
| **Burn-in compositing in the live encoder** | `volt-encoder/bin/encoder.py`, `_overlay_vf()` at line 496, building `movie=…,format=rgba,colorchannelmixer=aa=…[wm];[in]scale=…[bg];[bg][wm]overlay=…` |
| Fetching the graphic to the encoder | `_fetch_watermark()`, `encoder.py:417` |
| Per-channel overlay config in the database | `channels.watermark_enabled / watermark_ref / watermark_position / watermark_offset_x / watermark_offset_y / watermark_opacity / watermark_scale`, migration `0014_channel_columns_drift.sql` |
| Passing it to the encoder | `volt-app/src/services/jobConfig.ts`, `buildEncoderJobConfig()` emitting `cfg.watermark` |
| An asset library with an object store | `media_files` + `media_folders`, `services/imageStore.ts`, keys `library/<account>/<path>` and `derived/<account>/<path>` |
| **An overlay layer in the player** | `volt-player/src/layouts/stage.ts` already has the z-index stack (`.vp-screen` z0, poster z1, `.vp-scrim` z2, `.vp-chrome` z3, cover z4) and already paints `.vp-logo` from `player_configs.options.logoUrl` |
| A job queue with a handler pattern | `services/jobs/queue.ts` + `worker.ts`, existing handlers `clipExtract.ts` and `qcRun.ts` |
| Stream-copy concatenation | `services/clips/extract.ts` (`concatRun`, and `-f concat -c copy`) and `services/vod-extractor-job.ts` |

So the platform already burns one static PNG into the live picture and already
paints one logo over the player. **The proposal is really "make that overlay a
template with a data feed instead of a fixed image", which is a much smaller
statement than "build a graphics system".**

Two things genuinely do not exist: **any ad marker support at all** (a repo-wide
search for `scte`, `EXT-X-DATERANGE`, `CUE-OUT`, `vast`, `vmap`, `midroll`
returns nothing but `Array.splice`), and any HTML rendering anywhere in the media
path.

---

## Part 1: what the compositing actually costs, measured

### Finding 1: the browser is not the bottleneck. The screenshot is.

I built a 1080p scorebug as a plain HTML page with a deterministic
`renderFrame(n)` function, then measured a headless Chromium producing frames
from it:

| What was measured | Per frame | Against 25 fps realtime |
|---|---|---|
| **DOM update only, no capture** | **0.9 ms** | **45x faster than realtime** |
| Clipped capture, 620x68, PNG with alpha | 33 ms | 1.2x |
| Full 1080p, JPEG, no alpha | 40 ms | 1.0x |
| Full 1080p, PNG with alpha | 74 ms | **0.54x, slower than realtime** |

Read the first row against the last. **Rendering the graphic costs about one
percent of the budget. Ninety-nine percent goes on capturing it, serialising it
across the DevTools socket and PNG-encoding it.** The naive implementation, take
a screenshot every frame, is half of realtime and would look like proof that
"HTML graphics are too expensive for live". It is not. It is proof that
screenshots are the wrong capture mechanism.

This has three consequences, and they shape the whole design:

1. **Never capture the full frame.** The scorebug's bounding box was 620x68, or
   **two percent of a 1080p frame.** Render and composite the box, position it
   with the `overlay` filter's `x:y`, and leave the other 98 percent alone.
2. **Never capture at frame rate.** A scorebug changes when somebody scores. It
   is an **event stream, not a 25 fps video stream.** Capture on change, hold the
   last buffer for the frames in between. That turns a per-frame cost into a
   per-event cost, and a football match has maybe a few hundred events in ninety
   minutes rather than 135,000 frames. The exception is animated transitions, the
   wipe-on and wipe-off, which genuinely are 25 fps for about a second and can be
   pre-rendered once per template.
3. **Do not write the fast capture path yourself.** The reason CasparCG, OBS and
   the commercial graphics vendors all use CEF offscreen rendering rather than
   screenshots is exactly the gap in that table: `OnPaint` hands you a dirty-rect
   BGRA buffer in-process with no serialisation and no image encoding. That is a
   real piece of engineering and it is a bad place to spend our weeks.

### Finding 2: VoD intros and outros cost essentially nothing, if you match parameters

Attaching a graphic to the front of a VoD does not need a re-encode at all, and
the machinery is already in the repo. Measured:

```
intro.mp4   1280x720 h264 High,  75 packets,  3.00s
body.mp4    1280x720 h264 High, 250 packets, 10.00s
joined.mp4  1280x720 h264 High, 325 packets, 13.02s   <- 75 + 250 exactly
concat wall time: 0.109 seconds
```

Both files encoded with identical `-profile:v high -level 4.0 -pix_fmt yuv420p
-g 50 -keyint_min 50 -sc_threshold 0 -video_track_timescale 90000`, then joined
with `-f concat -c copy`. **A one-hour asset gets its branded intro and outro in
a fraction of a second with no quality loss and no transcode**, using the same
`-f concat -c copy` call that `clips/extract.ts` and `vod-extractor-job.ts`
already make.

### Finding 3: and here is how that goes wrong, silently

The same test with a mismatched intro, 1920x1080 instead of 1280x720, everything
else equal:

```
badjoin.mp4  claims 1920x1080, 325 packets, duration 90.94 seconds
ffmpeg exit code: 0
```

Thirteen seconds of content in a file that reports itself as ninety-one seconds
and the wrong resolution. **One warning on stderr about non-monotonic DTS, a
clean exit code, and a broken asset.** No exception to catch, nothing for a job
handler to fail on.

So the rule for the render job is not "produce an MP4". It is: **read the target
asset's exact encoder parameters and render the intro to match them, then verify
the joined packet count equals the sum of the parts before publishing.** That
check is two lines of `ffprobe` and it is the difference between this feature
being reliable and it quietly shipping corrupt files to customers.

### Finding 4: a text-only scorebug needs no new infrastructure at all

`drawtext` takes `textfile=…:reload=1` and re-reads the file during encoding.
Verified against a solid background so the text was the only thing that could
change: three sampled frames, three different hashes, one continuous ffmpeg
process, no restart. The Docker encoder image already ships ffmpeg built with
`drawtext`.

That is not the product. It is a way to put a live scorebug in front of a
prospect **this week**, on a real stream, before committing to any of the below.

---

## Part 2: the three use cases have three different answers

You grouped scorebugs, ad banners and VoD intros as one feature. Technically they
share a renderer. Commercially they are opposites, and the ad one is the one to
get right.

### Sports scorebugs: yes, and this is the differentiator

Real demand, real willingness to pay, and it is the thing that makes a white
label platform feel like broadcast rather than like a video host.

But the graphics are the easy half. **A scorebug without a score is wallpaper.**
The product is the **data channel**: a small live state document per event that
an operator updates from a console panel, an API pushes into, or a sports data
feed drives, with the template bound to it. That is what customers pay for, it is
cheap to build, and it is the part a generic graphics tool does not give them
because it does not know what an event is. We do.

### Banner ads: build the overlay, do not burn it in

This is the one to push back on. Burning a banner into the picture makes it
**identical for every viewer**, which destroys the only property that makes ad
inventory valuable. A burned-in banner is sponsorship sold at a flat rate. A
client-side overlay is addressable, so it can differ by geography, by account, by
device and by session, and it reports its own impressions. Same pixels, an order
of magnitude apart in what they are worth.

The correct shapes, and they are not the same as each other:

- **Sponsor identity and brand marks**: burn in. Contracts often require it, it
  survives redistribution and download, and ad blockers cannot touch it. This is
  the existing watermark feature grown up, and it is the honest use of burn-in.
- **Targeted display and banners**: client-side over the player, never burned.
  The player already has the layer.
- **Video ads, pre-roll and mid-roll**: neither. That is `SCTE-35` markers in the
  manifest plus server-side ad insertion, which is a different project with a
  different standard, and we currently emit **no ad markers of any kind**. The
  HLS writers already emit `EXT-X-DISCONTINUITY`, so adding `EXT-X-DATERANGE` and
  `EXT-X-CUE-OUT` is a small change to code that exists, and it is where the
  actual ad money is. Worth a separate note, not worth conflating with graphics.

### VoD intros, outros and social cut-downs: the easiest money in the list

Lowest cost, fastest to ship, immediately visible to every customer, and it uses
machinery that is already built. Two variants with very different costs:

- **Intro and outro cards**: parameter-matched render plus `-f concat -c copy`.
  0.109 seconds, per Finding 2.
- **A persistent lower third across a whole asset**: requires re-encoding the
  entire asset. Genuinely expensive, and it should be priced as such rather than
  bundled.

One free lunch worth naming: **when an asset is being reformatted for social
anyway, a 9:16 or 1:1 crop, it is being re-encoded regardless, so burning
graphics into that render costs nothing extra.** Social cut-downs are where
full-frame graphics are effectively free, and they are also where branding
matters most.

---

## Part 3: the architecture that keeps this from fragmenting

**One template artifact. Three renderers. Non-negotiable.**

```
                      ┌─ the player (DOM over the video)      live, addressable, free
  template + data ────┼─ the console (the same DOM, preview)  what you see is what ships
                      └─ headless render (frames to ffmpeg)   VoD burn, and live burn if paid for
```

If a template can render in the player but not in the burn job, the feature
splits into two half-products and every customer finds the seam. That constrains
the template language, deliberately:

- **A fixed canvas** with a declared safe area, not a responsive layout.
- **A declarative data contract**, so the same state document drives all three.
- **Deterministic animation**: a `renderFrame(n)` function driven by frame number,
  never `requestAnimationFrame` or wall-clock. The offline renderer has to be able
  to ask for frame 4,271 and get exactly what the player showed at that moment.
  The benchmark page above was written this way and it is the reason the render
  cost came out at 0.9 ms.
- **No network fetches at render time.** Data arrives as state, assets resolve
  from `library/<account>/…`.

Templates fit the existing asset library with a new `media_files.kind`, and
rendered output belongs under the `derived/<account>/…` prefix that already
exists for generated keyframes and storyboards.

### The one encoder change that live burn-in needs first

`encoder.py` applies the overlay with **`-vf` per ladder rung**, at line 553, so
the graphic is decoded and composited once for every rendition. That is
acceptable for a static PNG and wrong for a dynamic source.

The fix is also the cost saving: **composite once onto the decoded full-resolution
frame, before the ladder splits, then scale each rung from the composited
picture.** That means one alpha blend per frame instead of one per rung, and it
converts the graph from per-output `-vf` to a single `-filter_complex` with a
`split`. It is a contained refactor of `start_transcode()`, it should happen
before any dynamic overlay work, and it makes the marginal cost of live graphics
roughly "one browser process plus one blend", not "another transcode".

---

## Part 4: build or plug in

**Both, on different halves.** Buy or borrow the renderer, own the template
format and the control plane.

**Singular.live** is the obvious incumbent and the pricing settles it: **$150 a
month for the Professional tier with ONE output, and $100 a month for each
additional output**, Enterprise from $350. Priced per output, which is per
channel. Forty channels is over four thousand dollars a month before anyone has
sold anything. **That does not survive contact with multi-tenancy**, so it cannot
sit underneath our product as a resold dependency.

It is however a perfectly good **integration**. A customer who already has a
graphics team and a Singular subscription should be able to point their output at
one of our events, and that costs us almost nothing to support because their
client-side output is a URL and their on-device rendering is somebody else's box.
Support it as an input. Do not resell it.

**CasparCG** is the free broadcast-grade option and it does use CEF for HTML.
It is also a playout server designed around SDI and NDI outputs and a channel
model of its own, which is an awkward citizen in a per-tenant container fleet.
Right answer for a customer who already runs one. Wrong answer as our core.

**What to own**: the template format, the data channel, the operator panel, the
preview, and the binding to events, channels and accounts. That is product, it is
where the customer experience lives, and no vendor will give it to us shaped like
our domain model.

---

## Part 5: phasing, and what it costs

The order is deliberately the reverse of the order the use cases were raised in,
because value per week of work runs the other way.

**Phase 0, days. Prove demand before building.** `drawtext` with
`textfile=…:reload=1`, verified working above, plus a scratch endpoint that
writes the file. Put a live scorebug on a real stream in front of a real
prospect. Ugly typography, zero infrastructure, and it answers the only question
that matters before spending five weeks.

**Phase 1, roughly three to four weeks. Template, data channel, player overlay.**
No encoder changes at all. Ships the scorebug and the addressable banner for
anyone watching in our player, which is most viewers. Uses the z-index stack in
`stage.ts` that is already there.

**Phase 2, roughly two to three weeks. The offline burn job.** A new
`overlay.render` handler alongside `clipExtract` and `qcRun`, headless Chromium,
parameter inheritance, the packet-count verification from Finding 3, and
`-f concat -c copy`. Ships VoD intros, outros and burned graphics on social
cut-downs.

**Phase 3, deferred until somebody pays for it. Live burn-in.** Needs the
`-filter_complex` refactor first, then CEF offscreen rendering with capture on
change. This is the only part with real media-engineering risk, and the only part
whose value is limited to customers redistributing outside our player.

**Separately, and worth more than all of the above: `SCTE-35` markers.** Not
graphics. The manifests already carry discontinuities, and ad markers are where
the monetisation question actually leads.

So: **five to seven weeks for phases 1 and 2 together**, mostly control plane and
player work rather than media engineering, on top of a burn-in path and an asset
library and a job queue that already exist.

**Is it more hassle than it is worth? No, provided phase 3 stays deferred.**
Phases 1 and 2 are ordinary application work with a well-understood cost. Phase 3
is where the hassle lives, and it is separable, which is the whole reason to
sequence it this way.

---

## Open decisions

1. **Is the scorebug data channel operator-driven, API-driven, or fed from a
   sports data provider?** All three eventually, but the first one shapes the
   console.
2. **Who authors templates?** A fixed library we ship, a customer uploading HTML
   (which is arbitrary code in a renderer, so it needs sandboxing), or a
   constrained visual editor. This is the largest scope question in the whole
   feature.
3. **Does a burned-in sponsor graphic need to appear in recordings and clips as
   well as the live stream?** If yes, it must be burned live rather than at
   publish time, which pulls phase 3 forward.
4. **Ad markers: separate project, or the natural sequel to phase 1?**

## How to re-run the measurements

```bash
# Finding 2 and 3: concat, matched and mismatched
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=25:duration=10 -f lavfi -i sine=duration=10 \
  -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p -g 50 -keyint_min 50 -sc_threshold 0 \
  -c:a aac -ar 48000 -ac 2 -video_track_timescale 90000 body.mp4
# ...same flags for intro.mp4, then:
printf "file 'intro.mp4'\nfile 'body.mp4'\n" > list.txt
ffmpeg -f concat -safe 0 -i list.txt -c copy joined.mp4
ffprobe -select_streams v:0 -count_packets -show_entries stream=nb_read_packets joined.mp4

# Finding 1: render cost vs capture cost
# a page exposing window.renderFrame(n), then per frame:
#   await page.evaluate(n => window.renderFrame(n), n)        -> 0.9 ms
#   await page.screenshot({ omitBackground: true })           -> 74 ms
#   await page.screenshot({ clip: bbox, omitBackground: true }) -> 33 ms

# Finding 4: live text reload, no encoder restart
ffmpeg -re -f lavfi -i color=c=darkgreen:size=640x360:rate=25:duration=3.5 \
  -vf "drawtext=textfile=score.txt:reload=1:fontsize=28:fontcolor=white:x=20:y=20" out.mp4
# rewrite score.txt while it runs
```

## Sources

- [Singular.live pricing](https://www.singular.live/pricing)
- [Singular.live client-side rendering](https://www.singular.live/solutions/client-side-rendering)
- [Bitmovin: SCTE-35, the essential guide](https://bitmovin.com/blog/scte-35-guide/)
- [Bitmovin: live encoding with HLS, SCTE-35 and SSAI](https://developer.bitmovin.com/encoding/docs/live-encoding-with-hls-scte-35-and-ssai)
- [CEF offscreen rendering discussion, on the cost of the capture path](https://magpcss.org/ceforum/viewtopic.php?f=6&t=19628)
- [CasparCG on headless Linux with ffmpeg output](https://casparcgforum.org/t/casparcg-server-on-headless-linux-outputting-ffmpeg/7593)
