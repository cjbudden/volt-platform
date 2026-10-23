# The Volt player SDK

One player, everywhere Volt plays: customers' websites and apps, the share
preview page, and the console. Phase 1 (this release) is the **web SDK** with
its skins; the native SDKs follow the same contract (section 9).

Code: `volt-player/src/sdk` (the SDK), `volt-player/src/index.ts` (the
`window.VoltPlayer` bundle), `volt-web/src/VoltPlayerView.tsx` (the console's
React wrapper). Tests: `volt-app/test/player-sdk.check.ts` (47, the rules),
`volt-app/test/player-sdk-api.check.sh` (29, the server side),
`volt-app/test/player-layouts.check.ts` (12, saved skins vs the bundle).

## 1. What it does

| Feature | Where it works |
|---|---|
| Video and audio: HLS and DASH (Shaka), progressive MP3/MP4, the browser's own HLS on Apple devices | every browser with Media Source Extensions; iPhone and Safari natively |
| **Playlists** from Volt asset ids, plain URLs, or items with metadata | all |
| **Guide (EPG)**: the programme on air, a schedule panel, the next programme | live channels and events with a published guide |
| **Up next**: a card before the end of an item (counts down and plays the next) or of a programme (says what starts next) | all |
| **Start over** (back to the programme's start) and **Go live** | live streams with a DVR window and PROGRAM-DATE-TIME |
| **Quality menu** (Auto shows what it picked) | adaptive streams with more than one size |
| **Subtitles menu**, only when the stream has subtitles; the viewer's language is remembered | all |
| **Audio language menu**, only when there is more than one | all |
| **Chromecast** (Google Cast web sender, loaded only where it can cast) | Chrome and Edge, desktop and Android |
| **AirPlay** | Safari (macOS, iPhone, iPad) |
| Picture in picture, full screen, keyboard (space, arrows, m, f, c) | where the browser supports them |
| **Viewer beacons** for Analytics (start, heartbeat, end) | any item with a playback token |
| Themes (no code) and custom skins (code) | all |
| **Playback stats** (right-click > Playback stats, or Shift+D): what is really playing, dropped frames, codecs, bandwidth, buffer, latency, CDN, stalls; Copy debug info for a support ticket | all skins, and the console's hls.js / dash.js monitors (section 12) |

## 2. Skins

| Skin | For | Saved in Player setup? |
|---|---|---|
| `video` | The front-end video player: title, logo, the controls above, up next, schedule | yes |
| `event` | An event's whole life: promo (poster, the two teams or the line-up), countdown, postponed / cancelled, the paywall's passes with Buy, the replay afterwards; the `video` player while it is live | yes |
| `audio_square` | A square tile: artwork, track, play | yes |
| `audio_wave` | A strip: artwork, track, a live waveform (from the audio itself when the browser allows, a gentle idle motion otherwise) | yes |
| `audio_nowplaying` | Big artwork, track details, the last five tracks, what is coming up, and the Coming up banner | yes |
| `audio_radio` | A station player: logo and name, the programme on air with its progress and time left, a waveform, the Coming up banner the stream raises before the next programme, then Next and Later | yes |
| `admin` | The console's player: no branding or casting, the bar under the picture, what is actually playing (resolution, bitrate, buffer, distance from live), a Stats button for the playback stats panel | no (console only) |

The four original station layouts (`card`, `bar`, `hero`, `stage`) remain. A
station whose saved layout is an SDK skin is handed to the SDK player by the
same embed snippet, with no change on the customer's page.

**What the audio skins show**, best first: the track now playing (the
station's metadata, enriched with artwork), else the programme on air (the
guide), else the item's own title and artwork. "Recently played" is the last
five songs from the station's content log (idents and ad breaks left out);
"Coming up" is the guide.

## 3. Embedding

**From the console**: the **Embed player** button beside Share, on a channel's
page (icon) and in an event's drawer (Player). It offers video skins only (a
channel gets the video player; an event gets the event player or the plain
video player), the app and its key (with "Create a key for this embed", shown
once), account branding or a colour, corners, autoplay, schedule / start over,
Chromecast, AirPlay, the checkout and sign-in pages for paid events, and a
width. The preview is the real player in demo mode (for events: Countdown,
Paid, Postponed, Live, Replay). The tag carries its own settings, so nothing
is saved and two sites can embed the same event differently. Radio stations
keep their own Player setup page with the audio skins.

**No code** (a CMS block, a static page):

