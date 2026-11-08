// ============================================================================
//  THE VOLT PLAYER SDK CONTRACT, in Kotlin.
//
//  The same state fields, commands and theme tokens as the web SDK
//  (volt-player/src/sdk/types.ts) and the Swift SDK (VoltPlayerCore), so a
//  skin designed in the console renders the same way on every device and a
//  support answer is the same everywhere. Instants are epoch milliseconds
//  (Double), media times are seconds, exactly as on the web.
// ============================================================================
package com.volt.player.core

/** Epoch milliseconds, as the web SDK and the API use. */
typealias EpochMs = Double

/** Where to play from. Any one is enough; the engine picks the best it can play. */
data class Source(
    val hls: String? = null,
    val dash: String? = null,
    /** Progressive audio (radio). */
    val mp3: String? = null,
    /** Anything else: a progressive MP4, or a manifest whose kind is guessed from the URL. */
    val url: String? = null,
)

/**
 * A channel watermark the PLAYER draws, placed as the encoder would burn it:
 * offsets in pixels of a 1920x1080 frame from the corner, height as a
 * percentage of the frame height, opacity 0 to 100.
 */
data class BrandMark(
    val url: String,
    val position: Position = Position.tr,
    val offsetX: Double = 48.0,
    val offsetY: Double = 48.0,
    val opacity: Double = 100.0,
    val scale: Double = 8.0,
) {
    @Suppress("EnumEntryName")
    enum class Position { tl, tc, tr, bl, bc, br }
}

/** On-demand ads the play gate gave an item. */
data class ItemAds(val delivery: Delivery, val sessionId: String? = null, val timelineUrl: String? = null) {
    enum class Delivery(val wire: String) { Stitched("stitched"), Guided("guided");
        companion object { fun of(s: String?) = entries.firstOrNull { it.wire == s } }
    }
}

/** One thing in a playlist: a URL, an asset id (resolved through the play gate), or both. */
data class PlaylistItem(
    val id: String,
    val title: String? = null,
    val subtitle: String? = null,
    val description: String? = null,
    val artworkUrl: String? = null,
    val source: Source? = null,
    /** A Volt asset (channel, event, VOD). Resolved when the item comes up, so tokens are fresh. */
    val assetId: String? = null,
    val durationMs: Double? = null,
    val startsAt: EpochMs? = null,
    val endsAt: EpochMs? = null,
    val live: Boolean? = null,
    /** The playback token for beacons, when the caller already has one. */
    val playbackToken: String? = null,
    val ads: ItemAds? = null,
    val brandMark: BrandMark? = null,
    val meta: Map<String, String> = emptyMap(),
)

/** A programme in a channel's guide. Instants are epoch ms. */
data class Programme(
    val id: String,
    val title: String,
    val subtitle: String? = null,
    val description: String? = null,
    val imageUrl: String? = null,
    val startsAt: EpochMs,
    /** `Double.POSITIVE_INFINITY` when the stream has not said when it ends. */
    val endsAt: EpochMs,
    /** The programme's key metadata as the stream carries it (keys lower case). Empty for a fetched guide. */
    val meta: Map<String, String> = emptyMap(),
)

/** A track on an audio service: what is playing, what played, what is next. */
data class TrackInfo(
    val title: String,
    val artist: String? = null,
    val album: String? = null,
    val year: Int? = null,
    val artworkUrl: String? = null,
    val startedAt: EpochMs? = null,
    /** Where to listen; show it with the artwork when present. */
    val listen: Listen? = null,
) {
    data class Listen(val service: String, val url: String)
}

data class Quality(
    val id: String,
    val height: Int?,
    val width: Int?,
    /** Bits per second, as the manifest declares it. */
    val bitrate: Double,
    /** "1080p", "720p", or "128 kbps" for an audio-only ladder. */
    val label: String,
)

data class TextTrackInfo(val id: String, val lang: String, val label: String, val kind: String)
data class AudioTrackInfo(val id: String, val lang: String, val label: String, val channels: Int?)

enum class PlayerStatus { Idle, Loading, Ready, Playing, Paused, Buffering, Ended, Error, Offline, Locked }

/** Which part of its life an event is in. Decided by the control plane, never by the player's clock. */
enum class Presentation(val wire: String) {
    Pre("pre"), Live("live"), Ended("ended"), Replay("replay"), Offline("offline"), Postponed("postponed"), Cancelled("cancelled");
    companion object { fun of(s: String?) = entries.firstOrNull { it.wire == s } }
}

data class PromoSide(val name: String, val imageUrl: String? = null, val subtitle: String? = null)

data class EventPromo(
    val template: Template,
    val headline: String? = null,
    val subhead: String? = null,
    val posterUrl: String? = null,
    val posterFit: String? = null,
    val sides: List<PromoSide>? = null,
    val separator: String? = null,
) {
    enum class Template(val wire: String) { Plain("plain"), Versus("versus"), Billing("billing"), People("people"), Field("field");
        companion object { fun of(s: String?) = entries.firstOrNull { it.wire == s } }
    }
}

