// ============================================================================
//  PARITY WITH THE WEB SDK.
//
//  The same cases, with the same expected answers, as the web SDK's own checks
//  (volt-app/test/player-sdk.check.ts and player-triggers.check.ts). If one of
//  these fails, iOS and the web disagree about a rule, which is a bug on one
//  side or the other, never something to "fix" in the test.
// ============================================================================
import XCTest
@testable import VoltPlayerCore

final class ScheduleParityTests: XCTestCase {
    let H: Double = 3_600_000
    let T: Double = 1_792_238_400_000 // 2026-10-17T12:00:00Z

    var sched: [Programme] {
        Schedule.clean([
            ["id": "b", "title": "Science Hour", "startsAt": T + H, "endsAt": T + 2 * H],
            ["id": "a", "title": "News", "startsAt": T, "endsAt": T + H],
            ["id": "x", "title": "bad", "startsAt": T + 5 * H, "endsAt": T + 4 * H],
            ["id": "a", "title": "dupe", "startsAt": T, "endsAt": T + H],
            ["id": "c", "title": "Film", "startsAt": T + 3 * H, "endsAt": T + 5 * H],
        ] as [Any])
    }

    func testGuide() {
        XCTAssertEqual(sched.map(\.id), ["a", "b", "c"], "sorted, de-duplicated, invalid rows dropped")
        XCTAssertEqual(Schedule.programmeAt(sched, T + 30 * 60_000)?.id, "a")
        XCTAssertNil(Schedule.programmeAt(sched, T + 2.5 * H), "a gap is no programme")
        XCTAssertEqual(Schedule.programmeAfter(sched, T + H - 1)?.id, "b")
    }

    func vod(_ t: Double, hasNext: Bool = true, duration: Double = 600, auto: Bool = true, dismissed: Bool = false) -> UpNext? {
        Schedule.upNext(.init(hasNextItem: hasNext, nextItem: PlaylistItem(id: "n", title: "Episode 2"), currentTime: t, duration: duration,
                              live: false, programme: nil, nextProgramme: nil, playheadClock: nil, seconds: 15, autoAdvance: auto, dismissed: dismissed))
    }

    func testUpNextOnDemand() {
        XCTAssertNil(vod(500))
        let u = vod(590)
        XCTAssertEqual(u?.kind, .item); XCTAssertEqual(u?.title, "Episode 2"); XCTAssertEqual(u?.inMs, 10_000)
        XCTAssertEqual(u?.autoAdvance, true); XCTAssertEqual(u?.totalMs, 15_000)
        XCTAssertNil(vod(590, dismissed: true), "cancelled stays cancelled")
        XCTAssertNil(vod(590, hasNext: false))
        XCTAssertNil(vod(20, duration: 25), "an item shorter than twice the window gets no card")
        XCTAssertEqual(vod(590, auto: false)?.autoAdvance, false)
    }

    func live(_ clock: Double, next: Programme? = nil) -> UpNext? {
        Schedule.upNext(.init(hasNextItem: false, nextItem: nil, currentTime: 0, duration: .nan, live: true, programme: sched[0],
                              nextProgramme: next ?? sched[1], playheadClock: clock, seconds: 60, autoAdvance: true, dismissed: false))
    }

    func testUpNextLive() {
        XCTAssertEqual(live(T + H - 30_000)?.title, "Science Hour")
        XCTAssertEqual(live(T + H - 30_000)?.kind, .programme)
        XCTAssertEqual(live(T + H - 30_000)?.autoAdvance, false)
        XCTAssertNil(live(T + 10 * 60_000))
        XCTAssertNil(live(T + H - 30_000, next: sched[2]), "a programme hours later is not up next")
    }

    func testStartOver() {
        let ps = T - 10 * 60_000
        let a = Schedule.startOverTarget(programmeStart: T, presentationStart: ps, seekable: .init(start: 0, end: 1200))
        XCTAssertEqual(a?.seconds, 600); XCTAssertEqual(a?.clippedMs, 0)
        let c = Schedule.startOverTarget(programmeStart: T, presentationStart: ps, seekable: .init(start: 700, end: 1900))
        XCTAssertEqual(c?.seconds, 701); XCTAssertEqual(c?.clippedMs, 101_000)
        XCTAssertNil(Schedule.startOverTarget(programmeStart: T, presentationStart: nil, seekable: .init(start: 0, end: 100)))
        XCTAssertTrue(Schedule.canStartOver(sched[0], presentationStart: ps, seekable: .init(start: 0, end: 1200), live: true))
        XCTAssertFalse(Schedule.canStartOver(sched[0], presentationStart: ps, seekable: .init(start: 700, end: 1900), live: true))
        XCTAssertFalse(Schedule.canStartOver(sched[0], presentationStart: ps, seekable: .init(start: 0, end: 1200), live: false))
    }

