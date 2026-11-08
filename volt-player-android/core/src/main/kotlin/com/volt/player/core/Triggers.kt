// ============================================================================
//  IN-STREAM TRIGGERS, player side. A port of volt-player/src/sdk/triggers.ts
//  (and the Swift Triggers).
//
//  The server writes them into the HLS playlists as
//      #EXT-X-DATERANGE:ID="...",CLASS="com.boomlabs.volt.<kind>",
//          START-DATE="...",DURATION=...,X-TITLE="...",X-NEXT-TITLE="..."
//  Media3 hands the media playlist's tags over as text (HlsMediaPlaylist.tags),
//  so the engine parses them here, with WALL-CLOCK start and end dates. The
//  contract's graphics are in MEDIA seconds (the clock of currentTime), so the
//  engine converts with the stream's presentation start:
//      media seconds = (wall clock ms - presentationStart ms) / 1000
//  which holds for a viewer behind live, one scrubbing the DVR, and VOD.
// ============================================================================
package com.volt.player.core

import kotlin.math.max

object Triggers {
    const val CLASS_PREFIX = "com.boomlabs.volt."

    /** One EXT-X-DATERANGE, with wall-clock times (epoch ms). */
    data class DateRange(
        val id: String,
        val cls: String,
        val startDate: EpochMs,
        val endDate: EpochMs?,
        /** X- attributes and the rest, keyed as written (X-NEXT-TITLE). */
        val attributes: Map<String, String>,
    )

    /** X-NEXT-TITLE -> next_title; TITLE -> title. One key style whatever the source. */
    fun key(k: String): String {
        var s = k
        if (s.lowercase().startsWith("lsdr/")) s = s.drop(5)
        if (s.uppercase().startsWith("X-")) s = s.drop(2)
        return s.lowercase().replace("-", "_")
    }

    private fun graphicOf(cls: String, data: Map<String, String>): String {
        data["graphic"]?.takeIf { it.isNotEmpty() }?.let { return it }
        if (cls.endsWith(".ad")) return "ad"
        if (cls.endsWith(".programme")) return "programme"
        val rest = cls.drop(CLASS_PREFIX.length)
        return rest.ifEmpty { "unknown" }
    }

    /** Date ranges to graphics on the media clock. Unknown classes are ignored. */
    fun graphics(ranges: List<DateRange>, presentationStart: EpochMs): List<StreamGraphic> = ranges.mapNotNull { r ->
        if (!r.cls.startsWith(CLASS_PREFIX)) return@mapNotNull null
        val data = HashMap<String, String>()
        // Only the X- attributes are the trigger's data (X-ID becomes "id"); ID, CLASS,
        // START-DATE and the rest describe the tag itself.
        for ((k, v) in r.attributes) {
            var raw = k
            if (raw.lowercase().startsWith("lsdr/")) raw = raw.drop(5)
            if (!raw.uppercase().startsWith("X-")) continue
            data[key(raw)] = v
        }
        val start = (r.startDate - presentationStart) / 1000
        val end = r.endDate?.let { (it - presentationStart) / 1000 }
        val id = data["id"]?.takeIf { it.isNotEmpty() } ?: r.id.ifEmpty { "${r.cls}@$start" }
        StreamGraphic(id = id, graphic = graphicOf(r.cls, data), start = start, end = end, data = data)
    }

    /** Every EXT-X-DATERANGE in a media playlist (or in a list of its tag lines). */
    fun parseDateRanges(playlist: String): List<DateRange> = parseDateRangeLines(playlist.lines())

    fun parseDateRangeLines(lines: List<String>): List<DateRange> {
        val out = mutableListOf<DateRange>()
        for (raw in lines) {
            val line = raw.trim()
            if (!line.startsWith("#EXT-X-DATERANGE:")) continue
            val attrs = parseAttributes(line.removePrefix("#EXT-X-DATERANGE:"))
            val start = attrs["START-DATE"]?.let(::parseISO) ?: continue
            val end = attrs["END-DATE"]?.let(::parseISO) ?: attrs["DURATION"]?.toDoubleOrNull()?.let { start + it * 1000 }
            out += DateRange(id = attrs["ID"] ?: "", cls = attrs["CLASS"] ?: "", startDate = start, endDate = end, attributes = attrs)
        }
        return out
    }

