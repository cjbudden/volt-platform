// ============================================================================
//  THE VOLT PLAYER FOR ANDROID: ExoPlayer + playlist + guide + events + beacons.
//
//  The same job as volt-player/src/sdk/player.ts and the Swift VoltPlayer. It
//  owns the ExoPlayer and publishes one PlayerState; skins draw from the state
//  and call commands, and never touch the ExoPlayer, so a skin can render
//  badly but cannot break playback. Every rule that is not Media3 plumbing
//  lives in :core (Derive, Schedule, Triggers, EventRules) and is unit tested.
//
//  Threading: create, command and destroy on the main thread (ExoPlayer's
//  rule). Polling runs in coroutines on the main dispatcher; HTTP is on IO.
// ============================================================================
package com.volt.player

import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.UiModeManager
import android.content.ComponentName
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Rational
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Metadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsManifest
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.CmcdConfiguration
import androidx.media3.extractor.metadata.icy.IcyInfo
import androidx.media3.extractor.metadata.id3.TextInformationFrame
import androidx.media3.session.MediaController
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.volt.player.core.AccessState
import com.volt.player.core.AudioTrackInfo
import com.volt.player.core.BeaconSession
import com.volt.player.core.Caps
import com.volt.player.core.Derive
import com.volt.player.core.DeriveInput
import com.volt.player.core.EngineSnapshot
import com.volt.player.core.EpochMs
import com.volt.player.core.EventInfo
import com.volt.player.core.EventRules
import com.volt.player.core.Gate
import com.volt.player.core.GateError
import com.volt.player.core.PlayerEventName
import com.volt.player.core.PlayerState
import com.volt.player.core.PlayerStatus
import com.volt.player.core.PlaylistItem
import com.volt.player.core.Presentation
import com.volt.player.core.Quality
import com.volt.player.core.ResolvedTheme
import com.volt.player.core.Schedule
import com.volt.player.core.SeekWindow
import com.volt.player.core.Source
import com.volt.player.core.StreamGraphic
import com.volt.player.core.TextTrackInfo
import com.volt.player.core.Theme
import com.volt.player.core.ThemeTokens
import com.volt.player.core.TrackInfo
import com.volt.player.core.Translator
import com.volt.player.core.Triggers
import com.volt.player.core.VoltApi
import com.volt.player.core.VoltCommands
import com.volt.player.core.mergeResolved
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.lang.ref.WeakReference
import java.util.Locale
import java.util.UUID
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

@androidx.annotation.OptIn(UnstableApi::class)
class VoltPlayer(context: Context, options: VoltPlayerOptions) : VoltCommands {
    private val app: Context = context.applicationContext
    var options: VoltPlayerOptions = options
        private set

    private val _state = MutableStateFlow(PlayerState())
    /** Everything a skin draws from. */
    val state: StateFlow<PlayerState> = _state.asStateFlow()
    private val _theme = MutableStateFlow(ThemeTokens.resolve(options.theme))
    val theme: StateFlow<ResolvedTheme> = _theme.asStateFlow()
    val t = Translator(options.strings)
    /** True on Android TV, Google TV and Fire TV: the lean-back skin and D-pad focus. */
    val isTv: Boolean = isTelevision(app)
    private val _skinId = MutableStateFlow(options.skin ?: when {
        options.eventId != null -> "event"
        options.stationId != null -> "audio_nowplaying"
        isTv -> "tv"
        else -> "video"
    })
    /** The skin to draw: the option, else the asset kind's default (tv on a TV). */
    val skinId: StateFlow<String> = _skinId.asStateFlow()

    private val api: VoltApi? = if (options.apiBase != null && options.appKey != null)
        VoltApi(options.apiBase, options.appKey, packageName = app.packageName, appVersion = options.appVersion) else null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var tickJob: Job? = null
    private var loadJob: Job? = null
    private var eventJob: Job? = null
    private val pollJobs = mutableListOf<Job>()

    /** The id of the current play attempt: gate, beacons and CMCD join on it. */
    private var sid: String = newSid()
    private val exo: ExoPlayer? = if (options.demo != null) null else buildExo()
    /** For the view that draws the picture. Skins never use it. */
    val exoPlayer: ExoPlayer? get() = exo

    private var mediaSession: MediaSession? = null
    private var controllerFuture: ListenableFuture<MediaController>? = null

    private val dateRanges = LinkedHashMap<String, Triggers.DateRange>()
    private var presentationStart: EpochMs? = null
    private var dismissed: String? = null
    private var currentCardKey: String? = null
    private var lastProgrammeId: String? = null
    private var beacons: BeaconSession? = null
    private var beaconClock = SystemClock.elapsedRealtime()
    private var loadedIndex = -1
    /** Playback has begun for this item, so a stop is a pause, not "ready". */
    private var started = false
    /** The last beacons go out on their own scope, so destroy() cannot cancel them in flight. */
    private val beaconScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    /** "group:track" ids as the menus show them, to the Media3 group id, index and type. */
    private val trackRefs = HashMap<String, Triple<String, Int, Int>>()
    private var autoPipOn: Boolean? = null
    /** The stream was loaded for this live phase, so a locked event does not ask the gate on every poll. */
    private var liveLoadStarted = false
    /** The Activity hosting the view, for picture in picture. Set by VoltPlayerView. */
    private var host: WeakReference<Activity>? = null
    private val prefs = app.getSharedPreferences("volt.player", Context.MODE_PRIVATE)