    func testQualities() {
        let q = Schedule.qualityList([
            .init(id: "1", height: 720, width: 1280, bandwidth: 3_000_000), .init(id: "2", height: 720, width: 1280, bandwidth: 2_500_000),
            .init(id: "3", height: 1080, width: 1920, bandwidth: 6_000_000), .init(id: "4", height: 360, width: 640, bandwidth: 800_000),
            .init(id: "5", height: 2160, width: 3840, bandwidth: 15_000_000)])
        XCTAssertEqual(q.map(\.label), ["4K", "1080p", "720p", "360p"])
        XCTAssertEqual(q.first { $0.label == "720p" }?.id, "1")
        let aq = Schedule.qualityList([.init(id: "7", height: nil, width: nil, bandwidth: 128_000), .init(id: "8", height: nil, width: nil, bandwidth: 64_000)])
        XCTAssertEqual(aq.map(\.label), ["128 kbps", "64 kbps"])
    }

    func testPlaylists() {
        let pl = Schedule.normalize([.string("c6ffb359-4ce7-4e79-9817-778f69d418ba"), .string("https://cdn.example.com/show/ep1/master.m3u8"),
                                     .string(""), .item(PlaylistItem(id: "x", title: "X")),
                                     .item(PlaylistItem(id: "y", source: Source(mp3: "https://r.example.com/live.mp3")))])
        XCTAssertEqual(pl.count, 4)
        XCTAssertEqual(Schedule.normalize([.item(PlaylistItem(id: "z"))]).count, 0)
        XCTAssertEqual(pl[0].assetId, "c6ffb359-4ce7-4e79-9817-778f69d418ba")
        XCTAssertNotNil(pl[1].source?.url); XCTAssertEqual(pl[1].title, "ep1")
        XCTAssertEqual(Schedule.sourceKind("https://x/a.m3u8?t=1"), .hls)
        XCTAssertEqual(Schedule.sourceKind("https://x/a.mpd"), .dash)
        XCTAssertEqual(Schedule.sourceKind("https://x/a.mp3"), .mp3)
        XCTAssertEqual(Schedule.sourceKind("https://x/a.mp4"), .mp4)
        XCTAssertEqual(Schedule.fmtTime(65), "1:05"); XCTAssertEqual(Schedule.fmtTime(3725), "1:02:05"); XCTAssertEqual(Schedule.fmtTime(.nan), "0:00")
    }
}

final class ThemeParityTests: XCTestCase {
    func testInk() {
        XCTAssertEqual(ThemeTokens.inkFor("#ffffff"), "#0b0e13")
        XCTAssertEqual(ThemeTokens.inkFor("#000000"), "#ffffff")
        XCTAssertEqual(ThemeTokens.inkFor("#e11d48"), "#ffffff")
    }

    func testResolve() {
        let th = ThemeTokens.resolve(Theme(primary: "#e11d48", secondary: "#f5f5f4", text: "#f6f6f6", radius: 99, upNextSeconds: 2, controls: ["cast": false]))
        XCTAssertEqual(th.text, "#0b0e13", "light text on a light background is replaced")
        XCTAssertGreaterThanOrEqual(ThemeTokens.contrast(th.text, th.background), 4.5)
        XCTAssertEqual(th.radius, 28); XCTAssertEqual(th.upNextSeconds, 5)
        XCTAssertFalse(th.controls.cast); XCTAssertTrue(th.controls.quality)
        XCTAssertEqual(ThemeTokens.resolve(Theme(primary: "red")).primary, "#3f7bff")
        XCTAssertNil(ThemeTokens.resolve(Theme(logoUrl: "javascript:alert(1)")).logoUrl)
        XCTAssertNil(ThemeTokens.resolve(Theme(logoUrl: "//evil.example/x.png")).logoUrl)
        XCTAssertEqual(ThemeTokens.resolve(Theme(logoUrl: "https://cdn.example.com/l.png")).logoUrl, "https://cdn.example.com/l.png")
        XCTAssertNil(ThemeTokens.resolve(Theme(logoUrl: "https://a/b.png"), Theme(json: ["logoUrl": NSNull()])).logoUrl, "a later layer can clear the logo")
    }

