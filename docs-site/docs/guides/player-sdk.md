---
title: Player SDK
sidebar_position: 5
description: Create and control the Volt web player from code, with skins, themes, playlists, the programme guide, casting, paid events, DRM and playback reporting.
guide: developer
---

# Player SDK

The Volt player is the same player everywhere Volt plays: your websites and apps, share links and the console. This page is for developers who want to create and control it from code. For a no-code tag, see [embed the player](embedding.md).

## What it is for

| Feature | Where it works |
|---|---|
| Video and audio: HLS and DASH, progressive MP3 and MP4, and the native player on Apple devices | Every current browser. iPhone and Safari natively. |
| **Playlists** of Volt asset ids, plain URLs, or items with your own metadata | Everywhere |
| **Programme guide**: what is on, a schedule panel, what is next | Live channels and events with a guide |
| **Up next**: a card before the end of an item (counts down and plays the next) or of a programme (says what starts next) | Everywhere |
| **Start over** (back to the start of the programme) and **Go live** | Live streams with catch-up (DVR) |
| **Quality menu** (Auto shows what it picked) | Streams with more than one size |
| **Subtitles menu**, shown only when the stream has subtitles. The viewer's language is remembered. | Everywhere |
| **Audio language menu**, shown only when there is more than one | Everywhere |
| **Chromecast** | Chrome and Edge, desktop and Android |
| **AirPlay** | Safari on macOS, iPhone and iPad |
| Picture in picture, full screen, keyboard (space, arrows, m, f, c) | Where the browser supports them |
| Viewer reporting for Analytics (start, heartbeat, end) | Any item played through the play gate |
| Themes (no code) and custom skins (code) | Everywhere |

## Skins

| Skin | For |
|---|---|
| `video` | The video player: title, logo, controls, up next, schedule |
| `event` | An event's whole life: promo (poster, teams or line-up), countdown, postponed or cancelled, the passes with Buy, the live player, then the replay |
| `audio_square` | A square tile: artwork, track, play |
| `audio_wave` | A strip: artwork, track and a live waveform |
| `audio_nowplaying` | Large artwork, track details, the last five tracks and what is coming up |
| `audio_radio` | A station player: the programme on air and how far through it is, a waveform, and a Coming up banner before the next programme |

The audio skins show, best first: the track now playing (with artwork), otherwise the programme on air, otherwise the item's own title and artwork.

## Before you start

- An app for your website and its publishable key, with your site on its list: see [Getting started with apps and keys](../api/apps-and-keys.md). Never put a secret key (`sk_live_...`) in a page.
- The ids of the channels, events or on-demand assets to play.
- For paid or members-only content, your sign-in and checkout pages (see [the play gate](../api/play-gate.md)).

Every example on this page is a complete page you can paste and run, with your own key, ids and host.

## Step by step

### Create a player

Load the script, then create a player in an element:

```html file=player/create-player.html
```

The script takes the API address from where it was served, so `apiBase` is only needed when you serve the script from somewhere else.

### Options

Everything is optional except `el`:

`skin`, `theme`, `apiBase`, `appKey`, `source`, `item`, `playlist`, `startIndex`, `assetId`, `epg`, `stationId`, `autoplay`, `muted`, `poster`, `watermark`, `startAt`, `requestHeaders`, `beacons`, `cmcd`, `drm`, `debug`, `cast` (`false`, or `{ receiverAppId }`), `airplay`, `media`, `strings` (your own translations), `demo`, `onEvent`, and for events `eventId`, `viewerToken`, `purchaseUrl` and `signInUrl`.

### Events

`state`, `ready`, `play`, `pause`, `ended`, `error`, `itemchange`, `programmechange`, `upnext`, `qualitychange`, `castchange`, `presentationchange`, `locked`, `purchase`, `signin`.

A tag embed dispatches `volt-player-ready` on the page, with the player in `event.detail`, so you can listen without creating the player yourself.

### Commands

