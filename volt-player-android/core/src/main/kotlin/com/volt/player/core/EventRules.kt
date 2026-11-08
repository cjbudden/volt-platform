// ============================================================================
//  EVENTS: countdown, polling, calendar. The rules of the web event skin
//  (volt-player/src/sdk/skins/event.ts and player.ts pollEvent), shared by
//  every native skin.
//
//  The phase (pre / live / ended / replay / offline / postponed / cancelled)
//  is decided by the control plane. The player never guesses it from its own
//  clock; it only counts down to the start it was given, and asks again
//  every 30 s, every 5 s in the last two minutes and while a start is late.
// ============================================================================
package com.volt.player.core

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.floor
import kotlin.math.roundToLong

object EventRules {
    /** Seconds until the next phase check. */
    fun pollDelay(presentation: Presentation?, msToStart: Double?): Double {
        if (presentation == Presentation.Offline) return 5.0
        if (msToStart != null && msToStart <= 120_000) return 5.0
        return 30.0
    }

    /** Milliseconds to the start, or null when there is nothing to count down to. */
    fun msToStart(e: EventInfo?, now: EpochMs): Double? {
        val s = e?.startsAt ?: return null
        if (e.presentation != Presentation.Pre || s <= now) return null
        return s - now
    }

    /** Days, hours, minutes and seconds of a countdown. */
    data class Countdown(val days: Int, val hours: Int, val minutes: Int, val seconds: Int)

    fun countdown(ms: Double): Countdown {
        val s = maxOf(0L, floor(ms / 1000).toLong()).toInt()
        return Countdown(days = s / 86_400, hours = (s % 86_400) / 3600, minutes = (s % 3600) / 60, seconds = s % 60)
    }

    /** Whether the video player is shown (live, or the replay playing). */
    fun showsVideo(presentation: Presentation?, replaying: Boolean): Boolean = replaying || presentation == Presentation.Live

    internal fun icsDate(ms: EpochMs): String {
        val f = SimpleDateFormat("yyyyMMdd'T'HHmmss'Z'", Locale.US)
        f.timeZone = TimeZone.getTimeZone("UTC")
        return f.format(Date(ms.roundToLong()))
    }

    internal fun icsText(s: String): String = s.replace("\\", "\\\\").replace(",", "\\,").replace(";", "\\;")
        .replace("\r\n", "\\n").replace("\n", "\\n")

    /** An .ics file for the event, so Add to calendar works with every calendar app. */
    fun ics(id: String, title: String, startsAt: EpochMs, endsAt: EpochMs?, description: String?, url: String, now: EpochMs): String {
        val end = if ((endsAt ?: 0.0) > startsAt) endsAt!! else startsAt + 2 * 3_600_000
        val lines = mutableListOf("BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Volt//Player//EN", "BEGIN:VEVENT",
            "UID:$id@volt-player", "DTSTAMP:${icsDate(now)}", "DTSTART:${icsDate(startsAt)}", "DTEND:${icsDate(end)}",
            "SUMMARY:${icsText(title)}")
        if (!description.isNullOrEmpty()) lines += "DESCRIPTION:${icsText(description)}"
        lines += "URL:$url"
        lines += listOf("END:VEVENT", "END:VCALENDAR")
        return lines.joinToString("\r\n")
    }
}