```html
<div data-volt-player data-app-key="pk_live_…" data-asset-id="<channel, event or VOD id>"
     data-skin="video" data-primary-color="#e11d48"></div>
<script src="https://<your volt>/player/volt-player.js"></script>
```

Other attributes: `data-event-id` (the event skin), `data-purchase-url`,
`data-sign-in-url`, `data-playlist="<id>,<id>,…"`, `data-src="<manifest URL>"`,
`data-epg-channel="<channel id>"`, `data-station-id` (radio now playing),
`data-theme='{"radius":4,"logoUrl":"https://…"}'`, `data-logo`,
`data-autoplay`, `data-muted`, `data-poster`. The original station embed
(`data-channel-id` only) still works and follows the station's saved config.

**With code**:

```js
const player = await VoltPlayer.VoltPlayer.create({
  el: '#player', appKey: 'pk_live_…',
  playlist: ['<asset id>', '<asset id>', 'https://cdn.example.com/promo/master.m3u8'],
  epg: { channelId: '<channel id>' },          // or an array of programmes
  theme: { primary: '#e11d48', logoUrl: 'https://…/logo.png', upNextSeconds: 20 },
  skin: 'video', autoplay: true, muted: true,
})
player.on('itemchange', ({ index }) => …)
player.on('programmechange', (p) => …)
player.next(); player.seek(120); player.setTheme({ radius: 0 })
```

Options (all optional except `el`): `skin`, `theme`, `apiBase`, `appKey`,
`source`, `item`, `playlist`, `startIndex`, `assetId`, `epg`, `stationId`,
`autoplay`, `muted`, `poster`, `watermark`, `startAt`, `requestHeaders`,
`beacons`, `cast` (`false`, or `{ receiverAppId }`), `airplay`, `media`,
`strings` (translations), `demo`, `debug` (section 12), `onEvent`, and for events `eventId`,
`viewerToken`, `purchaseUrl`, `signInUrl`.

Events: `state`, `ready`, `play`, `pause`, `ended`, `error`, `itemchange`,
`programmechange`, `upnext`, `qualitychange`, `castchange`,
`presentationchange`, `locked`, `purchase`, `signin`, `statschange`. A declarative embed
dispatches `volt-player-ready` (the player in `event.detail`) so a page can
listen without creating the player itself.

## 4. The contract (state and commands)

A skin is given **state** and **commands**, never the stream. The full shapes
are in `volt-player/src/sdk/types.ts`; the native SDKs expose the same fields.

State (the parts skins use most): `status` (idle, loading, ready, playing,
paused, buffering, ended, error, offline), `playing`, `error`, `currentTime`,
`duration`, `live`, `seekable`, `dvr`, `atLiveEdge`, `behindLive`, `wallClock`,
`programme`, `nextProgramme`, `schedule`, `canStartOver`, `qualities`,
`quality`, `activeQuality`, `textTracks`, `textTrack`, `audioTracks`, `items`,
`index`, `item`, `upNext`, `nowPlaying`, `history`, `nextTrack`, `cast`,
`airplay`, `fullscreen`, `pip`, `hasPicture`, `audioOnly`, `volume`, `muted`,
and for events `event`, `presentation`, `msToStart`, `access` (mode, message,
products) `replaying`, and `stats` (the stats panel is open); status `locked` means the gate wants a purchase or
a sign-in.

Commands: `play`, `pause`, `toggle`, `seek`, `seekBy`, `goLive`, `startOver`,
`setQuality`, `setTextTrack`, `setAudioTrack`, `setVolume`, `toggleMute`,
`setRate`, `next`, `previous`, `playItem`, `cancelUpNext`, `toggleFullscreen`,
`togglePip`, `cast`, `airplay`, `levels` (frequency data for a visualiser),
`purchase`, `signIn`, `playReplay`, `refreshAccess`, `toggleStats`.

## 5. Theme (no code) and custom skins (code)

**The theme** is saved in Player setup (Radio > station > Player) and applies
to every built-in skin. Stored as the two colour columns plus
`player_configs.options.theme`:

| Token | Meaning | CSS variable |
|---|---|---|
| `primary` | buttons, progress, live dot | `--vp-primary`, `--vp-primary-ink` |
| `secondary` | chrome and cards | `--vp-secondary`, `--vp-secondary-ink` |
| `background`, `text` | the chrome's own colours (text is replaced if unreadable) | `--vp-bg`, `--vp-text`, `--vp-muted` |
| `radius` | corners, 0-28 px | `--vp-radius` |
| `font` | a font the page loads | `--vp-font` |
| `logoUrl`, `logoPosition` | https or a path on the site; top left, top right, bottom right, hidden | |
| `upNextSeconds`, `autoAdvance` | when the up-next card appears; play the next item by itself | |
| `controls` | which controls show (title, 10 s buttons, volume, quality, subtitles, audio, start over, schedule, up next, recently played, PiP, full screen, Chromecast, AirPlay) | |

