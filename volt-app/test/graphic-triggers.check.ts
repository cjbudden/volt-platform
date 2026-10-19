// ============================================================================
//  IN-STREAM GRAPHIC TRIGGERS (services/graphicTriggers.ts).
//
//  The rules that decide WHEN a player shows Up next, the grammar of the HLS line
//  and the DASH payload the encoder writes, the settings, the cache that keeps
//  schedule reads flat however many encoders ask, and the endpoint the encoder
//  polls. The placement into real manifests is volt-encoder/bin/test_timed_events.py.
//
//  Usage: DATABASE_URL=... npx tsx test/graphic-triggers.check.ts
// ============================================================================
import { pool, query } from '../src/db';
import {
  buildTriggers, triggersFor, hlsTag, dashEvent, resolveGraphics, DEFAULT_GRAPHICS, triggersForStream, wireFormat,
  CLASS_GRAPHIC, SCHEME_GRAPHIC, type ScheduleItem,
} from '../src/services/graphicTriggers';
import { CLASS_PROGRAMME } from '../src/services/timedMetadata';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

const T = (hhmm: string) => new Date(`2026-10-20T${hhmm}:00.000Z`);
const P = (id: string, a: string, b: string | null, title: string, extra: Partial<ScheduleItem> = {}): ScheduleItem =>
  ({ id, title, startsAt: T(a), endsAt: b ? T(b) : null, ...extra });