    /** HLS attribute list: KEY=value or KEY="quoted, with commas". */
    fun parseAttributes(s: String): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        var i = 0
        while (i < s.length) {
            val eq = s.indexOf('=', i)
            if (eq < 0) break
            val k = s.substring(i, eq).trim(',', ' ')
            var j = eq + 1
            val v: String
            if (j < s.length && s[j] == '"') {
                val from = j + 1
                val close = s.indexOf('"', from).let { if (it < 0) s.length else it }
                v = s.substring(from, close)
                j = if (close < s.length) close + 1 else close
            } else {
                val comma = s.indexOf(',', j).let { if (it < 0) s.length else it }
                v = s.substring(j, comma); j = comma
            }
            if (k.isNotEmpty()) out[k] = v
            i = if (j < s.length) j + 1 else j
        }
        return out
    }

    private val ISO = Regex("""^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$""")

    /**
     * ISO 8601 with or without fractional seconds, to epoch ms. Parsed by hand so it
     * works on every Android version without java.time.
     */
    fun parseISO(s: String): EpochMs? {
        val m = ISO.matchEntire(s.trim()) ?: return null
        val g = m.groupValues
        val y = g[1].toInt(); val mo = g[2].toInt(); val d = g[3].toInt()
        val h = g[4].toInt(); val mi = g[5].toInt(); val se = g[6].toInt()
        if (mo !in 1..12 || d !in 1..31 || h > 23 || mi > 59 || se > 60) return null
        val frac = if (g[7].isEmpty()) 0.0 else ("0" + g[7]).toDouble()
        val days = daysFromCivil(y, mo, d)
        var ms = ((days * 86_400L + h * 3600L + mi * 60L + se) * 1000L).toDouble() + Math.round(frac * 1000).toDouble()
        val z = g[8]
        if (z != "Z") {
            val sign = if (z[0] == '-') -1 else 1
            val digits = z.drop(1).replace(":", "")
            val off = digits.take(2).toInt() * 60 + digits.drop(2).toInt()
            ms -= sign * off * 60_000.0
        }
        return ms
    }

    /** Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm). */
    private fun daysFromCivil(y0: Int, m: Int, d: Int): Long {
        val y = if (m <= 2) y0 - 1 else y0
        val era = (if (y >= 0) y else y - 399) / 400
        val yoe = y - era * 400
        val doy = (153 * (if (m > 2) m - 3 else m + 9) + 2) / 5 + d - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097L + doe - 719_468L
    }

    /** Keep graphics by id; a later report of the same one replaces it. Forget what ended long ago. */
    fun merge(into: MutableMap<String, StreamGraphic>, list: List<StreamGraphic>, horizon: Double? = null) {
        for (g in list) into[g.id] = g
        if (horizon != null) into.entries.removeAll { it.value.end != null && it.value.end!! < horizon }
    }

    /** What is on screen at media time t. */
    fun activeAt(all: List<StreamGraphic>, t: Double): List<StreamGraphic> =
        all.filter { t >= it.start && (it.end == null || t < it.end) }.sortedBy { it.start }

    /**
     * The Up next card from an active up-next graphic. Counts down to the next programme's
     * start when the stream has a wall clock, else to the card's own end.
     */
    fun upNext(g: StreamGraphic, at: Double, wallClock: EpochMs?): UpNext {
        val starts = g.data["starts"]?.let(::parseISO)
        val inMs = if (starts != null && wallClock != null) max(0.0, starts - wallClock) else max(0.0, ((g.end ?: at) - at) * 1000)
        return UpNext(kind = UpNext.Kind.Programme, title = nonEmpty(g.data["title"]) ?: "Up next", subtitle = nonEmpty(g.data["subtitle"]),
            artworkUrl = nonEmpty(g.data["image"]), inMs = Schedule.roundHalfAway(inMs), autoAdvance = false,
            totalMs = Schedule.roundHalfAway(((g.end ?: (g.start + 12)) - g.start) * 1000),
            shownMs = max(0.0, Schedule.roundHalfAway((at - g.start) * 1000)), startsAt = starts, source = UpNext.From.Stream)
    }

    /** The ad break at media time t, if one is on and asks for graphics to be hidden. */
    fun adBreakAt(all: List<StreamGraphic>, t: Double): StreamGraphic? = all.firstOrNull { g ->
        g.graphic == "ad-break" && t >= g.start && (g.end == null || t < g.end) && (g.data["hide_graphics"] ?: "all") != "none"
    }

    private val programmeOwn = setOf("id", "title", "subtitle", "description", "image", "graphic", "kind")

    /** The programme's key metadata from its marker: everything but its own fields and next_*. */
    fun programmeMeta(d: Map<String, String>): Map<String, String> =
        d.filter { (k, v) -> k !in programmeOwn && !k.startsWith("next_") && v.isNotEmpty() }

    /** A programme marker as a Programme (instants from the presentation start). */
    fun programme(g: StreamGraphic, presentationStart: EpochMs): Programme = Programme(
        id = nonEmpty(g.data["id"]) ?: g.id, title = g.data["title"] ?: "", subtitle = g.data["subtitle"],
        description = g.data["description"], imageUrl = g.data["image"],
        startsAt = presentationStart + g.start * 1000,
        endsAt = g.end?.let { presentationStart + it * 1000 } ?: Double.POSITIVE_INFINITY, meta = programmeMeta(g.data),
    )

    internal fun nonEmpty(s: String?): String? = if (s.isNullOrEmpty()) null else s
}
