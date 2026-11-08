// ============================================================================
//  THE TV SKIN: lean-back on Android TV, Google TV and Fire TV, driven by a
//  remote. The Android twin of the Swift `tv` skin, with the same rules
//  (core TvRules): what left and right do, when the controls hide, and what
//  the guide lists.
//
//  With the controls hidden, the picture is everything:
//    centre / OK        play or pause (or Skip intro when it is offered)
//    left / right       back or forward by the theme's seek step
//    up                 show the controls
//    down               open the guide (or show the controls)
//    play/pause, rewind, fast forward on the remote work at any time
//    back               hides the guide, then the controls, then leaves
//
//  With the controls shown, the D-pad moves between them with a visible focus
//  ring in the theme's focus colour. They hide 5 s after the last press while
//  playing, never while the guide or a menu is open.
//
//  The guide lists what is on now, what can still be watched from its start
//  (inside the DVR window) and what is later. Choosing an earlier programme
//  plays it from its start.
// ============================================================================
package com.volt.player.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ListAlt
import androidx.compose.material.icons.filled.Audiotrack
import androidx.compose.material.icons.filled.ClosedCaption
import androidx.compose.material.icons.filled.ClosedCaptionOff
import androidx.compose.material.icons.filled.FastForward
import androidx.compose.material.icons.filled.FastRewind
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.RestartAlt
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.volt.player.core.PlayerStatus
import com.volt.player.core.Schedule
import com.volt.player.core.TvRules
import kotlinx.coroutines.delay

@Composable
fun TvSkin(ctx: SkinContext) {
    val s = LocalVoltStyle.current
    val t = ctx.t
    val st = ctx.state
    val k = ctx.commands
    val step = ctx.theme.seekStep
    var shown by remember { mutableStateOf(true) }
    var guide by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableIntStateOf(0) }
    var lastInput by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val root = remember { FocusRequester() }
    val play = remember { FocusRequester() }
    fun poke() { lastInput = System.currentTimeMillis() }
    fun show() { shown = true; poke() }
    fun seekBy(delta: Double) { if (TvRules.seekTarget(st, delta) != null) k.seekBy(delta); show() }
    // The OK press that showed the controls must not also press the button that takes focus.
    var swallowUp by remember { mutableStateOf<Key?>(null) }
    val blocked = st.status == PlayerStatus.Locked || st.status == PlayerStatus.Error || st.status == PlayerStatus.Offline

    // Controls hide 5 s after the last press while playing (TvRules.shouldHide).
    LaunchedEffect(lastInput, shown, st.playing, guide, menuOpen) {
        while (true) {
            val idle = (System.currentTimeMillis() - lastInput) / 1000.0
            if (TvRules.shouldHide(shown, st.playing, guide || menuOpen > 0, idle)) { shown = false; break }
            delay(250)
        }
    }
    // Focus: the play button while the controls are up, the picture while they are not.
    LaunchedEffect(shown, guide) {
        if (guide) return@LaunchedEffect
        runCatching { if (shown) play.requestFocus() else root.requestFocus() }
    }
    LaunchedEffect(st.adBreak != null, blocked) {
        if (st.adBreak != null || blocked) { shown = false; runCatching { root.requestFocus() } }
    }
    BackHandler(enabled = guide || shown) {
        if (guide) { guide = false; show() } else shown = false
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .focusRequester(root)
            .focusable()
            .onPreviewKeyEvent { e ->
                if (e.type == KeyEventType.KeyUp && swallowUp != null && e.key == swallowUp) { swallowUp = null; return@onPreviewKeyEvent true }
                if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                poke()
                // The remote's media keys work whatever has focus.
                when (e.key) {
                    Key.MediaPlayPause -> { k.toggle(); show(); return@onPreviewKeyEvent true }
                    Key.MediaPlay -> { k.play(); show(); return@onPreviewKeyEvent true }
                    Key.MediaPause -> { k.pause(); show(); return@onPreviewKeyEvent true }
                    Key.MediaFastForward -> { seekBy(step); return@onPreviewKeyEvent true }
                    Key.MediaRewind -> { seekBy(-step); return@onPreviewKeyEvent true }
                }
                // Controls up, the guide open, or a panel to act on (paywall, error): the D-pad moves focus.
                if (shown || guide || blocked) return@onPreviewKeyEvent false
                when (e.key) {
                    Key.DirectionCenter, Key.Enter, Key.NumPadEnter -> {
                        val sk = st.skip
                        if (sk != null) k.skip() else k.toggle()
                        swallowUp = e.key
                        show(); true
                    }
                    Key.DirectionLeft -> { seekBy(-step); true }
                    Key.DirectionRight -> { seekBy(step); true }
                    Key.DirectionUp -> { show(); true }
                    Key.DirectionDown -> { if (st.schedule.isNotEmpty() && st.live) { guide = true; poke() } else show(); true }
                    else -> false
                }
            },
    ) {
        ctx.picture()
        st.item?.brandMark?.takeIf { st.adBreak == null }?.let { BrandMarkView(it) }
        ctx.watermark?.let { WatermarkView(it) }

        Box(Modifier.align(Alignment.Center)) {
            when (st.status) {
                PlayerStatus.Loading, PlayerStatus.Buffering -> VoltSpinner(tv = true)
                PlayerStatus.Error, PlayerStatus.Offline -> CenterMessage(st.error ?: t("offline"), tv = true) { k.play() }
                PlayerStatus.Locked -> LockedPanel(st.access, k, tv = true)
                PlayerStatus.Ended -> VoltPillButton(t("replay"), Icons.Filled.Replay, tv = true) { k.play() }
                else -> {}
            }
        }

        // Skip intro / Up next stay on screen with the controls hidden; OK takes Skip.
        Box(Modifier.align(Alignment.BottomEnd).padding(horizontal = 48.dp, vertical = if (shown) 170.dp else 48.dp)) {
            val sk = st.skip
            val up = st.upNext
            if (sk != null) SkipButton(sk, tv = true) { k.skip(); poke() }
            else if (up != null && ctx.theme.controls.upNext && st.adBreak == null) UpNextCard(up, tv = true, playNow = { k.next() }, cancel = { k.cancelUpNext() })
        }

        AnimatedVisibility(shown && st.adBreak == null && !blocked, enter = fadeIn(), exit = fadeOut()) {
            Column(Modifier.fillMaxSize()) {
                TvTop(ctx)
                Spacer(Modifier.weight(1f))
                TvBottom(ctx, play, onGuide = { guide = true; poke() }, onMenu = { open -> menuOpen = if (open) menuOpen + 1 else (menuOpen - 1).coerceAtLeast(0); poke() }, poke = ::poke)
            }
        }

        AnimatedVisibility(guide, modifier = Modifier.align(Alignment.CenterEnd), enter = slideInHorizontally { it } + fadeIn(), exit = slideOutHorizontally { it } + fadeOut()) {
            TvGuide(ctx) { target -> guide = false; target?.let { k.seek(it); k.play() }; show() }
        }
        if (st.stats) StatsPanel(st, tv = true) { k.toggleStats(false) }
    }
}

