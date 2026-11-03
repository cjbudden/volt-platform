// ============================================================================
//  SONGS IN THE MANIFEST, READ AT THE PLAYHEAD (build queue 1.7b).
//
//  Christian, 3 Nov 2026: DVR must show what was playing where the listener
//  is, not what is playing now. The whole path, each part with real code:
//
//    the content log            programmes rows the ICY reader writes
//    the timed-events endpoint  hands every song to the station container as
//                               a trigger (services/radio/songTriggers.ts)
//    the container's placement  volt-encoder/bin/timed_events.py, run here in
//                               python on a station playlist and MPD, puts each
//                               song in at its time and keeps only those inside
//                               the playlist's own window (the DVR window)
//    the player                 volt-player sdk/triggers.ts reads the tags as
//                               Shaka hands them over, sdk/songs.ts says what
//                               is playing at the playhead
//
//  Checked: a song change lands at its time; scrubbing back 60 minutes shows
//  that moment's song, the ones before it, and the next one counting down from
//  there; at the live edge "next" is the guide's next programme; nothing
//  already written changes when the next song starts or a cover is found (only
//  attributes are added); HLS and DASH both; the SDK makes no now-playing API
//  call.
//
//  Usage: DATABASE_URL=... npx tsx test/radio-songs.check.ts
// ============================================================================
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

