// ============================================================================
//  RESOLVING A LADDER, AND FITTING IT TO A SOURCE.
//
//  This answers one question: given a ladder group and a file, what rungs are
//  actually encoded? It is pure, so the same function answers it for the console
//  ("what would this folder do to a 720p file") and for the encode itself.
//
//  THE REQUIREMENT IS THAT A FILE ENCODE MATCH THE LIVE TRANSCODER. That is not
//  achieved by copying the live bitrates into a VOD ladder — that is correct on
//  the day it is written and wrong for the rest of the system's life, because
//  somebody re-tunes the live 720p rung and both encodes keep succeeding. It is
//  achieved by a ladder group that TRACKS a live output profile: it holds no
//  rungs of its own and reads them at encode time. See 0030_encode_profiles.sql.
//
//  THE RATE CONTROL IS NOT HERE AND MUST NOT BE. Preset, maxrate, bufsize, GOP
//  and sc_threshold are the contract that makes ABR switching work, they are the
//  same for live and for file, and they live in exactly one place:
//  volt-encoder/bin/encoder.py video_rung_args(). This module decides WHICH
//  rungs; that one decides HOW each is encoded.
//
//  ---------------------------------------------------------------------------
//  NEVER UPSCALE, AND THE THREE WAYS THAT GOES WRONG
//
//  A 720p source against a 1080p rung costs a full rung of bitrate and storage
//  to carry no extra detail, so rungs above the source are dropped. Three cases
//  make that harder than it sounds:
//
//  1. A SOURCE WHOSE HEIGHT WE DO NOT KNOW. A probe can fail, and a file can be
//     audio-only. `null` height means NOT MEASURED, and it must never be read as
//     zero: zero drops every rung and produces an asset with no renditions, and
//     the log would say the source was too small rather than that nothing was
//     measured. Unknown means encode the full ladder and say so.
//
//  2. A SOURCE BELOW EVERY RUNG. A 240p file against 1080/720/480/360 drops all
//     four, and "no rungs" is not an encode, it is a silent failure that looks
//     like a completed job. The lowest rung is kept and ADAPTED to the source's
//     own height, which is the only outcome that is both playable and not an
//     upscale. It is recorded as an adaptation, not as a match.
//
//  3. FRAME RATE. A 25fps source encoded at 50 duplicates every frame: full
//     bitrate, no extra motion. Capped for the same reason and recorded the
//     same way.
//
//  WHAT WAS DROPPED IS PART OF THE RESULT, not a log line. An asset with three
//  renditions sitting beside one with four is a question somebody will ask, and
//  the answer has to be on the asset rather than in a log that has rotated.
// ============================================================================

export interface Rung {
  height: number;
  bitrate_kbps: number;
  /** null means "the ladder's frame rate". */
  fps?: number | null;
}

export type LadderOrigin =
  | { kind: 'tracked'; outputProfileId: string; profileName?: string | null }
  | { kind: 'members' };

export interface LadderGroupRow {
  id: string;
  name: string;
  tracks_output_profile_id: string | null;
  segment_dur: number | string;
  fps: number | string;
  packaging: 'hls' | 'dash' | 'both';
  codec_backend: 'x264' | 'nvenc';
  cap_to_source: boolean;
}

export interface ResolvedLadder {
  groupId: string;
  groupName: string;
  rungs: Rung[];
  segmentSeconds: number;
  fps: number;
  packaging: 'hls' | 'dash' | 'both';
  codecBackend: 'x264' | 'nvenc';
  capToSource: boolean;
  origin: LadderOrigin;
}

/** What a probe told us. Every field may be absent, and absent is not zero. */
export interface SourceProbe {
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  durationMs?: number | null;
  hasVideo?: boolean;
  hasAudio?: boolean;
}

export type DropReason =
  | 'above_source_height'
  | 'duplicate_height';

export interface DroppedRung extends Rung {
  why: DropReason;
  /** The measurement the decision was made from, so it can be argued with. */
  sourceHeight?: number | null;
}

export interface FittedLadder {
  kept: Rung[];
  dropped: DroppedRung[];
  /** The ladder's frame rate after capping to the source. */
  fps: number;
  /** Set when the lowest rung was re-pointed at the source's own height. */
  adapted: { from: number; to: number; reason: 'source_below_every_rung' } | null;
  /** True when nothing could be measured, so nothing was capped. Distinct from
   *  "measured and everything fitted", which is why it is a separate field. */
  sourceUnmeasured: boolean;
  notes: string[];
}

/**
 * The rungs a ladder group means.
 *
 * A tracking group's rungs come from the live profile it tracks, which is what
 * makes "the same as live" true rather than asserted. A group with members owns
 * its own, and the caller supplies them already ordered.
 */
