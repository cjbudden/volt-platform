// ============================================================================
//  THE SKIN KIT: the parts every skin is built from, the Compose twins of
//  skins/kit.ts and the Swift SkinKit. Each control is focusable with a
//  visible ring (D-pad, keyboard, TV remote) and carries a label for
//  TalkBack. A custom skin builds from these and reads colours from
//  LocalVoltStyle, so themes keep working.
// ============================================================================
package com.volt.player.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import coil.compose.AsyncImage
import com.volt.player.core.AccessState
import com.volt.player.core.BrandMark
import com.volt.player.core.Gate
import com.volt.player.core.PlayerState
import com.volt.player.core.Schedule
import com.volt.player.core.SkipOffer
import com.volt.player.core.UpNext
import com.volt.player.core.VoltCommands
import kotlin.math.max
import kotlin.math.min

/** An icon button with a label for TalkBack and a focus ring. */
@Composable
fun VoltIconButton(icon: ImageVector, label: String, size: Dp = 22.dp, tv: Boolean = false, enabled: Boolean = true,
                   modifier: Modifier = Modifier, onClick: () -> Unit) {
    val s = LocalVoltStyle.current
    val box = if (tv) size * 2.4f else size * 2f
    Box(
        modifier
            .size(box)
            .clip(CircleShape)
            .voltFocus(CircleShape, tv)
            .clickable(enabled = enabled, onClickLabel = label, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = if (enabled) s.text else s.muted, modifier = Modifier.size(if (tv) size * 1.3f else size))
    }
}

/** A filled pill button in the primary colour (Play now, Buy, Watch the replay). */
@Composable
fun VoltPillButton(text: String, icon: ImageVector? = null, primary: Boolean = true, tv: Boolean = false,
                   modifier: Modifier = Modifier, onClick: () -> Unit) {
    val s = LocalVoltStyle.current
    val shape = RoundedCornerShape(50)
    Row(
        modifier
            .clip(shape)
            .voltFocus(shape, tv)
            .background(if (primary) s.primary else s.text.copy(alpha = 0.14f))
            .clickable(onClick = onClick)
            .padding(horizontal = if (tv) 26.dp else 16.dp, vertical = if (tv) 12.dp else 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val ink = if (primary) s.primaryInk else s.text
        if (icon != null) Icon(icon, null, tint = ink, modifier = Modifier.size(if (tv) 24.dp else 18.dp))
        Text(text, style = s.type(14f, FontWeight.Bold, ink), maxLines = 1)
    }
}

/** LIVE when at the live edge; Go live (and how far behind) otherwise. */
@Composable
fun LiveBadge(state: PlayerState, tv: Boolean = false, onGoLive: () -> Unit) {
    val s = LocalVoltStyle.current
    val t = LocalVoltT.current
    val shape = RoundedCornerShape(50)
    val atEdge = state.atLiveEdge
    Row(
        Modifier
            .clip(shape)
            .voltFocus(shape, tv)
            .clickable(enabled = !atEdge, onClickLabel = t("goLive"), onClick = onGoLive)
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(if (tv) 12.dp else 8.dp).clip(CircleShape).background(if (atEdge) s.live else s.muted))
        Text(if (atEdge) t("live") else t("goLive"), style = s.type(12f, FontWeight.Bold))
        if (!atEdge && state.behindLive >= 1) Text(t("behindLive", mapOf("time" to Schedule.fmtTime(state.behindLive))), style = s.type(11f, color = s.muted))
    }
}

/**
 * The scrubber: on demand from 0 to the duration, on live the DVR window. Drag or tap on
 * touch; left and right by the theme's seek step with a D-pad when focused.
 */
