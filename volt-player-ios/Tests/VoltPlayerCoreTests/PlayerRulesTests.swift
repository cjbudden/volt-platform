// The rules that are new in the iOS port (derive as a pure function, beacons with an
// injected clock, the API client against a fake transport).
import XCTest
@testable import VoltPlayerCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class DeriveTests: XCTestCase {
    let ps: Double = 1_792_500_000_000

    func input(t: Double, live: Bool = true, graphics: [StreamGraphic] = [], schedule: [Programme] = [], graphicsOn: Bool = true,
               items: [PlaylistItem] = [], duration: Double = .nan, dismissed: String? = nil) -> DeriveInput {
        DeriveInput(engine: EngineSnapshot(currentTime: t, duration: duration, live: live,
                                           seekable: live ? SeekWindow(start: 0, end: 600) : nil, presentationStart: ps),
                    now: ps + 600_000, schedule: schedule, graphics: graphics, graphicsOn: graphicsOn, upNextOn: true, skipOn: true,
                    upNextSeconds: 15, autoAdvance: true, items: items, index: 0, dismissed: dismissed)
    }

    let prog = StreamGraphic(id: "p1", graphic: "programme", start: 0, end: 300, data: ["id": "p1", "title": "Morning Show", "genre": "News", "next_title": "Midday"])
    let prog2 = StreamGraphic(id: "p2", graphic: "programme", start: 300, end: 900, data: ["id": "p2", "title": "Midday"])
    let up = StreamGraphic(id: "u1", graphic: "up-next", start: 280, end: 292, data: ["title": "Midday"])
    let brk = StreamGraphic(id: "b1", graphic: "ad-break", start: 100, end: 160, data: ["break": "brk-1"])

    func testProgrammeFromStream() {
        let d = Derive.run(input(t: 50, graphics: [prog]))
        XCTAssertEqual(d.programme?.title, "Morning Show")
        XCTAssertEqual(d.programme?.meta, ["genre": "News"], "key metadata from the marker, own fields and next_* left out")
        XCTAssertEqual(d.programme?.startsAt, ps)
        XCTAssertEqual(d.nextProgramme?.title, "Midday", "named by the marker before the next one is announced")
        XCTAssertEqual(d.wallClock, ps + 50_000)
        XCTAssertEqual(d.behindLive, 550)
        XCTAssertFalse(d.atLiveEdge)
        XCTAssertTrue(d.dvr)
        let d2 = Derive.run(input(t: 50, graphics: [prog, prog2]))
        XCTAssertEqual(d2.nextProgramme?.id, "p2", "the announced marker wins")
    }

    func testGuideWins() {
        let g = [Programme(id: "g1", title: "Guide show", startsAt: ps, endsAt: ps + 3_600_000)]
        XCTAssertEqual(Derive.run(input(t: 50, graphics: [prog], schedule: g)).programme?.title, "Guide show")
    }

    func testStreamUpNextAndDismiss() {
        let d = Derive.run(input(t: 285, graphics: [prog, up]))
        XCTAssertEqual(d.upNext?.source, .stream); XCTAssertEqual(d.dismissKey, "g:u1")
        XCTAssertNil(Derive.run(input(t: 285, graphics: [prog, up], dismissed: "g:u1")).upNext)
    }

    func testAdBreakHidesEverything() {
        let d = Derive.run(input(t: 120, graphics: [prog, brk, StreamGraphic(id: "u0", graphic: "up-next", start: 110, end: 130, data: [:])]))
        XCTAssertEqual(d.adBreak?.id, "brk-1")
        XCTAssertEqual(d.graphics.map(\.id), ["b1"], "only the break itself")
        XCTAssertNil(d.upNext)
        XCTAssertEqual(d.programme?.title, "Morning Show", "now / next is data, still known during a break")
    }

    func testGraphicsOffStillReportsBreak() {
        let d = Derive.run(input(t: 120, graphics: [prog, brk], graphicsOn: false))
        XCTAssertTrue(d.graphics.isEmpty)
        XCTAssertNotNil(d.adBreak)
    }

    func testSkipOnDemandOnly() {
        let sk = StreamGraphic(id: "s1", graphic: "skip-intro", start: 10, end: 40, data: ["kind": "intro"])
        XCTAssertEqual(Derive.run(input(t: 20, live: false, graphics: [sk], duration: 1200)).skip?.kind, "intro")
        XCTAssertNil(Derive.run(input(t: 39.6, live: false, graphics: [sk], duration: 1200)).skip, "gone in the last half second")
        XCTAssertNil(Derive.run(input(t: 20, live: true, graphics: [sk])).skip, "never live")
    }

    func testPlaylistUpNext() {
        let items = [PlaylistItem(id: "a"), PlaylistItem(id: "b", title: "Episode 2")]
        let d = Derive.run(input(t: 590, live: false, items: items, duration: 600))
        XCTAssertEqual(d.upNext?.title, "Episode 2"); XCTAssertEqual(d.dismissKey, "i:0")
    }
}

