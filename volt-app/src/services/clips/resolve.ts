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

export interface ResolvedRun {
  runId: string;
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
  reason: 'no-recording' | 'between-runs';
}

export interface Resolution {
  streamId: string;
  requestedFromMs: number;
  requestedToMs: number;
  requestedMs: number;
  /** Runs in chronological order. More than one means the clip spans a restart. */
  runs: ResolvedRun[];
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
  const runs: ResolvedRun[] = [];

  for (const runId of listRuns(streamId)) {
    const pick = pickRenditions(streamId, runId);
    const rendition = kind === 'audio'
      ? (pick.audio ? 'audio' : null)
      : (pick.video ?? (pick.audio ? 'audio' : null));
    if (!rendition) continue;

    const segs = segmentsIn(streamId, runId, rendition, from, to);
    if (!segs.length) continue;

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

    runs.push({
      runId, rendition,
      initPath: join(dir, 'init.mp4'),
      segments: resolved,
      startMs: resolved[0].startMs,
      endMs: resolved[resolved.length - 1].endMs,
    });
  }

  runs.sort((a, b) => a.startMs - b.startMs);

  // ---- coverage and gaps ---------------------------------------------------
  // Walk the covered intervals in order; anything the request wanted that no run
  // provides is a hole, and the operator has to be told before work is queued.
  const gaps: Gap[] = [];
  let coveredMs = 0;
  let cursor = from;
  for (const run of runs) {
    const runFrom = Math.max(from, run.startMs);
    const runTo = Math.min(to, run.endMs);
    if (runFrom > cursor) {
      gaps.push({
        fromMs: cursor, toMs: runFrom, ms: runFrom - cursor,
        reason: runs.indexOf(run) === 0 ? 'no-recording' : 'between-runs',
      });
    }
    coveredMs += Math.max(0, runTo - Math.max(cursor, runFrom));
    cursor = Math.max(cursor, runTo);
  }
  if (cursor < to) {
    gaps.push({ fromMs: cursor, toMs: to, ms: to - cursor, reason: 'no-recording' });
  }

  const first = runs[0];
  const last = runs[runs.length - 1];
  const needsTrim = runs.some((r) => r.segments.some((s) => s.partial));

  return {
    streamId,
    requestedFromMs: from,
    requestedToMs: to,
    requestedMs: to - from,
    runs,
    gaps,
    coveredMs,
    coveragePct: to > from ? Math.round((coveredMs / (to - from)) * 1000) / 10 : 0,
    effectiveFromMs: first ? Math.max(from, first.startMs) : null,
    effectiveToMs: last ? Math.min(to, last.endMs) : null,
    kind,
    needsTrim,
  };
}

/** Total segments across every run — a rough cost signal for the UI. */
export function segmentCount(r: Resolution): number {
  return r.runs.reduce((n, run) => n + run.segments.length, 0);
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
  if (!r.runs.length) {
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
