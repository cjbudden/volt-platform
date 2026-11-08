// ============================================================================
//  TALKING TO THE CONTROL PLANE: asset ids, the guide, events, now playing,
//  beacons. A port of volt-player/src/sdk/resolver.ts.
//
//  Every call carries the PUBLISHABLE app key and nothing secret. Register the
//  app in Volt as type "iOS" and use that app's key, not a web key: a web key
//  is tied to website origins, and an app sends none.
//
//  The play gate (POST /api/availability) decides per asset and per viewer,
//  and answers with the URLs to play and a short-lived playback token. Items
//  are resolved when they come up, so a long playlist never plays on an
//  expired token.
// ============================================================================
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The HTTP the SDK needs. Injected so tests run without a network.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, Int)
}

/// URLSession, with no cookies: the player is anonymous unless given a viewer token.
public struct URLSessionTransport: HTTPTransport {
    let session: URLSession
    public init(session: URLSession? = nil) {
        if let session { self.session = session; return }
        let c = URLSessionConfiguration.ephemeral
        c.httpShouldSetCookies = false
        c.timeoutIntervalForRequest = 15
        self.session = URLSession(configuration: c)
    }
    public func send(_ request: URLRequest) async throws -> (Data, Int) {
        try await withCheckedThrowingContinuation { cont in
            session.dataTask(with: request) { data, resp, err in
                if let err { cont.resume(throwing: err); return }
                cont.resume(returning: (data ?? Data(), (resp as? HTTPURLResponse)?.statusCode ?? 0))
            }.resume()
        }
    }
}

/// The gate said no: why, in words a viewer can read, and what would let them in.
public struct GateError: Error, Equatable {
    public var status: Int
    public var message: String
    public var mode: String?
    public var products: [Product]
}

public enum Gate {
    /// What a viewer is told when the gate says no. Same words as the web SDK.
    public static func message(status: Int, mode: String?) -> String {
        if mode == "paywall" || status == 402 { return "This needs a subscription or purchase." }
        if mode == "sign_in" { return "Sign in to watch this." }
        if status == 451 { return "This is not available in your region." }
        if status == 403 { return "This player is not allowed here." }
        if status == 404 { return "This could not be found." }
        if status == 401 { return "This player key is not valid." }
        return "This is not available right now."
    }

    /// Fill a purchase / sign-in URL template. Values are URL-encoded.
    public static func fillUrl(_ tpl: String, _ vars: [String: String?]) -> String {
        var out = "", i = tpl.startIndex
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()"))
        while i < tpl.endIndex {
            if tpl[i] == "{", let close = tpl[i...].firstIndex(of: "}") {
                let k = String(tpl[tpl.index(after: i)..<close])
                if !k.isEmpty, k.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) {
                    let v = (vars[k] ?? nil) ?? ""
                    out += v.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
                    i = tpl.index(after: close); continue
                }
            }
            out.append(tpl[i]); i = tpl.index(after: i)
        }
        return out
    }

    /// "A$4.99", in the viewer's own locale.
    public static func fmtPrice(cents: Int, currency: String, locale: Locale = .current) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency; f.currencyCode = currency; f.locale = locale
        return f.string(from: NSNumber(value: Double(cents) / 100)) ?? String(format: "%.2f %@", Double(cents) / 100, currency)
    }

    /// "24 hours", "1 month", or "This event" for the item's own dates.
    public static func fmtTerm(_ p: Product) -> String {
        guard p.kind == .period, let n = p.count, n > 0, let u = p.unit else { return "This event" }
        if u == .day && n == 1 { return "24 hours" }
        return "\(n) \(u.rawValue)\(n == 1 ? "" : "s")"
    }
}

/// What the gate answered for one asset.
public struct ResolvedItem: Equatable, Sendable {
    public var source: Source?
    public var token: String?
    public var title: String?
    public var description: String?
    public var artworkUrl: String?
    public var durationMs: Double?
    public var live: Bool?
    public var kind: String?
    public var ads: ItemAds?
    public var brandMark: BrandMark?
}

public struct NowPlayingAnswer: Equatable, Sendable {
    public var nowPlaying: TrackInfo?
    public var history: [TrackInfo]
    public var next: TrackInfo?
    public var onAir: Bool
}

public struct VoltAPI: Sendable {
    public let base: URL
    public let appKey: String
    let transport: HTTPTransport
    /// Sent on every call, so the app is known in reports and the gate can tell an app from a page.
    let clientHeaders: [String: String]

