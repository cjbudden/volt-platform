// ============================================================================
//  THE VOLT PLAYER SDK CONTRACT, in Swift.
//
//  The same state fields, commands and theme tokens as the web SDK
//  (volt-player/src/sdk/types.ts), so a skin designed in the console renders
//  the same way on every device and a support answer is the same everywhere.
//  Instants are epoch milliseconds (Double), media times are seconds, exactly
//  as on the web. Names match the web contract; where Swift needs a different
//  spelling the web name is in the comment.
// ============================================================================
import Foundation

/// Epoch milliseconds, as the web SDK and the API use.
public typealias EpochMs = Double

/// Where to play from. Any one is enough; the engine picks the best it can play.
public struct Source: Codable, Equatable, Sendable {
    public var hls: String?
    public var dash: String?
    /// Progressive audio (radio).
    public var mp3: String?
    /// Anything else: a progressive MP4, or a manifest whose kind is guessed from the URL.
    public var url: String?
    public init(hls: String? = nil, dash: String? = nil, mp3: String? = nil, url: String? = nil) {
        self.hls = hls; self.dash = dash; self.mp3 = mp3; self.url = url
    }
}

/// A channel watermark the PLAYER draws, placed as the encoder would burn it:
/// offsets in pixels of a 1920x1080 frame from the corner, height as a percentage
/// of the frame height, opacity 0 to 100.
public struct BrandMark: Codable, Equatable, Sendable {
    public enum Position: String, Codable, Sendable { case tl, tc, tr, bl, bc, br }
    public var url: String
    public var position: Position
    public var offsetX: Double
    public var offsetY: Double
    public var opacity: Double
    public var scale: Double
    public init(url: String, position: Position, offsetX: Double, offsetY: Double, opacity: Double, scale: Double) {
        self.url = url; self.position = position; self.offsetX = offsetX; self.offsetY = offsetY; self.opacity = opacity; self.scale = scale
    }
}

/// On-demand ads the play gate gave an item.
public struct ItemAds: Codable, Equatable, Sendable {
    public enum Delivery: String, Codable, Sendable { case stitched, guided }
    public var delivery: Delivery
    public var sessionId: String?
    public var timelineUrl: String?
    public init(delivery: Delivery, sessionId: String? = nil, timelineUrl: String? = nil) {
        self.delivery = delivery; self.sessionId = sessionId; self.timelineUrl = timelineUrl
    }
}

/// One thing in a playlist: a URL, an asset id (resolved through the play gate), or both.
public struct PlaylistItem: Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String?
    public var subtitle: String?
    public var description: String?
    public var artworkUrl: String?
    public var source: Source?
    /// A Volt asset (channel, event, VOD). Resolved when the item comes up, so tokens are fresh.
    public var assetId: String?
    public var durationMs: Double?
    public var startsAt: EpochMs?
    public var endsAt: EpochMs?
    public var live: Bool?
    /// The playback token for beacons, when the caller already has one.
    public var playbackToken: String?
    public var ads: ItemAds?
    public var brandMark: BrandMark?
    public var meta: [String: String]

    public init(id: String, title: String? = nil, subtitle: String? = nil, description: String? = nil,
                artworkUrl: String? = nil, source: Source? = nil, assetId: String? = nil,
                durationMs: Double? = nil, startsAt: EpochMs? = nil, endsAt: EpochMs? = nil, live: Bool? = nil,
                playbackToken: String? = nil, ads: ItemAds? = nil, brandMark: BrandMark? = nil, meta: [String: String] = [:]) {
        self.id = id; self.title = title; self.subtitle = subtitle; self.description = description
        self.artworkUrl = artworkUrl; self.source = source; self.assetId = assetId; self.durationMs = durationMs
        self.startsAt = startsAt; self.endsAt = endsAt; self.live = live; self.playbackToken = playbackToken
        self.ads = ads; self.brandMark = brandMark; self.meta = meta
    }
}

