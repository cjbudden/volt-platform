// The tv skin's rules, the same cases as the Swift TVRulesTests and TVThemeTokenTests,
// so Android TV and Apple TV resolve and behave alike.
package com.volt.player.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TvThemeTokenParityTests {
    @Test fun defaults() {
        val t = ThemeTokens.resolve()
        assertEquals("#3f7bff", t.focusColor); assertEquals(10.0, t.seekStep, 0.0)
    }

    @Test fun focusColorFallsBackToPrimaryThenInk() {
        assertEquals("#3f7bff", ThemeTokens.resolve(Theme(secondary = "#f5f5f4", focusColor = "#ffffff")).focusColor)
        assertEquals("neither reads on black: white", "#ffffff",
            ThemeTokens.resolve(Theme(primary = "#111111", secondary = "#000000", focusColor = "#222222")).focusColor)
        assertEquals("#ffd60a", ThemeTokens.resolve(Theme(focusColor = "#ffd60a")).focusColor)
        assertEquals("not a hex colour", "#3f7bff", ThemeTokens.resolve(Theme(focusColor = "yellow")).focusColor)
    }

    @Test fun seekStepSnaps() {
        assertEquals(10.0, ThemeTokens.resolve(Theme(seekStep = Double.NaN)).seekStep, 0.0)
        assertEquals("later layers win", 15.0, ThemeTokens.resolve(Theme(seekStep = 30.0), Theme(seekStep = 15.0)).seekStep, 0.0)
    }

    @Test fun fromJson() {
        val t = ThemeTokens.resolve(Theme.fromJson(JsonObject(mapOf("focusColor" to JsonPrimitive("#ffd60a"), "seekStep" to JsonPrimitive(30)))))
        assertEquals("#ffd60a", t.focusColor); assertEquals(30.0, t.seekStep, 0.0)
    }
}

class TvRulesTests {
    private val now = 1_792_500_000_000.0

    /** A live channel with a one hour window, the playhead 60 s behind live. */
    private fun live() = PlayerState(live = true, dvr = true, seekable = SeekWindow(0.0, 3600.0), currentTime = 3540.0, wallClock = now - 60_000)

    @Test fun seekTargetOnDemand() {
        var s = PlayerState(duration = 100.0, currentTime = 95.0)
        assertEquals("kept inside the duration", 100.0, TvRules.seekTarget(s, 10.0)!!, 0.0)
        s = s.copy(currentTime = 4.0)
        assertEquals(0.0, TvRules.seekTarget(s, -10.0)!!, 0.0)
        assertNull("nothing to seek in before the duration is known", TvRules.seekTarget(s.copy(duration = Double.NaN), 10.0))
    }

    @Test fun seekTargetLive() {
        val s = live()
        assertEquals(3570.0, TvRules.seekTarget(s, 30.0)!!, 0.0)
        assertEquals("never past the live edge", 3600.0, TvRules.seekTarget(s, 300.0)!!, 0.0)
        assertNull("no window, no seeking", TvRules.seekTarget(s.copy(dvr = false), -10.0))
    }

    @Test fun shouldHide() {
        assertFalse(TvRules.shouldHide(true, true, false, 4.9))
        assertTrue(TvRules.shouldHide(true, true, false, 5.0))
        assertFalse("paused keeps them", TvRules.shouldHide(true, false, false, 60.0))
        assertFalse("a panel keeps them", TvRules.shouldHide(true, true, true, 60.0))
    }

    @Test fun presentationStart() {
        assertEquals(now - 60_000 - 3_540_000, TvRules.presentationStart(live())!!, 0.0)
        assertNull(TvRules.presentationStart(PlayerState()))
    }

    @Test fun guideRows() {
        val ps = now - 60_000 - 3_540_000
        val s = live().copy(schedule = listOf(
            Programme(id = "gone", title = "Gone", startsAt = ps - 7_200_000, endsAt = ps - 600_000),
            Programme(id = "clip", title = "Half in", startsAt = ps - 600_000, endsAt = ps + 1_200_000),
            Programme(id = "early", title = "Earlier", startsAt = ps + 1_200_000, endsAt = ps + 3_000_000),
            Programme(id = "now", title = "On now", startsAt = ps + 3_000_000, endsAt = now + 1_800_000),
            Programme(id = "later", title = "Later", startsAt = now + 1_800_000, endsAt = now + 3_600_000),
        ))
        val rows = TvRules.guideRows(s, now)
        assertEquals("a programme wholly before the window is left out", listOf("clip", "early", "now", "later"), rows.map { it.id })
        assertEquals(TvRules.GuideRow.Kind.Earlier, rows[0].kind); assertTrue(rows[0].clipped)
        assertEquals("from the earliest part kept", 1.0, rows[0].target!!, 0.0)
        assertEquals(1200.0, rows[1].target!!, 0.0); assertFalse(rows[1].clipped)
        assertEquals(TvRules.GuideRow.Kind.OnNow, rows[2].kind); assertEquals("on now: from its start", 3000.0, rows[2].target!!, 0.0)
        assertEquals(TvRules.GuideRow.Kind.Later, rows[3].kind); assertNull(rows[3].target)
        assertEquals(2, TvRules.initialRow(rows))
    }

    @Test fun guideWithoutWindow() {
        val s = PlayerState(live = true, schedule = listOf(
            Programme(id = "a", title = "A", startsAt = now - 7_200_000, endsAt = now - 600_000),
            Programme(id = "b", title = "B", startsAt = now - 600_000, endsAt = now + 600_000),
            Programme(id = "c", title = "C", startsAt = now + 600_000, endsAt = now + 1_200_000),
        ))
        val rows = TvRules.guideRows(s, now)
        assertEquals("without a window nothing earlier can be watched", listOf("b", "c"), rows.map { it.id })
        assertNull(rows[0].target)
    }

    @Test fun guideLimitKeepsOnNow() {
        val s = PlayerState(live = true, schedule = (0 until 100).map { i ->
            Programme(id = "p$i", title = "P$i", startsAt = now + (i - 1) * 600_000.0, endsAt = now + i * 600_000.0)
        })
        val rows = TvRules.guideRows(s, now, limit = 10)
        assertEquals(10, rows.size)
        assertEquals("the one on now is first when nothing earlier is watchable", "p1", rows.first().id)
        assertNull(TvRules.initialRow(emptyList()))
    }
}
