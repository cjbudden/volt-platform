#if os(iOS) || os(tvOS)
import Foundation
import VoltPlayerCore

/// Everything the player can be told when it is created. The same options as the
/// web SDK's VoltPlayerSdkOptions, minus what only a web page has (el, media, CSS).
public struct VoltPlayerOptions {
    /// The Volt control plane, e.g. https://volt.example.com.
    public var apiBase: URL?
    /// The publishable key of an app registered in Volt as type iOS (Apple TV apps use one too).
    public var appKey: String?

    // What to play: one of these.
    public var source: Source?
    public var item: PlaylistItem?
    /// Items, asset ids or plain URLs.
    public var playlist: [Schedule.Entry]?
    public var startIndex: Int = 0
    /// A channel, event or on-demand asset, through the play gate.
    public var assetId: String?
    /// An event: countdown, phases, promo and replay (the event skin). Also plays it.
    public var eventId: String?
    /// A radio station: its saved player setup, and now playing every 15 s.
    public var stationId: String?
    /// The guide for a live channel, fetched with the key.
    public var epgChannelId: String?
    /// Or the guide given directly.
    public var epg: [Programme]?

    /// "video" (default; "tv" on Apple TV), "tv", "event", "audio_square", "audio_nowplaying", "audio_radio",
    /// or a registered skin.
    public var skin: String?
    public var theme: Theme?
    /// Translations: the same keys as the web SDK.
    public var strings: [String: String] = [:]

    public var autoplay = true
    public var muted = false
    /// Start position in seconds for on demand.
    public var startAt: Double?
    public var poster: String?
    /// Diagonal text over the picture (share previews).
    public var watermark: String?
    /// A brand mark over the picture for every item (the gate's own, per item, wins).
    public var brandMark: BrandMark?
    /// Act on in-stream graphic triggers, overriding the saved setup.
    public var showGraphics: Bool?

    /// The signed-in viewer (a Volt viewer session token), so purchases and memberships unlock.
    public var viewerToken: String?
    /// Where Buy goes: {productKey}, {assetId}, {price}, {currency} filled in. Without it, a `purchase` event.
    public var purchaseUrl: String?
    /// Where Sign in goes ({assetId} filled in). Without it, a `signin` event.
    public var signInUrl: String?

    /// Viewer beacons for Analytics. On when the item has a playback token.
    public var beacons = true
    /// FairPlay: the certificate and licence server, and headers for licence requests.
    public var fairPlay: FairPlayConfig?
    /// Show the title and artwork on the lock screen and in Control Center, with play and pause.
    public var lockScreen = true
    /// Set the audio session to .playback, so sound plays with the silent switch on and,
    /// with the Background Modes > Audio capability, in the background.
    public var configureAudioSession = true
    /// Allow AirPlay video (external playback).
    public var airplay = true
    /// App name and version, sent with every request, so a bad release can be found in reports.
    public var appVersion: String?

    /// DEMO: draw this state and play nothing. For skin previews and design work.
    public var demo: PlayerState?

    /// Apple TV: who draws the playback controls of the `tv` skin.
    ///   .system  the system player (AVPlayerViewController): Siri Remote scrubbing with
    ///            previews, the info panel (subtitles, audio, description), with Volt's
    ///            Guide, Go live, Start over and Quality in its transport bar. The default.
    ///   .volt    Volt's own focusable controls, themed like every other skin.
    public enum TVControls: Sendable { case system, volt }
    public var tvControls: TVControls = .system

    /// Every player event, as the web SDK emits them.
    public var onEvent: ((PlayerEventName, Any?) -> Void)?

    public init(apiBase: URL? = nil, appKey: String? = nil) { self.apiBase = apiBase; self.appKey = appKey }
}

/// FairPlay Streaming. The licence request body is the SPC; the answer is the CKC.
public struct FairPlayConfig {
    public var certificateUrl: URL
    public var licenseUrl: URL
    public var headers: [String: String]
    public init(certificateUrl: URL, licenseUrl: URL, headers: [String: String] = [:]) {
        self.certificateUrl = certificateUrl; self.licenseUrl = licenseUrl; self.headers = headers
    }
}
#endif
