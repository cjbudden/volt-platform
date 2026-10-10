// ============================================================================
//  Local recording index — the bridge between recordings and the per-run
//  segments on disk.
//
//  Recording playback needs: 'give me time range [from..to] of this channel or
//  event as a playable VOD manifest'. The per-run namespace makes this exact:
//  every run dir holds CMAF segments whose WALL-CLOCK placement is measured
//  (file mtime = when its content finished being written) and whose MEDIA
//  duration is exact (tfdt deltas between consecutive segments). This service
//  scans runs/<runId>/<rendition>/seg_*.m4s, answers range queries, and builds
//  VOD playlists: per-run EXT-X-MAP (each run has its own init), EXT-X-
//  DISCONTINUITY between runs, per-segment PDT so players show real times.
//
//  Cuts are segment-accurate here (the DESIGN_frame_access.md JIT path later
//  refines the edges to frame accuracy without changing this addressing).
// ============================================================================
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { originBaseFor } from './liveOrigin';

export interface LocalSegment {
  runId: string;
  rendition: string;
  file: string;          // seg_N.m4s
  seq: number;
  startMs: number;       // wall-clock start of this segment's content
  durMs: number;         // exact media duration (tfdt delta) where known
  uri: string;           // public /origin path
}

export interface RunSpan { runId: string; startMs: number; endMs: number; segments: number }

/** What a segment is nominally cut at, when nothing measurable says otherwise. */
const NOMINAL_SEGMENT_MS = 4000;
/** The longest a single segment can credibly be. Anything beyond this is not a
 *  long segment, it is a rebased timeline being read as a duration. */
const MAX_SEGMENT_MS = 60_000;

// ---- fMP4 box peeks (same logic the encoder uses) ---------------------------
function readHead(path: string, n = 65536): Buffer | null {
  try {
    const fd = openSync(path, 'r');
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, 0);
    closeSync(fd);
    return buf.subarray(0, got);
  } catch { return null; }
}

function mdhdTimescale(initPath: string): number | null {
  const b = readHead(initPath);
  if (!b) return null;
  const i = b.indexOf('mdhd');
  if (i < 0) return null;
  const ver = b[i + 4];
  const off = i + 8 + (ver === 1 ? 16 : 8);
  const ts = b.readUInt32BE(off);
  return ts || null;
}

function tfdtBase(segPath: string): bigint | null {
  const b = readHead(segPath);
  if (!b) return null;
  const i = b.indexOf('tfdt');
  if (i < 0) return null;
  const ver = b[i + 4];
  if (ver === 1) return b.readBigUInt64BE(i + 8);
  return BigInt(b.readUInt32BE(i + 8));
}

// ---- scanning ---------------------------------------------------------------
/** Rendition dirs (contain init.mp4) inside one run, e.g. ['480p','audio']. */
function renditionsIn(runDir: string): string[] {
  try {
    return readdirSync(runDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(runDir, d.name, 'init.mp4')))
      .map((d) => d.name);
  } catch { return []; }
}

export function listRuns(streamId: string): string[] {
  try {
    return readdirSync(join(originBaseFor(streamId), 'runs')).sort();
  } catch { return []; }
}

// ---- per-run scan cache -----------------------------------------------------
//
//  A segment's tfdt and mtime never change once the file is closed, but the
//  old scan re-read the head of EVERY segment and stat'ed it on EVERY call. A
//  24x7 channel holds ~21,600 segments per retained day, and the recording page
//  calls this several times per load (timeline, waveform, programmes) and then
//  again on every waveform poll. That was tens of thousands of file opens per
//  request, and it was the bulk of "the page takes a long time to load".
//
//  The cache keeps what was measured per file and only touches files it has not
//  seen, plus the newest two (the one still being written and the one just
//  closed, whose mtime can still move). Pruned files drop out because the
//  directory listing is still read fresh each time. A very short TTL folds the
//  bursts of calls a single page load makes into one directory read.
interface ScanEntry { f: string; seq: number; tfdt: bigint | null; mtimeMs: number }
interface RunScanCache { ts: number; entries: Map<string, ScanEntry>; result: LocalSegment[]; at: number }
const scanCache = new Map<string, RunScanCache>();
const SCAN_TTL_MS = 1500;
/** Files at the tail of the listing that are re-measured on every scan. */
const SCAN_HOT_TAIL = 2;

