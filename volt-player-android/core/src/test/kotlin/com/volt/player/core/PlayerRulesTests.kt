// The rules that are new in the native ports (derive as a pure function, beacons with an
// injected clock, the API client against a fake transport), the same cases as the Swift
// PlayerRulesTests, plus the TV theme tokens.
package com.volt.player.core

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DeriveTests {
    private val ps = 1_792_500_000_000.0

    private fun input(t: Double, live: Boolean = true, graphics: List<StreamGraphic> = emptyList(), schedule: List<Programme> = emptyList(),
                      graphicsOn: Boolean = true, items: List<PlaylistItem> = emptyList(), duration: Double = Double.NaN, dismissed: String? = null) =
        DeriveInput(EngineSnapshot(t, duration, live, if (live) SeekWindow(0.0, 600.0) else null, ps),
            now = ps + 600_000, schedule = schedule, graphics = graphics, graphicsOn = graphicsOn, upNextOn = true, skipOn = true,
            upNextSeconds = 15.0, autoAdvance = true, items = items, index = 0, dismissed = dismissed)

    private val prog = StreamGraphic("p1", "programme", 0.0, 300.0, mapOf("id" to "p1", "title" to "Morning Show", "genre" to "News", "next_title" to "Midday"))
    private val prog2 = StreamGraphic("p2", "programme", 300.0, 900.0, mapOf("id" to "p2", "title" to "Midday"))
    private val up = StreamGraphic("u1", "up-next", 280.0, 292.0, mapOf("title" to "Midday"))
    private val brk = StreamGraphic("b1", "ad-break", 100.0, 160.0, mapOf("break" to "brk-1"))

    @Test fun programmeFromStream() {
        val d = Derive.run(input(50.0, graphics = listOf(prog)))
        assertEquals("Morning Show", d.programme?.title)
        assertEquals("key metadata from the marker, own fields and next_* left out", mapOf("genre" to "News"), d.programme?.meta)
        assertEquals(ps, d.programme!!.startsAt, 0.0)
        assertEquals("named by the marker before the next one is announced", "Midday", d.nextProgramme?.title)
        assertEquals(ps + 50_000, d.wallClock!!, 0.0)
        assertEquals(550.0, d.behindLive, 0.0)
        assertFalse(d.atLiveEdge)
        assertTrue(d.dvr)
        val d2 = Derive.run(input(50.0, graphics = listOf(prog, prog2)))
        assertEquals("the announced marker wins", "p2", d2.nextProgramme?.id)
    }

    @Test fun guideWins() {
        val g = listOf(Programme(id = "g1", title = "Guide show", startsAt = ps, endsAt = ps + 3_600_000))
        assertEquals("Guide show", Derive.run(input(50.0, graphics = listOf(prog), schedule = g)).programme?.title)
    }

    @Test fun streamUpNextAndDismiss() {
        val d = Derive.run(input(285.0, graphics = listOf(prog, up)))
        assertEquals(UpNext.From.Stream, d.upNext?.source); assertEquals("g:u1", d.dismissKey)
        assertNull(Derive.run(input(285.0, graphics = listOf(prog, up), dismissed = "g:u1")).upNext)
    }

    @Test fun adBreakHidesEverything() {
        val d = Derive.run(input(120.0, graphics = listOf(prog, brk, StreamGraphic("u0", "up-next", 110.0, 130.0, emptyMap()))))
        assertEquals("brk-1", d.adBreak?.id)
        assertEquals("only the break itself", listOf("b1"), d.graphics.map { it.id })
        assertNull(d.upNext)
        assertEquals("now / next is data, still known during a break", "Morning Show", d.programme?.title)
    }

    @Test fun graphicsOffStillReportsBreak() {
        val d = Derive.run(input(120.0, graphics = listOf(prog, brk), graphicsOn = false))
        assertTrue(d.graphics.isEmpty())
        assertNotNull(d.adBreak)
    }

    @Test fun skipOnDemandOnly() {
        val sk = StreamGraphic("s1", "skip-intro", 10.0, 40.0, mapOf("kind" to "intro"))
        assertEquals("intro", Derive.run(input(20.0, live = false, graphics = listOf(sk), duration = 1200.0)).skip?.kind)
        assertNull("gone in the last half second", Derive.run(input(39.6, live = false, graphics = listOf(sk), duration = 1200.0)).skip)
        assertNull("never live", Derive.run(input(20.0, live = true, graphics = listOf(sk))).skip)
    }

    @Test fun playlistUpNext() {
        val items = listOf(PlaylistItem(id = "a"), PlaylistItem(id = "b", title = "Episode 2"))
        val d = Derive.run(input(590.0, live = false, items = items, duration = 600.0))
        assertEquals("Episode 2", d.upNext?.title); assertEquals("i:0", d.dismissKey)
    }
}

