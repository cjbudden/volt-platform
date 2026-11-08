// ============================================================================
//  TALKING TO THE CONTROL PLANE: asset ids, the guide, events, now playing,
//  beacons. A port of volt-player/src/sdk/resolver.ts (and the Swift VoltAPI).
//
//  Every call carries the PUBLISHABLE app key and nothing secret. Register the
//  app in Volt as type "Android" and use that app's key, not a web key: a web
//  key is tied to website origins, and an app sends none.
//
//  The play gate (POST /api/availability) decides per asset and per viewer,
//  and answers with the URLs to play and a short-lived playback token. Items
//  are resolved when they come up, so a long playlist never plays on an
//  expired token.
// ============================================================================
package com.volt.player.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale

/** One HTTP request the SDK makes. */
data class HttpRequest(val url: String, val method: String = "GET", val headers: Map<String, String> = emptyMap(), val body: String? = null)

/** The HTTP the SDK needs. Injected so tests run without a network. */
fun interface HttpTransport {
    /** The response body and status code. Throws only when there was no response at all. */
    suspend fun send(request: HttpRequest): Pair<String, Int>
}

/** HttpURLConnection, with no cookies: the player is anonymous unless given a viewer token. */
class UrlConnectionTransport(private val timeoutMs: Int = 15_000) : HttpTransport {
    override suspend fun send(request: HttpRequest): Pair<String, Int> = withContext(Dispatchers.IO) {
        val c = URL(request.url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = request.method
            c.connectTimeout = timeoutMs; c.readTimeout = timeoutMs
            c.useCaches = false
            c.instanceFollowRedirects = true
            for ((k, v) in request.headers) c.setRequestProperty(k, v)
            if (request.body != null) {
                c.doOutput = true
                c.outputStream.use { it.write(request.body.toByteArray(Charsets.UTF_8)) }
            }
            val status = c.responseCode
            val stream = if (status in 200..399) c.inputStream else c.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            text to status
        } finally { c.disconnect() }
    }
}

/** The gate said no: why, in words a viewer can read, and what would let them in. */
class GateError(val status: Int, override val message: String, val mode: String?, val products: List<Product>) : Exception(message)

object Gate {
    /** What a viewer is told when the gate says no. Same words as the web SDK. */
    fun message(status: Int, mode: String?): String = when {
        mode == "paywall" || status == 402 -> "This needs a subscription or purchase."
        mode == "sign_in" -> "Sign in to watch this."
        status == 451 -> "This is not available in your region."
        status == 403 -> "This player is not allowed here."
        status == 404 -> "This could not be found."
        status == 401 -> "This player key is not valid."
        else -> "This is not available right now."
    }

    /** Fill a purchase / sign-in URL template. Values are URL-encoded (spaces as %20). */
    fun fillUrl(tpl: String, vars: Map<String, String?>): String {
        val out = StringBuilder()
        var i = 0
        while (i < tpl.length) {
            if (tpl[i] == '{') {
                val close = tpl.indexOf('}', i)
                if (close > i + 1) {
                    val k = tpl.substring(i + 1, close)
                    if (k.all { it.isLetterOrDigit() || it == '_' }) {
                        out.append(encode(vars[k] ?: "")); i = close + 1; continue
                    }
                }
            }
            out.append(tpl[i]); i++
        }
        return out.toString()
    }

    /** encodeURIComponent: letters, digits and -_.!~*'() stay as they are. */
    fun encode(v: String): String = URLEncoder.encode(v, "UTF-8").replace("+", "%20")
        .replace("%21", "!").replace("%27", "'").replace("%28", "(").replace("%29", ")").replace("%7E", "~")

    /** "A$4.99", in the viewer's own locale. */
    fun fmtPrice(cents: Int, currency: String, locale: Locale = Locale.getDefault()): String = try {
        val f = NumberFormat.getCurrencyInstance(locale)
        f.currency = Currency.getInstance(currency)
        f.format(cents / 100.0)
    } catch (_: Exception) { "%.2f %s".format(cents / 100.0, currency) }

