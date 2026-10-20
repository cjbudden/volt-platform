---
title: Player SDK
sidebar_position: 5
description: Create and control the Volt web player from code, with skins, themes, playlists, the programme guide, casting and paid events.
---

# Player SDK

The Volt player is the same player everywhere Volt plays: your websites and apps, share links and the console. This page is for developers who want to create and control it from code. For a no-code tag, see [embed the player](embedding.md).

## What it does

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

## Create a player

Load the script, then create a player in an element:

```html
<div id="player"></div>
<script src="https://your-volt-host/player/volt-player.js"></script>
<script>
  (async () => {
    const player = await VoltPlayer.VoltPlayer.create({
      el: '#player',
      appKey: 'pk_live_...',
      playlist: ['<asset id>', '<asset id>', 'https://cdn.example.com/promo/master.m3u8'],
      epg: { channelId: '<channel id>' },
      theme: { primary: '#e11d48', logoUrl: 'https://example.com/logo.png', upNextSeconds: 20 },
      skin: 'video',
      autoplay: true,
      muted: true,
    });

    player.on('itemchange', ({ index }) => console.log('now playing item', index));
    player.on('programmechange', (p) => console.log('programme', p));
  })();
</script>
```

### Options

Everything is optional except `el`:

`skin`, `theme`, `apiBase`, `appKey`, `source`, `item`, `playlist`, `startIndex`, `assetId`, `epg`, `stationId`, `autoplay`, `muted`, `poster`, `watermark`, `startAt`, `requestHeaders`, `beacons`, `cast` (`false`, or `{ receiverAppId }`), `airplay`, `media`, `strings` (your own translations), `demo`, `onEvent`, and for events `eventId`, `viewerToken`, `purchaseUrl` and `signInUrl`.

### Events

`state`, `ready`, `play`, `pause`, `ended`, `error`, `itemchange`, `programmechange`, `upnext`, `qualitychange`, `castchange`, `presentationchange`, `locked`, `purchase`, `signin`.

A tag embed dispatches `volt-player-ready` on the page, with the player in `event.detail`, so you can listen without creating the player yourself.

### Commands

`play`, `pause`, `toggle`, `seek`, `seekBy`, `goLive`, `startOver`, `setQuality`, `setTextTrack`, `setAudioTrack`, `setVolume`, `toggleMute`, `setRate`, `next`, `previous`, `playItem`, `cancelUpNext`, `toggleFullscreen`, `togglePip`, `cast`, `airplay`, `purchase`, `signIn`, `playReplay`, `refreshAccess`, and `setTheme`, `setViewerToken`.

```js
player.next();
player.seek(120);
player.setTheme({ radius: 0 });
```

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

```js
VoltPlayer.registerSkin('acme', () => ({
  mount(ctx) {
    // Build your DOM in ctx.root, place ctx.stage (the picture), wire up ctx.commands
  },
  update(state) {
    // Change only what changed
  },
}));

VoltPlayer.VoltPlayer.create({ el: '#p', skin: 'acme', appKey: 'pk_live_...', assetId: '<asset id>' });
```

`VoltPlayer.kit` has the building blocks the built-in skins use: icons, buttons with tooltips, menus, sliders, auto-hide and time formatting. Pass `demo: { ... }` to render any state with no stream, which is handy while you design a skin.

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
