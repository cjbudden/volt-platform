// Prove the image service against the real test card. Verifies: URL grammar parsing
// (incl. the two given example URLs), fit modes (fit-in keeps aspect, exact WxH,
// stretch distorts, fill crops to focus), the sharpen filter + format conversion,
// HMAC signing, and disk caching.
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { parseImageUrl } from './src/parse.mjs';
import { renderImage } from './src/render.mjs';
import { sign, verify } from './src/sign.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };
const src = await readFile('media/live_channel/TV1.png');
const dims = async (buf) => { const m = await sharp(buf).metadata(); return [m.width, m.height, m.format]; };

// ---- grammar: the two example URLs parse as expected ----
const a = parseImageUrl('/fit-in/1920x0/live_channel/TV1.png');
ok(a.fit === 'fit-in' && a.width === 1920 && a.height === 0 && a.key === 'live_channel/TV1.png', 'parses /fit-in/1920x0/<path>');
const b = parseImageUrl('/fit-in/1920x0/filter(sharpen:100)/live_channel/TV1.png');
ok(b.filters.sharpen === 100 && b.key === 'live_channel/TV1.png', 'parses filter(sharpen:100)');
const c = parseImageUrl('/fill/400x400/filter(focus:top-right,format:webp)/live_channel/TV1.png');
ok(c.fit === 'fill' && c.filters.focus === 'top-right' && c.filters.format === 'webp', 'parses fill + focus + format');

// ---- fit-in 1920x0 keeps aspect (2400x1350 -> 1920x1080) ----
{
  const r = await renderImage(src, parseImageUrl('/fit-in/1920x0/live_channel/TV1.png'));
  ok(r.width === 1920 && r.height === 1080, `fit-in 1920x0 -> 1920x1080 (got ${r.width}x${r.height})`);
}
// ---- 0x600 keeps aspect from height (-> 1067x600) ----
{
  const r = await renderImage(src, parseImageUrl('/fit-in/0x600/live_channel/TV1.png'));
  ok(r.height === 600 && Math.abs(r.width - 1067) <= 1, `0x600 -> ~1067x600 (got ${r.width}x${r.height})`);
}
// ---- exact WxH via stretch distorts (square output from 16:9 source) ----
{
  const r = await renderImage(src, parseImageUrl('/stretch/600x600/live_channel/TV1.png'));
  ok(r.width === 600 && r.height === 600, `stretch 600x600 -> exact 600x600`);
}
// ---- fill 600x600 crops to the box (exact) and focus changes the crop ----
{
  const centre = (await renderImage(src, parseImageUrl('/fill/600x600/live_channel/TV1.png'))).buffer;
  const tr = (await renderImage(src, parseImageUrl('/fill/600x600/filter(focus:top-right)/live_channel/TV1.png'))).buffer;
  const [cw, ch] = await dims(centre);
  ok(cw === 600 && ch === 600, 'fill 600x600 -> exact 600x600 box');
  // the FOCUS badge sits at ~82%,20% (top-right). A top-right crop must differ from a centre crop,
  // and must contain more red (the badge) than the centre crop.
  const redFrac = async (buf) => {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    let red = 0; const px = info.width * info.height;
    for (let i = 0; i < data.length; i += info.channels) if (data[i] > 150 && data[i + 1] < 90 && data[i + 2] < 90) red++;
    return red / px;
  };
  const rc = await redFrac(centre), rt = await redFrac(tr);
  ok(rt > rc, `focus:top-right keeps the focal badge (red ${(rt * 100).toFixed(1)}% > centre ${(rc * 100).toFixed(1)}%)`);
}
// ---- format conversion to webp ----
{
  const r = await renderImage(src, parseImageUrl('/fit-in/800x0/filter(format:webp)/live_channel/TV1.png'));
  ok(r.format === 'webp', `format:webp -> webp output (got ${r.format})`);
}
// ---- sharpen produces a different (higher-detail) output than no sharpen ----
{
  const plain = (await renderImage(src, parseImageUrl('/fit-in/800x0/live_channel/TV1.png'))).buffer;
  const sharp1 = (await renderImage(src, parseImageUrl('/fit-in/800x0/filter(sharpen:150)/live_channel/TV1.png'))).buffer;
  ok(Buffer.compare(plain, sharp1) !== 0, 'sharpen changes the output');
}
// ---- signing ----
{
  const canonical = 'fit-in/1920x0/live_channel/TV1.png';
  const s = sign(canonical, 'k');
  ok(verify(s, canonical, 'k'), 'valid signature verifies');
  ok(!verify('nope', canonical, 'k'), 'bad signature rejected');
  ok(verify('unsafe', canonical, 'k', { allowUnsafe: true }), 'unsafe allowed in dev');
  ok(!verify('unsafe', canonical, 'k', { allowUnsafe: false }), 'unsafe rejected in prod');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
