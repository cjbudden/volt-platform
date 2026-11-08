// ============================================================================
//  TV RULES: what the `tv` skin decides, kept here so it is tested on any
//  machine (the skin itself only draws). The same rules as the Swift TVRules,
//  so Android TV and Apple TV behave alike.
//
//    seekTarget        where left and right on the remote go: the theme's
//                      seek step, kept inside what can be played
//    shouldHide        controls appear on any remote input and go away a few
//                      seconds after the last one, never while a panel is
//                      open or nothing is playing
//    guideRows         the schedule as the guide panel lists it: what is on
//                      now, what can still be watched from its start (it is
//                      inside the DVR window), and what is later
//
//  The guide works from the state alone. The wall clock of media time 0 is
//  the playhead's wall clock minus the playhead.
// ============================================================================
package com.volt.player.core

import kotlin.math.max
import kotlin.math.min

object TvRules {
    /** Seconds after the last remote input before the controls hide while playing. */
    const val CONTROLS_HIDE_DELAY = 5.0

    /** Whether the controls should hide now. */
    fun shouldHide(shown: Boolean, playing: Boolean, panelOpen: Boolean, idleSeconds: Double): Boolean =
        shown && playing && !panelOpen && idleSeconds >= CONTROLS_HIDE_DELAY

    /**
     * Where a press of left (negative) or right (positive) goes, or null when there is nothing to
     * seek in: a live stream without a DVR window, or on demand before the duration is known.
     */
    fun seekTarget(s: PlayerState, delta: Double): Double? {
        val to = s.currentTime + delta
        if (s.live) {
            val w = s.seekable
            if (!s.dvr || w == null || w.end <= w.start) return null
            return min(max(w.start, to), w.end)
        }
        if (!s.duration.isFinite() || s.duration <= 0) return null
        return min(max(0.0, to), s.duration)
    }

    /** The wall-clock instant (epoch ms) of media time 0, from the playhead's own wall clock. */
    fun presentationStart(s: PlayerState): EpochMs? {
        val w = s.wallClock ?: return null
        if (!w.isFinite()) return null
        return w - s.currentTime * 1000
    }

    data class GuideRow(
        val programme: Programme,
        val kind: Kind,
        /** Media seconds to seek to for "watch from the start", or null when it cannot be watched. */
        val target: Double?,
        /** The window no longer reaches the start: playing from the earliest part kept. */
        val clipped: Boolean,
    ) {
        enum class Kind { Earlier, OnNow, Later }
        val id: String get() = programme.id
    }

    /**
     * The guide as a list, in time order: earlier programmes still (partly) in the window, the one
     * on now, then later ones (shown, not playable). At most `limit` rows.
     */
    fun guideRows(s: PlayerState, now: EpochMs, limit: Int = 40): List<GuideRow> {
        val ps = presentationStart(s)
        val at = s.wallClock ?: now
        val windowStartWall: EpochMs? = if (ps != null && s.seekable != null) ps + s.seekable.start * 1000 else null
        val rows = mutableListOf<GuideRow>()
        for (p in s.schedule.sortedBy { it.startsAt }) {
            val onNow = p.startsAt <= at && at < p.endsAt
            if (p.startsAt > at) { rows += GuideRow(p, GuideRow.Kind.Later, null, false); continue }
            // Earlier or on now: watchable if any of it is still in the window.
            if (windowStartWall != null && p.endsAt <= windowStartWall) continue
            if (windowStartWall == null && !onNow) continue
            var target: Double? = null
            var clipped = false
            if (s.live && s.dvr) Schedule.startOverTarget(p.startsAt, ps, s.seekable)?.let { target = it.seconds; clipped = it.clippedMs > 0 }
            rows += GuideRow(p, if (onNow) GuideRow.Kind.OnNow else GuideRow.Kind.Earlier, target, clipped)
        }
        if (rows.size <= limit) return rows
        // Keep the rows around the one on now.
        val i = rows.indexOfFirst { it.kind == GuideRow.Kind.OnNow }.let { if (it < 0) 0 else it }
        val from = max(0, min(i - limit / 4, rows.size - limit))
        return rows.subList(from, from + limit).toList()
    }

    /** The row the guide opens on: the one on now, else the first. */
    fun initialRow(rows: List<GuideRow>): Int? =
        if (rows.isEmpty()) null else rows.indexOfFirst { it.kind == GuideRow.Kind.OnNow }.let { if (it < 0) 0 else it }
}
