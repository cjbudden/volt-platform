// Frame index for a chunked (HLS/CMAF) origin. This is the piece that turns a
// segment-addressable asset into a FRAME-addressable one WITHOUT storing per-frame
// files: we map any global frame number to the segment that contains it and the
// local frame offset inside that segment. A single small segment is then read and
// decoded to the requested frame (see render.mjs). Pure + probe helpers.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function probe(file, entries) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', entries, '-of', 'json', file], { encoding: 'utf8' });
  return JSON.parse(out);
}

// Parse an HLS media playlist into ordered segment names + durations.
export function parsePlaylist(playlistPath) {
  const dir = path.dirname(playlistPath);
  const lines = readFileSync(playlistPath, 'utf8').split(/\r?\n/);
  const segs = [];
  let dur = null;
  for (const ln of lines) {
    if (ln.startsWith('#EXTINF:')) dur = parseFloat(ln.slice(8));
    else if (ln && !ln.startsWith('#')) { segs.push({ name: ln.trim(), dur }); dur = null; }
  }
  return { dir, segs };
}

// Build the frame index: exact per-segment frame counts (probed) + cumulative
// start frame, and the stream fps. Robust to non-uniform segment lengths.
export function buildIndex(playlistPath) {
  const { dir, segs } = parsePlaylist(playlistPath);
  const r = probe(path.join(dir, segs[0].name), 'stream=r_frame_rate');
  const [num, den] = r.streams[0].r_frame_rate.split('/').map(Number);
  const fps = num / den;
  let cum = 0;
  const segments = segs.map((s, i) => {
    const p = probe(path.join(dir, s.name), 'stream=nb_read_frames');
    // nb_read_frames needs -count_frames; fall back to duration*fps
    let frames = Number(p.streams?.[0]?.nb_read_frames);
    if (!Number.isFinite(frames) || !frames) frames = Math.round(s.dur * fps);
    const seg = { i, name: s.name, path: path.join(dir, s.name), startFrame: cum, frames, dur: s.dur };
    cum += frames;
    return seg;
  });
  return { dir, fps, totalFrames: cum, durationSec: cum / fps, segments };
}

// Faster index for large assets: trust EXTINF*fps instead of decode-counting.
export function buildIndexFast(playlistPath) {
  const { dir, segs } = parsePlaylist(playlistPath);
  const r = probe(path.join(dir, segs[0].name), 'stream=r_frame_rate');
  const [num, den] = r.streams[0].r_frame_rate.split('/').map(Number);
  const fps = num / den;
  let cum = 0;
  const segments = segs.map((s, i) => {
    const frames = Math.round(s.dur * fps);
    const seg = { i, name: s.name, path: path.join(dir, s.name), startFrame: cum, frames, dur: s.dur };
    cum += frames; return seg;
  });
  return { dir, fps, totalFrames: cum, durationSec: cum / fps, segments };
}

// Locate a global frame -> which segment + local frame offset + time-in-segment.
export function locateFrame(index, n) {
  if (n < 0 || n >= index.totalFrames) throw new Error(`frame ${n} out of range 0..${index.totalFrames - 1}`);
  const seg = index.segments.find(s => n >= s.startFrame && n < s.startFrame + s.frames);
  const localFrame = n - seg.startFrame;
  return { seg, localFrame, tInSeg: localFrame / index.fps, globalTime: n / index.fps };
}

// Plan a frame-accurate clip [inN, outN] inclusive: which segments it spans and the
// exact time window. Segment-aligned copies could be -c copy; frame-accurate edges
// re-encode. (render.mjs re-encodes the whole range for exactness in this prototype.)
export function planClip(index, inN, outN) {
  if (outN < inN) throw new Error('out < in');
  const a = locateFrame(index, inN), b = locateFrame(index, outN);
  return {
    inN, outN, frames: outN - inN + 1,
    inTime: inN / index.fps, outTimeExclusive: (outN + 1) / index.fps,
    firstSeg: a.seg.i, lastSeg: b.seg.i,
    segmentAligned: a.localFrame === 0 && b.localFrame === b.seg.frames - 1,
  };
}