/** Scan ONE rendition of ONE run into wall-clock placed segments. */
export function scanRun(streamId: string, runId: string, rendition: string): LocalSegment[] {
  const dir = join(originBaseFor(streamId), 'runs', runId, rendition);
  const key = `${streamId}/${runId}/${rendition}`;
  const now = Date.now();
  const cached = scanCache.get(key);
  if (cached && now - cached.at < SCAN_TTL_MS) return cached.result;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^seg_\d+\.m4s$/.test(f));
  } catch { scanCache.delete(key); return []; }
  const ts = cached?.ts ?? (mdhdTimescale(join(dir, 'init.mp4')) ?? 90000);
  const known = cached?.entries ?? new Map<string, ScanEntry>();
  const sortedFiles = files
    .map((f) => ({ f, seq: parseInt(f.match(/\d+/)![0], 10) }))
    .sort((a, b) => a.seq - b.seq);
  const next = new Map<string, ScanEntry>();
  const hotFrom = Math.max(0, sortedFiles.length - SCAN_HOT_TAIL);
  const entries: ScanEntry[] = sortedFiles.map(({ f, seq }, i) => {
    const hit = i < hotFrom ? known.get(f) : undefined;
    if (hit) { next.set(f, hit); return hit; }
    let e: ScanEntry;
    try { e = { f, seq, tfdt: tfdtBase(join(dir, f)), mtimeMs: statSync(join(dir, f)).mtimeMs }; }
    catch { e = { f, seq, tfdt: null, mtimeMs: now }; }
    next.set(f, e);
    return e;
  });
  const out = placeSegments(entries.map((e) => ({ seq: e.seq, tfdt: e.tfdt, mtimeMs: e.mtimeMs })), ts)
    .map((p, i) => ({
      runId, rendition, file: entries[i].f, seq: entries[i].seq,
      startMs: p.startMs, durMs: p.durMs,
      uri: `/origin/${streamId}/runs/${runId}/${rendition}/${entries[i].f}`,
    }));
  scanCache.set(key, { ts, entries: next, result: out, at: now });
  return out;
}

// ---- placement: where each segment sits on the wall clock -------------------
//
//  DURATION. A tfdt DELTA is a segment's duration only when the next entry is
//  the segment that genuinely follows it. Two ways that fails, both seen on
//  real runs:
//    REBASED TIMELINE. An encoder restarting inside a run resets tfdt and the
//    delta comes out negative; one real run produced -1,264,001 ms.
//    A MISSING NEIGHBOUR. When a segment is absent (pruned, lost to a killed
//    process) the next entry is not seq+1 and the delta measures across the
//    hole: the segment before a five-segment hole took a 24s duration.
//  So: consecutive sequence numbers AND a plausible value, or the neighbouring
//  segment's measured length.
//
//  POSITION. Segments used to be placed at "file written minus duration". That
//  holds only when the encoder writes each segment as its content finishes.
//  It does not when the SOURCE arrives in chunks: a radio station pulling an
//  HLS source (ABC Jazz, 10 Oct 2026) receives 10 s at a time and the packager
//  writes two or three 4 s segments within 0.1 s of each other, every 10 s.
//  Each burst was stacked into one 4 s slot followed by 6 s of nothing, so a
//  continuous recording showed a "gap" every 10 s: 29 false gaps in a 5 minute
//  clip, the waveform and EPG out of step with what was heard, and clips
//  refused or cut short, while playback (which follows the media clock) was
//  smooth.
//
//  Now the MEDIA clock places segments, anchored to the wall clock:
//    - a PIECE is a stretch of consecutive sequence numbers whose tfdt runs on
//      without a reset. Inside it, segment i starts at anchor + its media offset.
//    - a segment's write time can only be LATER than its content ended (it is
//      written after the content exists, sometimes a whole burst later), so
//      lag_i = write_i - mediaEnd_i over-estimates the anchor and the smallest
//      lag is the best estimate. Taken as a suffix minimum, so the anchor only
//      ever steps forward.
//    - a STALL (the encoder fell behind and carried on, delivery paused and the
//      source skipped ahead) shows as the lag stepping up for good. A step
//      larger than this run's normal burst spread is a real hole and starts a
//      new anchor; smaller ones are delivery jitter and are absorbed.
//    - between pieces (a missing segment, a reset clock) the next piece is
//      anchored on its own and never starts before the previous one ended.
//  Every segment still ends no later than it was written, and a run written
//  steadily (a transcoding encoder) is placed exactly as before.
export interface SegmentFacts { seq: number; tfdt: bigint | null; mtimeMs: number }