@Composable
fun Scrubber(state: PlayerState, tv: Boolean = false, step: Double = 10.0, modifier: Modifier = Modifier,
             /** Left and right on a D-pad: seek by this much (the engine adds quick presses up). */
             onStep: ((Double) -> Unit)? = null, onSeek: (Double) -> Unit) {
    val s = LocalVoltStyle.current
    val t = LocalVoltT.current
    val (from, to) = if (state.live) (state.seekable?.start ?: 0.0) to (state.seekable?.end ?: 0.0) else 0.0 to state.duration
    val span = to - from
    if (!span.isFinite() || span <= 0) { Spacer(modifier.height(if (tv) 10.dp else 6.dp)); return }
    var dragFrac by remember { mutableStateOf<Float?>(null) }
    // The live window moves every tick: the gesture handlers read the latest range instead of
    // restarting (a restart mid-drag would cancel the drag and freeze the bar).
    val fromNow by rememberUpdatedState(from)
    val spanNow by rememberUpdatedState(span)
    val seekNow by rememberUpdatedState(onSeek)
    val frac = dragFrac ?: ((state.currentTime - from) / span).toFloat().coerceIn(0f, 1f)
    var focused by remember { mutableStateOf(false) }
    val h = if (tv) 8.dp else 4.dp
    val label = if (state.live) t("behindLive", mapOf("time" to Schedule.fmtTime(state.behindLive))) else
        "${Schedule.fmtTime(state.currentTime)} / ${Schedule.fmtTime(state.duration)}"
    Box(
        modifier
            .fillMaxWidth()
            .height(if (tv) 30.dp else 24.dp)
            .onFocusChanged { focused = it.isFocused }
            .focusable()
            .semantics { contentDescription = label }
            .onKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown) return@onKeyEvent false
                when (e.key) {
                    Key.DirectionLeft -> { onStep?.invoke(-step) ?: onSeek(max(from, state.currentTime - step)); true }
                    Key.DirectionRight -> { onStep?.invoke(step) ?: onSeek(min(to, state.currentTime + step)); true }
                    else -> false
                }
            }
            .pointerInput(Unit) {
                detectTapGestures { o -> seekNow(fromNow + spanNow * (o.x / size.width).coerceIn(0f, 1f)) }
            }
            .pointerInput(Unit) {
                detectHorizontalDragGestures(
                    onDragStart = { o -> dragFrac = (o.x / size.width).coerceIn(0f, 1f) },
                    onDragEnd = { dragFrac?.let { seekNow(fromNow + spanNow * it) }; dragFrac = null },
                    onDragCancel = { dragFrac = null },
                    onHorizontalDrag = { c, _ -> dragFrac = (c.position.x / size.width).coerceIn(0f, 1f) },
                )
            },
        contentAlignment = Alignment.CenterStart,
    ) {
        Canvas(Modifier.fillMaxWidth().height(if (focused) h * 1.6f else h)) {
            val r = CornerRadius(size.height / 2, size.height / 2)
            drawRoundRect(color = s.text.copy(alpha = 0.25f), size = size, cornerRadius = r)
            drawRoundRect(color = s.primary, size = Size(size.width * frac, size.height), cornerRadius = r)
            val knob = if (focused || dragFrac != null) size.height * 1.4f else size.height
            drawCircle(color = if (focused) s.focus else s.primary, radius = knob, center = Offset(size.width * frac, size.height / 2))
        }
    }
}

/**
 * The up-next card: what is next, the countdown, Play now and Cancel (items only).
 * `compact` is one row with icon actions, for phone-sized players.
 */
