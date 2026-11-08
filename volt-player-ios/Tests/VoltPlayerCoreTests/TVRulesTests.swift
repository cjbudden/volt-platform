// The tv skin's rules, and the two theme tokens it reads (focusColor, seekStep).
// The theme cases are the same as the Android SDK's, so both TV skins resolve alike.
import XCTest
@testable import VoltPlayerCore

final class TVThemeTokenTests: XCTestCase {
    func testDefaults() {
        let t = ThemeTokens.resolve()
        XCTAssertEqual(t.focusColor, "#3f7bff", "the default primary reads on the default background")
        XCTAssertEqual(t.seekStep, 10)
    }

    func testFocusColorFallsBackToPrimaryThenInk() {
        XCTAssertGreaterThanOrEqual(ThemeTokens.contrast("#3f7bff", "#f5f5f4"), 3)
        XCTAssertEqual(ThemeTokens.resolve(Theme(secondary: "#f5f5f4", focusColor: "#ffffff")).focusColor, "#3f7bff",
                       "white on near white is refused, primary still reads")
        XCTAssertEqual(ThemeTokens.resolve(Theme(primary: "#111111", secondary: "#000000", focusColor: "#222222")).focusColor, "#ffffff",
                       "neither reads on black: white")
        XCTAssertEqual(ThemeTokens.resolve(Theme(focusColor: "#ffd60a")).focusColor, "#ffd60a")
        XCTAssertEqual(ThemeTokens.resolve(Theme(focusColor: "yellow")).focusColor, "#3f7bff", "not a hex colour")
    }

    func testSeekStepSnaps() {
        XCTAssertEqual(ThemeTokens.resolve(Theme(seekStep: 14)).seekStep, 15)
        XCTAssertEqual(ThemeTokens.resolve(Theme(seekStep: 12.5)).seekStep, 10, "a tie goes to the smaller")
        XCTAssertEqual(ThemeTokens.resolve(Theme(seekStep: 100)).seekStep, 30)
        XCTAssertEqual(ThemeTokens.resolve(Theme(seekStep: .nan)).seekStep, 10)
        XCTAssertEqual(ThemeTokens.resolve(Theme(seekStep: 30), Theme(seekStep: 15)).seekStep, 15, "later layers win")
    }

    func testFromJson() {
        let t = ThemeTokens.resolve(Theme(json: ["focusColor": "#ffd60a", "seekStep": 30]))
        XCTAssertEqual(t.focusColor, "#ffd60a")
        XCTAssertEqual(t.seekStep, 30)
    }
}

final class TVRulesTests: XCTestCase {
    let now: Double = 1_792_500_000_000

    /// A live channel with a one hour window, the playhead 60 s behind live.
    func live() -> PlayerState {
        var s = PlayerState()
        s.live = true; s.dvr = true
        s.seekable = SeekWindow(start: 0, end: 3600)
        s.currentTime = 3540
        s.wallClock = now - 60_000
        return s
    }

    func testSeekTargetOnDemand() {
        var s = PlayerState()
        s.duration = 100; s.currentTime = 95
        XCTAssertEqual(TVRules.seekTarget(s, delta: 10), 100, "kept inside the duration")
        s.currentTime = 4
        XCTAssertEqual(TVRules.seekTarget(s, delta: -10), 0)
        s.duration = .nan
        XCTAssertNil(TVRules.seekTarget(s, delta: 10), "nothing to seek in before the duration is known")
    }

    func testSeekTargetLive() {
        var s = live()
        XCTAssertEqual(TVRules.seekTarget(s, delta: 30), 3570)
        XCTAssertEqual(TVRules.seekTarget(s, delta: 300), 3600, "never past the live edge")
        s.dvr = false
        XCTAssertNil(TVRules.seekTarget(s, delta: -10), "no window, no seeking")
    }

    func testShouldHide() {
        XCTAssertFalse(TVRules.shouldHide(shown: true, playing: true, panelOpen: false, idleSeconds: 4.9))
        XCTAssertTrue(TVRules.shouldHide(shown: true, playing: true, panelOpen: false, idleSeconds: 5))
        XCTAssertFalse(TVRules.shouldHide(shown: true, playing: false, panelOpen: false, idleSeconds: 60), "paused keeps them")
        XCTAssertFalse(TVRules.shouldHide(shown: true, playing: true, panelOpen: true, idleSeconds: 60), "a panel keeps them")
    }

    func testPresentationStart() {
        XCTAssertEqual(TVRules.presentationStart(live()), now - 60_000 - 3_540_000)
        XCTAssertNil(TVRules.presentationStart(PlayerState()))
    }

    func testGuideRows() {
        var s = live()
        let ps = now - 60_000 - 3_540_000          // media time 0; the window starts here
        s.schedule = [
            Programme(id: "gone", title: "Gone", startsAt: ps - 7_200_000, endsAt: ps - 600_000),
            Programme(id: "clip", title: "Half in", startsAt: ps - 600_000, endsAt: ps + 1_200_000),
            Programme(id: "early", title: "Earlier", startsAt: ps + 1_200_000, endsAt: ps + 3_000_000),
            Programme(id: "now", title: "On now", startsAt: ps + 3_000_000, endsAt: now + 1_800_000),
            Programme(id: "later", title: "Later", startsAt: now + 1_800_000, endsAt: now + 3_600_000),
        ]
        let rows = TVRules.guideRows(s, now: now)
        XCTAssertEqual(rows.map(\.id), ["clip", "early", "now", "later"], "a programme wholly before the window is left out")
        XCTAssertEqual(rows[0].kind, .earlier); XCTAssertEqual(rows[0].clipped, true)
        XCTAssertEqual(rows[0].target, 1, "from the earliest part kept")
        XCTAssertEqual(rows[1].target, 1200); XCTAssertFalse(rows[1].clipped)
        XCTAssertEqual(rows[2].kind, .onNow); XCTAssertEqual(rows[2].target, 3000, "on now: from its start")
        XCTAssertEqual(rows[3].kind, .later); XCTAssertNil(rows[3].target)
        XCTAssertEqual(TVRules.initialRow(rows), 2)
    }

    func testGuideWithoutWindow() {
        var s = PlayerState()
        s.live = true
        s.schedule = [
            Programme(id: "a", title: "A", startsAt: now - 7_200_000, endsAt: now - 600_000),
            Programme(id: "b", title: "B", startsAt: now - 600_000, endsAt: now + 600_000),
            Programme(id: "c", title: "C", startsAt: now + 600_000, endsAt: now + 1_200_000),
        ]
        let rows = TVRules.guideRows(s, now: now)
        XCTAssertEqual(rows.map(\.id), ["b", "c"], "without a window nothing earlier can be watched")
        XCTAssertNil(rows[0].target)
    }

    func testGuideLimitKeepsOnNow() {
        var s = PlayerState()
        s.live = true
        s.schedule = (0..<100).map { i in
            Programme(id: "p\(i)", title: "P\(i)", startsAt: now + Double(i - 1) * 600_000, endsAt: now + Double(i) * 600_000)
        }
        let rows = TVRules.guideRows(s, now: now, limit: 10)
        XCTAssertEqual(rows.count, 10)
        XCTAssertEqual(rows.first?.id, "p1", "the one on now is first when nothing earlier is watchable")
        XCTAssertEqual(TVRules.initialRow([]), nil)
    }
}