    func testFromConfig() {
        let cfg: [String: Any] = ["primaryColor": "#112233", "secondaryColor": "#ffffff",
                                  "options": ["theme": ["radius": 4, "controls": ["schedule": false]]]]
        let t = ThemeTokens.resolve(ThemeTokens.fromConfig(cfg))
        XCTAssertEqual(t.primary, "#112233"); XCTAssertEqual(t.radius, 4); XCTAssertFalse(t.controls.schedule)
    }

    func testGraphicsSwitch() {
        XCTAssertTrue(ThemeTokens.resolve().showGraphics)
        XCTAssertFalse(ThemeTokens.resolve(Theme(showGraphics: false)).showGraphics)
    }
}

final class EventParityTests: XCTestCase {
    func testCountdown() {
        let ms: Double = 2 * 86_400_000.0 + 3 * 3_600_000.0 + 240_000.0 + 5_500.0
        XCTAssertEqual(EventRules.countdown(ms), EventRules.Countdown(days: 2, hours: 3, minutes: 4, seconds: 5))
        XCTAssertEqual(EventRules.countdown(-5), EventRules.Countdown(days: 0, hours: 0, minutes: 0, seconds: 0))
    }

    func testIcs() {
        let start = 1_792_315_800_000.0 // 2026-10-18T09:30:00Z
        let ics = EventRules.ics(id: "e1", title: "Final; Lions, Tigers", startsAt: start, endsAt: nil, description: nil,
                                 url: "https://x.example/watch", now: start)
        XCTAssertTrue(ics.contains("DTSTART:20261018T093000Z")); XCTAssertTrue(ics.contains("DTEND:20261018T113000Z"))
        XCTAssertTrue(ics.contains("SUMMARY:Final\\; Lions\\, Tigers"))
        XCTAssertEqual(ics.components(separatedBy: "\r\n").first, "BEGIN:VCALENDAR")
    }

    func testPrices() {
        XCTAssertEqual(Gate.fmtTerm(Product(productKey: "a", kind: .period, count: 1, unit: .day, priceCents: 0, currency: "AUD")), "24 hours")
        XCTAssertEqual(Gate.fmtTerm(Product(productKey: "b", kind: .period, count: 3, unit: .month, priceCents: 0, currency: "AUD")), "3 months")
        XCTAssertEqual(Gate.fmtTerm(Product(productKey: "c", kind: .published_dates, priceCents: 0, currency: "AUD")), "This event")
        let p = Gate.fmtPrice(cents: 1499, currency: "AUD", locale: Locale(identifier: "en_AU"))
        XCTAssertTrue(p.contains("14.99") || p.contains("14,99"), p)
        XCTAssertEqual(Gate.fillUrl("https://shop.example/buy?p={productKey}&a={assetId}&x={nope}", ["productKey": "final pass", "assetId": "e1"]),
                       "https://shop.example/buy?p=final%20pass&a=e1&x=")
    }

    func testPolling() {
        XCTAssertEqual(EventRules.pollDelay(presentation: .pre, msToStart: 3_600_000), 30)
        XCTAssertEqual(EventRules.pollDelay(presentation: .pre, msToStart: 90_000), 5, "last two minutes")
        XCTAssertEqual(EventRules.pollDelay(presentation: .offline, msToStart: nil), 5, "a late start")
    }
}

final class TriggerParityTests: XCTestCase {
    // The up-next trigger from player-triggers.check.ts, as a playlist carries it. Media time 0 is
    // presentationStart; the trigger starts at 71.7 s and lasts 12 s.
    let ps = Triggers.parseISO("2026-10-20T18:26:00.000Z")!
    var playlist: String {
        """
        #EXTM3U
        #EXT-X-PROGRAM-DATE-TIME:2026-10-20T18:26:00.000Z
        #EXT-X-DATERANGE:ID="up-next:p1",CLASS="com.boomlabs.volt.graphic",START-DATE="2026-10-20T18:27:11.700Z",DURATION=12,X-ID="up-next:p1",X-GRAPHIC="up-next",X-TITLE="Evening Bulletin",X-STARTS="2026-10-20T18:30:00.000Z",X-SUBTITLE="Live from the harbour"
        #EXT-X-DATERANGE:ID="p1",CLASS="com.boomlabs.volt.programme",START-DATE="2026-10-20T18:26:00.000Z",END-DATE="2026-10-20T18:30:10.000Z",X-ID="p1",X-TITLE="Morning Show",X-GENRE="News",X-NEXT-TITLE="Evening Bulletin"
        #EXT-X-DATERANGE:ID="ad",CLASS="com.example.ads",START-DATE="2026-10-20T18:26:05.000Z",DURATION=30,X-AD="1"
        #EXTINF:6.0,
        seg1.ts
        """
    }

