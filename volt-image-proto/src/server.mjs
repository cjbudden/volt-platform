// On-the-fly image service (prototype). Parses the URL grammar, renders with sharp,
// and caches the derivative on disk keyed by the canonical request. A CDN sits in
// front in production; the origin is S3 (here: local media/).
import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseImageUrl } from './parse.mjs';
import { renderImage } from './render.mjs';
import { verify } from './sign.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, '..');
const MEDIA = path.join(ROOT, 'media');           // origin (S3 in prod)
const CACHE = path.join(ROOT, '.cache');          // derivative cache (S3/CDN in prod)
const SECRET = process.env.IMG_SECRET || 'dev-secret';
const ALLOW_UNSAFE = process.env.IMG_ALLOW_UNSAFE !== '0';
const PORT = process.env.PORT || 8791;
await mkdir(CACHE, { recursive: true });

const CT = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' };

const server = http.createServer(async (req, res) => {
  const t0 = process.hrtime.bigint();
  try {
    if (req.url === '/gallery' || req.url === '/') return sendFile(res, path.join(ROOT, 'gallery.html'), 'text/html');
    const spec = parseImageUrl(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!verify(spec.sig, spec.canonical, SECRET, { allowUnsafe: ALLOW_UNSAFE })) {
      res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('bad signature');
    }
    const cacheKey = createHash('sha256').update(spec.canonical).digest('hex');
    const cachePath = path.join(CACHE, cacheKey);
    // cache HIT
    try {
      const buf = await readFile(cachePath);
      const meta = JSON.parse(await readFile(cachePath + '.json', 'utf8'));
      res.writeHead(200, { 'content-type': CT[meta.format] || 'application/octet-stream',
        'x-cache': 'HIT', 'cache-control': 'public,max-age=31536000,immutable',
        'x-render-ms': ms(t0), 'content-length': buf.length });
      return res.end(buf);
    } catch { /* miss */ }
    // render
    const src = path.join(MEDIA, spec.key);
    let input; try { input = await readFile(src); } catch { res.writeHead(404).end('source not found'); return; }
    const out = await renderImage(input, spec);
    await writeFile(cachePath, out.buffer);
    await writeFile(cachePath + '.json', JSON.stringify({ format: out.format, width: out.width, height: out.height }));
    res.writeHead(200, { 'content-type': CT[out.format] || 'application/octet-stream',
      'x-cache': 'MISS', 'cache-control': 'public,max-age=31536000,immutable',
      'x-image-size': `${out.width}x${out.height}`, 'x-render-ms': ms(t0), 'content-length': out.buffer.length });
    res.end(out.buffer);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/plain' }); res.end('error: ' + (e && e.message || e));
  }
});
function ms(t0) { return (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1); }
async function sendFile(res, fp, ct) { try { const b = await readFile(fp); res.writeHead(200, { 'content-type': ct }); res.end(b); } catch { res.writeHead(404).end(); } }
server.listen(PORT, () => console.log(`image service on http://localhost:${PORT}/  (unsafe=${ALLOW_UNSAFE})`));