final class BeaconTests: XCTestCase {
    func testSession() {
        var sent: [[String: Any]] = []
        let b = BeaconSession(token: "tok", id: "ios-1", now: 0) { sent.append($0) }
        b.time(0, paused: true)
        b.playing(now: 1.25, kbps: 3000)
        XCTAssertEqual(sent.last?["event"] as? String, "start")
        XCTAssertEqual(sent.last?["ttffMs"] as? Int, 1250)
        var t = 0.0
        for _ in 0..<40 { t += 0.5; b.time(t, paused: false) }   // 20 s watched
        b.seeking(); b.time(500, paused: false)                    // a seek is not watching
        b.time(500.5, paused: true)                                // nor is a pause
        b.tick(now: 10, kbps: 3000)
        XCTAssertEqual(sent.count, 1, "no heartbeat before 30 s")
        b.tick(now: 31.3, kbps: 2500)
        XCTAssertEqual(sent.last?["event"] as? String, "heartbeat")
        XCTAssertEqual(sent.last?["seconds"] as? Int, 20)
        XCTAssertEqual(sent.last?["bitrateKbps"] as? Int, 2500)
        b.end(); b.end()
        XCTAssertEqual(sent.filter { $0["event"] as? String == "end" }.count, 1, "ends once")
        b.resume(now: 40, kbps: nil)
        XCTAssertNotEqual(b.sessionId, "ios-1", "back from the background: a new session")
        XCTAssertNil(sent.last?["bitrateKbps"], "an unknown bitrate is left out")
    }
}

final class FakeTransport: HTTPTransport, @unchecked Sendable {
    var requests: [URLRequest] = []
    let reply: (URLRequest) -> (Int, Any)
    init(_ reply: @escaping (URLRequest) -> (Int, Any)) { self.reply = reply }
    func send(_ request: URLRequest) async throws -> (Data, Int) {
        requests.append(request)
        let (s, j) = reply(request)
        return (try JSONSerialization.data(withJSONObject: j), s)
    }
}

final class APITests: XCTestCase {
    func testResolve() async throws {
        let f = FakeTransport { _ in (200, ["available": true, "playbackToken": "pt",
                                            "delivery": ["hls": "https://cdn/x/master.m3u8"],
                                            "meta": ["title": "News 24", "live": true, "kind": "channel",
                                                     "brandMark": ["url": "https://cdn/logo.png", "position": "tr", "offsetX": 40, "offsetY": 40, "opacity": 80, "scale": 7]],
                                            "ads": ["delivery": "guided", "sessionId": "s1"]]) }
        let api = VoltAPI(base: URL(string: "https://volt.example")!, appKey: "pk_test_123", transport: f, bundleId: "com.example.app")
        let r = try await api.resolve(assetId: "c6ffb359-4ce7-4e79-9817-778f69d418ba", viewerToken: "vt", sid: "sid-1")
        XCTAssertEqual(r.source?.hls, "https://cdn/x/master.m3u8"); XCTAssertEqual(r.token, "pt"); XCTAssertEqual(r.live, true)
        XCTAssertEqual(r.brandMark?.opacity, 80); XCTAssertEqual(r.ads?.delivery, .guided)
        let req = f.requests[0]
        XCTAssertEqual(req.url?.path, "/api/availability"); XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "authorization"), "Bearer vt")
        XCTAssertEqual(req.value(forHTTPHeaderField: "x-volt-bundle-id"), "com.example.app")
        let body = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
        XCTAssertEqual(body["appKey"] as? String, "pk_test_123"); XCTAssertEqual(body["sid"] as? String, "sid-1")
        XCTAssertEqual(body["caps"] as? [String], ["hls-interstitials"], "Apple players play HLS Interstitials natively")
    }

    func testPaywall() async {
        let f = FakeTransport { _ in (402, ["available": false, "mode": "paywall",
                                            "products": [["productKey": "day", "kind": "period", "count": 1, "unit": "day", "priceCents": 499, "currency": "AUD"]]]) }
        let api = VoltAPI(base: URL(string: "https://volt.example")!, appKey: "pk", transport: f)
        do { _ = try await api.resolve(assetId: "x"); XCTFail("should throw") }
        catch let e as GateError {
            XCTAssertEqual(e.mode, "paywall"); XCTAssertEqual(e.products.first?.priceCents, 499)
            XCTAssertEqual(e.message, "This needs a subscription or purchase.")
        } catch { XCTFail("\(error)") }
    }

    func testEventAndGuideAndNowPlaying() async {
        let f = FakeTransport { r in
            switch r.url!.path {
            case "/api/player/event": return (200, ["id": "e1", "title": "Final", "startsAt": 1000, "endsAt": 2000, "presentation": "pre",
                                                    "promo": ["template": "versus", "sides": [["name": "Lions"], ["name": "Tigers"]]]])
            case "/api/player/epg": return (200, ["programmes": [["id": "a", "title": "News", "startsAt": 0, "endsAt": 10]]])
            default: return (200, ["title": "Song", "artist": "Band", "history": [["title": "Old"]], "next": ["primary": "Next one"], "onAir": true])
            }
        }
        let api = VoltAPI(base: URL(string: "https://volt.example")!, appKey: "pk", transport: f)
        let e = await api.event(id: "e1")
        XCTAssertEqual(e?.presentation, .pre); XCTAssertEqual(e?.promo?.sides?.map(\.name), ["Lions", "Tigers"])
        XCTAssertEqual(f.requests[0].url?.query?.contains("eventId=e1"), true)
        let g = await api.schedule(channelId: "c1")
        XCTAssertEqual(g.first?.title, "News")
        let np = await api.nowPlaying(stationId: "s1")
        XCTAssertEqual(np?.nowPlaying?.artist, "Band"); XCTAssertEqual(np?.history.first?.title, "Old"); XCTAssertEqual(np?.next?.title, "Next one")
    }

    func testMerge() {
        let item = PlaylistItem(id: "a", title: "Mine", assetId: "a")
        let r = ResolvedItem(source: Source(hls: "h"), token: "t", title: "Theirs", artworkUrl: "art", live: true)
        let m = mergeResolved(item, r)
        XCTAssertEqual(m.title, "Mine", "the caller's title wins"); XCTAssertEqual(m.source?.hls, "h"); XCTAssertEqual(m.artworkUrl, "art")
        XCTAssertEqual(m.playbackToken, "t")
    }
}
