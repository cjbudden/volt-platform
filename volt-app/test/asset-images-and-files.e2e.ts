// ============================================================================
//  IMAGE TYPES, THE METADATA IMAGE FIX, COMPANION FILES AND SUBTITLE DELIVERY,
//  end to end against Postgres, the local store and real CMAF segments.
//  Needs DATABASE_URL (a migrated database) and ffmpeg.
//  Usage: npx tsx test/asset-images-and-files.e2e.ts
// ============================================================================
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const T = mkdtempSync(join(tmpdir(), 'volt-e2e-'));
process.env.IMAGE_STORE_DIR = join(T, 'images'); process.env.CLIPS_DIR = join(T, 'clips'); process.env.IMAGE_STORE_DRIVER = 'local';
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

async function main() {
  const { one, query, pool } = await import('../src/db');
  const acct = (await one<any>(`INSERT INTO accounts (name) VALUES ('E2E') RETURNING id`))!.id;
  await (await import('../src/services/contentTypes')).ensureStandardTypes(acct);
  const ep = (await one<any>(`SELECT id FROM metadata_schemas WHERE account_id = $1 AND standard_key = 'episode'`, [acct]))!.id;
  const id = (await one<any>(`SELECT gen_random_uuid() AS id`))!.id;
  // A real CMAF ladder whose media timeline starts at 1000 s, as a clip copied from live would.
  const dir = join(process.env.CLIPS_DIR!, 'vod', id); mkdirSync(join(dir, '720p'), { recursive: true });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25', '-t', '6', '-c:v', 'libx264', '-g', '50', '-video_track_timescale', '12800',
    '-f', 'hls', '-hls_time', '2', '-hls_segment_type', 'fmp4', '-hls_playlist_type', 'vod', '-hls_fmp4_init_filename', 'init.mp4', join(dir, '720p', 'index.m3u8')]);
  const { writeFileSync } = await import('node:fs');
  // ffmpeg's HLS muxer writes tfdt 0; a clip copied from a live timeline carries the live clock.
  // Put 1000 s (at the track's 12800 timescale) into the real segment's tfdt.
  { const { readFileSync: rf } = await import('node:fs'); const f = join(dir, '720p', 'index0.m4s'); const b = rf(f); const i = b.indexOf('tfdt');
    if (b[i + 4] === 1) b.writeBigUInt64BE(12_800_000n, i + 8); else b.writeUInt32BE(12_800_000, i + 8); writeFileSync(f, b); }
  writeFileSync(join(dir, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\n720p/index.m3u8\n');
  writeFileSync(join(dir, 'manifest.mpd'), '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"><Period id="0" start="PT0S"><AdaptationSet contentType="video"></AdaptationSet></Period></MPD>');
  await query(`INSERT INTO vod_assets (id, account_id, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, schema_id, metadata, source_kind)
               VALUES ($1,$2,'Harbour E1',$3,0,6000,6000,$4,'{"title":"Harbour E1"}','upload')`, [id, acct, `/clips/vod/${id}/master.m3u8`, ep]);

  console.log('== image types ==');
  const IS = await import('../src/services/media/assetImageSet');
  const types = await IS.listImageTypes(acct);
  ok(types.map((t) => t.key).join() === 'thumbnail,cover,poster,hero,banner,social,title', 'standard types seeded', types.map((t) => t.key).join());
  await IS.saveImageType(acct, null, { key: 'partner-tile', label: 'Partner tile', aspect: '4:3', minWidth: 800, minHeight: 600 });
  await IS.saveImageType(acct, 'banner', { label: 'Home banner', enabled: false });
  let v = (await IS.assetImages(id, acct))!;
  ok(v.media === 'video' && v.primaryType === 'thumbnail', 'a video asset: thumbnail is the main image');
  ok(!v.slots.some((s) => s.type.key === 'banner') && v.slots.some((s) => s.type.key === 'partner-tile'), 'switched-off type hidden, custom type offered');
  // Images in the library.
  const sharp = (await import('sharp')).default;
  const { saveToLibrary } = await import('../src/services/media/libraryImages');
  const img = (w: number, h: number, c: string) => sharp({ create: { width: w, height: h, channels: 3, background: c } }).jpeg().toBuffer();
  const wide = await saveToLibrary(acct, 'media/harbour', 'wide.jpg', await img(1920, 1080, '#336699'), 'image/jpeg', 'poster', {});
  const tall = await saveToLibrary(acct, 'media/harbour', 'poster.jpg', await img(1000, 1500, '#993333'), 'image/jpeg', 'poster', {});
  const small = await saveToLibrary(acct, 'media/harbour', 'small.jpg', await img(400, 600, '#339933'), 'image/jpeg', 'poster', {});
  await (await import('../src/services/media/assetImage')).setAssetImage(id, acct, `/${wide}`, 'tester');
  v = (await IS.assetImages(id, acct))!;
  const poster = v.slots.find((s) => s.type.key === 'poster')!;
  ok(!poster.image && poster.fallback?.from === 'thumbnail' && /600x900|1000x1500/.test(poster.fallback.url ?? ''), 'poster falls back to the thumbnail, cropped 2:3', JSON.stringify(poster.fallback));
  await IS.setTypeImage(id, acct, 'poster', `/${tall}`, 'tester', { x: 50, y: 20 });
  v = (await IS.assetImages(id, acct))!;
  const p2 = v.slots.find((s) => s.type.key === 'poster')!;
  ok(p2.image?.key === tall && /focus=50-20/.test(p2.image.url ?? '') && p2.warnings.length === 0, 'own poster with a focus point, no warnings', JSON.stringify(p2));
  ok(v.urls.poster === p2.image!.url && !!v.urls.hero, 'urls map for portals');
  await IS.setTypeImage(id, acct, 'poster', `/${small}`, 'tester');
  ok((await IS.assetImages(id, acct))!.slots.find((s) => s.type.key === 'poster')!.warnings.some((w) => /Smaller/.test(w)), 'a small poster warns');
  let threw = ''; try { await IS.setTypeImage(id, acct, 'banner', `/${tall}`, 'tester'); } catch (e: any) { threw = e.message; }
  ok(/not an image type/.test(threw), 'a switched-off type cannot be set');
  threw = ''; try { await IS.deleteImageType(acct, 'poster'); } catch (e: any) { threw = e.message; }
  ok(/switch it off/.test(threw), 'a standard type cannot be deleted');
  await IS.setTypeImage(id, acct, 'partner-tile', `/${wide}`, 'tester');
  threw = ''; try { await IS.deleteImageType(acct, 'partner-tile'); } catch (e: any) { threw = e.message; }
  ok(/1 asset has/.test(threw), 'a custom type in use needs force');
  ok((await IS.deleteImageType(acct, 'partner-tile', true)).images === 1, 'force removes it and its images');
  await IS.clearTypeImage(id, acct, 'poster');
  ok((await IS.assetImages(id, acct))!.slots.find((s) => s.type.key === 'poster')!.fallback != null, 'removed: falls back again');

  console.log('== the metadata image fix ==');
  let a = (await one<any>(`SELECT poster_key, poster_locked FROM vod_assets WHERE id = $1`, [id]))!;
  ok(a.poster_locked && a.poster_key === wide, 'the image was chosen by hand (locked)');
  const before = { title: 'Harbour E1' }, after = { title: 'Harbour E1', image: `/${tall}`, poster: `/${small}` };
  await query(`UPDATE vod_assets SET metadata = $2 WHERE id = $1`, [id, JSON.stringify(after)]);
  const r = await IS.applyImageFieldChanges(id, acct, before, after, 'tester');
  a = (await one<any>(`SELECT poster_key, poster_source FROM vod_assets WHERE id = $1`, [id]))!;
  ok(r.primary && a.poster_key === tall && a.poster_source === 'metadata', 'a new image in the Image field replaces a locked image at once', JSON.stringify({ r, a }));
  ok(r.slots.includes('poster') && (await IS.assetImages(id, acct))!.slots.find((s) => s.type.key === 'poster')!.image?.key === small, 'the Poster field fills the Poster slot');
  const { framePosterName } = await import('../src/services/media/assetImage');
  const b1 = await img(64, 36, '#000'), b2 = await img(64, 36, '#fff');
  ok(framePosterName(b1) !== framePosterName(b2) && framePosterName(b1) === framePosterName(b1) && framePosterName(b1, 'Harbour E1.mov') === `harbour-e1-${framePosterName(b1).slice(-14)}`, 'a different frame gets a different file name, named after the asset');

  console.log('== companion files ==');
  const CS = await import('../src/services/companions/store');
  const srt = Buffer.from('1\n00:00:01,000 --> 00:00:02,500\nHello <i>harbour</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nCaf\xe9 au lait\n', 'latin1');
  const en = await CS.addFile(id, acct, { name: 'Harbour.E1.en.sdh.srt', buf: srt, by: 'tester' });
  ok(en.file.kind === 'captions' && en.file.language === 'en' && en.file.sdh && en.file.isDefault && en.file.label === 'English (SDH)' && en.file.report.cues === 2 && en.file.encoding === 'windows-1252', 'SRT: English SDH, default, 2 cues, old encoding read', JSON.stringify(en.file));
  ok((await CS.addFile(id, acct, { name: 'again.srt', buf: srt, by: 'tester' })).duplicate, 'the same bytes again is the same file');
  const tt = Buffer.from('<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xml:lang="fr"><body><div><p begin="00:00:01.000" end="00:00:02.000">Bonjour</p></div></body></tt>');
  const fr = await CS.addFile(id, acct, { name: 'harbour_e1_FR.ttml', buf: tt, by: 'tester' });
  ok(fr.file.language === 'fr' && !fr.file.isDefault && fr.file.label === 'French', 'TTML: French, not default');
  const bad = await CS.addFile(id, acct, { name: 'empty.vtt', buf: Buffer.from('WEBVTT\n\n'), by: 'tester' });
  ok(!bad.file.enabled && bad.file.report.ok === false, 'an empty caption file is kept but not offered');
  const nfo = Buffer.from('<?xml version="1.0"?><episodedetails><title>The Pilot</title><showtitle>Harbour</showtitle><season>1</season><episode>1</episode><plot>A ship and a storm.</plot><genre>Drama</genre></episodedetails>');
  const md = await CS.addFile(id, acct, { name: 'Harbour.E1.nfo', buf: nfo, by: 'tester' });
  ok(md.file.kind === 'metadata' && md.file.report.values === 6, 'NFO sidecar read', JSON.stringify(md.file.report));
  const plan = await CS.proposeMetadata(id, acct, md.file.id);
  const pf = Object.fromEntries(plan.proposals.map((p) => [p.field, p.value]));
  ok(pf.title === 'The Pilot' && pf.series === 'Harbour' && pf.season === 1 && pf.episodeNumber === 1 && pf.description === 'A ship and a storm.', 'mapped to the Episode type', JSON.stringify(pf));
  const ap = await CS.applyMetadata(id, acct, md.file.id, ['series', 'season', 'episodeNumber', 'description'], { description: 'Edited by a person.' }, 'tester');
  a = (await one<any>(`SELECT metadata, metadata_provenance FROM vod_assets WHERE id = $1`, [id]))!;
  ok(a.metadata.series === 'Harbour' && a.metadata.description === 'Edited by a person.' && a.metadata.title === 'Harbour E1' && a.metadata_provenance.series.source === 'sidecar', 'only approved fields written, edits kept, provenance recorded', JSON.stringify(a.metadata));
  ok(ap.applied.length === 4, 'applied 4');
  await CS.updateFile(id, acct, fr.file.id, { isDefault: true, offsetMs: 500 });
  const list = (await CS.listFiles(id, acct)).files;
  ok(list.filter((f: any) => f.isDefault).map((f: any) => f.language).join() === 'fr', 'one default at a time');
  const frVtt = (await CS.fileContent(id, acct, fr.file.id, true)).buf.toString();
  ok(/00:00:01\.500 --> 00:00:02\.500/.test(frVtt), 'an offset rebuilds the WebVTT', frVtt);

  console.log('== delivery ==');
  const express = (await import('express')).default;
  const { serveSubs, withTracks } = await import('../src/services/companions/serve');
  const app = express();
  app.get(/^\/clips\/.+\/subs\/[0-9a-f-]{36}(\.dash)?\.(m3u8|vtt)$/i, serveSubs);
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const { readFileSync } = await import('node:fs');
  const m = await withTracks(readFileSync(join(dir, 'master.m3u8'), 'utf8'), id, false);
  ok((m.match(/TYPE=SUBTITLES/g) ?? []).length === 2 && /SUBTITLES="volt-subs"/.test(m) && !m.includes(bad.file.id), 'master: two offered tracks, the empty one left out', m);
  ok(/NAME="French",LANGUAGE="fr",DEFAULT=YES/.test(m) && /CHARACTERISTICS="public.accessibility/.test(m), 'default and SDH flags');
  const mpd = await withTracks(readFileSync(join(dir, 'manifest.mpd'), 'utf8'), id, true);
  ok((mpd.match(/contentType="text"/g) ?? []).length === 2 && mpd.includes(`subs/${en.file.id}.dash.vtt`), 'MPD: two text sets');
  const pl = await (await fetch(`${base}/clips/vod/${id}/subs/${en.file.id}.m3u8`)).text();
  ok(pl.includes(`${en.file.id}.vtt`) && pl.includes('#EXTINF:6.000,'), 'subtitle playlist', pl);
  const vtt = await (await fetch(`${base}/clips/vod/${id}/subs/${en.file.id}.vtt`)).text();
  const tfdtMap = /X-TIMESTAMP-MAP=MPEGTS:(\d+),LOCAL:00:00:00\.000/.exec(vtt);
  // ffmpeg -output_ts_offset 1000 → first segment decode time ~1000 s (+ the encoder's own start delay).
  const mpegts = tfdtMap ? Number(tfdtMap[1]) / 90000 : -1;
  ok(Math.abs(mpegts - 1000) < 0.001, `X-TIMESTAMP-MAP read from the delivered segment's tfdt (${mpegts.toFixed(3)} s)`, vtt.slice(0, 200));
  ok(/Café au lait/.test(vtt) && /<i>harbour<\/i>/.test(vtt), 'cue text survives, Windows-1252 decoded');
  const dvtt = await (await fetch(`${base}/clips/vod/${id}/subs/${en.file.id}.dash.vtt`)).text();
  ok(!/X-TIMESTAMP-MAP/.test(dvtt) && /00:00:01\.000/.test(dvtt), 'DASH WebVTT has no HLS map');
  ok((await fetch(`${base}/clips/vod/00000000-0000-0000-0000-000000000000/subs/${en.file.id}.vtt`)).status === 404, 'a track only answers under its own asset');
  ok((await fetch(`${base}/clips/vod/${id}/subs/${bad.file.id}.vtt`)).status === 404, 'a track not offered is not served');
  await CS.deleteFile(id, acct, en.file.id);
  const m2 = await withTracks(readFileSync(join(dir, 'master.m3u8'), 'utf8'), id, false);
  ok((m2.match(/TYPE=SUBTITLES/g) ?? []).length === 1, 'a removed track leaves the master at once');
  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
