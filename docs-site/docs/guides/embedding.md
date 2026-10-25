---
title: Embed the player
sidebar_position: 4
description: Put a Volt channel, event or station on your own website with one tag.
---

# Embed the player

You can put any channel, event, on-demand asset or radio station on your own website with one `<div>` and one `<script>`. There is no build step and no JavaScript to write. For full control from code, see the [player SDK](player-sdk.md).

## Get the snippet from the console

The quickest way is to let Volt write the tag for you:

- **Channels**: open the channel and choose **Embed player** (the icon next to Share).
- **Events**: open the event and choose the player icon (**Embed player: countdown, Buy when paid, then the live player**), or **Settings**, then **Player**.
- **Radio stations**: use the station's **Player** setup page, which offers the audio skins.

The embed builder lets you choose the skin, the app and its key (or create a key for this embed), your account branding or a colour, corners, autoplay, the schedule and start-over buttons, Chromecast, AirPlay, the checkout and sign-in pages for paid events, and the width. The preview is the real player in demo mode. For events you can preview each phase: countdown, paid, postponed, live and replay.

The tag carries its own settings, so nothing is saved in Volt and two sites can embed the same event differently.

## The tag

```html
<div data-volt-player
     data-app-key="pk_live_..."
     data-asset-id="<channel, event or VOD id>"
     data-skin="video"
     data-primary-color="#e11d48"></div>

<script src="https://your-volt-host/player/volt-player.js"></script>
```

The script takes the API address from where it was served, so there is nothing else to configure.

The key is a **publishable** key (`pk_live_...`). It is meant to be public: it works only on the domains you allow for its app, and it cannot change anything. Never paste a secret key (`sk_live_...`) into a page.

### Attributes

| Attribute | Value |
|---|---|
| `data-app-key` | Your app's publishable key. Required. |
| `data-asset-id` | A channel, event or on-demand asset id |
| `data-skin` | `video`, `event`, `audio_square`, `audio_wave`, `audio_nowplaying` or `audio_radio`. See the [player SDK](player-sdk.md#skins). |
| `data-primary-color` | Your brand colour for buttons, progress and the live dot |
| `data-event-id` | An event, for the `event` skin |
| `data-purchase-url`, `data-sign-in-url` | Your checkout and sign-in pages, for paid or members-only events |
| `data-playlist` | Several ids, separated by commas |
| `data-src` | A manifest URL to play directly |
| `data-epg-channel` | A channel id whose programme guide to show |
| `data-station-id` | A radio station, for now-playing information |
| `data-theme` | Theme settings as JSON, for example `'{"radius":4,"logoUrl":"https://example.com/logo.png"}'` |
| `data-logo`, `data-poster` | A logo, and an image shown before the first frame |
| `data-autoplay`, `data-muted` | Start by itself, start muted |

A station embed made before the SDK skins existed (`data-channel-id` only) still works and follows the station's saved player setup.

## Allow your domains first

A publishable key works only on the domains listed against its app. Add yours in **API Keys and Apps** before you paste the snippet, including any staging domain. If you forget, the player says so plainly:

> This site is not on the app's allowed origins. Add its domain in API Keys & Apps.

## More than one player on a page

Every `[data-volt-player]` on the page is mounted once when the page loads. If your page adds players later (in a tab, a modal or an infinite scroll), call `VoltPlayer.scan()` and the new ones mount. Existing players are never mounted twice, so calling it again is safe.

```html
<script>
  document.querySelector('#tab-2').addEventListener('shown', () => {
    window.VoltPlayer.scan();
  });
</script>
```

## Autoplay

Browsers block sound that starts by itself. If you ask for autoplay and the browser refuses, the player reports an `error` with `stage: 'autoplay-blocked'` and waits for a click. That is the correct behaviour, not a fault. If something must start on its own, start it muted (`data-muted`) and let the viewer unmute.

## Player events

The player reports what happens to it, in your own code (`onEvent`, see the [player SDK](player-sdk.md)) and in your Volt reports, with the same names:

| Event | Means |
|---|---|
| `player.load` | The player script started |
| `player.ready` | A source was chosen and attached |
| `manifest.ok` / `manifest.error` | The stream's manifest loaded, or did not |
| `play`, `pause`, `stop` | Playback |
| `stall`, `recover` | Buffering started and ended |
| `error` | Something failed. `stage` says where. |

## When something is wrong

| You see | Usually |
|---|---|
| Nothing renders | The `<script>` is above the `<div>`, or the `<div>` has no `data-app-key` |
| "This site is not on the app's allowed origins" | Your domain is not on the app's list |
| "This player key is not valid" | A secret key (`sk_live_...`) was pasted instead of the publishable key, or the key was revoked |
| Plays on one of your sites but not another | Check the allowed domains for the second site |
| Sound does not start | Autoplay was blocked. Start muted. |
