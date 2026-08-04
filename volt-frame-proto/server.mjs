// Tiny prototype server (Node built-in http, no deps) exposing the frame-addressable
// surface over a chunked origin: JIT single-frame pull, JIT clip, a WebVTT thumbnail
// sprite for scrub, and a standard HLS I-frame trick-play playlist. Plus a browser
// scrubber at /scrub. In production these sit behind playback tokens + a CDN cache;
// here they run against the local media/ segment dir.
import http from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from './index.mjs';
import { renderFrame, renderClip, renderSprite, renderIframePlaylist } from './render.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = path.join(__dir, 'media');
const PLAYLIST = path.join(MEDIA, 'index.m3u8');
const CLIPS = path.join(MEDIA, '_clips'); mkdirSync(CLIPS, { recursive: true });
const PORT = process.env.PORT || 8790;

console.log('building frame index…');
const index = buildIndex(PLAYLIST);
console.log(`index: ${index.totalFrames} frames @ ${index.fps}fps, ${index.segments.length} segments, ${index.durationSec}s`);

// pre-generate the scrub sprite + the I-frame trick-play playlist once
renderSprite(index, path.join(MEDIA, 'source.mp4'), path.join(MEDIA, 'sprite.jpg'), path.join(MEDIA, 'sprite.vtt'));
const IFRAMES = renderIframePlaylist(index);
console.log('sprite + i-frame playlist ready');

const CT = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg', '.vtt': 'text/vtt', '.html': 'text/html; charset=utf-8' };

function sendFile(res, fp) {
  if (!existsSync(fp)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': CT[path.extname(fp)] || 'application/octet-stream', 'content-length': statSync(fp).size });
  createReadStream(fp).pipe(res);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://x`);
  const p = u.pathname;
  try {
    if (p === '/' || p === '/scrub') return sendFile(res, path.join(__dir, 'scrub.html'));
    if (p === '/api/meta') { res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ fps: index.fps, totalFrames: index.totalFrames, durationSec: index.durationSec,
        segments: index.segments.map(s => ({ i: s.i, startFrame: s.startFrame, frames: s.frames })) })); }
    if (p === '/api/frame') {
      const n = parseInt(u.searchParams.get('n') || '0', 10);
      const w = parseInt(u.searchParams.get('w') || '640', 10);
      const jpg = renderFrame(index, n, w);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public,max-age=31536000', 'content-length': jpg.length });
      return res.end(jpg);
    }
    if (p === '/api/iframes.m3u8') { res.writeHead(200, { 'content-type': CT['.m3u8'] }); return res.end(IFRAMES); }
    if (p === '/api/clip') {
      const inN = parseInt(u.searchParams.get('in'), 10), outN = parseInt(u.searchParams.get('out'), 10);
      const name = `clip-${inN}-${outN}.mp4`;
      const outPath = path.join(CLIPS, name);
      const plan = renderClip(index, PLAYLIST, inN, outN, outPath);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ url: `/media/_clips/${name}`, ...plan }));
    }
    if (p.startsWith('/media/')) return sendFile(res, path.join(MEDIA, p.slice('/media/'.length)));
    if (p === '/sprite.jpg') return sendFile(res, path.join(MEDIA, 'sprite.jpg'));
    if (p === '/sprite.vtt') return sendFile(res, path.join(MEDIA, 'sprite.vtt'));
    res.writeHead(404).end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(e && e.message || e));
  }
});
server.listen(PORT, () => console.log(`frame-proto on http://localhost:${PORT}/scrub`));
