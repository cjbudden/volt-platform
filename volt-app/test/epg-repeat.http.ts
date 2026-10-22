/** HTTP half of test/epg-repeat.check.sh (the .sh seeds and starts the API). */
import { query, one, pool } from '../src/db';
import { topUpSeries } from '../src/services/epgPlace';
import { addDays, localDateOf, localToUtc, weekdayOf } from '../src/services/epgRepeat';

const BASE = process.env.BASE!;
const CH = '0000000e-0000-0000-0000-0000000000bb';
const TZ = 'Australia/Sydney';
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log('PASS ' + m)) : (fail++, console.log('FAIL ' + m)));
let A = '';
async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${A}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j: any = null; try { j = t ? JSON.parse(t) : null } catch { j = t }
  return { status: r.status, j };
}
const at = (date: string, time: string) => localToUtc(date, time, TZ);
const count = async (where = '', p: unknown[] = []) => (await one<any>(`SELECT count(*)::int n FROM programmes WHERE channel_id='${CH}' ${where}`, p))!.n as number;
const titlesOn = async (date: string) => (await query<any>(
  `SELECT title FROM programmes WHERE channel_id=$1 AND starts_at >= $2 AND starts_at < $3 ORDER BY starts_at`, [CH, at(date, '00:00'), at(addDays(date, 1), '00:00')])).map((r) => r.title).join(',');

