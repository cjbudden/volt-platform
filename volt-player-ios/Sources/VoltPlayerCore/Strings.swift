// Every word a built-in skin shows, the same keys as the web SDK
// (volt-player/src/sdk/strings.ts), so one translation file serves every
// platform: pass `strings: ["live": "EN DIRECT", ...]` to the player.
import Foundation

public enum VoltStrings {
    public static let defaults: [String: String] = [
        "play": "Play", "pause": "Pause", "replay": "Play again",
        "live": "LIVE", "goLive": "Go live", "behindLive": "{time} behind",
        "startOver": "Start over", "startOverHint": "Watch {title} from the beginning",
        "back10": "Back 10 seconds", "fwd10": "Forward 10 seconds",
        "mute": "Mute", "unmute": "Unmute", "volume": "Volume",
        "quality": "Quality", "auto": "Auto", "autoNow": "Auto ({q})",
        "subtitles": "Subtitles", "off": "Off", "audio": "Audio", "speed": "Speed", "normal": "Normal",
        "fullscreen": "Full screen", "exitFullscreen": "Exit full screen", "pip": "Picture in picture",
        "cast": "Cast to a TV", "stopCasting": "Stop casting", "castingTo": "Playing on {device}", "airplay": "AirPlay",
        "upNext": "Up next", "skipIntro": "Skip intro", "skipRecap": "Skip recap", "skipCredits": "Skip credits", "skip": "Skip",
        "nextIn": "Next in {time}", "startsIn": "Starts in {time}", "playNow": "Play now", "cancel": "Cancel",
        "schedule": "Schedule", "playlist": "Playlist", "now": "Now", "next": "Next", "later": "Later", "onNow": "On now",
        "ad": "Ad", "adOf": "Ad {number} of {of}", "learnMore": "Learn more", "adBreak": "Ad break", "adBreakWatched": "Ad break, watched",
        "nowPlaying": "Now playing", "recentlyPlayed": "Recently played", "comingUp": "Coming up",
        "comingUpIn": "Coming up in {time}", "startsAt": "Starts at {time}", "dismiss": "Dismiss", "onAir": "On air",
        "timeLeft": "{time} left", "nextAt": "Next at {time}", "laterToday": "Later",
        "offline": "This is not on air right now.", "stopped": "The stream stopped unexpectedly.", "retry": "Try again",
        "loading": "Loading", "previous": "Previous", "nextItem": "Next",
        "startsIn2": "Starts in", "days": "days", "hours": "hrs", "mins": "min", "secs": "sec",
        "addToCalendar": "Add to calendar", "postponed": "Postponed", "cancelled": "Cancelled", "newDateTba": "A new date will be announced.",
        "wasAt": "Was {when}", "nowAt": "Now {when}", "startingSoon": "Starting soon", "startingSoonText": "The stream will play as soon as it begins.",
        "ended": "This event has ended", "watchReplay": "Watch the replay", "replayHint": "The full event, from the start.",
        "buyTitle": "Get access", "buy": "Buy", "alreadyBought": "Already bought? Check again", "signInTitle": "Sign in to watch", "signIn": "Sign in",
        "regionBlocked": "This event is not available in your region.", "liveNow": "Live now", "backToEvent": "Back to the event",
        "stats": "Stats", "playbackStats": "Debug mode", "copyDebug": "Copy debug info", "resolution": "Resolution", "bitrate": "Bitrate",
        "buffer": "Buffer", "latency": "Behind live",
    ]

    /// Fill {name} placeholders.
    public static func format(_ s: String, _ vars: [String: String] = [:]) -> String {
        guard !vars.isEmpty, s.contains("{") else { return s }
        var out = "", i = s.startIndex
        while i < s.endIndex {
            if s[i] == "{", let close = s[i...].firstIndex(of: "}") {
                let key = String(s[s.index(after: i)..<close])
                if key.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) { out += vars[key] ?? ""; i = s.index(after: close); continue }
            }
            out.append(s[i]); i = s.index(after: i)
        }
        return out
    }
}

/// A translator: the client's strings first, then the defaults, then the key itself.
public struct Translator: Sendable {
    public let overrides: [String: String]
    public init(_ overrides: [String: String] = [:]) { self.overrides = overrides }
    public func callAsFunction(_ key: String, _ vars: [String: String] = [:]) -> String {
        VoltStrings.format(overrides[key] ?? VoltStrings.defaults[key] ?? key, vars)
    }
}
