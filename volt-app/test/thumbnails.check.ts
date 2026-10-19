// ============================================================================
//  ENCODER THUMBNAILS + LIBRARY METADATA, end to end.
//
//  Naming rules (time zones, repeated hours, slugs), cue and VTT maths, image
//  metadata extraction (EXIF, GPS, IPTC/XMP), library search SQL, and a real
//  build: the suite ENCODES three minutes of moving test picture into an origin
//  run with the encoder's segment shape, builds that hour, and checks the
//  stills, sheets, VTT, database rows, folder layout and a clip's re-timed VTT.
//
//  Usage: DATABASE_URL=... npx tsx test/thumbnails.check.ts
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'volt-thumbs-'));
process.env.IMAGE_STORE_DIR = join(ROOT, 'store');
process.env.ORIGIN_DIR = join(ROOT, 'origin');
process.env.IMAGE_SIGNING_SECRET = 'thumbnails-check-signing-secret-0123456789';
process.env.IMAGE_PUBLIC_BASE_URL = 'https://img.test';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));

const ACC = '0000000a-0000-0000-0000-0000000079a1';
const GRP = '0000000d-0000-0000-0000-0000000079a1';
const CH = '0000000e-0000-0000-0000-0000000079a1';
const VOD = '0000000f-0000-0000-0000-0000000079a1';
const SEG_S = 4, DUR_S = 180;