Text on a colour is always black or white, whichever reads better; a chosen
text colour below 3:1 contrast is replaced. "Use account branding" fills the
colours and logo from Admin > Account settings.

**A custom skin** is a `mount(ctx)` and an `update(state)`:

```js
VoltPlayer.registerSkin('acme', () => ({
  mount(ctx) { /* build DOM in ctx.root, place ctx.stage (the picture), wire ctx.commands */ },
  update(state) { /* cheap: change what changed */ },
}))
VoltPlayer.VoltPlayer.create({ el: '#p', skin: 'acme', appKey, assetId })
```

`VoltPlayer.kit` has the pieces the built-in skins use (icons, buttons with
tooltips, menus, sliders, auto-hide, time formatting). A complete example:
`volt-player/examples/custom-skin.html`. `demo: { … }` renders any state with
no stream, for designing a skin.

## 6. Events: countdown, phases, paid access

`GET /api/player/event?appKey=&eventId=` gives the event skin its title,
promo (from the event's schema.org metadata: competition, venue and round, the
home and away teams or performers with logos, the poster), the start in epoch
ms, the promoter's messages, the published replay, and **the phase**, which
the control plane decides and the player never guesses from its clock:

| Phase | When | The skin shows |
|---|---|---|
| `pre` | before the start | countdown (days, hours, minutes, seconds), the start in the viewer's own time, Add to calendar (.ics) |
| `offline` | past the start, not live yet | "Starting soon"; the stream starts by itself |
| `live` | live, inside its public window, output valid | the video player |
| `postponed` | metadata `eventStatus` EventPostponed / EventRescheduled | was / now, or "a new date will be announced" |
| `cancelled` | EventCancelled | said plainly, no countdown |
| `ended` / `replay` | after the end, without / with a published VOD | the closing message / Watch the replay |

The player polls the phase every 30 s (every 5 s in the last two minutes and
during a delayed start) and loads the stream the moment it is live.

**Paid and members-only events.** The play gate answers a paywall with the
passes (name, what it covers, price in the viewer's locale). The skin lists
them with Buy at any phase, so viewers buy before the start. Buy opens the
checkout page (`purchaseUrl`, with `{productKey}`, `{assetId}`, `{price}`,
`{currency}` filled in) or, without one, emits `purchase` for the host page's
own checkout. Once the viewer has bought or signed in, the page passes their
Volt viewer session token: `player.setViewerToken(token)`, and the gate is
asked again. "Already bought? Check again" does the same. A region block is
shown as a message.

## 7. Live: guide, up next, start over

The guide comes from `GET /api/player/epg?appKey=&channelId=` (programmes from
6 hours back to 24 ahead, not the radio content log, refreshed every 5
minutes). The programme shown is the one **at the playhead**: a viewer three
minutes behind live sees the change three minutes later.

**The Up next / Coming up card is one template** (`kit.upNextCard`, exported for
custom skins as `VoltPlayer.kit.upNextCard(ctx, 'overlay' | 'banner')`): the video
skins use the overlay (bottom right of the picture), the audio skins the banner.
Whatever drives it (the stream's own trigger, a fetched guide, or the end of a
playlist item) it says the same things the same way: "Starts in 2 min" or
"Coming up in 40 s", the title, the subtitle, the start time when known. When the
stream times the card, its bar runs over the card's own time on screen; otherwise
over the countdown. With no guide loaded, the stream's programme markers name what
is on and, about 90 s ahead, what is next.

**Skip intro / recap / credits** (on-demand only): `state.skip` is the stretch at the playhead from the asset's
skip markers (docs/DESIGN_vod_skip_markers.md), `commands.skip()` jumps past it (credits on a playlist: the next
item). The video and admin skins show the button (`kit.skipButton`); `controls.skip: false` turns it off. Never
offered live.

`player.getStreamGraphics()` returns every trigger the manifests have announced
(past, on screen, upcoming) in media time, whatever `showGraphics` says: for
checking a stream, not drawing.

Start over needs the stream's wall clock (HLS PROGRAM-DATE-TIME, which the Volt
packager writes) and a DVR window that reaches back to the programme's start.
The button only appears when both are true, so it never promises a beginning
that has already left the window.