    private val lifecycle = object : DefaultLifecycleObserver {
        override fun onStop(owner: LifecycleOwner) { wentToBackground() }
        override fun onStart(owner: LifecycleOwner) { if (_state.value.playing) beacons?.resume(beaconNow, kbps) }
    }

    private fun buildExo(): ExoPlayer {
        val sources = DefaultMediaSourceFactory(app)
        if (options.cmcd) {
            sources.setCmcdConfigurationFactory { item ->
                CmcdConfiguration(sid, item.mediaId, object : CmcdConfiguration.RequestConfig {}, CmcdConfiguration.MODE_QUERY_PARAMETER)
            }
        }
        val audio = AudioAttributes.Builder().setUsage(C.USAGE_MEDIA)
            .setContentType(if (options.stationId != null) C.AUDIO_CONTENT_TYPE_MUSIC else C.AUDIO_CONTENT_TYPE_MOVIE).build()
        // Audio focus: pause for a call, duck for a navigation prompt, stop when another app plays.
        return ExoPlayer.Builder(app).setMediaSourceFactory(sources).setHandleAudioBecomingNoisy(true)
            .setAudioAttributes(audio, true)
            .setWakeMode(if (options.backgroundPlayback) C.WAKE_MODE_NETWORK else C.WAKE_MODE_NONE)
            .build()
    }

    private fun caps(): Caps {
        val pm = app.packageManager
        val pip = !isTv && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && pm.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
        return Caps(pip = pip, fullscreen = !isTv, cast = false, airplay = false, tv = isTv, pinQuality = true, backgroundAudio = options.backgroundPlayback)
    }

    // ---- Start ---------------------------------------------------------------

    private suspend fun start() {
        var items: List<PlaylistItem> = when {
            options.playlist != null -> Schedule.normalize(options.playlist!!)
            options.item != null -> listOf(options.item!!)
            options.source != null -> listOf(PlaylistItem(id = "source", source = options.source))
            (options.assetId ?: options.eventId) != null -> (options.assetId ?: options.eventId)!!.let { listOf(PlaylistItem(id = it, assetId = it)) }
            else -> emptyList()
        }
        // A station: its saved setup (theme) and its sources, unless the app gave its own.
        val sid0 = options.stationId
        if (sid0 != null && api != null) {
            api.stationSession(sid0)?.let { s ->
                _theme.value = ThemeTokens.resolve(s.theme, options.theme)
                if (items.isEmpty()) items = listOf(PlaylistItem(id = sid0, title = s.name, artworkUrl = s.artworkUrl, source = s.source, live = true))
            }
            pollNowPlaying(sid0)
        }
        options.epg?.let { g -> set { it.copy(schedule = g) } }
        options.epgChannelId?.let { pollGuide(it) }
        set { it.copy(items = items, index = options.startIndex.coerceIn(0, max(0, items.size - 1))) }
        // An event plays only when the control plane says it is live (or the replay is asked for):
        // pollEvent loads it then, on the first answer or any later one.
        if (options.eventId != null) {
            pollEvent()
            if (_state.value.presentation != Presentation.Live) set { it.copy(status = PlayerStatus.Idle) }
            return
        }
        if (items.isNotEmpty()) load(_state.value.index)
    }

    // ---- Loading an item -----------------------------------------------------

    private fun load(index: Int) {
        val st = _state.value
        if (index < 0 || index >= st.items.size) return
        loadJob?.cancel()
        // Stop the current item first: a next item that turns out locked or off air must not
        // leave the previous stream playing behind its panel, or let its callbacks change the status.
        exo?.stop()
        exo?.clearMediaItems()
        endBeacons()
        dismissed = null
        dateRanges.clear()
        presentationStart = null
        loadedIndex = -1
        started = false
        sid = newSid()
        set { it.copy(index = index, item = it.items[index], status = PlayerStatus.Loading, error = null, errorCode = null,
            qualities = emptyList(), quality = "auto", textTracks = emptyList(), audioTracks = emptyList(), upNext = null, skip = null) }
        emit(PlayerEventName.ItemChange, _state.value.item)
        loadJob = scope.launch { resolveAndPlay(index) }
    }