@Composable
private fun TvTop(ctx: SkinContext) {
    val s = LocalVoltStyle.current
    val st = ctx.state
    val title = if (st.live && st.programme != null) st.programme!!.title else st.item?.title ?: ""
    val subtitle = if (st.live && st.programme != null) st.item?.title else st.item?.subtitle
    Row(
        Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(s.background.copy(alpha = 0.8f), Color.Transparent)))
            .padding(horizontal = 48.dp, vertical = 28.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = s.type(22f, FontWeight.Bold), maxLines = 1, overflow = TextOverflow.Ellipsis)
            subtitle?.let { Text(it, style = s.type(14f, color = s.muted), maxLines = 1, overflow = TextOverflow.Ellipsis) }
            st.nextProgramme?.takeIf { st.live }?.let {
                Text("${ctx.t("next")}: ${it.title}  ${Schedule.fmtClock(it.startsAt)}", style = s.type(12f, color = s.muted), maxLines = 1)
            }
        }
        voltUrl(ctx.theme.logoUrl, LocalVoltBase.current)?.let { AsyncImage(it, null, contentScale = ContentScale.Fit, modifier = Modifier.height(40.dp)) }
    }
}

@Composable
private fun TvBottom(ctx: SkinContext, play: FocusRequester, onGuide: () -> Unit, onMenu: (Boolean) -> Unit, poke: () -> Unit) {
    val s = LocalVoltStyle.current
    val t = ctx.t
    val st = ctx.state
    val k = ctx.commands
    val c = ctx.theme.controls
    val step = ctx.theme.seekStep
    Column(
        Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, s.background.copy(alpha = 0.85f))))
            .padding(horizontal = 48.dp, vertical = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (!st.live || st.dvr) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Scrubber(st, tv = true, step = step, modifier = Modifier.weight(1f),
                    onStep = { d -> if (TvRules.seekTarget(st, d) != null) k.seekBy(d); poke() }) { k.seek(it); poke() }
                if (!st.live) Text("${Schedule.fmtTime(st.currentTime)} / ${Schedule.fmtTime(st.duration)}", style = s.type(13f))
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            VoltIconButton(if (st.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, if (st.playing) t("pause") else t("play"),
                tv = true, modifier = Modifier.focusRequester(play)) { k.toggle(); poke() }
            if (c.seekButtons && (!st.live || st.dvr)) {
                VoltIconButton(Icons.Filled.FastRewind, t("back10"), tv = true) { if (TvRules.seekTarget(st, -step) != null) k.seekBy(-step); poke() }
                VoltIconButton(Icons.Filled.FastForward, t("fwd10"), tv = true) { if (TvRules.seekTarget(st, step) != null) k.seekBy(step); poke() }
            }
            if (st.live) LiveBadge(st, tv = true) { k.goLive(); poke() }
            if (c.startOver && st.canStartOver) VoltIconButton(Icons.Filled.RestartAlt, t("startOver"), tv = true) { k.startOver(); poke() }
            Spacer(Modifier.weight(1f))
            if (c.schedule && st.live && st.schedule.isNotEmpty()) VoltIconButton(Icons.AutoMirrored.Filled.ListAlt, t("schedule"), tv = true, onClick = onGuide)
            if (c.subtitles && st.textTracks.isNotEmpty()) TvMenu(if (st.textTrack == null) Icons.Filled.ClosedCaptionOff else Icons.Filled.ClosedCaption, t("subtitles"),
                listOf(MenuChoice(null, t("off"))) + st.textTracks.map { MenuChoice(it.id, it.label) }, st.textTrack, onMenu) { k.setTextTrack(it) }
            if (c.audioTracks && st.audioTracks.size > 1) TvMenu(Icons.Filled.Audiotrack, t("audio"), st.audioTracks.map { MenuChoice(it.id, it.label) }, st.audioTrack, onMenu) { id -> id?.let(k::setAudioTrack) }
            if (c.quality && st.qualities.size > 1) {
                val auto = if (st.quality == "auto" && st.activeQuality != null) t("autoNow", mapOf("q" to st.activeQuality!!.label)) else t("auto")
                TvMenu(Icons.Filled.Settings, t("quality"), listOf(MenuChoice("auto", auto)) + st.qualities.map { MenuChoice(it.id, it.label) }, st.quality, onMenu) { k.setQuality(it ?: "auto") }
            }
        }
    }
}

