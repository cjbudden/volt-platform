// ============================================================================
//  IN-STREAM TRIGGERS, player side. A port of volt-player/src/sdk/triggers.ts.
//
//  The server writes them into the HLS playlists as
//      #EXT-X-DATERANGE:ID="...",CLASS="com.boomlabs.volt.<kind>",
//          START-DATE="...",DURATION=...,X-TITLE="...",X-NEXT-TITLE="..."
//  On Apple platforms AVPlayer hands them over as date range metadata groups
//  (AVPlayerItemMetadataCollector), with WALL-CLOCK start and end dates. The
//  contract's graphics are in MEDIA seconds (the clock of currentTime), so the
//  engine converts with the stream's presentation start:
//      media seconds = (wall clock ms - presentationStart ms) / 1000
//  which holds for a viewer behind live, one scrubbing the DVR, and VOD.
//
//  `parseDateRanges` reads the tags from playlist text directly, for tests and
//  for any host that fetches playlists itself.
// ============================================================================
import Foundation

public enum Triggers {
    public static let classPrefix = "com.boomlabs.volt."

    /// One EXT-X-DATERANGE, with wall-clock times (epoch ms).
    public struct DateRange: Equatable, Sendable {
        public var id: String
        public var cls: String
        public var startDate: EpochMs
        public var endDate: EpochMs?
        /// X- attributes and the rest, keyed as written (X-NEXT-TITLE).
        public var attributes: [String: String]
        public init(id: String, cls: String, startDate: EpochMs, endDate: EpochMs?, attributes: [String: String]) {
            self.id = id; self.cls = cls; self.startDate = startDate; self.endDate = endDate; self.attributes = attributes
        }
    }

    /// X-NEXT-TITLE -> next_title; TITLE -> title. One key style whatever the source.
    public static func key(_ k: String) -> String {
        var s = k
        if s.lowercased().hasPrefix("lsdr/") { s = String(s.dropFirst(5)) }
        if s.uppercased().hasPrefix("X-") { s = String(s.dropFirst(2)) }
        return s.lowercased().replacingOccurrences(of: "-", with: "_")
    }

    static func graphicOf(_ cls: String, _ data: [String: String]) -> String {
        if let g = data["graphic"], !g.isEmpty { return g }
        if cls.hasSuffix(".ad") { return "ad" }
        if cls.hasSuffix(".programme") { return "programme" }
        let rest = String(cls.dropFirst(classPrefix.count))
        return rest.isEmpty ? "unknown" : rest
    }

    /// Date ranges to graphics on the media clock. Unknown classes are ignored.
    public static func graphics(from ranges: [DateRange], presentationStart: EpochMs) -> [StreamGraphic] {
        ranges.compactMap { r in
            guard r.cls.hasPrefix(classPrefix) else { return nil }
            var data: [String: String] = [:]
            // Only the X- attributes are the trigger's data (X-ID becomes "id"); ID, CLASS,
            // START-DATE and the rest describe the tag itself.
            for (k, v) in r.attributes {
                var raw = k
                if raw.lowercased().hasPrefix("lsdr/") { raw = String(raw.dropFirst(5)) }
                guard raw.uppercased().hasPrefix("X-") else { continue }
                data[key(raw)] = v
            }
            let start = (r.startDate - presentationStart) / 1000
            let end = r.endDate.map { ($0 - presentationStart) / 1000 }
            let id = data["id"].flatMap { $0.isEmpty ? nil : $0 } ?? (r.id.isEmpty ? "\(r.cls)@\(start)" : r.id)
            return StreamGraphic(id: id, graphic: graphicOf(r.cls, data), start: start, end: end, data: data)
        }
    }

