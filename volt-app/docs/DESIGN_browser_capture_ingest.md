# Browser capture: streaming from a phone, a desktop, or a screen

**Assessment only. Nothing here is built and no code was changed to write it.**

The question: can the web app ask for a camera, a microphone and a desktop, and
send them to our encoder as an instant event? What would it cost to offer, and
what is it worth?

Short answer: **yes, and the increment is smaller than it looks, because it adds
a new front door to an encoder fleet we already run rather than a new cost
centre.** There is one hard constraint that shapes the whole product, and it is
not negotiable: **no mobile browser can capture a screen.**

---

## Part 1: mobile upload, which we already have

Uploads are already the right shape for a phone, and that is not an accident —
`services/uploads.ts` was built resumable:

- **8 MB chunks**, tracked individually, with `missingChunks()` and resume.
- **A per-session capability token**, deliberately separate from the user's JWT.
  The comment in `modules/uploads.ts` says why: *"a fifteen-minute JWT would
  expire in the middle of a large file"*. On a phone that is the normal case,
  not the edge case.
- **16 GB cap**, well beyond anything a phone produces.

That combination is exactly what mobile needs: a dropped connection in a lift, a
backgrounded browser, a switch from wifi to cellular — all resumable.

### Three gaps worth checking before claiming mobile support

None are big, and none were changed:

1. **HEIC and HEVC.** The upload allow-list is `mp4, mov, m4v, webm, mkv, ts,
   mpg, mpeg, avi` plus stills. An iPhone shooting in its default "High
   Efficiency" mode produces **HEVC inside .mov** for video and **.heic** for
   stills. The .mov passes the extension check; whether the pipeline transcodes
   HEVC is a separate question. **.heic is not in the list at all**, so an iPhone
   photo would be stored without an extension.
2. **`capture` and `accept` on the file inputs.** `ImageLibrary` uses
   `accept="image/*"`, which on mobile does offer the camera. Adding
   `capture="environment"` where a live photo is wanted skips the picker.
   Worth an audit of every input rather than a guess.
3. **Nobody has tested it on a phone.** The design is right; the evidence is
   absent, and those are different things.

---

## Part 2: THE constraint — screen capture does not exist on mobile

`getDisplayMedia()`, the API that captures a screen, window or tab:

| Browser | Support |
|---|---|
| Desktop Chrome / Edge / Firefox / Safari | **Yes** |
| **iOS Safari** (all versions to date) | **No** |
| **Android Chrome** | **No** |
| **Samsung Internet** | **No** |

This is not a gap we can code around: the API is absent from every mobile
browser. So the feature splits, permanently, into two different products:

- **Desktop browser** — camera, microphone, **and screen/window/tab**. The full
  proposition.
- **Mobile browser** — camera and microphone only. Still valuable (a reporter in
  the field, a walk-around, a piece to camera), but it is not "share my screen
  from my phone" and never will be in a browser.

A native mobile app can capture the screen (iOS ReplayKit, Android
MediaProjection). That is a separate product with a separate cost, and the
honest position is that browser-first covers the two segments below anyway,
because **gamers and corporate presenters are both sitting at a desktop.**

---

## Part 3: how it would work, and why it is a small change

The standard landed: **WHIP — WebRTC-HTTP Ingestion Protocol — is now RFC 9725**
(IETF, 2025). It is a plain HTTP POST of an SDP offer, which makes it the first
browser-native ingest that is genuinely standard rather than vendor-specific.

The shape that fits this platform:

```
browser (getUserMedia + getDisplayMedia)
   │  WHIP over HTTPS, one POST, token-authenticated
   ▼
WHIP ingest tier  ──── forwards natively, no re-encode ────►  SRT
   │                                                            │
   └── MediaMTX: `forward: - dest: srt://host:port?streamid=…`   ▼
                                                     OUR EXISTING ENCODER
                                                     (unchanged)