(async () => {
  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'rep@repeatco.example', password: 'volt1234' }) }).then((r) => r.json());
  A = login.access; ok(!!A, 'logged in');

  const today = localDateOf(new Date(), TZ);
  const D = addDays(today, 3);
  const mk = async (title: string, s: string, e: string, extra: any = {}) =>
    (await api('POST', '/api/epg', { channelId: CH, title, startsAt: s, endsAt: e, ...extra })).j;
  // The night before runs into D: belongs to D-1, must not be copied with D.
  await mk('Night Before', at(addDays(D, -1), '23:00'), at(D, '02:00'));
  const breakfast = await mk('Breakfast', at(D, '06:00'), at(D, '09:00'), { geoMode: 'allow', geoCountries: ['AU'] });
  await mk('Morning', at(D, '09:00'), at(D, '12:00'));
  const lunch = await mk('Lunch', at(D, '12:00'), at(D, '13:00'), { autoVod: true });
  await mk('Overnight', at(D, '23:00'), at(addDays(D, 1), '02:00'));

  // ---- Copy day: preview writes nothing -------------------------------------
  const before = await count();
  const pv = await api('POST', '/api/epg/copy-day', { channelId: CH, sourceDate: D, tz: TZ, dates: [addDays(D, 1), addDays(D, 2)], policy: 'replace', dryRun: true });
  ok(pv.status === 200 && pv.j.summary.added === 8, `preview: 4 programmes x 2 days = 8 (got ${JSON.stringify(pv.j.summary)})`);
  ok(!pv.j.outcomes.some((o: any) => o.title === 'Night Before'), 'the programme from the night before is not part of the day');
  ok((await count()) === before, 'preview wrote nothing');

  // Something already there on both targets.
  await mk('Special', at(addDays(D, 1), '12:30'), at(addDays(D, 1), '13:30'));
  await query(`INSERT INTO programmes(channel_id,title,starts_at,ends_at,source_ref) VALUES ($1,'Feed Item',$2,$3,'xmltv:test:1')`, [CH, at(addDays(D, 2), '09:30'), at(addDays(D, 2), '10:00')]);
  const pv2 = await api('POST', '/api/epg/copy-day', { channelId: CH, sourceDate: D, tz: TZ, dates: [addDays(D, 1), addDays(D, 2)], policy: 'replace', dryRun: true });
  const o = (t: string, d: string) => pv2.j.outcomes.find((x: any) => x.title === t && x.date === d);
  ok(o('Lunch', addDays(D, 1))?.result === 'replace' && o('Lunch', addDays(D, 1)).replaces[0].title === 'Special', 'preview: Lunch replaces Special');
  ok(o('Morning', addDays(D, 2))?.result === 'skip' && /feed/.test(o('Morning', addDays(D, 2)).reason), 'preview: feed programme protected, Morning skipped with reason');
  const pvSkip = await api('POST', '/api/epg/copy-day', { channelId: CH, sourceDate: D, tz: TZ, dates: [addDays(D, 1)], policy: 'skip', dryRun: true });
  ok(pvSkip.j.summary.added === 3 && pvSkip.j.summary.replaced === 0, 'only fill empty time: Lunch left out, nothing replaced');

  const cp = await api('POST', '/api/epg/copy-day', { channelId: CH, sourceDate: D, tz: TZ, dates: [addDays(D, 1), addDays(D, 2)], policy: 'replace' });
  ok(cp.status === 201 && !!cp.j.batchId, 'copy applied with an undo batch');
  ok((await titlesOn(addDays(D, 1))) === 'Breakfast,Morning,Lunch,Overnight', `copy target day 1 = ${await titlesOn(addDays(D, 1))}`);
  ok((await titlesOn(addDays(D, 2))) === 'Breakfast,Feed Item,Lunch,Overnight', `copy target day 2 keeps the feed item = ${await titlesOn(addDays(D, 2))}`);
  const copied = await one<any>(`SELECT * FROM programmes WHERE channel_id=$1 AND title='Breakfast' AND starts_at=$2`, [CH, at(addDays(D, 1), '06:00')]);
  ok(copied?.geo_mode === 'allow' && copied?.geo_countries?.[0] === 'AU', 'slot controls travel with the copy');
  const un = await api('POST', `/api/epg/batches/${cp.j.batchId}/undo`);
  ok(un.status === 200 && un.j.restored === 1, `undo: copies removed, Special restored (${JSON.stringify(un.j)})`);
  ok((await titlesOn(addDays(D, 1))) === 'Special', 'after undo the day is as it was');
  ok((await api('POST', `/api/epg/batches/${cp.j.batchId}/undo`)).status === 409, 'undo twice is refused');

  // ---- Day repeat: every <weekday of D+7> for 4 weeks -------------------------
  const W = addDays(D, 7);
  const wd = weekdayOf(W);
  const rpv = await api('POST', '/api/epg/copy-day', { channelId: CH, sourceDate: D, tz: TZ, repeat: { rule: { freq: 'weekly', byDay: [wd] }, until: addDays(W, 21) }, policy: 'replace', dryRun: true });
  ok(rpv.j.summary.added === 16 && rpv.j.summary.dates === 4, `day repeat preview: 4 weeks x 4 = 16 (${JSON.stringify(rpv.j.summary)})`);
  const rp = await api('POST', '/api/epg/copy-day', { channelId: CH, sourceDate: D, tz: TZ, repeat: { rule: { freq: 'weekly', byDay: [wd] }, until: addDays(W, 21) }, policy: 'replace' });
  ok(rp.status === 201 && !!rp.j.seriesId, 'day repeat created as a linked repeat');
  const daySeries = rp.j.seriesId;
  ok((await count(`AND series_id=$1`, [daySeries])) === 16, 'day repeat placed 16 occurrences');
  ok((await titlesOn(addDays(W, 14))) === 'Breakfast,Morning,Lunch,Overnight', 'a repeated day looks like the source day');

  // ---- Programme repeat over the top: Lunch every day for 10 days --------------
  const ppv = await api('POST', '/api/epg/repeat', { programmeId: lunch.id, rule: { freq: 'daily' }, until: addDays(D, 10), policy: 'replace', tz: TZ, dryRun: true });
  const meet = ppv.j.outcomes.find((x: any) => x.date === W);
  ok(meet?.result === 'replace' && meet.replaces[0].fromRepeat, 'programme repeat meets the day repeat: preview says it replaces a repeat occurrence');
  const pr = await api('POST', '/api/epg/repeat', { programmeId: lunch.id, rule: { freq: 'daily' }, until: addDays(D, 10), policy: 'replace', tz: TZ });
  ok(pr.status === 201 && pr.j.summary.added === 10, `programme repeat: 10 more days (${JSON.stringify(pr.j.summary)})`);
  const lunchSeries = pr.j.seriesId;
  const ds = await one<any>('SELECT exdates FROM programme_series WHERE id=$1', [daySeries]);
  ok(ds.exdates.includes(`${W}#d2`), 'the replaced day-repeat occurrence is remembered as removed');
  const ls = await one<any>('SELECT series_id, series_key FROM programmes WHERE id=$1', [lunch.id]);
  ok(ls.series_id === lunchSeries && ls.series_key === 'p0', 'the original programme is the first occurrence');
  ok((await api('POST', '/api/epg/repeat', { programmeId: lunch.id, rule: { freq: 'daily' }, policy: 'replace' })).status === 400, 'repeating a repeat again is refused with a message');

  // top-up is idempotent and respects exdates
  await query(`UPDATE programme_series SET materialized_until=NULL WHERE id IN ($1,$2)`, [daySeries, lunchSeries]);
  const nBefore = await count();
  await topUpSeries();
  ok((await count()) === nBefore, `top-up re-run adds nothing and does not refill a removed occurrence (${nBefore} -> ${await count()})`);

  // ---- Copying a day that holds repeat occurrences onto days the repeat covers --
  const cpr = await api('POST', '/api/epg/copy-day', { channelId: CH, sourceDate: addDays(D, 4), tz: TZ, dates: [addDays(D, 5)], policy: 'replace', dryRun: true });
  ok(cpr.j.outcomes.some((x: any) => x.title === 'Lunch' && x.result === 'skip' && /from its repeat/.test(x.reason)), 'copy skips a repeat occurrence its repeat already places there');

  // ---- Scoped edits -----------------------------------------------------------
  const occ = await query<any>(`SELECT * FROM programmes WHERE series_id=$1 ORDER BY starts_at`, [lunchSeries]);
  const one3 = occ[3];
  await api('PATCH', `/api/epg/${one3.id}`, { title: 'Lunch (special guest)' });
  ok((await one<any>('SELECT series_detached FROM programmes WHERE id=$1', [one3.id])).series_detached === true, 'edit this one: marked as individually edited');
  const e = await api('PATCH', `/api/epg/${occ[1].id}`, { title: 'Midday', startsAt: at(localDateOf(occ[1].starts_at, TZ), '12:15'), endsAt: at(localDateOf(occ[1].starts_at, TZ), '13:15'), scope: 'series' });
  ok(e.status === 200 && e.j.repeat?.keptEdited === 1, `edit all repeats: individually edited one kept (${JSON.stringify(e.j.repeat)})`);
  const after = await query<any>(`SELECT title, starts_at FROM programmes WHERE series_id=$1 AND starts_at > now() ORDER BY starts_at`, [lunchSeries]);
  ok(after.filter((r) => r.title === 'Midday').length === after.length - 1, 'all other future occurrences renamed');
  ok(after.filter((r) => r.title === 'Midday').every((r) => (Date.parse(r.starts_at) - Date.parse(at(localDateOf(r.starts_at, TZ), '12:15'))) === 0), 'and moved to 12:15 local on every date');
  ok(after.some((r) => r.title === 'Lunch (special guest)'), 'the individually edited occurrence is unchanged');

  const f = await api('PATCH', `/api/epg/${occ[6].id}`, { title: 'Late Lunch', scope: 'following' });
  const split = f.j.repeat?.seriesId; if (!split) console.log('DEBUG', f.status, JSON.stringify(f.j).slice(0, 400));
  ok(f.status === 200 && split && split !== lunchSeries, 'edit this and following: repeat split');
  ok((await count(`AND series_id=$1 AND title='Late Lunch'`, [split])) >= 4 && (await count(`AND series_id=$1 AND title='Late Lunch'`, [lunchSeries])) === 0, 'earlier occurrences keep the old title');
  const old = await one<any>('SELECT until_date FROM programme_series WHERE id=$1', [lunchSeries]);
  ok(old.until_date && localDateOf(occ[6].starts_at, TZ) > new Date(old.until_date).toISOString().slice(0, 10), 'the first part now ends the day before');

  // ---- Scoped deletes ---------------------------------------------------------
  const occ2 = await query<any>(`SELECT * FROM programmes WHERE series_id=$1 ORDER BY starts_at`, [split]);
  const r1 = await api('DELETE', `/api/epg/${occ2[0].id}`);
  ok(r1.status === 204, 'delete this one');
  const ex = await one<any>('SELECT exdates FROM programme_series WHERE id=$1', [split]);
  ok(ex.exdates.length === 1, 'deleted occurrence remembered');
  const r2 = await api('DELETE', `/api/epg/${occ2[1].id}?scope=series`);
  ok(r2.status === 200 && r2.j.seriesDeleted === true && (await count(`AND series_id=$1`, [split])) === 0, 'delete all repeats: occurrences gone, repeat gone');
  ok((await count(`AND series_id=$1`, [lunchSeries])) > 0, 'the earlier part of the split repeat is untouched');

  // day series: delete one programme from all repeats keeps the others
  const dayOcc = await one<any>(`SELECT * FROM programmes WHERE series_id=$1 AND series_key='d0' ORDER BY starts_at LIMIT 1`, [daySeries]);
  const r3 = await api('DELETE', `/api/epg/${dayOcc.id}?scope=series`);
  ok(r3.status === 200 && r3.j.seriesDeleted === false && (await count(`AND series_id=$1 AND series_key='d0'`, [daySeries])) === 0 && (await count(`AND series_id=$1`, [daySeries])) > 0, 'removing Breakfast from a day repeat keeps the rest of the day');
  const info = await api('GET', `/api/epg/series/${daySeries}`);
  ok(info.status === 200 && /Every/.test(info.j.description) && info.j.items === 3, `series info: ${info.j.description}, ${info.j.items} items`);

  // ---- Clear day is undoable --------------------------------------------------
  const cd = await api('POST', '/api/epg/clear-day', { channelId: CH, fromStart: at(W, '00:00'), fromEnd: at(addDays(W, 1), '00:00') });
  ok(cd.status === 200 && cd.j.deleted > 0 && !!cd.j.batchId, 'clear day returns an undo batch');
  const cu = await api('POST', `/api/epg/batches/${cd.j.batchId}/undo`);
  ok(cu.j.restored === cd.j.deleted, `clear day undone: ${cu.j.restored} restored`);
  const exAfter = await one<any>('SELECT exdates FROM programme_series WHERE id=$1', [daySeries]);
  ok(!exAfter.exdates.some((x: string) => x.startsWith(W) && !x.endsWith('#d2')), 'undo took back the exdates clear day wrote');

  // ---- End a repeat from a date -----------------------------------------------
  const endR = await api('POST', `/api/epg/series/${daySeries}/end`, { from: addDays(W, 14) });
  ok(endR.status === 200 && (await count(`AND series_id=$1 AND series_date >= $2`, [daySeries, addDays(W, 14)])) === 0, 'stop repeating from a date');

  // ---- Events repeat too ------------------------------------------------------
  const ev = await one<any>(`INSERT INTO events(group_id,name,scheduled_start,scheduled_end) VALUES ('0000000d-0000-0000-0000-0000000000e7','Repeat Event', now()+interval '2 day', now()+interval '2 day 4 hours') RETURNING id`);
  const ep = (await api('POST', '/api/epg', { eventId: ev.id, title: 'Keynote', startsAt: at(D, '10:00'), endsAt: at(D, '11:00') })).j;
  const er = await api('POST', '/api/epg/repeat', { programmeId: ep.id, rule: { freq: 'weekdays' }, until: addDays(D, 6), policy: 'replace', tz: TZ });
  ok(er.status === 201 && er.j.summary.added >= 3, `event programmes repeat (${er.j.summary?.added})`);

  // ---- Legacy offset copy still behaves as before -----------------------------
  const lg = await api('POST', '/api/epg/copy-day', { channelId: CH, fromStart: at(addDays(D, 30), '00:00'), fromEnd: at(addDays(D, 31), '00:00'), dayOffsets: [1] });
  ok(lg.status === 201, 'legacy dayOffsets form still answers');

  console.log(`\nepg-repeat: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
