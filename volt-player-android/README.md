# Volt player SDK for Android and Android TV

The Volt player for Android phone, tablet and TV apps (Android TV, Google TV, Fire TV): Media3 ExoPlayer underneath, Jetpack Compose skins on top. It has the same state, commands, theme tokens, skins and strings as the web player SDK (`volt-player`) and the Apple SDK (`volt-player-ios`). A theme saved in Player setup looks the same in a browser, on an iPhone and on an Android TV, and a support answer is the same everywhere.

**Status: 0.1.0, preview.** Everything compiles against the real libraries and the demo app builds:

- **Core:** 43 tests pass. They are the same cases and expected answers as the web SDK's own checks and the Apple SDK's, plus the TV rules.
- **Skins:** each one has been rendered to images and checked by eye.
- **Not yet done:** nothing has been played on a phone or a TV. The first job is to install the demo app on an Android TV or a phone and play the public test stream.

## Requirements

| | |
|---|---|
| Android | 7.0 (API 24) or later; Android TV, Google TV and Fire TV (Fire OS 6 or later) |
| Build | Android Studio Ladybug or later, AGP 8.7, Kotlin 2.1, compileSdk 35 |
| Libraries | Media3 1.5.1 (ExoPlayer, HLS, DASH, session, ui), Jetpack Compose (BOM 2024.12.01), Coil 2.7 |
| Volt app key | A **publishable key of an app of type Android** (Volt > API Keys & Apps > New app > Android). For a TV app, register an app of **type TV** and use its key, so reports count TV viewing apart and rights that differ by app type apply. Not a web key: a web key is tied to website addresses, and an app sends none |
| Picture in picture | `android:supportsPictureInPicture="true"` and the `configChanges` in the demo's manifest, on the Activity that shows the player |
| Background audio | Nothing to add: the SDK's manifest declares the playback service and its permissions. Turn on `backgroundPlayback` |
| Chromecast | Not in this release (reported as unavailable) |
| Widevine | A licence server URL from your DRM provider |

## Add it to an app

Until it is published to a Maven repository, include this build in your app's `settings.gradle.kts`:

```kotlin
includeBuild("../volt-player-android")
```

and depend on the player in the app module (Gradle substitutes the included project):

```kotlin
implementation("com.volt.player:player:0.1.0")
```

```kotlin
@Composable
fun ChannelScreen() {
    val context = LocalContext.current
    val player = remember {
        VoltPlayer(context, VoltPlayerOptions(
            apiBase = "https://volt.example.com",
            appKey = "pk_live_...",
            assetId = "c6ffb359-4ce7-4e79-9817-778f69d418ba",      // a channel, event or on-demand asset
            epgChannelId = "c6ffb359-4ce7-4e79-9817-778f69d418ba", // its guide, for now and next
        ))
    }
    DisposableEffect(player) { onDispose { player.destroy() } }
    VoltPlayerView(player, Modifier.fillMaxWidth().aspectRatio(16 / 9f))
}
```

Always call `destroy()` when the screen goes away. It ends the viewer session for Analytics, stops polling and releases the ExoPlayer. Create, command and destroy the player on the main thread.

## What to play

| Option | Plays |
|---|---|
| `assetId` | A channel, event or on-demand asset, through the play gate (country, rights, paywall, playback token) |
| `eventId` | An event: countdown, phases, promo, paywall, then live, then the replay. The skin is `event` by default |
| `stationId` | A radio station: its saved Player setup (theme), its stream, and now playing plus the last five tracks every 15 s. The skin is `audio_nowplaying` by default |
| `playlist` | Items, asset ids or URLs (`Schedule.Entry.Str`, `Schedule.Entry.Item`), with Up next and auto-advance |
| `source` / `item` | A URL you already have (HLS, DASH, MP3, MP4) |
| `epgChannelId` / `epg` | The guide, for Start over, Up next and the programme on air |

HLS is played when a source has it, DASH otherwise. The stream's programme markers, Up next, ad breaks and Skip intro are EXT-X-DATERANGE tags in the HLS playlists, so a DASH copy of the same CMAF would play without them.

