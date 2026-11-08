// ============================================================================
//  THE PLAYER'S ARITHMETIC: programmes, up next, start over, qualities,
//  playlists. A line-for-line port of volt-player/src/sdk/schedule.ts (and the
//  Swift Schedule). Pure, so every rule is unit tested against the same cases
//  as the web SDK's test/player-sdk.check.ts.
// ============================================================================
package com.volt.player.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import java.net.URI
import java.net.URLDecoder
import java.text.DateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToLong

object Schedule {
    /** The programme on air at an instant, or null in a gap. */
    fun programmeAt(list: List<Programme>, at: EpochMs): Programme? = list.firstOrNull { it.startsAt <= at && at < it.endsAt }

    /** The first programme starting at or after an instant. */
    fun programmeAfter(list: List<Programme>, at: EpochMs): Programme? =
        list.filter { it.startsAt >= at }.minByOrNull { it.startsAt }

    /**
     * Sorted, de-duplicated, and only what is valid. Arrives from a feed; trust nothing.
     * Takes a JSON array of objects, or a list of maps (tests and hosts).
     */
    fun clean(list: Any?): List<Programme> {
        val rows: List<Map<String, Any?>> = when (list) {
            is JsonArray -> list.mapNotNull { (it as? JsonObject)?.let(::plain) }
            is List<*> -> list.mapNotNull { r -> (r as? Map<*, *>)?.entries?.associate { (k, v) -> k.toString() to v } }
            else -> return emptyList()
        }
        val out = mutableListOf<Programme>()
        val seen = HashSet<String>()
        for (x in rows) {
            val title = x["title"] as? String ?: continue
            val s = num(x["startsAt"]) ?: continue
            val e = num(x["endsAt"]) ?: continue
            if (e <= s) continue
            val id = x["id"]?.let { idString(it) } ?: s.toLong().toString()
            if (!seen.add(id)) continue
            out += Programme(id = id, title = title, subtitle = x["subtitle"] as? String, description = x["description"] as? String,
                imageUrl = x["imageUrl"] as? String, startsAt = s, endsAt = e)
        }
        return out.sortedBy { it.startsAt }
    }

    private fun idString(v: Any): String = when (v) {
        is Double -> if (v == Math.floor(v) && v.isFinite()) v.toLong().toString() else v.toString()
        is Float -> idString(v.toDouble())
        else -> v.toString()
    }

    /** A JSON object as plain Kotlin values (String, Double, Boolean, Map, List, null). */
    fun plain(o: JsonObject): Map<String, Any?> = o.mapValues { (_, v) -> plainValue(v) }

    fun plainValue(v: kotlinx.serialization.json.JsonElement): Any? = when (v) {
        is JsonObject -> plain(v)
        is JsonArray -> v.map(::plainValue)
        is JsonPrimitive -> when {
            v.isString -> v.content
            v.content == "null" -> null
            v.content == "true" -> true
            v.content == "false" -> false
            else -> v.doubleOrNull
        }
    }

    fun num(v: Any?): Double? = when (v) {
        is Number -> v.toDouble().takeIf { it.isFinite() }
        is String -> v.toDoubleOrNull()?.takeIf { it.isFinite() }
        is JsonPrimitive -> (v.doubleOrNull ?: v.content.toDoubleOrNull())?.takeIf { it.isFinite() }
        else -> null
    }

    data class UpNextInput(
        val hasNextItem: Boolean,
        val nextItem: PlaylistItem?,
        val currentTime: Double,
        val duration: Double,
        val live: Boolean,
        val programme: Programme?,
        val nextProgramme: Programme?,
        /** What time it is AT THE PLAYHEAD (a viewer 30 s behind live sees the change 30 s later). */
        val playheadClock: EpochMs?,
        val seconds: Double,
        val autoAdvance: Boolean,
        val dismissed: Boolean,
    )

