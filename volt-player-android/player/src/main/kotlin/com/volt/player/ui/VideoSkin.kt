// ============================================================================
//  THE DEFAULT VIDEO SKIN for phones and tablets, the native twin of
//  skins/video.ts and the Swift VideoSkin.
//
//  Top: title (the item, or the programme on air), logo.
//  Middle: the big play button, a spinner, or a message with Try again.
//  Bottom: scrubber (on demand, or the DVR window on live), play, back and
//  forward by the seek step, time or LIVE / Go live, Start over, then
//  subtitles (only when the stream has them), audio, quality, speed, picture
//  in picture, full screen. Up next sits bottom right; Skip intro / credits
//  where it would. Controls hide after 3 s of playing and come back on a tap.
// ============================================================================
package com.volt.player.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Audiotrack
import androidx.compose.material.icons.filled.ClosedCaption
import androidx.compose.material.icons.filled.ClosedCaptionOff
import androidx.compose.material.icons.filled.Forward10
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.FullscreenExit
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PictureInPictureAlt
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.Replay10
import androidx.compose.material.icons.filled.RestartAlt
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.VolumeOff
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.volt.player.core.PlayerStatus
import com.volt.player.core.Schedule
import com.volt.player.core.Theme
import kotlinx.coroutines.delay

@Composable
fun VideoSkin(ctx: SkinContext) {
    val s = LocalVoltStyle.current
    val t = ctx.t
    val st = ctx.state
    val k = ctx.commands
    val c = ctx.theme.controls
    var shown by remember { mutableStateOf(true) }
    var poke by remember { mutableIntStateOf(0) }
    // Controls hide 3 s after the last touch while playing.
    LaunchedEffect(poke, st.playing, shown) {
        if (shown && st.playing) { delay(3000); shown = false }
    }
    val chrome = shown || !st.playing
    // Locked, an error or nothing on air: the panel is all there is to use.
    val blocked = st.status == PlayerStatus.Locked || st.status == PlayerStatus.Error || st.status == PlayerStatus.Offline
    // The big play button is up: the up-next card waits, so the two never overlap.
    val bigPlay = !st.playing && !blocked && st.status != PlayerStatus.Loading && st.status != PlayerStatus.Buffering

    // Picture in picture: the window is tiny and the system draws its own controls.
    if (st.pip.active) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            ctx.picture()
            st.item?.brandMark?.takeIf { st.adBreak == null }?.let { BrandMarkView(it) }
        }
        return
    }
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { shown = !shown; poke++ },
    ) {
        ctx.picture()
        st.item?.brandMark?.takeIf { st.adBreak == null }?.let { BrandMarkView(it) }
        ctx.watermark?.let { WatermarkView(it) }
        if (chrome) Box(Modifier.fillMaxSize().background(s.background.copy(alpha = 0.32f)))

        Box(Modifier.align(Alignment.Center)) { Center(ctx, chrome) }

        Column(Modifier.fillMaxSize()) {
            AnimatedVisibility(chrome, enter = fadeIn(), exit = fadeOut()) { Top(ctx) }
            Spacer(Modifier.weight(1f))
            if (!blocked) Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.End) {
                val sk = st.skip
                val up = st.upNext
                if (sk != null) SkipButton(sk) { k.skip() }
                else if (up != null && c.upNext && !bigPlay) UpNextCard(up, compact = true, playNow = { k.next() }, cancel = { k.cancelUpNext() })
            }
            AnimatedVisibility(chrome && !blocked, enter = fadeIn(), exit = fadeOut()) { Bottom(ctx) { poke++ } }
        }
        if (st.stats) StatsPanel(st) { k.toggleStats(false) }
    }
}

@Composable
private fun Center(ctx: SkinContext, chrome: Boolean) {
    val s = LocalVoltStyle.current
    val st = ctx.state
    val k = ctx.commands
    when (st.status) {
        PlayerStatus.Loading, PlayerStatus.Buffering -> VoltSpinner()
        PlayerStatus.Error, PlayerStatus.Offline -> CenterMessage(st.error ?: ctx.t("offline")) { k.play() }
        PlayerStatus.Locked -> LockedPanel(st.access, k)
        else -> if (!st.playing && (chrome || st.status != PlayerStatus.Playing)) {
            val ended = st.status == PlayerStatus.Ended
            Box(
                Modifier.size(76.dp).clip(CircleShape).voltFocus(CircleShape).background(s.primary)
                    .clickable(onClickLabel = if (ended) ctx.t("replay") else ctx.t("play")) { k.play() },
                contentAlignment = Alignment.Center,
            ) { Icon(if (ended) Icons.Filled.Replay else Icons.Filled.PlayArrow, null, tint = s.primaryInk, modifier = Modifier.size(40.dp)) }
        }
    }
}

