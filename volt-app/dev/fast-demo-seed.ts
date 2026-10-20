/**
 * Demo FAST channels with realistic lengths, for looking at the builder:
 *
 *   Movies Plus     the cable movie model. Seven films make a 14-hour run order
 *                   that free-runs, so each film airs about twelve times a week
 *                   at twelve different times. One slot rotates three films
 *                   (one per pass), one rests every other pass.
 *   Classic Drama   the series model (the 7plus FAST style): a drama stripped
 *                   in order, four episodes at a time, with an encore later in
 *                   the pass; a procedural shuffled without repeats; a
 *                   daily restart at 06:00 and a 30-minute grid.
 *
 * Library rows only (no media), so the planner, guide and week view can be
 * seen without packaging anything; the titles show "not prepared yet".
 *
 *   BASE=http://localhost:8486 EMAIL=... PASSWORD=... npx tsx dev/fast-demo-seed.ts
 */
import { query, one, pool } from '../src/db';

const BASE = process.env.BASE ?? 'http://localhost:8486';
let A = '';
const api = async (m: string, p: string, b?: unknown) => {
  const r = await fetch(BASE + p, { method: m, headers: { authorization: `Bearer ${A}`, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
};

(async () => {
  A = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.EMAIL, password: process.env.PASSWORD }) })).json()).access;
  const me = await api('GET', '/api/auth/me');
  const acct = me.accountId ?? me.account_id ?? me.account?.id;
  const groups = await api('GET', '/api/groups');
  const group = (Array.isArray(groups) ? groups : groups.items)[0];
  const mk = async (title: string, min: number, md: any = {}) => {
    const r = await one<any>(`INSERT INTO vod_assets (account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata)
      VALUES ($1,'upload','clip',$2,0,$3,$3,$4::jsonb) RETURNING id`, [acct, title, Math.round(min * 60_000), JSON.stringify({ title, ...md })]);
    return String(r.id);
  };
  const films = [
    ['The Long Crossing', 118], ['Night Harbour', 104], ['Red Earth', 127], ['Glass City', 96], ['The Last Ferry', 112],
    ['Summer of the Comet', 109], ['Northbound', 121], ['The Quiet Hour', 99], ['Iron Coast', 131], ['Paper Lanterns', 93],
  ];
  const f: string[] = [];
  for (const [t, m] of films) f.push(await mk(String(t), Number(m), { genre: ['Drama'] }));
  for (let s = 1; s <= 3; s++) for (let e = 1; e <= 13; e++) await mk(`Country Station S${s} E${e}`, 46 + (e % 3), { series: 'Country Station', season: s, episodeNumber: e });
  for (let e = 1; e <= 26; e++) await mk(`Harbour Patrol ${e}`, 22, { series: 'Harbour Patrol', season: 1, episodeNumber: e });
  const promo = await mk('Channel promo', 0.5);
  const slate = await mk('Back soon slate', 0.1);

  // ---- Movies Plus: 14 h run order, free-running -----------------------------
  const m = await api('POST', '/api/fast/channels', { name: 'Movies Plus', groupId: group.id, zone: 'Australia/Brisbane' });
  await api('PUT', `/api/fast/lineups/${m.lineup.id}`, { slots: [
    { id: 'a', kind: 'title', pool: [{ assetId: f[0] }] },
    { id: 'b', kind: 'title', pool: [{ assetId: f[1] }, { assetId: f[7] }, { assetId: f[9] }], label: 'Rotating' },
    { id: 'c', kind: 'title', pool: [{ assetId: f[2] }] },
    { id: 'd', kind: 'title', pool: [{ assetId: f[3] }, { skip: true }] },
    { id: 'e', kind: 'title', pool: [{ assetId: f[4] }] },
    { id: 'f', kind: 'title', pool: [{ assetId: f[5] }] },
    { id: 'g', kind: 'title', pool: [{ assetId: f[6] }, { assetId: f[8] }] },
  ], settings: { gridMin: 5 } });
  await api('PUT', `/api/fast/channels/${m.channel.id}/ads`, { mode: 'markers', policy: { loadMinPerHour: 8, breakSec: 120, betweenSec: 60, slateAssetId: slate }, houseAds: [{ assetId: promo }] });

  // ---- Classic Drama: series, daily restart, half-hour grid -------------------
  const d = await api('POST', '/api/fast/channels', { name: 'Classic Drama', groupId: group.id, zone: 'Australia/Brisbane' });
  await api('PUT', `/api/fast/lineups/${d.lineup.id}`, { slots: [
    { id: 'cs', kind: 'series', series: 'Country Station', count: 4, order: 'sequential', atEnd: 'loop' },
    { id: 'hp', kind: 'series', series: 'Harbour Patrol', count: 6, order: 'shuffle', atEnd: 'loop' },
    { id: 'cs2', kind: 'series', series: 'Country Station', count: 4, order: 'sequential', atEnd: 'loop' },
    { id: 'enc', kind: 'series', series: 'Country Station', count: 1, order: 'sequential', encoreOf: 'cs2' },
    { id: 'hp2', kind: 'series', series: 'Harbour Patrol', count: 4, order: 'shuffle', atEnd: 'loop' },
  ], settings: { anchor: '06:00', gridMin: 30 } });
  await api('PUT', `/api/fast/channels/${d.channel.id}/ads`, { mode: 'markers', policy: { loadMinPerHour: 10, breakSec: 90, betweenSec: 30, slateAssetId: slate }, houseAds: [{ assetId: promo }] });
  console.log(JSON.stringify({ movies: m.channel.id, drama: d.channel.id }));
  await pool.end();
})().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
