// ============================================================================
//  A DEMO APP for the Volt player SDK on Android phones, tablets and TVs.
//
//  Set your Volt address and the publishable key of an app of type Android in
//  local.properties (see demo/build.gradle.kts), then run it. Without them the
//  public test stream and the skins in demo mode still work.
//
//    A public test stream   plays with no server at all
//    A channel              the play gate, the guide, Start over, Go live
//    An event               countdown, phases, paywall, live, replay
//    A radio station        its Player setup theme and now playing
//    Skins in demo mode     every built-in skin drawing a sample state
//
//  On a TV the same app opens with the D-pad and plays in the `tv` skin.
// ============================================================================
package com.volt.player.demo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.volt.player.VoltPlayer
import com.volt.player.VoltPlayerOptions
import com.volt.player.core.EventInfo
import com.volt.player.core.EventPromo
import com.volt.player.core.PlayerState
import com.volt.player.core.PlayerStatus
import com.volt.player.core.PlaylistItem
import com.volt.player.core.Presentation
import com.volt.player.core.Programme
import com.volt.player.core.PromoSide
import com.volt.player.core.Quality
import com.volt.player.core.SeekWindow
import com.volt.player.core.Source
import com.volt.player.core.TextTrackInfo
import com.volt.player.core.Theme
import com.volt.player.core.TrackInfo
import com.volt.player.core.UpNext
import com.volt.player.ui.VoltPlayerView

private const val TEST_STREAM = "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8"

class DemoActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { DemoApp() }
    }
}

private enum class Screen(val title: String, val needsServer: Boolean) {
    Url("A public test stream", false),
    Channel("A channel (play gate, guide)", true),
    Event("An event (countdown, paywall, replay)", true),
    Station("A radio station (now playing)", true),
    Skins("Every skin in demo mode", false),
}

private val configured get() = BuildConfig.VOLT_API.isNotEmpty() && BuildConfig.VOLT_KEY.isNotEmpty()

@Composable
private fun DemoApp() {
    var screen by remember { mutableStateOf<Screen?>(null) }
    BackHandler(enabled = screen != null) { screen = null }
    Box(Modifier.fillMaxSize().background(Color(0xFF0B0E13))) {
        when (screen) {
            null -> Home { screen = it }
            Screen.Url -> PlayerScreen(VoltPlayerOptions(source = Source(hls = TEST_STREAM), theme = Theme(primary = "#e11d48", radius = 4.0)))
            Screen.Channel -> PlayerScreen(VoltPlayerOptions(apiBase = BuildConfig.VOLT_API, appKey = BuildConfig.VOLT_KEY,
                assetId = BuildConfig.VOLT_CHANNEL, epgChannelId = BuildConfig.VOLT_CHANNEL))
            Screen.Event -> PlayerScreen(VoltPlayerOptions(apiBase = BuildConfig.VOLT_API, appKey = BuildConfig.VOLT_KEY, eventId = BuildConfig.VOLT_EVENT,
                purchaseUrl = "https://shop.example.com/buy?p={productKey}&e={assetId}"))
            Screen.Station -> PlayerScreen(VoltPlayerOptions(apiBase = BuildConfig.VOLT_API, appKey = BuildConfig.VOLT_KEY,
                stationId = BuildConfig.VOLT_STATION, backgroundPlayback = true), audio = true)
            Screen.Skins -> DemoSkins()
        }
    }
}

@Composable
private fun Home(open: (Screen) -> Unit) {
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    LazyColumn(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Text("Volt player SDK", style = TextStyle(color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)) }
        if (!configured) item {
            Text("Set volt.apiBase and volt.appKey in local.properties for the channel, event and station demos.",
                style = TextStyle(color = Color(0xA8FFFFFF), fontSize = 13.sp))
        }
        items(Screen.entries.toList()) { s ->
            val enabled = !s.needsServer || configured
            var focused by remember { mutableStateOf(false) }
            Text(s.title,
                style = TextStyle(color = if (enabled) Color.White else Color(0x66FFFFFF), fontSize = 17.sp),
                modifier = Modifier.fillMaxWidth()
                    .then(if (s == Screen.Url) Modifier.focusRequester(first) else Modifier)
                    .onFocusChanged { focused = it.isFocused }
                    .clip(RoundedCornerShape(10.dp))
                    .border(if (focused) 3.dp else 0.dp, if (focused) Color(0xFF3F7BFF) else Color.Transparent, RoundedCornerShape(10.dp))
                    .background(Color(0xFF161B24))
                    .clickable(enabled = enabled) { open(s) }
                    .padding(18.dp))
        }
    }
}

