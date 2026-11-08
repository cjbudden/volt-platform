package com.volt.player

import com.volt.player.core.BrandMark
import com.volt.player.core.PlayerEventName
import com.volt.player.core.PlayerState
import com.volt.player.core.PlaylistItem
import com.volt.player.core.Programme
import com.volt.player.core.Schedule
import com.volt.player.core.Source
import com.volt.player.core.Theme

/**
 * Everything the player can be told when it is created. The same options as the web
 * SDK's VoltPlayerSdkOptions and the Swift VoltPlayerOptions, minus what only a web
 * page has (el, media, CSS).
 */
data class VoltPlayerOptions(
    /** The Volt control plane, e.g. https://volt.example.com. */
    val apiBase: String? = null,
    /** The publishable key of an app registered in Volt as type Android. */
    val appKey: String? = null,

    // What to play: one of these.
    val source: Source? = null,
    val item: PlaylistItem? = null,
    /** Items, asset ids or plain URLs. */
    val playlist: List<Schedule.Entry>? = null,
    val startIndex: Int = 0,
    /** A channel, event or on-demand asset, through the play gate. */
    val assetId: String? = null,
    /** An event: countdown, phases, promo and replay (the event skin). Also plays it. */
    val eventId: String? = null,
    /** A radio station: its saved player setup, and now playing every 15 s. */
    val stationId: String? = null,
    /** The guide for a live channel, fetched with the key. */
    val epgChannelId: String? = null,
    /** Or the guide given directly. */
    val epg: List<Programme>? = null,

    /**
     * "video" (phones and tablets), "tv" (the default on a TV), "event", "audio_square",
     * "audio_nowplaying", "audio_radio", or a skin registered with VoltSkins.register.
     */
    val skin: String? = null,
    val theme: Theme? = null,
    /** Translations: the same keys as the web SDK. */
    val strings: Map<String, String> = emptyMap(),

    val autoplay: Boolean = true,
    val muted: Boolean = false,
    /** Start position in seconds for on demand. */
    val startAt: Double? = null,
    val poster: String? = null,
    /** Diagonal text over the picture (share previews). */
    val watermark: String? = null,
    /** A brand mark over the picture for every item (the gate's own, per item, wins). */
    val brandMark: BrandMark? = null,
    /** Act on in-stream graphic triggers, overriding the saved setup. */
    val showGraphics: Boolean? = null,

    /** The signed-in viewer (a Volt viewer session token), so purchases and memberships unlock. */
    val viewerToken: String? = null,
    /** Where Buy goes: {productKey}, {assetId}, {price}, {currency} filled in. Without it, a `purchase` event. */
    val purchaseUrl: String? = null,
    /** Where Sign in goes ({assetId} filled in). Without it, a `signin` event. */
    val signInUrl: String? = null,

    /** Viewer beacons for Analytics. On when the item has a playback token. */
    val beacons: Boolean = true,
    /** CMCD on segment requests (query mode), with the play attempt's id as the session, so CDN logs join. */
    val cmcd: Boolean = true,
    /** Widevine: the licence server and headers for licence requests. */
    val widevine: WidevineConfig? = null,
    /**
     * Keep playing with the screen off or the app in the background, with the system media
     * notification and lock screen controls (VoltPlaybackService). Essential for radio. Keep
     * the VoltPlayer in a ViewModel or the Application so it outlives the screen.
     */
    val backgroundPlayback: Boolean = false,
    /** Android 12+: going Home while a video plays enters picture in picture by itself (the Activity must allow it). */
    val autoPictureInPicture: Boolean = true,
    /** A MediaSession for headset buttons, Bluetooth, Assistant and the system media controls. */
    val mediaSession: Boolean = true,
    /** Remember the viewer's subtitle language between sessions, as the web player does. */
    val rememberSubtitleLanguage: Boolean = true,
    /** App version, sent with every request, so a bad release can be found in reports. */
    val appVersion: String? = null,

    /** DEMO: draw this state and play nothing. For skin previews and design work. */
    val demo: PlayerState? = null,

    /** Every player event, as the web SDK emits them. */
    val onEvent: ((PlayerEventName, Any?) -> Unit)? = null,
)

/** Widevine DRM. The licence request is sent to [licenseUrl] with [headers]. */
data class WidevineConfig(val licenseUrl: String, val headers: Map<String, String> = emptyMap(), val multiSession: Boolean = false)
