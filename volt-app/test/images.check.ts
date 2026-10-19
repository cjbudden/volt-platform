// ============================================================================
//  IMAGE SERVICE: the whole contract, no database, no network.
//
//  SDK maths (sha256/hmac against node:crypto), SDK == server signatures,
//  both URL grammars, every guard, per-account keys and rotation, the sharp
//  pipeline (fits, focus, crop, formats, EXIF, SVG, bombs), the cache layers
//  (memory, local disk, S3 via a fake client), single-flight, the busy limiter,
//  the public HTTP route (403/200/304/HEAD/headers) and the signing API.
//
//  Usage: npx tsx test/images.check.ts      (also run by `npm run check`)
// ============================================================================
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { imageServiceConfig } from '../src/config';
import * as sdk from '../src/services/images/sdk';
import { parseImageRequest, ImageError, type ImageLimits } from '../src/services/images/grammar';
import { accountSigningKey, signWithAccountKey, verifyImageSignature, assertSigningConfigured } from '../src/services/images/signing';
import { renderImage } from '../src/services/images/render';
import { ImageService, typeFromCacheKey, type SourceStore } from '../src/services/images/service';
import { LocalDerivativeCache, S3DerivativeCache, MemoryLru, Limiter, BusyError, NoDerivativeCache } from '../src/services/images/cache';
import { imagesPublicRouter, setImageService, signForAccount, splitImagePath } from '../src/modules/images';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));
async function rejects(m: string, fn: () => unknown, status: number) {
  try { await fn(); bad(m, `expected ImageError ${status}, it succeeded`); }
  catch (e: any) { e instanceof ImageError && e.status === status ? ok(m) : bad(m, `expected ${status}, got ${e?.status ?? ''} ${e?.message}`); }
}

const ACC = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const SECRET = 'test-image-signing-secret-0123456789abcdef';
const LIMITS: ImageLimits = { maxDimension: 4096, maxOutputPixels: 4096 * 4096, formats: ['webp', 'avif', 'jpeg', 'png'] };

const root = mkdtempSync(join(tmpdir(), 'volt-images-'));
const storeDir = join(root, 'store');
const cacheDir = join(root, 'cache');

class DirStore implements SourceStore {
  gets = 0;
  async get(k: string) { this.gets++; try { return readFileSync(join(storeDir, k)); } catch { return null; } }
  async stat(k: string) { try { return { size: statSync(join(storeDir, k)).size }; } catch { return null; } }
}
function putSource(key: string, body: Buffer) {
  mkdirSync(dirname(join(storeDir, key)), { recursive: true });
  writeFileSync(join(storeDir, key), body);
}
function cfg(over: Record<string, string> = {}) {
  return imageServiceConfig({
    IMAGE_SIGNING_SECRET: SECRET, IMAGE_CACHE_DIR: cacheDir, IMAGE_PUBLIC_BASE_URL: 'https://img.test', ...over,
  } as NodeJS.ProcessEnv);
}
const keyFor = (acct: string) => accountSigningKey(SECRET, acct);
const signRest = (acct: string, rest: string) => signWithAccountKey(keyFor(acct), rest);

// 1200x800 card: grey field, a red badge in the top-right corner, a blue one bottom-left.
async function card(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
    <rect width="1200" height="800" fill="#808080"/>
    <rect x="1000" y="0" width="200" height="200" fill="#ff0000"/>
    <rect x="0" y="600" width="200" height="200" fill="#0000ff"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
async function redShare(buf: Buffer): Promise<number> {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let red = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) red++;
  return red / (info.width * info.height);
}
const dims = async (b: Buffer) => { const m = await sharp(b).metadata(); return `${m.width}x${m.height}`; };
const fmtOf = async (b: Buffer) => (await sharp(b).metadata()).format;

