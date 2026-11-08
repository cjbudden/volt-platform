// Every word a built-in skin shows, the same keys as the web SDK
// (volt-player/src/sdk/strings.ts) and the Swift SDK, so one translation file
// serves every platform: pass strings = mapOf("live" to "EN DIRECT", ...) to the player.
package com.volt.player.core

object VoltStrings {
    val defaults: Map<String, String> = mapOf(
        "play" to "Play",
        "pause" to "Pause",
        "replay" to "Play again",
        "live" to "LIVE",
        "goLive" to "Go live",
        "behindLive" to "{time} behind",
        "startOver" to "Start over",
        "startOverHint" to "Watch {title} from the beginning",
        "back10" to "Back 10 seconds",
        "fwd10" to "Forward 10 seconds",
        "mute" to "Mute",
        "unmute" to "Unmute",
        "volume" to "Volume",
        "quality" to "Quality",
        "auto" to "Auto",
        "autoNow" to "Auto ({q})",
        "subtitles" to "Subtitles",
        "off" to "Off",
        "audio" to "Audio",
        "speed" to "Speed",
        "normal" to "Normal",
        "fullscreen" to "Full screen",
        "exitFullscreen" to "Exit full screen",
        "pip" to "Picture in picture",
        "cast" to "Cast to a TV",
        "stopCasting" to "Stop casting",
        "castingTo" to "Playing on {device}",
        "airplay" to "AirPlay",
        "upNext" to "Up next",
        "skipIntro" to "Skip intro",
        "skipRecap" to "Skip recap",
        "skipCredits" to "Skip credits",
        "skip" to "Skip",
        "nextIn" to "Next in {time}",
        "startsIn" to "Starts in {time}",
        "playNow" to "Play now",
        "cancel" to "Cancel",
        "schedule" to "Schedule",
        "playlist" to "Playlist",
        "now" to "Now",
        "next" to "Next",
        "later" to "Later",
        "onNow" to "On now",
        "ad" to "Ad",
        "adOf" to "Ad {number} of {of}",
        "learnMore" to "Learn more",
        "adBreak" to "Ad break",
        "adBreakWatched" to "Ad break, watched",
        "nowPlaying" to "Now playing",
        "recentlyPlayed" to "Recently played",
        "comingUp" to "Coming up",
        "comingUpIn" to "Coming up in {time}",
        "startsAt" to "Starts at {time}",
        "dismiss" to "Dismiss",
        "onAir" to "On air",
        "timeLeft" to "{time} left",
        "nextAt" to "Next at {time}",
        "laterToday" to "Later",
        "offline" to "This is not on air right now.",
        "stopped" to "The stream stopped unexpectedly.",
        "retry" to "Try again",
        "loading" to "Loading",
        "previous" to "Previous",
        "nextItem" to "Next",
        "startsIn2" to "Starts in",
        "days" to "days",
        "hours" to "hrs",
        "mins" to "min",
        "secs" to "sec",
        "addToCalendar" to "Add to calendar",
        "postponed" to "Postponed",
        "cancelled" to "Cancelled",
        "newDateTba" to "A new date will be announced.",
        "wasAt" to "Was {when}",
        "nowAt" to "Now {when}",
        "startingSoon" to "Starting soon",
        "startingSoonText" to "The stream will play as soon as it begins.",
        "ended" to "This event has ended",
        "watchReplay" to "Watch the replay",
        "replayHint" to "The full event, from the start.",
        "buyTitle" to "Get access",
        "buy" to "Buy",
        "alreadyBought" to "Already bought? Check again",
        "signInTitle" to "Sign in to watch",
        "signIn" to "Sign in",
        "regionBlocked" to "This event is not available in your region.",
        "liveNow" to "Live now",
        "backToEvent" to "Back to the event",
        "stats" to "Stats",
        "playbackStats" to "Debug mode",
        "copyDebug" to "Copy debug info",
        "resolution" to "Resolution",
        "bitrate" to "Bitrate",
        "buffer" to "Buffer",
        "latency" to "Behind live",
    )

    /** Fill {name} placeholders. */
    fun format(s: String, vars: Map<String, String> = emptyMap()): String {
        if (vars.isEmpty() || !s.contains('{')) return s
        val out = StringBuilder()
        var i = 0
        while (i < s.length) {
            if (s[i] == '{') {
                val close = s.indexOf('}', i)
                if (close > i) {
                    val key = s.substring(i + 1, close)
                    if (key.all { it.isLetterOrDigit() || it == '_' }) { out.append(vars[key] ?: ""); i = close + 1; continue }
                }
            }
            out.append(s[i]); i++
        }
        return out.toString()
    }
}

/** A translator: the client's strings first, then the defaults, then the key itself. */
class Translator(val overrides: Map<String, String> = emptyMap()) {
    operator fun invoke(key: String, vars: Map<String, String> = emptyMap()): String =
        VoltStrings.format(overrides[key] ?: VoltStrings.defaults[key] ?: key, vars)
}