## 8. Casting

**Chromecast**: the TV is sent the stream URL and plays it itself, so the URL
must be reachable from the TV and allow its origin (CORS); Volt's delivery
does. The receiver is Google's Default Media Receiver unless an app id is set
(`cast: { receiverAppId }`; a branded receiver is registered in the Google
Cast console). **AirPlay** uses Safari's picker; on Apple devices the player
plays HLS natively so there is a URL to hand over. Both are off on share
previews (a private preview stays on the device it was opened on) and in the
console.

## 9. Where Volt uses it

| Page | Skin | Notes |
|---|---|---|
| Share preview (`/share/<token>`) | `video` in the account's primary colour; `audio_radio` for a radio station | watermark inside the picture (stays in full screen); beacons filed as "Share link"; plays the delivered copies (`master_cc` / `manifest_cc`), so in-stream graphics show; an **In-stream graphics** panel lists what the stream announced and when, to check triggers before a channel goes public; falls back to hls.js only if the bundle is missing |
| Recording page | `admin` | playlists under `/api/` carry the operator's token |
| Media library (video preview) | `admin` | |
| Player setup preview (radio) | the chosen skin, in demo mode | exactly what embeds will render |
| Embed player (channel and event pages) | `video`, or `event` for events | builds the tag; preview in demo mode |
| Customer embeds | any | the station snippet, or the SDK options above |

The console imports the SDK source (`@volt/player`), loaded on first use so
pages that play nothing do not download Shaka.

## 10. Native SDKs (next phases)

Same state, commands, theme tokens and skins, built on each platform's own
player so DRM, background audio and system controls work properly:

| Platform | Built on | Casting |
|---|---|---|
| iOS, iPadOS, tvOS (Swift package) | AVPlayer; SwiftUI skins | AirPlay (system), Chromecast (Google Cast SDK) |
| Android phone, tablet, Android TV, Fire TV (Kotlin) | Media3 ExoPlayer; Compose skins (TV: D-pad focus) | Chromecast (Cast framework) |
| Chromecast receiver | CAF receiver with the Volt skin | (is the target) |
| Samsung Tizen, LG webOS | this web SDK in a TV shell, remote-key navigation | |
| Roku | BrightScript / SceneGraph | |

The rules in `volt-player/src/sdk/schedule.ts` and `theme.ts` are ported line
for line, and `test/player-sdk.check.ts`'s cases become each SDK's unit tests.

## 11. Server side

| Endpoint | What it gives the player |
|---|---|
| `POST /api/availability` (play gate) | `delivery` (HLS, DASH, and MP3 for radio) for channels, **events** (live in their public window) and **VOD**, plus `meta` (title, description, artwork, length, live); a paywall answer carries the passes and the meta |
| `GET /api/player/event` | an event's phase, times, promo, messages and replay (cached 10 s) |
| `GET /api/player/epg` | the guide around now (cached a minute, keyed and scoped like every player call) |
| `POST /api/player/now-playing` | the track now, plus `history` (last five songs) |
| `POST /api/player/session` | a station's sources and saved config (skin + theme) |
| `PUT /api/player-config/:id` | saves `layout` (any skin above except `admin`) and `options.theme` |

Migrations `0055_player_sdk_skins.sql` and `0056_player_event_skin.sql` let a
config name the SDK skins.

## 12. Playback stats (the debug panel, 23 Oct 2026)

A "stats for nerds" panel on every Volt player, so a viewer on a support call,
a customer's developer, or an operator checking an output can say exactly
what is playing. Code: `volt-player/src/sdk/stats.ts`. Tests:
`volt-app/test/player-stats.check.ts` (46, the rows and the report) and
`volt-app/test/player-stats-browser.check.ts` (46, in Chromium on real HLS
and DASH streams, through Shaka, hls.js and dash.js).