    /// Every EXT-X-DATERANGE in a media playlist.
    public static func parseDateRanges(_ playlist: String) -> [DateRange] {
        var out: [DateRange] = []
        for raw in playlist.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("#EXT-X-DATERANGE:") else { continue }
            let attrs = parseAttributes(String(line.dropFirst("#EXT-X-DATERANGE:".count)))
            guard let sd = attrs["START-DATE"], let start = parseISO(sd) else { continue }
            var end: EpochMs?
            if let ed = attrs["END-DATE"], let e = parseISO(ed) { end = e }
            else if let d = attrs["DURATION"].flatMap(Double.init) { end = start + d * 1000 }
            out.append(DateRange(id: attrs["ID"] ?? "", cls: attrs["CLASS"] ?? "", startDate: start, endDate: end, attributes: attrs))
        }
        return out
    }

    /// HLS attribute list: KEY=value or KEY="quoted, with commas".
    public static func parseAttributes(_ s: String) -> [String: String] {
        var out: [String: String] = [:]
        var i = s.startIndex
        while i < s.endIndex {
            guard let eq = s[i...].firstIndex(of: "=") else { break }
            let k = s[i..<eq].trimmingCharacters(in: CharacterSet(charactersIn: ", "))
            var j = s.index(after: eq)
            var v = ""
            if j < s.endIndex && s[j] == "\"" {
                let from = s.index(after: j)
                let close = s[from...].firstIndex(of: "\"") ?? s.endIndex
                v = String(s[from..<close])
                j = close < s.endIndex ? s.index(after: close) : close
            } else {
                let comma = s[j...].firstIndex(of: ",") ?? s.endIndex
                v = String(s[j..<comma]); j = comma
            }
            if !k.isEmpty { out[k] = v }
            i = j < s.endIndex ? s.index(after: j) : j
        }
        return out
    }

    /// ISO 8601 with or without fractional seconds, to epoch ms.
    public static func parseISO(_ s: String) -> EpochMs? {
        let a = ISO8601DateFormatter()
        a.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = a.date(from: s) { return d.timeIntervalSince1970 * 1000 }
        a.formatOptions = [.withInternetDateTime]
        return a.date(from: s).map { $0.timeIntervalSince1970 * 1000 }
    }

    /// Keep graphics by id; a later report of the same one replaces it. Forget what ended long ago.
    public static func merge(_ into: inout [String: StreamGraphic], _ list: [StreamGraphic], horizon: Double? = nil) {
        for g in list { into[g.id] = g }
        if let h = horizon { into = into.filter { $0.value.end == nil || $0.value.end! >= h } }
    }

    /// What is on screen at media time t.
    public static func activeAt(_ all: [StreamGraphic], _ t: Double) -> [StreamGraphic] {
        all.filter { t >= $0.start && ($0.end == nil || t < $0.end!) }.sorted { $0.start < $1.start }
    }

    /// The Up next card from an active up-next graphic. Counts down to the next programme's
    /// start when the stream has a wall clock, else to the card's own end.
    public static func upNext(from g: StreamGraphic, at t: Double, wallClock: EpochMs?) -> UpNext {
        let starts = g.data["starts"].flatMap(parseISO)
        let inMs: Double
        if let s = starts, let w = wallClock { inMs = max(0, s - w) } else { inMs = max(0, ((g.end ?? t) - t) * 1000) }
        return UpNext(kind: .programme, title: nonEmpty(g.data["title"]) ?? "Up next", subtitle: nonEmpty(g.data["subtitle"]),
                      artworkUrl: nonEmpty(g.data["image"]), inMs: inMs.rounded(), autoAdvance: false,
                      totalMs: (((g.end ?? g.start + 12) - g.start) * 1000).rounded(),
                      shownMs: max(0, ((t - g.start) * 1000).rounded()), startsAt: starts, source: .stream)
    }

    /// The ad break at media time t, if one is on and asks for graphics to be hidden.
    public static func adBreakAt(_ all: [StreamGraphic], _ t: Double) -> StreamGraphic? {
        all.first { g in
            g.graphic == "ad-break" && t >= g.start && (g.end == nil || t < g.end!) && (g.data["hide_graphics"] ?? "all") != "none"
        }
    }

    static let programmeOwn: Set<String> = ["id", "title", "subtitle", "description", "image", "graphic", "kind"]

    /// The programme's key metadata from its marker: everything but its own fields and next_*.
    public static func programmeMeta(_ d: [String: String]) -> [String: String] {
        d.filter { !programmeOwn.contains($0.key) && !$0.key.hasPrefix("next_") && !$0.value.isEmpty }
    }

    /// A programme marker as a Programme (instants from the presentation start).
    public static func programme(from g: StreamGraphic, presentationStart: EpochMs) -> Programme {
        Programme(id: nonEmpty(g.data["id"]) ?? g.id, title: g.data["title"] ?? "", subtitle: g.data["subtitle"],
                  description: g.data["description"], imageUrl: g.data["image"],
                  startsAt: presentationStart + g.start * 1000,
                  endsAt: g.end.map { presentationStart + $0 * 1000 } ?? .infinity, meta: programmeMeta(g.data))
    }

    static func nonEmpty(_ s: String?) -> String? { (s?.isEmpty ?? true) ? nil : s }
}