export function placeSegments(entries: SegmentFacts[], timescale: number): { startMs: number; durMs: number }[] {
  const n = entries.length;
  if (!n) return [];
  // 1. durations, and where the media clock breaks
  const dur: number[] = [];
  const breakBefore: boolean[] = [true];
  for (let i = 0; i < n; i++) {
    const e = entries[i], nxt = entries[i + 1];
    const consecutive = nxt != null && nxt.seq === e.seq + 1;
    const raw = (consecutive && e.tfdt != null && nxt!.tfdt != null)
      ? Number((nxt!.tfdt - e.tfdt) * 1000n / BigInt(timescale)) : null;
    const plausible = raw != null && raw > 0 && raw <= MAX_SEGMENT_MS;
    dur.push(plausible ? raw! : (i > 0 ? dur[i - 1] : NOMINAL_SEGMENT_MS));
    if (i + 1 < n) breakBefore.push(!consecutive || (raw != null && !plausible));
  }
  // 2. this run's normal delivery cadence: the typical spacing between writes,
  //    ignoring files written in the same burst (under a second apart). The
  //    MEDIAN, so one stall cannot pass itself off as normal: a 90th percentile
  //    did, in a short run, and hid a 60 s stall. A burst source (10 s chunks)
  //    reads 10 s, a steady 4 s encoder 4 s; a step in the lag beyond 1.5x that
  //    (and at least 6 s) is a real hole.
  const spacing = entries.slice(1).map((e, i) => e.mtimeMs - entries[i].mtimeMs).filter((d) => d >= 1000).sort((a, b) => a - b);
  const cadence = spacing.length ? spacing[Math.floor(spacing.length / 2)] : NOMINAL_SEGMENT_MS;
  const stallMs = Math.max(6000, cadence * 1.5);
  // 3. place each piece
  const out: { startMs: number; durMs: number }[] = new Array(n);
  let prevEnd = -Infinity;
  for (let a = 0; a < n;) {
    let b = a + 1;
    while (b < n && !breakBefore[b]) b++;
    const media: number[] = [];
    let acc = 0;
    for (let i = a; i < b; i++) { media.push(acc); acc += dur[i]; }
    const lag = media.map((m, k) => entries[a + k].mtimeMs - (m + dur[a + k]));
    const suffixMin = new Array(lag.length);
    for (let k = lag.length - 1; k >= 0; k--) suffixMin[k] = Math.min(lag[k], k + 1 < lag.length ? suffixMin[k + 1] : Infinity);
    let anchor = suffixMin[0];
    for (let k = 0; k < lag.length; k++) {
      if (suffixMin[k] - anchor > stallMs) anchor = suffixMin[k];
      const startMs = Math.max(anchor + media[k], prevEnd);
      out[a + k] = { startMs, durMs: dur[a + k] };
      prevEnd = startMs + dur[a + k];
    }
    a = b;
  }
  return out;
}

/** Drop a run's scan cache (after a prune or a rewrite). Optional: the cache
 *  self-heals from the directory listing, this only makes it immediate. */
export function invalidateRunScan(streamId: string, runId?: string): void {
  for (const k of scanCache.keys()) {
    if (k.startsWith(runId ? `${streamId}/${runId}/` : `${streamId}/`)) scanCache.delete(k);
  }
}

/** The video rendition to use (highest height dir) and whether audio exists. */
export function pickRenditions(streamId: string, runId: string): { video: string | null; audio: boolean } {
  const rends = renditionsIn(join(originBaseFor(streamId), 'runs', runId));
  const vids = rends.filter((r) => r !== 'audio' && r !== 'subtitles')
    .map((r) => ({ r, h: parseInt(r, 10) || 0 })).sort((a, b) => b.h - a.h);
  return { video: vids[0]?.r ?? null, audio: rends.includes('audio') };
}

/** AUDIO segments of every run overlapping [fromMs..toMs], in time order.
 *  The waveform service uses this: audio is the cheap rendition to decode and
 *  is present for both TV channels and radio stations. */
