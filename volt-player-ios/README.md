# Volt player SDK for iOS and Apple TV

The Volt player for iPhone, iPad and Apple TV apps: AVPlayer underneath, SwiftUI skins on top. It has the same state, commands, theme tokens, skins and strings as the web player SDK (`volt-player`). A theme saved in Player setup therefore looks the same in a browser and in an app, and a support answer is the same on both.

**Status: 0.1.0, preview.** The shared core is built and tested: 41 tests, the same cases and answers as the web SDK's own checks, plus the Apple TV rules. The AVPlayer engine, the skins and the Apple TV skin are written but have **not yet been built in Xcode or run on a device**. The first job on a Mac is to open the package in Xcode and run the two demo apps (iPhone and Apple TV).

## Requirements

| | |
|---|---|
| iOS / iPadOS | 15 or later |
| tvOS | 15 or later (see [Apple TV](#apple-tv)) |
| Xcode | 16 or later (Swift 5.9 package, iOS 18 SDK) |
| Volt app key | A **publishable key of an app of type iOS** (Volt > API Keys & Apps > New app > iOS). For an Apple TV app, register an app of **type TV** and use its key, so reports count TV viewing apart and rights that differ by app type apply. Not a web key: a web key is tied to website addresses, and an app sends none |
| Capabilities (in the app's target) | Background Modes > **Audio, AirPlay, and Picture in Picture** for radio in the background and for picture in picture |
| Chromecast | Not in this release (reported as unavailable) |
| FairPlay | A FairPlay certificate and licence server, from your DRM provider |

## Add it to an app

Xcode > File > Add Package Dependencies. Use the repository address, or Add Local and choose the `volt-player-ios` folder. Add the **VoltPlayer** library to the app target.

```swift
import SwiftUI
import VoltPlayer

struct ChannelScreen: View {
    @StateObject var player: VoltPlayer = {
        var o = VoltPlayerOptions(apiBase: URL(string: "https://volt.example.com")!, appKey: "pk_live_...")
        o.assetId = "c6ffb359-4ce7-4e79-9817-778f69d418ba"      // a channel, event or on-demand asset
        o.epgChannelId = "c6ffb359-4ce7-4e79-9817-778f69d418ba" // its guide, for now and next
        return VoltPlayer(o)
    }()

    var body: some View {
        VoltPlayerView(player: player)
            .aspectRatio(16 / 9, contentMode: .fit)
            .onDisappear { player.destroy() }
    }
}
```

Always call `destroy()` when the screen goes away. It ends the viewer session for Analytics and stops polling.

## What to play

| Option | Plays |
|---|---|
| `assetId` | A channel, event or on-demand asset, through the play gate (country, rights, paywall, playback token) |
| `eventId` | An event: countdown, phases, promo, paywall, then live, then the replay. The skin is `event` by default |
| `stationId` | A radio station: its saved Player setup (theme), its stream, and now playing plus the last five tracks every 15 s. The skin is `audio_nowplaying` by default |
| `playlist` | Items, asset ids or URLs, with Up next and auto-advance |
| `source` / `item` | A URL you already have (HLS, MP3, MP4) |
| `epgChannelId` / `epg` | The guide, for Start over, Up next and the programme on air |

## Skins and themes

Built-in skins: `video`, `tv`, `event`, `audio_square`, `audio_nowplaying`, `audio_radio`. `audio_wave` falls back to `audio_nowplaying`: AVPlayer gives no audio levels for HLS, and the waveform shows real levels or nothing. `tv` is for Apple TV; on iPhone and iPad it draws as `video`. On Apple TV every built-in name has a ten-foot layout (see [Apple TV](#apple-tv)).

```swift
o.skin = "audio_square"
o.theme = Theme(primary: "#e11d48", secondary: "#101418", radius: 8, controls: ["speed": true, "cast": false])
o.strings = ["live": "EN DIRECT", "goLive": "Retour au direct"]
```

The theme tokens are the same as on the web (`primary`, `secondary`, `background`, `text`, `radius`, `font`, `logoUrl`, `logoPosition`, `upNextSeconds`, `showGraphics`, `autoAdvance`, `controls`). Text always stays readable: a text colour below 3:1 contrast is replaced with black or white.

Two tokens from the proposed set are built here and in the Android SDK, with the same rules:

| Token | Rule |
|---|---|
| `focusColor` | The focus ring on TV. Kept only at 3:1 contrast on the background; otherwise the primary colour if that reads, otherwise black or white |
| `seekStep` | Seconds for the skip buttons and the remote's left and right: snapped to 10, 15 or 30 (a tie goes to the smaller), 10 when not set |

**Your own skin** is any SwiftUI view built from a `SkinContext` (state, commands, theme, translator, picture):

```swift
VoltPlayerView(player: player) { ctx in
    ZStack(alignment: .bottomLeading) {
        ctx.picture
        Text(ctx.state.programme?.title ?? "").padding()
        Button(ctx.state.playing ? "Pause" : "Play") { ctx.commands.toggle() }
    }
}
```

Or register it by name, so `options.skin = "acme"` uses it: `VoltSkins.register("acme") { ctx in AnyView(AcmeSkin(ctx: ctx)) }`. Build skins from the kit (`VoltIconButton`, `Scrubber`, `LiveBadge`, `UpNextCard`, `SkipButton`, `ChoiceMenu`, `RoutePickerButton`, `BrandMarkView`) and read colours from `@Environment(\.voltStyle)` so they follow the theme.

**Demo mode** draws any state with no stream, for designing a skin: `o.demo = somePlayerState`.

## Paid events and sign in

`purchaseUrl` and `signInUrl` are opened in the browser with `{productKey}`, `{assetId}`, `{price}` and `{currency}` filled in. Without them, the player emits `.purchase` / `.signin` through `onEvent` for the app's own checkout (for example StoreKit). After a purchase or sign in, call `player.setViewerToken(token)` and the play gate is asked again.

## Events

`onEvent` receives the same events as the web SDK: `ready`, `play`, `pause`, `ended`, `error`, `itemchange`, `programmechange`, `upnext`, `qualitychange`, `presentationchange`, `purchase`, `signin`, `locked`, `statschange`. The whole state is also `player.state` (`@Published`).

## Parity with the web SDK

| | iOS |
|---|---|
| HLS, MP3, MP4 | Yes (AVPlayer). DASH is not played on Apple devices; Volt always offers HLS |
| Play gate, playback token, paywall, sign in | Yes |
| Guide, now / next from the stream's own markers, Up next, Start over, Go live, DVR | Yes |
| In-stream graphics (EXT-X-DATERANGE), ad breaks, skip intro / credits | Yes |
| Programme key metadata (`programme.meta`) | Yes |
| Subtitles and audio languages | Yes |
| Quality menu | Partial: AVPlayer cannot pin one variant, so a choice is a ceiling (the best at or under it plays) |
| AirPlay, picture in picture, lock screen and Control Center | Yes |
| Chromecast | Not yet (needs the Google Cast SDK in the app) |
| Guided ads (HLS Interstitials) | Played by AVPlayer itself. The "Ad 1 of 2" overlay and click-through are not yet built |
| Stitched ads | Yes (server side, nothing to do in the player) |
| Viewer beacons | Yes. A video moved to the background ends its session; audio, picture in picture and AirPlay keep it |
| CMCD | Not yet |
| FairPlay | Written, not yet tried against a licence server |
| HTML graphics overlay (scorebugs from the console) | Not yet |
| Custom skins, demo mode, translations | Yes |
| tvOS | The `tv` skin with the Siri Remote, the guide panel and a ten-foot audio skin. See [Apple TV](#apple-tv) |

## Apple TV

The same package, the same `VoltPlayer` and `VoltPlayerView`. On Apple TV a channel or on-demand title gets the `tv` skin by default, an event the `event` skin (which hands over to `tv` when it goes live), and a station a ten-foot audio skin.

```swift
var o = VoltPlayerOptions(apiBase: URL(string: "https://volt.example.com")!, appKey: "pk_live_...")
o.assetId = channelId
o.epgChannelId = channelId          // the guide, for the guide panel and Start over
o.tvControls = .system              // or .volt
VoltPlayerView(player: VoltPlayer(o)).ignoresSafeArea()
```

### Two ways to draw the controls

**`.system` (the default)** hosts the system player, AVPlayerViewController, and adds Volt to it. This is the recommended choice, and the reason is the remote: viewers already know how the system player behaves on Apple TV, and it handles the Siri Remote better than any custom drawing can. Clickpad and touch-surface scrubbing with picture previews (from the I-frame playlists when the output profile has trick-play on), swipe down for the info panel, Menu to go back, and the accessibility features of the system player all come with it. Volt adds:

| Where | What |
|---|---|
| Transport bar | **Schedule** (opens Volt's guide panel), **Start over**, **Go live** when behind, **Quality** (a ceiling, as on iOS) |
| Contextual buttons | **Skip intro / recap / credits**, and **Up next** for the next playlist item |
| Info panel | The programme on air as the title, the channel as the subtitle, its description and artwork. Subtitles and audio languages are chosen here, the system way |
| During an ad break | Playback is linear: the transport bar cannot skip the break |
| Over the picture | The brand mark, the watermark, and a "Coming up" banner for the next programme. None of these take focus |

**`.volt`** draws Volt's own controls in the account's theme, for apps that want the same look as their other screens:

| Remote | What it does |
|---|---|
| Any press | Brings the controls up. They go away 5 s after the last press while playing |
| Left / right (controls hidden) | Seek back or forward by `seekStep` (10 s unless the theme says 15 or 30), inside what can be played |
| Up / down, or select (controls hidden) | Bring the controls up |
| Play/Pause | Play or pause, from anywhere |
| Menu | Hides the controls; when they are hidden, goes back |

The bar has Play, back and forward by the seek step, Start over, Go live, Schedule, previous and next for playlists, and Subtitles, Audio and Quality (each opens a list). Every button shows a focus ring in `focusColor`.

With either choice, Volt draws what the system player has no words for: the paywall and sign in, region messages, "not on air", errors, and demo mode.

### The guide panel

Schedule opens the guide over the picture. The programme on now has focus first. Earlier programmes that are still inside the live window play from their start (from the earliest part kept when the window has already passed their start). Later programmes are listed but there is nothing to play yet. Menu closes it. The rules are `TVRules.guideRows` in the core, tested.

### What is not on Apple TV

| Feature | On Apple TV |
|---|---|
| AirPlay sending, picture in picture, full screen toggle | Not offered: the state reports them unavailable. A TV is always full screen and receives AirPlay rather than sending it |
| Chromecast | Not offered |
| Buy and Sign in | Always passed to the app as `.purchase` and `.signin` events (a TV has no browser). Use StoreKit for purchases, and sign in with a code shown on screen and confirmed on a phone. Then call `setViewerToken` |
| Add to calendar on events | Not shown |
| Copy debug info | Not shown (no clipboard); the stats panel still opens |
| The touch skins (`video`, `audio_square`, `audio_radio`) | Drawn as `tv` and the TV audio skin |

Use the key of an app of type TV for an Apple TV app: the app's type is what reports and rights go by. (The `x-volt-platform` header the SDK sends is informational; the server does not read it.)

### Run the Apple TV demo

Create a tvOS App project in Xcode (SwiftUI, tvOS 15 or later), add this package (Add Local, the `volt-player-ios` folder), replace the app's file with `Examples/VoltPlayerTVDemo/VoltPlayerTVDemoApp.swift`, and set `VOLT_API` and `VOLT_KEY`. It has a channel (with each kind of controls), an event, a station, a public test stream, and the TV skin in demo mode in each state (live and behind, paywall, region block, not on air, event countdown, radio).

## Develop

```
swift test        # the core: runs on macOS or Linux
```

Every rule that is not AVFoundation plumbing lives in `VoltPlayerCore` (`Schedule`, `Derive`, `Triggers`, `EventRules`, `ThemeTokens`, `TVRules`, `VoltAPI`, `BeaconSession`) and is ported line for line from `volt-player/src/sdk`. `Tests/VoltPlayerCoreTests/ParityTests.swift` checks the web SDK's own cases. If one fails, iOS and the web disagree, so fix the code, not the test.

The demo apps are in `Examples/VoltPlayerDemo` (iPhone and iPad) and `Examples/VoltPlayerTVDemo` (Apple TV).
