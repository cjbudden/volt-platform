/**
 * VOD extractor JOB runner — turns a clip request into real outputs.
 *
 * Closes the "vod-extractor produces real output" gap: given a recording's CMAF
 * segment tree (as written to S3 / MinIO: `<rendition>/init.mp4` + `seg_N.m4s`)
 * and a `clip_spec` (ordered [{recordingDir,startMs,endMs}] — supports MULTI-
 * recording composed clips), it produces:
 *   - manifest mode: trimmed HLS media playlists + master (segment copy, no
 *     re-encode) with EXT-X-DISCONTINUITY between spec entries;
 *   - progressive mode: a flat MP4 (ffmpeg -c copy, +faststart).
 *
 * Pure selection (`selectSegments`) is unit-tested; the file/ffmpeg side is
 * covered by e2e/extractor-test.sh against real Shaka output. Runs as a CPU task
 * (like the thumbnailer) — the orchestrator launches it; `tools/extract-clip.ts`
 * is the entrypoint.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface RenditionSpec {
  id: string;
  bandwidthBps: number;
  width: number;
  height: number;
  codecs: string;
}
export interface ClipSpecEntry {
  recordingDir: string; // contains <rid>/init.mp4 + <rid>/seg_N.m4s
  startMs: number;
  endMs: number;
}
export interface ExtractJob {
  segMs: number;                // segment duration (ms) — segments are boundary-aligned
  renditions: RenditionSpec[];  // ABR ladder
  clipSpec: ClipSpecEntry[];    // ordered ranges, possibly across recordings
  outputKind: 'manifest' | 'progressive' | 'both';
  outDir: string;               // local dir to write into (uploaded to S3 by caller)
  segPrefix?: string;           // default 'seg_'
  segExt?: string;              // default '.m4s'
}

export interface SelectedSeg {
  srcDir: string;   // rendition dir the segment lives in
  seq: number;      // 1-based segment number in its source recording
  startMs: number;  // clip-relative? no — source-recording-relative start
  durMs: number;
  discontinuity: boolean; // true for the first segment of each spec entry after the first
}

/**
 * Pure: pick the segments overlapping each spec entry's [startMs,endMs], across
 * all entries, in order, marking a discontinuity at each entry boundary.
 * `segCountFor(entryIndex)` returns how many segments exist for that recording.
 */
export function selectSegments(
  clipSpec: ClipSpecEntry[],
  segMs: number,
  segCountFor: (entryIndex: number) => number,
): SelectedSeg[] {
  const out: SelectedSeg[] = [];
  clipSpec.forEach((entry, ei) => {
    const count = segCountFor(ei);
    let firstOfEntry = true;
    for (let seq = 1; seq <= count; seq++) {
      const segStart = (seq - 1) * segMs;
      const segEnd = segStart + segMs;
      // keep any segment that overlaps the requested window
      if (segEnd > entry.startMs && segStart < entry.endMs) {
        out.push({
          srcDir: entry.recordingDir,
          seq,
          startMs: segStart,
          durMs: segMs,
          discontinuity: !firstOfEntry ? false : ei > 0, // boundary between spec entries
        });
        firstOfEntry = false;
      }
    }
  });
  return out;
}

const segFile = (job: ExtractJob, n: number) => `${job.segPrefix ?? 'seg_'}${n}${job.segExt ?? '.m4s'}`;

async function countSegs(job: ExtractJob, dir: string): Promise<number> {
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.startsWith(job.segPrefix ?? 'seg_') && f.endsWith(job.segExt ?? '.m4s')).length;
  } catch {
    return 0;
  }
}