export function audioSegmentsInRange(streamId: string, fromMs: number, toMs: number): LocalSegment[] {
  const out: LocalSegment[] = [];
  for (const runId of listRuns(streamId)) {
    if (!pickRenditions(streamId, runId).audio) continue;
    for (const s of scanRun(streamId, runId, 'audio')) {
      if (s.startMs + s.durMs > fromMs && s.startMs < toMs) out.push(s);
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** True when NO run of this stream has a video rendition (radio / audio-only). */
export function isAudioOnly(streamId: string): boolean {
  const runs = listRuns(streamId);
  if (!runs.length) return false;
  return runs.every((run) => {
    const p = pickRenditions(streamId, run);
    return !p.video;
  }) && runs.some((run) => pickRenditions(streamId, run).audio);
}

/** Coverage summary across all runs (for the UI timeline: spans + gaps).
 *  Audio-only runs (radio) fall back to the audio rendition. */
export function recordingSpans(streamId: string): RunSpan[] {
  const spans: RunSpan[] = [];
  for (const runId of listRuns(streamId)) {
    const pick = pickRenditions(streamId, runId);
    const video = pick.video ?? (pick.audio ? 'audio' : null);
    if (!video) continue;
    const segs = scanRun(streamId, runId, video);
    if (!segs.length) continue;
    const last = segs[segs.length - 1];
    spans.push({ runId, startMs: segs[0].startMs, endMs: last.startMs + last.durMs, segments: segs.length });
  }
  return spans;
}

// ---- range playlists --------------------------------------------------------
function fmtPdt(ms: number): string {
  return new Date(ms).toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
}

/** One rendition's VOD playlist over [fromMs..toMs], spanning runs with
 *  DISCONTINUITY + per-run MAP. Returns null when nothing overlaps. */
export function rangeMediaPlaylist(streamId: string, kind: 'video' | 'audio', fromMs: number, toMs: number): string | null {
  const groups: { runId: string; rend: string; segs: LocalSegment[] }[] = [];
  for (const runId of listRuns(streamId)) {
    const pick = pickRenditions(streamId, runId);
    const rend = kind === 'video' ? pick.video : (pick.audio ? 'audio' : null);
    if (!rend) continue;
    const segs = scanRun(streamId, runId, rend)
      .filter((s) => s.startMs + s.durMs > fromMs && s.startMs < toMs);
    if (segs.length) groups.push({ runId, rend, segs });
  }
  if (!groups.length) return null;
  groups.sort((a, b) => a.segs[0].startMs - b.segs[0].startMs);
  const maxDur = Math.ceil(Math.max(...groups.flatMap((g) => g.segs.map((s) => s.durMs))) / 1000);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${maxDur}`,
    '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
  groups.forEach((g, gi) => {
    if (gi > 0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXT-X-MAP:URI="/origin/${streamId}/runs/${g.runId}/${g.rend}/init.mp4"`);
    for (const s of g.segs) {
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${fmtPdt(s.startMs)}`);
      lines.push(`#EXTINF:${(s.durMs / 1000).toFixed(3)},`);
      lines.push(s.uri);
    }
  });
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/** Master playlist for the range: video variant + audio group when present.
 *  Media playlist URLs are provided by the caller (they carry auth/query). */
export function rangeMasterPlaylist(streamId: string, hasAudio: boolean,
  videoUrl: string | null, audioUrl: string): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  if (!videoUrl) {
    // AUDIO-ONLY (radio): the audio media playlist is the variant itself.
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="mp4a.40.2"`);
    lines.push(audioUrl);
    return lines.join('\n') + '\n';
  }
  if (hasAudio) {
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="${audioUrl}"`);
  }
  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=2000000${hasAudio ? ',AUDIO="audio"' : ''}`);
  lines.push(videoUrl);
  return lines.join('\n') + '\n';
}

// ---- GAPS: where the recording has nothing ----------------------------------
//
//  A span per run hides the holes INSIDE a run (a pruned segment, an encoder
//  that stalled for a minute and carried on under the same run id), and the
//  space BETWEEN runs is only visible as an absence. An editor placing marks
//  needs the holes drawn as holes, before the clip is refused for crossing one.
//
//  Walks the representative rendition's segments in time order; anything
//  wider than a segment's worth of tolerance is a gap. Same contiguity rule
//  as the clip resolver, so what the timeline shows is what the cut will hit.
export interface RecordingGap {
  fromMs: number; toMs: number; ms: number;
  reason: 'between-runs' | 'missing-media' | 'no-recording';
}
const GAP_MIN_MS = 1500;   // under this is segment jitter, not a hole

export function recordingGaps(streamId: string, fromMs: number, toMs: number): RecordingGap[] {
  const segs: LocalSegment[] = [];
  for (const runId of listRuns(streamId)) {
    const pick = pickRenditions(streamId, runId);
    const rend = pick.video ?? (pick.audio ? 'audio' : null);
    if (!rend) continue;
    for (const s of scanRun(streamId, runId, rend)) {
      if (s.startMs + s.durMs > fromMs && s.startMs < toMs) segs.push(s);
    }
  }
  segs.sort((a, b) => a.startMs - b.startMs);
  const gaps: RecordingGap[] = [];
  if (!segs.length) {
    if (toMs - fromMs > GAP_MIN_MS) gaps.push({ fromMs, toMs, ms: toMs - fromMs, reason: 'no-recording' });
    return gaps;
  }
  if (segs[0].startMs - fromMs > GAP_MIN_MS) {
    gaps.push({ fromMs, toMs: segs[0].startMs, ms: segs[0].startMs - fromMs, reason: 'no-recording' });
  }
  let cursor = segs[0].startMs + segs[0].durMs;
  let prevRun = segs[0].runId;
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    if (s.startMs - cursor > GAP_MIN_MS) {
      gaps.push({ fromMs: cursor, toMs: s.startMs, ms: s.startMs - cursor,
                  reason: s.runId !== prevRun ? 'between-runs' : 'missing-media' });
    }
    cursor = Math.max(cursor, s.startMs + s.durMs);
    prevRun = s.runId;
  }
  if (toMs - cursor > GAP_MIN_MS) {
    gaps.push({ fromMs: cursor, toMs, ms: toMs - cursor, reason: 'no-recording' });
  }
  return gaps;
}

// ---- ON AIR INSTEAD: where viewers saw the channel's loop ----------------------
//
// The playout splice (volt-encoder/bin/playout.py) covers a lost source by putting the
// channel's pre-built loop or slate into the DELIVERED playlists. The loop never goes
// through the packager, so it is never in the recording: the recording keeps only
// real source media and the outage is a hole in it. What the hole does not say is
// that the audience was not looking at a dead player, they were watching the loop.
// The encoder writes every splice to playout.jsonl in its run directory; this turns
// those into intervals the timeline draws and gap reasons can name.
export interface FallbackSpan {
  fromMs: number; toMs: number; ms: number;
  filler: 'loop' | 'slate';
  reason: 'source-lost' | 'forced';
  open: boolean;            // still on the loop (live run, or the run ended on it)
}

export function recordingFallbacks(streamId: string, fromMs: number, toMs: number): FallbackSpan[] {
  const out: FallbackSpan[] = [];
  for (const runId of listRuns(streamId)) {
    let txt: string;
    try { txt = readFileSync(join(originBaseFor(streamId), 'runs', runId, 'playout.jsonl'), 'utf8'); }
    catch { continue; }
    let cur: FallbackSpan | null = null;
    for (const line of txt.split('\n')) {
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      if (e?.type !== 'splice' || !Number.isFinite(Number(e.at_ms))) continue;
      const at = Number(e.at_ms);
      if (e.to === 'loop' && !cur) {
        cur = { fromMs: at, toMs: at, ms: 0, filler: e.filler === 'loop' ? 'loop' : 'slate',
                reason: e.reason === 'forced' ? 'forced' : 'source-lost', open: true };
      } else if (e.to === 'live' && cur) {
        cur.toMs = at; cur.open = false; out.push(cur); cur = null;
      }
    }
    if (cur) {
      // the run ended (or is still) on the loop: it lasts to the run's last segment
      const spans = recordingSpans(streamId).filter((s) => s.runId === runId);
      cur.toMs = Math.max(cur.fromMs, spans.length ? spans[spans.length - 1].endMs : Date.now());
      out.push(cur);
    }
  }
  return out
    .filter((f) => f.toMs > fromMs && f.fromMs < toMs)
    .map((f) => {
      const a = Math.max(f.fromMs, fromMs), b = Math.min(f.toMs, toMs);
      return { ...f, fromMs: a, toMs: b, ms: b - a };
    });
}