/** An event as the event skin shows it (GET /api/player/event). */
data class EventInfo(
    val id: String,
    val title: String,
    val description: String? = null,
    val startsAt: EpochMs?,
    val endsAt: EpochMs?,
    /** The start it was moved from, so a postponement can say "was 19:30". */
    val previousStartsAt: EpochMs? = null,
    val presentation: Presentation,
    val preMessage: String? = null,
    val endedMessage: String? = null,
    val promo: EventPromo? = null,
    val replayAssetId: String? = null,
)

/** Something a viewer can buy to watch (the play gate's paywall answer). */
data class Product(
    val productKey: String,
    val name: String? = null,
    val kind: Kind,
    val count: Int? = null,
    val unit: Unit? = null,
    val priceCents: Int,
    val currency: String,
) {
    enum class Kind(val wire: String) { Period("period"), PublishedDates("published_dates");
        companion object { fun of(s: String?) = entries.firstOrNull { it.wire == s } }
    }
    enum class Unit(val wire: String) { Day("day"), Week("week"), Month("month"), Year("year");
        companion object { fun of(s: String?) = entries.firstOrNull { it.wire == s } }
    }
}

/** Why the viewer cannot watch yet, and what would let them. */
data class AccessState(val mode: Mode? = null, val message: String? = null, val products: List<Product> = emptyList()) {
    enum class Mode(val wire: String) { Paywall("paywall"), SignIn("sign_in"), Blocked("blocked");
        companion object { fun of(s: String?) = entries.firstOrNull { it.wire == s } }
    }
}

data class UpNext(
    val kind: Kind,
    val title: String,
    val subtitle: String? = null,
    val artworkUrl: String? = null,
    /** Milliseconds until it starts (a programme) or until auto-advance (an item). */
    val inMs: Double,
    /** An item plays by itself when the countdown ends; a programme simply starts on the channel. */
    val autoAdvance: Boolean,
    /** The countdown length, so a skin can draw progress. */
    val totalMs: Double,
    /** How long the card has been on screen, when the stream times it. */
    val shownMs: Double? = null,
    val startsAt: EpochMs? = null,
    val source: From? = null,
) {
    enum class Kind { Item, Programme }
    enum class From { Stream, Guide, Playlist }
    enum class Variant { Overlay, Banner }

    /** 0..1 for a progress bar: the card's own time on screen when the stream times it, else the countdown. */
    val progress: Double
        get() {
            val f = shownMs?.let { it / maxOf(1.0, totalMs) } ?: (1 - inMs / maxOf(1.0, totalMs))
            return f.coerceIn(0.0, 1.0)
        }

    /** The small line above the title: "Starts in 2 min", "Coming up in 40 s", "Next in 8 s". */
    fun kicker(t: Translator, variant: Variant = Variant.Overlay): String {
        val time = Schedule.fmtIn(inMs)
        if (kind == Kind.Item) return if (autoAdvance) t("nextIn", mapOf("time" to time)) else t("upNext")
        if (variant == Variant.Banner) return if (inMs > 0) t("comingUpIn", mapOf("time" to time)) else t("comingUp")
        return if (inMs > 0) t("startsIn", mapOf("time" to time)) else t("upNext")
    }
}

/** What a Skip button offers: the stretch, in media seconds, and what it is. */
data class SkipOffer(val kind: String, val from: Double, val to: Double, val id: String)

/** A graphic the stream asked for (an EXT-X-DATERANGE trigger). Times are media seconds. */
data class StreamGraphic(
    val id: String,
    /** 'up-next', 'programme', 'ad-break', 'skip-intro', or any graphic a later server sends. */
    val graphic: String,
    val start: Double,
    /** null when open-ended. */
    val end: Double?,
    /** The trigger's data, keys lower case with underscores: title, subtitle, image, starts... */
    val data: Map<String, String>,
)

data class SeekWindow(val start: Double, val end: Double)

data class CastState(val available: Boolean = false, val state: State = State.None, val device: String? = null) {
    enum class State { None, Connecting, Connected }
}

data class Toggle2(val available: Boolean = false, val active: Boolean = false)

data class AdBreakState(val id: String, val endsAt: EpochMs?)

/** The on-demand ad on screen now. */
data class AdState(val breakId: String, val index: Int, val of: Int, val remaining: Double, val clickable: Boolean)

/**
 * What this device and stream can do, so a skin hides what is not there
 * instead of drawing a button that does nothing (PLAYER_FEATURES.md, "caps").
 */
data class Caps(
    val pip: Boolean = false,
    val fullscreen: Boolean = true,
    val cast: Boolean = false,
    val airplay: Boolean = false,
    /** A TV: remote or D-pad, always full screen, lean-back skin. */
    val tv: Boolean = false,
    /** A rendition can be pinned (Android can; AVPlayer only caps). */
    val pinQuality: Boolean = true,
    val backgroundAudio: Boolean = true,
)

