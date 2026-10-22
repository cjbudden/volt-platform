// ============================================================================
//  SOURCE PREVIEW RELAY: play a channel's HLS input in the console even when
//  the source's server does not allow playback from other sites (no CORS).
//
//  The console first plays an HLS input straight from its own address, which
//  is the truest picture of it. Many contribution CDNs refuse that (no
//  Access-Control-Allow-Origin), while Volt itself pulls them fine. Then the
//  console asks for a relay: the control plane fetches the playlist, rewrites
//  every address in it to come back through here, and passes segments
//  through untouched. It is the same stream, byte for byte.
//
//  WHAT IT WILL FETCH. Only an input configured on a channel or event the caller can
//  see (checked when the preview address is issued), and then only addresses
//  that came out of that input's own playlists: each rewritten address is
//  signed, so the relay cannot be pointed anywhere else. http and https only,
//  playlists capped at 1 MB, segments at 60 MB, every fetch time-limited.
//
//  ADDRESS SHAPE: /api/source-preview/<token>/index.m3u8, where the token
//  names the account, channel and input and expires after two hours. A video
//  element cannot send an Authorization header, so the token is the
//  credential; it grants watching one input and nothing else.
// ============================================================================
import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { one } from '../db';

const TTL_MS = 2 * 3600 * 1000;
const MAX_PLAYLIST = 1024 * 1024;
const MAX_SEGMENT = 60 * 1024 * 1024;
const MAX_HOPS = 5;
const key = () => createHmac('sha256', config.jwt.accessSecret).update('volt-source-preview-v1').digest();
const sign = (s: string) => createHmac('sha256', key()).update(s).digest('base64url');
const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// k: 'event' when the owner is an event (GET /events/:id/inputs/:inputId/preview).
// Absent means a channel, so tokens issued before events had previews still read.
interface Claims { a: string; c: string; i: string; e: number; k?: 'event' }