function mediaPlaylist(segs: { uri: string; durSec: number; disc: boolean; map: string }[], targetDur: number): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${targetDur}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  let lastMap = '';
  segs.forEach((s) => {
    if (s.disc) lines.push('#EXT-X-DISCONTINUITY');
    if (s.map !== lastMap) {
      lines.push(`#EXT-X-MAP:URI="${s.map}"`);
      lastMap = s.map;
    }
    lines.push(`#EXTINF:${s.durSec.toFixed(3)},`);
    lines.push(s.uri);
  });
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let err = '';
    ff.stderr.on('data', (d) => (err += d.toString()));
    ff.on('error', reject);
    ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}: ${err.slice(-500)}`))));
  });
}

export interface ExtractResult {
  outputKind: string;
  masterKey?: string;
  progressiveKey?: string;
  renditions: string[];
  segmentCount: number;
  durationMs: number;
}

/** Build the actual clip outputs on disk under job.outDir. */
export async function runExtractJob(job: ExtractJob): Promise<ExtractResult> {
  await fs.mkdir(job.outDir, { recursive: true });
  const wantManifest = job.outputKind !== 'progressive';
  const wantProgressive = job.outputKind !== 'manifest';
  const targetDur = Math.ceil(job.segMs / 1000);
  let totalSegs = 0;
  const renderedRenditions: string[] = [];

  for (const r of job.renditions) {
    // per-rendition segment count per spec entry
    const counts = await Promise.all(job.clipSpec.map((e) => countSegs(job, path.join(e.recordingDir, r.id))));
    const selected = selectSegments(job.clipSpec, job.segMs, (i) => counts[i]);
    if (!selected.length) continue;
    renderedRenditions.push(r.id);
    totalSegs = Math.max(totalSegs, selected.length);

    const rOut = path.join(job.outDir, r.id);
    await fs.mkdir(rOut, { recursive: true });
    const items: { uri: string; durSec: number; disc: boolean; map: string }[] = [];
    let idx = 0;
    for (const s of selected) {
      const srcSeg = path.join(s.srcDir, r.id, segFile(job, s.seq));
      const srcInit = path.join(s.srcDir, r.id, 'init.mp4');
      const dstSeg = `s_${idx}.m4s`;
      const initName = `init_${path.basename(s.srcDir)}.mp4`;
      if (wantManifest) {
        await fs.copyFile(srcSeg, path.join(rOut, dstSeg));
        await fs.copyFile(srcInit, path.join(rOut, initName)).catch(() => {});
        items.push({ uri: dstSeg, durSec: job.segMs / 1000, disc: s.discontinuity, map: initName });
      }
      idx++;
    }
    if (wantManifest) await fs.writeFile(path.join(rOut, 'index.m3u8'), mediaPlaylist(items, targetDur));
  }

  let masterKey: string | undefined;
  if (wantManifest && renderedRenditions.length) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7'];
    for (const r of job.renditions) {
      if (!renderedRenditions.includes(r.id)) continue;
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidthBps},RESOLUTION=${r.width}x${r.height},CODECS="${r.codecs}"`);
      lines.push(`${r.id}/index.m3u8`);
    }
    await fs.writeFile(path.join(job.outDir, 'master.m3u8'), lines.join('\n') + '\n');
    masterKey = 'master.m3u8';
  }

  let progressiveKey: string | undefined;
  if (wantProgressive) {
    // Top rendition → flat MP4. Concatenate init + selected segments into one
    // fmp4 byte-stream, then remux (-c copy) to MP4 with faststart.
    const r = job.renditions[0];
    const counts = await Promise.all(job.clipSpec.map((e) => countSegs(job, path.join(e.recordingDir, r.id))));
    const selected = selectSegments(job.clipSpec, job.segMs, (i) => counts[i]);
    if (selected.length) {
      const tmp = path.join(job.outDir, `_concat_${r.id}.mp4`);
      // group consecutive segments by source recording so each keeps its own init
      const parts: string[] = [];
      let curDir = '';
      let buf: string[] = [];
      const flush = async () => {
        if (!buf.length) return;
        const partPath = path.join(job.outDir, `_part_${parts.length}.mp4`);
        const cat = [path.join(curDir, r.id, 'init.mp4'), ...buf];
        const data = await Promise.all(cat.map((f) => fs.readFile(f)));
        await fs.writeFile(partPath, Buffer.concat(data));
        parts.push(partPath);
        buf = [];
      };
      for (const s of selected) {
        if (s.srcDir !== curDir) {
          await flush();
          curDir = s.srcDir;
        }
        buf.push(path.join(s.srcDir, r.id, segFile(job, s.seq)));
      }
      await flush();
      const outMp4 = path.join(job.outDir, 'progressive.mp4');
      if (parts.length === 1) {
        await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-i', parts[0], '-c', 'copy', '-movflags', '+faststart', '-y', outMp4]);
      } else {
        // concat demuxer across per-recording parts
        const listFile = path.join(job.outDir, '_concat.txt');
        await fs.writeFile(listFile, parts.map((p) => `file '${p}'`).join('\n') + '\n');
        await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', '-y', outMp4]);
      }
      // cleanup temps
      for (const p of [tmp, ...parts]) await fs.rm(p, { force: true });
      await fs.rm(path.join(job.outDir, '_concat.txt'), { force: true });
      progressiveKey = 'progressive.mp4';
    }
  }

  const durationMs = job.clipSpec.reduce((a, e) => a + (e.endMs - e.startMs), 0);
  return { outputKind: job.outputKind, masterKey, progressiveKey, renditions: renderedRenditions, segmentCount: totalSegs, durationMs };
}