    /** "24 hours", "1 month", or "This event" for the item's own dates. */
    fun fmtTerm(p: Product): String {
        val n = p.count; val u = p.unit
        if (p.kind != Product.Kind.Period || n == null || n <= 0 || u == null) return "This event"
        if (u == Product.Unit.Day && n == 1) return "24 hours"
        return "$n ${u.wire}${if (n == 1) "" else "s"}"
    }
}

/** What the gate answered for one asset. */
data class ResolvedItem(
    val source: Source? = null,
    val token: String? = null,
    val title: String? = null,
    val description: String? = null,
    val artworkUrl: String? = null,
    val durationMs: Double? = null,
    val live: Boolean? = null,
    val kind: String? = null,
    val ads: ItemAds? = null,
    val brandMark: BrandMark? = null,
)

data class NowPlayingAnswer(val nowPlaying: TrackInfo?, val history: List<TrackInfo>, val next: TrackInfo?, val onAir: Boolean)

data class StationSession(val theme: Theme, val source: Source, val name: String?, val artworkUrl: String?)

object VoltSdk {
    const val VERSION = "0.1.0"
}

class VoltApi(
    val base: String,
    val appKey: String,
    private val transport: HttpTransport = UrlConnectionTransport(),
    platform: String = "android",
    packageName: String? = null,
    appVersion: String? = null,
) {
    /** Sent on every call, so the app is known in reports and the gate can tell an app from a page. */
    private val clientHeaders: Map<String, String> = buildMap {
        put("x-volt-sdk", "android/${VoltSdk.VERSION}")
        put("x-volt-platform", platform)
        if (packageName != null) put("x-volt-bundle-id", packageName)
        if (appVersion != null) put("x-volt-app-version", appVersion)
    }

    private val json = Json { ignoreUnknownKeys = true }

    internal fun url(path: String, query: Map<String, String> = emptyMap()): String {
        val b = base.trimEnd('/') + "/" + path.trimStart('/')
        if (query.isEmpty()) return b
        return b + "?" + query.toSortedMap().entries.joinToString("&") { (k, v) -> "${Gate.encode(k)}=${Gate.encode(v)}" }
    }

    private fun request(u: String, method: String = "GET", body: JsonObject? = null, bearer: String? = null): HttpRequest {
        val h = clientHeaders.toMutableMap()
        if (body != null) h["content-type"] = "application/json"
        if (bearer != null) h["authorization"] = "Bearer $bearer"
        return HttpRequest(u, method, h, body?.let { sortedJson(it) })
    }

    /** JSON with sorted keys, so requests are stable (and testable). */
    private fun sortedJson(o: JsonObject): String = json.encodeToString(JsonObject.serializer(), JsonObject(o.toSortedMap()))

    private fun obj(text: String): JsonObject = try { json.parseToJsonElement(text) as? JsonObject ?: JsonObject(emptyMap()) } catch (_: Exception) { JsonObject(emptyMap()) }

    /**
     * Ask the play gate. `sid` is the play attempt's session id, so the gate's decision, the
     * beacons and the CDN logs join on one id. `caps` says what this player can do: Media3
     * in this release plays guided (HLS Interstitials) ads only when the app adds the
     * interstitials loader, so none are claimed by default and the gate stitches instead.
     */
    suspend fun resolve(assetId: String, viewerToken: String? = null, sid: String? = null,
                        adDelivery: String = "auto", caps: List<String> = emptyList()): ResolvedItem {
        val body = buildMap<String, JsonElement> {
            put("appKey", JsonPrimitive(appKey)); put("assetId", JsonPrimitive(assetId)); put("adDelivery", JsonPrimitive(adDelivery))
            put("caps", JsonArray(caps.map(::JsonPrimitive)))
            if (sid != null) put("sid", JsonPrimitive(sid))
        }
        val (text, status) = transport.send(request(url("api/availability"), "POST", JsonObject(body), viewerToken))
        val j = obj(text)
        if (status !in 200..299 || j.bool("available") == false) {
            val mode = j.str("mode")
            val products = (j["products"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.let(::product) }
            throw GateError(status, Gate.message(status, mode), mode, products)
        }
        val d = j["delivery"] as? JsonObject
        val m = j["meta"] as? JsonObject ?: JsonObject(emptyMap())
        val ads = (j["ads"] as? JsonObject)?.let { a -> ItemAds.Delivery.of(a.str("delivery"))?.let { ItemAds(it, a.str("sessionId"), a.str("timelineUrl")) } }
        return ResolvedItem(
            source = d?.let { Source(hls = it.str("hls"), dash = it.str("dash"), mp3 = it.str("mp3")) },
            token = j.str("playbackToken"),
            title = m.str("title"), description = m.str("description"), artworkUrl = m.str("artworkUrl"),
            durationMs = Schedule.num(m["durationMs"]), live = m.bool("live"), kind = m.str("kind"),
            ads = ads, brandMark = (m["brandMark"] as? JsonObject)?.let(::brandMark),
        )
    }

    internal fun product(x: JsonObject): Product? {
        val key = x.str("productKey") ?: return null
        return Product(productKey = key, name = x.str("name"), kind = Product.Kind.of(x.str("kind")) ?: Product.Kind.PublishedDates,
            count = x.int("count"), unit = Product.Unit.of(x.str("unit")), priceCents = x.int("priceCents") ?: 0,
            currency = x.str("currency") ?: "USD")
    }

    internal fun brandMark(x: JsonObject): BrandMark? {
        val u = x.str("url") ?: return null
        fun n(k: String, d: Double) = Schedule.num(x[k]) ?: d
        return BrandMark(url = u, position = x.str("position")?.let { p -> BrandMark.Position.entries.firstOrNull { it.name == p } } ?: BrandMark.Position.tr,
            offsetX = n("offsetX", 48.0), offsetY = n("offsetY", 48.0), opacity = n("opacity", 100.0), scale = n("scale", 8.0))
    }

    /** A channel's guide (GET /api/player/epg). */
    suspend fun schedule(channelId: String): List<Programme> {
        val (text, status) = try { transport.send(request(url("api/player/epg", mapOf("appKey" to appKey, "channelId" to channelId)))) } catch (_: Exception) { return emptyList() }
        if (status !in 200..299) return emptyList()
        return Schedule.clean(obj(text)["programmes"])
    }

    /** An event's phase, times and promo (GET /api/player/event). */
    suspend fun event(id: String): EventInfo? {
        val (text, status) = try { transport.send(request(url("api/player/event", mapOf("appKey" to appKey, "eventId" to id)))) } catch (_: Exception) { return null }
        if (status !in 200..299) return null
        return eventInfo(obj(text))
    }

    internal fun eventInfo(j: JsonObject): EventInfo? {
        val id = j.str("id") ?: return null
        val title = j.str("title") ?: return null
        val promo = (j["promo"] as? JsonObject)?.let { p ->
            EventPromo.Template.of(p.str("template"))?.let { tpl ->
                EventPromo(template = tpl, headline = p.str("headline"), subhead = p.str("subhead"), posterUrl = p.str("posterUrl"),
                    posterFit = p.str("posterFit"),
                    sides = (p["sides"] as? JsonArray)?.mapNotNull { s -> (s as? JsonObject)?.let { o -> o.str("name")?.let { PromoSide(it, o.str("imageUrl"), o.str("subtitle")) } } },
                    separator = p.str("separator"))
            }
        }
        return EventInfo(id = id, title = title, description = j.str("description"),
            startsAt = Schedule.num(j["startsAt"]), endsAt = Schedule.num(j["endsAt"]), previousStartsAt = Schedule.num(j["previousStartsAt"]),
            presentation = Presentation.of(j.str("presentation")) ?: Presentation.Offline,
            preMessage = j.str("preMessage"), endedMessage = j.str("endedMessage"), promo = promo, replayAssetId = j.str("replayAssetId"))
    }

    /** What a station is playing, the last five tracks and what is next (POST /api/player/now-playing). */
    suspend fun nowPlaying(stationId: String): NowPlayingAnswer? {
        val body = JsonObject(mapOf("appKey" to JsonPrimitive(appKey), "channelId" to JsonPrimitive(stationId)))
        val (text, status) = try { transport.send(request(url("api/player/now-playing"), "POST", body)) } catch (_: Exception) { return null }
        if (status !in 200..299) return null
        val j = obj(text)
        return NowPlayingAnswer(nowPlaying = track(j),
            history = (j["history"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.let(::track) }.take(5),
            next = (j["next"] as? JsonObject)?.let(::track), onAir = j.bool("onAir") != false)
    }

    internal fun track(x: JsonObject): TrackInfo? {
        val title = x.str("title") ?: x.str("primary") ?: return null
        if (title.isEmpty()) return null
        val listen = (x["listen"] as? JsonObject)?.let { l -> l.str("url")?.let { TrackInfo.Listen(l.str("service") ?: "Apple Music", it) } }
        return TrackInfo(title = title, artist = x.str("artist") ?: x.str("secondary"), album = x.str("album"), year = x.int("year"),
            artworkUrl = x.str("artworkUrl"), startedAt = Schedule.num(x["startedAt"]) ?: Schedule.num(x["since"]), listen = listen)
    }

    /** A radio station's saved player setup (POST /api/player/session): its theme and sources. */
    suspend fun stationSession(stationId: String): StationSession? {
        val body = JsonObject(mapOf("appKey" to JsonPrimitive(appKey), "channelId" to JsonPrimitive(stationId)))
        val (text, status) = try { transport.send(request(url("api/player/session"), "POST", body)) } catch (_: Exception) { return null }
        if (status !in 200..299) return null
        val j = obj(text)
        val s = j["sources"] as? JsonObject ?: JsonObject(emptyMap())
        val st = j["station"] as? JsonObject ?: JsonObject(emptyMap())
        return StationSession(ThemeTokens.fromConfig(j["config"] as? JsonObject), Source(hls = s.str("hls"), dash = s.str("dash"), mp3 = s.str("mp3")),
            st.str("name"), st.str("artworkUrl"))
    }

    /** One viewer beacon (POST /api/analytics/beacon). Never throws: reporting never breaks playback. */
    suspend fun beacon(body: Map<String, Any>) {
        val o = JsonObject(body.mapValues { (_, v) -> toJson(v) })
        try { transport.send(request(url("api/analytics/beacon"), "POST", o)) } catch (_: Exception) { }
    }

    private fun toJson(v: Any?): JsonElement = when (v) {
        null -> JsonNull
        is String -> JsonPrimitive(v)
        is Number -> JsonPrimitive(v)
        is Boolean -> JsonPrimitive(v)
        is Map<*, *> -> JsonObject(v.entries.associate { (k, x) -> k.toString() to toJson(x) })
        is List<*> -> JsonArray(v.map(::toJson))
        else -> JsonPrimitive(v.toString())
    }
}

internal fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
internal fun JsonObject.bool(k: String): Boolean? = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
internal fun JsonObject.int(k: String): Int? = (this[k] as? JsonPrimitive)?.let { it.intOrNull ?: Schedule.num(it)?.toInt() }

/** Apply what the gate said onto the playlist item, without losing what the caller set. */
fun mergeResolved(item: PlaylistItem, r: ResolvedItem): PlaylistItem = item.copy(
    source = if (!Schedule.hasSource(item.source)) r.source else item.source,
    playbackToken = r.token ?: item.playbackToken,
    title = item.title ?: r.title,
    description = item.description ?: r.description,
    artworkUrl = item.artworkUrl ?: r.artworkUrl,
    durationMs = item.durationMs ?: r.durationMs,
    live = item.live ?: r.live,
    ads = r.ads ?: item.ads,
    brandMark = item.brandMark ?: r.brandMark,
)
