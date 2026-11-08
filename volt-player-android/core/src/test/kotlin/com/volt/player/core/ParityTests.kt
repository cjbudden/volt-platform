// ============================================================================
//  PARITY WITH THE WEB SDK (and the Swift SDK).
//
//  The same cases, with the same expected answers, as the web SDK's own checks
//  (volt-app/test/player-sdk.check.ts and player-triggers.check.ts) and the
//  Swift ParityTests. If one of these fails, Android and the web disagree about
//  a rule, which is a bug on one side or the other, never something to "fix"
//  in the test.
// ============================================================================
package com.volt.player.core

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class ScheduleParityTests {
    private val H = 3_600_000.0
    private val T = 1_792_238_400_000.0 // 2026-10-17T12:00:00Z

    private val sched: List<Programme> get() = Schedule.clean(listOf(
        mapOf("id" to "b", "title" to "Science Hour", "startsAt" to T + H, "endsAt" to T + 2 * H),
        mapOf("id" to "a", "title" to "News", "startsAt" to T, "endsAt" to T + H),
        mapOf("id" to "x", "title" to "bad", "startsAt" to T + 5 * H, "endsAt" to T + 4 * H),
        mapOf("id" to "a", "title" to "dupe", "startsAt" to T, "endsAt" to T + H),
        mapOf("id" to "c", "title" to "Film", "startsAt" to T + 3 * H, "endsAt" to T + 5 * H),
    ))

    @Test fun guide() {
        assertEquals("sorted, de-duplicated, invalid rows dropped", listOf("a", "b", "c"), sched.map { it.id })
        assertEquals("a", Schedule.programmeAt(sched, T + 30 * 60_000)?.id)
        assertNull("a gap is no programme", Schedule.programmeAt(sched, T + 2.5 * H))
        assertEquals("b", Schedule.programmeAfter(sched, T + H - 1)?.id)
    }

    private fun vod(t: Double, hasNext: Boolean = true, duration: Double = 600.0, auto: Boolean = true, dismissed: Boolean = false) =
        Schedule.upNext(Schedule.UpNextInput(hasNext, PlaylistItem(id = "n", title = "Episode 2"), t, duration, false, null, null, null, 15.0, auto, dismissed))

    @Test fun upNextOnDemand() {
        assertNull(vod(500.0))
        val u = vod(590.0)!!
        assertEquals(UpNext.Kind.Item, u.kind); assertEquals("Episode 2", u.title); assertEquals(10_000.0, u.inMs, 0.0)
        assertTrue(u.autoAdvance); assertEquals(15_000.0, u.totalMs, 0.0)
        assertNull("cancelled stays cancelled", vod(590.0, dismissed = true))
        assertNull(vod(590.0, hasNext = false))
        assertNull("an item shorter than twice the window gets no card", vod(20.0, duration = 25.0))
        assertEquals(false, vod(590.0, auto = false)?.autoAdvance)
    }

    private fun live(clock: Double, next: Programme? = null) = Schedule.upNext(Schedule.UpNextInput(false, null, 0.0, Double.NaN, true,
        sched[0], next ?: sched[1], clock, 60.0, true, false))

    @Test fun upNextLive() {
        assertEquals("Science Hour", live(T + H - 30_000)?.title)
        assertEquals(UpNext.Kind.Programme, live(T + H - 30_000)?.kind)
        assertEquals(false, live(T + H - 30_000)?.autoAdvance)
        assertNull(live(T + 10 * 60_000))
        assertNull("a programme hours later is not up next", live(T + H - 30_000, next = sched[2]))
    }

    @Test fun startOver() {
        val ps = T - 10 * 60_000
        val a = Schedule.startOverTarget(T, ps, SeekWindow(0.0, 1200.0))!!
        assertEquals(600.0, a.seconds, 0.0); assertEquals(0.0, a.clippedMs, 0.0)
        val c = Schedule.startOverTarget(T, ps, SeekWindow(700.0, 1900.0))!!
        assertEquals(701.0, c.seconds, 0.0); assertEquals(101_000.0, c.clippedMs, 0.0)
        assertNull(Schedule.startOverTarget(T, null, SeekWindow(0.0, 100.0)))
        assertTrue(Schedule.canStartOver(sched[0], ps, SeekWindow(0.0, 1200.0), true))
        assertFalse(Schedule.canStartOver(sched[0], ps, SeekWindow(700.0, 1900.0), true))
        assertFalse(Schedule.canStartOver(sched[0], ps, SeekWindow(0.0, 1200.0), false))
    }

    @Test fun qualities() {
        val q = Schedule.qualityList(listOf(
            Schedule.VariantInput("1", 720, 1280, 3_000_000.0), Schedule.VariantInput("2", 720, 1280, 2_500_000.0),
            Schedule.VariantInput("3", 1080, 1920, 6_000_000.0), Schedule.VariantInput("4", 360, 640, 800_000.0),
            Schedule.VariantInput("5", 2160, 3840, 15_000_000.0)))
        assertEquals(listOf("4K", "1080p", "720p", "360p"), q.map { it.label })
        assertEquals("1", q.first { it.label == "720p" }.id)
        val aq = Schedule.qualityList(listOf(Schedule.VariantInput("7", null, null, 128_000.0), Schedule.VariantInput("8", null, null, 64_000.0)))
        assertEquals(listOf("128 kbps", "64 kbps"), aq.map { it.label })
    }

    @Test fun playlists() {
        val pl = Schedule.normalize(listOf(
            Schedule.Entry.Str("c6ffb359-4ce7-4e79-9817-778f69d418ba"), Schedule.Entry.Str("https://cdn.example.com/show/ep1/master.m3u8"),
            Schedule.Entry.Str(""), Schedule.Entry.Item(PlaylistItem(id = "x", title = "X")),
            Schedule.Entry.Item(PlaylistItem(id = "y", source = Source(mp3 = "https://r.example.com/live.mp3")))))
        assertEquals(4, pl.size)
        assertEquals(0, Schedule.normalize(listOf(Schedule.Entry.Item(PlaylistItem(id = "z")))).size)
        assertEquals("c6ffb359-4ce7-4e79-9817-778f69d418ba", pl[0].assetId)
        assertNotNull(pl[1].source?.url); assertEquals("ep1", pl[1].title)
        assertEquals(Schedule.SourceKind.Hls, Schedule.sourceKind("https://x/a.m3u8?t=1"))
        assertEquals(Schedule.SourceKind.Dash, Schedule.sourceKind("https://x/a.mpd"))
        assertEquals(Schedule.SourceKind.Mp3, Schedule.sourceKind("https://x/a.mp3"))
        assertEquals(Schedule.SourceKind.Mp4, Schedule.sourceKind("https://x/a.mp4"))
        assertEquals("1:05", Schedule.fmtTime(65.0)); assertEquals("1:02:05", Schedule.fmtTime(3725.0)); assertEquals("0:00", Schedule.fmtTime(Double.NaN))
    }
}