(async () => {
  console.log('== when Up next appears ==');
  const day = [
    P('a', '18:00', '18:30', 'Six O\'Clock News'),
    P('b', '18:30', '19:00', 'Evening Bulletin', { subtitle: 'Live from the harbour', imageUrl: 'https://img.example/eb.jpg' }),
    P('c', '19:00', '19:03', 'Promo break', { kind: 'ad' }),
    P('d', '19:03', '20:00', 'Documentary', { imageUrl: 'library/acct/doc.jpg' }),
    P('e', '21:00', '22:00', 'Late film'),             // an hour after d ends: not "next"
    P('f', '22:00', null, 'Overnight'),                // open-ended
  ];
  const all = buildTriggers(day, DEFAULT_GRAPHICS);
  const up = all.filter((t) => t.graphic === 'up-next');
  check('every programme keeps its boundary marker', all.filter((t) => t.graphic === 'programme' || t.graphic === 'ad').length, 6);
  check('up next is raised where something follows on: a, b, and e (Overnight follows the film); not d, an hour gap', up.map((t) => t.id).join(','), 'up-next:a,up-next:b,up-next:e');
  const ua = up.find((t) => t.id === 'up-next:a')!;
  check('two minutes before the end by default', ua.start.toISOString(), T('18:28').toISOString());
  check('for twelve seconds', ua.durationSec, 12);
  check('naming the next programme', ua.data.TITLE, 'Evening Bulletin');
  check('with its start', ua.data.STARTS, T('18:30').toISOString());
  check('its subtitle', ua.data.SUBTITLE, 'Live from the harbour');
  check('and an image a player can fetch', ua.data.IMAGE, 'https://img.example/eb.jpg');
  const ub = up.find((t) => t.id === 'up-next:b')!;
  check('an ad break is skipped: the next CONTENT is named', ub.data.TITLE, 'Documentary');
  check('a storage key is not offered as an image (a player cannot fetch it unsigned)', ub.data.IMAGE, undefined);
  check('no up next during the ad itself', up.some((t) => t.id === 'up-next:c'), false);

  const short = buildTriggers([P('s', '10:00', '10:02', 'Short'), P('t', '10:02', '11:00', 'Next')], DEFAULT_GRAPHICS);
  check('a programme too short for the card gets none', short.some((t) => t.graphic === 'up-next'), false);

  const custom = resolveGraphics({ upNext: { leadSec: 60, durationSec: 8 } });
  check('lead is configurable', buildTriggers(day, custom).find((t) => t.id === 'up-next:a')!.start.toISOString(), T('18:29').toISOString());
  check('switching it off leaves only the boundaries', buildTriggers(day, resolveGraphics({ upNext: { enabled: false } })).some((t) => t.graphic === 'up-next'), false);
  check('settings are clamped: a lead of 5 s becomes 15', resolveGraphics({ upNext: { leadSec: 5 } }).upNext.leadSec, 15);
  check('nonsense becomes the default', resolveGraphics({ upNext: { durationSec: 'x' } }).upNext.durationSec, 12);
  check('snake_case from a form is accepted', resolveGraphics({ up_next: { lead_sec: 300 } }).upNext.leadSec, 300);

  console.log('\n== which triggers a window carries ==');
  const w = triggersFor(all, T('18:27'), T('18:28'));
  check('a window just before up next includes it (look-ahead)', w.some((t) => t.id === 'up-next:a'), true);
  check('the programme on air is included', w.some((t) => t.id === 'a'), true);
  check('the open-ended overnight is not, at 18:27', w.some((t) => t.id === 'f'), false);
  check('at 23:00 the open-ended one is', triggersFor(all, T('23:00'), T('23:01')).some((t) => t.id === 'f'), true);

  console.log('\n== the HLS line ==');
  const line = hlsTag(ua);
  check('a DATERANGE', line.startsWith('#EXT-X-DATERANGE:'), true);
  check('with our reverse-DNS class', line.includes(`CLASS="${CLASS_GRAPHIC}"`), true);
  check('START-DATE quoted, ISO with ms', line.includes(`START-DATE="2026-10-20T18:28:00.000Z"`), true);
  check('DURATION as a decimal, unquoted', line.includes('DURATION=12.000'), true);
  check('data as X- attributes', line.includes('X-GRAPHIC="up-next"') && line.includes('X-TITLE="Evening Bulletin"'), true);
  check('the ID is repeated as X-ID, which a player keeps when it drops ID', line.includes('X-ID="up-next:a"'), true);
  const nasty = hlsTag({ ...ua, data: { TITLE: 'He said "go"\nnow' } });
  check('quotes and line breaks cannot break the tag', /X-TITLE="He said gonow"/.test(nasty) && !nasty.includes('\n'), true);
  check('the programme marker keeps the existing class', hlsTag(all.find((t) => t.id === 'a')!).includes(`CLASS="${CLASS_PROGRAMME}"`), true);

  console.log('\n== the DASH payload ==');
  const d = dashEvent(ua);
  check('graphics have their own versioned scheme', d.schemeIdUri, SCHEME_GRAPHIC);
  check('value names the graphic', d.value, 'up-next');
  check('duration in ms', d.durationMs, 12000);
  const md = JSON.parse(d.messageData);
  check('payload is JSON with lower-case keys', md.title, 'Evening Bulletin');
  check('and says what it is', md.graphic, 'up-next');
  check('wire format carries both renderings', !!wireFormat(ua).hls && !!wireFormat(ua).dash, true);

  console.log('\n== loader: cached, and invalidated by an EPG edit ==');
  const A = '00000000-0000-0000-0000-00000000f001', PR = '00000000-0000-0000-0000-00000000f002';
  const G = '00000000-0000-0000-0000-00000000f003', C = '00000000-0000-0000-0000-00000000f004';
  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'GfxCo')`, [A]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ($1,$2,'p','[{"height":720,"bitrate_kbps":2500}]','transcode')`, [PR, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent) VALUES ($1,$2,'g',$3,5,5)`, [G, A, PR]);
  await query(`INSERT INTO channels(id,group_id,name,status,kind) VALUES ($1,$2,'Harbour TV','live','tv')`, [C, G]);
  const now = Date.now(), H = 3600_000;
  const at = (ms: number) => new Date(now + ms).toISOString();
  await query(`INSERT INTO programmes(channel_id,title,starts_at,ends_at) VALUES ($1,'Now Show',$2,$3),($1,'Next Show',$3,$4)`,
    [C, at(-H), at(60_000), at(H)]);
  const { startListener } = await import('../src/scale/notify');
  (await import('../src/scale/cache')).wireCacheInvalidation();   // what startScale() does at boot
  await startListener().catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  const first = await triggersForStream('channel', C, new Date(now - 60_000), new Date(now + 30_000));
  check('the loader finds the up next due now', first.some((t) => t.graphic === 'up-next' && t.data.TITLE === 'Next Show'), true);
  // Prove the second read is served from cache: change the row WITHOUT the
  // trigger firing is impossible, so instead count queries.
  let reads = 0;
  const orig = (pool as any).query.bind(pool);
  (pool as any).query = (...a: any[]) => { if (String(a[0]).includes('FROM programmes')) reads++; return orig(...a); };
  for (let i = 0; i < 20; i++) await triggersForStream('channel', C, new Date(now - 60_000), new Date(now + 30_000));
  check('twenty encoder polls cost no schedule read', reads, 0);
  await query(`UPDATE programmes SET title = 'Renamed Show' WHERE channel_id = $1 AND title = 'Next Show'`, [C]);
  await new Promise((r) => setTimeout(r, 400));
  const after = await triggersForStream('channel', C, new Date(now - 60_000), new Date(now + 30_000));
  check('an EPG edit is visible on the next poll (cache invalidated by the row trigger)', after.some((t) => t.data.TITLE === 'Renamed Show'), true);
  check('which took exactly one read', reads, 1);
  await query(`UPDATE channels SET graphics = '{"upNext":{"enabled":false}}' WHERE id = $1`, [C]);
  await new Promise((r) => setTimeout(r, 400));
  const off = await triggersForStream('channel', C, new Date(now - 60_000), new Date(now + 30_000));
  check('switching Up next off on the channel takes effect too', off.some((t) => t.graphic === 'up-next'), false);
  (pool as any).query = orig;
  check('an unknown stream is no triggers, not an error', (await triggersForStream('channel', '00000000-0000-0000-0000-000000000bad', new Date(), new Date(now + 1000))).length, 0);

  console.log('\n== the endpoint the encoder polls ==');
  await query(`UPDATE channels SET graphics = '{}' WHERE id = $1`, [C]);
  await new Promise((r) => setTimeout(r, 300));
  const { createServer } = await import('../src/server');
  const { config } = await import('../src/config');
  const app: any = createServer();
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const noTok = await fetch(`${base}/api/streams/${C}/timed-events?kind=channel`);
  check('without the ingest token it is refused', noTok.status, 401);
  const r = await fetch(`${base}/api/streams/${C}/timed-events?kind=channel`, { headers: { 'X-Volt-Ingest-Token': config.ingestToken } });
  check('with it, 200', r.status, 200);
  const body: any = await r.json();
  check('it returns the triggers around now', body.triggers.some((t: any) => t.graphic === 'up-next'), true);
  check('each with its HLS line', body.triggers.every((t: any) => t.hls.startsWith('#EXT-X-DATERANGE:')), true);
  check('and its DASH event', body.triggers.every((t: any) => typeof t.dash.messageData === 'string'), true);
  const big = await fetch(`${base}/api/streams/${C}/timed-events?from=2026-01-01&to=2026-03-01`, { headers: { 'X-Volt-Ingest-Token': config.ingestToken } });
  check('a window over six hours is refused', big.status, 400);
  srv.close();

  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  console.log(`\n${pass} passed, ${fail} failed`);
  const { stopListener } = await import('../src/scale/notify');
  await stopListener().catch(() => {});
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