    private suspend fun resolveAndPlay(index: Int) {
        var it0 = _state.value.items[index]
        val asset = it0.assetId
        if (asset != null && api != null && (!Schedule.hasSource(it0.source) || it0.playbackToken == null)) {
            try {
                val r = api.resolve(asset, options.viewerToken, sid)
                it0 = mergeResolved(it0, r)
                set { it.copy(access = AccessState()) }
            } catch (e: CancellationException) { throw e
            } catch (e: GateError) {
                set { s -> s.copy(status = PlayerStatus.Locked, error = e.message,
                    access = AccessState(mode = AccessState.Mode.of(e.mode) ?: if (e.status == 451) AccessState.Mode.Blocked else null,
                        message = e.message, products = e.products)) }
                emit(PlayerEventName.Locked, e.message)
                return
            } catch (_: Exception) {
                fail(t("stopped"), "network"); return
            }
        }
        if (it0.brandMark == null) it0 = it0.copy(brandMark = options.brandMark)
        val item = it0
        set { s -> s.copy(items = s.items.toMutableList().also { l -> l[index] = item }, item = item) }
        val (url, mime) = playable(item.source) ?: run {
            set { it.copy(status = PlayerStatus.Offline, error = t("offline")) }
            return
        }
        attach(url, mime, item, index)
    }

    /**
     * HLS first: the stream's programme markers, up next, ad breaks and skip markers are
     * EXT-X-DATERANGE tags in the HLS playlists, so a DASH copy of the same CMAF would play
     * without them. DASH when there is no HLS, then progressive audio, then anything else.
     */
    private fun playable(s: Source?): Pair<String, String?>? {
        if (s == null) return null
        s.hls?.takeIf { it.isNotEmpty() }?.let { return it to MimeTypes.APPLICATION_M3U8 }
        s.dash?.takeIf { it.isNotEmpty() }?.let { return it to MimeTypes.APPLICATION_MPD }
        s.mp3?.takeIf { it.isNotEmpty() }?.let { return it to null }
        s.url?.takeIf { it.isNotEmpty() }?.let { u ->
            return u to when (Schedule.sourceKind(u)) {
                Schedule.SourceKind.Hls -> MimeTypes.APPLICATION_M3U8
                Schedule.SourceKind.Dash -> MimeTypes.APPLICATION_MPD
                else -> null
            }
        }
        return null
    }

    private fun attach(url: String, mime: String?, item: PlaylistItem, index: Int) {
        val e = exo ?: return
        val meta = MediaMetadata.Builder().setTitle(item.title).setSubtitle(item.subtitle)
            .setArtworkUri(item.artworkUrl?.let(Uri::parse)).build()
        val b = MediaItem.Builder().setUri(url).setMediaId(item.assetId ?: item.id).setMediaMetadata(meta)
        if (mime != null) b.setMimeType(mime)
        options.widevine?.let { w ->
            b.setDrmConfiguration(MediaItem.DrmConfiguration.Builder(C.WIDEVINE_UUID).setLicenseUri(w.licenseUrl)
                .setLicenseRequestHeaders(w.headers).setMultiSession(w.multiSession).build())
        }
        e.setMediaItem(b.build())
        val start = options.startAt
        if (start != null && item.live != true && index == options.startIndex) e.seekTo((start * 1000).toLong())
        e.prepare()
        e.playWhenReady = options.autoplay
        loadedIndex = index
        val token = item.playbackToken
        if (token != null && options.beacons && api != null) {
            beaconClock = SystemClock.elapsedRealtime()
            beacons = BeaconSession(token = token, id = sid, now = 0.0) { body -> beaconScope.launch { api.beacon(body) } }
        }
        startTicking()
        emit(PlayerEventName.Ready, null)
    }

    // ---- Watching the player -------------------------------------------------