class BeaconTests {
    @Test fun session() {
        val sent = mutableListOf<Map<String, Any>>()
        val b = BeaconSession(token = "tok", id = "android-1", now = 0.0) { sent += it }
        b.time(0.0, paused = true)
        b.playing(now = 1.25, kbps = 3000)
        assertEquals("start", sent.last()["event"])
        assertEquals(1250, sent.last()["ttffMs"])
        var t = 0.0
        repeat(40) { t += 0.5; b.time(t, paused = false) }   // 20 s watched
        b.seeking(); b.time(500.0, paused = false)             // a seek is not watching
        b.time(500.5, paused = true)                           // nor is a pause
        b.tick(now = 10.0, kbps = 3000)
        assertEquals("no heartbeat before 30 s", 1, sent.size)
        b.tick(now = 31.3, kbps = 2500)
        assertEquals("heartbeat", sent.last()["event"])
        assertEquals(20, sent.last()["seconds"])
        assertEquals(2500, sent.last()["bitrateKbps"])
        b.end(); b.end()
        assertEquals("ends once", 1, sent.count { it["event"] == "end" })
        b.resume(now = 40.0, kbps = null)
        assertNotEquals("back from the background: a new session", "android-1", b.sessionId)
        assertNull("an unknown bitrate is left out", sent.last()["bitrateKbps"])
    }
}

class FakeTransport(private val reply: (HttpRequest) -> Pair<Int, String>) : HttpTransport {
    val requests = mutableListOf<HttpRequest>()
    override suspend fun send(request: HttpRequest): Pair<String, Int> {
        requests += request
        val (s, j) = reply(request)
        return j to s
    }
}

class ApiTests {
    private fun path(r: HttpRequest) = java.net.URI(r.url).path

    @Test fun resolve() = runTest {
        val f = FakeTransport {
            200 to """{"available":true,"playbackToken":"pt","delivery":{"hls":"https://cdn/x/master.m3u8"},
                "meta":{"title":"News 24","live":true,"kind":"channel","brandMark":{"url":"https://cdn/logo.png","position":"tr","offsetX":40,"offsetY":40,"opacity":80,"scale":7}},
                "ads":{"delivery":"guided","sessionId":"s1"}}"""
        }
        val api = VoltApi("https://volt.example", "pk_test_123", f, packageName = "com.example.app")
        val r = api.resolve("c6ffb359-4ce7-4e79-9817-778f69d418ba", viewerToken = "vt", sid = "sid-1")
        assertEquals("https://cdn/x/master.m3u8", r.source?.hls); assertEquals("pt", r.token); assertEquals(true, r.live)
        assertEquals(80.0, r.brandMark!!.opacity, 0.0); assertEquals(ItemAds.Delivery.Guided, r.ads?.delivery)
        val req = f.requests[0]
        assertEquals("/api/availability", path(req)); assertEquals("POST", req.method)
        assertEquals("Bearer vt", req.headers["authorization"])
        assertEquals("com.example.app", req.headers["x-volt-bundle-id"])
        assertEquals("android", req.headers["x-volt-platform"])
        val body = Json.parseToJsonElement(req.body!!).jsonObject
        assertEquals("pk_test_123", body["appKey"]!!.jsonPrimitive.content); assertEquals("sid-1", body["sid"]!!.jsonPrimitive.content)
        assertEquals("no guided-ads capability claimed by default", 0, body["caps"]!!.jsonArray.size)
    }

