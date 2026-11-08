---
title: Player SDK for iOS
sidebar_label: Player SDK for iOS
description: Put Volt channels, events, radio and on-demand titles in an iPhone or iPad app, with the same skins and themes as the web player.
---

# Player SDK for iOS

The Volt player for iPhone and iPad apps. It plays channels, events, radio stations and on-demand titles. It uses the same skins, themes, translations and player events as the [web player](./player-sdk.md), so a theme saved in Player setup looks the same on a website and in an app.

:::caution Preview
The iOS SDK is at version 0.1, a preview. The shared rules are tested against the same cases as the web player. The player and its skins have not yet been run on a device. Try it in a test app before you ship it. The full list of what it needs is in [iOS requirements](./player-sdk-ios-requirements.md).
:::

## Before you start

- **An app of type iOS in Volt.** Go to **API Keys & Apps**, choose **New app**, set the type to **iOS**, and create a publishable key for it. Don't use a key from a web app: a web key works only on the website addresses it lists, and an app has none.
- **Xcode 16 or later**, and an app that supports iOS 15 or later.
- **Something to play:** the id of a channel, event, radio station or on-demand title. It's on the item's page in Volt, in **Share** and **Embed player**.

## Step 1: Add the package

1. In Xcode, choose **File > Add Package Dependencies**.
2. Enter the Volt iOS SDK address your Volt contact gave you, or choose **Add Local** and pick the `volt-player-ios` folder.
3. Add the **VoltPlayer** library to your app's target.

## Step 2: Play a channel

```swift
import SwiftUI
import VoltPlayer

struct ChannelScreen: View {
    @StateObject var player: VoltPlayer = {
        var o = VoltPlayerOptions(apiBase: URL(string: "https://volt.example.com")!, appKey: "pk_live_...")
        o.assetId = "CHANNEL_ID"
        o.epgChannelId = "CHANNEL_ID"   // the guide: programme on air, Up next, Start over
        return VoltPlayer(o)
    }()

    var body: some View {
        VoltPlayerView(player: player)
            .aspectRatio(16 / 9, contentMode: .fit)
            .onDisappear { player.destroy() }
    }
}
```

Call `destroy()` when the screen closes. It ends the viewer's session for Analytics and stops polling.

## Step 3: Choose what to play

| Option | What it plays |
|---|---|
| `assetId` | A channel, event or on-demand title. Volt checks the viewer's country, rights and access first, as it does for the web player |
| `eventId` | An event through its whole life: countdown, Buy, live, then the replay. Uses the `event` skin |
| `stationId` | A radio station with its own Player setup theme, now playing and the last five tracks. Uses the `audio_nowplaying` skin |
| `playlist` | A list of ids or addresses, with Up next and auto-play |
| `source` | An HLS, MP3 or MP4 address you already have |

## Step 4: Skins and themes

The built-in skins are the same as on the web: `video`, `event`, `audio_square`, `audio_nowplaying` and `audio_radio`. On iOS, `audio_wave` shows as `audio_nowplaying`, because iOS gives no sound levels for HLS streams.

```swift
o.skin = "audio_square"
o.theme = Theme(primary: "#e11d48", radius: 8, controls: ["speed": true])
o.strings = ["live": "EN DIRECT"]
```

The theme settings have the same names as on the web: colours, corners, font, logo, when Up next appears, and which controls show. Text always stays readable: a text colour without enough contrast is replaced with black or white.

To build your own skin, write a SwiftUI view that takes the player's state and commands:

```swift
VoltPlayerView(player: player) { ctx in
    ZStack(alignment: .bottomLeading) {
        ctx.picture
        Text(ctx.state.programme?.title ?? "").padding()
    }
}
```

Use the kit's parts (`Scrubber`, `LiveBadge`, `UpNextCard`, `SkipButton`, `ChoiceMenu`, `RoutePickerButton`) and the theme's colours (`@Environment(\.voltStyle)`), so your skin follows Player setup. Set `o.demo` to any state to design a skin without a stream.

## Step 5: Paid events and sign in

When an event needs a pass, the `event` skin lists the passes with Buy. Either:

- set `purchaseUrl` (and `signInUrl`) to your own pages. `{productKey}`, `{assetId}`, `{price}` and `{currency}` are filled in, or
- handle the `.purchase` and `.signin` events in `onEvent` and run your own checkout. Apple requires in-app purchase for digital content sold in an app.

After a purchase or sign in, call `player.setViewerToken(token)`. Volt checks the viewer's access again and the event plays.

## Step 6: Background audio, AirPlay and picture in picture

In your app target's **Signing & Capabilities**, add **Background Modes** and tick **Audio, AirPlay, and Picture in Picture**. Radio then keeps playing with the screen locked, and the lock screen shows the station and the song with play and pause. AirPlay and picture in picture buttons appear in the skin when they can be used.

## What works on iOS

| Feature | iOS |
|---|---|
| Channels, events, radio, on demand | Yes |
| Guide, now and next, Up next, Start over, Go live, seek in the live window | Yes |
| Programme details carried in the stream, ad breaks, Skip intro and credits | Yes |
| Subtitles and audio languages | Yes |
| Quality menu | Partly: a choice is a ceiling, and the best stream at or under it plays |
| AirPlay, picture in picture, lock screen | Yes |
| Passes, sign in, region messages | Yes |
| Viewer reporting in Analytics | Yes |
| Server-side ads | Yes. Guided ads play, but the "Ad 1 of 2" label is not shown yet |
| FairPlay DRM | Written, not yet tested with a licence server |
| Chromecast | Not yet |
| Apple TV | Yes, with the `tv` skin (see Step 7) |

## Step 7: Apple TV

The same package plays on Apple TV (tvOS 15 or later). A channel or on-demand title gets the `tv` skin, an event the `event` skin, and a radio station a large-screen audio layout. Use the same kind of key: a publishable key of an app of type **iOS**.

By default the `tv` skin uses the Apple TV system player, so the Siri Remote works the way viewers expect: scrubbing with previews, swipe down for subtitles, audio and the programme's details, Menu to go back. Volt adds **Schedule**, **Start over**, **Go live** and **Quality** to its bar, and **Skip intro** and **Up next** buttons over the picture. To use Volt's own controls in your theme instead, set `o.tvControls = .volt`.

Two theme settings matter most on a TV: `focusColor`, the ring around the focused button, and `seekStep`, how far left and right on the remote jump (10, 15 or 30 seconds).

On Apple TV, **Buy** and **Sign in** always come to your app as events: a TV has no browser. Take the viewer through your in-app purchase, or show a code to confirm on a phone, then call `setViewerToken`.

## Troubleshooting

| What you see | Why, and what to do |
|---|---|
| "This player key is not valid." | The key is wrong or revoked. Create a key for the iOS app in API Keys & Apps |
| "This player is not allowed here." | The key belongs to a web app. Use a key from an app of type iOS |
| "This is not available in your region." | The title's geo rules block the viewer's country. See [Securing a live stream](../workflows/secure-live-stream.md) |
| Radio stops when the phone locks | Background Modes > Audio is not ticked in the app target |
| No Start over button | The channel has no guide loaded (`epgChannelId`), or its live window does not reach the programme's start |