@Composable
fun UpNextCard(up: UpNext, tv: Boolean = false, compact: Boolean = false, playNow: () -> Unit, cancel: () -> Unit) {
    val s = LocalVoltStyle.current
    val t = LocalVoltT.current
    val base = LocalVoltBase.current
    if (compact && !tv) {
        Column(Modifier.widthIn(max = 260.dp).clip(s.shape).background(s.secondary.copy(alpha = 0.94f))) {
            Row(Modifier.padding(start = 10.dp, top = 6.dp, bottom = 6.dp, end = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f, fill = false)) {
                    Text(up.kicker(t), style = s.type(10f, FontWeight.SemiBold, s.muted), maxLines = 1)
                    Text(up.title, style = s.type(13f, FontWeight.Bold, s.secondaryInk), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (up.kind == UpNext.Kind.Item) VoltIconButton(Icons.Filled.SkipNext, t("playNow"), size = 18.dp, onClick = playNow)
                VoltIconButton(Icons.Filled.Close, if (up.kind == UpNext.Kind.Item) t("cancel") else t("dismiss"), size = 16.dp, onClick = cancel)
            }
            Canvas(Modifier.fillMaxWidth().height(2.dp)) {
                drawRect(s.text.copy(alpha = 0.2f), size = size)
                drawRect(s.primary, size = Size(size.width * up.progress.toFloat(), size.height))
            }
        }
        return
    }
    Column(
        Modifier
            .widthIn(max = if (tv) 460.dp else 300.dp)
            .clip(s.shape)
            .background(s.secondary.copy(alpha = 0.94f))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            voltUrl(up.artworkUrl, base)?.let { u ->
                AsyncImage(u, null, contentScale = ContentScale.Crop, modifier = Modifier.size(if (tv) 96.dp else 64.dp, if (tv) 54.dp else 36.dp).clip(RoundedCornerShape(4.dp)))
            }
            Column(Modifier.weight(1f, fill = false)) {
                Text(up.kicker(t), style = s.type(11f, FontWeight.SemiBold, s.muted))
                Text(up.title, style = s.type(15f, FontWeight.Bold, s.secondaryInk), maxLines = 1, overflow = TextOverflow.Ellipsis)
                up.subtitle?.let { Text(it, style = s.type(12f, color = s.muted), maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        }
        Canvas(Modifier.fillMaxWidth().height(3.dp)) {
            drawRect(s.text.copy(alpha = 0.2f), size = size)
            drawRect(s.primary, size = Size(size.width * up.progress.toFloat(), size.height))
        }
        if (up.kind == UpNext.Kind.Item) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                VoltPillButton(t("playNow"), Icons.Filled.SkipNext, tv = tv, onClick = playNow)
                VoltPillButton(t("cancel"), primary = false, tv = tv, onClick = cancel)
            }
        } else {
            VoltPillButton(t("dismiss"), primary = false, tv = tv, onClick = cancel)
        }
    }
}

/** Skip intro / recap / credits. */
@Composable
fun SkipButton(offer: SkipOffer, tv: Boolean = false, onSkip: () -> Unit) {
    val t = LocalVoltT.current
    val text = when (offer.kind) { "intro" -> t("skipIntro"); "recap" -> t("skipRecap"); "credits" -> t("skipCredits"); else -> t("skip") }
    VoltPillButton(text, Icons.Filled.SkipNext, tv = tv, onClick = onSkip)
}

/** A message in the middle of the picture, with Try again. */
@Composable
fun CenterMessage(text: String, tv: Boolean = false, retry: (() -> Unit)?) {
    val s = LocalVoltStyle.current
    val t = LocalVoltT.current
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.padding(16.dp)) {
        Text(text, style = s.type(15f, FontWeight.SemiBold), textAlign = TextAlign.Center)
        if (retry != null) VoltPillButton(t("retry"), tv = tv, onClick = retry)
    }
}

/** The buffering spinner, in the theme's text colour. */
@Composable
fun VoltSpinner(tv: Boolean = false) {
    CircularProgressIndicator(color = LocalVoltStyle.current.text, strokeWidth = if (tv) 4.dp else 3.dp, modifier = Modifier.size(if (tv) 56.dp else 40.dp))
}

/**
 * The channel's brand mark, placed as the encoder would burn it: offsets in pixels of a
 * 1920x1080 frame from the corner, height a percentage of the frame height.
 */