/// A programme in a channel's guide. Instants are epoch ms.
public struct Programme: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var subtitle: String?
    public var description: String?
    public var imageUrl: String?
    public var startsAt: EpochMs
    /// `.infinity` when the stream has not said when it ends.
    public var endsAt: EpochMs
    /// The programme's key metadata as the stream carries it (keys lower case): genre,
    /// series, season, episode, rating, year, artist, album, language... Empty for a fetched guide.
    public var meta: [String: String]
    public init(id: String, title: String, subtitle: String? = nil, description: String? = nil, imageUrl: String? = nil,
                startsAt: EpochMs, endsAt: EpochMs, meta: [String: String] = [:]) {
        self.id = id; self.title = title; self.subtitle = subtitle; self.description = description
        self.imageUrl = imageUrl; self.startsAt = startsAt; self.endsAt = endsAt; self.meta = meta
    }
}

/// A track on an audio service: what is playing, what played, what is next.
public struct TrackInfo: Equatable, Sendable {
    public struct Listen: Equatable, Sendable { public var service: String; public var url: String }
    public var title: String
    public var artist: String?
    public var album: String?
    public var year: Int?
    public var artworkUrl: String?
    public var startedAt: EpochMs?
    /// Where to listen; show it with the artwork when present (Apple artwork must link to Apple Music).
    public var listen: Listen?
    public init(title: String, artist: String? = nil, album: String? = nil, year: Int? = nil, artworkUrl: String? = nil,
                startedAt: EpochMs? = nil, listen: Listen? = nil) {
        self.title = title; self.artist = artist; self.album = album; self.year = year
        self.artworkUrl = artworkUrl; self.startedAt = startedAt; self.listen = listen
    }
}

public struct Quality: Equatable, Sendable, Identifiable {
    public var id: String
    public var height: Int?
    public var width: Int?
    /// Bits per second, as the manifest declares it.
    public var bitrate: Double
    /// "1080p", "720p", or "128 kbps" for an audio-only ladder.
    public var label: String
    public init(id: String, height: Int?, width: Int?, bitrate: Double, label: String) {
        self.id = id; self.height = height; self.width = width; self.bitrate = bitrate; self.label = label
    }
}

public struct TextTrackInfo: Equatable, Sendable, Identifiable {
    public var id: String; public var lang: String; public var label: String; public var kind: String
    public init(id: String, lang: String, label: String, kind: String) { self.id = id; self.lang = lang; self.label = label; self.kind = kind }
}
public struct AudioTrackInfo: Equatable, Sendable, Identifiable {
    public var id: String; public var lang: String; public var label: String; public var channels: Int?
    public init(id: String, lang: String, label: String, channels: Int?) { self.id = id; self.lang = lang; self.label = label; self.channels = channels }
}

public enum PlayerStatus: String, Sendable {
    case idle, loading, ready, playing, paused, buffering, ended, error, offline, locked
}

/// Which part of its life an event is in. Decided by the control plane, never by the player's clock.
public enum Presentation: String, Codable, Sendable {
    case pre, live, ended, replay, offline, postponed, cancelled
}

public struct PromoSide: Codable, Equatable, Sendable {
    public var name: String
    public var imageUrl: String?
    public var subtitle: String?
    public init(name: String, imageUrl: String? = nil, subtitle: String? = nil) { self.name = name; self.imageUrl = imageUrl; self.subtitle = subtitle }
}

public struct EventPromo: Codable, Equatable, Sendable {
    public enum Template: String, Codable, Sendable { case plain, versus, billing, people, field }
    public var template: Template
    public var headline: String?
    public var subhead: String?
    public var posterUrl: String?
    public var posterFit: String?
    public var sides: [PromoSide]?
    public var separator: String?
    public init(template: Template, headline: String? = nil, subhead: String? = nil, posterUrl: String? = nil, posterFit: String? = nil,
                sides: [PromoSide]? = nil, separator: String? = nil) {
        self.template = template; self.headline = headline; self.subhead = subhead; self.posterUrl = posterUrl
        self.posterFit = posterFit; self.sides = sides; self.separator = separator
    }
}

