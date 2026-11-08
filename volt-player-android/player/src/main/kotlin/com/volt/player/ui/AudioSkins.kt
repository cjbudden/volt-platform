// ============================================================================
//  AUDIO SKINS, the native twins of skins/audio.ts and the Swift AudioSkins.
//
//    audio_square      a square tile: artwork, title, play. Fits a grid.
//    audio_nowplaying  a panel: big artwork, track details, the last five
//                      tracks and what is coming up. (audio_wave and
//                      audio_radio map here: the waveform shows real levels or
//                      nothing, and Android gives none for a stream.)
//
//  What they show, best first: the track now playing (station metadata or the
//  stream's ID3), else the programme on air, else the item's own title. On a
//  TV the panel is sized for ten feet and the play button takes focus.
// ============================================================================
package com.volt.player.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.volt.player.core.PlayerState
import com.volt.player.core.PlayerStatus
import com.volt.player.core.Schedule
import com.volt.player.core.TrackInfo
import com.volt.player.core.VoltCommands

/** What an audio skin shows: the track, else the programme, else the item. */
internal data class AudioInfo(val title: String, val sub: String, val art: String?, val meta: String) {
    companion object {
        fun of(st: PlayerState): AudioInfo {
            val item = st.item
            val np = st.nowPlaying
            if (np != null && np.title.isNotEmpty()) {
                return AudioInfo(np.title, np.artist ?: "", np.artworkUrl ?: item?.artworkUrl,
                    listOfNotNull(np.album, np.year?.toString()).joinToString(" · "))
            }
            val p = st.programme
            if (p != null) {
                return AudioInfo(p.title, p.subtitle ?: item?.title ?: "", p.imageUrl ?: item?.artworkUrl,
                    "${Schedule.fmtClock(p.startsAt)} – ${if (p.endsAt.isFinite()) Schedule.fmtClock(p.endsAt) else ""}")
            }
            return AudioInfo(item?.title ?: "", item?.subtitle ?: item?.description ?: "", item?.artworkUrl, "")
        }
    }
}

@Composable
internal fun Artwork(url: String?, modifier: Modifier = Modifier) {
    val s = LocalVoltStyle.current
    val u = voltUrl(url, LocalVoltBase.current)
    Box(modifier.aspectRatio(1f).clip(s.shape).background(s.text.copy(alpha = 0.08f)), contentAlignment = Alignment.Center) {
        if (u != null) AsyncImage(u, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        else Icon(Icons.Filled.MusicNote, null, tint = s.text.copy(alpha = 0.45f), modifier = Modifier.size(36.dp))
    }
}

@Composable
internal fun PlayButton(st: PlayerState, k: VoltCommands, size: Dp, tv: Boolean = false, focus: FocusRequester? = null) {
    val s = LocalVoltStyle.current
    val t = LocalVoltT.current
    Box(
        Modifier.size(size).clip(CircleShape).then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
            .voltFocus(CircleShape, tv).background(s.primary)
            .clickable(onClickLabel = if (st.playing) t("pause") else t("play")) { k.toggle() },
        contentAlignment = Alignment.Center,
    ) {
        if (st.buffering || st.status == PlayerStatus.Loading) CircularProgressIndicator(color = s.primaryInk, strokeWidth = 3.dp, modifier = Modifier.size(size * 0.45f))
        else Icon(if (st.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, null, tint = s.primaryInk, modifier = Modifier.size(size * 0.5f))
    }
}

/** "Listen on Apple Music": Apple's artwork may be shown only with a link to the song there. */
@Composable
private fun ListenLink(track: TrackInfo?) {
    val s = LocalVoltStyle.current
    val l = track?.listen ?: return
    val context = LocalContext.current
    Text("Listen on ${l.service}", style = s.type(11f, FontWeight.SemiBold, s.muted),
        modifier = Modifier.clickable { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(l.url))) } })
}

@Composable
fun AudioSquareSkin(ctx: SkinContext) {
    val s = LocalVoltStyle.current
    val info = AudioInfo.of(ctx.state)
    Box(Modifier.fillMaxSize().aspectRatio(1f, matchHeightConstraintsFirst = true).clip(s.shape)) {
        Artwork(info.art, Modifier.fillMaxSize())
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Transparent, s.background.copy(alpha = 0.9f)))))
        Row(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.Bottom) {
            Column(Modifier.weight(1f)) {
                if (ctx.state.live) Text(ctx.t("onAir"), style = s.type(10f, FontWeight.ExtraBold, s.live))
                Text(info.title, style = s.type(15f, FontWeight.Bold), maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(info.sub, style = s.type(12f, color = s.muted), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            PlayButton(ctx.state, ctx.commands, 46.dp, ctx.tv)
        }
    }
}

@Composable
fun AudioNowPlayingSkin(ctx: SkinContext) {
    val s = LocalVoltStyle.current
    val t = ctx.t
    val st = ctx.state
    val info = AudioInfo.of(st)
    val tv = ctx.tv
    val focus = remember { FocusRequester() }
    if (tv) LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Box(Modifier.fillMaxSize().background(s.background)) {
        ctx.picture() // the stream's own picture, if an audio service has one (and its timed metadata keeps flowing)
        Box(Modifier.fillMaxSize().background(s.background))
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(if (tv) 48.dp else 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Artwork(info.art, Modifier.width(if (tv) 260.dp else 120.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(t("nowPlaying"), style = s.type(11f, FontWeight.SemiBold, s.muted))
                    Text(info.title, style = s.type(18f, FontWeight.Bold), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(info.sub, style = s.type(14f, color = s.text.copy(alpha = 0.85f)), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (info.meta.isNotEmpty()) Text(info.meta, style = s.type(12f, color = s.muted))
                    ListenLink(st.nowPlaying)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PlayButton(st, ctx.commands, if (tv) 72.dp else 48.dp, tv, focus)
                if (st.live) LiveBadge(st, tv) { ctx.commands.goLive() }
                Spacer(Modifier.weight(1f))
            }
            when (st.status) {
                PlayerStatus.Error, PlayerStatus.Offline -> CenterMessage(st.error ?: t("offline"), tv) { ctx.commands.play() }
                PlayerStatus.Locked -> LockedPanel(st.access, ctx.commands, tv)
                else -> {}
            }
            st.nextTrack?.let { next ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(t("comingUp"), style = s.type(11f, FontWeight.SemiBold, s.muted))
                    Text(listOfNotNull(next.title, next.artist).joinToString(" · "), style = s.type(13f))
                }
            }
            if (ctx.theme.controls.history && st.history.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(t("recentlyPlayed"), style = s.type(11f, FontWeight.SemiBold, s.muted))
                    for (h in st.history.take(5)) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Artwork(h.artworkUrl, Modifier.width(if (tv) 56.dp else 36.dp))
                        Column(Modifier.weight(1f)) {
                            Text(h.title, style = s.type(13f, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            h.artist?.let { Text(it, style = s.type(12f, color = s.muted), maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        }
                        h.startedAt?.let { Text(Schedule.fmtClock(it), style = s.type(11f, color = s.muted)) }
                    }
                }
            }
        }
    }
}