    private val listener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying) {
                started = true
                set { it.copy(status = PlayerStatus.Playing, playing = true, buffering = false) }
                beacons?.playing(beaconNow, kbps)
                emit(PlayerEventName.Play, null)
            } else {
                val s = _state.value.status
                if (s != PlayerStatus.Ended && s != PlayerStatus.Error && s != PlayerStatus.Locked && s != PlayerStatus.Offline
                    && exo?.playbackState != Player.STATE_BUFFERING) {
                    set { it.copy(status = if (exo?.playbackState == Player.STATE_READY) PlayerStatus.Paused else it.status, playing = false) }
                    emit(PlayerEventName.Pause, null)
                } else set { it.copy(playing = false) }
            }
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            when (playbackState) {
                Player.STATE_BUFFERING -> set { it.copy(buffering = true, status = if (it.status == PlayerStatus.Loading) it.status else PlayerStatus.Buffering) }
                Player.STATE_READY -> set {
                    val status = when {
                        exo?.isPlaying == true -> PlayerStatus.Playing
                        it.status == PlayerStatus.Loading || it.status == PlayerStatus.Buffering ->
                            if (exo?.playWhenReady == true) PlayerStatus.Buffering else if (started) PlayerStatus.Paused else PlayerStatus.Ready
                        else -> it.status
                    }
                    it.copy(buffering = false, status = status)
                }
                Player.STATE_ENDED -> ended()
                else -> {}
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            // Paused longer than the DVR window: carry on from the live edge, as the other players do.
            if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                exo?.seekToDefaultPosition(); exo?.prepare(); return
            }
            fail(readable(error), error.errorCodeName)
        }

        override fun onTracksChanged(tracks: Tracks) { readTracks(tracks) }

        override fun onTimelineChanged(timeline: Timeline, reason: Int) { readManifest() }

        override fun onVideoSizeChanged(videoSize: VideoSize) { set { it.copy(hasPicture = videoSize.width > 0) } }

        override fun onMetadata(metadata: Metadata) { readMetadata(metadata) }

        override fun onPlaybackParametersChanged(playbackParameters: PlaybackParameters) {
            set { it.copy(rate = playbackParameters.speed.toDouble()) }
        }
    }

    // Runs after every property above (the listener included) is initialised.
    init {
        val demo = options.demo
        if (demo != null) {
            _state.value = demo
        } else {
            val e = exo!!
            e.volume = if (options.muted) 0f else 1f
            _state.value = _state.value.copy(muted = options.muted, caps = caps())
            e.addListener(listener)
            if (options.rememberSubtitleLanguage) prefs.getString("textLang", null)?.let { lang ->
                e.trackSelectionParameters = e.trackSelectionParameters.buildUpon().setPreferredTextLanguage(lang).build()
            }
            if (options.mediaSession) {
                // Tapping the media notification opens the app.
                val open = app.packageManager.getLaunchIntentForPackage(app.packageName)?.let {
                    PendingIntent.getActivity(app, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                }
                mediaSession = MediaSession.Builder(app, e).setId("volt-${UUID.randomUUID()}").apply { open?.let(::setSessionActivity) }.build()
                if (options.backgroundPlayback) connectService()
            }
            ProcessLifecycleOwner.get().lifecycle.addObserver(lifecycle)
            scope.launch { start() }
        }
    }

    private fun startTicking() {
        if (tickJob?.isActive == true) return
        tickJob = scope.launch {
            while (isActive) { derive(); delay(500) }
        }
    }

    private val beaconNow: Double get() = (SystemClock.elapsedRealtime() - beaconClock) / 1000.0
    private val kbps: Int? get() {
        val br = exo?.videoFormat?.bitrate?.takeIf { it > 0 } ?: exo?.audioFormat?.bitrate?.takeIf { it > 0 } ?: return null
        return Math.round(br / 1000.0).toInt()
    }

    /** The timeline window: live or not, the seekable range, and the wall clock of position 0. */
    private fun window(): Timeline.Window? {
        val e = exo ?: return null
        val tl = e.currentTimeline
        if (tl.isEmpty) return null
        return tl.getWindow(e.currentMediaItemIndex, Timeline.Window())
    }

    /** The state from the engine, every half second (Derive.run, tested in :core). */
    private fun derive() {
        val e = exo ?: return
        if (loadedIndex < 0) return
        val w = window()
        val live = w?.isLive() == true
        val cur = e.currentPosition / 1000.0
        val durMs = w?.durationMs ?: C.TIME_UNSET
        var seek: SeekWindow? = null
        if (durMs != C.TIME_UNSET && durMs > 0) {
            // On live the end is the live edge Media3 holds to (the target offset), not the last segment.
            val end = if (live && w!!.defaultPositionMs != C.TIME_UNSET) max(w.defaultPositionMs, 0L) / 1000.0 else durMs / 1000.0
            seek = SeekWindow(0.0, max(end, cur))
        }
        if (w != null && w.windowStartTimeMs != C.TIME_UNSET) presentationStart = w.windowStartTimeMs.toDouble()
        val duration = if (live || durMs == C.TIME_UNSET) Double.NaN else durMs / 1000.0
        val ps = presentationStart
        val graphics: List<StreamGraphic> = if (ps != null) Triggers.graphics(dateRanges.values.toList(), ps) else emptyList()
        val th = _theme.value
        val st = _state.value
        val d = Derive.run(DeriveInput(
            engine = EngineSnapshot(cur, duration, live, seek, ps), now = System.currentTimeMillis().toDouble(),
            schedule = st.schedule, graphics = graphics, graphicsOn = options.showGraphics ?: th.showGraphics,
            upNextOn = th.controls.upNext, skipOn = th.controls.skip, upNextSeconds = th.upNextSeconds, autoAdvance = th.autoAdvance,
            items = st.items, index = st.index, dismissed = dismissed))
        beacons?.time(cur, paused = !st.playing)
        beacons?.tick(beaconNow, kbps)
        if (d.programme?.id != lastProgrammeId) {
            lastProgrammeId = d.programme?.id
            d.programme?.let { emit(PlayerEventName.ProgrammeChange, it) }
        }
        if (d.upNext != null && st.upNext == null) emit(PlayerEventName.UpNext, d.upNext)
        val active = activeQuality()
        val activity = host?.get()
        val pipActive = activity != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && activity.isInPictureInPictureMode
        set {
            it.copy(currentTime = cur, duration = duration, live = live, seekable = seek, dvr = d.dvr, atLiveEdge = d.atLiveEdge,
                behindLive = d.behindLive, wallClock = d.wallClock, programme = d.programme, nextProgramme = d.nextProgramme,
                canStartOver = d.canStartOver, graphics = d.graphics, adBreak = d.adBreak, upNext = d.upNext, skip = d.skip,
                activeQuality = active, pip = it.pip.copy(available = it.caps.pip && activity != null && it.hasPicture, active = pipActive),
                msToStart = EventRules.msToStart(it.event, System.currentTimeMillis().toDouble()) ?: it.msToStart)
        }
        d.dismissKey?.let { currentCardKey = it }
        updateAutoPip()
    }

    /**
     * Android 12+: going Home while a video plays enters picture in picture by itself, as iOS
     * does from inline. Only while something with a picture is playing.
     */
    private fun updateAutoPip() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !options.autoPictureInPicture) return
        val a = host?.get() ?: return
        val st = _state.value
        val on = st.caps.pip && st.playing && st.hasPicture
        if (on == autoPipOn) return
        autoPipOn = on
        try { a.setPictureInPictureParams(PictureInPictureParams.Builder().setAutoEnterEnabled(on).setAspectRatio(pipRatio()).build()) } catch (_: Exception) { }
    }

    private fun pipRatio(): Rational {
        val v = exo?.videoSize
        val ratio = if (v != null && v.width > 0 && v.height > 0) Rational(v.width, v.height) else Rational(16, 9)
        // Android allows 1:2.39 to 2.39:1; anything wider is clamped.
        return if (ratio.toFloat() > 2.39f) Rational(239, 100) else if (ratio.toFloat() < 0.42f) Rational(100, 239) else ratio
    }

    /** The media playlist's EXT-X-DATERANGE tags: programmes, up next, ad breaks, skip markers. */
    private fun readManifest() {
        val m = exo?.currentManifest as? HlsManifest ?: return
        val ranges = Triggers.parseDateRangeLines(m.mediaPlaylist.tags)
        for (r in ranges) dateRanges[r.id.ifEmpty { "${r.cls}@${r.startDate}" }] = r
        // Forget what ended more than an hour before the playlist starts.
        val horizon = (presentationStart ?: return) - 3_600_000
        dateRanges.entries.removeAll { (_, r) -> (r.endDate ?: Double.MAX_VALUE) < horizon }
    }

    private fun readTracks(tracks: Tracks) {
        val video = mutableListOf<Schedule.VariantInput>()
        val audioOnly = mutableListOf<Schedule.VariantInput>()
        val texts = mutableListOf<TextTrackInfo>()
        val audios = mutableListOf<AudioTrackInfo>()
        var selectedText: String? = null
        var selectedAudio: String? = null
        trackRefs.clear()
        tracks.groups.forEachIndexed { gi, g ->
            for (i in 0 until g.length) {
                if (!g.isTrackSupported(i)) continue
                val f = g.getTrackFormat(i)
                val id = "$gi:$i"
                trackRefs[id] = Triple(g.mediaTrackGroup.id, i, g.type)
                when (g.type) {
                    C.TRACK_TYPE_VIDEO -> video += Schedule.VariantInput(id, f.height.takeIf { it > 0 }, f.width.takeIf { it > 0 },
                        (if (f.peakBitrate > 0) f.peakBitrate else f.bitrate).coerceAtLeast(0).toDouble())
                    C.TRACK_TYPE_AUDIO -> {
                        audioOnly += Schedule.VariantInput(id, null, null, (if (f.peakBitrate > 0) f.peakBitrate else f.bitrate).coerceAtLeast(0).toDouble())
                        audios += AudioTrackInfo(id, f.language ?: "", f.label ?: languageName(f.language) ?: "Audio ${audios.size + 1}",
                            f.channelCount.takeIf { it > 0 })
                        if (g.isTrackSelected(i)) selectedAudio = id
                    }
                    C.TRACK_TYPE_TEXT -> {
                        texts += TextTrackInfo(id, f.language ?: "", f.label ?: languageName(f.language) ?: "Subtitles ${texts.size + 1}",
                            if ((f.roleFlags and C.ROLE_FLAG_DESCRIBES_MUSIC_AND_SOUND) != 0) "captions" else "subtitles")
                        if (g.isTrackSelected(i)) selectedText = id
                    }
                }
            }
        }
        val qualities = if (video.isNotEmpty()) Schedule.qualityList(video)
            else if (audioOnly.distinctBy { it.bandwidth }.size > 1) Schedule.qualityList(audioOnly) else emptyList()
        // One language, several bitrates is a ladder, not a choice of language.
        val audioChoices = audios.distinctBy { it.lang to it.label }
        set {
            it.copy(qualities = qualities, audioOnly = video.isEmpty() && audioOnly.isNotEmpty(), textTracks = texts, textTrack = selectedText,
                audioTracks = if (audioChoices.size > 1) audioChoices else emptyList(), audioTrack = if (audioChoices.size > 1) selectedAudio else null)
        }
    }

    private fun languageName(tag: String?): String? = tag?.takeIf { it.isNotEmpty() && it != "und" }?.let {
        Locale.forLanguageTag(it).getDisplayName(Locale.getDefault()).ifEmpty { null }?.replaceFirstChar { c -> c.titlecase(Locale.getDefault()) }
    }

    private fun activeQuality(): Quality? {
        val f = exo?.videoFormat ?: return null
        val q = _state.value.qualities
        if (q.isEmpty()) return null
        return q.firstOrNull { it.height == f.height } ?: q.minByOrNull { abs(it.bitrate - f.bitrate) }
    }

    /** Timed ID3 (radio now playing carried in the stream) and Icecast titles. */
    private fun readMetadata(m: Metadata) {
        if (options.stationId != null) return // the station's own feed is richer
        var title: String? = null; var artist: String? = null; var album: String? = null
        for (i in 0 until m.length()) {
            when (val e = m.get(i)) {
                is TextInformationFrame -> when (e.id) {
                    "TIT2" -> title = e.values.firstOrNull() ?: title
                    "TPE1" -> artist = e.values.firstOrNull() ?: artist
                    "TALB" -> album = e.values.firstOrNull() ?: album
                }
                is IcyInfo -> e.title?.let { raw ->
                    val parts = raw.split(" - ", limit = 2)
                    if (parts.size == 2) { artist = parts[0].trim(); title = parts[1].trim() } else title = raw.trim()
                }
            }
        }
        val tt = title?.takeIf { it.isNotEmpty() } ?: return
        set { it.copy(nowPlaying = TrackInfo(title = tt, artist = artist, album = album, startedAt = System.currentTimeMillis().toDouble())) }
    }

    /** Let go of the stream (an event that is no longer live, or before a new item). */
    private fun stopPlayback(status: PlayerStatus) {
        loadJob?.cancel()
        exo?.stop(); exo?.clearMediaItems()
        endBeacons()
        loadedIndex = -1
        set { it.copy(status = status, playing = false, buffering = false) }
    }

    private fun ended() {
        endBeacons()
        val st = _state.value
        if (!st.live && st.index + 1 < st.items.size && _theme.value.autoAdvance && dismissed != "i:${st.index}") { next(); return }
        set { it.copy(status = PlayerStatus.Ended, playing = false) }
        emit(PlayerEventName.Ended, null)
    }

    private fun fail(message: String, code: String?) {
        set { it.copy(status = PlayerStatus.Error, playing = false, buffering = false, error = message, errorCode = code) }
        emit(PlayerEventName.Error, message)
    }

    private fun readable(e: PlaybackException): String {
        val cause = e.cause
        if (cause is HttpDataSource.InvalidResponseCodeException && (cause.responseCode == 404 || cause.responseCode == 410)) return t("offline")
        return when (e.errorCode) {
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "You're offline."
            PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW -> t("stopped")
            else -> t("stopped")
        }
    }

    private fun wentToBackground() {
        // A video in the background has nobody watching; audio and picture in picture do.
        val st = _state.value
        if (st.hasPicture && !st.pip.active) {
            if (!options.backgroundPlayback) exo?.pause()
            beacons?.end()
        }
    }

    private fun endBeacons() { beacons?.end(); beacons = null }

    // ---- Polling -------------------------------------------------------------

    private fun pollGuide(channelId: String) {
        val a = api ?: return
        pollJobs += scope.launch {
            while (isActive) {
                val g = a.schedule(channelId)
                if (g.isNotEmpty()) set { it.copy(schedule = g) }
                delay(5 * 60_000L)
            }
        }
    }

    private fun pollNowPlaying(stationId: String) {
        val a = api ?: return
        pollJobs += scope.launch {
            while (isActive) {
                a.nowPlaying(stationId)?.let { np -> set { it.copy(nowPlaying = np.nowPlaying, history = np.history, nextTrack = np.next) } }
                delay(15_000L)
            }
        }
    }

    private suspend fun pollEvent(): EventInfo? {
        val id = options.eventId ?: return null
        val a = api ?: return null
        val e = a.event(id)
        if (e != null) {
            val was = _state.value.presentation
            set { it.copy(event = e, presentation = e.presentation, msToStart = EventRules.msToStart(e, System.currentTimeMillis().toDouble())) }
            if (was != e.presentation) emit(PlayerEventName.PresentationChange, e.presentation.wire)
            val st = _state.value
            // Live now and nothing loaded: load the stream. The phase came from the control plane, not this clock.
            if (e.presentation == Presentation.Live && !liveLoadStarted && !st.replaying && loadedIndex < 0 && loadJob?.isActive != true && st.items.isNotEmpty()) {
                liveLoadStarted = true
                load(st.index)
            }
            // No longer live (ended, offline, postponed): stop, so nothing plays behind the promo screen.
            if (was == Presentation.Live && e.presentation != Presentation.Live && !st.replaying) { liveLoadStarted = false; stopPlayback(PlayerStatus.Idle) }
        }
        eventJob?.cancel()
        eventJob = scope.launch {
            val st = _state.value
            delay((EventRules.pollDelay(st.presentation, st.msToStart) * 1000).toLong())
            pollEvent()
        }
        return e
    }

    // ---- Commands ------------------------------------------------------------

    override fun play() {
        val e = exo ?: return
        val s = _state.value.status
        if (s == PlayerStatus.Error || s == PlayerStatus.Offline || loadedIndex < 0) { load(_state.value.index); return }
        if (s == PlayerStatus.Ended) e.seekTo(0)
        e.play()
    }
    override fun pause() { exo?.pause() }
    override fun toggle() { if (_state.value.playing) pause() else play() }
    override fun seek(seconds: Double) {
        beacons?.seeking()
        exo?.seekTo((max(0.0, seconds) * 1000).toLong())
    }
    override fun seekBy(delta: Double) {
        // From the engine's position, not the last state tick, so three quick presses are three steps.
        var to = (exo?.currentPosition?.div(1000.0) ?: _state.value.currentTime) + delta
        val d = _state.value.duration
        if (!_state.value.live && d.isFinite()) to = min(max(0.0, to), d)
        _state.value.seekable?.let { w -> to = min(max(w.start, to), w.end) }
        seek(to)
    }
    override fun goLive() {
        val e = exo ?: return
        beacons?.seeking()
        e.seekToDefaultPosition()
        e.play()
    }
    override fun adClick() { /* On-demand ad overlay: not in this release (ads are stitched for Android). */ }
    override fun startOver() {
        val p = _state.value.programme ?: return
        val r = Schedule.startOverTarget(p.startsAt, presentationStart, _state.value.seekable) ?: return
        seek(r.seconds)
    }
    override fun setQuality(id: String) {
        val e = exo ?: return
        val b = e.trackSelectionParameters.buildUpon()
        // Auto clears only the picture size: the viewer's audio language stays as chosen.
        val type = if (_state.value.audioOnly) C.TRACK_TYPE_AUDIO else C.TRACK_TYPE_VIDEO
        if (id == "auto") b.clearOverridesOfType(type)
        else trackOf(id, type)?.let { (g, i) -> b.setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, listOf(i))) }
        e.trackSelectionParameters = b.build()
        set { it.copy(quality = id) }
        emit(PlayerEventName.QualityChange, id)
    }
    override fun setTextTrack(id: String?) {
        val e = exo ?: return
        val b = e.trackSelectionParameters.buildUpon()
        if (id == null) {
            b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            if (options.rememberSubtitleLanguage) prefs.edit().remove("textLang").apply()
        } else trackOf(id, C.TRACK_TYPE_TEXT)?.let { (g, i) ->
            b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false).setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, listOf(i)))
            val lang = g.getTrackFormat(i).language
            if (options.rememberSubtitleLanguage && lang != null) prefs.edit().putString("textLang", lang).apply()
        }
        e.trackSelectionParameters = b.build()
        set { it.copy(textTrack = id) }
    }
    override fun setAudioTrack(id: String) {
        val e = exo ?: return
        val (g, i) = trackOf(id, C.TRACK_TYPE_AUDIO) ?: return
        e.trackSelectionParameters = e.trackSelectionParameters.buildUpon().setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, listOf(i))).build()
        set { it.copy(audioTrack = id) }
    }
    /**
     * A menu id back to the Media3 group and index, matched on the group's own id and type, so a
     * menu drawn before the tracks changed can never select a different group or a different kind.
     */
    private fun trackOf(id: String, type: Int): Pair<Tracks.Group, Int>? {
        val (groupId, i, t) = trackRefs[id] ?: return null
        if (t != type) return null
        val g = exo?.currentTracks?.groups?.firstOrNull { it.mediaTrackGroup.id == groupId && it.type == type } ?: return null
        return if (i in 0 until g.length) g to i else null
    }
    override fun setVolume(v: Double) {
        val x = v.coerceIn(0.0, 1.0)
        exo?.volume = x.toFloat()
        set { it.copy(volume = x, muted = x == 0.0) }
    }
    override fun toggleMute() {
        val e = exo ?: return
        val mute = !_state.value.muted
        e.volume = if (mute) 0f else _state.value.volume.toFloat().takeIf { it > 0 } ?: 1f
        set { it.copy(muted = mute) }
    }
    override fun setRate(r: Double) { exo?.setPlaybackSpeed(r.toFloat()); set { it.copy(rate = r) } }
    override fun next() { val s = _state.value; if (s.index + 1 < s.items.size) load(s.index + 1) }
    override fun previous() { val s = _state.value; if (s.currentTime > 5 || s.index == 0) seek(0.0) else load(s.index - 1) }
    override fun playItem(index: Int) { load(index) }
    override fun cancelUpNext() { dismissed = currentCardKey; set { it.copy(upNext = null) } }
    override fun skip() {
        val s = _state.value
        val sk = s.skip ?: return
        if (sk.kind == "credits" && s.index + 1 < s.items.size) next() else seek(sk.to)
    }
    override fun toggleFullscreen() { if (!isTv) set { it.copy(fullscreen = !it.fullscreen) } }
    override fun togglePip() {
        val a = host?.get() ?: return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !_state.value.caps.pip) return
        try { a.enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(pipRatio()).build()) } catch (_: Exception) { }
    }
    /** Chromecast needs the Cast framework in the app; this release reports it unavailable. */
    override fun cast() {}
    /** AirPlay is Apple only. */
    override fun airplay() {}
    override fun purchase(productKey: String) {
        val s = _state.value
        val p = s.access.products.firstOrNull { it.productKey == productKey }
        val tpl = options.purchaseUrl
        if (tpl != null) {
            open(Gate.fillUrl(tpl, mapOf("productKey" to productKey, "assetId" to (s.item?.assetId ?: options.eventId),
                "price" to p?.let { "%.2f".format(Locale.US, it.priceCents / 100.0) }, "currency" to p?.currency)))
        } else emit(PlayerEventName.Purchase, mapOf("productKey" to productKey, "assetId" to s.item?.assetId))
    }
    override fun signIn() {
        val tpl = options.signInUrl
        if (tpl != null) open(Gate.fillUrl(tpl, mapOf("assetId" to (_state.value.item?.assetId ?: options.eventId))))
        else emit(PlayerEventName.SignIn, mapOf("assetId" to _state.value.item?.assetId))
    }
    private fun open(url: String) {
        try { app.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) { }
    }
    override fun playReplay() {
        val r = _state.value.event?.replayAssetId ?: return
        set { it.copy(items = listOf(PlaylistItem(id = r, assetId = r)), replaying = true) }
        load(0)
    }
    override fun refreshAccess() { loadedIndex = -1; load(_state.value.index) }
    override fun toggleStats(on: Boolean?) { set { it.copy(stats = on ?: !it.stats) }; emit(PlayerEventName.StatsChange, _state.value.stats) }

    /** Change the viewer (after sign-in or a purchase) and ask the gate again. */
    fun setViewerToken(token: String?) { options = options.copy(viewerToken = token); refreshAccess() }
    /** The console's live preview: change the theme without reloading. */
    fun setTheme(theme: Theme?) { _theme.value = ThemeTokens.resolve(options.theme, theme) }
    fun setSkin(id: String) { _skinId.value = id; emit(PlayerEventName.SkinChange, id) }

    /** The view hands over its Activity, for picture in picture. */
    fun attachHost(activity: Activity?) { host = activity?.let { WeakReference(it) }; autoPipOn = null }

    /** Stop everything: beacons end, polling stops, the player lets go of the stream and the session. */
    fun destroy() {
        endBeacons()
        scope.cancel()
        ProcessLifecycleOwner.get().lifecycle.removeObserver(lifecycle)
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controllerFuture = null
        VoltPlaybackService.release(mediaSession)
        mediaSession?.release(); mediaSession = null
        exo?.removeListener(listener)
        exo?.release()
    }

    // ---- Background playback ------------------------------------------------

    /** Binds VoltPlaybackService, which hands the system this player's session (notification, lock screen). */
    private fun connectService() {
        val s = mediaSession ?: return
        VoltPlaybackService.offer(s)
        controllerFuture = MediaController.Builder(app, SessionToken(app, ComponentName(app, VoltPlaybackService::class.java))).buildAsync()
    }

    // ---- Plumbing ------------------------------------------------------------

    private fun set(change: (PlayerState) -> PlayerState) {
        val s = change(_state.value)
        if (s != _state.value) { _state.value = s; emit(PlayerEventName.State, null) }
    }

    private fun emit(name: PlayerEventName, detail: Any?) {
        val cb = options.onEvent ?: return
        cb(name, detail)
    }

    companion object {
        private fun newSid() = "android-${UUID.randomUUID().toString().lowercase()}"

        /** Android TV, Google TV, Fire TV. */
        fun isTelevision(context: Context): Boolean {
            val ui = context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
            if (ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION) return true
            val pm = context.packageManager
            return pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) || pm.hasSystemFeature("amazon.hardware.fire_tv")
        }

        internal fun findActivity(context: Context): Activity? {
            var c: Context? = context
            while (c is ContextWrapper) { if (c is Activity) return c; c = c.baseContext }
            return null
        }
    }
}
