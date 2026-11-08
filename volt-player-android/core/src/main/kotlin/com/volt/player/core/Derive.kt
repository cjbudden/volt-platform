// ============================================================================
//  DERIVE: from what the engine reports to what a skin shows.
//
//  The same rules as derive() in volt-player/src/sdk/player.ts (and the Swift
//  Derive), as a pure function, so the Android engine stays thin and every
//  rule is tested:
//
//    * the wall clock at the playhead: the stream's PROGRAM-DATE-TIME when it
//      has one, else now minus the distance behind live
//    * the programme on air: the fetched guide, else the stream's own
//      programme marker (no app key needed for now / next)
//    * up next: the stream's own trigger wins over one worked out from the
//      guide, and nothing is offered during an ad break
//    * skip intro / recap / credits: on demand only, gone in the last half
//      second so a button never offers to skip what has just ended
// ============================================================================
package com.volt.player.core

import kotlin.math.max

/** What the engine knows at this instant. */
data class EngineSnapshot(
    val currentTime: Double,
    val duration: Double,
    val live: Boolean,
    val seekable: SeekWindow?,
    /** Wall clock of media time 0 (epoch ms), from PROGRAM-DATE-TIME. */
    val presentationStart: EpochMs?,
)

data class DeriveInput(
    val engine: EngineSnapshot,
    val now: EpochMs,
    val schedule: List<Programme>,
    val graphics: List<StreamGraphic>,
    val graphicsOn: Boolean,
    val upNextOn: Boolean,
    val skipOn: Boolean,
    val upNextSeconds: Double,
    val autoAdvance: Boolean,
    val items: List<PlaylistItem>,
    val index: Int,
    /** "g:<id>", "p:<id>" or "i:<index>": the up-next card the viewer dismissed. */
    val dismissed: String?,
)

data class Derived(
    val behindLive: Double,
    val atLiveEdge: Boolean,
    val dvr: Boolean,
    val wallClock: EpochMs?,
    val programme: Programme?,
    val nextProgramme: Programme?,
    val canStartOver: Boolean,
    val graphics: List<StreamGraphic>,
    val adBreak: AdBreakState?,
    val upNext: UpNext?,
    val skip: SkipOffer?,
    /** The key to store when the viewer dismisses the card on screen. */
    val dismissKey: String?,
)

object Derive {
    /** A DVR window shorter than this is not worth a scrubber on live. */
    const val DVR_MIN_SECONDS = 60.0
    /** Within this of the live edge counts as live. */
    const val LIVE_EDGE_SECONDS = 8.0

    fun run(i: DeriveInput): Derived {
        val e = i.engine
        val t = e.currentTime
        val behind = if (e.live && e.seekable != null) max(0.0, e.seekable.end - t) else 0.0
        val wall: EpochMs? = e.presentationStart?.let { it + t * 1000 } ?: if (e.live) i.now - behind * 1000 else null
        val adBreakG = Triggers.adBreakAt(i.graphics, t)
        val active = Triggers.activeAt(i.graphics, t)
        val shown = if (!i.graphicsOn) emptyList() else (adBreakG?.let { listOf(it) } ?: active)

        val sched = i.schedule
        val inband = if (sched.isEmpty() && e.presentationStart != null) active.firstOrNull { it.graphic == "programme" } else null
        var programme: Programme? = null
        if (sched.isNotEmpty()) programme = Schedule.programmeAt(sched, wall ?: i.now)
        else if (inband != null && e.presentationStart != null) programme = Triggers.programme(inband, e.presentationStart)

        val guideNext = if (sched.isEmpty()) null else Schedule.programmeAfter(sched, programme?.let { it.endsAt - 1 } ?: (wall ?: i.now))
        var nextProgramme = guideNext
        if (sched.isEmpty() && inband != null && e.presentationStart != null) {
            val later = i.graphics.filter { it.graphic == "programme" && it.start > inband.start }.minByOrNull { it.start }
            if (later != null) nextProgramme = Triggers.programme(later, e.presentationStart)
            else {
                val nt = inband.data["next_title"]
                if (!nt.isNullOrEmpty()) {
                    val ns = inband.data["next_start"]?.let(Triggers::parseISO)
                    nextProgramme = Programme(id = inband.data["next_id"]?.takeIf { it.isNotEmpty() } ?: "next:${inband.id}", title = nt,
                        subtitle = inband.data["next_subtitle"], imageUrl = inband.data["next_image"],
                        startsAt = ns ?: programme?.endsAt ?: i.now, endsAt = Double.POSITIVE_INFINITY)
                }
            }
        }

        val dismissKey = programme?.let { "p:${it.id}" } ?: "i:${i.index}"
        val upG = shown.firstOrNull { it.graphic == "up-next" }
        var upNext: UpNext? = null
        var cardKey: String? = null
        if (adBreakG == null && i.upNextOn) {
            if (upG != null && i.dismissed != "g:${upG.id}") {
                upNext = Triggers.upNext(upG, t, wall); cardKey = "g:${upG.id}"
            } else if (upG == null || i.dismissed == "g:${upG.id}") {
                val hasNext = i.index + 1 < i.items.size
                upNext = Schedule.upNext(Schedule.UpNextInput(
                    hasNextItem = hasNext, nextItem = if (hasNext) i.items[i.index + 1] else null,
                    currentTime = t, duration = e.duration, live = e.live, programme = programme, nextProgramme = guideNext,
                    playheadClock = wall, seconds = i.upNextSeconds, autoAdvance = i.autoAdvance, dismissed = i.dismissed == dismissKey))
                if (upNext != null) cardKey = dismissKey
            }
        }

        var skip: SkipOffer? = null
        if (!e.live && i.skipOn) {
            for (g in i.graphics) {
                if (!g.graphic.startsWith("skip-")) continue
                val end = g.end ?: continue
                if (t >= g.start && t < end - 0.5) {
                    skip = SkipOffer(kind = g.data["kind"]?.takeIf { it.isNotEmpty() } ?: g.graphic.drop(5), from = g.start, to = end, id = g.id)
                    break
                }
            }
        }

        val dvr = e.live && (e.seekable?.let { it.end - it.start >= DVR_MIN_SECONDS } ?: false)
        return Derived(
            behindLive = behind, atLiveEdge = !e.live || behind <= LIVE_EDGE_SECONDS, dvr = dvr, wallClock = wall,
            programme = programme, nextProgramme = nextProgramme,
            canStartOver = Schedule.canStartOver(programme, e.presentationStart, e.seekable, e.live),
            graphics = shown,
            adBreak = adBreakG?.let { g ->
                AdBreakState(id = g.data["break"]?.takeIf { it.isNotEmpty() } ?: g.id,
                    endsAt = g.end?.let { end -> e.presentationStart?.let { it + end * 1000 } })
            },
            upNext = upNext, skip = skip, dismissKey = cardKey,
        )
    }
}