/** A menu button that tells the skin it is open, so the controls stay up while choosing. */
@Composable
private fun TvMenu(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, choices: List<MenuChoice>, selected: String?,
                   onMenu: (Boolean) -> Unit, onPick: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val report by rememberUpdatedState(onMenu)
    // The menu can leave while open (the tracks changed): the controls must not stay up for good.
    DisposableEffect(Unit) { onDispose { if (open) report(false) } }
    VoltIconButton(icon, label, tv = true) { open = true; onMenu(true) }
    if (open) ChoiceDialog(label, choices, selected, tv = true, onDismiss = { open = false; onMenu(false) }) { onPick(it); open = false; onMenu(false) }
}

/** The guide panel: earlier (watch from the start), on now, later. */
@Composable
private fun TvGuide(ctx: SkinContext, done: (Double?) -> Unit) {
    val s = LocalVoltStyle.current
    val t = ctx.t
    val rows = remember(ctx.state.schedule, ctx.state.seekable, (ctx.state.wallClock ?: 0.0) / 60_000) {
        TvRules.guideRows(ctx.state, System.currentTimeMillis().toDouble())
    }
    val start = TvRules.initialRow(rows) ?: 0
    val list = rememberLazyListState(initialFirstVisibleItemIndex = (start - 1).coerceAtLeast(0))
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    Column(
        Modifier.fillMaxHeight().width(560.dp).background(s.secondary.copy(alpha = 0.96f)).padding(vertical = 28.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(t("schedule"), style = s.type(18f, FontWeight.Bold, s.secondaryInk), modifier = Modifier.padding(horizontal = 28.dp))
        LazyColumn(state = list, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            itemsIndexed(rows, key = { _, r -> r.id }) { i, r ->
                val p = r.programme
                val shape = RoundedCornerShape(8.dp)
                val playable = r.target != null
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp)
                        .then(if (i == start) Modifier.focusRequester(first) else Modifier)
                        .clip(shape).voltFocus(shape, tv = true)
                        .background(if (r.kind == TvRules.GuideRow.Kind.OnNow) s.primary.copy(alpha = 0.18f) else Color.Transparent)
                        .clickable { if (playable) done(r.target) }
                        .padding(horizontal = 12.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Text(Schedule.fmtClock(p.startsAt), style = s.type(13f, FontWeight.SemiBold, s.muted), modifier = Modifier.width(96.dp))
                    Column(Modifier.weight(1f)) {
                        Text(p.title, style = s.type(15f, FontWeight.SemiBold, s.secondaryInk), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val note = when (r.kind) {
                            TvRules.GuideRow.Kind.OnNow -> t("onNow")
                            TvRules.GuideRow.Kind.Earlier -> if (playable) t("startOver") else null
                            TvRules.GuideRow.Kind.Later -> t("later")
                        }
                        note?.let { Text(it, style = s.type(11f, color = s.muted)) }
                    }
                    if (playable) Icon(Icons.Filled.PlayArrow, null, tint = s.secondaryInk, modifier = Modifier.width(24.dp))
                }
            }
        }
    }
}