/** Everything a skin draws from. The same fields as the web SDK's PlayerState. */
data class PlayerState(
    val status: PlayerStatus = PlayerStatus.Idle,
    val playing: Boolean = false,
    val buffering: Boolean = false,
    /** Readable, already: shown to the viewer as it is. */
    val error: String? = null,
    val errorCode: String? = null,

    val currentTime: Double = 0.0,
    /** Seconds; NaN for live. */
    val duration: Double = Double.NaN,
    val live: Boolean = false,
    /** The seekable window. For live with DVR it is the timeshift buffer. */
    val seekable: SeekWindow? = null,
    /** The window is long enough to be worth a scrubber on live. */
    val dvr: Boolean = false,
    val atLiveEdge: Boolean = true,
    /** Seconds behind the live edge. */
    val behindLive: Double = 0.0,
    /** The wall-clock instant of the playhead (epoch ms), when the stream carries one. */
    val wallClock: EpochMs? = null,

    val programme: Programme? = null,
    val nextProgramme: Programme? = null,
    val schedule: List<Programme> = emptyList(),
    val canStartOver: Boolean = false,

    val volume: Double = 1.0,
    val muted: Boolean = false,
    val rate: Double = 1.0,

    val qualities: List<Quality> = emptyList(),
    /** "auto", or the id of a pinned quality. */
    val quality: String = "auto",
    val activeQuality: Quality? = null,
    val textTracks: List<TextTrackInfo> = emptyList(),
    /** null = subtitles off. */
    val textTrack: String? = null,
    val audioTracks: List<AudioTrackInfo> = emptyList(),
    val audioTrack: String? = null,

    val items: List<PlaylistItem> = emptyList(),
    val index: Int = 0,
    val item: PlaylistItem? = null,
    val upNext: UpNext? = null,
    /** A skippable stretch at the playhead (intro, recap, credits). On demand only. */
    val skip: SkipOffer? = null,
    /** In-stream graphics on screen now. Empty unless graphics are on. */
    val graphics: List<StreamGraphic> = emptyList(),
    /** The stream says an ad break is playing: the player draws nothing of its own over it. */
    val adBreak: AdBreakState? = null,
    val ad: AdState? = null,

    val nowPlaying: TrackInfo? = null,
    val history: List<TrackInfo> = emptyList(),
    val nextTrack: TrackInfo? = null,

    val cast: CastState = CastState(),
    val airplay: Toggle2 = Toggle2(),
    val fullscreen: Boolean = false,
    val pip: Toggle2 = Toggle2(),
    val hasPicture: Boolean = false,
    val audioOnly: Boolean = false,
    val caps: Caps = Caps(),

    val event: EventInfo? = null,
    val presentation: Presentation? = null,
    val msToStart: Double? = null,
    val access: AccessState = AccessState(),
    val replaying: Boolean = false,
    val stats: Boolean = false,
) {
    // Data class equality treats NaN == NaN for Double properties (it compares boxed values),
    // so two live states with duration NaN are equal, as on iOS.
}

/** Everything a skin may ask the player to do. The same commands as the web SDK. */
interface VoltCommands {
    fun play()
    fun pause()
    fun toggle()
    fun seek(seconds: Double)
    fun seekBy(delta: Double)
    fun goLive()
    fun adClick()
    fun startOver()
    fun setQuality(id: String)
    fun setTextTrack(id: String?)
    fun setAudioTrack(id: String)
    fun setVolume(v: Double)
    fun toggleMute()
    fun setRate(r: Double)
    fun next()
    fun previous()
    fun playItem(index: Int)
    fun cancelUpNext()
    fun skip()
    fun toggleFullscreen()
    fun togglePip()
    /** Chromecast. Reported unavailable until the Cast add-on is linked. */
    fun cast()
    fun airplay()
    fun purchase(productKey: String)
    fun signIn()
    fun playReplay()
    fun refreshAccess()
    fun toggleStats(on: Boolean? = null)
}

/** Which controls a skin shows. A skin honours what applies to it and ignores the rest. */
data class ControlToggles(
    val title: Boolean = true,
    val seekButtons: Boolean = true,
    val volume: Boolean = true,
    val quality: Boolean = true,
    val subtitles: Boolean = true,
    val audioTracks: Boolean = true,
    val speed: Boolean = false,
    val pip: Boolean = true,
    val fullscreen: Boolean = true,
    val cast: Boolean = true,
    val airplay: Boolean = true,
    val startOver: Boolean = true,
    val schedule: Boolean = true,
    val upNext: Boolean = true,
    val history: Boolean = true,
    val skip: Boolean = true,
)

/** Player event names, as the web SDK emits them. */
enum class PlayerEventName(val wire: String) {
    State("state"), Ready("ready"), Play("play"), Pause("pause"), Ended("ended"), Error("error"),
    ItemChange("itemchange"), ProgrammeChange("programmechange"), UpNext("upnext"), QualityChange("qualitychange"),
    CastChange("castchange"), PresentationChange("presentationchange"), Purchase("purchase"), SignIn("signin"),
    Locked("locked"), Graphic("graphic"), StatsChange("statschange"), SkinChange("skinchange")
}