@Composable
private fun Top(ctx: SkinContext) {
    val s = LocalVoltStyle.current
    val st = ctx.state
    val title = if (st.live && st.programme != null) st.programme!!.title else st.item?.title ?: ""
    val subtitle = if (st.live && st.programme != null) st.item?.title else st.item?.subtitle
    Row(
        Modifier.fillMaxWidth()
            .background(Brush.verticalGradient(listOf(s.background.copy(alpha = 0.7f), Color.Transparent)))
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        if (ctx.theme.controls.title) Column(Modifier.weight(1f)) {
            Text(title, style = s.type(16f, FontWeight.Bold), maxLines = 1, overflow = TextOverflow.Ellipsis)
            subtitle?.let { Text(it, style = s.type(12f, color = s.muted), maxLines = 1, overflow = TextOverflow.Ellipsis) }
        } else Spacer(Modifier.weight(1f))
        val logo = voltUrl(ctx.theme.logoUrl, LocalVoltBase.current)
        if (logo != null && (ctx.theme.logoPosition == Theme.LogoPosition.TopRight || ctx.theme.logoPosition == Theme.LogoPosition.TopLeft)) {
            AsyncImage(logo, null, contentScale = ContentScale.Fit, modifier = Modifier.height(24.dp))
        }
    }
}

@Composable
private fun Bottom(ctx: SkinContext, touched: () -> Unit) {
    val s = LocalVoltStyle.current
    val t = ctx.t
    val st = ctx.state
    val k = ctx.commands
    val c = ctx.theme.controls
    val step = ctx.theme.seekStep
    fun act(f: () -> Unit): () -> Unit = { f(); touched() }
    Column(
        Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, s.background.copy(alpha = 0.75f)))),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        if (!st.live || st.dvr) Scrubber(st, step = step, modifier = Modifier.padding(horizontal = 14.dp), onStep = { k.seekBy(it); touched() }) { k.seek(it); touched() }
        Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            VoltIconButton(if (st.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, if (st.playing) t("pause") else t("play"), onClick = act { k.toggle() })
            if (c.seekButtons && (!st.live || st.dvr)) {
                VoltIconButton(Icons.Filled.Replay10, t("back10"), size = 20.dp, onClick = act { k.seekBy(-step) })
                VoltIconButton(Icons.Filled.Forward10, t("fwd10"), size = 20.dp, onClick = act { k.seekBy(step) })
            }
            if (c.volume) VoltIconButton(if (st.muted) Icons.Filled.VolumeOff else Icons.Filled.VolumeUp, if (st.muted) t("unmute") else t("mute"), size = 20.dp, onClick = act { k.toggleMute() })
            if (st.live) LiveBadge(st) { k.goLive(); touched() }
            else Text("${Schedule.fmtTime(st.currentTime)} / ${Schedule.fmtTime(st.duration)}", style = s.type(12f), modifier = Modifier.padding(horizontal = 6.dp))
            if (c.startOver && st.canStartOver) VoltIconButton(Icons.Filled.RestartAlt, t("startOver"), size = 20.dp, onClick = act { k.startOver() })
            Spacer(Modifier.weight(1f))
            if (c.subtitles && st.textTracks.isNotEmpty()) {
                ChoiceMenu(if (st.textTrack == null) Icons.Filled.ClosedCaptionOff else Icons.Filled.ClosedCaption, t("subtitles"),
                    listOf(MenuChoice(null, t("off"))) + st.textTracks.map { MenuChoice(it.id, it.label) }, st.textTrack) { k.setTextTrack(it); touched() }
            }
            if (c.audioTracks && st.audioTracks.size > 1) {
                ChoiceMenu(Icons.Filled.Audiotrack, t("audio"), st.audioTracks.map { MenuChoice(it.id, it.label) }, st.audioTrack) { id -> id?.let { k.setAudioTrack(it) }; touched() }
            }
            if (c.quality && st.qualities.size > 1) {
                val auto = if (st.quality == "auto" && st.activeQuality != null) t("autoNow", mapOf("q" to st.activeQuality!!.label)) else t("auto")
                ChoiceMenu(Icons.Filled.Settings, t("quality"), listOf(MenuChoice("auto", auto)) + st.qualities.map { MenuChoice(it.id, it.label) }, st.quality) { k.setQuality(it ?: "auto"); touched() }
            }
            if (c.speed && !st.live) {
                val rates = listOf(0.5, 0.75, 1.0, 1.25, 1.5, 2.0)
                ChoiceMenu(Icons.Filled.Speed, t("speed"), rates.map { r -> MenuChoice(r.toString(), if (r == 1.0) t("normal") else "${r}×") }, st.rate.toString()) {
                    it?.toDoubleOrNull()?.let(k::setRate); touched()
                }
            }
            if (c.pip && st.pip.available && st.hasPicture) VoltIconButton(Icons.Filled.PictureInPictureAlt, t("pip"), size = 20.dp, onClick = act { k.togglePip() })
            if (c.fullscreen && st.caps.fullscreen) {
                VoltIconButton(if (st.fullscreen) Icons.Filled.FullscreenExit else Icons.Filled.Fullscreen, if (st.fullscreen) t("exitFullscreen") else t("fullscreen"),
                    size = 20.dp, onClick = act { k.toggleFullscreen() })
            }
        }
    }
}
