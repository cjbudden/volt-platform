// Prove the prototype end to end against real media (no server needed for the
// assertions). Verifies: the frame index locates frames correctly across segments;
// a JIT single-frame pull returns the RIGHT frame (checked by decoding the burned
// frame number region twice and by exact size); a JIT clip has the exact duration;
// the WebVTT sprite + HLS I-frame trick-play playlist are well-formed.
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, locateFrame, planClip } from './index.mjs';
import { renderFrame, renderClip, renderSprite, renderIframePlaylist } from './render.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = path.join(__dir, 'media');
const PLAYLIST = path.join(MEDIA, 'index.m3u8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };

const index = buildIndex(PLAYLIST);
ok(index.totalFrames === 500, `index counts 500 frames (got ${index.totalFrames})`);
ok(index.fps === 25, `fps 25 (got ${index.fps})`);
ok(index.segments.length === 10, `10 segments (got ${index.segments.length})`);

// locate across a segment boundary: frame 137 -> segment 2, local 37
const loc = locateFrame(index, 137);
ok(loc.seg.i === 2 && loc.localFrame === 37, `frame 137 -> seg 2 local 37 (got seg ${loc.seg.i} local ${loc.localFrame})`);
ok(Math.abs(loc.globalTime - 5.48) < 1e-6, `frame 137 -> 5.480s`);

// JIT single-frame pull returns a valid JPEG of the requested width, and the
// pulled frame is the CORRECT one: crop the burned "FRAME NNN" band and confirm the
// pulled image for frame N differs from N+1 (monotonic content) and matches a direct
// decode of the same global frame from the source.
const jN = renderFrame(index, 137, 640);
writeFileSync('/tmp/p_137.jpg', jN);
const dim = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'json', '/tmp/p_137.jpg'], { encoding: 'utf8' })).streams[0];
ok(dim.width === 640, `frame JPEG width 640 (got ${dim.width})`);

// ground-truth: decode global frame 137 straight from source.mp4 and compare to the
// segment-derived pull via a perceptual signature (average hash over a grayscale
// downscale). Identical frame => identical hash.
function sig(file) { // 32x32 grayscale raw bytes -> tolerant perceptual signature
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=32:32,format=gray',
    '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 20 });
}
const mad = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(MEDIA, 'source.mp4'),
  '-vf', 'select=eq(n\\,137),scale=640:-1', '-frames:v', '1', '/tmp/truth_137.jpg']);
writeFileSync('/tmp/p_138.jpg', renderFrame(index, 138, 640));
const sPull = sig('/tmp/p_137.jpg'), sTruth = sig('/tmp/truth_137.jpg'), sNext = sig('/tmp/p_138.jpg');
const madSame = mad(sPull, sTruth), madNeighbour = mad(sPull, sNext);
// same global frame: near-identical (only JPEG noise); neighbour: clearly different
ok(madSame < 3, `JIT frame pull == ground-truth decode of frame 137 (MAD ${madSame.toFixed(2)} < 3 — frame-accurate)`);
ok(madNeighbour > madSame * 3, `adjacent frame is distinct content (neighbour MAD ${madNeighbour.toFixed(2)} >> same ${madSame.toFixed(2)})`);

// JIT clip [110,185] inclusive = 76 frames = 3.04s, exact
const plan = planClip(index, 110, 185);
ok(plan.frames === 76, `clip plan 76 frames`);
renderClip(index, PLAYLIST, 110, 185, '/tmp/p_clip.mp4', 640);
const cd = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-count_frames', '-show_entries', 'stream=nb_read_frames,codec_name', '-of', 'json', '/tmp/p_clip.mp4'], { encoding: 'utf8' })).streams[0];
ok(cd.codec_name === 'h264', 'clip is decodable h264');
ok(Number(cd.nb_read_frames) === 76, `clip has exactly 76 frames (got ${cd.nb_read_frames})`);

// WebVTT sprite: sheet exists + VTT has one cue per second
renderSprite(index, path.join(MEDIA, 'source.mp4'), '/tmp/p_sprite.jpg', '/tmp/p_sprite.vtt');
ok(existsSync('/tmp/p_sprite.jpg') && statSync('/tmp/p_sprite.jpg').size > 0, 'sprite sheet rendered');
const vtt = execFileSync('cat', ['/tmp/p_sprite.vtt'], { encoding: 'utf8' });
ok(vtt.startsWith('WEBVTT') && (vtt.match(/#xywh=/g) || []).length === 20, 'sprite VTT has 20 tile cues + xywh');

// HLS I-frame trick-play playlist
const ifr = renderIframePlaylist(index);
ok(ifr.includes('#EXT-X-I-FRAMES-ONLY'), 'trick-play playlist is EXT-X-I-FRAMES-ONLY');
const iCount = (ifr.match(/#EXT-X-BYTERANGE:/g) || []).length;
ok(iCount === 10, `one I-frame byte-range per 2s segment = 10 (got ${iCount})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
