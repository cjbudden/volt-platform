// ============================================================================
//  THE PLAYER'S ARITHMETIC: programmes, up next, start over, qualities,
//  playlists. A line-for-line port of volt-player/src/sdk/schedule.ts. Pure,
//  so every rule is unit tested (Tests/VoltPlayerCoreTests) against the same
//  cases as the web SDK's test/player-sdk.check.ts.
// ============================================================================
import Foundation

public enum Schedule {
    /// The programme on air at an instant, or nil in a gap.
    public static func programmeAt(_ list: [Programme], _ at: EpochMs) -> Programme? {
        list.first { $0.startsAt <= at && at < $0.endsAt }
    }

    /// The first programme starting at or after an instant.
    public static func programmeAfter(_ list: [Programme], _ at: EpochMs) -> Programme? {
        var best: Programme?
        for p in list where p.startsAt >= at && (best == nil || p.startsAt < best!.startsAt) { best = p }
        return best
    }

    /// Sorted, de-duplicated, and only what is valid. Arrives from a feed; trust nothing.
    public static func clean(_ list: Any?) -> [Programme] {
        guard let arr = list as? [Any] else { return [] }
        var out: [Programme] = []
        var seen = Set<String>()
        for case let x as [String: Any] in arr {
            guard let title = x["title"] as? String, let s = num(x["startsAt"]), let e = num(x["endsAt"]), e > s else { continue }
            let id = (x["id"].map { "\($0)" }) ?? "\(Int64(s))"
            if seen.contains(id) { continue }
            seen.insert(id)
            out.append(Programme(id: id, title: title, subtitle: x["subtitle"] as? String, description: x["description"] as? String,
                                 imageUrl: x["imageUrl"] as? String, startsAt: s, endsAt: e))
        }
        return out.sorted { $0.startsAt < $1.startsAt }
    }

    static func num(_ v: Any?) -> Double? {
        if let n = v as? NSNumber { let d = n.doubleValue; return d.isFinite ? d : nil }
        if let s = v as? String, let d = Double(s), d.isFinite { return d }
        return nil
    }

    public struct UpNextInput {
        public var hasNextItem: Bool
        public var nextItem: PlaylistItem?
        public var currentTime: Double
        public var duration: Double
        public var live: Bool
        public var programme: Programme?
        public var nextProgramme: Programme?
        /// What time it is AT THE PLAYHEAD (a viewer 30 s behind live sees the change 30 s later).
        public var playheadClock: EpochMs?
        public var seconds: Double
        public var autoAdvance: Bool
        public var dismissed: Bool
        public init(hasNextItem: Bool, nextItem: PlaylistItem?, currentTime: Double, duration: Double, live: Bool,
                    programme: Programme?, nextProgramme: Programme?, playheadClock: EpochMs?, seconds: Double,
                    autoAdvance: Bool, dismissed: Bool) {
            self.hasNextItem = hasNextItem; self.nextItem = nextItem; self.currentTime = currentTime; self.duration = duration
            self.live = live; self.programme = programme; self.nextProgramme = nextProgramme; self.playheadClock = playheadClock
            self.seconds = seconds; self.autoAdvance = autoAdvance; self.dismissed = dismissed
        }
    }

    /// Should the up-next card show, and with what? On demand: the last `seconds` of an item
    /// with a next one. Live: the last `seconds` of a programme when the guide knows the next.
    public static func upNext(_ i: UpNextInput) -> UpNext? {
        if i.dismissed { return nil }
        let windowMs = max(5, i.seconds) * 1000
        if !i.live && i.hasNextItem && i.duration.isFinite && i.duration > 0 {
            let left = (i.duration - i.currentTime) * 1000
            if i.duration * 1000 < windowMs * 2 { return nil }
            if left > 0 && left <= windowMs {
                let n = i.nextItem
                return UpNext(kind: .item, title: n?.title ?? "Next", subtitle: n?.subtitle, artworkUrl: n?.artworkUrl,
                              inMs: max(0, left.rounded()), autoAdvance: i.autoAdvance, totalMs: windowMs, source: .playlist)
            }
            return nil
        }
        if i.live, let p = i.programme, let n = i.nextProgramme, let clock = i.playheadClock {
            let left = p.endsAt - clock
            if n.startsAt - p.endsAt > 5 * 60_000 { return nil }
            if left > 0 && left <= windowMs {
                return UpNext(kind: .programme, title: n.title, subtitle: n.subtitle, artworkUrl: n.imageUrl,
                              inMs: left.rounded(), autoAdvance: false, totalMs: windowMs, startsAt: n.startsAt, source: .guide)
            }
        }
        return nil
    }

    /// Where to seek to start the current programme from the beginning. `presentationStart` is
    /// the wall clock of media time 0. When the start is older than the DVR window, the oldest
    /// point available, with `clippedMs` saying how much of the beginning is missing.
    public static func startOverTarget(programmeStart: EpochMs, presentationStart: EpochMs?, seekable: SeekWindow?) -> (seconds: Double, clippedMs: Double)? {
        guard let ps = presentationStart, let w = seekable, programmeStart.isFinite else { return nil }
        let t = (programmeStart - ps) / 1000
        if t > w.end { return nil }
        let floor = w.start + 1
        if t >= floor { return (t, 0) }
        return (floor, ((floor - t) * 1000).rounded())
    }