/// An event as the event skin shows it (GET /api/player/event).
public struct EventInfo: Codable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var description: String?
    public var startsAt: EpochMs?
    public var endsAt: EpochMs?
    /// The start it was moved from, so a postponement can say "was 19:30".
    public var previousStartsAt: EpochMs?
    public var presentation: Presentation
    public var preMessage: String?
    public var endedMessage: String?
    public var promo: EventPromo?
    public var replayAssetId: String?
    public init(id: String, title: String, description: String? = nil, startsAt: EpochMs?, endsAt: EpochMs?,
                previousStartsAt: EpochMs? = nil, presentation: Presentation, preMessage: String? = nil,
                endedMessage: String? = nil, promo: EventPromo? = nil, replayAssetId: String? = nil) {
        self.id = id; self.title = title; self.description = description; self.startsAt = startsAt; self.endsAt = endsAt
        self.previousStartsAt = previousStartsAt; self.presentation = presentation; self.preMessage = preMessage
        self.endedMessage = endedMessage; self.promo = promo; self.replayAssetId = replayAssetId
    }
}

/// Something a viewer can buy to watch (the play gate's paywall answer).
public struct Product: Codable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable { case period, published_dates }
    public enum Unit: String, Codable, Sendable { case day, week, month, year }
    public var productKey: String
    public var name: String?
    public var kind: Kind
    public var count: Int?
    public var unit: Unit?
    public var priceCents: Int
    public var currency: String
    public var id: String { productKey }
    public init(productKey: String, name: String? = nil, kind: Kind, count: Int? = nil, unit: Unit? = nil, priceCents: Int, currency: String) {
        self.productKey = productKey; self.name = name; self.kind = kind; self.count = count; self.unit = unit
        self.priceCents = priceCents; self.currency = currency
    }
}

/// Why the viewer cannot watch yet, and what would let them.
public struct AccessState: Equatable, Sendable {
    public enum Mode: String, Sendable { case paywall, sign_in, blocked }
    public var mode: Mode?
    public var message: String?
    public var products: [Product]
    public init(mode: Mode? = nil, message: String? = nil, products: [Product] = []) {
        self.mode = mode; self.message = message; self.products = products
    }
}

public struct UpNext: Equatable, Sendable {
    public enum Kind: String, Sendable { case item, programme }
    public enum From: String, Sendable { case stream, guide, playlist }
    public var kind: Kind
    public var title: String
    public var subtitle: String?
    public var artworkUrl: String?
    /// Milliseconds until it starts (a programme) or until auto-advance (an item).
    public var inMs: Double
    /// An item plays by itself when the countdown ends; a programme simply starts on the channel.
    public var autoAdvance: Bool
    /// The countdown length, so a skin can draw progress.
    public var totalMs: Double
    /// How long the card has been on screen, when the stream times it.
    public var shownMs: Double?
    public var startsAt: EpochMs?
    public var source: From?
    public init(kind: Kind, title: String, subtitle: String? = nil, artworkUrl: String? = nil, inMs: Double,
                autoAdvance: Bool, totalMs: Double, shownMs: Double? = nil, startsAt: EpochMs? = nil, source: From? = nil) {
        self.kind = kind; self.title = title; self.subtitle = subtitle; self.artworkUrl = artworkUrl; self.inMs = inMs
        self.autoAdvance = autoAdvance; self.totalMs = totalMs; self.shownMs = shownMs; self.startsAt = startsAt; self.source = source
    }
    /// 0...1 for a progress bar: the card's own time on screen when the stream times it,
    /// else the countdown (kit.upNextProgress).
    public var progress: Double {
        let f = shownMs.map { $0 / max(1, totalMs) } ?? (1 - inMs / max(1, totalMs))
        return min(1, max(0, f))
    }

    public enum Variant: Sendable { case overlay, banner }

    /// The small line above the title: "Starts in 2 min", "Coming up in 40 s", "Next in 8 s" (kit.upNextKicker).
    public func kicker(_ t: Translator, _ variant: Variant = .overlay) -> String {
        let time = Schedule.fmtIn(inMs)
        if kind == .item { return autoAdvance ? t("nextIn", ["time": time]) : t("upNext") }
        if variant == .banner { return inMs > 0 ? t("comingUpIn", ["time": time]) : t("comingUp") }
        return inMs > 0 ? t("startsIn", ["time": time]) : t("upNext")
    }
}