```

**Everything downstream is untouched.** The encoder already takes SRT with a
streamid; `ingestProtocols.ts` is already a descriptor registry that the source
form reads, so `whip` becomes a row in it rather than a new form. Recording,
recording→VoD, clipping, captions, the player, share links, geo/rights,
analytics — all of it works because the stream arrives as SRT like any other.

MediaMTX ingests WHIP and forwards to SRT or RTMP **natively, without ffmpeg**,
which means the ingest tier does no encoding and stays cheap.

### What would actually have to be built

| | Effort |
|---|---|
| WHIP ingest tier: MediaMTX + per-event config, token auth, forward to the event's SRT | Small — the component exists |
| `whip` descriptor in `ingestProtocols.ts` | Trivial |
| **Browser capture UI**: device pickers, screen picker, preview, levels, go-live | **The bulk of it** |
| "Instant event": one click → event + encoder + WHIP endpoint, auto-ends | Small — `events` already have windows |
| TURN server (see below) | Small to run, real to pay for |

---

## Part 4: cost

### The feature adds a front door, not a cost centre

A browser-ingested event costs **the same as any other event** once it is
running: one encoder task plus viewer egress. Those are already modelled in
`usage_accruals` and already priced in `compute_rates`. The only NEW cost is the
ingest hop.

**The WHIP tier is cheap because it does not encode.** It terminates DTLS/SRTP,
depacketises and forwards. Call it a network-bound box like the relay tier. The
honest caveat: WebRTC has materially more per-connection overhead than SRT — ICE,
DTLS, SRTP, RTCP, jitter buffer — so the concurrency per instance needs
**measuring, not assuming**. Plan a load test before quoting a number.

### TURN is the cost nobody budgets for, and corporate is exactly who needs it

WebRTC prefers a direct path. Where the network refuses one — symmetric NAT,
strict firewalls, no UDP — the media is **relayed through a TURN server**, and
relayed media is egress we pay for, on the INGRESS side, which no other ingest
protocol in this platform costs us.

The customers most likely to need TURN are corporate ones, because corporate
networks are the restrictive ones. So the segment with the best willingness to
pay is also the segment with the extra cost. Budget it explicitly:

- a 3 Mbps presenter relayed via TURN for a 1-hour town hall is ~1.35 GB in;
- at $0.09/GB that is ~12 cents per presenter-hour, and near zero on a
  bandwidth-inclusive host (see `RELAY.md` — the same 80× argument applies, and
  TURN is stateless, so it belongs in the same place as the relays).

### Build versus buy

For comparison, Cloudflare Stream charges **$5 per 1,000 minutes stored** and
**$1 per 1,000 minutes delivered**, with **ingest and encoding free**. That is
genuinely cheap and worth knowing.

But buying it means the stream is encoded and served by them, which bypasses our
encoder, our recording layout, our clipping, our captions and our player — that
is to say, most of the product. **Buy the WHIP hop if we ever need to; do not
buy the pipeline.** Using a managed WebRTC service purely as a WHIP-to-SRT
gateway is a legitimate fallback if running one proves annoying, and it keeps
everything downstream ours.

---

## Part 5: what it is worth

### Gamers: a weak direct market, a reasonable indirect one

Competing with Twitch and YouTube on their terms is not a business — they are
free, and their value is the audience, not the encoder. The angle consistent
with the rest of VOLT is **white-label**: a games publisher, an esports
organisation or a tournament operator running a branded platform of their own,
where the audience is theirs and they need the infrastructure.

There is also a technical honesty point: **a serious gamer will use OBS**, which
already speaks RTMP and SRT and which we already support. Browser capture is for
the person who will not install anything. That is a real and large group, but it
is the casual end, and the casual end monetises through volume, which is the
part we do not have.

### Corporate: the stronger case, and it leans on what we already built

Town halls, all-hands, training, product launches, internal briefings. The
reasons this is the better segment:

- **They will not install software.** "Open a link, allow the camera, share your
  screen, go live" removes the entire IT-approval conversation. That is the
  whole value proposition and browser capture is the only way to deliver it.
- **The recording is the deliverable, not the live stream.** Most corporate
  video is watched afterwards. We already have recording → VoD, clipping and
  captions, so the thing they pay for is already built.
- **They need what a consumer platform will not give them**: geo and rights
  gating, a branded player, share links with expiry, per-viewer analytics,
  retention control. All present.
- **Willingness to pay is per-seat or per-event, not per-viewer**, which suits a
  platform whose costs are per-event.

### The instant-event framing is right

"Instant event" is exactly the correct abstraction and it is nearly free: an
event whose window starts now. It inherits the whole lifecycle — provisioning,
recording, auto-VoD, auto-clip, retention — and the only new thing is the front
door.

---

## What would need deciding before building

1. **Desktop-first, and say so.** Mobile is camera-only by browser limitation.
   Do not promise screen sharing from a phone.
2. **Is corporate the target, with gaming as a marketing story?** The build is
   the same either way; the positioning, pricing and support burden are not.
3. **Measure WHIP concurrency per instance** before quoting capacity to anyone.
4. **Decide where TURN runs**, and budget ingress egress for it — the one line
   item this feature genuinely adds.
5. **Native mobile app: explicitly out of scope for now**, and revisit only if
   mobile screen capture turns out to be a real ask rather than an assumed one.

---

## Sources

- [RFC 9725 — WebRTC-HTTP Ingestion Protocol (WHIP)](https://www.rfc-editor.org/info/rfc9725/)
- [Can I use — `getDisplayMedia()`](https://caniuse.com/mdn-api_mediadevices_getdisplaymedia)
- [MediaMTX — forwarding streams](https://mediamtx.org/docs/features/forward)
- [Cloudflare Stream pricing](https://developers.cloudflare.com/stream/pricing/index.md)
