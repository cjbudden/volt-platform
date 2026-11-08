// ============================================================================
//  TV RULES: what the `tv` skin decides, kept here so it is tested on any
//  machine (the skin itself only draws).
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
//  the playhead's wall clock minus the playhead, so a skin needs nothing the
//  web SDK's skins do not also have.
// ============================================================================
import Foundation

public enum TVRules {
    /// Seconds after the last remote input before the controls hide while playing.
    public static let controlsHideDelay: Double = 5

    /// Whether the controls should hide now.
    public static func shouldHide(shown: Bool, playing: Bool, panelOpen: Bool, idleSeconds: Double) -> Bool {
        shown && playing && !panelOpen && idleSeconds >= controlsHideDelay
    }

    /// Where a press of left (negative) or right (positive) goes, or nil when there is nothing to
    /// seek in: a live stream without a DVR window, or on demand before the duration is known.
    public static func seekTarget(_ s: PlayerState, delta: Double) -> Double? {
        let to = s.currentTime + delta
        if s.live {
            guard s.dvr, let w = s.seekable, w.end > w.start else { return nil }
            return min(max(w.start, to), w.end)
        }
        guard s.duration.isFinite, s.duration > 0 else { return nil }
        return min(max(0, to), s.duration)
    }

    /// The wall-clock instant (epoch ms) of media time 0, from the playhead's own wall clock.
    public static func presentationStart(_ s: PlayerState) -> EpochMs? {
        guard let w = s.wallClock, w.isFinite else { return nil }
        return w - s.currentTime * 1000
    }

    public struct GuideRow: Equatable, Sendable, Identifiable {
        public enum Kind: String, Sendable { case earlier, onNow, later }
        public var programme: Programme
        public var kind: Kind
        /// Media seconds to seek to for "watch from the start", or nil when it cannot be watched.
        public var target: Double?
        /// The window no longer reaches the start: playing from the earliest part kept.
        public var clipped: Bool
        public var id: String { programme.id }
    }

    /// The guide as a list, in time order: earlier programmes still (partly) in the window, the one
    /// on now, then later ones (shown, not playable). At most `limit` rows.
    public static func guideRows(_ s: PlayerState, now: EpochMs, limit: Int = 40) -> [GuideRow] {
        let ps = presentationStart(s)
        let at = s.wallClock ?? now
        let windowStartWall: EpochMs? = ps.flatMap { p in s.seekable.map { p + $0.start * 1000 } }
        var rows: [GuideRow] = []
        for p in s.schedule.sorted(by: { $0.startsAt < $1.startsAt }) {
            let onNow = p.startsAt <= at && at < p.endsAt
            if p.startsAt > at {
                rows.append(GuideRow(programme: p, kind: .later, target: nil, clipped: false))
                continue
            }
            // Earlier or on now: watchable if any of it is still in the window.
            if let ws = windowStartWall, p.endsAt <= ws { continue }
            if windowStartWall == nil && !onNow { continue }
            var target: Double?, clipped = false
            if s.live, s.dvr, let r = Schedule.startOverTarget(programmeStart: p.startsAt, presentationStart: ps, seekable: s.seekable) {
                target = r.seconds; clipped = r.clippedMs > 0
            }
            rows.append(GuideRow(programme: p, kind: onNow ? .onNow : .earlier, target: target, clipped: clipped))
        }
        if rows.count <= limit { return rows }
        // Keep the rows around the one on now.
        let i = rows.firstIndex { $0.kind == .onNow } ?? 0
        let from = max(0, min(i - limit / 4, rows.count - limit))
        return Array(rows[from..<(from + limit)])
    }

    /// The row the guide opens on: the one on now, else the first.
    public static func initialRow(_ rows: [GuideRow]) -> Int? {
        rows.isEmpty ? nil : (rows.firstIndex { $0.kind == .onNow } ?? 0)
    }
}