class ThemeParityTests {
    @Test fun ink() {
        assertEquals("#0b0e13", ThemeTokens.inkFor("#ffffff"))
        assertEquals("#ffffff", ThemeTokens.inkFor("#000000"))
        assertEquals("#ffffff", ThemeTokens.inkFor("#e11d48"))
    }

    @Test fun resolve() {
        val th = ThemeTokens.resolve(Theme(primary = "#e11d48", secondary = "#f5f5f4", text = "#f6f6f6", radius = 99.0, upNextSeconds = 2.0, controls = mapOf("cast" to false)))
        assertEquals("light text on a light background is replaced", "#0b0e13", th.text)
        assertTrue(ThemeTokens.contrast(th.text, th.background) >= 4.5)
        assertEquals(28.0, th.radius, 0.0); assertEquals(5.0, th.upNextSeconds, 0.0)
        assertFalse(th.controls.cast); assertTrue(th.controls.quality)
        assertEquals("#3f7bff", ThemeTokens.resolve(Theme(primary = "red")).primary)
        assertNull(ThemeTokens.resolve(Theme(logoUrl = "javascript:alert(1)")).logoUrl)
        assertNull(ThemeTokens.resolve(Theme(logoUrl = "//evil.example/x.png")).logoUrl)
        assertEquals("https://cdn.example.com/l.png", ThemeTokens.resolve(Theme(logoUrl = "https://cdn.example.com/l.png")).logoUrl)
        assertNull("a later layer can clear the logo",
            ThemeTokens.resolve(Theme(logoUrl = "https://a/b.png"), Theme.fromJson(JsonObject(mapOf("logoUrl" to JsonNull)))).logoUrl)
    }