    /**
     * Should the up-next card show, and with what? On demand: the last `seconds` of an item
     * with a next one. Live: the last `seconds` of a programme when the guide knows the next.
     */
    fun upNext(i: UpNextInput): UpNext? {
        if (i.dismissed) return null
        val windowMs = max(5.0, i.seconds) * 1000
        if (!i.live && i.hasNextItem && i.duration.isFinite() && i.duration > 0) {
            val left = (i.duration - i.currentTime) * 1000
            if (i.duration * 1000 < windowMs * 2) return null
            if (left > 0 && left <= windowMs) {
                val n = i.nextItem
                return UpNext(kind = UpNext.Kind.Item, title = n?.title ?: "Next", subtitle = n?.subtitle, artworkUrl = n?.artworkUrl,
                    inMs = max(0.0, roundHalfAway(left)), autoAdvance = i.autoAdvance, totalMs = windowMs, source = UpNext.From.Playlist)
            }
            return null
        }
        val p = i.programme; val n = i.nextProgramme; val clock = i.playheadClock
        if (i.live && p != null && n != null && clock != null) {
            val left = p.endsAt - clock
            if (n.startsAt - p.endsAt > 5 * 60_000) return null
            if (left > 0 && left <= windowMs) {
                return UpNext(kind = UpNext.Kind.Programme, title = n.title, subtitle = n.subtitle, artworkUrl = n.imageUrl,
                    inMs = roundHalfAway(left), autoAdvance = false, totalMs = windowMs, startsAt = n.startsAt, source = UpNext.From.Guide)
            }
        }
        return null
    }

    /** Swift's rounded(): to nearest, halves away from zero. */
    fun roundHalfAway(v: Double): Double = if (v >= 0) Math.floor(v + 0.5) else -Math.floor(-v + 0.5)

    data class StartOver(val seconds: Double, val clippedMs: Double)

    /**
     * Where to seek to start the current programme from the beginning. `presentationStart` is
     * the wall clock of media time 0. When the start is older than the DVR window, the oldest
     * point available, with `clippedMs` saying how much of the beginning is missing.
     */
    fun startOverTarget(programmeStart: EpochMs, presentationStart: EpochMs?, seekable: SeekWindow?): StartOver? {
        if (presentationStart == null || seekable == null || !programmeStart.isFinite()) return null
        val t = (programmeStart - presentationStart) / 1000
        if (t > seekable.end) return null
        val floor = seekable.start + 1
        if (t >= floor) return StartOver(t, 0.0)
        return StartOver(floor, roundHalfAway((floor - t) * 1000))
    }

    /** Start over is offered only when the window reaches back to the programme start. */
    fun canStartOver(programme: Programme?, presentationStart: EpochMs?, seekable: SeekWindow?, live: Boolean): Boolean {
        if (!live || programme == null) return false
        val r = startOverTarget(programme.startsAt, presentationStart, seekable) ?: return false
        return r.clippedMs == 0.0
    }

    data class VariantInput(val id: String, val height: Int?, val width: Int?, val bandwidth: Double)

    /**
     * The quality menu: ONE ENTRY PER PICTURE SIZE (the highest bitrate kept),
     * or by bitrate for an audio-only ladder.
     */
    fun qualityList(tracks: List<VariantInput>): List<Quality> {
        val video = tracks.filter { (it.height ?: 0) > 0 }
        if (video.isEmpty()) {
            val byRate = LinkedHashMap<Long, Quality>()
            for (t in tracks) {
                val kbps = roundHalfAway(t.bandwidth / 1000).toLong()
                if (kbps !in byRate) byRate[kbps] = Quality(t.id, null, null, t.bandwidth, "$kbps kbps")
            }
            return byRate.values.sortedByDescending { it.bitrate }
        }
        val byHeight = LinkedHashMap<Int, Quality>()
        for (t in video) {
            val h = t.height!!
            val cur = byHeight[h]
            if (cur != null && t.bandwidth <= cur.bitrate) continue
            byHeight[h] = Quality(t.id, h, t.width, t.bandwidth, qualityLabel(h))
        }
        return byHeight.values.sortedByDescending { it.height ?: 0 }
    }