**Opening it.** Right-click the player > **Playback stats** (Shift+right-click
still gives the browser's own menu), **Shift+D** while the player has focus,
the admin skin's **Stats** button, or `player.showStats()`. The same menu has
**Copy debug info**. × closes it.

**What it shows**, measured, not declared:

| Row | Says |
|---|---|
| Asset / Session | the asset id and the beacon session id (what Analytics filed this viewing under) |
| Viewport / Frames | the player's size × device pixel ratio; frames dropped of frames decoded |
| Current / Optimal Res | the rendition playing (size @ frame rate); the smallest rendition that fills the box at this pixel ratio (as hls.js and Shaka size to the player) |
| Volume | level, and muted |
| Codecs | named, with the codec string: `H.264 High L4 (avc1.640028) / AAC-LC (mp4a.40.2) 2ch 48 kHz`; HDR when not SDR |
| Bitrate | the rendition's bitrate, ABR auto or pinned |
| Connection Speed | the engine's bandwidth estimate, with a 60-second graph |
| Network Activity | bytes downloaded each second, and the total, graphed |
| Buffer Health | seconds buffered ahead, graphed |
| Live Latency | live only: seconds behind real time (from PROGRAM-DATE-TIME) or the live edge, and the target, graphed |
| Live Mode / Stream | HLS or DASH, low latency or not, the DVR window, segment length; or "on demand" |
| Engine | Shaka (with version), the browser's own HLS, progressive, hls.js or dash.js; the DRM key system |
| Delivery | the host that served the last segment, the CDN POP and cache result (CloudFront `x-amz-cf-pop` / `x-cache`, Cloudflare `cf-ray` / `cf-cache-status`, Fastly `x-served-by`), where the CDN exposes them (CORS `Access-Control-Expose-Headers`) |
| Stalls / Errors | rebuffers after playback started (and their time), recoverable errors, the last error code |
| Status, Programme | the player's status (with the error), the programme on air |
| Manifest | the URL **without its query**, so a token never ends up in a ticket |
| Date | the playhead's wall clock (live with PROGRAM-DATE-TIME), in the viewer's time zone |

Rows with nothing to say are left out (no latency on demand, no resolution
for audio). **Copy debug info** gives the same rows in full plus the SDK
version, the time (UTC), the browser and the page (without its query).

**Cost.** Nothing is built until the panel first opens; sampling runs once a
second only while it is open. Two media listeners count stalls from load, and
the Shaka path reads the CDN headers of each segment response.

**For customers.** On by default. `debug: false` (or `data-debug="false"` on
a declarative embed) removes the menu and the shortcut for viewers; the API
still works, so a site can put the panel behind its own "Report a problem".
`debug: { open: true }` (or `data-debug="open"`) opens it on load.
`player.getStats()` returns the sample without the panel;
`player.copyDebugInfo()` copies and returns the report; `statschange` fires
when it opens or closes.

**HLS and DASH alike.** Through the SDK both play in Shaka, so every row is
the same. On the console's dash.js monitors the codec, frame rate and segment
length come from the representation actually playing (dash.js's track codec
is only its first representation's); dash.js does not hand over response
headers, so Delivery shows the host but not the POP or cache result.

**On players the SDK does not own.** `attachStats(host, probe)` puts the same
panel and right-click menu on any player. Probes: `mediaProbe(video)` (any
element, including Safari's own HLS), `hlsJsProbe(hls, video)`,
`dashJsProbe(player)`, merged with `combineProbes()` (earlier wins). The
console uses this through `volt-web/src/useStatsPanel.ts` on the channel's
**output monitor** (with a Stats button beside HLS / DASH), the **source
preview**, and the **output URL** previews. Every other console player is the
SDK with the admin skin (recordings, media library, skip markers, FAST), so
it has the panel already.

**Native SDKs (next phases)** are to expose the same sample (`getStats()`),
from AVPlayer's access log and ExoPlayer's analytics listener, and draw the
same rows.

## HTML graphics from the console (20 Oct 2026)

Scorebugs, lower thirds, tickers and bugs set up under Graphics with *Shown in: player* (or both) are drawn by
the SDK over the picture, for any item with an `assetId` (channel or event) and an `appKey`. Nothing to
configure: `showGraphics: false` (or the theme's) turns them off with the in-stream graphics.

* Feed: `GET /api/player/graphics?appKey=&streamId=&since=`, polled every 2 s while the stream has player
  graphics, every 30 s while it has none, never after a 404.
* Timing: the state applied is the one in force at the playhead's wall clock, so they stay with the picture
  behind live and in the DVR.
* Each graphic is a sandboxed iframe (`.vp-gfx` layer in the stage, below the watermark); a template cannot
  reach the host page.
* `state.overlays`: `{ id, name, kind }[]` on screen now. Event `graphic` with `graphic: 'html'` as each comes on.
* Hidden during ad breaks and without a picture. Impressions go to `POST /api/player/graphics/impressions`
  unless `beacons: false`.

Source: `volt-player/src/sdk/overlay.ts`; server `src/services/graphics/playerFeed.ts`; REQ_graphics_overlays.md section 13.