## Skins and themes

Built-in skins: `video`, `tv`, `event`, `audio_square`, `audio_nowplaying`, `audio_radio`. `audio_wave` and `audio_radio` draw as `audio_nowplaying`: the waveform shows real levels or nothing, and Android gives none for a stream. On a TV, `video` draws as `tv`; on a phone, `tv` draws as `video`.

```kotlin
VoltPlayerOptions(
    skin = "audio_square",
    theme = Theme(primary = "#e11d48", secondary = "#101418", radius = 8.0, controls = mapOf("speed" to true, "cast" to false)),
    strings = mapOf("live" to "EN DIRECT", "goLive" to "Retour au direct"),
)
```

The theme tokens are the same as on the web (`primary`, `secondary`, `background`, `text`, `radius`, `font`, `logoUrl`, `logoPosition`, `upNextSeconds`, `showGraphics`, `autoAdvance`, `controls`), plus two for TVs: `focusColor` (the focus ring, kept at 3:1 on the background, else the primary, else black or white) and `seekStep` (10, 15 or 30 s for the skip buttons and the remote's left and right). Text always stays readable: a text colour below 3:1 contrast is replaced with black or white. `font` is not applied on Android: the skins use the app's own type.

**Your own skin** is any composable given a `SkinContext` (state, commands, theme, translator, picture):

```kotlin
VoltPlayerView(player) { ctx ->
    Box(Modifier.fillMaxSize()) {
        ctx.picture()
        Text(ctx.state.programme?.title ?: "", Modifier.align(Alignment.TopStart).padding(16.dp))
        Button(onClick = { ctx.commands.toggle() }) { Text(if (ctx.state.playing) "Pause" else "Play") }
    }
}
```

Or register it by name, so `skin = "acme"` uses it: `VoltSkins.register("acme") { ctx -> AcmeSkin(ctx) }`. Build skins from the kit (`VoltIconButton`, `VoltPillButton`, `Scrubber`, `LiveBadge`, `UpNextCard`, `SkipButton`, `ChoiceMenu`, `LockedPanel`, `BrandMarkView`) and read colours from `LocalVoltStyle.current`, so they follow the theme. Every kit control has a focus ring for D-pads and keyboards.

**Demo mode** draws any state with no stream, for designing a skin: `VoltPlayerOptions(demo = somePlayerState)`.

## Android TV, Google TV and Fire TV

The same library. On a TV (detected from the UI mode, the leanback feature or Fire TV hardware) a channel or on-demand title gets the `tv` skin, an event the `event` skin (which hands over to `tv` when it goes live), and a station the now-playing skin at ten-foot size.

With the controls hidden the picture is everything:

| Remote | Does |
|---|---|
| OK | Play or pause; Skip intro when it is offered |
| Left / right | Back or forward by the theme's `seekStep` (10 s by default), inside what can be played |
| Up | Show the controls |
| Down | Open the guide (live channels with a schedule), else show the controls |
| Play/pause, rewind, fast forward | Work at any time |
| Back | Closes the guide, then hides the controls, then leaves |

With the controls shown, the D-pad moves between them with a focus ring in the theme's focus colour. They hide 5 s after the last press while playing, never while the guide or a menu is open.

The guide lists what is on now, what can still be watched from its start (it is inside the DVR window) and what is later. Choosing an earlier programme plays it from its start. These rules (`TvRules` in the core) are the same on Apple TV.

Not on a TV: picture in picture, full screen (a TV player is always full screen), Add to calendar.

## Paid events and sign in

`purchaseUrl` and `signInUrl` are opened in the browser with `{productKey}`, `{assetId}`, `{price}` and `{currency}` filled in. Without them the player emits `Purchase` / `SignIn` through `onEvent` for the app's own checkout (Google Play Billing; app stores require their own payment for digital content). After a purchase or sign in, call `player.setViewerToken(token)` and the play gate is asked again.

## Background audio, the lock screen and picture in picture

- **Background audio:** `backgroundPlayback = true` keeps radio and audio playing with the screen off. It shows the system media notification and lock screen controls, and holds a network wake lock while playing. Keep that `VoltPlayer` in a ViewModel or the Application so it outlives the screen. Without it, a video pauses when the app goes to the background.
- **Audio focus:** the player pauses for a call, ducks for a navigation prompt and stops when another app starts playing.
- **Picture in picture:** on Android 12 and later, going Home while a video plays enters picture in picture by itself. Turn this off with `autoPictureInPicture = false`. The picture in picture button works on Android 8 and later.

## Concurrent streams

A title or channel whose publishing rule sets **Concurrent streams** limits how many plays one signed-in viewer may have open at once; over the limit the viewer's oldest play is stopped (see the play gate guide). The web player stops and shows the message itself. This SDK does not yet act on the server's `stop` answer to its viewer reports: for an on-demand title the CDN refuses the stopped play's addresses within about a minute, so the play ends as an `error`; a live channel plays on until the app asks the play gate again. Ask the gate again with a new play (a new `sid`) when the viewer wants to watch here.

## Events

`onEvent` receives the same events as the web SDK: `ready`, `play`, `pause`, `ended`, `error`, `itemchange`, `programmechange`, `upnext`, `qualitychange`, `presentationchange`, `purchase`, `signin`, `locked`, `statschange`, `skinchange`. The whole state is also `player.state` (a `StateFlow`).

## Parity with the web SDK

| | Android |
|---|---|
| HLS, DASH, MP3, MP4 | Yes (Media3). HLS first when a source has both |
| Play gate, playback token, paywall, sign in | Yes |
| Guide, now / next from the stream's own markers, Up next, Start over, Go live, DVR | Yes |
| In-stream graphics (EXT-X-DATERANGE), ad breaks, skip intro / credits | Yes, from the HLS playlists |
| Subtitles (the viewer's language remembered) and audio languages | Yes |
| Quality menu | Yes, and a choice pins that rendition, as on the web (iOS can only set a ceiling) |
| Picture in picture, background audio, lock screen, headset and Bluetooth buttons | Yes |
| Chromecast | Not yet (needs the Cast framework in the app) |
| Guided ads (HLS Interstitials) | Not claimed: the gate stitches ads for Android instead. The ad overlay is not yet built |
| Stitched ads | Yes (server side, nothing to do in the player) |
| Viewer beacons | Yes. A video in the background ends its session; audio and picture in picture keep it |
| CMCD | Yes: Media3's CMCD (version 1 keys) in query mode, with the play attempt's id as the session, so the gate, the beacons and the CDN logs join |
| Widevine | Written (`widevine = WidevineConfig(licenseUrl, headers)`), not yet tried against a licence server |
| HTML graphics overlay (scorebugs from the console) | Not yet |
| Custom skins, demo mode, translations | Yes |
| Android TV, Google TV, Fire TV | The `tv` skin with D-pad and remote, the guide panel, ten-foot audio |

## Develop

```
./gradlew :core:test                 # the rules: runs on any JVM, 43 tests
./gradlew :demo:assembleDebug        # the demo app for phones and TVs
./gradlew :player:recordPaparazziDebug   # screenshots of every skin, in player/src/test/snapshots/images
```

Every rule that is not Media3 plumbing lives in `:core` (`Schedule`, `Derive`, `Triggers`, `EventRules`, `ThemeTokens`, `TvRules`, `VoltApi`, `BeaconSession`). It is ported line for line from `volt-player/src/sdk`, by way of the Swift core. `core/src/test/.../ParityTests.kt` checks the web SDK's own cases. If one fails, Android and the web disagree, so fix the code, not the test.

The demo app is in `demo/`. Set `volt.apiBase`, `volt.appKey`, `volt.channelId`, `volt.eventId` and `volt.stationId` in `local.properties` (never committed) for the channel, event and station screens. The public test stream and the skins in demo mode work without them. It installs on phones and TVs (it has a TV banner and launcher entry).