    fun qualityLabel(h: Int): String = when {
        h >= 2100 -> "4K"
        h >= 1400 -> "1440p"
        else -> "${h}p"
    }

    enum class SourceKind { Hls, Dash, Mp3, Mp4 }

    fun sourceKind(url: String): SourceKind {
        val p = url.substringBefore('?').lowercase()
        return when {
            p.endsWith(".m3u8") || p.endsWith(".m3u") -> SourceKind.Hls
            p.endsWith(".mpd") -> SourceKind.Dash
            p.endsWith(".mp3") || p.endsWith(".aac") || p.endsWith(".m4a") -> SourceKind.Mp3
            else -> SourceKind.Mp4
        }
    }

    fun isUUID(s: String): Boolean {
        val parts = s.split("-")
        return parts.map { it.length } == listOf(8, 4, 4, 4, 12) && parts.all { p -> p.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' } }
    }

    /** A playlist entry: an item, an asset id or a URL. */
    sealed interface Entry {
        data class Item(val item: PlaylistItem) : Entry
        data class Str(val value: String) : Entry
    }

    /** A playlist from whatever was passed: items, asset ids, or URLs. */
    fun normalize(entries: List<Entry>): List<PlaylistItem> {
        val out = mutableListOf<PlaylistItem>()
        entries.forEachIndexed { i, e ->
            when (e) {
                is Entry.Str -> {
                    val s = e.value.trim()
                    if (s.isEmpty()) return@forEachIndexed
                    out += if (isUUID(s)) PlaylistItem(id = s, assetId = s)
                    else PlaylistItem(id = "url-$i", title = titleFromUrl(s), source = Source(url = s))
                }
                is Entry.Item -> if (e.item.assetId != null || hasSource(e.item.source) || e.item.title != null) out += e.item
            }
        }
        return out
    }

    fun hasSource(s: Source?): Boolean = s != null && listOf(s.hls, s.dash, s.mp3, s.url).any { !it.isNullOrEmpty() }

    fun titleFromUrl(u: String): String {
        val path = try { URI("https://x").resolve(URI(u.replace(" ", "%20"))).rawPath ?: return u } catch (_: Exception) { return u }
        val parts = path.split("/").filter { it.isNotEmpty() }
        val last = parts.lastOrNull() ?: return u
        val lower = last.lowercase()
        val generic = listOf("master.", "index.", "manifest.", "playlist.").any { lower.startsWith(it) }
        val name = if (parts.size > 1 && generic) parts[parts.size - 2] else last
        val decoded = try { URLDecoder.decode(name.replace("+", "%2B"), "UTF-8") } catch (_: Exception) { name }
        val dot = decoded.lastIndexOf('.')
        if (dot > 0 && decoded.substring(dot + 1).all { it.isLetterOrDigit() }) return decoded.substring(0, dot)
        return decoded
    }

    /** "12:04", or "1:02:04" past an hour. */
    fun fmtTime(sec: Double): String {
        val v = if (sec.isFinite() && sec >= 0) sec.toLong() else 0L
        val s = v % 60; val m = (v / 60) % 60; val h = v / 3600
        val mm = if (h > 0) "%02d".format(m) else m.toString()
        return (if (h > 0) "$h:" else "") + mm + ":" + "%02d".format(s)
    }

    /** "12 s", "3 min" (without "in"). */
    fun fmtIn(ms: Double): String {
        val s = ceil(ms / 1000).toLong()
        return if (s < 60) "$s s" else "${ceil(s / 60.0).toLong()} min"
    }

    /** A wall-clock time in the viewer's own locale. */
    fun fmtClock(ms: EpochMs, locale: Locale = Locale.getDefault(), timeZone: TimeZone = TimeZone.getDefault()): String {
        if (!ms.isFinite()) return ""
        val f = DateFormat.getTimeInstance(DateFormat.SHORT, locale)
        f.timeZone = timeZone
        return f.format(Date(ms.roundToLong()))
    }
}
