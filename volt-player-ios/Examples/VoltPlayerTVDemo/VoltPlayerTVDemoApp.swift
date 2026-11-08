// ============================================================================
//  A DEMO APP for the Volt player SDK on Apple TV.
//
//  Create a new tvOS App project in Xcode (SwiftUI, tvOS 15+), add this
//  package (File > Add Package Dependencies > Add Local... and pick
//  volt-player-ios), replace the app's files with this one, and set VOLT_API
//  and VOLT_KEY below to your Volt address and the publishable key of an app
//  of type iOS (Apple TV apps use the same key type).
//
//  Background audio for radio: Signing & Capabilities > Background Modes >
//  Audio, AirPlay, and Picture in Picture.
//
//  Every screen plays full screen. Menu on the remote goes back.
// ============================================================================
import SwiftUI
import VoltPlayer

let VOLT_API = URL(string: "https://volt.example.com")!
let VOLT_KEY = "pk_live_replace_me"

@main
struct VoltPlayerTVDemoApp: App {
    var body: some Scene { WindowGroup { DemoList() } }
}

struct DemoList: View {
    @State private var channelId = ""
    @State private var eventId = ""
    @State private var stationId = ""

    var body: some View {
        NavigationView {
            Form {
                Section("A live channel (tv skin: guide, start over, go live)") {
                    TextField("Channel id", text: $channelId)
                    NavigationLink("Play with the system controls") { ChannelScreen(id: channelId, controls: .system) }.disabled(channelId.isEmpty)
                    NavigationLink("Play with Volt's controls") { ChannelScreen(id: channelId, controls: .volt) }.disabled(channelId.isEmpty)
                }
                Section("An event (countdown, paywall, live, replay)") {
                    TextField("Event id", text: $eventId)
                    NavigationLink("Open") { EventScreen(id: eventId) }.disabled(eventId.isEmpty)
                }
                Section("A radio station (now playing, last tracks)") {
                    TextField("Station id", text: $stationId)
                    NavigationLink("Listen") { StationScreen(id: stationId) }.disabled(stationId.isEmpty)
                }
                Section("No server needed") {
                    NavigationLink("A public test stream, system controls") { UrlScreen(controls: .system) }
                    NavigationLink("A public test stream, Volt's controls") { UrlScreen(controls: .volt) }
                    ForEach(DemoState.allCases, id: \.self) { d in
                        NavigationLink("Demo mode: \(d.rawValue)") { DemoScreen(demo: d) }
                    }
                }
            }
            .navigationTitle("Volt player")
        }
    }
}

/// A full-screen player that lets go of the stream when the screen goes away. Not while something
/// the player itself shows is over it (the same guard as the iPhone demo's full screen).
struct FullScreenPlayer: View {
    @ObservedObject var player: VoltPlayer
    var body: some View {
        VoltPlayerView(player: player)
            .ignoresSafeArea()
            .onDisappear { if !player.state.fullscreen { player.destroy() } }
    }
}

struct ChannelScreen: View {
    @StateObject var player: VoltPlayer
    init(id: String, controls: VoltPlayerOptions.TVControls) {
        var o = VoltPlayerOptions(apiBase: VOLT_API, appKey: VOLT_KEY)
        o.assetId = id
        o.epgChannelId = id
        o.tvControls = controls
        o.onEvent = { name, detail in print("volt:", name.rawValue, detail ?? "") }
        _player = StateObject(wrappedValue: VoltPlayer(o))
    }
    var body: some View { FullScreenPlayer(player: player) }
}

struct EventScreen: View {
    @StateObject var player: VoltPlayer
    init(id: String) {
        var o = VoltPlayerOptions(apiBase: VOLT_API, appKey: VOLT_KEY)
        o.eventId = id
        // A TV has no browser: Buy and Sign in arrive here, for the app's own checkout or sign-in code.
        o.onEvent = { name, detail in
            if name == .purchase || name == .signin { print("volt: the app takes over:", name.rawValue, detail ?? "") }
        }
        _player = StateObject(wrappedValue: VoltPlayer(o))
    }
    var body: some View { FullScreenPlayer(player: player) }
}

struct StationScreen: View {
    @StateObject var player: VoltPlayer
    init(id: String) {
        var o = VoltPlayerOptions(apiBase: VOLT_API, appKey: VOLT_KEY)
        o.stationId = id
        _player = StateObject(wrappedValue: VoltPlayer(o))
    }
    var body: some View { FullScreenPlayer(player: player) }
}