@Composable
private fun PlayerScreen(options: VoltPlayerOptions, audio: Boolean = false) {
    val context = LocalContext.current
    val player = remember { VoltPlayer(context, options) }
    DisposableEffect(player) { onDispose { player.destroy() } }
    if (player.isTv || !audio) VoltPlayerView(player, Modifier.fillMaxSize().let { if (player.isTv) it else it.aspectRatio(16 / 9f, matchHeightConstraintsFirst = false) })
    else VoltPlayerView(player, Modifier.fillMaxWidth().height(520.dp))
}

/** Every built-in skin in demo mode: no stream, any state. How skins are designed and checked. */
@Composable
private fun DemoSkins() {
    val context = LocalContext.current
    // The tv skin is shown on a TV, where it is driven by the remote.
    val skins = listOf(if (VoltPlayer.isTelevision(context)) "tv" else "video", "event", "audio_square", "audio_nowplaying")
    val players = remember { skins.associateWith { VoltPlayer(context, VoltPlayerOptions(skin = it, demo = demoState())) } }
    DisposableEffect(Unit) { onDispose { players.values.forEach { it.destroy() } } }
    LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
        items(skins) { id ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(id, style = TextStyle(color = Color(0xA8FFFFFF), fontSize = 12.sp, fontFamily = FontFamily.Monospace))
                val p = players.getValue(id)
                when (id) {
                    "audio_square" -> VoltPlayerView(p, Modifier.size(220.dp))
                    "audio_nowplaying" -> VoltPlayerView(p, Modifier.fillMaxWidth().height(460.dp))
                    else -> VoltPlayerView(p, Modifier.fillMaxWidth().aspectRatio(16 / 9f))
                }
            }
        }
    }
}

private fun demoState(): PlayerState {
    val now = System.currentTimeMillis().toDouble()
    return PlayerState(
        status = PlayerStatus.Paused, live = true, dvr = true, atLiveEdge = false, behindLive = 42.0,
        seekable = SeekWindow(0.0, 3600.0), currentTime = 3558.0, wallClock = now - 42_000,
        item = PlaylistItem(id = "demo", title = "News 24", live = true),
        programme = Programme(id = "p1", title = "The Morning Show", subtitle = "News, weather and guests", startsAt = now - 1_800_000, endsAt = now + 1_800_000),
        nextProgramme = Programme(id = "p2", title = "Midday Report", startsAt = now + 1_800_000, endsAt = now + 5_400_000),
        schedule = listOf(
            Programme(id = "p0", title = "Early News", startsAt = now - 3_600_000, endsAt = now - 1_800_000),
            Programme(id = "p1", title = "The Morning Show", startsAt = now - 1_800_000, endsAt = now + 1_800_000),
            Programme(id = "p2", title = "Midday Report", startsAt = now + 1_800_000, endsAt = now + 5_400_000),
        ),
        canStartOver = true,
        upNext = UpNext(UpNext.Kind.Programme, "Midday Report", inMs = 90_000.0, autoAdvance = false, totalMs = 120_000.0, startsAt = now + 90_000, source = UpNext.From.Guide),
        qualities = listOf(Quality("1", 1080, 1920, 6e6, "1080p"), Quality("2", 720, 1280, 3e6, "720p")),
        textTracks = listOf(TextTrackInfo("0", "en", "English", "subtitles")),
        nowPlaying = TrackInfo(title = "Harbour Lights", artist = "The Night Ferries", album = "Low Tide", year = 2025),
        history = listOf(TrackInfo(title = "Long Way Round", artist = "Sun Engine", startedAt = now - 240_000)),
        event = EventInfo(id = "e1", title = "Grand Final", startsAt = now + 2 * 86_400_000 + 5 * 3_600_000, endsAt = null, presentation = Presentation.Pre,
            promo = EventPromo(EventPromo.Template.Versus, headline = "Premiership 2026", sides = listOf(PromoSide("Harbour City"), PromoSide("Northline")))),
        presentation = Presentation.Pre,
    )
}