    func graphics() -> [StreamGraphic] { Triggers.graphics(from: Triggers.parseDateRanges(playlist), presentationStart: ps) }

    func testParse() {
        let g = graphics()
        XCTAssertEqual(g.count, 2, "someone else's classes are ignored")
        let up = g.first { $0.graphic == "up-next" }!
        XCTAssertEqual(up.id, "up-next:p1")
        XCTAssertEqual(up.data.keys.sorted(), ["graphic", "id", "starts", "subtitle", "title"])
        XCTAssertEqual(up.start, 71.7, accuracy: 0.001); XCTAssertEqual(up.end!, 83.7, accuracy: 0.001)
        XCTAssertEqual(g.first { $0.graphic == "programme" }?.data["next_title"], "Evening Bulletin")
    }

    func testOnScreenAndRetimed() {
        var store: [String: StreamGraphic] = [:]
        Triggers.merge(&store, [StreamGraphic(id: "p1", graphic: "programme", start: 0, end: 100, data: ["title": "Morning Show"])])
        Triggers.merge(&store, [StreamGraphic(id: "p1", graphic: "programme", start: 0, end: 250, data: ["title": "Morning Show"])])
        XCTAssertEqual(store.count, 1); XCTAssertEqual(store["p1"]?.end, 250)
        Triggers.merge(&store, graphics().filter { $0.graphic == "up-next" })
        XCTAssertEqual(Triggers.activeAt(Array(store.values), 75).map(\.graphic), ["programme", "up-next"])
        XCTAssertEqual(Triggers.activeAt(Array(store.values), 90).map(\.graphic), ["programme"])
        Triggers.merge(&store, [], horizon: 5000)
        XCTAssertEqual(store.count, 0)
    }

    func testCard() {
        let up = graphics().first { $0.graphic == "up-next" }!
        let wall = Triggers.parseISO("2026-10-20T18:28:00.000Z")!
        let card = Triggers.upNext(from: up, at: 72, wallClock: wall)
        XCTAssertEqual(card.inMs, 120_000); XCTAssertEqual(card.totalMs, 12_000)
        XCTAssertEqual(card.title, "Evening Bulletin"); XCTAssertEqual(card.subtitle, "Live from the harbour")
        XCTAssertEqual(card.kind, .programme); XCTAssertFalse(card.autoAdvance)
        XCTAssertEqual(Triggers.upNext(from: up, at: 80, wallClock: nil).inMs, 3700)
        XCTAssertEqual(card.startsAt, Triggers.parseISO("2026-10-20T18:30:00.000Z"))
        XCTAssertEqual(card.source, .stream)

        let t = Translator()
        XCTAssertEqual(Triggers.upNext(from: up, at: 71.7, wallClock: wall - 300).progress, 0, accuracy: 0.001)
        XCTAssertEqual(Triggers.upNext(from: up, at: 77.7, wallClock: wall + 6000).progress, 0.5, accuracy: 0.001)
        XCTAssertEqual(Triggers.upNext(from: up, at: 83.7, wallClock: wall + 12000).progress, 1, accuracy: 0.001)
        XCTAssertEqual(UpNext(kind: .item, title: "B", inMs: 2500, autoAdvance: true, totalMs: 10000).progress, 0.75)
        XCTAssertEqual(card.kicker(t), "Starts in 2 min")
        XCTAssertEqual(card.kicker(t, .banner), "Coming up in 2 min")
        var c40 = card; c40.inMs = 40_000
        XCTAssertEqual(c40.kicker(t, .banner), "Coming up in 40 s")
        XCTAssertEqual(UpNext(kind: .item, title: "B", inMs: 8000, autoAdvance: true, totalMs: 10000).kicker(t), "Next in 8 s")
    }

    func testSkipMarker() {
        let pl = """
        #EXT-X-DATERANGE:ID="s",CLASS="com.boomlabs.volt.skip",START-DATE="2026-10-20T18:26:55.070Z",END-DATE="2026-10-20T18:27:34.940Z",X-ID="skip-intro:a1",X-GRAPHIC="skip-intro",X-KIND="intro",X-TO="94.942"
        """
        let g = Triggers.graphics(from: Triggers.parseDateRanges(pl), presentationStart: ps)
        XCTAssertEqual(g.first?.graphic, "skip-intro"); XCTAssertEqual(g.first?.data["kind"], "intro")
        XCTAssertEqual(g.first!.end!, 94.94, accuracy: 0.001)
    }
}
