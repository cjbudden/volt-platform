// ============================================================================
//  THE EVENT SKIN, the native twin of skins/event.ts and the Swift EventSkin.
//
//  Draws the phase the control plane reports over the event's promo, and
//  hands over to the video skin (tv on a TV) when it is live or the replay
//  is playing:
//
//    pre         countdown, the start in the viewer's own time, Add to calendar
//    offline     past the start, not live yet: "Starting soon"
//    postponed   was / now, or "a new date will be announced"
//    cancelled   said plainly, no countdown
//    ended       the promoter's closing message
//    replay      Watch the replay
//    locked      at any phase: the passes with Buy, or Sign in
//
//  On a TV there is no Add to calendar (a TV has no calendar).
// ============================================================================
package com.volt.player.ui

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import coil.compose.AsyncImage
import com.volt.player.core.EventRules
import com.volt.player.core.EventPromo
import com.volt.player.core.PlayerStatus
import com.volt.player.core.Presentation
import com.volt.player.core.PromoSide
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date

@Composable
fun EventSkin(ctx: SkinContext) {
    val st = ctx.state
    if (EventRules.showsVideo(st.presentation, st.replaying) && st.status != PlayerStatus.Locked) {
        if (ctx.tv) TvSkin(ctx) else VideoSkin(ctx)
        return
    }
    val s = LocalVoltStyle.current
    val base = LocalVoltBase.current
    var now by remember { mutableDoubleStateOf(System.currentTimeMillis().toDouble()) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis().toDouble() } }
    Box(Modifier.fillMaxSize().background(s.background), contentAlignment = Alignment.Center) {
        voltUrl(st.event?.promo?.posterUrl, base)?.let { u ->
            AsyncImage(u, null, contentScale = if (st.event?.promo?.posterFit == "contain") ContentScale.Fit else ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(s.background.copy(alpha = 0.2f), s.background.copy(alpha = 0.92f)))))
        Column(Modifier.padding(18.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Promo(ctx)
            Phase(ctx, now)
            if (st.status == PlayerStatus.Locked || st.access.products.isNotEmpty()) LockedPanel(st.access, ctx.commands, ctx.tv)
        }
    }
}

@Composable
private fun Promo(ctx: SkinContext) {
    val s = LocalVoltStyle.current
    val e = ctx.state.event
    val promo = e?.promo
    val sides = promo?.sides
    if (promo != null && sides != null && sides.size >= 2 && promo.template == EventPromo.Template.Versus) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Side(sides[0])
            Text(promo.separator ?: "vs", style = s.type(16f, FontWeight.ExtraBold, s.muted))
            Side(sides[1])
        }
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        e?.promo?.headline?.let { Text(it, style = s.type(12f, FontWeight.SemiBold, s.muted)) }
        Text(e?.title ?: ctx.state.item?.title ?: "", style = s.type(22f, FontWeight.ExtraBold), textAlign = TextAlign.Center)
        e?.promo?.subhead?.let { Text(it, style = s.type(13f, color = s.muted)) }
    }
}

@Composable
private fun Side(p: PromoSide) {
    val s = LocalVoltStyle.current
    Column(Modifier.widthIn(max = (140 * s.scale).dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        voltUrl(p.imageUrl, LocalVoltBase.current)?.let { AsyncImage(it, null, contentScale = ContentScale.Fit, modifier = Modifier.size((56 * s.scale).dp)) }
        Text(p.name, style = s.type(14f, FontWeight.Bold), maxLines = 2, textAlign = TextAlign.Center)
    }
}

private fun whenText(ms: Double): String =
    DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(ms.toLong()))

@Composable
private fun Phase(ctx: SkinContext, now: Double) {
    val s = LocalVoltStyle.current
    val t = ctx.t
    val st = ctx.state
    val e = st.event
    val context = LocalContext.current
    when (st.presentation) {
        Presentation.Pre -> e?.startsAt?.let { start ->
            val cd = EventRules.countdown(start - now)
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(t("startsIn2"), style = s.type(12f, FontWeight.SemiBold, s.muted))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    CountUnit(cd.days, t("days")); CountUnit(cd.hours, t("hours")); CountUnit(cd.minutes, t("mins")); CountUnit(cd.seconds, t("secs"))
                }
                Text(whenText(start), style = s.type(13f))
                e.preMessage?.let { Text(it, style = s.type(13f, color = s.muted), textAlign = TextAlign.Center) }
                if (!ctx.tv) VoltPillButton(t("addToCalendar"), Icons.Filled.CalendarMonth, primary = false) {
                    // An .ics the viewer opens in any calendar app.
                    runCatching {
                        val ics = EventRules.ics(e.id, e.title, start, e.endsAt, e.description, "", System.currentTimeMillis().toDouble())
                        val f = java.io.File(context.cacheDir, "volt-event-${e.id.take(36)}.ics").apply { writeText(ics) }
                        val uri = FileProvider.getUriForFile(context, "${context.packageName}.volt.files", f)
                        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "text/calendar")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), t("addToCalendar")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    }
                }
            }
        }
        Presentation.Offline -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(t("startingSoon"), style = s.type(17f, FontWeight.Bold))
            Text(t("startingSoonText"), style = s.type(13f, color = s.muted))
            VoltSpinner(ctx.tv)
        }
        Presentation.Postponed -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(t("postponed"), style = s.type(17f, FontWeight.Bold))
            e?.previousStartsAt?.let { Text(t("wasAt", mapOf("when" to whenText(it))), style = s.type(13f, color = s.muted).copy(textDecoration = TextDecoration.LineThrough)) }
            val start = e?.startsAt
            if (start != null) Text(t("nowAt", mapOf("when" to whenText(start))), style = s.type(13f, FontWeight.SemiBold))
            else Text(t("newDateTba"), style = s.type(13f, color = s.muted))
        }
        Presentation.Cancelled -> Text(t("cancelled"), style = s.type(17f, FontWeight.Bold))
        Presentation.Replay -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(t("ended"), style = s.type(15f, FontWeight.SemiBold, s.muted))
            VoltPillButton(t("watchReplay"), Icons.Filled.PlayArrow, tv = ctx.tv) { ctx.commands.playReplay() }
            Text(t("replayHint"), style = s.type(12f, color = s.muted))
        }
        Presentation.Ended -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(t("ended"), style = s.type(17f, FontWeight.Bold))
            e?.endedMessage?.let { Text(it, style = s.type(13f, color = s.muted), textAlign = TextAlign.Center) }
        }
        else -> VoltSpinner(ctx.tv)
    }
}

@Composable
private fun CountUnit(v: Int, label: String) {
    val s = LocalVoltStyle.current
    Column(
        Modifier.widthIn(min = (52 * s.scale).dp).clip(s.shape).background(s.secondary.copy(alpha = 0.85f)).padding(vertical = 6.dp, horizontal = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("%02d".format(v), style = s.type(26f, FontWeight.ExtraBold))
        Text(label, style = s.type(10f, FontWeight.SemiBold, s.muted))
    }
}
