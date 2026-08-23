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

/** Scan ONE rendition of ONE run into wall-clock placed segments. */
export function scanRun(streamId: string, runId: string, rendition: string): LocalSegment[] {
  const dir = join(originBaseFor(streamId), 'runs', runId, rendition);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^seg_\d+\.m4s$/.test(f));
  } catch { return []; }
  const ts = mdhdTimescale(join(dir, 'init.mp4')) ?? 90000;
  const entries = files.map((f) => {
    const seq = parseInt(f.match(/\d+/)![0], 10);
    return { f, seq, tfdt: tfdtBase(join(dir, f)), mtimeMs: statSync(join(dir, f)).mtimeMs };
  }).sort((a, b) => a.seq - b.seq);
  const out: LocalSegment[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const nxt = entries[i + 1];
    // A tfdt DELTA is only a duration when the media timeline actually ran
    // forward across the pair. It does not always: an encoder that restarts
    // inside a run rebases tfdt, and the delta then comes out negative — one
    // real run here produced -1,264,001 ms. Used unchecked that is not a small
    // error, it is a segment placed twenty-one minutes into the FUTURE (start is
    // mtime minus duration), which paints media over a gap, offers a clip range
    // that has nothing behind it, and puts a stray bar on the waveform far from
    // any recording. So a delta is accepted only if it is plausible, and an
    // implausible one falls back to the neighbouring segment's measured length.
    const raw = (e.tfdt != null && nxt?.tfdt != null)
      ? Number((nxt.tfdt - e.tfdt) * 1000n / BigInt(ts))
      : null;
    const plausible = raw != null && raw > 0 && raw <= MAX_SEGMENT_MS;
    const durMs = plausible ? raw
      : (i > 0 ? out[i - 1].durMs : NOMINAL_SEGMENT_MS);
    out.push({
      runId, rendition, file: e.f, seq: e.seq,
      startMs: e.mtimeMs - durMs,   // measured write clock, same rule as live PDT
      durMs,
      uri: `/origin/${streamId}/runs/${runId}/${rendition}/${e.f}`,
    });
  }
  return out;
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