@Composable
fun BrandMarkView(mark: BrandMark) {
    val base = LocalVoltBase.current
    val url = voltUrl(mark.url, base) ?: return
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val k = maxWidth.value / 1920f
        val h = (maxHeight.value * (mark.scale / 100f).toFloat()).dp
        val ox = (mark.offsetX * k).toFloat().dp
        val oy = (mark.offsetY * k).toFloat().dp
        val align = when (mark.position) {
            BrandMark.Position.tl -> Alignment.TopStart; BrandMark.Position.tc -> Alignment.TopCenter; BrandMark.Position.tr -> Alignment.TopEnd
            BrandMark.Position.bl -> Alignment.BottomStart; BrandMark.Position.bc -> Alignment.BottomCenter; BrandMark.Position.br -> Alignment.BottomEnd
        }
        val x = when (mark.position) { BrandMark.Position.tl, BrandMark.Position.bl -> ox; BrandMark.Position.tr, BrandMark.Position.br -> -ox; else -> 0.dp }
        val y = when (mark.position) { BrandMark.Position.tl, BrandMark.Position.tc, BrandMark.Position.tr -> oy; else -> -oy }
        AsyncImage(url, null, contentScale = ContentScale.Fit, alpha = (mark.opacity / 100).toFloat().coerceIn(0f, 1f),
            modifier = Modifier.align(align).offset(x, y).height(h))
    }
}

/** Diagonal text repeated over the picture (share previews). Stays in full screen. */
@Composable
fun WatermarkView(text: String) {
    val s = LocalVoltStyle.current
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.rotate(-24f), verticalArrangement = Arrangement.spacedBy(48.dp)) {
            repeat(5) {
                Text("$text   $text   $text", style = s.type(16f, FontWeight.Bold, s.text.copy(alpha = 0.16f)), maxLines = 1)
            }
        }
    }
}

data class MenuChoice(val id: String?, val label: String)

/**
 * A control that opens a list of choices (subtitles, audio, quality, speed). A dialog, not a
 * drop-down, so it works the same with touch, a keyboard and a TV remote.
 */
@Composable
fun ChoiceMenu(icon: ImageVector, label: String, choices: List<MenuChoice>, selected: String?, tv: Boolean = false, onPick: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    VoltIconButton(icon, label, size = 20.dp, tv = tv) { open = true }
    if (open) ChoiceDialog(label, choices, selected, tv, onDismiss = { open = false }) { onPick(it); open = false }
}

@Composable
fun ChoiceDialog(title: String, choices: List<MenuChoice>, selected: String?, tv: Boolean = false, onDismiss: () -> Unit, onPick: (String?) -> Unit) {
    val s = LocalVoltStyle.current
    val first = remember { FocusRequester() }
    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .widthIn(min = 220.dp, max = if (tv) 520.dp else 360.dp)
                .clip(s.shape)
                .background(s.secondary)
                .padding(vertical = 8.dp),
        ) {
            Text(title, style = s.type(13f, FontWeight.SemiBold, s.muted), modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            LazyColumn(Modifier.heightIn(max = if (tv) 520.dp else 400.dp)) {
                itemsIndexed(choices) { i, c ->
                    val on = c.id == selected
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .then(if (i == choices.indexOfFirst { it.id == selected }.coerceAtLeast(0)) Modifier.focusRequester(first) else Modifier)
                            .voltFocus(RoundedCornerShape(6.dp), tv)
                            .clickable { onPick(c.id) }
                            .padding(horizontal = 16.dp, vertical = if (tv) 14.dp else 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.width(26.dp)) { if (on) Icon(Icons.Filled.Check, null, tint = s.primary, modifier = Modifier.size(18.dp)) }
                        Text(c.label, style = s.type(15f, if (on) FontWeight.Bold else FontWeight.Normal, s.secondaryInk))
                    }
                }
            }
        }
    }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
}