async function main() {
  // ------------------------------------------------------------ 1. SDK maths
  for (const s of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000), 'héllo wörld ✓ 日本 🙂']) {
    const want = createHash('sha256').update(s, 'utf8').digest('hex');
    check(`sdk sha256 matches node (len ${s.length})`, Buffer.from(sdk.sha256(sdk.utf8(s))).toString('hex'), want);
  }
  for (const klen of [0, 16, 64, 65, 200]) {
    const k = randomBytes(klen);
    const want = createHmac('sha256', k).update('message ✓').digest('hex');
    check(`sdk hmac matches node (key ${klen}B)`, Buffer.from(sdk.hmacSha256(new Uint8Array(k), sdk.utf8('message ✓'))).toString('hex'), want);
  }
  for (const n of [0, 1, 2, 3, 16, 31, 32]) {
    const b = randomBytes(n);
    check(`base64url round trip ${n}B`, Buffer.from(sdk.fromBase64Url(sdk.toBase64Url(new Uint8Array(b)))).toString('hex'), b.toString('hex'));
    check(`base64url matches node ${n}B`, sdk.toBase64Url(new Uint8Array(b)), b.toString('base64url'));
  }

  // ------------------------------------------- 2. SDK == server signatures
  const ak = keyFor(ACC);
  const rest = `640x360,cover,focus=30-20/library/${ACC}/slates/a b ✓.png`;
  check('SDK signature equals server signature', sdk.signImagePath(ak, rest), signRest(ACC, rest));
  check('signature is 22 chars', sdk.signImagePath(ak, rest).length, sdk.IMAGE_SIG_LENGTH);
  check('imageSpec is canonical', sdk.imageSpec({ format: 'png', width: 640, height: 360, grayscale: true, focus: { x: 30, y: 20 }, quality: 70 }),
    '640x360,cover,focus=30-20,gray,q=70,fmt=png');
  check('imageSpec omits defaults', sdk.imageSpec({ width: 320, height: 0, quality: 80, format: 'webp', brightness: 100 }), '320x0,cover');
  const url = sdk.imageUrl({ baseUrl: 'https://img.test/', key: `/library/${ACC}/slates/a b ✓.png`, accountKey: ak, width: 640, height: 360, focus: { x: 30, y: 20 } });
  truthy('imageUrl encodes the key per segment', url.startsWith('https://img.test/img/') && url.endsWith('/library/' + ACC + '/slates/a%20b%20%E2%9C%93.png'));
  check('accountOfKey', sdk.accountOfKey(`library/${ACC}/x.png`), ACC);
  check('accountOfKey rejects other roots', sdk.accountOfKey(`private/${ACC}/x.png`), null);

  // ------------------------------------------------------------ 3. grammar
  let p = parseImageRequest(`640x360,cover,focus=30-20,gray,blur=2.5,bright=120,sat=0,sharp,q=70,fmt=avif,v=abc1/library/${ACC}/a.png`, LIMITS);
  check('compact: size', `${p.spec.w}x${p.spec.h}`, '640x360');
  check('compact: focus', JSON.stringify(p.spec.focus), '{"x":30,"y":20}');
  check('compact: filters', [p.spec.gray, p.spec.blur, p.spec.bright, p.spec.sat, p.spec.sharpen, p.spec.q, p.spec.fmt, p.spec.version].join('|'),
    'true|2.5|120|0|1|70|avif|abc1');
  check('compact: default enlarge false', p.spec.enlarge, false);
  p = parseImageRequest(`fit-in/1920x0/library/${ACC}/live_channel/TV1.png`, LIMITS);
  check('path style: fit-in -> inside, auto height, png from source', `${p.style} ${p.spec.fit} ${p.spec.w}x${p.spec.h} ${p.spec.fmt}`, 'path inside 1920x0 png');
  p = parseImageRequest(`fit-in/1920x0/filter(sharpen:100,format:webp)/library/${ACC}/live_channel/TV1.png`, LIMITS);
  check('path style: filter(sharpen:100,format:webp)', `${p.spec.sharpen} ${p.spec.fmt}`, '1.5 webp');
  p = parseImageRequest(`fill/500x500/filter(focus:top-right,format:jpg,quality:60)/library/${ACC}/a.jpg`, LIMITS);
  check('path style: fill + gravity + jpg alias', `${p.spec.fit} ${p.spec.gravity} ${p.spec.fmt} ${p.spec.q}`, 'cover top-right jpeg 60');
  p = parseImageRequest(`fit-in/800x450/filter(background:0b1020)/library/${ACC}/a.png`, LIMITS);
  check('path style: fit-in + background letterboxes', `${p.spec.fit} ${p.spec.bg}`, 'contain 0b1020');
  p = parseImageRequest(`stretch/600x600/library/${ACC}/a.png`, LIMITS);
  check('path style: stretch -> fill', p.spec.fit, 'fill');
  p = parseImageRequest(`fill/600x300/filter(focus:0.8x0.2)/library/${ACC}/a.png`, LIMITS);
  check('path style: normalised focus point', JSON.stringify(p.spec.focus), '{"x":80,"y":20}');
  p = parseImageRequest(`1920x0/filter(grayscale)/library/${ACC}/a.png`, LIMITS);
  check('path style without a fit segment', `${p.style} ${p.spec.gray}`, 'path true');

  await rejects('unknown option is refused', () => parseImageRequest(`64x64,cover,wobble/library/${ACC}/a.png`, LIMITS), 400);
  await rejects('duplicate option is refused', () => parseImageRequest(`64x64,cover,inside/library/${ACC}/a.png`, LIMITS), 400);
  await rejects('0x0 is refused', () => parseImageRequest(`0x0,cover/library/${ACC}/a.png`, LIMITS), 400);
  await rejects('over max dimension is refused, not clamped', () => parseImageRequest(`5000x10,cover/library/${ACC}/a.png`, LIMITS), 400);
  await rejects('over max pixels is refused', () => parseImageRequest(`4000x4000,cover/library/${ACC}/a.png`, { ...LIMITS, maxOutputPixels: 1e6 }), 400);
  await rejects('disabled format is refused', () => parseImageRequest(`64x64,cover,fmt=avif/library/${ACC}/a.png`, { ...LIMITS, formats: ['webp'] }), 400);
  await rejects('q out of range', () => parseImageRequest(`64x64,cover,q=0/library/${ACC}/a.png`, LIMITS), 400);
  await rejects('crop outside the image', () => parseImageRequest(`64x64,cover,crop=60-0-50-100/library/${ACC}/a.png`, LIMITS), 400);
  await rejects('bad background', () => parseImageRequest(`64x64,contain,bg=red/library/${ACC}/a.png`, LIMITS), 400);
  await rejects('unknown path-style filter', () => parseImageRequest(`fit-in/64x64/filter(wobble:1)/library/${ACC}/a.png`, LIMITS), 400);
  await rejects('relative segment in key', () => parseImageRequest(`64x64,cover/library/${ACC}/../${OTHER}/a.png`, LIMITS), 400);
  await rejects('key outside library/derived', () => parseImageRequest(`64x64,cover/secrets/${ACC}/a.png`, LIMITS), 404);
  await rejects('non-image extension', () => parseImageRequest(`64x64,cover/library/${ACC}/a.mp4`, LIMITS), 415);
  await rejects('missing key', () => parseImageRequest(`64x64,cover`, LIMITS), 400);

  // ------------------------------------------------------------ 4. signing
  const r1 = `64x64,cover/library/${ACC}/a.png`;
  truthy('valid signature verifies', verifyImageSignature(signRest(ACC, r1), r1, ACC, [SECRET]));
  check('account A key cannot sign account B images', verifyImageSignature(signRest(ACC, `64x64,cover/library/${OTHER}/a.png`), `64x64,cover/library/${OTHER}/a.png`, OTHER, [SECRET]), false);
  check('tampered spec fails', verifyImageSignature(signRest(ACC, r1), r1.replace('64x64', '65x64'), ACC, [SECRET]), false);
  check('"unsafe" is not a signature', verifyImageSignature('unsafe', r1, ACC, [SECRET]), false);
  truthy('previous secret still verifies during rotation',
    verifyImageSignature(signWithAccountKey(accountSigningKey('old-secret', ACC), r1), r1, ACC, ['new-secret', 'old-secret']));
  check('retired secret no longer verifies',
    verifyImageSignature(signWithAccountKey(accountSigningKey('old-secret', ACC), r1), r1, ACC, ['new-secret', '']), false);
  let threw = false; try { assertSigningConfigured('', true); } catch { threw = true; }
  truthy('production refuses to boot without a secret', threw);
  threw = false; try { assertSigningConfigured('dev-image-signing-secret', true); } catch { threw = true; }
  truthy('production refuses the dev secret', threw);
  threw = false; try { assertSigningConfigured(SECRET, true); } catch { threw = true; }
  check('production accepts a real secret', threw, false);
  check('dev default secret exists so local runs need no setup', imageServiceConfig({} as any).signingSecret.length > 0, true);
  check('production default secret is empty (must be set)', imageServiceConfig({ NODE_ENV: 'production' } as any).signingSecret, '');

  // ------------------------------------------------------------ 5. render
  const src = await card();
  const R = { maxInputPixels: 100_000_000, timeoutSeconds: 20 };
  const spec = (s: string) => parseImageRequest(`${s}/library/${ACC}/a.png`, LIMITS).spec;
  check('inside 600x0 keeps aspect', await dims((await renderImage(src, spec('600x0,inside'), R)).buffer), '600x400');
  check('inside 0x200 keeps aspect', await dims((await renderImage(src, spec('0x200,inside'), R)).buffer), '300x200');
  check('cover 300x300 exact box', await dims((await renderImage(src, spec('300x300,cover'), R)).buffer), '300x300');
  check('fill (stretch) exact', await dims((await renderImage(src, spec('300x500,fill'), R)).buffer), '300x500');
  check('contain + bg letterboxes to the box', await dims((await renderImage(src, spec('400x400,contain,bg=000000'), R)).buffer), '400x400');
  check('no enlargement by default', await dims((await renderImage(src, spec('2400x0,inside'), R)).buffer), '1200x800');
  check('up allows enlargement', await dims((await renderImage(src, spec('2400x0,inside,up'), R)).buffer), '2400x1600');
  const tr = await redShare((await renderImage(src, spec('200x200,cover,focus=top-right,fmt=png'), R)).buffer);
  const ctr = await redShare((await renderImage(src, spec('200x200,cover,fmt=png'), R)).buffer);
  truthy(`gravity top-right keeps the red badge (${tr.toFixed(3)} vs centre ${ctr.toFixed(3)})`, tr > 0.05 && ctr < 0.01);
  const fp = await redShare((await renderImage(src, spec('200x200,cover,focus=95-5,fmt=png'), R)).buffer);
  truthy(`focus point 95-5 keeps the red badge (${fp.toFixed(3)})`, fp > 0.05);
  const cr = await renderImage(src, spec('100x100,cover,crop=0-75-25-25,fmt=png'), R);
  const { data: px } = await sharp(cr.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  truthy('crop keeps the bottom-left blue badge', px[2] > 200 && px[0] < 60);
  await renderImage(src, spec('300x200,cover,focus=smart'), R).then(() => ok('smart (attention) crop renders'), (e) => bad('smart crop', e.message));
  for (const f of ['webp', 'avif', 'jpeg', 'png'] as const) {
    const out = await renderImage(src, spec(`120x80,cover,fmt=${f}`), R);
    check(`format ${f} encodes`, await fmtOf(out.buffer) === (f === 'avif' ? 'heif' : f) && out.contentType === `image/${f}`, true);
  }
  const g = await renderImage(src, spec('60x40,cover,gray,fmt=png'), R);
  const gs = await sharp(g.buffer).stats();
  truthy('gray removes colour', Math.abs(gs.channels[0].mean - gs.channels[1].mean) < 1);
  const rotated = await sharp(src).resize(300, 200).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  check('EXIF orientation applied before sizing', await dims((await renderImage(rotated, spec('100x0,inside'), R)).buffer), '100x150');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#f00"/></svg>');
  const sv = await renderImage(svg, spec('400x0,inside,fmt=png'), R);
  check('SVG is rasterised sharp at the requested size', await dims(sv.buffer), '400x200');
  check('SVG output is a raster, never svg', sv.contentType, 'image/png');
  await rejects('decompression bomb is refused', () => renderImage(src, spec('10x10,cover'), { ...R, maxInputPixels: 1000 }), 413);
  try { await renderImage(Buffer.from('definitely not an image'), spec('10x10,cover'), R); bad('garbage input refused', 'rendered'); }
  catch (e: any) { truthy(`garbage input refused (${e.status})`, e instanceof ImageError && [415, 422].includes(e.status)); }

  // ------------------------------------------------------------ 6. service + caches
  const KEY = `library/${ACC}/slates/card one.png`;
  putSource(KEY, src);
  const store = new DirStore();
  let svc = new ImageService(cfg(), store, new LocalDerivativeCache(cacheDir, typeFromCacheKey));
  const rest6 = `320x200,cover,fmt=jpeg/${KEY}`;
  const sig6 = signRest(ACC, rest6);
  let res = await svc.handle(sig6, rest6);
  check('first request renders (MISS)', res.cache, 'MISS');
  check('rendered size', await dims(res.body), '320x200');
  check('content type from spec', res.contentType, 'image/jpeg');
  res = await svc.handle(sig6, rest6);
  check('second request from memory', res.cache, 'MEMORY');
  await new Promise((r) => setTimeout(r, 50));    // background cache write
  truthy('derivative written to the cache at the request path', existsSync(join(cacheDir, 'img', sig6, rest6)));
  svc = new ImageService(cfg(), store, new LocalDerivativeCache(cacheDir, typeFromCacheKey));
  res = await svc.handle(sig6, rest6);
  check('a fresh task reads the shared cache (HIT)', res.cache, 'HIT');
  check('cache HIT keeps the content type', res.contentType, 'image/jpeg');
  await rejects('unsigned request is refused', () => svc.handle('unsafe', rest6), 403);
  await rejects('wrong signature is refused', () => svc.handle(sig6.replace(/^./, sig6[0] === 'A' ? 'B' : 'A'), rest6), 403);
  await rejects('signature for another account is refused', () => svc.handle(signRest(OTHER, rest6), rest6), 403);
  const missing = `64x64,cover/library/${ACC}/nope.png`;
  await rejects('missing source is 404', () => svc.handle(signRest(ACC, missing), missing), 404);
  const big = new ImageService(cfg({ IMAGE_MAX_SOURCE_BYTES: '100' }), new DirStore(), new NoDerivativeCache());
  const bigRest = `64x64,cover/${KEY}`;
  await rejects('source over the byte limit is 413', () => big.handle(signRest(ACC, bigRest), bigRest), 413);

  // single flight: ten concurrent identical requests, one render
  const sf = new ImageService(cfg(), new DirStore(), new NoDerivativeCache());
  const sfRest = `500x300,cover,q=55/${KEY}`;
  const sfSig = signRest(ACC, sfRest);
  await Promise.all(Array.from({ length: 10 }, () => sf.handle(sfSig, sfRest)));
  check('ten concurrent identical requests render once', sf.stats.renders, 1);

  // limiter: one slot, no queue, distinct URLs -> 503 for the overflow
  const busy = new ImageService(cfg({ IMAGE_MAX_CONCURRENT: '1', IMAGE_MAX_QUEUE: '1' }), new DirStore(), new NoDerivativeCache());
  (busy as any).limiter = new Limiter(1, 0);
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => {
    const r = `${200 + i}x100,cover/${KEY}`;
    return busy.handle(signRest(ACC, r), r);
  }));
  const s503 = outcomes.filter((o) => o.status === 'rejected' && (o.reason as any).status === 503).length;
  truthy(`saturated renderer answers 503 (${s503} of 4)`, s503 >= 1 && outcomes.some((o) => o.status === 'fulfilled'));
  const lim = new Limiter(2, 10);
  let peak = 0, live = 0;
  await Promise.all(Array.from({ length: 12 }, () => lim.run(async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; })));
  check('limiter never exceeds its concurrency', peak, 2);
  let busyThrown = false;
  const l0 = new Limiter(1, 0);
  const hold = l0.run(() => new Promise((r) => setTimeout(r, 20)));
  try { await l0.run(async () => 1); } catch (e) { busyThrown = e instanceof BusyError; }
  await hold;
  truthy('limiter refuses beyond its queue', busyThrown);

  const lru = new MemoryLru<{ body: Buffer }>(1000);
  lru.set('a', { body: Buffer.alloc(100) }); lru.set('b', { body: Buffer.alloc(100) });
  lru.get('a');
  for (let i = 0; i < 9; i++) lru.set('x' + i, { body: Buffer.alloc(100) });
  check('LRU keeps the recently used entry and evicts the stale one', [lru.get('a') ? 'a' : '-', lru.get('b') ? 'b' : '-'].join(''), 'a-');
  check('LRU respects its byte cap', lru.usedBytes <= 1000, true);
  lru.set('huge', { body: Buffer.alloc(500) });
  check('LRU skips entries over 1/8 of the cap', lru.get('huge'), undefined);

  let escaped = false;
  try { await new LocalDerivativeCache(cacheDir, typeFromCacheKey).put('../outside.png', Buffer.from('x')); } catch { escaped = true; }
  truthy('local cache refuses a path outside its directory', escaped);

  // S3 cache with a fake client
  const objects = new Map<string, any>();
  const fakeS3 = {
    async send(cmd: any) {
      const name = cmd.constructor.name, inp = cmd.input;
      if (name === 'PutObjectCommand') { objects.set(`${inp.Bucket}/${inp.Key}`, inp); return {}; }
      if (name === 'GetObjectCommand') {
        const o = objects.get(`${inp.Bucket}/${inp.Key}`);
        if (!o) throw Object.assign(new Error('nope'), { name: 'NoSuchKey' });
        return { Body: (async function* () { yield o.Body; })(), ContentType: o.ContentType };
      }
      throw new Error('unexpected ' + name);
    },
  };
  const s3c = new S3DerivativeCache('img-bucket', 'img-cache', 'ap-southeast-2', fakeS3);
  check('S3 cache miss returns null', await s3c.get('img/x/y.png'), null);
  const s3svc = new ImageService(cfg(), new DirStore(), s3c);
  const s3rest = `160x100,cover,fmt=png/${KEY}`;
  const s3sig = signRest(ACC, s3rest);
  await s3svc.handle(s3sig, s3rest);
  await new Promise((r) => setTimeout(r, 20));
  const put = objects.get(`img-bucket/img-cache/img/${s3sig}/${s3rest}`);
  truthy('S3 cache object written at prefix + request path (what CloudFront reads)', !!put);
  check('S3 object carries its content type', put?.ContentType, 'image/png');
  check('S3 object carries immutable Cache-Control', put?.CacheControl, 'public, max-age=31536000, immutable');
  const s3svc2 = new ImageService(cfg(), new DirStore(), s3c);
  check('a fresh task HITs the S3 cache', (await s3svc2.handle(s3sig, s3rest)).cache, 'HIT');

  // ------------------------------------------------------------ 7. HTTP
  setImageService(new ImageService(cfg(), new DirStore(), new LocalDerivativeCache(join(root, 'http-cache'), typeFromCacheKey)));
  const app = express();
  app.use('/img', imagesPublicRouter());
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    let r = await fetch(`${base}/img/320x200,cover/${encodeURI(KEY)}`);
    check('old unsigned /img URL is refused', r.status, 403);
    r = await fetch(`${base}/img/unsafe/fit-in/320x0/${encodeURI(KEY)}`);
    check('"unsafe" path is refused', r.status, 403);
    const u = sdk.imageUrl({ baseUrl: base, key: KEY, accountKey: ak, width: 320, height: 200, focus: { x: 90, y: 10 } });
    r = await fetch(u);
    check('signed SDK URL renders 200', r.status, 200);
    check('content type', r.headers.get('content-type'), 'image/webp');
    check('immutable cache control', r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    check('cache header MISS first', r.headers.get('x-image-cache'), 'MISS');
    check('nosniff', r.headers.get('x-content-type-options'), 'nosniff');
    check('CORS open for <img> and canvas', r.headers.get('access-control-allow-origin'), '*');
    truthy('render timing exposed', /render;dur=\d+/.test(r.headers.get('server-timing') ?? ''));
    const body = Buffer.from(await r.arrayBuffer());
    check('HTTP body is the rendered size', await dims(body), '320x200');
    const etag = r.headers.get('etag')!;
    r = await fetch(u);
    check('second fetch from memory', r.headers.get('x-image-cache'), 'MEMORY');
    r = await fetch(u, { headers: { 'If-None-Match': etag } });
    check('If-None-Match answers 304', r.status, 304);
    r = await fetch(u, { method: 'HEAD' });
    check('HEAD answers 200 with length', r.status === 200 && Number(r.headers.get('content-length')) > 0, true);
    const legacy = await signForAccount(ACC, { path: 'slates/card one.png', fit: 'fit-in', width: 640, height: 360,
      filters: { format: 'jpeg', quality: 82, sharpen: 60 }, expiresIn: 3600 }, LIMITS, SECRET, base, async () => null);
    r = await fetch(legacy.url);
    check('first published sign contract still works end to end', r.status, 200);
    check('legacy fit-in -> inside 640x360 box keeps aspect', await dims(Buffer.from(await r.arrayBuffer())), '540x360');
    r = await fetch(`${base}/img/${sdk.signImagePath(ak, `99999x1,cover/${KEY}`)}/99999x1,cover/${encodeURI(KEY)}`);
    check('signed but oversized is 400', r.status, 400);
    check('4xx is briefly cacheable at the edge', r.headers.get('cache-control'), 'public, max-age=300');
    r = await fetch(`${base}/img/${'A'.repeat(22)}/64x64,cover/library%2F${ACC}%2Fx.png`);
    check('encoded slash is refused', r.status, 400);
  } finally {
    server.close();
  }
  let split: any = null; try { split = splitImagePath('/abc/64x64,cover/library/x/%E0%A4%A.png'); } catch (e: any) { split = e.status; }
  check('malformed percent-encoding is 400', split, 400);

  // ------------------------------------------------------------ 8. signing API
  const s1 = await signForAccount(ACC, { path: 'posters/final.jpg', width: 1280, height: 720, format: 'avif', quality: 60 }, LIMITS, SECRET, 'https://img.test', async () => '20261015120000');
  check('sign: account-relative path is put under the account', s1.key, `library/${ACC}/posters/final.jpg`);
  check('sign: spec', s1.spec, '1280x720,cover,q=60,fmt=avif,v=20261015120000');
  truthy('sign: url on the image base', s1.url.startsWith('https://img.test/img/' + s1.signature + '/'));
  truthy('sign: signature verifies on the render path', verifyImageSignature(s1.signature, `${s1.spec}/${s1.key}`, ACC, [SECRET]));
  check('sign: no expiry (cache-friendly)', s1.expires, null);
  let st = 0; try { await signForAccount(ACC, { key: `library/${OTHER}/x.png`, width: 10 }, LIMITS, SECRET, '', async () => null); } catch (e: any) { st = e.status; }
  check('sign: another account\'s image is 403', st, 403);
  st = 0; try { await signForAccount(ACC, { path: 'x.png', width: 9000 }, LIMITS, SECRET, '', async () => null); } catch (e: any) { st = e.status; }
  check('sign: guards apply before signing (400)', st, 400);
  st = 0; try { await signForAccount(ACC, { path: 'x.png' }, LIMITS, SECRET, '', async () => null); } catch (e: any) { st = e.status; }
  check('sign: a size is required (400)', st, 400);
  const s2 = await signForAccount(ACC, { path: 'x.png', spec: '200x100,inside,gray' }, LIMITS, SECRET, '', async () => null);
  check('sign: raw spec passes through', s2.spec, '200x100,inside,gray');

  // ------------------------------------------------------------ 9. copies of the SDK
  const sdkSrc = readFileSync(join(__dirname, '../src/services/images/sdk.ts'), 'utf8');
  for (const copy of ['../../packages/image-url/src/index.ts', '../../volt-web/src/lib/imageUrl.ts']) {
    const pth = join(__dirname, copy);
    if (!existsSync(pth)) { bad(`SDK copy ${copy}`, 'missing; run node packages/image-url/scripts/sync.js'); continue; }
    check(`SDK copy ${copy} is in sync`, readFileSync(pth, 'utf8') === sdkSrc, true);
  }

  rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
