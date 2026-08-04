// Just-in-time renderers over the frame index. Nothing is pre-generated: a request
// for a frame or a clip reads only the relevant segment(s) from the origin and
// decodes on demand. In production the origin is S3 (HTTP byte-range) and results
// are cached at the CDN; here the origin is the local segment dir.
import { execFileSync } from 'node:child_process';
import { locateFrame, planClip, probe } from './index.mjs';
import path from 'node:path';

// A single frame as a JPEG, at a requested width. Reads ONE segment, decodes to the
// local frame. This is the core frame-addressable pull.
export function renderFrame(index, n, width = 640) {
  const { seg, localFrame } = locateFrame(index, n);
  const vf = `select=eq(n\\,${localFrame}),scale=${width}:-1`;
  return execFileSync('ffmpeg', ['-v', 'error', '-i', seg.path, '-vf', vf,
    '-frames:v', '1', '-f', 'mjpeg', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
}

// A frame-accurate clip [inN,outN] as a progressive MP4, rendered JIT from the
// segmented origin via the playlist. Re-encode = exact edges.
export function renderClip(index, playlistPath, inN, outN, outPath, width = 1280) {
  const plan = planClip(index, inN, outN);
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-i', playlistPath,
    '-ss', plan.inTime.toFixed(6), '-to', plan.outTimeExclusive.toFixed(6),
    '-vf', `scale=${width}:-1`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', outPath]);
  return plan;
}

// WebVTT thumbnail sprite: ONE sheet + a VTT that maps each second to a tile rect.
// Standard, player-agnostic scrub preview (no per-frame pull needed while dragging).
export function renderSprite(index, sourcePath, outSpritePath, outVttPath, opts = {}) {
  const cols = opts.cols ?? 10, tileW = opts.tileW ?? 240, tileH = opts.tileH ?? 135, everySec = 1;
  const totalTiles = Math.ceil(index.durationSec / everySec);
  const rows = Math.ceil(totalTiles / cols);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', sourcePath,
    '-vf', `fps=1/${everySec},scale=${tileW}:${tileH},tile=${cols}x${rows}`,
    '-frames:v', '1', outSpritePath]);
  const spriteName = path.basename(outSpritePath);
  const fmt = (s) => new Date(s * 1000).toISOString().substr(11, 12);
  let vtt = 'WEBVTT\n\n';
  for (let t = 0; t < totalTiles; t++) {
    const c = t % cols, r = Math.floor(t / cols);
    vtt += `${fmt(t)} --> ${fmt(Math.min(t + everySec, index.durationSec))}\n`;
    vtt += `${spriteName}#xywh=${c * tileW},${r * tileH},${tileW},${tileH}\n\n`;
  }
  require_write(outVttPath, vtt);
  return { tiles: totalTiles, cols, rows, tileW, tileH };
}

// HLS I-FRAME-ONLY trick-play playlist (EXT-X-I-FRAMES-ONLY). Standardized fast
// scrubbing: the player pulls ONLY keyframes, by byte range, from the same segments.
export function renderIframePlaylist(index) {
  let out = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-I-FRAMES-ONLY\n';
  let maxDur = 0;
  const body = [];
  for (const seg of index.segments) {
    const packets = JSON.parse(execFileSyncStr('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_packets', '-show_entries', 'packet=pos,size,flags,pts_time', '-of', 'json', seg.path])).packets || [];
    const iframes = packets.filter(pk => (pk.flags || '').includes('K'));
    for (let k = 0; k < iframes.length; k++) {
      const cur = iframes[k];
      const next = iframes[k + 1];
      const pos = Number(cur.pos);
      const size = next ? Number(next.pos) - pos : Number(cur.size);
      const dur = next ? (Number(next.pts_time) - Number(cur.pts_time)) : (seg.dur / Math.max(1, iframes.length));
      maxDur = Math.max(maxDur, dur);
      body.push(`#EXTINF:${dur.toFixed(5)},\n#EXT-X-BYTERANGE:${size}@${pos}\n${seg.name}`);
    }
  }
  out = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:${Math.ceil(maxDur)}\n#EXT-X-I-FRAMES-ONLY\n`
      + body.join('\n') + '\n#EXT-X-ENDLIST\n';
  return out;
}

import { writeFileSync } from 'node:fs';
function require_write(p, s) { writeFileSync(p, s); }
function execFileSyncStr(cmd, args) { return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