let pass = 0, fail = 0;
const ok = (m: string, c: boolean, extra?: unknown) => {
  if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`)); }
};

const A = '00000000-0000-0000-0000-0000000c3a01';
const G = '00000000-0000-0000-0000-0000000c3b01';
const S = '00000000-0000-0000-0000-0000000c3d01';
const ENC = join(__dirname, '..', '..', 'volt-encoder', 'bin');

/** Every attribute of a DATERANGE line, name -> raw value. */
function attrs(line: string): Map<string, string> {
  const m = new Map<string, string>();
  const body = line.slice(line.indexOf(':') + 1);
  for (const x of body.matchAll(/([A-Z0-9-]+)=("(?:[^"]*)"|[^,]*)/g)) m.set(x[1], x[2]);
  return m;
}
/** Every attribute of `a` is in `b` with the same value (b may add some). */
const onlyAdded = (a: string, b: string) => { const x = attrs(a), y = attrs(b); for (const [k, v] of x) if (y.get(k) !== v) return false; return true; };

async function main() {
  const { songTriggers, CLASS_SONG } = await import('../src/services/radio/songTriggers');
  const { hlsTag, dashEvent, wireFormat, SCHEME_SONG } = await import('../src/services/graphicTriggers');
  const { fromHlsRegions, fromDashRegion, mergeGraphics } = await import('../../volt-player/src/sdk/triggers');
  const { songsAt } = await import('../../volt-player/src/sdk/songs');

  console.log('== the triggers (pure) ==');
  const t0 = Date.UTC(2026, 10, 3, 9, 0, 0);
  const row = (id: string, min: number, title: string, cls = 'song', image: string | null = null) =>
    ({ id, title, startsAt: new Date(t0 + min * 60_000), cls, image, provider: null, link: null });
  const log1 = [row('a', 0, 'Aurora Skies - Neon Rain'), row('b', 4, 'Advert: Crunchy Cola', 'ad'), row('c', 5, 'The Midnight Owls - Paper Boats')];
  const tr1 = songTriggers(log1, 'Sim FM');
  ok('only songs become triggers (the advert does not)', tr1.length === 2 && tr1.every((t) => t.cls === CLASS_SONG && t.graphic === 'song'));
  ok('a song ends where the next logged entry starts (the advert)', tr1[0].durationSec === 240);
  ok('the song on air is open (no duration)', tr1[1].durationSec === null);
  const line1 = hlsTag(tr1[1]);
  ok('the HLS line: song class, the change time, title and artist split', /CLASS="com\.boomlabs\.volt\.song"/.test(line1) && line1.includes(`START-DATE="${new Date(t0 + 5 * 60_000).toISOString()}"`)
    && /X-TITLE="Paper Boats"/.test(line1) && /X-ARTIST="The Midnight Owls"/.test(line1) && !/DURATION=/.test(line1), line1);
  // The next song starts, and later its cover is found: attributes are ADDED.
  const log2 = [...log1, row('d', 9, 'Coastline - Glass Harbour')];
  const tr2 = songTriggers(log2, 'Sim FM');
  const line2 = hlsTag(tr2[1]);
  ok('when the next song starts, DURATION is added', /DURATION=240\.000/.test(line2));
  ok('and every attribute already written is unchanged', onlyAdded(line1, line2), { line1, line2 });
  const tr3 = songTriggers(log2, 'Sim FM', (r) => (r.id === 'c' ? { artwork: 'https://img.example/img/sig/600x600,inside/library/x.jpg', album: 'Night Kites' } : {}));
  const line3 = hlsTag(tr3[1]);
  ok('the cover and album, once found, are added', /X-ARTWORK="https:\/\/img\.example/.test(line3) && /X-ALBUM="Night Kites"/.test(line3));
  ok('and still nothing already written changes', onlyAdded(line2, line3));
  const de = dashEvent(tr3[1]);
  ok('DASH: the song scheme, the title in the payload', de.schemeIdUri === SCHEME_SONG && JSON.parse(de.messageData).title === 'Paper Boats' && JSON.parse(de.messageData).artwork?.startsWith('https://'));

  console.log('\n== the endpoint the station container polls ==');
  const { query, pool } = await import('../src/db');
  const { config } = await import('../src/config');
  const { createServer } = await import('../src/server');
  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'SongCo')`, [A]);
  await query(`INSERT INTO groups(id,account_id,name) VALUES ($1,$2,'g')`, [G, A]);
  await query(`INSERT INTO channels(id,group_id,name,status,kind) VALUES ($1,$2,'Song FM','live','radio')`, [S, G]);
  // Ninety minutes of songs, four minutes each, an advert every fifth slot.
  const now = Date.now();
  const startMin = Math.floor((now - 90 * 60_000) / 60_000) * 60_000;
  const logged: { title: string; at: number; cls: string }[] = [];
  for (let i = 0; i * 4 < 90; i++) {
    const at = startMin + i * 4 * 60_000;
    const cls = i % 5 === 4 ? 'ad' : 'song';
    const title = cls === 'ad' ? `Advert ${i}` : `Artist ${i} - Song ${i}`;
    logged.push({ title, at, cls });
    await query(`INSERT INTO programmes(channel_id, source_ref, title, starts_at, ends_at, status, metadata)
      VALUES ($1,$2,$3,to_timestamp($4/1000.0),to_timestamp($4/1000.0)+interval '1 second','aired',$5::jsonb)`,
      [S, `icy:${at}`, title, at, JSON.stringify({ source: 'icy', class: cls })]);
  }
  const app: any = createServer();
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const r = await fetch(`${base}/api/streams/${S}/timed-events?kind=channel`, { headers: { 'X-Volt-Ingest-Token': config.ingestToken } });
  const body: any = await r.json();
  const songs = (body.triggers ?? []).filter((t: any) => t.graphic === 'song');
  const nSongs = logged.filter((l) => l.cls === 'song').length;
  ok(`every song of the last ninety minutes is handed over (${songs.length} of ${nSongs})`, r.status === 200 && songs.length === nSongs, songs.length);
  ok('each with its HLS line and DASH event', songs.every((t: any) => /CLASS="com\.boomlabs\.volt\.song"/.test(t.hls) && t.dash?.schemeIdUri === SCHEME_SONG));
  ok('the programme and graphic triggers are still there beside them', Array.isArray(body.triggers) && body.now_playing !== undefined);
  srv.close();

  console.log('\n== placed by the container (timed_events.py) ==');
  // A station playlist covering the last two hours in 4 s segments, as
  // radio.py writes it (PROGRAM-DATE-TIME on the first segment).
  const plStart = now - 120 * 60_000;
  const segs = Math.floor((120 * 60_000) / 4000);
  const pl = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MAP:URI="init.mp4"',
    `#EXT-X-PROGRAM-DATE-TIME:${new Date(plStart).toISOString()}`];
  for (let i = 0; i < segs; i++) pl.push('#EXTINF:4.000000,', `seg_${String(i).padStart(5, '0')}.m4s`);
  const placeHls = (text: string, trig: any[]) => {
    const p = spawnSync('python3', ['-c', 'import sys,json;sys.path.insert(0,sys.argv[1]);import timed_events as t\nfeed=t.TriggerFeed("x",fetch=lambda: json.loads(sys.argv[3]));feed.poll_once()\nprint(t.inject_hls(sys.argv[2],feed.current()))', ENC, text, JSON.stringify({ triggers: trig })], { encoding: 'utf8', maxBuffer: 1 << 26 });
    return p.status === 0 ? p.stdout : `ERR ${p.stderr}`;
  };
  const placed = placeHls(pl.join('\n'), body.triggers);
  const ranges = placed.split('\n').filter((l) => l.startsWith('#EXT-X-DATERANGE:') && /volt\.song/.test(l));
  ok(`the playlist carries every song (${ranges.length})`, ranges.length === nSongs, placed.slice(0, 300));
  const first = logged.find((l) => l.cls === 'song')!;
  ok('a song change lands at its time', ranges.some((l) => l.includes(`START-DATE="${new Date(first.at).toISOString()}"`)));
  // The DVR window: a playlist that only holds the last 30 minutes keeps only
  // the songs that overlap it.
  const shortStart = now - 30 * 60_000;
  const short = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:900', '#EXT-X-MAP:URI="init.mp4"', `#EXT-X-PROGRAM-DATE-TIME:${new Date(shortStart).toISOString()}`];
  for (let i = 0; i < 450; i++) short.push('#EXTINF:4.000000,', `seg_${String(900 + i).padStart(5, '0')}.m4s`);
  const placedShort = placeHls(short.join('\n'), body.triggers).split('\n').filter((l) => l.startsWith('#EXT-X-DATERANGE:') && /volt\.song/.test(l));
  const inWindow = songs.filter((t: any) => Date.parse(t.start) + (t.duration ?? 1e9) * 1000 > shortStart).length;
  ok(`trimmed to the DVR window: ${placedShort.length} songs for a 30 minute playlist (expected ${inWindow})`, placedShort.length === inWindow && inWindow < nSongs);
  // DASH: an EventStream in the Period.
  const ast = new Date(now - 120 * 60_000).toISOString();
  const mpd = `<?xml version="1.0"?><MPD type="dynamic" availabilityStartTime="${ast}" timeShiftBufferDepth="PT7200S"><Period id="0" start="PT0S"><AdaptationSet/></Period></MPD>`;
  const pd = spawnSync('python3', ['-c', 'import sys,json;sys.path.insert(0,sys.argv[1]);import timed_events as t\nfeed=t.TriggerFeed("x",fetch=lambda: json.loads(sys.argv[3]));feed.poll_once()\nprint(t.inject_mpd(sys.argv[2],feed.current()))', ENC, mpd, JSON.stringify({ triggers: body.triggers })], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const songStream = /<EventStream schemeIdUri="urn:com:boomlabs:volt:song:2026"[^>]*>(.*?)<\/EventStream>/s.exec(pd.stdout ?? '');
  const events = songStream ? (songStream[1].match(/<Event /g) ?? []).length : 0;
  ok(`DASH: a song EventStream with every song (${events})`, events === nSongs, (pd.stderr || '').slice(0, 200));

  console.log('\n== the player, at its playhead ==');
  // As Shaka hands DATERANGEs over: one region per attribute, media times on
  // the playlist's clock (media time 0 = the playlist's first PDT).
  const toMedia = (iso: string) => (Date.parse(iso) - plStart) / 1000;
  const regions: any[] = [];
  for (const l of ranges) {
    const a = attrs(l);
    const start = toMedia(a.get('START-DATE')!.replace(/"/g, ''));
    const end = a.has('DURATION') ? start + Number(a.get('DURATION')) : Infinity;
    for (const [k, v] of a) if (k.startsWith('X-')) regions.push({ startTime: start, endTime: end, metadataType: 'com.boomlabs.volt.song', payload: { key: k, data: v.replace(/^"|"$/g, '') } });
  }
  const store = new Map();
  mergeGraphics(store, fromHlsRegions(regions));
  const liveT = (now - plStart) / 1000;
  const back = liveT - 3600;
  const at = songsAt(store.values(), back, plStart, null);
  const playingThen = [...logged].reverse().find((l) => l.at <= now - 3600_000)!;
  const want = playingThen.cls === 'song' ? playingThen.title.split(' - ')[1] : null;
  ok(`scrubbed back 60 minutes: now playing is that moment's song (${at.nowPlaying?.title ?? 'none'})`, (at.nowPlaying?.title ?? null) === want, { want, got: at.nowPlaying });
  const nextThen = logged.find((l) => l.at > now - 3600_000 && l.cls === 'song')!;
  ok(`up next is the song that followed (${at.next?.title})`, at.next?.title === nextThen.title.split(' - ')[1] && at.next?.startedAt === nextThen.at);
  const countdown = ((at.next?.startedAt ?? 0) - (plStart + back * 1000)) / 1000;
  ok(`counting down from there (${countdown.toFixed(0)} s to go)`, countdown > 0 && countdown <= 240);
  ok('history: the songs before it, newest first', at.history.length > 0 && at.history.every((h, i, a) => i === 0 || (a[i - 1].startedAt ?? 0) > (h.startedAt ?? 0)) && (at.history[0].startedAt ?? 0) < (at.nowPlaying?.startedAt ?? now));
  const edge = songsAt(store.values(), liveT - 1, plStart, { title: 'The Late Show', startsAt: now + 600_000 });
  const lastSong = [...logged].reverse().find((l) => l.cls === 'song')!;
  ok('at the live edge, now playing is the song on air', edge.nowPlaying?.title === (logged[logged.length - 1].cls === 'song' ? lastSong.title.split(' - ')[1] : edge.nowPlaying?.title));
  ok('and next is the guide\'s next programme (the next song is not known yet)', edge.next?.title === 'The Late Show' && edge.next?.startedAt === now + 600_000);
  // DASH regions: one per event, payload in messageData.
  const dg = fromDashRegion({ schemeIdUri: SCHEME_SONG, value: 'song', startTime: 10, endTime: 250, id: 'song:x',
    eventNode: { attributes: { messageData: dashEvent(tr3[1]).messageData } } });
  ok('DASH events become songs the same way, cover and all', !!dg && dg.graphic === 'song' && songsAt([dg!], 20, null).nowPlaying?.artist === 'The Midnight Owls' && !!songsAt([dg!], 20, null).nowPlaying?.artworkUrl, dg);

  console.log('\n== no now-playing API calls ==');
  const src = readFileSync(join(__dirname, '..', '..', 'volt-player', 'src', 'sdk', 'player.ts'), 'utf8');
  ok('the SDK player does not call the now-playing API', !/fetchNowPlaying|\/api\/player\/now-playing/.test(src));
  ok('and reads songs at the playhead instead', /songsAt\(/.test(src));

  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await pool.end();
  console.log(`\nradio-songs: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
