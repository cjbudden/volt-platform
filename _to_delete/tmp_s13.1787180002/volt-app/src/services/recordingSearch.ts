// ============================================================================
//  Recording search — find content INSIDE recordings, two ways:
//
//  1. TRANSCRIPT: the encoder appends every caption cue to a durable per-run
//     transcript.jsonl with MEASURED wall-clock times ({lang, start_ms, end_ms,
//     text}). Searching that answers "when was this statement made" with a
//     timestamp you can jump the range picker to and clip. Runs recorded before
//     the index existed fall back to parsing the on-disk WebVTT sub segments,
//     placed by file mtime (approximate: the write happens a few seconds after
//     capture, so fallback hits are marked approx).
//
//  2. EPG: programmes (guide entries) overlapping a recording's window locate
//     content by what was ON AIR — search programme titles to find the
//     recording AND the exact time slice to clip (modules/recordings.ts joins
//     the programmes table; this file only handles the transcript side).
// ============================================================================
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { originBaseFor } from './liveOrigin';
import { listRuns } from './localRecordingIndex';

export interface TranscriptEntry {
  runId: string;
  lang: string;
  startMs: number;   // wall-clock
  endMs: number;
  text: string;
  approx?: boolean;  // true when placed from VTT mtimes (pre-index runs)
}

/** Parse one run's transcript.jsonl (the durable index the encoder appends). */
function readRunIndex(streamId: string, runId: string): TranscriptEntry[] {
  const p = join(originBaseFor(streamId), 'runs', runId, 'transcript.jsonl');
  if (!existsSync(p)) return [];
  const out: TranscriptEntry[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (typeof j.text === 'string' && j.text && Number.isFinite(j.start_ms)) {
        out.push({ runId, lang: String(j.lang || 'und'), startMs: Number(j.start_ms), endMs: Number(j.end_ms ?? j.start_ms), text: j.text });
      }
    } catch { /* skip corrupt line */ }
  }
  return out;
}

/** Fallback for runs recorded before transcript.jsonl existed: parse the
 *  on-disk sub_N.vtt segments. Cue times inside a segment are RELATIVE to the
 *  segment start; the file's mtime is when the chunk finished processing, so
 *  wall placement = mtime - (last cue's relative end) + cue offset. Accurate to
 *  a few seconds (processing delay), which is fine for locating a statement. */
function readRunVtt(streamId: string, runId: string): TranscriptEntry[] {
  const subRoot = join(originBaseFor(streamId), 'runs', runId, 'subtitles');
  let langs: string[];
  try { langs = readdirSync(subRoot); } catch { return []; }
  const out: TranscriptEntry[] = [];
  for (const lang of langs) {
    const dir = join(subRoot, lang);
    let files: string[];
    try { files = readdirSync(dir).filter((f) => /^sub_\d+\.vtt$/.test(f)); } catch { continue; }
    for (const f of files) {
      const p = join(dir, f);
      let raw: string, mtime: number;
      try { raw = readFileSync(p, 'utf8'); mtime = statSync(p).mtimeMs; } catch { continue; }
      const cues: { rs: number; re: number; text: string }[] = [];
      const re = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*\n((?:(?!\n\n)[\s\S])*)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw))) {
        const rs = (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + +m[4];
        const rend = (+m[5] * 3600 + +m[6] * 60 + +m[7]) * 1000 + +m[8];
        const text = m[9].trim();
        if (text) cues.push({ rs, re: rend, text });
      }
      if (!cues.length) continue;
      const lastEnd = Math.max(...cues.map((c) => c.re));
      for (const c of cues) {
        out.push({ runId, lang, startMs: mtime - lastEnd + c.rs, endMs: mtime - lastEnd + c.re, text: c.text, approx: true });
      }
    }
  }
  return out;
}

/** Every transcript entry for a stream (all runs), sorted by time. Runs with a
 *  durable index use it; older runs fall back to VTT parsing. */
export function transcriptForStream(streamId: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const runId of listRuns(streamId)) {
    const idx = readRunIndex(streamId, runId);
    out.push(...(idx.length ? idx : readRunVtt(streamId, runId)));
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Case-insensitive all-words match ("prime minister" finds a cue containing
 *  both words in any order). Returns entries in time order. */
export function searchTranscript(entries: TranscriptEntry[], q: string, lang?: string): TranscriptEntry[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return entries.filter((e) => {
    if (lang && e.lang !== lang) return false;
    const t = e.text.toLowerCase();
    return words.every((w) => t.includes(w));
  });
}

/** Does ANY cue of this stream match q inside [fromMs..toMs]? Used by the
 *  recordings LIST search (cheap early-exit scan, no allocation of results). */
export function transcriptMatches(streamId: string, q: string, fromMs: number, toMs: number): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  for (const e of transcriptForStream(streamId)) {
    if (e.startMs > toMs) break;
    if (e.endMs < fromMs) continue;
    const t = e.text.toLowerCase();
    if (words.every((w) => t.includes(w))) return true;
  }
  return false;
}