    @Test fun paywall() = runTest {
        val f = FakeTransport { 402 to """{"available":false,"mode":"paywall","products":[{"productKey":"day","kind":"period","count":1,"unit":"day","priceCents":499,"currency":"AUD"}]}""" }
        val api = VoltApi("https://volt.example", "pk", f)
        try { api.resolve("x"); fail("should throw") }
        catch (e: GateError) {
            assertEquals("paywall", e.mode); assertEquals(499, e.products.first().priceCents)
            assertEquals("This needs a subscription or purchase.", e.message)
        }
    }

    @Test fun eventAndGuideAndNowPlaying() = runTest {
        val f = FakeTransport { r ->
            when (path(r)) {
                "/api/player/event" -> 200 to """{"id":"e1","title":"Final","startsAt":1000,"endsAt":2000,"presentation":"pre","promo":{"template":"versus","sides":[{"name":"Lions"},{"name":"Tigers"}]}}"""
                "/api/player/epg" -> 200 to """{"programmes":[{"id":"a","title":"News","startsAt":0,"endsAt":10}]}"""
                else -> 200 to """{"title":"Song","artist":"Band","history":[{"title":"Old"}],"next":{"primary":"Next one"},"onAir":true}"""
            }
        }
        val api = VoltApi("https://volt.example", "pk", f)
        val e = api.event("e1")
        assertEquals(Presentation.Pre, e?.presentation); assertEquals(listOf("Lions", "Tigers"), e?.promo?.sides?.map { it.name })
        assertTrue(java.net.URI(f.requests[0].url).query.contains("eventId=e1"))
        val g = api.schedule("c1")
        assertEquals("News", g.first().title)
        val np = api.nowPlaying("s1")
        assertEquals("Band", np?.nowPlaying?.artist); assertEquals("Old", np?.history?.first()?.title); assertEquals("Next one", np?.next?.title)
    }

    @Test fun merge() {
        val item = PlaylistItem(id = "a", title = "Mine", assetId = "a")
        val r = ResolvedItem(source = Source(hls = "h"), token = "t", title = "Theirs", artworkUrl = "art", live = true)
        val m = mergeResolved(item, r)
        assertEquals("the caller's title wins", "Mine", m.title); assertEquals("h", m.source?.hls); assertEquals("art", m.artworkUrl)
        assertEquals("t", m.playbackToken)
    }
}

/** The two TV tokens (PLAYER_FEATURES.md, proposed), the same rule on every SDK. */
class TvThemeTests {
    @Test fun focusColor() {
        assertEquals("#3f7bff", ThemeTokens.resolve().focusColor)
        assertTrue(ThemeTokens.contrast("#3f7bff", "#f5f5f4") >= 3)
        assertEquals("a white ring on a light background falls back to primary", "#3f7bff",
            ThemeTokens.resolve(Theme(secondary = "#f5f5f4", focusColor = "#ffffff")).focusColor)
        assertEquals("#ffd400", ThemeTokens.resolve(Theme(focusColor = "#ffd400")).focusColor)
        assertEquals("primary too faint on the background: black or white", "#0b0e13",
            ThemeTokens.resolve(Theme(primary = "#fafafa", secondary = "#ffffff")).focusColor)
    }

    @Test fun seekStep() {
        assertEquals(10.0, ThemeTokens.resolve().seekStep, 0.0)
        assertEquals(15.0, ThemeTokens.resolve(Theme(seekStep = 14.0)).seekStep, 0.0)
        assertEquals("ties go to the smaller", 10.0, ThemeTokens.resolve(Theme(seekStep = 12.5)).seekStep, 0.0)
        assertEquals(30.0, ThemeTokens.resolve(Theme(seekStep = 100.0)).seekStep, 0.0)
        assertEquals(30.0, ThemeTokens.resolve(Theme.fromJson(JsonObject(mapOf("seekStep" to JsonPrimitive(30))))).seekStep, 0.0)
    }
}
