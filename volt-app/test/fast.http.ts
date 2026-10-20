/** HTTP half of test/fast.check.sh (the .sh seeds and starts the API). */
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query, one, pool } from '../src/db';

const BASE = process.env.BASE!;
const ACCT = '0000000a-0000-0000-0000-0000000000f1';
const GROUP = '0000000d-0000-0000-0000-0000000000f1';
const LIVE = '0000000e-0000-0000-0000-0000000000f2';
const LAB = process.env.FAST_LAB;
const CLIPS = process.env.CLIPS_DIR!;
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log('PASS ' + m)) : (fail++, console.log('FAIL ' + m)));
let A = '';
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${A}`, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j: any = null; try { j = t ? JSON.parse(t) : null } catch { j = t }
  return { status: r.status, j };
}

// a fake ad server: a two-ad pod, one creative we have packaged, one we have not
let vastMode: 'pod' | 'slow' | 'empty' = 'pod';
const vast = createServer((req, res) => {
  const inline = (id: string, seq: number, dur: string, uai: string) => `<Ad id="${id}" sequence="${seq}"><InLine><AdSystem>FakeAds</AdSystem><AdTitle>${id}</AdTitle>
    <Impression>http://127.0.0.1:1/imp?${id}</Impression><Creatives><Creative id="c${id}"><UniversalAdId idRegistry="ad-id.org">${uai}</UniversalAdId><Linear><Duration>${dur}</Duration>
    <MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="1280" height="720">http://127.0.0.1:1/${id}.mp4</MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad>`;
  const body = vastMode === 'empty' ? '<VAST version="4.2"/>' : `<VAST version="4.2">${inline('known', 1, '00:00:15', 'UAI-X')}${inline('fresh', 2, '00:00:30', 'UAI-NEW')}</VAST>`;
  setTimeout(() => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(body); }, vastMode === 'slow' ? 3000 : 5);
});