/// What a Skip button offers: the stretch, in media seconds, and what it is.
public struct SkipOffer: Equatable, Sendable {
    public var kind: String
    public var from: Double
    public var to: Double
    public var id: String
    public init(kind: String, from: Double, to: Double, id: String) { self.kind = kind; self.from = from; self.to = to; self.id = id }
}

/// A graphic the stream asked for (an EXT-X-DATERANGE trigger). Times are media seconds.
public struct StreamGraphic: Equatable, Sendable, Identifiable {
    public var id: String
    /// 'up-next', 'programme', 'ad-break', 'skip-intro', or any graphic a later server sends.
    public var graphic: String
    public var start: Double
    /// nil when open-ended.
    public var end: Double?
    /// The trigger's data, keys lower case with underscores: title, subtitle, image, starts...
    public var data: [String: String]
    public init(id: String, graphic: String, start: Double, end: Double?, data: [String: String]) {
        self.id = id; self.graphic = graphic; self.start = start; self.end = end; self.data = data
    }
}

public struct SeekWindow: Equatable, Sendable {
    public var start: Double
    public var end: Double
    public init(start: Double, end: Double) { self.start = start; self.end = end }
}

public struct CastState: Equatable, Sendable {
    public enum State: String, Sendable { case none, connecting, connected }
    public var available: Bool = false
    public var state: State = .none
    public var device: String?
    public init(available: Bool = false, state: State = .none, device: String? = nil) {
        self.available = available; self.state = state; self.device = device
    }
}

public struct Toggle2: Equatable, Sendable {
    public var available: Bool = false
    public var active: Bool = false
    public init(available: Bool = false, active: Bool = false) { self.available = available; self.active = active }
}

public struct AdBreakState: Equatable, Sendable {
    public var id: String
    public var endsAt: EpochMs?
    public init(id: String, endsAt: EpochMs?) { self.id = id; self.endsAt = endsAt }
}

/// The on-demand ad on screen now.
public struct AdState: Equatable, Sendable {
    public var breakId: String
    public var index: Int
    public var of: Int
    public var remaining: Double
    public var clickable: Bool
    public init(breakId: String, index: Int, of: Int, remaining: Double, clickable: Bool) {
        self.breakId = breakId; self.index = index; self.of = of; self.remaining = remaining; self.clickable = clickable
    }
}

/// Everything a skin draws from. The same fields as the web SDK's PlayerState.
public struct PlayerState: Equatable, Sendable {
    public var status: PlayerStatus = .idle
    public var playing = false
    public var buffering = false
    /// Readable, already: shown to the viewer as it is.
    public var error: String?
    public var errorCode: String?

    public var currentTime: Double = 0
    /// Seconds; .nan for live.
    public var duration: Double = .nan
    public var live = false
    /// The seekable window. For live with DVR it is the timeshift buffer.
    public var seekable: SeekWindow?
    /// The window is long enough to be worth a scrubber on live.
    public var dvr = false
    public var atLiveEdge = true
    /// Seconds behind the live edge.
    public var behindLive: Double = 0
    /// The wall-clock instant of the playhead (epoch ms), when the stream carries one.
    public var wallClock: EpochMs?

    public var programme: Programme?
    public var nextProgramme: Programme?
    public var schedule: [Programme] = []
    public var canStartOver = false

    public var volume: Double = 1
    public var muted = false
    public var rate: Double = 1

    public var qualities: [Quality] = []
    /// "auto", or the id of a pinned quality.
    public var quality: String = "auto"
    public var activeQuality: Quality?
    public var textTracks: [TextTrackInfo] = []
    /// nil = subtitles off.
    public var textTrack: String?
    public var audioTracks: [AudioTrackInfo] = []
    public var audioTrack: String?

    public var items: [PlaylistItem] = []
    public var index = 0
    public var item: PlaylistItem?
    public var upNext: UpNext?
    /// A skippable stretch at the playhead (intro, recap, credits). On demand only.
    public var skip: SkipOffer?
    /// In-stream graphics on screen now. Empty unless graphics are on.
    public var graphics: [StreamGraphic] = []
    /// The stream says an ad break is playing: the player draws nothing of its own over it.
    public var adBreak: AdBreakState?
    public var ad: AdState?

