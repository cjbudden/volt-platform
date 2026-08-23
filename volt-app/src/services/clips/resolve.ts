// ============================================================================
//  RANGE RESOLUTION — turn an absolute time range into the media that covers it.
//
//  This is the load-bearing half of clipping, and the reason the API takes wall
//  clock rather than a recording id: the caller says "14:05 to 14:20 on this
//  channel" and the backend works out which runs, which renditions and which
//  segments that actually is. A range may span several capture runs (an encoder
//  restart), several broadcast days, and may have holes in it.
//
//  WHY NOT the orphaned extractor's approach. vod-extractor-job.ts computes a
//  segment's position as `(seq - 1) * segMs`, i.e. it assumes every segment is
//  exactly the nominal length. Real segments are not: the encoder targets 4s but
//  lands where the keyframe lands, and the index measures each one's true
//  duration from its tfdt delta. Over an hour that assumption drifts by seconds.
//  Everything here uses the MEASURED placement instead.
// ============================================================================
import { listRuns, pickRenditions, scanRun, type LocalSegment } from '../localRecordingIndex';
import { originBaseFor } from '../liveOrigin';
import { join } from 'node:path';

export type MediaKind = 'video' | 'audio';

export interface ResolvedSegment {
  runId: string;
  rendition: string;
  file: string;
  seq: number;
  /** Wall-clock start and end of this segment's content. */
  startMs: number;
  endMs: number;
  /** Absolute path on disk, for the extractor. */
  path: string;
  /** How much of this segment the request actually wants, as an offset into it.
   *  0 / durMs for a fully-included segment; non-zero on the two ends. */
  takeFromMs: number;
  takeToMs: number;
  partial: boolean;
}

/**
 * A CONTIGUOUS BLOCK of media: segments that follow each other with no hole, all
 * from one run and one rendition.
 *
 * This is deliberately not the same thing as a run, and the difference is the
 * bug it exists to prevent. A run can have a hole in the middle of it — the disk
 * filled, the process was killed between writes, retention pruned from the wrong
 * end. Treated as one span, the segments either side of that hole get byte-joined
 * into a single file, and the clip comes out shorter than asked for with the
 * missing minutes silently absent and every trim point after the hole wrong. The
 * gap has to be seen at RESOLUTION time, where it can be reported, refused, or
 * accepted deliberately.
 */
export interface ResolvedBlock {
  runId: string;
  /** Which contiguous block of that run this is: 0 unless the run has holes. */
  blockIndex: number;
  rendition: string;
  /** init.mp4 for this run and rendition. Segments are undecodable without it. */
  initPath: string;
  segments: ResolvedSegment[];
  startMs: number;
  endMs: number;
}

export interface Gap {
  fromMs: number;
  toMs: number;
  ms: number;
  reason: 'no-recording' | 'between-runs' | 'missing-media';
}

export interface Resolution {
  streamId: string;
  requestedFromMs: number;
  requestedToMs: number;
  requestedMs: number;
  /** Contiguous blocks in chronological order. More than one means the range
   *  crosses a restart, or a hole inside a run. */
  blocks: ResolvedBlock[];
  /** Distinct capture runs contributing, which is <= blocks.length. */
  runCount: number;
  gaps: Gap[];
  coveredMs: number;
  coveragePct: number;
  /** Where the media actually begins and ends, which may be inside the request
   *  when the edges are not covered. */
  effectiveFromMs: number | null;
  effectiveToMs: number | null;
  kind: MediaKind;
  /** True when the first or last segment is only partly wanted, i.e. a
   *  frame-accurate cut needs to re-encode an end. */
  needsTrim: boolean;
}

