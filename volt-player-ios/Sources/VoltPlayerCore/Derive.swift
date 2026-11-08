// ============================================================================
//  DERIVE: from what the engine reports to what a skin shows.
//
//  The same rules as derive() in volt-player/src/sdk/player.ts, as a pure
//  function, so the iOS engine stays thin and every rule is tested:
//
//    * the wall clock at the playhead: the stream's PROGRAM-DATE-TIME when it
//      has one, else now minus the distance behind live
//    * the programme on air: the fetched guide, else the stream's own
//      programme marker (no app key needed for now / next)
//    * up next: the stream's own trigger wins over one worked out from the
//      guide, and nothing is offered during an ad break
//    * skip intro / recap / credits: on demand only, gone in the last half
//      second so a button never offers to skip what has just ended
// ============================================================================
import Foundation

/// What the engine knows at this instant.
public struct EngineSnapshot: Equatable, Sendable {
    public var currentTime: Double
    public var duration: Double
    public var live: Bool
    public var seekable: SeekWindow?
    /// Wall clock of media time 0 (epoch ms), from PROGRAM-DATE-TIME.
    public var presentationStart: EpochMs?
    public init(currentTime: Double, duration: Double, live: Bool, seekable: SeekWindow?, presentationStart: EpochMs?) {
        self.currentTime = currentTime; self.duration = duration; self.live = live; self.seekable = seekable; self.presentationStart = presentationStart
    }
}

public struct DeriveInput {
    public var engine: EngineSnapshot
    public var now: EpochMs
    public var schedule: [Programme]
    public var graphics: [StreamGraphic]
    public var graphicsOn: Bool
    public var upNextOn: Bool
    public var skipOn: Bool
    public var upNextSeconds: Double
    public var autoAdvance: Bool
    public var items: [PlaylistItem]
    public var index: Int
    /// "g:<id>", "p:<id>" or "i:<index>": the up-next card the viewer dismissed.
    public var dismissed: String?
    public init(engine: EngineSnapshot, now: EpochMs, schedule: [Programme], graphics: [StreamGraphic], graphicsOn: Bool,
                upNextOn: Bool, skipOn: Bool, upNextSeconds: Double, autoAdvance: Bool, items: [PlaylistItem], index: Int, dismissed: String?) {
        self.engine = engine; self.now = now; self.schedule = schedule; self.graphics = graphics; self.graphicsOn = graphicsOn
        self.upNextOn = upNextOn; self.skipOn = skipOn; self.upNextSeconds = upNextSeconds; self.autoAdvance = autoAdvance
        self.items = items; self.index = index; self.dismissed = dismissed
    }
}

public struct Derived: Equatable, Sendable {
    public var behindLive: Double
    public var atLiveEdge: Bool
    public var dvr: Bool
    public var wallClock: EpochMs?
    public var programme: Programme?
    public var nextProgramme: Programme?
    public var canStartOver: Bool
    public var graphics: [StreamGraphic]
    public var adBreak: AdBreakState?
    public var upNext: UpNext?
    public var skip: SkipOffer?
    /// The key to store when the viewer dismisses the card on screen.
    public var dismissKey: String?
}

public enum Derive {
    /// A DVR window shorter than this is not worth a scrubber on live.
    public static let dvrMinSeconds: Double = 60
    /// Within this of the live edge counts as live.
    public static let liveEdgeSeconds: Double = 8

    public static func run(_ i: DeriveInput) -> Derived {
        let e = i.engine
        let t = e.currentTime
        let behind = e.live && e.seekable != nil ? max(0, e.seekable!.end - t) : 0
        let wall: EpochMs? = e.presentationStart.map { $0 + t * 1000 } ?? (e.live ? i.now - behind * 1000 : nil)
        let adBreakG = Triggers.adBreakAt(i.graphics, t)
        let active = Triggers.activeAt(i.graphics, t)
        let shown = !i.graphicsOn ? [] : (adBreakG.map { [$0] } ?? active)

        let sched = i.schedule
        let inband = sched.isEmpty && e.presentationStart != nil ? active.first { $0.graphic == "programme" } : nil
        var programme: Programme?
        if !sched.isEmpty { programme = Schedule.programmeAt(sched, wall ?? i.now) }
        else if let g = inband, let ps = e.presentationStart { programme = Triggers.programme(from: g, presentationStart: ps) }

        let guideNext = sched.isEmpty ? nil : Schedule.programmeAfter(sched, programme.map { $0.endsAt - 1 } ?? (wall ?? i.now))
        var nextProgramme = guideNext
        if sched.isEmpty, let g = inband, let ps = e.presentationStart {
            let later = i.graphics.filter { $0.graphic == "programme" && $0.start > g.start }.min { $0.start < $1.start }
            if let nx = later { nextProgramme = Triggers.programme(from: nx, presentationStart: ps) }
            else if let nt = g.data["next_title"], !nt.isEmpty {
                let ns = g.data["next_start"].flatMap(Triggers.parseISO)
                nextProgramme = Programme(id: g.data["next_id"].flatMap { $0.isEmpty ? nil : $0 } ?? "next:\(g.id)", title: nt,
                                          subtitle: g.data["next_subtitle"], imageUrl: g.data["next_image"],
                                          startsAt: ns ?? programme?.endsAt ?? i.now, endsAt: .infinity)
            }
        }

        let dismissKey = programme.map { "p:\($0.id)" } ?? "i:\(i.index)"
        let upG = shown.first { $0.graphic == "up-next" }
        var upNext: UpNext?
        var cardKey: String? = nil
        if adBreakG == nil && i.upNextOn {
            if let g = upG, i.dismissed != "g:\(g.id)" {
                upNext = Triggers.upNext(from: g, at: t, wallClock: wall); cardKey = "g:\(g.id)"
            } else if upG == nil || i.dismissed == "g:\(upG!.id)" {
                upNext = Schedule.upNext(.init(
                    hasNextItem: i.index + 1 < i.items.count, nextItem: i.index + 1 < i.items.count ? i.items[i.index + 1] : nil,
                    currentTime: t, duration: e.duration, live: e.live, programme: programme, nextProgramme: guideNext,
                    playheadClock: wall, seconds: i.upNextSeconds, autoAdvance: i.autoAdvance, dismissed: i.dismissed == dismissKey))
                if upNext != nil { cardKey = dismissKey }
            }
        }

        var skip: SkipOffer?
        if !e.live && i.skipOn {
            for g in i.graphics where g.graphic.hasPrefix("skip-") {
                guard let end = g.end else { continue }
                if t >= g.start && t < end - 0.5 {
                    skip = SkipOffer(kind: g.data["kind"].flatMap { $0.isEmpty ? nil : $0 } ?? String(g.graphic.dropFirst(5)), from: g.start, to: end, id: g.id)
                    break
                }
            }
        }

        let dvr = e.live && (e.seekable.map { $0.end - $0.start >= dvrMinSeconds } ?? false)
        return Derived(
            behindLive: behind, atLiveEdge: !e.live || behind <= liveEdgeSeconds, dvr: dvr, wallClock: wall,
            programme: programme, nextProgramme: nextProgramme,
            canStartOver: Schedule.canStartOver(programme, presentationStart: e.presentationStart, seekable: e.seekable, live: e.live),
            graphics: shown,
            adBreak: adBreakG.map { g in AdBreakState(id: g.data["break"].flatMap { $0.isEmpty ? nil : $0 } ?? g.id,
                                                      endsAt: g.end.flatMap { end in e.presentationStart.map { $0 + end * 1000 } }) },
            upNext: upNext, skip: skip, dismissKey: cardKey)
    }
}