`play`, `pause`, `toggle`, `seek`, `seekBy`, `goLive`, `startOver`, `setQuality`, `setTextTrack`, `setAudioTrack`, `setVolume`, `toggleMute`, `setRate`, `next`, `previous`, `playItem`, `cancelUpNext`, `toggleFullscreen`, `togglePip`, `cast`, `airplay`, `purchase`, `signIn`, `playReplay`, `refreshAccess`, and `setTheme`, `setViewerToken`.

The example above wires **Next** to `player.next()` and calls `player.setTheme(...)`; every command works the same way.

### State

The player's state includes: `status` (idle, loading, ready, playing, paused, buffering, ended, error, offline, or `locked` when a purchase or sign-in is needed), `playing`, `error`, `currentTime`, `duration`, `live`, `dvr`, `atLiveEdge`, `behindLive`, `programme`, `nextProgramme`, `schedule`, `canStartOver`, `qualities`, `quality`, `textTracks`, `audioTracks`, `items`, `index`, `item`, `upNext`, `nowPlaying`, `history`, `cast`, `airplay`, `fullscreen`, `pip`, `volume`, `muted`, and for events `event`, `presentation`, `msToStart`, `access` and `replaying`.

## Themes

A theme changes the look of every built-in skin without code. For radio stations it is saved in **Player setup**. In code, pass `theme`.

| Setting | Means |
|---|---|
| `primary` | Buttons, progress, live dot |
| `secondary` | Chrome and cards |
| `background`, `text` | The player's own colours. A text colour that would be hard to read is replaced. |
| `radius` | Corners, 0 to 28 px |
| `font` | A font your page loads |
| `logoUrl`, `logoPosition` | Your logo: top left, top right, bottom right, or hidden |
| `upNextSeconds`, `autoAdvance` | When the up-next card appears, and whether the next item plays by itself |
| `controls` | Which controls show: title, 10-second buttons, volume, quality, subtitles, audio, start over, schedule, up next, recently played, picture in picture, full screen, Chromecast, AirPlay |

Text on a colour is always black or white, whichever reads better. "Use account branding" fills the colours and logo from **Admin > Account settings**.

## Custom skins

A custom skin is a `mount` and an `update`. It is given state and commands, never the stream itself.

```html file=player/custom-skin.html
```

`VoltPlayer.kit` has the building blocks the built-in skins use: icons, buttons with tooltips, menus, sliders, auto-hide and time formatting. Pass `demo: { ... }` to render any state with no stream, which is handy while you design a skin.

## Playback reporting and DRM

```html file=player/drm-and-reporting.html
```

- **`drm`**: `servers` maps each key system to its licence server address (`com.widevine.alpha`, `com.microsoft.playready`, `org.w3.clearkey`), and `headers` are sent with every licence request. The player picks the system the device supports. FairPlay on Apple devices is not offered yet: Safari plays with its own player, without these settings.
- **`cmcd`**: the player reports what the viewer saw in the CMCD v2 standard, on by default whenever there is an app key: a `CMCD` argument on every playlist and segment request (so the CDN logs carry it), and batched reports to Volt from the moment the play gate is asked. `app` and `appVersion` name your app in the reports; `false` turns reporting off. Read the results in **Analytics > Playback** or through the [QoE API](../api/playback-reporting.md).
- The player's `sessionId` is this play attempt's id. The play gate, the viewer reports and the CDN logs all carry it, so one viewer's problem can be followed from end to end.

## Journey to play

With `VoltJourney` your app also tells Volt how the viewer got to the play button: the app opened, the screens on the way, the title picked and where from, a paywall. **Analytics > Playback** then shows where viewers give up between opening the app and the first frame, and which rows, searches, links and notifications lead to watching. It is a fixed set of about ten events, not a page analytics tool, so it sits beside Google Analytics or yours rather than replacing it.

```html file=player/journey.html
```