    @Test fun fromConfig() {
        val cfg = buildJsonObject {
            put("primaryColor", "#112233"); put("secondaryColor", "#ffffff")
            putJsonObject("options") { putJsonObject("theme") { put("radius", 4); putJsonObject("controls") { put("schedule", false) } } }
        }
        val t = ThemeTokens.resolve(ThemeTokens.fromConfig(cfg))
        assertEquals("#112233", t.primary); assertEquals(4.0, t.radius, 0.0); assertFalse(t.controls.schedule)
    }

    @Test fun graphicsSwitch() {
        assertTrue(ThemeTokens.resolve().showGraphics)
        assertFalse(ThemeTokens.resolve(Theme(showGraphics = false)).showGraphics)
    }
}

class EventParityTests {
    @Test fun countdown() {
        val ms = 2 * 86_400_000.0 + 3 * 3_600_000.0 + 240_000.0 + 5_500.0
        assertEquals(EventRules.Countdown(2, 3, 4, 5), EventRules.countdown(ms))
        assertEquals(EventRules.Countdown(0, 0, 0, 0), EventRules.countdown(-5.0))
    }

    @Test fun ics() {
        val start = 1_792_315_800_000.0 // 2026-10-18T09:30:00Z
        val ics = EventRules.ics("e1", "Final; Lions, Tigers", start, null, null, "https://x.example/watch", start)
        assertTrue(ics.contains("DTSTART:20261018T093000Z")); assertTrue(ics.contains("DTEND:20261018T113000Z"))
        assertTrue(ics.contains("SUMMARY:Final\\; Lions\\, Tigers"))
        assertEquals("BEGIN:VCALENDAR", ics.split("\r\n").first())
    }

    @Test fun prices() {
        assertEquals("24 hours", Gate.fmtTerm(Product("a", kind = Product.Kind.Period, count = 1, unit = Product.Unit.Day, priceCents = 0, currency = "AUD")))
        assertEquals("3 months", Gate.fmtTerm(Product("b", kind = Product.Kind.Period, count = 3, unit = Product.Unit.Month, priceCents = 0, currency = "AUD")))
        assertEquals("This event", Gate.fmtTerm(Product("c", kind = Product.Kind.PublishedDates, priceCents = 0, currency = "AUD")))
        val p = Gate.fmtPrice(1499, "AUD", Locale.forLanguageTag("en-AU"))
        assertTrue(p, p.contains("14.99") || p.contains("14,99"))
        assertEquals("https://shop.example/buy?p=final%20pass&a=e1&x=",
            Gate.fillUrl("https://shop.example/buy?p={productKey}&a={assetId}&x={nope}", mapOf("productKey" to "final pass", "assetId" to "e1")))
    }

    @Test fun polling() {
        assertEquals(30.0, EventRules.pollDelay(Presentation.Pre, 3_600_000.0), 0.0)
        assertEquals("last two minutes", 5.0, EventRules.pollDelay(Presentation.Pre, 90_000.0), 0.0)
        assertEquals("a late start", 5.0, EventRules.pollDelay(Presentation.Offline, null), 0.0)
    }
}

class TriggerParityTests {
    // The up-next trigger from player-triggers.check.ts, as a playlist carries it. Media time 0 is
    // presentationStart; the trigger starts at 71.7 s and lasts 12 s.
    private val ps = Triggers.parseISO("2026-10-20T18:26:00.000Z")!!
    private val playlist = """
        #EXTM3U
        #EXT-X-PROGRAM-DATE-TIME:2026-10-20T18:26:00.000Z
        #EXT-X-DATERANGE:ID="up-next:p1",CLASS="com.boomlabs.volt.graphic",START-DATE="2026-10-20T18:27:11.700Z",DURATION=12,X-ID="up-next:p1",X-GRAPHIC="up-next",X-TITLE="Evening Bulletin",X-STARTS="2026-10-20T18:30:00.000Z",X-SUBTITLE="Live from the harbour"
        #EXT-X-DATERANGE:ID="p1",CLASS="com.boomlabs.volt.programme",START-DATE="2026-10-20T18:26:00.000Z",END-DATE="2026-10-20T18:30:10.000Z",X-ID="p1",X-TITLE="Morning Show",X-GENRE="News",X-NEXT-TITLE="Evening Bulletin"
        #EXT-X-DATERANGE:ID="ad",CLASS="com.example.ads",START-DATE="2026-10-20T18:26:05.000Z",DURATION=30,X-AD="1"
        #EXTINF:6.0,
        seg1.ts
    """.trimIndent()