export function resolveLadder(
  group: LadderGroupRow,
  opts: {
    /** The tracked live profile's rungs, when the group tracks one. */
    trackedRungs?: Rung[] | null;
    trackedProfileName?: string | null;
    /** The group's own members, when it does not track. */
    memberRungs?: Rung[] | null;
    /** Segment length and fps of the tracked profile, which win when tracking:
     *  the GOP has to match the live one or the boundaries do not line up. */
    trackedSegmentDur?: number | null;
    trackedFps?: number | null;
  }
): ResolvedLadder {
  const tracking = !!group.tracks_output_profile_id;

  // A TRACKING GROUP WITH NO RESOLVABLE PROFILE IS AN ERROR, NOT AN EMPTY
  // LADDER. Falling back to the members would silently encode to whatever the
  // group happened to own, which for a tracking group is nothing, and the job
  // would "succeed" having produced no renditions.
  if (tracking && (!opts.trackedRungs || !opts.trackedRungs.length)) {
    throw new Error(
      `ladder group "${group.name}" tracks a live output profile, but that profile ` +
      'has no rungs (or has been deleted); refusing to encode to an empty ladder');
  }
  if (!tracking && (!opts.memberRungs || !opts.memberRungs.length)) {
    throw new Error(`ladder group "${group.name}" has no renditions in it`);
  }

  const rungs = (tracking ? opts.trackedRungs! : opts.memberRungs!)
    .map((r) => ({ height: Number(r.height), bitrate_kbps: Number(r.bitrate_kbps), fps: r.fps ?? null }))
    // HIGHEST FIRST, always. The manifest lists them in this order and a player
    // picking the first variant should not get the 360p one because the rows
    // came back in insertion order.
    .sort((a, b) => b.height - a.height || b.bitrate_kbps - a.bitrate_kbps);

  return {
    groupId: group.id,
    groupName: group.name,
    rungs,
    // When tracking, the SEGMENT LENGTH comes from the live profile too. The GOP
    // is segment x fps, so a file encoded with a different segment length has its
    // keyframes in different places from the channel it is meant to match.
    segmentSeconds: Number((tracking ? opts.trackedSegmentDur : null) ?? group.segment_dur) || 4,
    fps: Number((tracking ? opts.trackedFps : null) ?? group.fps) || 25,
    packaging: group.packaging,
    codecBackend: group.codec_backend,
    capToSource: group.cap_to_source,
    origin: tracking
      ? { kind: 'tracked', outputProfileId: group.tracks_output_profile_id!, profileName: opts.trackedProfileName ?? null }
      : { kind: 'members' },
  };
}

/**
 * Fit a resolved ladder to what the source actually contains.
 *
 * Never throws: a ladder that fits nothing still returns a playable answer, and
 * every decision is on the result rather than in a log.
 */
export function fitToSource(ladder: ResolvedLadder, probe: SourceProbe): FittedLadder {
  const notes: string[] = [];
  const srcH = probe.height == null ? null : Number(probe.height);
  const srcFps = probe.fps == null ? null : Number(probe.fps);

  const out: FittedLadder = {
    kept: [], dropped: [], fps: ladder.fps, adapted: null,
    sourceUnmeasured: false, notes,
  };

  // CASE 1. Not measured is not zero. See the header.
  if (!ladder.capToSource || srcH == null || !Number.isFinite(srcH) || srcH <= 0) {
    out.kept = ladder.rungs.slice();
    if (!ladder.capToSource) {
      notes.push('this ladder is set to encode every rung regardless of the source');
    } else {
      out.sourceUnmeasured = true;
      notes.push(
        'the source height could not be measured, so the full ladder was encoded; ' +
        'this is not the same as a source that fitted every rung');
    }
    out.fps = capFps(ladder.fps, srcFps, notes);
    return out;
  }

  for (const r of ladder.rungs) {
    if (r.height > srcH) {
      out.dropped.push({ ...r, why: 'above_source_height', sourceHeight: srcH });
    } else {
      out.kept.push(r);
    }
  }

  // CASE 2. Everything was above the source. "No rungs" is a silent failure that
  // looks like a completed job, so the lowest rung is adapted to the source's
  // own height: playable, and still not an upscale.
  if (!out.kept.length && ladder.rungs.length) {
    const lowest = ladder.rungs[ladder.rungs.length - 1];
    out.kept = [{ ...lowest, height: srcH }];
    out.dropped = out.dropped.filter((d) => d.height !== lowest.height);
    out.adapted = { from: lowest.height, to: srcH, reason: 'source_below_every_rung' };
    notes.push(
      `the source is ${srcH}p, below every rung in this ladder; the lowest rung ` +
      `(${lowest.height}p ${lowest.bitrate_kbps}k) was encoded at the source's own ` +
      'height rather than upscaled');
  }

  // Two rungs at one height after adaptation would produce two identical
  // variants in the manifest, which players handle by picking one arbitrarily.
  const seen = new Set<number>();
  const deduped: Rung[] = [];
  for (const r of out.kept) {
    if (seen.has(r.height)) { out.dropped.push({ ...r, why: 'duplicate_height', sourceHeight: srcH }); continue; }
    seen.add(r.height); deduped.push(r);
  }
  out.kept = deduped;

  out.fps = capFps(ladder.fps, srcFps, notes);

  if (out.dropped.length) {
    notes.push(
      `${out.dropped.length} rung${out.dropped.length === 1 ? '' : 's'} above the ` +
      `source's ${srcH}p were not encoded, because upscaling costs the full rung ` +
      'to carry no extra detail');
  }
  return out;
}

/** CASE 3. Encoding 25fps material at 50 duplicates every frame. */
function capFps(ladderFps: number, sourceFps: number | null, notes: string[]): number {
  if (sourceFps == null || !Number.isFinite(sourceFps) || sourceFps <= 0) return ladderFps;
  // A small tolerance, because 29.97 and 30 are the same source in practice and
  // rounding one down to the other changes the GOP for no reason.
  if (sourceFps >= ladderFps - 0.5) return ladderFps;
  notes.push(
    `the ladder asks for ${ladderFps}fps and the source is ${sourceFps}fps; ` +
    'encoded at the source rate rather than duplicating frames');
  return sourceFps;
}

/** A one-line summary for a queue row or a job note. */
export function describeFit(f: FittedLadder): string {
  const kept = f.kept.map((r) => `${r.height}p`).join(', ') || 'nothing';
  if (f.adapted) return `${kept} (adapted from ${f.adapted.from}p, source was smaller)`;
  if (f.sourceUnmeasured) return `${kept} (source not measured)`;
  if (f.dropped.length) return `${kept} (${f.dropped.length} above the source dropped)`;
  return kept;
}