/** Segments a rendition contributes to [from..to], measured, in time order. */
function segmentsIn(streamId: string, runId: string, rendition: string, fromMs: number, toMs: number): LocalSegment[] {
  return scanRun(streamId, runId, rendition)
    .filter((s) => s.startMs + s.durMs > fromMs && s.startMs < toMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * Resolve [fromMs..toMs] on a stream to the runs and segments that cover it.
 *
 * `kind` picks the rendition family: 'video' takes the highest video rendition
 * of each run and falls back to audio for an audio-only run; 'audio' always
 * takes audio, which is what an MP3 or a waveform wants.
 */
export function resolveRange(
  streamId: string, fromMs: number, toMs: number, kind: MediaKind = 'video'
): Resolution {
  const from = Math.min(fromMs, toMs);
  const to = Math.max(fromMs, toMs);
  const blocks: ResolvedBlock[] = [];
  const runIds = new Set<string>();

  for (const runId of listRuns(streamId)) {
    const pick = pickRenditions(streamId, runId);
    const rendition = kind === 'audio'
      ? (pick.audio ? 'audio' : null)
      : (pick.video ?? (pick.audio ? 'audio' : null));
    if (!rendition) continue;

    const segs = segmentsIn(streamId, runId, rendition, from, to);
    if (!segs.length) continue;
    runIds.add(runId);

    const dir = join(originBaseFor(streamId), 'runs', runId, rendition);
    const resolved: ResolvedSegment[] = segs.map((s) => {
      const segStart = s.startMs;
      const segEnd = s.startMs + s.durMs;
      // Clamp the request to this segment: the first and last of a range are
      // usually partial, everything between is whole.
      const wantFrom = Math.max(from, segStart);
      const wantTo = Math.min(to, segEnd);
      return {
        runId, rendition, file: s.file, seq: s.seq,
        startMs: segStart, endMs: segEnd,
        path: join(dir, s.file),
        takeFromMs: wantFrom - segStart,
        takeToMs: wantTo - segStart,
        partial: wantFrom > segStart || wantTo < segEnd,
      };
    });

    // Split the run wherever the media stops being contiguous. Everything
    // downstream — the byte join, the trim offsets, the coverage figure — assumes
    // a block has no holes in it, so the holes have to be found HERE.
    for (const part of splitContiguous(resolved)) {
      blocks.push({
        runId,
        blockIndex: blocks.filter((b) => b.runId === runId).length,
        rendition,
        initPath: join(dir, 'init.mp4'),
        segments: part,
        startMs: part[0].startMs,
        endMs: part[part.length - 1].endMs,
      });
    }
  }

  blocks.sort((a, b) => a.startMs - b.startMs);

  // ---- coverage and gaps ---------------------------------------------------
  // Walk the covered intervals in order; anything the request wanted that no
  // block provides is a hole, and the operator has to be told before work is
  // queued. The REASON matters: media missing inside one run is a different
  // fault from a channel that simply was not recording.
  const gaps: Gap[] = [];
  let coveredMs = 0;
  let cursor = from;
  let prev: ResolvedBlock | null = null;
  for (const block of blocks) {
    const blockFrom = Math.max(from, block.startMs);
    const blockTo = Math.min(to, block.endMs);
    if (blockFrom > cursor) {
      gaps.push({
        fromMs: cursor, toMs: blockFrom, ms: blockFrom - cursor,
        reason: !prev ? 'no-recording'
          : prev.runId === block.runId ? 'missing-media'
          : 'between-runs',
      });
    }
    coveredMs += Math.max(0, blockTo - Math.max(cursor, blockFrom));
    cursor = Math.max(cursor, blockTo);
    prev = block;
  }
  if (cursor < to) {
    gaps.push({ fromMs: cursor, toMs: to, ms: to - cursor, reason: 'no-recording' });
  }

  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  const needsTrim = blocks.some((b) => b.segments.some((s) => s.partial));

  return {
    streamId,
    requestedFromMs: from,
    requestedToMs: to,
    requestedMs: to - from,
    blocks,
    runCount: runIds.size,
    gaps,
    coveredMs,
    coveragePct: to > from ? Math.round((coveredMs / (to - from)) * 1000) / 10 : 0,
    effectiveFromMs: first ? Math.max(from, first.startMs) : null,
    effectiveToMs: last ? Math.min(to, last.endMs) : null,
    kind,
    needsTrim,
  };
}

/**
 * How far consecutive segments may drift apart and still count as contiguous.
 *
 * Placement comes from write-completion times, which jitter: measured on real
 * runs the neighbour-to-neighbour delta sits within about a quarter of a second
 * either way, occasionally more under load. A genuinely missing segment leaves a
 * hole of a whole segment, four seconds, so a one-second threshold separates the
 * two cleanly without splitting a healthy run on noise.
 */
const CONTINUITY_TOLERANCE_MS = 1000;

/** Break a run's segments wherever the media is not continuous. */
function splitContiguous(segs: ResolvedSegment[]): ResolvedSegment[][] {
  const out: ResolvedSegment[][] = [];
  let cur: ResolvedSegment[] = [];
  for (const s of segs) {
    const prev = cur[cur.length - 1];
    // A skipped sequence number means a segment is not on disk, whatever the
    // clock says; a forward jump beyond tolerance means media is missing even
    // when the numbering looks intact. Either one ends the block.
    const broken = prev != null
      && (s.seq !== prev.seq + 1 || s.startMs - prev.endMs > CONTINUITY_TOLERANCE_MS);
    if (broken) { out.push(cur); cur = []; }
    cur.push(s);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Total segments across every block — a rough cost signal for the UI. */
export function segmentCount(r: Resolution): number {
  return r.blocks.reduce((n, b) => n + b.segments.length, 0);
}

/**
 * Is this range worth queueing?
 *
 * Deliberately explicit rather than a boolean: the caller shows the operator the
 * reason, and a job that cannot succeed is refused before a worker picks it up
 * rather than failing three times with a retry in between.
 */
export function assessRange(r: Resolution, opts: { maxGapMs?: number } = {}):
  { ok: true } | { ok: false; code: string; message: string } {
  const maxGap = opts.maxGapMs ?? 0;
  if (!r.blocks.length) {
    return { ok: false, code: 'no_media',
      message: `Nothing is recorded between ${new Date(r.requestedFromMs).toISOString()} and ${new Date(r.requestedToMs).toISOString()}.` };
  }
  if (r.requestedMs <= 0) {
    return { ok: false, code: 'empty_range', message: 'The end must be after the start.' };
  }
  const bigGaps = r.gaps.filter((g) => g.ms > maxGap);
  if (bigGaps.length) {
    const total = bigGaps.reduce((n, g) => n + g.ms, 0);
    return { ok: false, code: 'coverage_gap',
      message: `${bigGaps.length} gap${bigGaps.length === 1 ? '' : 's'} totalling ${(total / 1000).toFixed(1)}s ` +
               `fall inside this range (coverage ${r.coveragePct}%). Shrink the range or accept the gaps.` };
  }
  return { ok: true };
}
