// Every built-in skin drawing a sample state, rendered with no device: the quickest way to see
// what a theme or a layout change does. Run ./gradlew :player:recordPaparazziDebug and look in
// player/src/test/snapshots/images.
package com.volt.player.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.android.resources.Density
import com.android.resources.ScreenOrientation
import com.volt.player.core.AccessState
import com.volt.player.core.EventInfo
import com.volt.player.core.EventPromo
import com.volt.player.core.PlayerState
import com.volt.player.core.PlayerStatus
import com.volt.player.core.PlaylistItem
import com.volt.player.core.Presentation
import com.volt.player.core.Product
import com.volt.player.core.Programme
import com.volt.player.core.PromoSide
import com.volt.player.core.Quality
import com.volt.player.core.SeekWindow
import com.volt.player.core.TextTrackInfo
import com.volt.player.core.Theme
import com.volt.player.core.ThemeTokens
import com.volt.player.core.TrackInfo
import com.volt.player.core.Translator
import com.volt.player.core.UpNext
import com.volt.player.core.VoltCommands
import org.junit.Rule
import org.junit.Test

/** Commands that do nothing: a skin drawn without a player. */
private object NoCommands : VoltCommands {
    override fun play() {}; override fun pause() {}; override fun toggle() {}; override fun seek(seconds: Double) {}
    override fun seekBy(delta: Double) {}; override fun goLive() {}; override fun adClick() {}; override fun startOver() {}
    override fun setQuality(id: String) {}; override fun setTextTrack(id: String?) {}; override fun setAudioTrack(id: String) {}
    override fun setVolume(v: Double) {}; override fun toggleMute() {}; override fun setRate(r: Double) {}; override fun next() {}
    override fun previous() {}; override fun playItem(index: Int) {}; override fun cancelUpNext() {}; override fun skip() {}
    override fun toggleFullscreen() {}; override fun togglePip() {}; override fun cast() {}; override fun airplay() {}
    override fun purchase(productKey: String) {}; override fun signIn() {}; override fun playReplay() {}; override fun refreshAccess() {}
    override fun toggleStats(on: Boolean?) {}
}

class SkinScreenshots {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5, maxPercentDifference = 100.0)

    private val now = System.currentTimeMillis().toDouble()

    private fun state(status: PlayerStatus = PlayerStatus.Paused) = PlayerState(
        status = status, live = true, dvr = true, atLiveEdge = false, behindLive = 42.0, hasPicture = true,
        seekable = SeekWindow(0.0, 3600.0), currentTime = 3558.0, wallClock = now - 42_000,
        item = PlaylistItem(id = "demo", title = "News 24", live = true),
        programme = Programme(id = "p1", title = "The Morning Show", subtitle = "News, weather and guests", startsAt = now - 1_800_000, endsAt = now + 1_800_000),
        nextProgramme = Programme(id = "p2", title = "Midday Report", startsAt = now + 1_800_000, endsAt = now + 5_400_000),
        schedule = listOf(
            Programme(id = "p0", title = "Early News", startsAt = now - 3_000_000, endsAt = now - 1_800_000),
            Programme(id = "p1", title = "The Morning Show", startsAt = now - 1_800_000, endsAt = now + 1_800_000),
            Programme(id = "p2", title = "Midday Report", startsAt = now + 1_800_000, endsAt = now + 5_400_000),
        ),
        canStartOver = true,
        upNext = UpNext(UpNext.Kind.Programme, "Midday Report", inMs = 90_000.0, autoAdvance = false, totalMs = 120_000.0, startsAt = now + 90_000, source = UpNext.From.Guide),
        qualities = listOf(Quality("1", 1080, 1920, 6e6, "1080p"), Quality("2", 720, 1280, 3e6, "720p")),
        textTracks = listOf(TextTrackInfo("0", "en", "English", "subtitles")),
        nowPlaying = TrackInfo(title = "Harbour Lights", artist = "The Night Ferries", album = "Low Tide", year = 2025),
        history = listOf(TrackInfo(title = "Long Way Round", artist = "Sun Engine", startedAt = now - 240_000),
            TrackInfo(title = "Glass Coast", artist = "Mirrorball", startedAt = now - 480_000)),
        nextTrack = TrackInfo(title = "Northern Line", artist = "Calla"),
        event = EventInfo(id = "e1", title = "Grand Final", startsAt = now + 2 * 86_400_000 + 5 * 3_600_000, endsAt = null, presentation = Presentation.Pre,
            promo = EventPromo(EventPromo.Template.Versus, headline = "Premiership 2026", sides = listOf(PromoSide("Harbour City"), PromoSide("Northline")))),
        presentation = Presentation.Pre,
    )

    /** A stand-in picture: a gradient, so the chrome over it can be judged. */
    private val picture: @Composable () -> Unit = {
        Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(Color(0xFF243B55), Color(0xFF141E30), Color(0xFF3A1C32)))))
    }

    private fun shot(st: PlayerState, theme: Theme? = null, tv: Boolean = false, w: Int = 400, h: Int = 225, skin: @Composable (SkinContext) -> Unit) {
        val th = ThemeTokens.resolve(theme)
        val t = Translator()
        // A screen exactly the size of the player (xhdpi: 2 px per dp), so nothing is squeezed.
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(
            screenWidth = w * 2, screenHeight = h * 2, density = Density.XHIGH, xdpi = 320, ydpi = 320,
            orientation = if (w >= h) ScreenOrientation.LANDSCAPE else ScreenOrientation.PORTRAIT))
        paparazzi.snapshot {
            CompositionLocalProvider(LocalVoltStyle provides VoltStyle(th, if (tv) 1.5f else 1f), LocalVoltT provides t) {
                Box(Modifier.fillMaxSize()) { skin(SkinContext(st, NoCommands, th, t, tv, null, picture)) }
            }
        }
    }

    @Test fun video() = shot(state(), w = 560, h = 315) { VideoSkin(it) }
    @Test fun videoPlaying() = shot(state(PlayerStatus.Playing).copy(playing = true), w = 560, h = 315) { VideoSkin(it) }
    @Test fun videoThemed() = shot(state(), Theme(primary = "#e11d48", secondary = "#f5f5f4", radius = 4.0), w = 560, h = 315) { VideoSkin(it) }
    @Test fun videoLocked() = shot(state(PlayerStatus.Locked).copy(access = AccessState(AccessState.Mode.Paywall, "This needs a subscription or purchase.",
        listOf(Product("day", "Day pass", Product.Kind.Period, 1, Product.Unit.Day, 499, "AUD")))), w = 560, h = 315) { VideoSkin(it) }
    @Test fun event() = shot(state(), w = 560, h = 315) { EventSkin(it) }
    @Test fun audioSquare() = shot(state(PlayerStatus.Playing).copy(playing = true), w = 260, h = 260) { AudioSquareSkin(it) }
    @Test fun audioNowPlaying() = shot(state(), w = 400, h = 520) { AudioNowPlayingSkin(it) }
    @Test fun tv() = shot(state(), tv = true, w = 960, h = 540) { TvSkin(it) }
}