    public var nowPlaying: TrackInfo?
    public var history: [TrackInfo] = []
    public var nextTrack: TrackInfo?

    public var cast = CastState()
    public var airplay = Toggle2()
    public var fullscreen = false
    public var pip = Toggle2()
    public var hasPicture = false
    public var audioOnly = false

    public var event: EventInfo?
    public var presentation: Presentation?
    public var msToStart: Double?
    public var access = AccessState()
    public var replaying = false
    public var stats = false

    public init() {}

    public static func == (a: PlayerState, b: PlayerState) -> Bool {
        // NaN != NaN, so duration compares by bit pattern meaning (both NaN = equal).
        let dur = (a.duration.isNaN && b.duration.isNaN) || a.duration == b.duration
        return dur && a.status == b.status && a.playing == b.playing && a.buffering == b.buffering && a.error == b.error
            && a.errorCode == b.errorCode && a.currentTime == b.currentTime && a.live == b.live && a.seekable == b.seekable
            && a.dvr == b.dvr && a.atLiveEdge == b.atLiveEdge && a.behindLive == b.behindLive && a.wallClock == b.wallClock
            && a.programme == b.programme && a.nextProgramme == b.nextProgramme && a.schedule == b.schedule
            && a.canStartOver == b.canStartOver && a.volume == b.volume && a.muted == b.muted && a.rate == b.rate
            && a.qualities == b.qualities && a.quality == b.quality && a.activeQuality == b.activeQuality
            && a.textTracks == b.textTracks && a.textTrack == b.textTrack && a.audioTracks == b.audioTracks
            && a.audioTrack == b.audioTrack && a.items == b.items && a.index == b.index && a.item == b.item
            && a.upNext == b.upNext && a.skip == b.skip && a.graphics == b.graphics && a.adBreak == b.adBreak && a.ad == b.ad
            && a.nowPlaying == b.nowPlaying && a.history == b.history && a.nextTrack == b.nextTrack && a.cast == b.cast
            && a.airplay == b.airplay && a.fullscreen == b.fullscreen && a.pip == b.pip && a.hasPicture == b.hasPicture
            && a.audioOnly == b.audioOnly && a.event == b.event && a.presentation == b.presentation && a.msToStart == b.msToStart
            && a.access == b.access && a.replaying == b.replaying && a.stats == b.stats
    }
}

/// Everything a skin may ask the player to do. The same commands as the web SDK.
@MainActor
public protocol VoltCommands: AnyObject {
    func play()
    func pause()
    func toggle()
    func seek(_ seconds: Double)
    func seekBy(_ delta: Double)
    func goLive()
    func adClick()
    func startOver()
    func setQuality(_ id: String)
    func setTextTrack(_ id: String?)
    func setAudioTrack(_ id: String)
    func setVolume(_ v: Double)
    func toggleMute()
    func setRate(_ r: Double)
    func next()
    func previous()
    func playItem(_ index: Int)
    func cancelUpNext()
    func skip()
    func toggleFullscreen()
    func togglePip()
    /// Chromecast. Reported unavailable until the Google Cast add-on is linked.
    func cast()
    func airplay()
    func purchase(_ productKey: String)
    func signIn()
    func playReplay()
    func refreshAccess()
    func toggleStats(_ on: Bool?)
}

/// Which controls a skin shows. A skin honours what applies to it and ignores the rest.
public struct ControlToggles: Codable, Equatable, Sendable {
    public var title = true
    public var seekButtons = true
    public var volume = true
    public var quality = true
    public var subtitles = true
    public var audioTracks = true
    public var speed = false
    public var pip = true
    public var fullscreen = true
    public var cast = true
    public var airplay = true
    public var startOver = true
    public var schedule = true
    public var upNext = true
    public var history = true
    public var skip = true
    public init() {}
}

/// Player event names, as the web SDK emits them.
public enum PlayerEventName: String, Sendable {
    case state, ready, play, pause, ended, error, itemchange, programmechange, upnext, qualitychange, castchange
    case presentationchange, purchase, signin, locked, graphic, statschange
}
