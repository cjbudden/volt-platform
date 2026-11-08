// ============================================================================
//  THE VIEW: the picture, the skin on top, and full screen.
//
//      VoltPlayerView(player)                       the skin the player picked
//      VoltPlayerView(player) { ctx -> MySkin(ctx) } your own skin, inline
//      VoltSkins.register("acme") { ctx -> Acme(ctx) } then skin = "acme"
//
//  A skin gets a SkinContext: the state, the commands, the theme, the
//  translator and the picture. It never sees the ExoPlayer, so a skin can
//  draw badly but cannot break playback (the same rule as the web and iOS).
//
//  Full screen is a dialog over everything, so it works without any help from
//  the host Activity; the picture moves into it and back. On a TV the player
//  is always full screen and the button is not offered.
// ============================================================================
package com.volt.player.ui

import android.content.pm.ActivityInfo
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.volt.player.VoltPlayer
import com.volt.player.core.PlayerState
import com.volt.player.core.ResolvedTheme
import com.volt.player.core.Translator
import com.volt.player.core.VoltCommands

/** Everything a skin draws from. */
class SkinContext(
    val state: PlayerState,
    val commands: VoltCommands,
    val theme: ResolvedTheme,
    val t: Translator,
    /** Android TV, Google TV, Fire TV: lean-back, D-pad focus. */
    val tv: Boolean,
    /** Text drawn diagonally over the picture (share previews). */
    val watermark: String?,
    /** The picture (and the stream's subtitles). Place it once. */
    val picture: @Composable () -> Unit,
)

/** The skins a player can be asked for by name. Built-ins are registered on first use. */
object VoltSkins {
    private val skins = HashMap<String, @Composable (SkinContext) -> Unit>()

    /** Register your own skin, then pass skin = id. A built-in of the same name is replaced. */
    fun register(id: String, content: @Composable (SkinContext) -> Unit) { skins[id] = content }

    private fun builtIns() {
        if (skins.containsKey("video")) return
        skins.getOrPut("video") { { VideoSkin(it) } }
        skins.getOrPut("tv") { { TvSkin(it) } }
        skins.getOrPut("event") { { EventSkin(it) } }
        skins.getOrPut("audio_square") { { AudioSquareSkin(it) } }
        skins.getOrPut("audio_nowplaying") { { AudioNowPlayingSkin(it) } }
        skins.getOrPut("audio_radio") { { AudioNowPlayingSkin(it) } }
        // Android gives no audio levels for a stream without a visualiser permission, and the
        // waveform shows real levels or nothing: the now-playing skin stands in, as on iOS.
        skins.getOrPut("audio_wave") { { AudioNowPlayingSkin(it) } }
    }

    /**
     * The skin for an id on this device. On a TV the phone video skin becomes `tv`; elsewhere
     * `tv` becomes `video`. An unknown name plays in the default rather than a blank box.
     */
    fun resolve(id: String, tv: Boolean): @Composable (SkinContext) -> Unit {
        builtIns()
        val wanted = when {
            tv && id == "video" -> "tv"
            !tv && id == "tv" -> "video"
            else -> id
        }
        return skins[wanted] ?: skins[if (tv) "tv" else "video"]!!
    }
}

/**
 * The Volt player on screen. [skin] draws instead of the player's own skin.
 */
@androidx.annotation.OptIn(UnstableApi::class)
@Composable
fun VoltPlayerView(player: VoltPlayer, modifier: Modifier = Modifier, skin: (@Composable (SkinContext) -> Unit)? = null) {
    val state by player.state.collectAsStateWithLifecycle()
    val theme by player.theme.collectAsStateWithLifecycle()
    val skinId by player.skinId.collectAsStateWithLifecycle()
    val context = LocalContext.current
    DisposableEffect(player, context) {
        player.attachHost(VoltPlayer.findActivity(context))
        onDispose { player.attachHost(null) }
    }
    val style = remember(theme, player.isTv) { VoltStyle(theme, if (player.isTv) 1.5f else 1f) }
    val draw = skin ?: VoltSkins.resolve(skinId, player.isTv)

    @Composable
    fun content(showPicture: Boolean) {
        CompositionLocalProvider(LocalVoltStyle provides style, LocalVoltT provides player.t, LocalVoltBase provides player.options.apiBase) {
            val ctx = SkinContext(state, player, theme, player.t, player.isTv, player.options.watermark) {
                if (showPicture) Picture(player, state.playing) else Box(Modifier.fillMaxSize().background(Color.Black))
            }
            Box(Modifier.fillMaxSize()) { draw(ctx) }
        }
    }

    Box(modifier.background(Color.Black)) { content(showPicture = !state.fullscreen) }
    if (state.fullscreen && !player.isTv) {
        // Landscape while full screen, back to what the app had after.
        DisposableEffect(Unit) {
            val a = VoltPlayer.findActivity(context)
            val before = a?.requestedOrientation
            a?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            onDispose { if (a != null && before != null) a.requestedOrientation = before }
        }
        Dialog(onDismissRequest = { player.toggleFullscreen() },
            properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
            // No status or navigation bar over the picture; a swipe brings them back for a moment.
            val view = LocalView.current
            DisposableEffect(view) {
                (view.parent as? DialogWindowProvider)?.window?.let { w ->
                    WindowCompat.getInsetsController(w, view).apply {
                        hide(WindowInsetsCompat.Type.systemBars())
                        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    }
                }
                onDispose { }
            }
            Box(Modifier.fillMaxSize().background(Color.Black)) { content(showPicture = true) }
        }
    }
}

/** The ExoPlayer's picture and subtitles. Controls are the skin's, never Media3's. */
@androidx.annotation.OptIn(UnstableApi::class)
@Composable
private fun Picture(player: VoltPlayer, playing: Boolean) {
    val exo = player.exoPlayer
    if (exo == null) { Box(Modifier.fillMaxSize().background(Color.Black)); return }
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { c ->
            PlayerView(c).apply {
                layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                useController = false
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
                setKeepContentOnPlayerReset(true)
                isFocusable = false
                this.player = exo
            }
        },
        update = { v ->
            if (v.player !== exo) v.player = exo
            v.keepScreenOn = playing
        },
        onRelease = { v -> v.player = null },
    )
}