/** Why the viewer cannot watch, and what would let them: passes with Buy, Sign in, Check again. */
@Composable
fun LockedPanel(access: AccessState, commands: VoltCommands, tv: Boolean = false) {
    val s = LocalVoltStyle.current
    val t = LocalVoltT.current
    Column(
        Modifier.widthIn(max = if (tv) 640.dp else 420.dp).clip(s.shape).background(s.secondary.copy(alpha = 0.94f)).padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(Icons.Filled.Lock, null, tint = s.secondaryInk, modifier = Modifier.size(if (tv) 32.dp else 22.dp))
        val title = when (access.mode) {
            AccessState.Mode.Paywall -> t("buyTitle")
            AccessState.Mode.SignIn -> t("signInTitle")
            AccessState.Mode.Blocked -> t("regionBlocked")
            null -> access.message ?: t("offline")
        }
        Text(title, style = s.type(16f, FontWeight.Bold, s.secondaryInk), textAlign = TextAlign.Center)
        if (access.mode != AccessState.Mode.Blocked) access.message?.takeIf { it != title }?.let {
            Text(it, style = s.type(13f, color = s.muted), textAlign = TextAlign.Center)
        }
        for (p in access.products) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(Modifier.widthIn(min = 120.dp)) {
                    Text(p.name ?: Gate.fmtTerm(p), style = s.type(14f, FontWeight.SemiBold, s.secondaryInk))
                    Text(Gate.fmtTerm(p), style = s.type(12f, color = s.muted))
                }
                VoltPillButton("${t("buy")} ${Gate.fmtPrice(p.priceCents, p.currency)}", tv = tv) { commands.purchase(p.productKey) }
            }
        }
        if (access.mode == AccessState.Mode.SignIn || access.mode == AccessState.Mode.Paywall) {
            VoltPillButton(t("signIn"), primary = access.products.isEmpty(), tv = tv) { commands.signIn() }
        }
        if (access.mode == AccessState.Mode.Paywall) {
            Text(t("alreadyBought"), style = s.type(12f, FontWeight.SemiBold, s.primary),
                modifier = Modifier.clip(RoundedCornerShape(4.dp)).voltFocus(RoundedCornerShape(4.dp), tv).clickable { commands.refreshAccess() }.padding(6.dp))
        }
    }
}

/** What is really playing, for support: resolution, bitrate, buffer, distance behind live. */
@Composable
fun StatsPanel(state: PlayerState, tv: Boolean = false, close: () -> Unit) {
    val s = LocalVoltStyle.current
    val t = LocalVoltT.current
    val q = state.activeQuality
    Box(Modifier.fillMaxSize().padding(10.dp), contentAlignment = Alignment.TopStart) {
        Column(Modifier.clip(s.shape).background(Color.Black.copy(alpha = 0.78f)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(t("playbackStats"), style = s.type(12f, FontWeight.Bold, Color.White))
                Spacer(Modifier.width(10.dp))
                VoltIconButton(Icons.Filled.Close, t("dismiss"), size = 14.dp, tv = tv, onClick = close)
            }
            @Composable fun line(k: String, v: String) = Text("$k  $v", style = s.type(11f, color = Color.White))
            line(t("resolution"), q?.let { "${it.width ?: "?"}x${it.height ?: "?"} (${it.label})" } ?: "-")
            line(t("bitrate"), q?.let { "${(it.bitrate / 1000).toInt()} kbps" } ?: "-")
            line(t("quality"), if (state.quality == "auto") t("auto") else state.quality)
            if (state.live) line(t("latency"), Schedule.fmtTime(state.behindLive))
            line("Status", state.status.name.lowercase())
            state.item?.assetId?.let { line("Asset", it) }
        }
    }
}

/** Dp from pixels, for the few places that measure. */
@Composable fun pxToDp(px: Float): Dp = with(LocalDensity.current) { px.toDp() }