export function mintPreviewToken(accountId: string, ownerId: string, inputId: string, kind: 'channel' | 'event' = 'channel'): string {
  const claims: Claims = { a: accountId, c: ownerId, i: inputId, e: Date.now() + TTL_MS };
  if (kind === 'event') claims.k = 'event';
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${sign(body)}`;
}
function readToken(t: string): Claims | null {
  const [body, sig] = t.split('.');
  if (!body || !sig || !same(sign(body), sig)) return null;
  try { const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as Claims; return c.e > Date.now() ? c : null; } catch { return null; }
}

/** Fetch over http(s) only, following redirects by hand so every hop is checked. */
async function get(url: string, ms: number): Promise<globalThis.Response> {
  let cur = url;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const u = new URL(cur);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw Object.assign(new Error('Only http and https sources can be previewed'), { status: 400 });
      const r = await fetch(u, { redirect: 'manual', signal: ac.signal, headers: { 'user-agent': 'Volt-Source-Preview/1.0' } });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) { cur = new URL(loc, u).toString(); continue; }
      (r as any).finalUrl = cur;
      return r;
    }
    throw Object.assign(new Error('Too many redirects'), { status: 502 });
  } finally { clearTimeout(t); }
}

async function readCapped(r: globalThis.Response, cap: number): Promise<Buffer | null> {
  if (!r.body) return Buffer.alloc(0);
  const reader = r.body.getReader(); const parts: Buffer[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > cap) { await reader.cancel(); return null; }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

/** Every address in a playlist, made absolute, comes back through the relay, signed. */
export function rewritePlaylist(text: string, base: string, token: string): string {
  const relay = (uri: string, kind: 'pl' | 'seg') => {
    const abs = new URL(uri, base).toString();
    const u = Buffer.from(abs).toString('base64url');
    return `${kind}?u=${u}&s=${sign(`${token}|${kind}|${u}`)}`;
  };
  const lines = text.split(/\r?\n/);
  let nextIsPlaylist = false;
  return lines.map((l) => {
    const t = l.trim();
    if (!t) return l;
    if (t.startsWith('#')) {
      nextIsPlaylist = t.startsWith('#EXT-X-STREAM-INF');
      // URI="..." on EXT-X-MEDIA / I-FRAME-STREAM-INF (playlists), EXT-X-MAP / KEY / PART (bytes)
      return l.replace(/URI="([^"]+)"/g, (_m, uri) => {
        const isPl = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT)/.test(t);
        return `URI="${relay(uri, isPl ? 'pl' : 'seg')}"`;
      });
    }
    const kind = nextIsPlaylist || /\.m3u8?(\?|$)/i.test(t) ? 'pl' : 'seg';
    nextIsPlaylist = false;
    return relay(t, kind);
  }).join('\n');
}

async function inputUrl(c: Claims): Promise<string | null> {
  // The owner table follows the token's kind, so an event's token can never
  // reach a channel's input of the same id, nor the other way round.
  const [table, col] = c.k === 'event' ? ['events', 'event_id'] : ['channels', 'channel_id'];
  const row = await one<{ ingest_url: string | null }>(
    `SELECT si.ingest_url FROM stream_inputs si JOIN ${table} ch ON ch.id = si.${col} JOIN groups g ON g.id = ch.group_id
      WHERE si.id = $1 AND ch.id = $2 AND g.account_id = $3`, [c.i, c.c, c.a]);
  return row?.ingest_url ?? null;
}

async function sendPlaylist(res: Response, url: string, token: string) {
  const r = await get(url, 10_000);
  if (!r.ok) { res.status(502).type('text/plain').send(`The source answered ${r.status}`); return; }
  const buf = await readCapped(r, MAX_PLAYLIST);
  if (!buf) { res.status(502).type('text/plain').send('The source playlist is larger than 1 MB'); return; }
  const text = buf.toString('utf8');
  if (!text.trimStart().startsWith('#EXTM3U')) { res.status(502).type('text/plain').send('The source did not return an HLS playlist'); return; }
  res.set('cache-control', 'no-store').type('application/vnd.apple.mpegurl')
    .send(rewritePlaylist(text, (r as any).finalUrl ?? url, token));
}

function signedTarget(req: Request, kind: 'pl' | 'seg'): string | null {
  const u = String(req.query.u ?? ''); const s = String(req.query.s ?? '');
  if (!u || !s || !same(sign(`${req.params.token}|${kind}|${u}`), s)) return null;
  try { return Buffer.from(u, 'base64url').toString(); } catch { return null; }
}

export const sourcePreviewRouter = Router();
sourcePreviewRouter.use((_req, res, next) => { res.set('access-control-allow-origin', '*'); next(); });

const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
  fn(req, res).catch((e: any) => {
    if (res.headersSent) { res.end(); return; }
    const msg = e?.name === 'AbortError' ? 'The source did not answer in time' : (e?.message || 'Preview failed');
    res.status(e?.status ?? 502).type('text/plain').send(msg);
  });
};

sourcePreviewRouter.get('/:token/index.m3u8', wrap(async (req, res) => {
  const c = readToken(req.params.token);
  if (!c) { res.status(403).type('text/plain').send('This preview address has expired. Reload the page.'); return; }
  const url = await inputUrl(c);
  if (!url) { res.status(404).type('text/plain').send('That input no longer exists'); return; }
  await sendPlaylist(res, url, req.params.token);
}));

sourcePreviewRouter.get('/:token/pl', wrap(async (req, res) => {
  if (!readToken(req.params.token)) { res.status(403).end(); return; }
  const url = signedTarget(req, 'pl');
  if (!url) { res.status(403).end(); return; }
  await sendPlaylist(res, url, req.params.token);
}));

sourcePreviewRouter.get('/:token/seg', wrap(async (req, res) => {
  if (!readToken(req.params.token)) { res.status(403).end(); return; }
  const url = signedTarget(req, 'seg');
  if (!url) { res.status(403).end(); return; }
  const r = await get(url, 20_000);
  if (!r.ok || !r.body) { res.status(502).end(); return; }
  const len = Number(r.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_SEGMENT) { res.status(502).type('text/plain').send('Segment too large to preview'); return; }
  res.status(200).set('cache-control', 'no-store').type(r.headers.get('content-type') || 'application/octet-stream');
  if (Number.isFinite(len) && len > 0) res.set('content-length', String(len));
  const reader = r.body.getReader(); let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_SEGMENT) { await reader.cancel(); break; }
    if (!res.write(Buffer.from(value))) await new Promise((ok) => res.once('drain', ok));
  }
  res.end();
}));