    private fun graphics() = Triggers.graphics(Triggers.parseDateRanges(playlist), ps)

    @Test fun parse() {
        val g = graphics()
        assertEquals("someone else's classes are ignored", 2, g.size)
        val up = g.first { it.graphic == "up-next" }
        assertEquals("up-next:p1", up.id)
        assertEquals(listOf("graphic", "id", "starts", "subtitle", "title"), up.data.keys.sorted())
        assertEquals(71.7, up.start, 0.001); assertEquals(83.7, up.end!!, 0.001)
        assertEquals("Evening Bulletin", g.first { it.graphic == "programme" }.data["next_title"])
    }

    @Test fun onScreenAndRetimed() {
        val store = HashMap<String, StreamGraphic>()
        Triggers.merge(store, listOf(StreamGraphic("p1", "programme", 0.0, 100.0, mapOf("title" to "Morning Show"))))
        Triggers.merge(store, listOf(StreamGraphic("p1", "programme", 0.0, 250.0, mapOf("title" to "Morning Show"))))
        assertEquals(1, store.size); assertEquals(250.0, store["p1"]?.end!!, 0.0)
        Triggers.merge(store, graphics().filter { it.graphic == "up-next" })
        assertEquals(listOf("programme", "up-next"), Triggers.activeAt(store.values.toList(), 75.0).map { it.graphic })
        assertEquals(listOf("programme"), Triggers.activeAt(store.values.toList(), 90.0).map { it.graphic })
        Triggers.merge(store, emptyList(), horizon = 5000.0)
        assertEquals(0, store.size)
    }

    @Test fun card() {
        val up = graphics().first { it.graphic == "up-next" }
        val wall = Triggers.parseISO("2026-10-20T18:28:00.000Z")!!
        val card = Triggers.upNext(up, 72.0, wall)
        assertEquals(120_000.0, card.inMs, 0.0); assertEquals(12_000.0, card.totalMs, 0.0)
        assertEquals("Evening Bulletin", card.title); assertEquals("Live from the harbour", card.subtitle)
        assertEquals(UpNext.Kind.Programme, card.kind); assertFalse(card.autoAdvance)
        assertEquals(3700.0, Triggers.upNext(up, 80.0, null).inMs, 0.0)
        assertEquals(Triggers.parseISO("2026-10-20T18:30:00.000Z"), card.startsAt)
        assertEquals(UpNext.From.Stream, card.source)

        val t = Translator()
        assertEquals(0.0, Triggers.upNext(up, 71.7, wall - 300).progress, 0.001)
        assertEquals(0.5, Triggers.upNext(up, 77.7, wall + 6000).progress, 0.001)
        assertEquals(1.0, Triggers.upNext(up, 83.7, wall + 12000).progress, 0.001)
        assertEquals(0.75, UpNext(UpNext.Kind.Item, "B", inMs = 2500.0, autoAdvance = true, totalMs = 10000.0).progress, 0.0)
        assertEquals("Starts in 2 min", card.kicker(t))
        assertEquals("Coming up in 2 min", card.kicker(t, UpNext.Variant.Banner))
        assertEquals("Coming up in 40 s", card.copy(inMs = 40_000.0).kicker(t, UpNext.Variant.Banner))
        assertEquals("Next in 8 s", UpNext(UpNext.Kind.Item, "B", inMs = 8000.0, autoAdvance = true, totalMs = 10000.0).kicker(t))
    }

    @Test fun skipMarker() {
        val pl = """#EXT-X-DATERANGE:ID="s",CLASS="com.boomlabs.volt.skip",START-DATE="2026-10-20T18:26:55.070Z",END-DATE="2026-10-20T18:27:34.940Z",X-ID="skip-intro:a1",X-GRAPHIC="skip-intro",X-KIND="intro",X-TO="94.942""""
        val g = Triggers.graphics(Triggers.parseDateRanges(pl), ps)
        assertEquals("skip-intro", g.first().graphic); assertEquals("intro", g.first().data["kind"])
        assertEquals(94.94, g.first().end!!, 0.001)
    }
}
