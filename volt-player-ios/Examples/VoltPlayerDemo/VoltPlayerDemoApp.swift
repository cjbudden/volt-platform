// ============================================================================
//  A DEMO APP for the Volt player SDK on iOS.
//
//  Create a new iOS App project in Xcode (SwiftUI, iOS 15+), add this package
//  (File > Add Package Dependencies > Add Local... and pick volt-player-ios),
//  replace the app's files with this one, and set VOLT_API and VOLT_KEY below
//  to your Volt address and the publishable key of an app of type iOS.
//
//  Background audio for radio: Signing & Capabilities > Background Modes >
//  Audio, AirPlay, and Picture in Picture.
// ============================================================================
import SwiftUI
import VoltPlayer

let VOLT_API = URL(string: "https://volt.example.com")!
let VOLT_KEY = "pk_live_replace_me"

@main
struct VoltPlayerDemoApp: App {
    var body: some Scene { WindowGroup { DemoList() } }
}

struct DemoList: View {
    @State private var channelId = ""
    @State private var eventId = ""
    @State private var stationId = ""

    var body: some View {
        NavigationView {
            Form {
                Section("A live channel (video skin, guide, start over)") {
                    TextField("Channel id", text: $channelId).textInputAutocapitalization(.never)
                    NavigationLink("Play") { ChannelScreen(id: channelId) }.disabled(channelId.isEmpty)
                }
                Section("An event (countdown, paywall, live, replay)") {
                    TextField("Event id", text: $eventId).textInputAutocapitalization(.never)
                    NavigationLink("Open") { EventScreen(id: eventId) }.disabled(eventId.isEmpty)
                }
                Section("A radio station (now playing, last five)") {
                    TextField("Station id", text: $stationId).textInputAutocapitalization(.never)
                    NavigationLink("Listen") { StationScreen(id: stationId) }.disabled(stationId.isEmpty)
                }
                Section("No server needed") {
                    NavigationLink("Skins in demo mode") { DemoSkins() }
                    NavigationLink("A public test stream") { UrlScreen() }
                }
            }
            .navigationTitle("Volt player")
        }
    }
}

struct ChannelScreen: View {
    @StateObject var player: VoltPlayer
    init(id: String) {
        var o = VoltPlayerOptions(apiBase: VOLT_API, appKey: VOLT_KEY)
        o.assetId = id
        o.epgChannelId = id
        o.onEvent = { name, detail in print("volt:", name.rawValue, detail ?? "") }
        _player = StateObject(wrappedValue: VoltPlayer(o))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VoltPlayerView(player: player).aspectRatio(16 / 9, contentMode: .fit)
            if let p = player.state.programme {
                Text(p.title).font(.headline)
                if let g = p.meta["genre"] { Text(g).font(.caption).foregroundColor(.secondary) }
            }
            if let n = player.state.nextProgramme { Text("Next: \(n.title)").font(.subheadline) }
            Spacer()
        }
        .padding()
        .onDisappear { if !player.state.fullscreen { player.destroy() } }
    }
}

struct EventScreen: View {
    @StateObject var player: VoltPlayer
    init(id: String) {
        var o = VoltPlayerOptions(apiBase: VOLT_API, appKey: VOLT_KEY)
        o.eventId = id
        // Your own checkout; without it the player emits .purchase for the app to handle.
        o.purchaseUrl = "https://shop.example.com/buy?p={productKey}&e={assetId}"
        _player = StateObject(wrappedValue: VoltPlayer(o))
    }
    var body: some View {
        VoltPlayerView(player: player).aspectRatio(16 / 9, contentMode: .fit).padding()
            .onDisappear { if !player.state.fullscreen { player.destroy() } }
    }
}

struct StationScreen: View {
    @StateObject var player: VoltPlayer
    init(id: String) {
        var o = VoltPlayerOptions(apiBase: VOLT_API, appKey: VOLT_KEY)
        o.stationId = id
        o.skin = "audio_nowplaying"
        _player = StateObject(wrappedValue: VoltPlayer(o))
    }
    var body: some View {
        ScrollView { VoltPlayerView(player: player).padding() }
            .onDisappear { if !player.state.fullscreen { player.destroy() } }
    }
}

struct UrlScreen: View {
    @StateObject var player: VoltPlayer = {
        var o = VoltPlayerOptions()
        o.source = Source(hls: "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8")
        o.theme = Theme(primary: "#e11d48", radius: 4)
        return VoltPlayer(o)
    }()
    var body: some View {
        VoltPlayerView(player: player).aspectRatio(16 / 9, contentMode: .fit).padding()
            .onDisappear { if !player.state.fullscreen { player.destroy() } }
    }
}

/// Every built-in skin in demo mode: no stream, any state. How skins are designed and checked.
struct DemoSkins: View {
    static func state() -> PlayerState {
        var s = PlayerState()
        let now = Date().timeIntervalSince1970 * 1000
        s.status = .paused; s.live = true; s.dvr = true; s.atLiveEdge = false; s.behindLive = 42
        s.seekable = SeekWindow(start: 0, end: 3600); s.currentTime = 3558
        s.item = PlaylistItem(id: "demo", title: "News 24", live: true)
        s.programme = Programme(id: "p1", title: "The Morning Show", subtitle: "News, weather and guests", startsAt: now - 1_800_000, endsAt: now + 1_800_000)
        s.nextProgramme = Programme(id: "p2", title: "Midday Report", startsAt: now + 1_800_000, endsAt: now + 5_400_000)
        s.canStartOver = true
        s.upNext = UpNext(kind: .programme, title: "Midday Report", inMs: 90_000, autoAdvance: false, totalMs: 120_000, startsAt: now + 90_000, source: .guide)
        s.qualities = [Quality(id: "1", height: 1080, width: 1920, bitrate: 6e6, label: "1080p"), Quality(id: "2", height: 720, width: 1280, bitrate: 3e6, label: "720p")]
        s.textTracks = [TextTrackInfo(id: "0", lang: "en", label: "English", kind: "subtitles")]
        s.nowPlaying = TrackInfo(title: "Harbour Lights", artist: "The Night Ferries", album: "Low Tide", year: 2025)
        s.history = [TrackInfo(title: "Long Way Round", artist: "Sun Engine", startedAt: now - 240_000)]
        s.event = EventInfo(id: "e1", title: "Grand Final", startsAt: now + 2 * 86_400_000 + 5 * 3_600_000, endsAt: nil, presentation: .pre,
                            promo: EventPromo(template: .versus, headline: "Premiership 2026", sides: [PromoSide(name: "Harbour City"), PromoSide(name: "Northline")]))
        s.presentation = .pre
        return s
    }

    func player(_ skin: String) -> VoltPlayer {
        var o = VoltPlayerOptions()
        o.skin = skin; o.demo = Self.state()
        return VoltPlayer(o)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                ForEach(["video", "event", "audio_square", "audio_nowplaying", "audio_radio"], id: \.self) { id in
                    VStack(alignment: .leading) {
                        Text(id).font(.caption.monospaced())
                        if id.hasPrefix("audio") { VoltPlayerView(player: player(id)).frame(maxWidth: id == "audio_square" ? 220 : .infinity) }
                        else { VoltPlayerView(player: player(id)).aspectRatio(16 / 9, contentMode: .fit) }
                    }
                }
            }.padding()
        }
    }
}