- **Screens** come from the browser's address by themselves, single-page apps included, named by `routes` (`:id` is the title's id) or by the path. A router that does not change the address calls `journey.screen('detail', { type: 'detail', contentId })`.
- **`select(contentId, { entry, position })`** starts a journey. `entry` is `row:<row name>`, `search`, `continue`, `epg`, `related`, `deeplink` or `push`. A page opened from a link or a push notification starts one by itself.
- **The play.** Pass the journey to the player as `journey` and set `apiBase` to your Volt address, as for the player: each play then carries the journey and how many screens came before it, so every view in the reports knows where it came from.
- **`search(results, query)`** counts a search. The query is left out unless you set `searchQuery: 'hash'`, and then only a SHA-256 of it is sent. **`paywall(product)`** and **`purchase('success' | 'failed' | 'cancelled', product)`** mark the paywall. **`track(name, props)`** sends a custom event (up to 20 names per app session, ten short props each).
- **Privacy.** `consent: false` sends, keeps and forwards nothing until `setConsent(true)`; `setConsent(false)` stops again. No user ids, no advertising ids, no IP address. After 30 minutes in the background a new app session starts.

An app that does not use the SDK can send the same events itself: see [Journey to play](../api/playback-reporting.md#5-journey-to-play-how-viewers-got-to-the-play-button).

## Events: countdown, phases and paid access

The `event` skin follows the event through its life. Volt decides the phase. The player never guesses it from its own clock.

| Phase | When | The skin shows |
|---|---|---|
| `pre` | Before the start | A countdown, the start in the viewer's own time, and Add to calendar |
| `offline` | Past the start, not live yet | "Starting soon". The stream starts by itself. |
| `live` | Live, inside its public window | The video player |
| `postponed` | The event is postponed or rescheduled | Was and now, or "a new date will be announced" |
| `cancelled` | The event is cancelled | Said plainly, with no countdown |
| `ended` / `replay` | After the end, without or with a published replay | The closing message, or Watch the replay |

**Paid and members-only events.** When the event needs a pass, the skin lists the passes (name, what it covers, price in the viewer's currency) with **Buy**, at any phase, so viewers can buy before the start. **Buy** opens your checkout page (`purchaseUrl`, with `{productKey}`, `{assetId}`, `{price}` and `{currency}` filled in), or, without one, emits `purchase` so your page can run its own checkout. Once the viewer has bought or signed in, pass their Volt viewer session with `player.setViewerToken(token)` and the player checks again.

## Live: guide, up next and start over

The guide covers six hours back to 24 hours ahead and refreshes every few minutes. The programme shown is the one at the playhead, so a viewer three minutes behind live sees the change three minutes later.

**Start over** needs a catch-up (DVR) window that reaches back to the start of the programme. The button appears only when it does, so it never promises a beginning that is no longer available.

## Casting

- **Chromecast**: the TV is sent the stream and plays it itself. The receiver is Google's Default Media Receiver unless you set your own (`cast: { receiverAppId }`).
- **AirPlay**: uses Safari's picker.

Both are off on private share links, so a private preview stays on the device it was opened on.

## Troubleshooting

| You see | Usually | Do |
|---|---|---|
| "This site is not on the app's allowed origins" | The page's site is not on the app's list | Add it in **API Keys & Apps**, including staging sites |
| "This player key is not valid" | A revoked key, or a secret key pasted by mistake | Use the app's current `pk_live_...` key |
| `VoltPlayer is not defined` | Your code ran before the script loaded | Put your code after the `<script src>` tag, or wait for `volt-player-ready` |
| An `error` with `stage: 'autoplay-blocked'` | The browser blocked sound starting by itself | Start muted (`muted: true`) and let the viewer unmute |
| A protected stream fails at the licence | No licence server for the device's key system, or the server refused | Add the key system to `drm.servers`; check the licence server's own logs |
| **Journey to play** stays empty | The journey was made with `consent: false` and `setConsent(true)` was never called, or the app key is not a publishable key | Call `setConsent(true)` once the viewer agrees; use the app's `pk_live_...` key |
| `registerSkin` throws | The name is a built-in skin, or not 2 to 41 lowercase letters, digits, `-` or `_` | Pick another name |
