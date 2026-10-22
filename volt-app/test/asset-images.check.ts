// ============================================================================
//  ASSET IMAGES (services/media/assetImage.ts, musicLookup.ts, frameScore.ts,
//  modules/vodImage.ts, docs/ASSET_IMAGES.md).
//
//  Pure: the recording matcher (live, karaoke, bootleg versions lose; length
//  helps), song identity, metadata fills, the frame scorer on real frames
//  (bars, black, flat, blurred, a scene).
//  Postgres + HTTP, with a fake MusicBrainz and Cover Art Archive:
//    radio station artwork (square), a guide programme's own image, a song's
//    album cover (into the Image Library once per album, empty fields filled
//    with provenance), a song with no confident match (station fallback), the
//    best live keyframe, frames from an uploaded file, a manual choice that
//    sticks, the API, the list's audio flag, the sweep.
//  Usage: npx tsx test/asset-images.check.ts
// ============================================================================
import { createServer as httpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
const eq = (got: unknown, want: unknown, m: string) => ok(JSON.stringify(got) === JSON.stringify(want), m, `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);

// ---- a fake MusicBrainz + Cover Art Archive -----------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'asset-img-'));
const ff = (args: string[]) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);
ff(['-f', 'lavfi', '-i', 'testsrc2=s=500x500', '-frames:v', '1', join(tmp, 'cover.jpg')]);
const COVER = readFileSync(join(tmp, 'cover.jpg'));
const hits: string[] = [];
const rec = (o: any) => ({
  id: o.id, score: o.score ?? 100, title: o.title ?? 'Bohemian Rhapsody', length: o.length ?? 355000, disambiguation: o.dis ?? '', video: o.video ?? false,
  'artist-credit': [{ name: o.artist ?? 'Queen' }],
  releases: [{ id: `rel-${o.id}`, title: o.album ?? 'A Night at the Opera', status: o.status ?? 'Official', date: o.date ?? '1975-11-21',
    'release-group': { id: o.rg ?? `rg-${o.id}`, title: o.album ?? 'A Night at the Opera', 'primary-type': o.type ?? 'Album', 'secondary-types': o.sec ?? [] } }],
});
const mb = httpServer((q, r) => {
  const u = new URL(q.url!, 'http://x'); hits.push(u.pathname + u.search);
  r.setHeader('content-type', 'application/json');
  const query = u.searchParams.get('query') ?? '';
  if (u.pathname === '/ws/2/recording') {
    if (/Nobody Knows/.test(query)) return r.end(JSON.stringify({ recordings: [rec({ id: 'x1', title: 'Somebody Else', artist: 'Other Band', score: 60 })] }));
    if (/status:official/.test(query)) return r.end(JSON.stringify({ recordings: [] }));   // force the loose path
    return r.end(JSON.stringify({ recordings: [
      rec({ id: 'live1', dis: 'live, 2003-11-29: Cape Town', length: 139000, sec: ['Live'], album: '46664' }),
      rec({ id: 'kara', dis: 'karaoke version', sec: ['Compilation'], album: 'Greatest Karaoke Hits' }),
      rec({ id: 'boot', status: 'Bootleg', sec: ['Live'], album: 'Complete Kampuchea' }),
      rec({ id: 'studio', rg: 'rg-anato', length: 354000 }),
    ] }));
  }
  if (u.pathname.startsWith('/ws/2/recording/studio')) return r.end(JSON.stringify({ isrcs: ['GBUM71029604'], genres: [{ name: 'rock', count: 9 }, { name: 'progressive rock', count: 4 }] }));
  if (u.pathname.startsWith('/ws/2/release-group/')) return r.end(JSON.stringify({ 'first-release-date': '1975-11-21', genres: [] }));
  if (u.pathname.startsWith('/ws/2/release/')) return r.end(JSON.stringify({ 'label-info': [{ label: { name: 'EMI' } }] }));
  if (u.pathname === '/ws/2/release-group') return r.end(JSON.stringify({ 'release-groups': [] }));
  // Deezer (opt-in provider): it knows the independent single MusicBrainz does not.
  if (u.pathname === '/dz/search') {
    const q2 = u.searchParams.get('q') ?? '';
    if (/Orange Crush/i.test(q2) && /Infinite Lights/i.test(q2)) return r.end(JSON.stringify({ data: [
      { id: 2, title: 'Infinite Lights', title_short: 'Infinite Lights', title_version: '(Live)', duration: 300, isrc: 'XX', artist: { name: 'Orange Crush' }, album: { id: 9, title: 'Live at Home', cover_xl: `http://127.0.0.1:${(mb.address() as any).port}/dz/cover/9.jpg` }, link: 'https://www.deezer.com/track/2' },
      { id: 1, title: 'Infinite Lights', title_short: 'Infinite Lights', title_version: '', duration: 282, isrc: 'TCAFH2072219', artist: { name: 'Orange Crush' }, album: { id: 194591372, title: 'Infinite Lights', cover_xl: `http://127.0.0.1:${(mb.address() as any).port}/dz/cover/194591372.jpg` }, link: 'https://www.deezer.com/track/1184330882' },
    ] }));
    return r.end(JSON.stringify({ data: [] }));
  }
  if (u.pathname.startsWith('/dz/album/')) return r.end(JSON.stringify({ release_date: '2020-12-17', label: 'Orange Crush', record_type: 'single', genres: { data: [{ name: 'Electro' }, { name: 'Dance' }] }, cover_xl: `http://127.0.0.1:${(mb.address() as any).port}/dz/cover/194591372.jpg` }));
  if (u.pathname.startsWith('/dz/cover/')) { r.setHeader('content-type', 'image/jpeg'); return r.end(COVER); }
  if (u.pathname === '/img/logo.png') { r.setHeader('content-type', 'image/png'); return r.end(COVER); }
  // Apple's iTunes Search API.
  if (u.pathname === '/itunes/search') {
    const t = u.searchParams.get('term') ?? '';
    if (/Orange Crush/i.test(t) && /Infinite Lights/i.test(t)) return r.end(JSON.stringify({ resultCount: 1, results: [{ artistName: 'Orange Crush', trackName: 'Infinite Lights', collectionName: 'Infinite Lights - Single', releaseDate: '2020-12-17T12:00:00Z', primaryGenreName: 'Electronic', trackTimeMillis: 282000, artworkUrl100: `http://127.0.0.1:${(mb.address() as any).port}/dz/cover/apple/100x100bb.jpg`, trackViewUrl: 'https://music.apple.com/us/album/infinite-lights/1545721311?i=1545721315' }] }));
    return r.end(JSON.stringify({ resultCount: 0, results: [] }));
  }
  // Web pages a person pastes.
  if (u.pathname === '/page/oc.html') {
    r.setHeader('content-type', 'text/html; charset=utf-8');
    return r.end(`<!doctype html><html><head><title>Infinite Lights | Orange Crush</title>
      <meta property="og:title" content="Infinite Lights, by Orange Crush"><meta property="og:image" content="http://127.0.0.1:${(mb.address() as any).port}/dz/cover/page_16.jpg">
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicRecording","name":"Infinite Lights","byArtist":{"@type":"MusicGroup","name":"Orange Crush"},
        "inAlbum":{"@type":"MusicAlbum","name":"Infinite Lights","albumRelease":[]},"datePublished":"18 Dec 2020 00:00:00 GMT","duration":"P00H04M42S","isrcCode":"TCAFH2072219",
        "recordLabel":{"@type":"Organization","name":"Orange Crush Music"},"image":"http://127.0.0.1:${(mb.address() as any).port}/dz/cover/page_10.jpg"}</script></head><body>x</body></html>`);
  }
  if (u.pathname === '/page/blocked.html') { r.statusCode = 403; r.setHeader('content-type', 'text/html'); return r.end('<!DOCTYPE html><html><head><title>Client Challenge</title></head><body></body></html>'); }
  if (u.pathname === '/page/search.html') { r.setHeader('content-type', 'text/html'); return r.end('<html><head><title>Search results</title></head><body>nothing</body></html>'); }
  if (u.pathname.startsWith('/cover/release-group/')) {
    if (u.pathname.includes('rg-none')) { r.statusCode = 404; return r.end(); }
    r.setHeader('content-type', 'image/jpeg'); return r.end(COVER);
  }
  r.statusCode = 404; r.end('{}');
}).listen(0);
const mbPort = (mb.address() as any).port;
process.env.MUSICBRAINZ_BASE = `http://127.0.0.1:${mbPort}/ws/2`;
process.env.COVERART_BASE = `http://127.0.0.1:${mbPort}/cover`;
process.env.TRACK_META_MIN_GAP_MS = '5';
process.env.IMAGE_STORE_DIR = join(tmp, 'store');
process.env.DEEZER_API_BASE = `http://127.0.0.1:${mbPort}/dz`;
process.env.GRAPHICS_ALLOW_PRIVATE_FEEDS = '1';
process.env.ITUNES_API_BASE = `http://127.0.0.1:${mbPort}/itunes`;   // the fake servers are on 127.0.0.1