    public init(base: URL, appKey: String, transport: HTTPTransport = URLSessionTransport(), platform: String = "ios",
                bundleId: String? = Bundle.main.bundleIdentifier, appVersion: String? = nil) {
        self.base = base; self.appKey = appKey; self.transport = transport
        var h = ["x-volt-sdk": "ios/\(VoltSDK.version)", "x-volt-platform": platform]
        if let bundleId { h["x-volt-bundle-id"] = bundleId }
        if let appVersion { h["x-volt-app-version"] = appVersion }
        self.clientHeaders = h
    }

    func url(_ path: String, _ query: [String: String] = [:]) -> URL {
        var c = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        return c.url!
    }

    func request(_ u: URL, method: String = "GET", json: [String: Any]? = nil, bearer: String? = nil) -> URLRequest {
        var r = URLRequest(url: u)
        r.httpMethod = method
        for (k, v) in clientHeaders { r.setValue(v, forHTTPHeaderField: k) }
        if let json {
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])
        }
        if let bearer { r.setValue("Bearer \(bearer)", forHTTPHeaderField: "authorization") }
        return r
    }

    static func object(_ d: Data) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
    }

    /// Ask the play gate. `sid` is the play attempt's session id, so the gate's decision,
    /// the beacons and the CDN logs join on one id. Apple players play HLS Interstitials
    /// natively, so guided ads are offered.
    public func resolve(assetId: String, viewerToken: String? = nil, sid: String? = nil,
                        adDelivery: String = "auto", caps: [String] = ["hls-interstitials"]) async throws -> ResolvedItem {
        var body: [String: Any] = ["appKey": appKey, "assetId": assetId, "adDelivery": adDelivery, "caps": caps]
        if let sid { body["sid"] = sid }
        let (data, status) = try await transport.send(request(url("api/availability"), method: "POST", json: body, bearer: viewerToken))
        let j = Self.object(data)
        if !(200..<300).contains(status) || (j["available"] as? Bool) == false {
            let mode = j["mode"] as? String
            let products = (j["products"] as? [[String: Any]] ?? []).compactMap(Self.product)
            throw GateError(status: status, message: Gate.message(status: status, mode: mode), mode: mode, products: products)
        }
        let d = j["delivery"] as? [String: Any]
        let m = j["meta"] as? [String: Any] ?? [:]
        var ads: ItemAds?
        if let a = j["ads"] as? [String: Any], let del = (a["delivery"] as? String).flatMap(ItemAds.Delivery.init(rawValue:)) {
            ads = ItemAds(delivery: del, sessionId: a["sessionId"] as? String, timelineUrl: a["timelineUrl"] as? String)
        }
        return ResolvedItem(
            source: d.map { Source(hls: $0["hls"] as? String, dash: $0["dash"] as? String, mp3: $0["mp3"] as? String) },
            token: j["playbackToken"] as? String,
            title: m["title"] as? String, description: m["description"] as? String, artworkUrl: m["artworkUrl"] as? String,
            durationMs: Schedule.num(m["durationMs"]), live: m["live"] as? Bool, kind: m["kind"] as? String,
            ads: ads, brandMark: (m["brandMark"] as? [String: Any]).flatMap(Self.brandMark))
    }

    static func product(_ x: [String: Any]) -> Product? {
        guard let key = x["productKey"] as? String else { return nil }
        return Product(productKey: key, name: x["name"] as? String,
                       kind: (x["kind"] as? String).flatMap(Product.Kind.init(rawValue:)) ?? .published_dates,
                       count: (x["count"] as? NSNumber)?.intValue, unit: (x["unit"] as? String).flatMap(Product.Unit.init(rawValue:)),
                       priceCents: (x["priceCents"] as? NSNumber)?.intValue ?? 0, currency: x["currency"] as? String ?? "USD")
    }

    static func brandMark(_ x: [String: Any]) -> BrandMark? {
        guard let u = x["url"] as? String else { return nil }
        func n(_ k: String, _ d: Double) -> Double { Schedule.num(x[k]) ?? d }
        return BrandMark(url: u, position: (x["position"] as? String).flatMap(BrandMark.Position.init(rawValue:)) ?? .tr,
                         offsetX: n("offsetX", 48), offsetY: n("offsetY", 48), opacity: n("opacity", 100), scale: n("scale", 8))
    }

    /// A channel's guide (GET /api/player/epg).
    public func schedule(channelId: String) async -> [Programme] {
        guard let (data, status) = try? await transport.send(request(url("api/player/epg", ["appKey": appKey, "channelId": channelId]))),
              (200..<300).contains(status) else { return [] }
        return Schedule.clean(Self.object(data)["programmes"])
    }

    /// An event's phase, times and promo (GET /api/player/event).
    public func event(id: String) async -> EventInfo? {
        guard let (data, status) = try? await transport.send(request(url("api/player/event", ["appKey": appKey, "eventId": id]))),
              (200..<300).contains(status) else { return nil }
        return Self.eventInfo(Self.object(data))
    }

    static func eventInfo(_ j: [String: Any]) -> EventInfo? {
        guard let id = j["id"] as? String, let title = j["title"] as? String else { return nil }
        var promo: EventPromo?
        if let p = j["promo"] as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: p) {
            promo = try? JSONDecoder().decode(EventPromo.self, from: data)
        }
        return EventInfo(id: id, title: title, description: j["description"] as? String,
                         startsAt: Schedule.num(j["startsAt"]), endsAt: Schedule.num(j["endsAt"]),
                         previousStartsAt: Schedule.num(j["previousStartsAt"]),
                         presentation: (j["presentation"] as? String).flatMap(Presentation.init(rawValue:)) ?? .offline,
                         preMessage: j["preMessage"] as? String, endedMessage: j["endedMessage"] as? String,
                         promo: promo, replayAssetId: j["replayAssetId"] as? String)
    }

    /// What a station is playing, the last five tracks and what is next (POST /api/player/now-playing).
    public func nowPlaying(stationId: String) async -> NowPlayingAnswer? {
        guard let (data, status) = try? await transport.send(request(url("api/player/now-playing"), method: "POST",
                                                                     json: ["appKey": appKey, "channelId": stationId])),
              (200..<300).contains(status) else { return nil }
        let j = Self.object(data)
        return NowPlayingAnswer(nowPlaying: Self.track(j), history: Array((j["history"] as? [[String: Any]] ?? []).compactMap(Self.track).prefix(5)),
                                next: (j["next"] as? [String: Any]).flatMap(Self.track), onAir: (j["onAir"] as? Bool) != false)
    }

    static func track(_ x: [String: Any]) -> TrackInfo? {
        guard let title = (x["title"] as? String) ?? (x["primary"] as? String), !title.isEmpty else { return nil }
        var listen: TrackInfo.Listen?
        if let l = x["listen"] as? [String: Any], let u = l["url"] as? String { listen = .init(service: l["service"] as? String ?? "Apple Music", url: u) }
        return TrackInfo(title: title, artist: (x["artist"] as? String) ?? (x["secondary"] as? String), album: x["album"] as? String,
                         year: (x["year"] as? NSNumber)?.intValue, artworkUrl: x["artworkUrl"] as? String,
                         startedAt: Schedule.num(x["startedAt"]) ?? Schedule.num(x["since"]), listen: listen)
    }

    /// A radio station's saved player setup (POST /api/player/session): its theme and sources.
    public func stationSession(stationId: String) async -> (theme: Theme, source: Source, name: String?, artworkUrl: String?)? {
        guard let (data, status) = try? await transport.send(request(url("api/player/session"), method: "POST",
                                                                     json: ["appKey": appKey, "channelId": stationId])),
              (200..<300).contains(status) else { return nil }
        let j = Self.object(data)
        let s = j["sources"] as? [String: Any] ?? [:]
        let st = j["station"] as? [String: Any] ?? [:]
        return (ThemeTokens.fromConfig(j["config"] as? [String: Any]),
                Source(hls: s["hls"] as? String, dash: s["dash"] as? String, mp3: s["mp3"] as? String),
                st["name"] as? String, st["artworkUrl"] as? String)
    }

    /// One viewer beacon (POST /api/analytics/beacon). Never throws: reporting never breaks playback.
    public func beacon(_ body: [String: Any]) async {
        _ = try? await transport.send(request(url("api/analytics/beacon"), method: "POST", json: body))
    }
}

/// Apply what the gate said onto the playlist item, without losing what the caller set.
public func mergeResolved(_ item: PlaylistItem, _ r: ResolvedItem) -> PlaylistItem {
    var out = item
    if !Schedule.hasSource(item.source) { out.source = r.source }
    out.playbackToken = r.token ?? item.playbackToken
    out.title = item.title ?? r.title
    out.description = item.description ?? r.description
    out.artworkUrl = item.artworkUrl ?? r.artworkUrl
    out.durationMs = item.durationMs ?? r.durationMs
    out.live = item.live ?? r.live
    out.ads = r.ads ?? item.ads
    out.brandMark = item.brandMark ?? r.brandMark
    return out
}

public enum VoltSDK {
    public static let version = "0.1.0"
}
