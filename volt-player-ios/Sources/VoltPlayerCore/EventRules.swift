// ============================================================================
//  EVENTS: countdown, polling, calendar. The rules of the web event skin
//  (volt-player/src/sdk/skins/event.ts and player.ts pollEvent), shared by
//  every native skin.
//
//  The phase (pre / live / ended / replay / offline / postponed / cancelled)
//  is decided by the control plane. The player never guesses it from its own
//  clock; it only counts down to the start it was given, and asks again
//  every 30 s, every 5 s in the last two minutes and while a start is late.
// ============================================================================
import Foundation

public enum EventRules {
    /// Seconds until the next phase check.
    public static func pollDelay(presentation: Presentation?, msToStart: Double?) -> Double {
        if presentation == .offline { return 5 }
        if let ms = msToStart, ms <= 120_000 { return 5 }
        return 30
    }

    /// Milliseconds to the start, or nil when there is nothing to count down to.
    public static func msToStart(_ e: EventInfo?, now: EpochMs) -> Double? {
        guard let e, e.presentation == .pre, let s = e.startsAt, s > now else { return nil }
        return s - now
    }

    /// Days, hours, minutes and seconds of a countdown.
    public struct Countdown: Equatable, Sendable {
        public var days: Int, hours: Int, minutes: Int, seconds: Int
        public init(days: Int, hours: Int, minutes: Int, seconds: Int) { self.days = days; self.hours = hours; self.minutes = minutes; self.seconds = seconds }
    }

    public static func countdown(_ ms: Double) -> Countdown {
        let s = max(0, Int((ms / 1000).rounded(.down)))
        return Countdown(days: s / 86_400, hours: (s % 86_400) / 3600, minutes: (s % 3600) / 60, seconds: s % 60)
    }

    /// Whether the video player is shown (live, or the replay playing).
    public static func showsVideo(_ presentation: Presentation?, replaying: Bool) -> Bool {
        replaying || presentation == .live
    }

    static func icsDate(_ ms: EpochMs) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    static func icsText(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: ",", with: "\\,")
            .replacingOccurrences(of: ";", with: "\\;").replacingOccurrences(of: "\r\n", with: "\\n").replacingOccurrences(of: "\n", with: "\\n")
    }

    /// An .ics file for the event, so Add to calendar works with every calendar app.
    public static func ics(id: String, title: String, startsAt: EpochMs, endsAt: EpochMs?, description: String?, url: String, now: EpochMs) -> String {
        let end = (endsAt ?? 0) > startsAt ? endsAt! : startsAt + 2 * 3_600_000
        var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Volt//Player//EN", "BEGIN:VEVENT",
                     "UID:\(id)@volt-player", "DTSTAMP:\(icsDate(now))", "DTSTART:\(icsDate(startsAt))", "DTEND:\(icsDate(end))",
                     "SUMMARY:\(icsText(title))"]
        if let d = description, !d.isEmpty { lines.append("DESCRIPTION:\(icsText(d))") }
        lines.append("URL:\(url)")
        lines += ["END:VEVENT", "END:VCALENDAR"]
        return lines.joined(separator: "\r\n")
    }
}