struct UrlScreen: View {
    @StateObject var player: VoltPlayer
    init(controls: VoltPlayerOptions.TVControls) {
        var o = VoltPlayerOptions()
        o.source = Source(hls: "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8")
        o.item = PlaylistItem(id: "bipbop", title: "Test stream", subtitle: "Apple's HLS example",
                              source: Source(hls: "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8"))
        o.theme = Theme(primary: "#e11d48", radius: 8, focusColor: "#ffd60a", seekStep: 15)
        o.tvControls = controls
        _player = StateObject(wrappedValue: VoltPlayer(o))
    }
    var body: some View { FullScreenPlayer(player: player) }
}

/// The states a TV skin is designed and checked against, with no stream.
enum DemoState: String, CaseIterable {
    case live = "live channel, behind live"
    case paywall = "paywall"
    case region = "region blocked"
    case offline = "not on air"
    case countdown = "event countdown"
    case radio = "radio station"

    var skin: String {
        switch self {
        case .countdown: return "event"
        case .radio: return "audio_nowplaying"
        default: return "tv"
        }
    }

    func state() -> PlayerState {
        var s = PlayerState()
        let now = Date().timeIntervalSince1970 * 1000
        s.status = .paused; s.live = true; s.dvr = true; s.atLiveEdge = false; s.behindLive = 42
        s.seekable = SeekWindow(start: 0, end: 3600); s.currentTime = 3558
        s.wallClock = now - 42_000
        s.item = PlaylistItem(id: "demo", title: "News 24", live: true)
        s.programme = Programme(id: "p1", title: "The Morning Show", subtitle: "News, weather and guests", startsAt: now - 1_800_000, endsAt: now + 1_800_000)
        s.nextProgramme = Programme(id: "p2", title: "Midday Report", startsAt: now + 1_800_000, endsAt: now + 5_400_000)
        s.schedule = [
            Programme(id: "p0", title: "Early News", startsAt: now - 3_600_000, endsAt: now - 1_800_000),
            s.programme!, s.nextProgramme!,
            Programme(id: "p3", title: "Afternoon Live", startsAt: now + 5_400_000, endsAt: now + 9_000_000),
        ]
        s.canStartOver = true
        s.qualities = [Quality(id: "1", height: 1080, width: 1920, bitrate: 6e6, label: "1080p"), Quality(id: "2", height: 720, width: 1280, bitrate: 3e6, label: "720p")]
        s.textTracks = [TextTrackInfo(id: "0", lang: "en", label: "English", kind: "subtitles")]
        s.audioTracks = [AudioTrackInfo(id: "0", lang: "en", label: "English", channels: nil), AudioTrackInfo(id: "1", lang: "fr", label: "Français", channels: nil)]
        switch self {
        case .live: break
        case .paywall:
            s.status = .locked
            s.access = AccessState(mode: .paywall, message: nil, products: [])
        case .region:
            s.status = .locked
            s.access = AccessState(mode: .blocked, message: "This channel is not available in your region.", products: [])
        case .offline:
            s.status = .offline; s.error = "This is not on air right now."
        case .countdown:
            s.event = EventInfo(id: "e1", title: "Grand Final", startsAt: now + 2 * 86_400_000 + 5 * 3_600_000, endsAt: nil, presentation: .pre,
                                promo: EventPromo(template: .versus, headline: "Premiership 2026", sides: [PromoSide(name: "Harbour City"), PromoSide(name: "Northline")]))
            s.presentation = .pre
        case .radio:
            s.nowPlaying = TrackInfo(title: "Harbour Lights", artist: "The Night Ferries", album: "Low Tide", year: 2025)
            s.history = [TrackInfo(title: "Long Way Round", artist: "Sun Engine", startedAt: now - 240_000),
                         TrackInfo(title: "Paper Boats", artist: "Coastline", startedAt: now - 480_000)]
            s.nextTrack = TrackInfo(title: "Morning Tide", artist: "The Night Ferries")
            s.audioOnly = true
        }
        return s
    }
}

struct DemoScreen: View {
    @StateObject var player: VoltPlayer
    init(demo: DemoState) {
        var o = VoltPlayerOptions()
        o.skin = demo.skin
        o.demo = demo.state()
        _player = StateObject(wrappedValue: VoltPlayer(o))
    }
    var body: some View { VoltPlayerView(player: player).ignoresSafeArea() }
}