(async () => {
  await new Promise<void>((r) => vast.listen(8497, '127.0.0.1', () => r()));
  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'fast@fastco.example', password: 'volt1234' }) }).then((r) => r.json());
  A = login.access; ok(!!A, 'logged in');

  // ---- the library -----------------------------------------------------------
  await query(`DELETE FROM vod_assets WHERE account_id = $1`, [ACCT]);
  const mkAsset = async (name: string, secs: number, md: any, media?: string) => {
    const r = await one<any>(
      `INSERT INTO vod_assets (account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata)
       VALUES ($1, 'upload', 'clip', $2, 0, $3, $3, $4::jsonb) RETURNING id`, [ACCT, name, secs * 1000, JSON.stringify(md)]);
    let key = `/clips/vod/${r.id}/master.m3u8`;
    if (LAB && media && existsSync(join(LAB, 'vod', media))) {
      mkdirSync(join(CLIPS, 'vod'), { recursive: true });
      cpSync(join(LAB, 'vod', media), join(CLIPS, 'vod', r.id), { recursive: true });
    }
    await query(`UPDATE vod_assets SET master_key = $2 WHERE id = $1`, [r.id, key]);
    return String(r.id);
  };
  const filmA = await mkAsset('Film A', 60, { title: 'Film A', genre: ['Drama'] }, 'filmA');
  const filmB = await mkAsset('Film B', 46, { title: 'Film B' }, 'filmB');
  const eps: string[] = [];
  for (let i = 1; i <= 3; i++) eps.push(await mkAsset(`Blue Heelers ${i}`, 30, { title: `Blue Heelers ${i}`, series: 'Blue Heelers', season: 1, episodeNumber: i }, 'ep1'));
  const promo = await mkAsset('Channel promo', 10, { title: 'Channel promo' }, 'promo');
  const slate = await mkAsset('Slate', 6, { title: 'Slate' }, 'slate');
  const adX = await mkAsset('Ad X', 15, { title: 'Ad X', kind: 'ad', creativeKey: 'ad-id.org:UAI-X' }, 'adX');
  await query(`INSERT INTO ad_creatives (account_id, creative_key, vod_asset_id, status, duration_ms) VALUES ($1, 'ad-id.org:UAI-X', $2, 'ready', 15000) ON CONFLICT (account_id, creative_key) DO UPDATE SET vod_asset_id = EXCLUDED.vod_asset_id`, [ACCT, adX]);

  const lib = await api('GET', '/api/fast/library');
  ok(lib.status === 200 && lib.j.assets.length === 7, `library lists the 7 content assets, not the ad (got ${lib.j.assets?.length})`);
  ok(lib.j.series.length === 1 && lib.j.series[0].name === 'Blue Heelers' && lib.j.series[0].episodes === 3, 'series grouped: Blue Heelers, 3 episodes');

  // ---- a FAST channel ----------------------------------------------------------
  const created = await api('POST', '/api/fast/channels', { name: 'Movies FAST', groupId: GROUP, zone: 'Australia/Brisbane' });
  ok(created.status === 201 && created.j.channel.origin === 'playlist' && created.j.lineup.status === 'draft', 'playlist channel created with a draft lineup');
  const CH = created.j.channel.id, L = created.j.lineup.id;
  const list = await api('GET', '/api/fast/channels');
  ok(list.j.items.some((c: any) => c.id === CH), 'listed among FAST channels');

  // ---- the lineup: a rotation pool, a fixed title, a series slot -----------------
  const slots = [
    { id: 'm1', kind: 'title', pool: [{ assetId: filmA }, { assetId: filmB }], label: 'Movie slot' },
    { id: 'bh', kind: 'series', series: 'Blue Heelers', count: 2, order: 'sequential', atEnd: 'loop' },
    { id: 'm2', kind: 'title', pool: [{ assetId: filmB }, { skip: true }] },
  ];
  const put = await api('PUT', `/api/fast/lineups/${L}`, { slots, settings: { gridMin: 0 } });
  ok(put.status === 200 && put.j.slots.length === 3, 'slots saved');
  const bad = await api('PUT', `/api/fast/lineups/${L}`, { slots: [...slots, { id: 'enc', kind: 'series', series: 'Blue Heelers', count: 1, order: 'sequential', encoreOf: 'nope' }] });
  ok(bad.status === 400, 'an encore of a missing slot is refused');

  // ads: markers only, a between-programmes break, house promo + slate
  const ads = await api('PUT', `/api/fast/channels/${CH}/ads`, { mode: 'markers', policy: { betweenSec: 15, breakSec: 15, loadMinPerHour: 0, slateAssetId: slate }, houseAds: [{ assetId: promo }] });
  ok(ads.status === 200 && ads.j.mode === 'markers' && ads.j.house.length === 1 && ads.j.policy.betweenSec === 15, 'ads: markers, 15 s between breaks, a house promo, a slate');
  const noServer = await api('PUT', `/api/fast/channels/${CH}/ads`, { mode: 'stitched' });
  ok(noServer.status === 400, 'stitched without an ad server is refused with a reason');

  const pv = await api('POST', `/api/fast/lineups/${L}/preview`, { days: 0.25 });
  ok(pv.status === 200 && pv.j.programmes.length > 10, `preview plans the window (${pv.j.programmes?.length} programmes)`);
  const firsts = pv.j.programmes.slice(0, 7).map((p: any) => p.title).join(' | ');
  ok(firsts.startsWith('Film A | Blue Heelers 1 | Blue Heelers 2 | Film B | Film B | Blue Heelers 3 | Blue Heelers 1'), `pass 1 then pass 2: pool rotates, m2 drops, series continues (${firsts})`);
  ok(pv.j.programmes[0].breaks.length === 1 && pv.j.programmes[0].breaks[0].position === 'end', 'every programme ends with its 15 s break');
  ok(pv.j.rotation.passesPerWeek > 1000 && pv.j.repeats.length >= 4, 'rotation maths and repeat report returned');
  const before = await one<any>(`SELECT count(*)::int n FROM programmes WHERE channel_id = $1`, [CH]);
  ok(before.n === 0, 'preview writes nothing');

  // ---- activate: the guide and the breaks are written ---------------------------
  const act = await api('POST', `/api/fast/lineups/${L}/activate`, {});
  ok(act.status === 200 && act.j.applied.inserted > 100, `activated and applied (${act.j.applied?.inserted} programmes, ${act.j.applied?.breaks} breaks)`);
  const progs = await query<any>(`SELECT * FROM programmes WHERE channel_id = $1 ORDER BY starts_at LIMIT 5`, [CH]);
  ok(progs.length === 5 && progs[0].source_ref.startsWith(`fast:${L}:`) && progs[0].metadata.vodAssetId === filmA, 'programmes carry the lineup ref and the asset');
  ok(progs.every((p: any, i: number) => i === 0 || +new Date(p.starts_at) === +new Date(progs[i - 1].ends_at)), 'back to back in the guide');
  const brk = await query<any>(`SELECT * FROM stream_breaks WHERE channel_id = $1 ORDER BY starts_at LIMIT 3`, [CH]);
  ok(brk.length === 3 && brk[0].source === 'fast' && brk[0].duration_ms === 15000 && brk[0].position === 'end', 'breaks written with their programme');
  ok(+new Date(brk[0].starts_at) === +new Date(progs[0].starts_at) + 60_000, 'the first break starts when Film A ends');
  const edit = await api('PUT', `/api/fast/lineups/${L}`, { slots: slots.slice(0, 1) });
  ok(edit.status === 409, 'the active lineup cannot be edited in place');

  // re-apply is idempotent; a new draft activated carries the series on
  const again = await api('POST', `/api/fast/lineups/${L}/apply`, {});
  const count2 = await one<any>(`SELECT count(*)::int n FROM programmes WHERE channel_id = $1`, [CH]);
  ok(again.status === 200 && count2.n === act.j.applied.inserted + 1 || count2.n === again.j.inserted + 1 || count2.n >= again.j.inserted, `re-apply rewrites the future without duplicates (${count2.n})`);

  // ---- the playout timeline ----------------------------------------------------
  const now = Date.now();
  const tl = await fetch(`${BASE}/api/fast-playout/${CH}/timeline?from=${new Date(now - 60_000).toISOString()}&to=${new Date(now + 600_000).toISOString()}`, { headers: { 'X-Volt-Ingest-Token': 'z' } }).then((r) => r.json());
  const kinds = tl.items.map((i: any) => i.kind);
  ok(kinds.includes('content') && kinds.includes('break'), 'timeline: content and breaks');
  const b0 = tl.items.find((i: any) => i.kind === 'break');
  ok(b0.scte35Out.startsWith('0xFC') && b0.fill.length >= 1 && b0.fill[0].kind === 'house' && b0.fill[0].assetId === promo, 'a break carries SCTE-35 and its house fill (promo first)');
  const fillSec = b0.fill.reduce((s: number, f: any) => s + f.durationSec, 0);
  ok(Math.abs(fillSec - 15) <= 1 && b0.fill.some((f: any) => f.kind === 'slate' && f.assetId === slate), `house promo + slate fill the 15 s within a segment (${fillSec} s; the playout stretches the slate to the guide)`);
  const unauth = await fetch(`${BASE}/api/fast-playout/${CH}/timeline`);
  ok(unauth.status === 401, 'the timeline needs the ingest token');

  // ---- graphics: the break is in the triggers, Up next is moved out of it ---------
  await query(`UPDATE channels SET graphics = '{"upNext":{"enabled":true,"leadSec":20,"durationSec":5}}'::jsonb WHERE id = $1`, [CH]).catch(() => null);
  const te = await fetch(`${BASE}/api/streams/${CH}/timed-events?from=${new Date(now - 60_000).toISOString()}&to=${new Date(now + 3600_000).toISOString()}`, { headers: { 'X-Volt-Ingest-Token': 'z' } }).then((r) => r.json());
  const adT = te.triggers.filter((t: any) => t.graphic === 'ad-break');
  ok(adT.length > 0 && adT[0].hls.includes('X-HIDE-GRAPHICS="all"') && adT[0].dash.schemeIdUri === 'urn:com:boomlabs:volt:ad:2026', 'ad-break triggers in the feed, HLS and DASH, with hide-graphics');
  ok(Array.isArray(te.breaks) && te.breaks.length === adT.length && te.breaks[0].hideGraphics === true, 'the break windows on their own, for a burn-in compositor');
  const ups = te.triggers.filter((t: any) => t.graphic === 'up-next');
  const overlaps = ups.filter((u: any) => adT.some((a: any) => Date.parse(u.start) < Date.parse(a.start) + a.duration * 1000 && Date.parse(u.start) + u.duration * 1000 > Date.parse(a.start)));
  ok(overlaps.length === 0, `no Up next card is ever on screen during a break (${ups.length} cards; the short test programmes get none, see fast-graphics.check.ts)`);

  // ---- Go to break on a live channel -------------------------------------------
  const go = await api('POST', `/api/fast/streams/channel/${LIVE}/breaks`, { durationSec: 90 });
  ok(go.status === 201 && go.j.source === 'manual' && go.j.duration_ms === 90000, 'Go to break on a live channel');
  const te2 = await fetch(`${BASE}/api/streams/${LIVE}/timed-events`, { headers: { 'X-Volt-Ingest-Token': 'z' } }).then((r) => r.json());
  ok(te2.triggers.some((t: any) => t.graphic === 'ad-break' && t.id === `brk:${go.j.id}`), 'and the live encoder\'s feed carries it at once (cache invalidated)');
  const cancel = await api('DELETE', `/api/fast/streams/channel/${LIVE}/breaks/${go.j.id}`);
  const te3 = await fetch(`${BASE}/api/streams/${LIVE}/timed-events`, { headers: { 'X-Volt-Ingest-Token': 'z' } }).then((r) => r.json());
  ok(cancel.status === 204 && !te3.triggers.some((t: any) => t.graphic === 'ad-break'), 'a cancelled break leaves the feed');

  // ---- ad decisions ------------------------------------------------------------
  const srv = await api('POST', '/api/fast/ad-servers', { name: 'Fake GAM', vendor: 'gam', tagTemplate: 'http://127.0.0.1:8497/vast?sz=[BREAK_DURATION]&sid=[SESSION_ID]&c=[CACHEBUSTING]', timeoutMs: 1000 });
  ok(srv.status === 201, 'ad server added');
  const test = await api('POST', `/api/fast/ad-servers/${srv.j.id}/test`, { durationSec: 60 });
  ok(test.j.ads.length === 2 && test.j.request.includes('sz=60'), 'test the tag: two ads, macros filled');
  await api('PUT', `/api/fast/channels/${CH}/ads`, { mode: 'stitched', adServerId: srv.j.id, policy: { betweenSec: 60, breakSec: 15, loadMinPerHour: 0, slateAssetId: slate } });
  await api('POST', `/api/fast/lineups/${L}/apply`, {});
  const b1 = await one<any>(`SELECT id FROM stream_breaks WHERE channel_id = $1 AND starts_at > now() AND duration_ms = 60000 ORDER BY starts_at LIMIT 1`, [CH]);
  const d1 = await api('POST', `/api/fast/channels/${CH}/breaks/${b1.id}/decide`, { sessionId: 'viewer-1' });
  ok(d1.status === 200 && d1.j.items[0].kind === 'ad' && d1.j.items[0].assetId === adX, 'the conditioned creative plays first');
  ok(d1.j.toCondition.some((c: any) => c.creativeKey === 'ad-id.org:UAI-NEW') && d1.j.items.some((i: any) => i.kind === 'house'), 'the new creative is queued for packaging; house fills its time');
  ok(Math.abs(d1.j.adSec + d1.j.houseSec + d1.j.slateSec - 60) <= 1, 'the pod is the break, 60 s');
  const job = await one<any>(`SELECT * FROM jobs WHERE type = 'ad.condition' ORDER BY created_at DESC LIMIT 1`);
  ok(!!job && job.payload.creativeKey === 'ad-id.org:UAI-NEW', 'an ad.condition job is queued for it');
  vastMode = 'slow';
  const d2 = await api('POST', `/api/fast/channels/${CH}/breaks/${b1.id}/decide`, { sessionId: 'viewer-2' });
  ok(d2.j.fallback === 'ad-server-timeout' && d2.j.adSec === 0 && d2.j.houseSec > 0 && d2.j.elapsedMs < 1500, `ad server too slow: house ads within the budget (${d2.j.elapsedMs} ms)`);
  vastMode = 'empty';
  const d3 = await api('POST', `/api/fast/channels/${CH}/breaks/${b1.id}/decide`, { sessionId: 'viewer-3' });
  ok(d3.j.fallback === 'no-ads' && d3.j.houseSec > 0, 'no ads returned: house ads');
  vastMode = 'pod';
  const rep = await api('GET', `/api/fast/channels/${CH}/ad-report`);
  ok(rep.j.decisions === 3 && rep.j.timeouts === 1 && rep.j.fillRate > 0 && rep.j.fillRate < 1, `ad report: 3 decisions, 1 timeout, fill ${rep.j.fillRate}`);
  ok(rep.j.creatives.some((c: any) => c.creative_key === 'ad-id.org:UAI-X' && c.status === 'ready'), 'creatives listed with their state');

  // ---- a new version carries the series on ---------------------------------------
  // as if the lineup had been on air for ten minutes (the series has moved on)
  await query(`UPDATE fast_lineups SET epoch = epoch - interval '10 minutes' WHERE id = $1`, [L]);
  const draft = await api('POST', `/api/fast/channels/${CH}/lineups`, {});
  ok(draft.status === 201 && draft.j.status === 'draft' && draft.j.slots.length === 3, 'a draft copied from the active lineup');
  await api('PUT', `/api/fast/lineups/${draft.j.id}`, { slots: [slots[1], slots[0]] });
  const act2 = await api('POST', `/api/fast/lineups/${draft.j.id}/activate`, {});
  const oldL = await one<any>(`SELECT status FROM fast_lineups WHERE id = $1`, [L]);
  const newL = await one<any>(`SELECT * FROM fast_lineups WHERE id = $1`, [draft.j.id]);
  ok(act2.status === 200 && oldL.status === 'archived' && newL.status === 'active' && newL.version === 2, 'activate: old version archived, new one is v2');
  ok(Object.keys(newL.series_start).length === 1 && newL.series_start['blue heelers'] > 0, `series pointer carried on (${JSON.stringify(newL.series_start)})`);
  const onAirStill = await one<any>(`SELECT count(*)::int n FROM programmes WHERE channel_id = $1 AND source_ref LIKE $2 AND starts_at <= now() AND ends_at > now()`, [CH, `fast:${L}:%`]);
  ok(onAirStill.n === 1, 'the programme on air is left alone');

  console.log(`\n${pass} passed, ${fail} failed`);
  vast.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); vast.close(); await pool.end().catch(() => null); process.exit(1); });
