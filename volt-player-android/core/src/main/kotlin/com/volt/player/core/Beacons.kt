// ============================================================================
//  VIEWER BEACONS: what Analytics counts. A port of volt-player/src/sdk/beacons.ts
//  (and the Swift BeaconSession).
//
//  A session per item: `start` when the first frame plays (with the time it
//  took), a `heartbeat` every 30 s with the seconds actually watched and the
//  bitrate, and `end` when the item changes, the player goes away, or the app
//  moves to the background. Coming back to the foreground while still playing
//  starts a new session, as a tab coming back does on the web.
//
//  Seconds watched are counted from the playhead moving while playing, so a
//  pause, a seek or a stall does not inflate watch time. The clock and the
//  sender are injected, so every rule is unit tested.
// ============================================================================
package com.volt.player.core

import java.util.UUID

class BeaconSession(
    private val token: String,
    id: String? = null,
    private val prefix: String = "android",
    now: Double,
    private val send: (Map<String, Any>) -> Unit,
) {
    companion object {
        const val HEARTBEAT_SECONDS = 30.0
        fun newId(prefix: String) = "$prefix-${UUID.randomUUID().toString().lowercase()}"
    }

    var sessionId: String = id ?: newId(prefix)
        private set
    private var started = false
    private var ended = false
    private var watched = 0.0
    private var lastT: Double? = null
    private val t0 = now
    private var lastBeat = now

    /** The first frame played. */
    fun playing(now: Double, kbps: Int?) {
        if (started) return
        started = true; lastBeat = now
        post("start", mapOf("ttffMs" to Schedule.roundHalfAway((now - t0) * 1000).toInt(), "bitrateKbps" to kbps))
    }

    /** Called on every time tick. `paused` true while not playing. */
    fun time(t: Double, paused: Boolean) {
        val last = lastT
        if (last != null && !paused) { val d = t - last; if (d > 0 && d < 5) watched += d }
        lastT = t
    }

    fun seeking() { lastT = null }

    /** Called on the player's tick; sends the heartbeat when it is due. */
    fun tick(now: Double, kbps: Int?) {
        if (!started || ended || now - lastBeat < HEARTBEAT_SECONDS) return
        lastBeat = now
        val s = Schedule.roundHalfAway(watched)
        watched -= s
        post("heartbeat", mapOf("seconds" to s.toInt(), "bitrateKbps" to kbps))
    }

    /** Close the session (item change, background, destroy). */
    fun end() {
        if (!started || ended) return
        ended = true
        post("end", mapOf("seconds" to Schedule.roundHalfAway(watched).toInt()))
        watched = 0.0
    }

    /** Back in the foreground and still playing: a new session. */
    fun resume(now: Double, kbps: Int?) {
        if (!ended) return
        sessionId = newId(prefix); ended = false; watched = 0.0; started = true; lastBeat = now; lastT = null
        post("start", mapOf("bitrateKbps" to kbps))
    }

    private fun post(event: String, extra: Map<String, Any?>) {
        val body = linkedMapOf<String, Any>("playbackToken" to token, "sessionId" to sessionId, "event" to event)
        for ((k, v) in extra) if (v != null) body[k] = v
        send(body)
    }
}