async function main() {
  const N = await import('../src/services/thumbnails/naming');
  const { readImageFacts } = await import('../src/services/images/metadata');
  const { buildFileSearch, prefixQuery, matchFolders, childFolders } = await import('../src/services/mediaSearch');
  const sharp = (await import('sharp')).default;

  // ------------------------------------------------------------ 1. naming
  const bne = 'Australia/Brisbane';
  const t0 = Date.UTC(2026, 9, 16, 8, 7, 5);          // 18:07:05 in Brisbane
  const p = N.localParts(t0, bne);
  check('local parts in the channel zone', `${p.date} ${p.hh}:${p.mm}:${p.ss}`, '2026-10-16 18:07:05');
  const u = N.hourUnit(t0, bne);
  check('hour unit starts on the local hour', new Date(u.start).toISOString(), '2026-10-16T08:00:00.000Z');
  check('and lasts an hour', u.end - u.start, 3600_000);
  check('folder label is the local hour', `${u.date}/${u.label}`, '2026-10-16/18');
  const ind = N.hourUnit(Date.UTC(2026, 9, 16, 8, 7, 5), 'Asia/Kolkata');  // 13:37 IST
  check('half-hour zones get local-hour units', new Date(ind.start).toISOString(), '2026-10-16T07:30:00.000Z');
  // Europe/London, 25 Oct 2026: 01:00-02:00 happens twice (BST then GMT)
  const first = N.hourUnit(Date.UTC(2026, 9, 25, 0, 30), 'Europe/London');
  const second = N.hourUnit(Date.UTC(2026, 9, 25, 1, 30), 'Europe/London');
  check('a repeated hour keeps its label the first time', first.label, '01');
  check('and gets a "b" the second time', second.label, '01b');
  check('repeated hours are different units', second.start - first.start, 3600_000);
  check('units cover a span hour by hour', N.unitsBetween(u.start, u.start + 3 * 3600_000, bne).length, 3);
  check('slugs are safe and readable', N.slugify('Évening News: Live! (HD)'), 'Evening-News-Live-HD');
  check('empty names still name something', N.slugify('!!!'), 'untitled');
  check('frame names are name-date-time', N.frameName('Grand-Final', t0, bne), 'Grand-Final-20261016-180705.jpg');
  check('sheet names carry the 10-minute block', N.sheetName('News', u, u.start + 600_000, bne), 'News-20261016-18-m10.jpg');
  check('VTT is named per hour', N.vttName('News', u), 'News-20261016-18.vtt');
  check('VTT time format', N.vttTime(3723_456), '01:02:03.456');

  const L = { tileW: 160, tileH: 90, cols: 10, rows: 6, intervalMs: 10_000 };
  const unit = { ...L, unitStart: u.start, unitEnd: u.end, sheets: [
    { key: 'library/a/s/m00.jpg', start_ms: u.start, slots: 60, filled: [0, 1, 2, 11] },
    { key: 'library/a/s/m10.jpg', start_ms: u.start + 600_000, slots: 60, filled: [0] },
  ] };
  const cues = N.cuesBetween([unit], u.start, u.end);
  check('one cue per filled tile', cues.length, 5);
  check('tile 11 sits on row 2, column 2', `${cues[3].x},${cues[3].y}`, '160,90');
  check('the next sheet starts its own grid', `${cues[4].key} ${cues[4].x},${cues[4].y}`, 'library/a/s/m10.jpg 0,0');
  check('cues carry the sheet version (tile count)', cues[0].v, 4);
  const vtt = N.buildVtt([unit], [{ from: u.start + 5_000, to: u.start + 25_000, offset: 0 }], (k, v) => `/s/${k}?v=${v}`);
  truthy('a clip VTT starts at 0', vtt.includes('00:00:00.000 --> 00:00:05.000\n/s/library/a/s/m00.jpg?v=4#xywh=0,0,160,90'));
  truthy('and is trimmed to the clip end', vtt.includes('00:00:15.000 --> 00:00:20.000\n/s/library/a/s/m00.jpg?v=4#xywh=320,0,160,90'));
  const two = N.buildVtt([unit], [{ from: u.start, to: u.start + 10_000, offset: 0 }, { from: u.start + 600_000, to: u.start + 610_000, offset: 10_000 }], (k) => k);
  truthy('composed clips stitch pieces at their offsets', two.includes('00:00:10.000 --> 00:00:20.000\nlibrary/a/s/m10.jpg#xywh=0,0,160,90'));
  check('slot lookup', JSON.stringify(N.slotFor(unit, u.start + 615_000)), '{"sheet":1,"slot":1}');

  // ------------------------------------------------------------ 2. metadata
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/">
  <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Grand Final crowd</rdf:li></rdf:Alt></dc:title>
  <dc:description><rdf:Alt><rdf:li xml:lang="x-default">Fans before the bounce</rdf:li></rdf:Alt></dc:description>
  <dc:subject><rdf:Bag><rdf:li>football</rdf:li><rdf:li>crowd</rdf:li></rdf:Bag></dc:subject>
  <dc:creator><rdf:Seq><rdf:li>Jane Photog</rdf:li></rdf:Seq></dc:creator>
  <photoshop:City>Melbourne</photoshop:City><photoshop:State>Victoria</photoshop:State><photoshop:Country>Australia</photoshop:Country>
  <Iptc4xmpCore:Location>Yarra Park</Iptc4xmpCore:Location></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const photo = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#357' } }).jpeg()
    .withExif({ IFD0: { Make: 'Canon', Model: 'Canon EOS R5', Copyright: '(c) Volt' },
      IFD2: { DateTimeOriginal: '2026:09:26 14:30:00', OffsetTimeOriginal: '+10:00' },
      IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '37/1 49/1 12/1', GPSLongitudeRef: 'E', GPSLongitude: '144/1 59/1 0/1' } } as any)
    .withXmp(xmp).toBuffer();
  const f = await readImageFacts(photo);
  check('dimensions', `${f.width}x${f.height}`, '300x200');
  check('camera, without the make repeated', f.camera, 'Canon EOS R5');
  check('date taken, with its offset', f.takenAt?.toISOString(), '2026-09-26T04:30:00.000Z');
  check('GPS latitude', f.gpsLat, -37.82);
  check('GPS longitude', Math.round((f.gpsLng ?? 0) * 1000) / 1000, 144.983);
  check('place names as written', f.location, 'Yarra Park, Melbourne, Victoria, Australia');
  check('title (XMP)', f.title, 'Grand Final crowd');
  check('description (XMP)', f.description, 'Fans before the bounce');
  check('keywords (XMP)', f.keywords.join(','), 'football,crowd');
  check('creator', f.creator, 'Jane Photog');
  check('copyright', f.copyright, '(c) Volt');
  check('sha256 checksum', f.checksum.length, 64);
  const plain = await readImageFacts(await sharp({ create: { width: 8, height: 8, channels: 4, background: '#0000' } }).png().toBuffer());
  check('an image with no metadata still reads', `${plain.width}x${plain.height} ${plain.gpsLat} ${plain.camera}`, '8x8 null null');
  check('alpha is recorded', (plain.metadata as any).hasAlpha, true);
  const junk = await readImageFacts(Buffer.from('not an image at all'));
  check('garbage never throws', junk.width, null);
  const noZone = await readImageFacts(await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).jpeg()
    .withExif({ IFD2: { DateTimeOriginal: '2026:01:02 03:04:05' } } as any).toBuffer());
  check('a zoneless EXIF date keeps the camera clock', noZone.takenAt?.toISOString(), '2026-01-02T03:04:05.000Z');

  // ------------------------------------------------------------ 3. search builders
  check('prefix query', prefixQuery('Grand  fin!'), 'grand:* & fin:*');
  check('empty query', prefixQuery('  ?? '), null);
  const b = buildFileSearch(ACC, { q: 'grand', source: 'encoder', near: { lat: -37.8, lng: 145, km: 10 }, sort: 'newest' });
  truthy('search uses the vector and a substring fallback', b.where.includes("search @@ to_tsquery('simple'") && b.where.includes('name ILIKE'));
  truthy('near filters with a bounding box and the true distance', b.where.includes('gps_lat BETWEEN') && b.where.includes('asin'));
  check('newest sorts by the picture time', b.order.startsWith('COALESCE(captured_at, taken_at, created_at) DESC'), true);
  check('folder search matches every word', matchFolders(['thumbnails', 'thumbnails/News', 'thumbnails/News/2026-10-16', 'slates'], 'news 10-16').join(','), 'thumbnails/News/2026-10-16');
  check('lazy children of a folder', childFolders(['a', 'a/b', 'a/b/c', 'a/d', 'e'], 'a').join(','), 'a/b,a/d');
  check('root children', childFolders(['a', 'a/b', 'e'], '').join(','), 'a,e');

  // ------------------------------------------------------------ 4. a real build
  const { query, pool } = await import('../src/db');
  const B = await import('../src/services/thumbnails/builder');
  const C = await import('../src/services/thumbnails/clips');
  const { imageStore } = await import('../src/services/imageStore');
  const { buildFileSearch: bfs } = await import('../src/services/mediaSearch');

  // a past hour, so every slot without media is a settled gap
  const T = Math.floor((Date.now() - 2 * 86400_000) / 3600_000) * 3600_000 + 30 * 60_000;
  const runId = new Date(T).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dir = join(process.env.ORIGIN_DIR!, CH, 'runs', runId, '360p');
  mkdirSync(dir, { recursive: true });
  const gop = String(SEG_S * 25);
  const enc = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${DUR_S}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '400k', '-g', gop, '-keyint_min', gop, '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${SEG_S})`, '-f', 'hls', '-hls_time', String(SEG_S),
    '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(dir, 'seg_%05d.m4s'), '-y', join(dir, 'index.m3u8')], { encoding: 'utf8' });
  if (enc.status !== 0) { console.log('SKIP build: ffmpeg could not encode', enc.stderr?.slice(0, 300)); }
  else {
    const files = readdirSync(dir).filter((x) => /^seg_\d+\.m4s$/.test(x)).sort();
    files.forEach((x, i) => { const t = (T / 1000) + (i + 1) * SEG_S; utimesSync(join(dir, x), t, t); });
    utimesSync(join(dir, 'init.mp4'), T / 1000, T / 1000);

    await query(`DELETE FROM storyboards WHERE stream_id = $1`, [CH]);
    await query(`DELETE FROM media_files WHERE account_id = $1`, [ACC]);
    await query(`INSERT INTO accounts(id,name) VALUES ($1,'ThumbCo') ON CONFLICT (id) DO NOTHING`, [ACC]);
    await query(`INSERT INTO groups(id,account_id,name) VALUES ($1,$2,'G') ON CONFLICT (id) DO NOTHING`, [GRP, ACC]);
    await query(`INSERT INTO channels(id,group_id,name,status,tz,kind) VALUES ($1,$2,'News 24','ended','Australia/Brisbane','tv')
                 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, tz = EXCLUDED.tz`, [CH, GRP]);
    await query(`DELETE FROM programmes WHERE channel_id = $1`, [CH]);
    await query(`INSERT INTO programmes(channel_id,title,starts_at,ends_at) VALUES ($1,'Grand Final',$2,$3)`,
      [CH, new Date(T + 60_000), new Date(T + 120_000)]);

    const r = await B.buildRange(CH, T - 60_000, T + DUR_S * 1000 + 60_000);
    check('one hour built', r.units, 1);
    check('a tile every 10 s of material', r.tiles, DUR_S / 10);
    check('a library still every minute', r.frames, DUR_S / 60);
    const sb = (await query<any>(`SELECT * FROM storyboards WHERE stream_id = $1`, [CH]))[0];
    const hu = N.hourUnit(T, 'Australia/Brisbane');
    check('folder is thumbnails/<channel>/<date>/<hour>', sb?.folder, `thumbnails/News-24/${hu.date}/${hu.label}`);
    check('the past hour is complete (gaps settled)', sb?.status, 'complete');
    check('tiles recorded', sb?.tiles, DUR_S / 10);
    const sheet = sb.sheets.find((s: any) => s.filled.length);
    check('the material lands in the m30 sheet', sheet.key.endsWith(`News-24-${hu.ymd}-${hu.label}-m30.jpg`), true);
    check('filled slots are the first 18', sheet.filled.join(','), Array.from({ length: 18 }, (_, i) => i).join(','));
    const sheetBytes = await imageStore().get(sheet.key);
    const sm = sheetBytes ? await sharp(sheetBytes).metadata() : null;
    check('a sheet is 10 x 6 tiles of 160 x 90', `${sm?.width}x${sm?.height}`, '1600x540');
    const stills = await query<any>(`SELECT name, folder, kind, source, channel_id, captured_at, title, metadata, width, height
                                      FROM media_files WHERE account_id = $1 AND kind = 'keyframe' ORDER BY captured_at`, [ACC]);
    check('three stills indexed', stills.length, 3);
    const hms = (ms: number) => N.localParts(ms, 'Australia/Brisbane');
    check('a still outside a programme is named after the channel', stills[0]?.name, `News-24-${hms(T).ymd}-${hms(T).hms}.jpg`);
    check('a still inside a programme is named after it', stills[1]?.name, `Grand-Final-${hms(T + 60_000).ymd}-${hms(T + 60_000).hms}.jpg`);
    check('stills are 640 x 360', `${stills[0]?.width}x${stills[0]?.height}`, '640x360');
    check('stills record where and when', `${stills[1]?.source} ${stills[1]?.channel_id} ${new Date(stills[1]?.captured_at).getTime()}`, `encoder ${CH} ${T + 60_000}`);
    check('and which programme', stills[1]?.metadata?.programme, 'Grand Final');
    truthy('the still bytes are in the library store', existsSync(join(process.env.IMAGE_STORE_DIR!, 'library', ACC, sb.folder, stills[0].name)));
    const sbRows = await query<any>(`SELECT name, folder FROM media_files WHERE account_id = $1 AND kind = 'storyboard'`, [ACC]);
    check('the sheet is in the library too, under storyboard/', sbRows[0]?.folder, `${sb.folder}/storyboard`);
    const hourVtt = (await imageStore().get(sb.vtt_key))?.toString() ?? '';
    check('the hour VTT has a cue per tile', (hourVtt.match(/#xywh=/g) ?? []).length, 18);
    truthy('and starts at the half hour', hourVtt.includes('00:30:00.000 --> 00:30:10.000'));
    truthy('pointing at signed, versioned sheet URLs', /https:\/\/img\.test\/img\/[A-Za-z0-9_-]{22}\/1600x540,fill,fmt=jpeg,q=85,v=18\/library\//.test(hourVtt));

    // search finds stills by programme and channel
    const sq = bfs(ACC, { q: 'grand final' });
    const found = await query<any>(`SELECT name FROM media_files WHERE ${sq.where}`, sq.params);
    check('search finds stills by programme name', found.length, 1);
    const sq2 = bfs(ACC, { q: 'news 24', kind: 'keyframe' });
    check('and by channel name', (await query<any>(`SELECT 1 FROM media_files WHERE ${sq2.where}`, sq2.params)).length, 3);

    // a second build adds nothing
    const again = await B.buildRange(CH, T - 60_000, T + DUR_S * 1000 + 60_000);
    check('a finished hour is never rebuilt', again.tiles + again.frames, 0);

    // a clip: 30 s from T+45 s, as clip_segments would describe it
    await query(`DELETE FROM vod_assets WHERE id = $1`, [VOD]);
    await query(`INSERT INTO vod_assets(id, channel_id, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms)
                 VALUES ($1,$2,'clip','Final siren',$3,$4,$5,30000)`, [VOD, CH, `vod/${VOD}/master.m3u8`, T + 45_000, T + 75_000]);
    const cp = await C.clipPieces(VOD, ACC);
    check('a clip maps to its source range', JSON.stringify(cp?.pieces), JSON.stringify([{ from: T + 45_000, to: T + 75_000, offset: 0 }]));
    const w = await C.writeClipThumbnails(VOD);
    check('the clip VTT has the clip\'s tiles', w.cues, 4);
    const clipVtt = (await imageStore().get(w.vttKey!))?.toString() ?? '';
    truthy('re-timed to start at 0 mid-tile', clipVtt.includes('00:00:00.000 --> 00:00:05.000'));
    truthy('and ending at the clip end', clipVtt.includes('--> 00:00:30.000'));
    truthy('stored beside the channel thumbnails', w.vttKey!.startsWith(`library/${ACC}/thumbnails/News-24/clips/Final-siren-`));
    const va = (await query<any>(`SELECT thumbs_vtt_key, poster_key, thumb_status FROM vod_assets WHERE id = $1`, [VOD]))[0];
    check('the asset points at its VTT', va.thumbs_vtt_key, w.vttKey);
    truthy('and has a poster from the nearest still', String(va.poster_key).includes('/thumbnails/News-24/'));
    check('thumbnails ready', va.thumb_status, 'ready');

    // retention
    process.env.THUMBS_RETENTION_DAYS = '1';
    const { config } = await import('../src/config');
    (config.thumbnails as any).retentionDays = 1;
    const sw = await B.sweepThumbnails();
    check('retention removes the old hour', sw.hours, 1);
    check('and its library rows', (await query<any>(`SELECT 1 FROM media_files WHERE account_id = $1 AND source = 'encoder'`, [ACC])).length, 0);
    check('and its files', existsSync(join(process.env.IMAGE_STORE_DIR!, 'library', ACC, sb.folder, stills[0].name)), false);
    await query(`DELETE FROM vod_assets WHERE id = $1`, [VOD]);
  }
  await pool.end();
  rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