    /// Start over is offered only when the window reaches back to the programme start.
    public static func canStartOver(_ programme: Programme?, presentationStart: EpochMs?, seekable: SeekWindow?, live: Bool) -> Bool {
        guard live, let p = programme, let r = startOverTarget(programmeStart: p.startsAt, presentationStart: presentationStart, seekable: seekable) else { return false }
        return r.clippedMs == 0
    }

    public struct VariantInput {
        public var id: String
        public var height: Int?
        public var width: Int?
        public var bandwidth: Double
        public init(id: String, height: Int?, width: Int?, bandwidth: Double) { self.id = id; self.height = height; self.width = width; self.bandwidth = bandwidth }
    }

    /// The quality menu: ONE ENTRY PER PICTURE SIZE (the highest bitrate kept),
    /// or by bitrate for an audio-only ladder.
    public static func qualityList(_ tracks: [VariantInput]) -> [Quality] {
        let video = tracks.filter { ($0.height ?? 0) > 0 }
        if video.isEmpty {
            var byRate: [Int: Quality] = [:]
            for t in tracks {
                let kbps = Int((t.bandwidth / 1000).rounded())
                if byRate[kbps] == nil { byRate[kbps] = Quality(id: t.id, height: nil, width: nil, bitrate: t.bandwidth, label: "\(kbps) kbps") }
            }
            return byRate.values.sorted { $0.bitrate > $1.bitrate }
        }
        var byHeight: [Int: Quality] = [:]
        for t in video {
            let h = t.height!
            if let cur = byHeight[h], t.bandwidth <= cur.bitrate { continue }
            byHeight[h] = Quality(id: t.id, height: h, width: t.width, bitrate: t.bandwidth, label: qualityLabel(h))
        }
        return byHeight.values.sorted { ($0.height ?? 0) > ($1.height ?? 0) }
    }

    public static func qualityLabel(_ h: Int) -> String {
        if h >= 2100 { return "4K" }
        if h >= 1400 { return "1440p" }
        return "\(h)p"
    }

    public enum SourceKind: String { case hls, dash, mp3, mp4 }

    public static func sourceKind(_ url: String) -> SourceKind {
        let p = (url.split(separator: "?", maxSplits: 1).first.map(String.init) ?? url).lowercased()
        if p.hasSuffix(".m3u8") || p.hasSuffix(".m3u") { return .hls }
        if p.hasSuffix(".mpd") { return .dash }
        if p.hasSuffix(".mp3") || p.hasSuffix(".aac") || p.hasSuffix(".m4a") { return .mp3 }
        return .mp4
    }

    static func isUUID(_ s: String) -> Bool {
        let parts = s.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.map(\.count) == [8, 4, 4, 4, 12] else { return false }
        return parts.allSatisfy { $0.allSatisfy { $0.isHexDigit } }
    }

    /// A playlist entry: an item, an asset id or a URL.
    public enum Entry { case item(PlaylistItem), string(String) }

    /// A playlist from whatever was passed: items, asset ids, or URLs.
    public static func normalize(_ entries: [Entry]) -> [PlaylistItem] {
        var out: [PlaylistItem] = []
        for (i, e) in entries.enumerated() {
            switch e {
            case .string(let raw):
                let s = raw.trimmingCharacters(in: .whitespaces)
                if s.isEmpty { continue }
                if isUUID(s) { out.append(PlaylistItem(id: s, assetId: s)) }
                else { out.append(PlaylistItem(id: "url-\(i)", title: titleFromUrl(s), source: Source(url: s))) }
            case .item(let it):
                if it.assetId != nil || hasSource(it.source) || it.title != nil { out.append(it) }
            }
        }
        return out
    }

    public static func hasSource(_ s: Source?) -> Bool {
        guard let s else { return false }
        return [s.hls, s.dash, s.mp3, s.url].contains { !($0 ?? "").isEmpty }
    }

    static func titleFromUrl(_ u: String) -> String {
        guard let url = URL(string: u, relativeTo: URL(string: "https://x")) else { return u }
        let parts = url.path.split(separator: "/").map(String.init)
        guard let last = parts.last else { return u }
        let lower = last.lowercased()
        let generic = ["master.", "index.", "manifest.", "playlist."].contains { lower.hasPrefix($0) }
        let name = parts.count > 1 && generic ? parts[parts.count - 2] : last
        let decoded = name.removingPercentEncoding ?? name
        if let dot = decoded.lastIndex(of: "."), decoded[decoded.index(after: dot)...].allSatisfy({ $0.isLetter || $0.isNumber }), dot != decoded.startIndex {
            return String(decoded[..<dot])
        }
        return decoded
    }

    /// "12:04", or "1:02:04" past an hour.
    public static func fmtTime(_ sec: Double) -> String {
        let v = sec.isFinite && sec >= 0 ? sec : 0
        let s = Int(v) % 60, m = (Int(v) / 60) % 60, h = Int(v) / 3600
        let mm = h > 0 ? String(format: "%02d", m) : String(m)
        return (h > 0 ? "\(h):" : "") + mm + ":" + String(format: "%02d", s)
    }

    /// "in 12 s", "in 3 min" (without "in").
    public static func fmtIn(_ ms: Double) -> String {
        let s = Int((ms / 1000).rounded(.up))
        return s < 60 ? "\(s) s" : "\(Int((Double(s) / 60).rounded(.up))) min"
    }

    /// A wall-clock time in the viewer's own locale.
    public static func fmtClock(_ ms: EpochMs, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        guard ms.isFinite else { return "" }
        let f = DateFormatter()
        f.locale = locale; f.timeZone = timeZone
        f.dateStyle = .none; f.timeStyle = .short
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
}
