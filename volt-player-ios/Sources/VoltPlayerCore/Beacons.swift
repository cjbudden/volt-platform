// ============================================================================
//  VIEWER BEACONS: what Analytics counts. A port of volt-player/src/sdk/beacons.ts.
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
import Foundation

public final class BeaconSession {
    public static let heartbeatSeconds: Double = 30

    public private(set) var id: String
    let token: String
    let prefix: String
    let send: ([String: Any]) -> Void
    var started = false
    var ended = false
    var watched: Double = 0
    var lastT: Double?
    let t0: Double
    var lastBeat: Double

    /// `now` is a monotonic clock in seconds; `send` posts the body.
    public init(token: String, id: String? = nil, prefix: String = "ios", now: Double, send: @escaping ([String: Any]) -> Void) {
        self.token = token; self.prefix = prefix; self.send = send
        self.id = id ?? Self.newId(prefix)
        self.t0 = now; self.lastBeat = now
    }

    static func newId(_ p: String) -> String { "\(p)-\(UUID().uuidString.lowercased())" }

    public var sessionId: String { id }

    /// The first frame played.
    public func playing(now: Double, kbps: Int?) {
        guard !started else { return }
        started = true; lastBeat = now
        post("start", ["ttffMs": Int(((now - t0) * 1000).rounded()), "bitrateKbps": kbps])
    }

    /// Called on every time tick. `paused` true while not playing.
    public func time(_ t: Double, paused: Bool) {
        if let last = lastT, !paused { let d = t - last; if d > 0 && d < 5 { watched += d } }
        lastT = t
    }

    public func seeking() { lastT = nil }

    /// Called on the player's tick; sends the heartbeat when it is due.
    public func tick(now: Double, kbps: Int?) {
        guard started, !ended, now - lastBeat >= Self.heartbeatSeconds else { return }
        lastBeat = now
        let s = watched.rounded()
        watched -= s
        post("heartbeat", ["seconds": Int(s), "bitrateKbps": kbps])
    }

    /// Close the session (item change, background, destroy).
    public func end() {
        guard started, !ended else { return }
        ended = true
        post("end", ["seconds": Int(watched.rounded())])
        watched = 0
    }

    /// Back in the foreground and still playing: a new session.
    public func resume(now: Double, kbps: Int?) {
        guard ended else { return }
        id = Self.newId(prefix); ended = false; watched = 0; started = true; lastBeat = now; lastT = nil
        post("start", ["bitrateKbps": kbps])
    }

    func post(_ event: String, _ extra: [String: Any?]) {
        var body: [String: Any] = ["playbackToken": token, "sessionId": id, "event": event]
        for (k, v) in extra { if let v { body[k] = v } }
        send(body)
    }
}