(async () => {
  const { scoreRecording, pickRecording, songIdentity, fillsFor } = await import('../src/services/media/musicLookup');
  const { frameStats, scoreFrame, pickFrame } = await import('../src/services/media/frameScore');

  console.log('== matcher ==');
  {
    const want = { artist: 'Queen', title: 'Bohemian Rhapsody', durationMs: 355_000 };
    const recs = [rec({ id: 'live1', dis: 'live, 2003-11-29: Cape Town', length: 139000, sec: ['Live'] }), rec({ id: 'kara', dis: 'karaoke version', sec: ['Compilation'] }),
      rec({ id: 'boot', status: 'Bootleg', sec: ['Live'] }), rec({ id: 'studio', length: 354000 })];
    eq(pickRecording(recs, want)?.r.id, 'studio', 'the studio album recording beats live, karaoke and bootleg versions that all score 100');
    const live = scoreRecording(recs[0], want);
    ok(live.score < 70 && live.notes.some((n) => /live version/.test(n)), 'a live version is explained and below the floor', JSON.stringify(live));
    eq(pickRecording([recs[0], recs[1], recs[2]], want), null, 'only live/karaoke/bootleg versions: a miss, not wrong art');
    eq(pickRecording([rec({ id: 'o', artist: 'Queen Latifah' }), rec({ id: 'q' })], { artist: 'Queen', title: 'Bohemian Rhapsody' })?.r.id, 'q', 'exact artist beats a partial one');
    const near = scoreRecording(rec({ id: 'a', length: 356000 }), want).score, far = scoreRecording(rec({ id: 'b', length: 600000 }), want).score;
    ok(near > far, 'a length close to the asset counts', `${near} vs ${far}`);
  }

  console.log('== identity + fills ==');
  {
    eq(songIdentity({ title: 'x', metadata: { artist: 'Queen', title: 'Bohemian Rhapsody' } }), { artist: 'Queen', title: 'Bohemian Rhapsody', from: 'metadata' }, 'song fields');
    eq(songIdentity({ metadata: { source: 'icy', class: 'song', raw: 'Fleetwood Mac - Dreams' } }), { artist: 'Fleetwood Mac', title: 'Dreams', from: 'icy' }, 'an ICY now-playing line');
    eq(songIdentity({ ingest: { id3: { artist: 'Daft Punk', title: 'Get Lucky' } } }), { artist: 'Daft Punk', title: 'Get Lucky', from: 'id3' }, 'ID3 tags');
    eq(songIdentity({ title: 'Morning show 7am' }), null, 'a programme title is not a song');
    eq(songIdentity({ title: 'Orange Crush - Infinite Lights', metadata: { artist: 'Orange Crush' } }), { artist: 'Orange Crush', title: 'Infinite Lights', from: 'metadata' }, 'artist filled, title empty: the song is the part of the asset title after the artist');
    eq(songIdentity({ title: 'Infinite Lights', metadata: { artist: 'Orange Crush' } }).title, 'Infinite Lights', 'an asset titled with just the song');
    const fields = [{ key: 'album', type: 'string' }, { key: 'genre', type: 'enum', options: ['Rock', 'Pop'], multiple: true }, { key: 'released', type: 'date' }, { key: 'isrc', type: 'string' }, { key: 'label', type: 'string' }];
    eq(fillsFor({ state: 'hit', album: 'A Night at the Opera', genres: ['progressive rock'], released: '1975', isrc: 'GB1', label: 'EMI' }, { label: 'Hollywood' }, fields),
      { album: 'A Night at the Opera', isrc: 'GB1', released: '1975-01-01', genre: ['Rock'] }, 'only empty fields; genre mapped to the type\'s options; a year becomes a date');
    eq(fillsFor({ state: 'miss' }, {}, fields), {}, 'a miss fills nothing');
  }

  console.log('== frames ==');
  const frame = (name: string, args: string[]) => { const f = join(tmp, `${name}.jpg`); ff([...args, '-frames:v', '1', f]); return readFileSync(f); };
  const F = {
    bars: frame('bars', ['-f', 'lavfi', '-i', 'smptebars=s=1280x720']),
    black: frame('black', ['-f', 'lavfi', '-i', 'color=c=black:s=1280x720']),
    flat: frame('flat', ['-f', 'lavfi', '-i', 'color=c=0x203060:s=1280x720']),
    scene: frame('scene', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720']),
  };
  ff(['-i', join(tmp, 'scene.jpg'), '-vf', 'gblur=sigma=12', join(tmp, 'soft.jpg')]);
  const soft = readFileSync(join(tmp, 'soft.jpg'));
  {
    const sc = async (b: Buffer, at = 0.4) => scoreFrame(await frameStats(b), at);
    eq([(await sc(F.bars)).rejected, (await sc(F.black)).rejected, (await sc(F.flat)).rejected], ['bars', 'black', 'flat'], 'colour bars, black and a flat card are rejected');
    const s = await sc(F.scene), b = await sc(soft);
    ok(s.score > b.score + 15 && b.notes.includes('soft'), 'a sharp frame beats the same frame blurred', `${s.score} vs ${b.score}`);
    ok((await sc(F.scene, 0.01)).score < s.score, 'the very start is discounted');
    const p = pickFrame([{ key: 'a', origin: 'live', score: 0, rejected: 'black' }, { key: 'b', origin: 'live', score: 80, atMs: 83_000, notes: ['sharp'] }]);
    ok(p.best?.key === 'b' && /Best of 2 frames at 01:23 \(sharp\); skipped 1 black/.test(p.reason), 'the reason says which and why', p.reason);
  }

  console.log('== variants, Deezer scoring, folders, station fills ==');
  {
    const { queryVariants, scoreDeezerTrack } = await import('../src/services/media/musicLookup');
    const { slug, assetFolder, songFolder } = await import('../src/services/media/libraryPaths');
    const { stationFills } = await import('../src/services/media/assetImage');
    eq(queryVariants({ artist: 'Calvin Harris', title: 'One Kiss (with Dua Lipa)' }).map((v) => `${v.variant}: ${v.artist} | ${v.title}`),
      ['as given: Calvin Harris | One Kiss (with Dua Lipa)', 'cleaned: Calvin Harris | One Kiss', 'artist and title swapped: One Kiss | Calvin Harris'], '"(with ...)" cleaned off; swapped last');
    eq(queryVariants({ artist: 'Orange Crush', title: 'Infinite Lights (Original Mix)' })[1].title, 'Infinite Lights', '"(Original Mix)" is the plain track');
    eq(queryVariants({ artist: 'A', title: 'Song (Tour 2019)' }).map((v) => v.variant), ['as given', 'without brackets', 'artist and title swapped'], 'any other bracket: a last-resort variant');
    const dz = (o: any) => ({ title: 'Infinite Lights', title_short: 'Infinite Lights', title_version: '', duration: 282, artist: { name: 'Orange Crush' }, ...o });
    const w = { artist: 'Orange Crush', title: 'Infinite Lights', durationMs: 282_000 };
    ok(scoreDeezerTrack(dz({}), w).score === 100 && scoreDeezerTrack(dz({ title_version: '(Live)', duration: 400 }), w).score < 70 && scoreDeezerTrack(dz({ artist: { name: 'Someone Else' } }), w).score < 70, 'Deezer: exact wins; a live version or another artist is below the floor');
    eq([slug('Orange Crush'), slug('Beyoncé & JAY-Z'), slug('  '), songFolder('Orange Crush', 'Infinite Lights', 'Infinite Lights')],
      ['orange-crush', 'beyonce-and-jay-z', 'untitled', 'media/orange-crush/infinite-lights/infinite-lights'], 'folder names: lower case, hyphens, no spaces');
    eq([assetFolder({ schemaKey: 'song', metadata: { artist: 'Queen', album: 'A Night at the Opera', title: 'Bohemian Rhapsody' } }),
        assetFolder({ metadata: { series: 'Bluey', episode: 'Keepy Uppy' } }),
        assetFolder({ eventName: 'Super Rugby R9', when: Date.UTC(2026, 9, 20) }),
        assetFolder({ channelName: 'Volt FM', programmeTitle: 'Breakfast', when: '2026-10-21T06:00:00Z' }),
        assetFolder({ title: 'Board meeting', when: Date.UTC(2026, 9, 1) })],
      ['media/queen/a-night-at-the-opera/bohemian-rhapsody', 'media/bluey/keepy-uppy', 'media/super-rugby-r9/2026-10-20', 'media/volt-fm/breakfast/2026-10-21', 'media/board-meeting/2026-10-01'],
      'a song, an episode, an event, a station programme, an upload');
    const fields = [{ key: 'name', type: 'string' }, { key: 'description', type: 'text' }, { key: 'logo', type: 'image' }, { key: 'genre', type: 'enum', multiple: true }, { key: 'frequency', type: 'string' }];
    eq(stationFills({ channel_kind: 'radio', channel_name: 'Volt FM', brand_ref: '/library/x/brand/a.png', channel_metadata: { description: 'Brisbane\'s home of music', genre: ['Music'], frequency: '104.5' }, schema_fields: fields, metadata: { frequency: '99.9' } }),
      { name: 'Volt FM', description: 'Brisbane\'s home of music', logo: '/library/x/brand/a.png', genre: ['Music'] }, 'a radio asset takes the station\'s name, description, logo and the rest; only empty fields');
    eq(stationFills({ channel_kind: 'tv', schema_fields: fields }), {}, 'not for TV');
  }

  console.log('== pages, Apple, when to look up ==');
  {
    const pm = await import('../src/services/media/pageMeta');
    const { scoreAppleTrack, appleAlbum } = await import('../src/services/media/musicLookup');
    const { mayLookUp } = await import('../src/services/media/assetImage');
    const apple = pm.songFromHtml(`<html><head><meta property="og:title" content="Infinite Lights by Orange Crush on Apple Music"><meta property="og:image" content="https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/x/859744508873_cover.jpg/1200x630wp-60.jpg">
      <script type="application/ld+json">{"@context":"http://schema.org","@type":"MusicComposition","name":"Infinite Lights","datePublished":"2020-12-17","timeRequired":"PT4M42S",
      "image":"https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/x/859744508873_cover.jpg/1200x630bb.jpg","audio":{"@type":"MusicRecording","name":"Infinite Lights","byArtist":[{"@type":"MusicGroup","name":"Orange Crush"}],"inAlbum":{"name":"Infinite Lights - Single"},"duration":"PT4M42S"}}</script></head></html>`, 'https://music.apple.com/us/album/x');
    eq([apple.artist, apple.title, apple.album, apple.released, apple.lengthMs, apple.image],
      ['Orange Crush', 'Infinite Lights', 'Infinite Lights', '2020-12-17', 282_000, 'https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/x/859744508873_cover.jpg/1200x1200bb.jpg'],
      'an Apple Music page: schema.org details, the single\'s name, the square cover at 1200 px');
    const og = pm.songFromHtml(`<meta content="Beds Are Burning - Midnight Oil" property="og:title"><meta property='og:image' content='/a.jpg'><meta property="music:release_date" content="1987-08-01">`, 'https://label.example/beds');
    eq([og.artist, og.title, og.released, og.image], ['Beds Are Burning', 'Midnight Oil', '1987-08-01', 'https://label.example/a.jpg'], 'Open Graph only: the title split, a relative image made absolute');
    eq([pm.isoDate('18 Dec 2020 00:00:00 GMT'), pm.isoDate('2020'), pm.isoDate('soon'), pm.durationMs('P00H04M42S'), pm.durationMs('4:42')], ['2020-12-18', '2020', null, 282_000, 282_000], 'dates and lengths in the forms pages use');
    eq(pm.bestImage('https://f4.bcbits.com/img/a1703361470_16.jpg'), 'https://f4.bcbits.com/img/a1703361470_10.jpg', 'Bandcamp: the original-size cover');
    eq(pm.splitTitle('Infinite Lights, by Orange Crush'), { title: 'Infinite Lights', artist: 'Orange Crush' }, 'Bandcamp\'s "Song, by Artist"');
    ok(pm.saysNothing(pm.songFromHtml('<title>Search results</title>', 'https://x.example/')), 'a search page says nothing about a song');
    ok(scoreAppleTrack({ artistName: 'Orange Crush', trackName: 'Infinite Lights', trackTimeMillis: 282000 }, { artist: 'Orange Crush', title: 'Infinite Lights', durationMs: 282000 }).score === 100
      && scoreAppleTrack({ artistName: 'Orange Crush', trackName: 'Infinite Lights (Live)', trackTimeMillis: 400000 }, { artist: 'Orange Crush', title: 'Infinite Lights', durationMs: 282000 }).score < 70, 'Apple: the original wins, a live version is below the floor');
    eq(appleAlbum('Infinite Lights - Single'), 'Infinite Lights', '"- Single" is not part of the name');
    const tm = await import('../src/services/radio/trackMeta');
    const block = "StreamTitle='Orange Crush – Infinite Lights';StreamUrl='https://somafm.com/logos/512/defcon512.jpg';";
    eq([tm.icyStreamTitle(block), tm.icyStreamUrl(block), tm.parseIcyTitle(block), tm.parseIcyTitle('Fleetwood Mac — Dreams'), tm.parseIcyTitle("StreamTitle='It's Not Over - Daughtry';")],
      ['Orange Crush – Infinite Lights', 'https://somafm.com/logos/512/defcon512.jpg', { artist: 'Orange Crush', title: 'Infinite Lights' }, { artist: 'Fleetwood Mac', title: 'Dreams' }, { artist: "It's Not Over", title: 'Daughtry' }],
      "the station's whole ICY block: just the title; en and em dashes split artist and song");
    eq(songIdentity({ metadata: { source: 'icy', class: 'song', raw: block } }), { artist: 'Orange Crush', title: 'Infinite Lights', from: 'icy' }, 'a clip cut from it knows the song');
    eq([mayLookUp({}, {}), mayLookUp({ music_lookup: { at: 'x', state: 'hit' } }, {}), mayLookUp({ music_lookup: { at: 'x', state: 'miss' } }, {}),
        mayLookUp({ music_lookup: { at: 'x', state: 'error', attempts: 1 } }, {}), mayLookUp({ music_lookup: { at: 'x', state: 'error', attempts: 3 } }, {}),
        mayLookUp({ music_lookup: { at: 'x', state: 'hit' } }, { userCheck: true }), mayLookUp({}, { lookup: false })],
      [true, false, false, true, false, true, false], 'look up when created; again only when a person checks (or a lookup that could not run, three tries)');
  }

  // ---- the database ----------------------------------------------------------
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { imageStore } = await import('../src/services/imageStore');
  const { ensureStandardTypes } = await import('../src/services/contentTypes');
  const { pickAssetImage, extractFrames } = await import('../src/services/media/assetImage');
  const { sweepUnpicked } = await import('../src/services/jobs/handlers/vodImage');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`img-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`img-o-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `img-${tag}@volt.test`]))!.id;
  const ouser = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `img-o-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  await ensureStandardTypes(acct);
  const { normKey } = await import('../src/services/radio/trackMeta');
  await query(`DELETE FROM music_lookups WHERE norm_key = ANY($1)`, [[normKey('Queen', 'Bohemian Rhapsody'), normKey('Garage Band', 'Nobody Knows')]]);
  const songType = (await one<any>(`SELECT id FROM metadata_schemas WHERE account_id = $1 AND standard_key = 'song'`, [acct]))!.id;
  const put = async (path: string, buf: Buffer) => { await imageStore().put(`library/${acct}/${path}`, buf, 'image/jpeg'); return `/library/${acct}/${path}`; };
  const artwork = await put('brand/station.jpg', F.scene);
  const progImg = await put('brand/breakfast.jpg', F.scene);
  const radio = (await one<any>(`INSERT INTO channels(group_id, name, kind, brand_ref) VALUES ($1,'Volt FM','radio',$2) RETURNING id`, [grp, artwork]))!.id;
  const tv = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Volt TV') RETURNING id`, [grp]))!.id;
  const T0 = Date.now() - 3600_000;
  const asset = async (o: any) => (await one<any>(
    `INSERT INTO vod_assets (channel_id, account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata, schema_id, export_mp3_key, ingest)
     VALUES ($1,$2,$3,'clip',$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb) RETURNING id`,
    [o.channel ?? null, o.channel ? null : acct, o.channel ? 'recording' : 'upload', o.title ?? 'Asset', o.start ?? T0, o.end ?? T0 + 600_000, o.dur ?? 600_000,
     JSON.stringify(o.metadata ?? {}), o.schema ?? null, o.mp3 ?? null, o.ingest ? JSON.stringify(o.ingest) : null]))!.id;
  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const otok = signAccess({ sub: ouser, account_id: other, role: 'owner' });
  const api = async (method: string, path: string, body?: any, t = tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${t}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let j: any = null; try { j = JSON.parse(text); } catch { j = text; } return { s: r.status, j };
  };

  try {
    console.log('== radio ==');
    const talk = await asset({ channel: radio, title: 'Drive time 4pm', mp3: 'x.mp3' });
    let r = await pickAssetImage(talk);
    ok(r.source === 'station' && r.shape === 'square' && r.key === artwork.slice(1) && /station artwork of Volt FM/.test(r.reason), 'a radio programme clip uses the station artwork, square', JSON.stringify(r));
    const breakfast = await asset({ channel: radio, title: 'Breakfast', mp3: 'x.mp3' });
    await query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at, metadata, clip_asset_id) VALUES ($1,'Breakfast',now() - interval '3 hours', now() - interval '1 hour', $2::jsonb, $3)`,
      [radio, JSON.stringify({ image: progImg }), breakfast]);
    r = await pickAssetImage(breakfast);
    ok(r.source === 'programme' && r.shape === 'square' && r.key === progImg.slice(1), 'a guide programme with its own image uses it', JSON.stringify(r));

    console.log('== songs ==');
    hits.length = 0;
    const song = await asset({ channel: radio, title: 'Bohemian Rhapsody', mp3: 'x.mp3', dur: 355_000, schema: songType, metadata: { title: 'Bohemian Rhapsody', artist: 'Queen', label: 'Hollywood' } });
    r = await pickAssetImage(song);
    const row = await one<any>(`SELECT poster_key, poster_shape, metadata, metadata_provenance, music_lookup FROM vod_assets WHERE id = $1`, [song]);
    ok(r.source === 'cover_art' && row.poster_shape === 'square' && row.poster_key === `library/${acct}/media/queen/a-night-at-the-opera/bohemian-rhapsody/cover.jpg`, 'a song gets its album cover, square, in the Image Library', JSON.stringify(r));
    ok(!!(await imageStore().get(row.poster_key)) && !!(await one(`SELECT 1 FROM media_files WHERE account_id = $1 AND path = 'media/queen/a-night-at-the-opera/bohemian-rhapsody/cover.jpg' AND source = 'auto'`, [acct])), 'the cover is a library image');
    eq([row.metadata.album, row.metadata.isrc, row.metadata.released, row.metadata.genre, row.metadata.label], ['A Night at the Opera', 'GBUM71029604', '1975-11-21', ['Rock'], 'Hollywood'], 'empty song fields filled; the label someone typed is kept');
    ok(row.metadata_provenance.album?.source === 'musicbrainz' && !row.metadata_provenance.label && row.music_lookup.recordingMbid === 'studio', 'provenance says MusicBrainz for what it filled');
    ok(hits.some((h) => h.startsWith('/ws/2/recording?')) && hits.filter((h) => h.startsWith('/cover/')).length === 1, 'searched, then one cover download');
    hits.length = 0;
    const again = await asset({ channel: radio, title: 'Bohemian Rhapsody', mp3: 'x.mp3', metadata: { source: 'icy', class: 'song', raw: 'Queen - Bohemian Rhapsody' } });
    r = await pickAssetImage(again);
    ok(r.source === 'cover_art' && hits.length === 0, 'the same song again: cached match, cover already in the library, no calls', JSON.stringify(hits));
    const unknown = await asset({ channel: radio, title: 'Nobody Knows', mp3: 'x.mp3', metadata: { source: 'icy', class: 'song', raw: 'Garage Band - Nobody Knows' } });
    r = await pickAssetImage(unknown);
    ok(r.source === 'station' && /No confident match/.test(r.reason), 'no confident match: the station artwork, and it says so', r.reason);

    console.log('== video: live keyframes ==');
    const clip = await asset({ channel: tv, title: 'Match highlights', start: T0, end: T0 + 300_000, dur: 300_000 });
    const frames: [string, Buffer, number][] = [['bars', F.bars, 2_000], ['black', F.black, 60_000], ['soft', soft, 120_000], ['scene', F.scene, 180_000], ['flat', F.flat, 240_000]];
    for (const [n, buf, at] of frames) {
      const key = `library/${acct}/thumbnails/tv/${n}.jpg`;
      await imageStore().put(key, buf, 'image/jpeg');
      await query(`INSERT INTO media_files(account_id, kind, path, folder, name, store_key, size_bytes, source, channel_id, captured_at) VALUES ($1,'keyframe',$2,'thumbnails/tv',$3,$4,$5,'encoder',$6,to_timestamp($7/1000.0))`,
        [acct, `thumbnails/tv/${n}.jpg`, `${n}.jpg`, key, buf.length, tv, T0 + at]);
    }
    r = await pickAssetImage(clip);
    const cl = await one<any>(`SELECT poster_key, poster_candidates FROM vod_assets WHERE id = $1`, [clip]);
    ok(r.source === 'live_frame' && r.shape === 'wide' && cl.poster_candidates[0].key.endsWith('/scene.jpg'), 'the sharp scene wins over bars, black, soft and flat', JSON.stringify(cl.poster_candidates.map((c: any) => [c.key.split('/').pop(), c.score, c.rejected])));
    ok(/^library\/[^/]+\/media\/volt-tv\/match-highlights\/\d{4}-\d{2}-\d{2}\/poster\.jpg$/.test(cl.poster_key) && /Best of 5 frames at 03:00.*skipped 1 bars, 1 black, 1 flat/.test(r.reason), 'copied into the library (keyframes are swept), with the reason', r.reason);

    console.log('== video: upload frames ==');
    const vid = join(tmp, 'up.mp4');
    ff(['-f', 'lavfi', '-i', 'smptebars=s=640x360:d=2', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=8', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=2',
      '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0', '-pix_fmt', 'yuv420p', vid]);
    const up = await asset({ title: 'Uploaded', dur: 12_000 });
    await query(`UPDATE vod_assets SET encode_result = '{}'::jsonb WHERE id = $1`, [up]);
    const cands = await extractFrames(up, acct, vid, 12_000, 10);
    ok(cands.length >= 8 && cands.some((c) => c.rejected === 'bars') && cands.some((c) => c.rejected === 'black'), 'frames spread over the file, the bars and the black tail rejected', JSON.stringify(cands.map((c) => [c.atMs, c.score, c.rejected])));
    r = await pickAssetImage(up);
    ok(r.source === 'frame' && Number(/at 00:0(\d)/.exec(r.reason)?.[1]) >= 2 && Number(/at 00:(\d\d)/.exec(r.reason)?.[1]) < 10, 'an upload\'s picture comes from the programme itself', r.reason);

    console.log('== sprites + backfill ==');
    {
      const { buildFileSprites, fileSpriteVtt, spriteInterval } = await import('../src/services/thumbnails/fileSprites');
      const sp = await buildFileSprites(up, acct, vid, 12_000);
      ok(!!sp && sp.sheets.length >= 1 && !!(await imageStore().get(sp.sheets[0].key)) && sp.sheets[0].key.startsWith(`library/${acct}/thumbnails/files/${up}/`), 'an upload gets sprite sheets in the library', JSON.stringify(sp));
      const vtt = fileSpriteVtt(sp!, (k) => `/img/x/${k}`);
      const cues = vtt.split('\n').filter((l) => l.includes(' --> '));
      ok(vtt.startsWith('WEBVTT') && cues.length === Math.ceil(12_000 / sp!.intervalMs) && /#xywh=\d+,\d+,\d+,\d+/.test(vtt) && cues[0].startsWith('00:00:00.000 --> '), 'one cue per tile across the file', `${cues.length} cues, every ${sp!.intervalMs} ms`);
      eq([spriteInterval(40_000), spriteInterval(3600_000), spriteInterval(2 * 3600_000)], [1000, 18000, 36000], 'about 200 previews whatever the length, at least a second apart');
      const g = await fetch(`${base}/api/thumbnails/vod/${up}.vtt`, { headers: { authorization: `Bearer ${tok}` } });
      const text = await g.text();
      ok(g.status === 200 && /\/img\/[^/]+\/\d+x\d+,fill.*\/library\/.*sheet-000\.jpg#xywh=0,0,/.test(text), 'the VTT route serves it with signed sheet URLs', text.slice(0, 200));
      const old = await asset({ title: 'Uploaded last month', dur: 12_000 });
      await query(`UPDATE vod_assets SET encode_result = '{}'::jsonb, source_key = $2 WHERE id = $1`, [old, vid]);
      const { prepareFileFrames } = await import('../src/services/media/assetImage');
      ok(await prepareFileFrames(old), 'an upload from before: frames and sprites built from its source file');
      const o = await one<any>(`SELECT sprite, poster_candidates, storyboard_key FROM vod_assets WHERE id = $1`, [old]);
      ok(o.sprite?.sheets?.length >= 1 && o.poster_candidates?.length >= 8 && o.storyboard_key, 'recorded on the asset');
      ok(!(await prepareFileFrames(old)), 'and not again unless asked');
    }

    console.log('== API ==');
    let g = await api('GET', `/api/vod/${clip}/image`);
    ok(g.s === 200 && g.j.source === 'live_frame' && /\/img\/[^/]+\/960x540,cover\/library\//.test(g.j.url) && g.j.candidates.length === 5 && /\/img\/.*320x180/.test(g.j.candidates[0].url), 'GET: image, reason and signed candidate URLs', JSON.stringify(g.j).slice(0, 300));
    const pickKey = g.j.candidates.find((c: any) => c.key.endsWith('/soft.jpg')).key;
    g = await api('PUT', `/api/vod/${clip}/image`, { ref: pickKey });
    ok(g.s === 200 && g.j.source === 'manual' && g.j.locked && /chosen by/.test(g.j.reason), 'choose a frame by hand: locked', JSON.stringify(g.j).slice(0, 200));
    r = await pickAssetImage(clip);
    ok(r.skipped === 'locked' && (await one<any>(`SELECT poster_source FROM vod_assets WHERE id = $1`, [clip])).poster_source === 'manual', 'automatic picks leave a manual choice alone');
    g = await api('PUT', `/api/vod/${clip}/image`, { ref: progImg });
    ok(g.s === 200 && g.j.key === progImg.slice(1), 'or any Image Library image');
    g = await api('PUT', `/api/vod/${clip}/image`, { ref: `/library/${other}/x.jpg` });
    ok(g.s === 400, 'not another account\'s image');
    g = await api('POST', `/api/vod/${clip}/image/auto`, {});
    ok(g.s === 200 && g.j.source === 'live_frame' && !g.j.locked, 'pick automatically again: unlocked');
    g = await api('GET', `/api/vod/${clip}/image`, undefined, otok);
    ok(g.s === 404, 'another account cannot see it');
    g = await api('GET', `/api/vod/${song}/image`);
    ok(g.j.song && g.j.audio && g.j.shape === 'square' && g.j.music?.album === 'A Night at the Opera', 'a song: audio, square, the lookup shown');
    const list = await api('GET', `/api/vod?limit=50`);
    const byId = new Map((Array.isArray(list.j) ? list.j : list.j.items ?? []).map((x: any) => [x.id, x]));
    ok((byId.get(song) as any)?.audio_only === true && (byId.get(clip) as any)?.audio_only === false && (byId.get(song) as any)?.poster_shape === 'square', 'the list says audio or not, and the shape', JSON.stringify([...byId.keys()].length));

    console.log('== providers: MusicBrainz, then Deezer ==');
    {
      const { config } = await import('../src/config');
      const { songMatch } = await import('../src/services/media/musicLookup');
      await query(`DELETE FROM music_lookups WHERE norm_key = $1`, [normKey('Orange Crush', 'Infinite Lights')]);
      config.trackMeta.providers.splice(0, Infinity, 'musicbrainz');
      let m = await songMatch('Orange Crush', 'Infinite Lights', 282_000);
      ok(m.state === 'miss' && /musicbrainz: no match/i.test(m.reason ?? ''), 'MusicBrainz alone: a miss, every variant and a single tried', m.reason);
      config.trackMeta.providers.splice(0, Infinity, 'musicbrainz', 'deezer');
      hits.length = 0;
      m = await songMatch('Orange Crush', 'Infinite Lights', 282_000);
      ok(m.state === 'hit' && m.provider === 'deezer' && m.album === 'Infinite Lights' && m.isrc === 'TCAFH2072219' && m.released === '2020-12-17' && m.label === 'Orange Crush' && m.genres?.join() === 'Electro,Dance',
        'Deezer switched on: the cached miss is asked again, and Deezer has the single (album, ISRC, date, label, genres)', JSON.stringify(m));
      ok(!/Live at Home/.test(m.album ?? ''), 'the live version lost to the original');
      const oc = await asset({ channel: radio, title: 'Orange Crush - Infinite Lights', mp3: 'x.mp3', dur: 282_000, metadata: { source: 'icy', class: 'song', raw: 'Orange Crush - Infinite Lights' } });
      const r2 = await pickAssetImage(oc);
      ok(r2.source === 'cover_art' && r2.key === `library/${acct}/media/orange-crush/infinite-lights/infinite-lights/cover.jpg` && /Deezer match 100\/100, image from Deezer/.test(r2.reason), 'its cover, from Deezer, under media/orange-crush/infinite-lights/infinite-lights/', r2.reason);
      const mf = await one<any>(`SELECT metadata FROM media_files WHERE account_id = $1 AND store_key = $2`, [acct, r2.key]);
      ok(mf?.metadata?.provider === 'deezer' && /deezer.com\/track/.test(mf.metadata.link ?? ''), 'the library file says where it came from');

      console.log('== the cover on the guide entry, as the song airs ==');
      const { attachSongArtwork } = await import('../src/services/jobs/handlers/songArtwork');
      const pg = (await one<any>(`INSERT INTO programmes(channel_id, source_ref, title, starts_at, ends_at, status, metadata) VALUES ($1,$2,'Orange Crush - Infinite Lights', now(), now() + interval '1 second','live',$3::jsonb) RETURNING id`,
        [radio, `icy:${Date.now()}`, JSON.stringify({ source: 'icy', class: 'song', raw: 'Orange Crush - Infinite Lights' })]))!.id;
      hits.length = 0;
      const a1 = await attachSongArtwork(pg);
      const pmd = (await one<any>(`SELECT metadata FROM programmes WHERE id = $1`, [pg]))!.metadata;
      ok(a1.image === `/library/${acct}/media/orange-crush/infinite-lights/infinite-lights/cover.jpg` && pmd.image === a1.image && pmd.album === 'Infinite Lights' && pmd.music?.provider === 'deezer', 'the guide entry gets the cover and the album', JSON.stringify(pmd));
      ok(hits.length === 0, 'a song played before: cached match, cover already stored, no external call', JSON.stringify(hits));
      eq((await attachSongArtwork(pg)).result, 'already has an image', 'and once only');
      const pg2 = (await one<any>(`INSERT INTO programmes(channel_id, source_ref, title, starts_at, ends_at, status, metadata) VALUES ($1,$2,'Some Band - New Song', now(), now() + interval '1 second','live',$3::jsonb) RETURNING id`,
        [radio, `icy:${Date.now() + 1}`, JSON.stringify({ source: 'icy', class: 'song', raw: 'Some Band - New Song', stream_url: `http://127.0.0.1:${mbPort}/dz/cover/feed.jpg` })]))!.id;
      hits.length = 0;
      const a2 = await attachSongArtwork(pg2);
      ok(a2.result === 'artwork from the station feed' && hits.every((h) => !h.startsWith('/ws/2') && !h.startsWith('/dz/search')), 'artwork the station sends is used, without a lookup', JSON.stringify([a2, hits]));
      config.trackMeta.providers.splice(0, Infinity, 'musicbrainz');
      // The cached match points at this test's mock server: not for anyone else.
      await query(`DELETE FROM music_lookups WHERE norm_key = ANY($1)`, [[normKey('Orange Crush', 'Infinite Lights'), normKey('Some Band', 'New Song')]]);
    }

    console.log('== station fields, image fields, a person\'s image ==');
    {
      const stType = (await one<any>(`SELECT id FROM metadata_schemas WHERE account_id = $1 AND standard_key = 'radio-station'`, [acct]))!.id;
      await query(`UPDATE channels SET metadata = $2::jsonb WHERE id = $1`, [radio, JSON.stringify({ description: 'Brisbane\'s home of music', genre: ['Music'] })]);
      const prog = await asset({ channel: radio, title: 'Saturday Sessions', mp3: 'x.mp3', schema: stType });
      await pickAssetImage(prog);
      const pr = await one<any>(`SELECT metadata, metadata_provenance FROM vod_assets WHERE id = $1`, [prog]);
      ok(pr.metadata.name === 'Volt FM' && pr.metadata.description === 'Brisbane\'s home of music' && pr.metadata.logo === artwork && pr.metadata_provenance.logo?.source === 'station',
        'a station programme\'s fields come from its station: name, description, logo', JSON.stringify(pr.metadata));
      const clipType = (await one<any>(`SELECT id, fields FROM metadata_schemas WHERE account_id = $1 AND standard_key = 'clip'`, [acct]))!;
      ok(clipType.fields.some((f: any) => f.key === 'thumbnail' && f.type === 'image'), 'standard image fields are of type image');
      const vidA = await asset({ channel: tv, title: 'Press conference', schema: clipType.id });
      const req1 = clipType.fields.filter((f: any) => f.required).reduce((o: any, f: any) => ({ ...o, [f.key]: f.type === 'date' ? '2026-10-21' : 'x' }), {});
      let p = await api('PUT', `/api/vod/${vidA}`, { metadata: { ...req1, thumbnail: `http://127.0.0.1:${mbPort}/img/logo.png` } });
      const saved = await one<any>(`SELECT metadata FROM vod_assets WHERE id = $1`, [vidA]);
      ok(p.s === 200 && /^\/library\/[^/]+\/media\/volt-tv\/press-conference\/\d{4}-\d{2}-\d{2}\/thumbnail\.png$/.test(saved.metadata.thumbnail ?? ''), 'a web address in an image field is copied into the library, in the asset\'s folder', JSON.stringify([p.s, p.j, saved.metadata]));
      p = await api('PUT', `/api/vod/${vidA}`, { metadata: { ...req1, thumbnail: `/library/${other}/x.jpg` } });
      ok(p.s === 422 && /another account/.test(p.j.error ?? ''), 'another account\'s image is refused', JSON.stringify(p.j));
      const r3 = await pickAssetImage(vidA);
      ok(r3.source === 'metadata' && r3.key === saved.metadata.thumbnail.slice(1), 'an image a person set wins over frames', JSON.stringify(r3));
      const songRow = await one<any>(`SELECT metadata, metadata_provenance FROM vod_assets WHERE id = $1`, [song]);
      ok(/^\/library\/.*\/cover\.jpg$/.test(songRow.metadata.artwork ?? '') && songRow.metadata_provenance.artwork?.source === 'musicbrainz', 'a song\'s artwork field is filled with its cover (by Volt, so a better match can replace it)');
      const r4 = await pickAssetImage(song);
      ok(r4.source === 'cover_art', 'Volt\'s own fill does not count as a person\'s image');
    }

    console.log('== look up once; a person checks and approves ==');
    {
      // An asset that already has its image and song details: no lookup at all.
      const full = await asset({ channel: radio, title: 'Queen - Bohemian Rhapsody', mp3: 'x.mp3', dur: 355_000, schema: songType,
        metadata: { title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', artwork: artwork } });
      hits.length = 0;
      const rf = await pickAssetImage(full);
      ok(rf.source === 'metadata' && hits.length === 0 && /already had an image and song details/.test(rf.music?.reason ?? ''), 'image and details already there: no lookup', JSON.stringify([rf.source, rf.music, hits]));
      // An image but no album: looked up for the details, the image kept.
      const half = await asset({ channel: radio, title: 'Queen - Bohemian Rhapsody', mp3: 'x.mp3', dur: 355_000, schema: songType, metadata: { title: 'Bohemian Rhapsody', artist: 'Queen', artwork: artwork } });
      const rh = await pickAssetImage(half);
      const hm = (await one<any>(`SELECT metadata FROM vod_assets WHERE id = $1`, [half]))!.metadata;
      ok(rh.source === 'metadata' && hm.album === 'A Night at the Opera' && hm.artwork === artwork, 'an image but no album: the album filled, the image kept', JSON.stringify([rh.source, hm]));

      // Looked up once when created; Pick again and saving metadata do not ask again.
      const { config } = await import('../src/config');
      config.trackMeta.providers.splice(0, Infinity, 'musicbrainz');
      await query(`DELETE FROM music_lookups WHERE norm_key = ANY($1)`, [[normKey('Orange Crush', 'Infinite Lights')]]);
      const oc = await asset({ channel: radio, title: 'Orange Crush - Infinite Lights', mp3: 'x.mp3', dur: 282_000, schema: songType,
        metadata: { source: 'icy', class: 'song', raw: 'Orange Crush - Infinite Lights', label: 'My Label' } });
      const r1 = await pickAssetImage(oc);
      const ml1 = (await one<any>(`SELECT music_lookup FROM vod_assets WHERE id = $1`, [oc]))!.music_lookup;
      ok(r1.source === 'station' && ml1.state === 'miss' && ml1.attempts === 1 && ml1.at, 'created: looked up once (MusicBrainz has no match), the station artwork meanwhile', JSON.stringify(ml1));
      hits.length = 0;
      let p = await api('POST', `/api/vod/${oc}/image/auto`, {});
      const ml2 = (await one<any>(`SELECT music_lookup FROM vod_assets WHERE id = $1`, [oc]))!.music_lookup;
      ok(p.s === 200 && hits.every((h) => !h.startsWith('/ws/2') && !h.startsWith('/dz') && !h.startsWith('/itunes')) && ml2.attempts === 1 && ml2.at === ml1.at, 'Pick again: no new lookup', JSON.stringify([hits, ml2]));

      // The person checks: every source plus a page they pasted; nothing changes yet.
      hits.length = 0;
      p = await api('POST', `/api/vod/${oc}/song/find`, { url: `http://127.0.0.1:${mbPort}/page/oc.html` });
      const by = (x: string) => p.j.results?.find((r: any) => r.provider === x);
      ok(p.s === 200 && by('musicbrainz')?.state === 'miss' && by('deezer')?.state === 'hit' && by('apple')?.state === 'hit' && by('page')?.state === 'hit', 'Find song details: MusicBrainz, Deezer, Apple and the page, side by side', JSON.stringify(p.j.results?.map((r: any) => [r.provider, r.state, r.reason])));
      eq([by('apple')?.album, by('apple')?.coverUrl?.endsWith('/1200x1200bb.jpg'), /promote/.test(by('apple')?.terms ?? '')], ['Infinite Lights', true, true], 'Apple: the single, its big cover, and its terms shown');
      eq([by('page')?.album, by('page')?.released, by('page')?.label, by('page')?.isrc, by('page')?.coverUrl?.endsWith('/dz/cover/page_10.jpg')], ['Infinite Lights', '2020-12-18', 'Orange Crush Music', 'TCAFH2072219', true], 'the page: album, date, label, ISRC, original cover');
      ok(by('page')?.proposed?.released === '2020-12-18' && by('page')?.proposed?.label === 'Orange Crush Music' && p.j.current?.metadata?.label === 'My Label' && p.j.current.fields.some((f: any) => f.key === 'label'),
        'each find as the asset\'s fields, next to what it has now', JSON.stringify([by('page')?.proposed, p.j.current?.metadata]));
      ok(p.j.searchLinks?.some((l: any) => l.site === 'Bandcamp' && /bandcamp\.com\/search\?q=Orange%20Crush%20Infinite%20Lights/.test(l.url)), 'links to search Bandcamp and others in the browser');
      const still = (await one<any>(`SELECT metadata, poster_source FROM vod_assets WHERE id = $1`, [oc]))!;
      ok(still.metadata.label === 'My Label' && !still.metadata.album && still.poster_source === 'station', 'finding changes nothing');
      const pb = await api('POST', `/api/vod/${oc}/song/find`, { url: `http://127.0.0.1:${mbPort}/page/blocked.html`, providers: [] });
      ok(pb.j.results?.[0]?.state === 'blocked' && /Copy image address/.test(pb.j.results[0].reason), 'a site that blocks programs: says so, and how to get the image instead', JSON.stringify(pb.j.results));
      const ps = await api('POST', `/api/vod/${oc}/song/find`, { url: `http://127.0.0.1:${mbPort}/page/search.html`, providers: [] });
      ok(ps.j.results?.[0]?.state === 'miss' && /does not describe a song/.test(ps.j.results[0].reason), 'a page about something else: says so');

      // Use the page's find, approving album and date only; the label stays, the image too.
      const pg = by('page');
      p = await api('POST', `/api/vod/${oc}/song/use`, { provider: 'page', artist: pg.artist, title: pg.title, album: pg.album, released: pg.released, label: pg.label, isrc: pg.isrc,
        link: pg.link, imageUrl: pg.coverUrl, fields: ['album', 'released'], useImage: false });
      let row = (await one<any>(`SELECT metadata, metadata_provenance, poster_source FROM vod_assets WHERE id = $1`, [oc]))!;
      ok(p.s === 200 && row.metadata.album === 'Infinite Lights' && row.metadata.released === '2020-12-18' && row.metadata.label === 'My Label' && row.poster_source === 'station'
        && row.metadata_provenance.album?.approvedBy && row.metadata_provenance.album?.source === 'page', 'only the approved fields change; the label and the image stay', JSON.stringify([p.s, p.j?.error, row.metadata]));
      // Now the cover and the label too.
      p = await api('POST', `/api/vod/${oc}/song/use`, { provider: 'page', artist: pg.artist, title: pg.title, album: pg.album, released: pg.released, label: pg.label, isrc: pg.isrc,
        link: pg.link, imageUrl: pg.coverUrl, fields: ['label', 'artwork'], useImage: true });
      row = (await one<any>(`SELECT metadata, poster_source, poster_key, poster_reason FROM vod_assets WHERE id = $1`, [oc]))!;
      ok(p.s === 200 && row.metadata.label === 'Orange Crush Music' && row.poster_source === 'cover_art' && row.poster_key === `library/${acct}/media/orange-crush/infinite-lights/infinite-lights/cover.jpg`
        && /Chosen by .* from a web page/.test(row.poster_reason) && row.metadata.artwork === `/${row.poster_key}`, 'approved: the label replaced, the cover in the song\'s folder and on the asset', JSON.stringify([p.j?.error, row]));

      // The next time the song airs, and a new clip of it: the chosen details, no lookup.
      const pgm = (await one<any>(`INSERT INTO programmes(channel_id, source_ref, title, starts_at, ends_at, status, metadata) VALUES ($1,$2,'Orange Crush - Infinite Lights', now(), now() + interval '1 second','live',$3::jsonb) RETURNING id`,
        [radio, `icy:${Date.now() + 7}`, JSON.stringify({ source: 'icy', class: 'song', raw: 'Orange Crush - Infinite Lights' })]))!.id;
      const { attachSongArtwork } = await import('../src/services/jobs/handlers/songArtwork');
      hits.length = 0;
      const aa = await attachSongArtwork(pgm);
      ok(aa.result === 'cover chosen for this song' && aa.image === `/${row.poster_key}` && hits.length === 0, 'on air again: the chosen cover, no lookup', JSON.stringify([aa, hits]));
      const oc2 = await asset({ channel: radio, title: 'Orange Crush - Infinite Lights', mp3: 'x.mp3', dur: 282_000, schema: songType, metadata: { source: 'icy', class: 'song', raw: 'Orange Crush - Infinite Lights' } });
      const r2 = await pickAssetImage(oc2);
      const m2 = (await one<any>(`SELECT metadata FROM vod_assets WHERE id = $1`, [oc2]))!.metadata;
      ok(r2.source === 'cover_art' && r2.key === row.poster_key && m2.album === 'Infinite Lights' && m2.label === 'Orange Crush Music' && hits.length === 0, 'a new clip of the song: the chosen details and cover at once', JSON.stringify([r2, m2, hits]));
      p = await api('DELETE', `/api/vod/${oc}/song/details`);
      ok(p.s === 200 && p.j.forgotten >= 1 && !(await one(`SELECT 1 FROM song_details WHERE account_id = $1`, [acct])), 'and it can be forgotten', JSON.stringify(p.j));
      p = await api('POST', `/api/vod/${oc}/song/find`, { providers: ['apple'] }, otok);
      ok(p.s === 404, 'another account cannot check it');
      await query(`DELETE FROM music_lookups WHERE norm_key = ANY($1)`, [[normKey('Orange Crush', 'Infinite Lights')]]);
    }

    console.log('== default chain: MusicBrainz, then Apple ==');
    {
      const { config } = await import('../src/config');
      const { songMatch } = await import('../src/services/media/musicLookup');
      const { attachSongArtwork } = await import('../src/services/jobs/handlers/songArtwork');
      const { listenLink } = await import('../src/modules/player');
      config.trackMeta.providers.splice(0, Infinity, 'musicbrainz', 'apple');
      await query(`DELETE FROM music_lookups WHERE norm_key = $1`, [normKey('Orange Crush', 'Infinite Lights')]);
      hits.length = 0;
      const m = await songMatch('Orange Crush', 'Infinite Lights', 282_000);
      ok(m.state === 'hit' && m.provider === 'apple' && m.album === 'Infinite Lights' && m.released === '2020-12-17' && /1200x1200bb\.jpg$/.test(m.coverUrl ?? '')
        && hits.some((h) => h.startsWith('/ws/2')) && hits.some((h) => h.startsWith('/itunes')) && !hits.some((h) => h.startsWith('/dz/search')),
        'MusicBrainz has nothing, Apple has the single; Deezer not asked', JSON.stringify([m, hits]));
      const pg = (await one<any>(`INSERT INTO programmes(channel_id, source_ref, title, starts_at, ends_at, status, metadata) VALUES ($1,$2,'Orange Crush - Infinite Lights', now(), now() + interval '1 second','live',$3::jsonb) RETURNING id`,
        [radio, `icy:${Date.now() + 11}`, JSON.stringify({ source: 'icy', class: 'song', raw: 'Orange Crush - Infinite Lights' })]))!.id;
      const aa = await attachSongArtwork(pg);
      const md = (await one<any>(`SELECT metadata FROM programmes WHERE id = $1`, [pg]))!.metadata;
      ok(aa.result === 'cover from apple' && md.music?.provider === 'apple' && /music\.apple\.com/.test(md.music?.link ?? ''), 'on air: the Apple cover, with its Apple Music link kept', JSON.stringify([aa, md.music]));
      eq(listenLink({ raw: 'x', startedAt: 0, image: md.image, provider: 'apple', link: md.music.link }), { service: 'Apple Music', url: md.music.link }, 'the player gets "Listen on Apple Music" with an Apple cover');
      eq([listenLink({ raw: 'x', startedAt: 0, image: md.image, provider: 'musicbrainz', link: 'https://musicbrainz.org/x' }), listenLink({ raw: 'x', startedAt: 0, image: null, provider: 'apple', link: md.music.link })], [null, null], 'and not for other covers, or with no cover');
      config.trackMeta.providers.splice(0, Infinity, 'musicbrainz');
      await query(`DELETE FROM music_lookups WHERE norm_key = $1`, [normKey('Orange Crush', 'Infinite Lights')]);
    }

    console.log('== a song found makes the asset a Song ==');
    {
      const { config } = await import('../src/config');
      config.trackMeta.providers.splice(0, Infinity, 'musicbrainz', 'apple');
      await query(`DELETE FROM music_lookups WHERE norm_key = $1`, [normKey('Orange Crush', 'Infinite Lights')]);
      const block = "StreamTitle='Orange Crush – Infinite Lights';StreamUrl='https://somafm.com/logos/512/defcon512.jpg';";
      // Cut from a recording, no content type: found automatically, so it becomes a Song with its fields.
      const cut = await asset({ channel: radio, title: 'Orange Crush - Infinite Lights', mp3: 'x.mp3', dur: 272_000, metadata: { source: 'icy', class: 'song', raw: block } });
      const rc = await pickAssetImage(cut);
      const row = (await one<any>(`SELECT schema_id, metadata FROM vod_assets WHERE id = $1`, [cut]))!;
      ok(rc.source === 'cover_art' && row.schema_id === songType && row.metadata.artist === 'Orange Crush' && row.metadata.album === 'Infinite Lights' && row.metadata.released === '2020-12-17' && row.metadata.title === 'Infinite Lights',
        'a song cut from a recording with no type: made a Song, its fields filled, the cover', JSON.stringify([rc.source, rc.reason, row]));
      // Another type: left as it is automatically.
      const clipT = (await one<any>(`SELECT id FROM metadata_schemas WHERE account_id = $1 AND standard_key = 'clip'`, [acct]))!.id;
      const other = await asset({ channel: radio, title: 'Orange Crush - Infinite Lights', mp3: 'x.mp3', dur: 272_000, schema: clipT, metadata: { source: 'icy', class: 'song', raw: block } });
      await pickAssetImage(other);
      eq((await one<any>(`SELECT schema_id FROM vod_assets WHERE id = $1`, [other]))!.schema_id, clipT, 'an asset of another type keeps it (a person decides)');
      // Find song details with the raw block typed in the boxes: cleaned; Song proposed, applied when ticked.
      let p = await api('POST', `/api/vod/${other}/song/find`, { artist: "StreamTitle='Orange Crush", title: "Infinite Lights';StreamUrl='https://somafm.com/logos/512/defcon512.jpg';", providers: ['apple'] });
      ok(p.s === 200 && p.j.query?.artist === 'Orange Crush' && p.j.query?.title === 'Infinite Lights' && p.j.results?.[0]?.state === 'hit', 'the raw block in the search boxes: searched as Orange Crush, Infinite Lights', JSON.stringify([p.j.query, p.j.results?.[0]?.state]));
      ok(p.j.contentType?.now?.id === clipT && p.j.contentType?.song?.id === songType && p.j.results[0].proposed?.album === 'Infinite Lights', 'it offers Song as the content type, and the Song fields');
      const f = p.j.results[0];
      p = await api('POST', `/api/vod/${other}/song/use`, { provider: 'apple', artist: f.artist, title: f.title, album: f.album, released: f.released, genres: f.genres, link: f.link, imageUrl: f.coverUrl,
        fields: ['artist', 'title', 'album', 'released'], useImage: true, setSong: true });
      const o2 = (await one<any>(`SELECT schema_id, metadata, poster_source FROM vod_assets WHERE id = $1`, [other]))!;
      ok(p.s === 200 && o2.schema_id === songType && o2.metadata.album === 'Infinite Lights' && o2.metadata.artist === 'Orange Crush' && o2.poster_source === 'cover_art',
        'ticked: made a Song, the fields and cover applied', JSON.stringify([p.j?.error, o2]));
      // The station's logo sent as StreamUrl with every song is not a song cover.
      const { attachSongArtwork } = await import('../src/services/jobs/handlers/songArtwork');
      await query(`DELETE FROM song_details WHERE account_id = $1`, [acct]);
      await query(`DELETE FROM music_lookups WHERE norm_key = $1`, [normKey('Some Band', 'Logo Song')]);
      const pl = (await one<any>(`INSERT INTO programmes(channel_id, source_ref, title, starts_at, ends_at, status, metadata) VALUES ($1,$2,'Some Band – Logo Song', now() + interval '1 hour', now() + interval '61 minutes','live',$3::jsonb) RETURNING id`,
        [radio, `icy:${Date.now() + 21}`, JSON.stringify({ source: 'icy', class: 'song', raw: "StreamTitle='Some Band – Logo Song';StreamUrl='http://127.0.0.1:" + mbPort + "/dz/cover/logos/station.jpg';", stream_url: `http://127.0.0.1:${mbPort}/dz/cover/logos/station.jpg` })]))!.id;
      const al = await attachSongArtwork(pl);
      ok(al.result !== 'artwork from the station feed', 'a StreamUrl that is the station logo is not taken as the song cover', JSON.stringify(al));
      const h = await api('GET', `/api/vod/${other}/history`);
      const kinds = (h.j.events ?? []).map((e: any) => e.kind);
      ok(h.s === 200 && kinds.includes('created') && kinds.includes('song') && kinds.includes('image') && kinds.includes('edit')
        && /Cut from a recording of Volt FM/.test(h.j.events.find((e: any) => e.kind === 'created')?.title ?? '') && h.j.events.some((e: any) => e.kind === 'edit' && /song details/.test(e.title) && e.by),
        'History: made from a recording, song details, image, and who changed what', JSON.stringify(h.j.events?.map((e: any) => [e.kind, e.title, e.by])));
      ok((await api('GET', `/api/vod/${other}/history`, undefined, otok)).s === 404, 'not for another account');
      config.trackMeta.providers.splice(0, Infinity, 'musicbrainz');
      await query(`DELETE FROM music_lookups WHERE norm_key = ANY($1)`, [[normKey('Orange Crush', 'Infinite Lights'), normKey('Some Band', 'Logo Song')]]);
      await query(`DELETE FROM song_details WHERE account_id = $1`, [acct]);
    }

    console.log('== rate gate ==');
    {
      const { takeTurn } = await import('../src/services/rateGate');
      const t0 = Date.now();
      await Promise.all([1, 2, 3, 4].map(() => takeTurn(`test-${tag}`, 150)));
      const took = Date.now() - t0;
      ok(took >= 420 && took < 1500, 'four turns at 150 ms take about 450 ms, whoever asks', String(took));
    }

    console.log('== colour key ==');
    {
      const l = await api('GET', `/api/vod?limit=100`);
      const kinds = new Map((Array.isArray(l.j) ? l.j : []).map((x: any) => [x.id, x.media_kind]));
      eq([kinds.get(song), kinds.get(talk), kinds.get(clip)], ['music', 'audio', 'video'], 'each asset says music, audio or video');
    }

    console.log('== sweep ==');
    const fresh = await asset({ channel: tv, title: 'New clip' });
    const pendingUpload = await asset({ title: 'Still encoding' });
    await sweepUnpicked(500);
    const jobs = await query<any>(`SELECT payload->>'vodAssetId' AS id FROM jobs WHERE type = 'vod.image' AND payload->>'vodAssetId' = ANY($1::text[])`, [[fresh, pendingUpload]]);
    ok(jobs.some((j) => j.id === fresh) && !jobs.some((j) => j.id === pendingUpload), 'the sweep queues new assets, not uploads still encoding');
  } finally {
    srv.close(); mb.close(); await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
