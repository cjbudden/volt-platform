// ============================================================================
//  TIMELINE GRID: GET /api/timeline/grid (TIMELINE_MODE.md, phase 1).
//
//  The Live Streams page's Timeline view draws every visible stream from this
//  one call, so the call has to be right about the things a picture cannot
//  show you are wrong about:
//
//    * the WINDOW is capped (48 hours), and a wider ask is a clear 400;
//    * PERMISSIONS remove rows: a role without radio rights gets no radio
//      rows at all, not empty ones, exactly as /api/monitoring/live filters;
//    * rows PAGE with the list standard's cursor, and pages do not overlap;
//    * AS-RUN times win over scheduled ones for a programme that has aired;
//    * GAPS come from what is on disk (the coverage resolver), never from a
//      recording row's declared window: a row can claim an hour a crash never
//      wrote;
//    * EVENTS are placed from their own window, actual times when known, and
//      an event nowhere near the window is not a row.
//
//  The first block needs nothing running (pure shaping). The rest needs a
//  database and the API:
//
//  Usage: DATABASE_URL=... API=http://localhost:8080 npx tsx test/timeline-grid.check.ts
//         (or: node scripts/check.js timeline-grid, which starts both for you)
// ============================================================================
import jwt from 'jsonwebtoken';
import { __testing } from '../src/modules/timelineGrid';

const API = process.env.API || 'http://localhost:8080';
const SECRET = process.env.JWT_ACCESS_SECRET || 'devsecret';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const throwsWith = (m: string, fn: () => unknown, re: RegExp) => {
  try { fn(); bad(m, 'did not throw'); }
  catch (e: any) { re.test(String(e?.message)) ? ok(m) : bad(m, `threw [${e?.message}]`); }
};

const H = 3_600_000;

// ---------------------------------------------------------------- pure
function pure() {
  console.log('\n== pure: window, kinds, shaping ==');
  const now = Date.parse('2026-10-20T12:00:00Z');
  const w = __testing.parseWindow({}, now);
  check('default window starts two hours back', w.from, now - 2 * H);
  check('and runs six hours', w.to - w.from, 6 * H);
  const w48 = __testing.parseWindow({ from: '2026-10-20T00:00:00Z', to: '2026-10-22T00:00:00Z' }, now);
  check('exactly 48 hours is allowed', w48.to - w48.from, 48 * H);
  throwsWith('49 hours is refused with the cap in the message',
    () => __testing.parseWindow({ from: '2026-10-20T00:00:00Z', to: '2026-10-22T01:00:00Z' }, now), /up to 48 hours/);
  throwsWith('to before from is refused', () => __testing.parseWindow({ from: '2026-10-20T10:00:00Z', to: '2026-10-20T09:00:00Z' }, now), /after/);
  throwsWith('a date that is not a date is refused', () => __testing.parseWindow({ from: 'yesterday' }, now), /ISO 8601/);
  check('epoch ms is accepted too', __testing.parseWindow({ from: String(now), to: String(now + H) }, now).from, now);

  check('kinds narrowed to what the role may view',
    __testing.allowedKinds('channel,radio,event', (k) => k !== 'radio').join(','), 'channel,event');
  throwsWith('an unknown kind is a 400, not silently dropped', () => __testing.allowedKinds('tv', () => true), /Unknown kind/);

  const aired = __testing.programmeBlock({
    id: 'p', title: 'News', starts_at: '2026-10-20T10:00:00Z', ends_at: '2026-10-20T11:00:00Z',
    actual_start: '2026-10-20T10:02:00Z', actual_end: '2026-10-20T11:05:00Z', status: 'aired',
  }, 'convertible');
  check('as-run start preferred over scheduled', aired.start, '2026-10-20T10:02:00.000Z');
  check('as-run end preferred over scheduled', aired.end, '2026-10-20T11:05:00.000Z');
  check('and the block says it is as-run', aired.asRun, true);
  check('the scheduled time is still carried', aired.scheduledStart, '2026-10-20T10:00:00.000Z');
  const planned = __testing.programmeBlock({ id: 'q', title: 'Later', starts_at: '2026-10-20T14:00:00Z', ends_at: '2026-10-20T15:00:00Z' }, 'manual');
  check('a programme that has not aired uses its schedule', planned.start, '2026-10-20T14:00:00.000Z');
  check('and is not as-run', planned.asRun, false);

  const ev = __testing.eventBlock({
    id: 'e', name: 'Final', status: 'live',
    scheduled_start: '2026-10-20T11:00:00Z', scheduled_end: '2026-10-20T11:30:00Z',
    actual_start: '2026-10-20T11:04:00Z', actual_end: null,
  }, now);
  check('an event block starts at its actual start', ev.start, '2026-10-20T11:04:00.000Z');
  check('a live event past its planned end reaches now', ev.end, new Date(now).toISOString());

  // Media comes from the resolver's blocks and gaps, whatever a recording row says.
  const m = __testing.mediaFrom({
    blocks: [{ startMs: now - 2 * H, endMs: now - H }, { startMs: now - 30 * 60_000, endMs: now }],
    gaps: [{ fromMs: now - H, toMs: now - 30 * 60_000, ms: 30 * 60_000, reason: 'between-runs' }],
    coveragePct: 75,
  } as any);
  check('runs are the measured blocks', m.runs.length, 2);
  check('the gap is the resolver gap', m.gaps[0].start, new Date(now - H).toISOString());
  check('with its reason', m.gaps[0].reason, 'between-runs');
  check('no resolution means no lane, not "nothing recorded"', __testing.mediaFrom(null).gaps.length, 0);
}

// ---------------------------------------------------------------- integration
const A  = '00000000-0000-0000-0000-00007e1a0001';
const P  = '00000000-0000-0000-0000-00007e1a0002';
const G1 = '00000000-0000-0000-0000-00007e1a0003';   // "News"
const G2 = '00000000-0000-0000-0000-00007e1a0004';   // "Radio"
const TV1 = '00000000-0000-0000-0000-00007e1a0010';
const TV2 = '00000000-0000-0000-0000-00007e1a0011';
const TV3 = '00000000-0000-0000-0000-00007e1a0012';
const RD1 = '00000000-0000-0000-0000-00007e1a0013';
const EV1 = '00000000-0000-0000-0000-00007e1a0020';  // running now
const EV2 = '00000000-0000-0000-0000-00007e1a0021';  // next month: not a row
const PR1 = '00000000-0000-0000-0000-00007e1a0030';  // aired, as-run differs
const PR2 = '00000000-0000-0000-0000-00007e1a0031';  // scheduled
const REC = '00000000-0000-0000-0000-00007e1a0040';
const UG  = '00000000-0000-0000-0000-00007e1a0050';
const U   = '00000000-0000-0000-0000-00007e1a0051';

const owner = jwt.sign({ sub: 'u', account_id: A, role: 'owner', typ: 'access' }, SECRET, { expiresIn: 600 });
const tvOnly = jwt.sign({ sub: U, account_id: A, role: 'operator', typ: 'access' }, SECRET, { expiresIn: 600 });

async function grid(qs: string, token = owner) {
  const r = await fetch(`${API}/api/timeline/grid${qs}`, { headers: { authorization: 'Bearer ' + token } });
  const body = await r.json().catch(() => null);
  return { status: r.status, body: body as any };
}

async function integration() {
  const { pool, query } = await import('../src/db');
  const now = Date.now();
  const at = (ms: number) => new Date(ms).toISOString();
  try {
    await query(`DELETE FROM accounts WHERE id=$1`, [A]);
    await query(`DELETE FROM users WHERE email='timeline-grid@example.test'`);
    await query(`INSERT INTO accounts(id,name) VALUES ($1,'GridCo')`, [A]);
    await query(
      `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type)
       VALUES ($1,$2,'p','[{"height":720,"bitrate_kbps":2500}]','package_only')`, [P, A]);
    await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent)
                 VALUES ($1,$3,'News',$4,20,10), ($2,$3,'Radio',$4,20,10)`, [G1, G2, A, P]);
    await query(
      `INSERT INTO channels(id,group_id,name,status,kind) VALUES
         ($1,$5,'Alpha','scheduled','tv'), ($2,$5,'Bravo','scheduled','tv'),
         ($3,$5,'Charlie','scheduled','tv'), ($4,$6,'Delta FM','scheduled','radio')`,
      [TV1, TV2, TV3, RD1, G1, G2]);
    await query(
      `INSERT INTO events(id,group_id,name,status,scheduled_start,scheduled_end,actual_start) VALUES
         ($1,$3,'Cup final','live',$4,$5,$6),
         ($2,$3,'Next month','scheduled',$7,$8,NULL)`,
      [EV1, EV2, G1, at(now - H), at(now + H), at(now - 50 * 60_000), at(now + 30 * 24 * H), at(now + 30 * 24 * H + H)]);
    await query(
      `INSERT INTO programmes(id,channel_id,title,starts_at,ends_at,actual_start,actual_end,status) VALUES
         ($1,$3,'Morning news',$4,$5,$6,$7,'aired'),
         ($2,$3,'Afternoon',$8,$9,NULL,NULL,'scheduled')`,
      [PR1, PR2, TV1,
       at(now - 90 * 60_000), at(now - 30 * 60_000), at(now - 85 * 60_000), at(now - 28 * 60_000),
       at(now + 30 * 60_000), at(now + 90 * 60_000)]);
    // A recording row DECLARING the last two hours. Nothing is on disk for this
    // channel, so the grid must report the whole past as a gap.
    await query(
      `INSERT INTO recordings(id,kind,channel_id,status,start_epoch_ms,end_epoch_ms,duration_ms,master_key,day_utc)
       VALUES ($1,'channel_day',$2,'complete',$3,$4,$5,$6,(now() AT TIME ZONE 'UTC')::date)`,
      [REC, TV1, now - 2 * H, now - 10 * 60_000, 2 * H - 10 * 60_000, `channel/${TV1}`]);
    // A member whose only role grants TV channels, events and monitoring: no radio.
    await query(`INSERT INTO user_groups(id,account_id,name,permissions) VALUES ($1,$2,'TV desk',$3::jsonb)`,
      [UG, A, JSON.stringify({ monitoring: 'view', channels: 'view', events: 'view', epg: 'view', radio: 'none' })]);
    await query(
      `INSERT INTO users(id,account_id,email,password_hash,role,status,user_group_id)
       VALUES ($1,$2,'timeline-grid@example.test','x','operator','active',$3)`, [U, A, UG]);
    await query(`INSERT INTO user_group_members(user_id,group_id) VALUES ($1,$2)`, [U, UG]);

    const win = `from=${encodeURIComponent(at(now - 2 * H))}&to=${encodeURIComponent(at(now + 4 * H))}`;

    console.log('\n== window cap ==');
    const wide = await grid(`?from=${encodeURIComponent(at(now))}&to=${encodeURIComponent(at(now + 49 * H))}`);
    check('a 49 hour window is a 400', wide.status, 400);
    check('which says what the cap is', /48 hours/.test(String(wide.body?.error ?? '')), true);
    const ok48 = await grid(`?from=${encodeURIComponent(at(now - 24 * H))}&to=${encodeURIComponent(at(now + 24 * H))}`);
    check('48 hours is answered', ok48.status, 200);

    console.log('\n== rows, and the owner sees every kind ==');
    const all = await grid(`?${win}`);
    check('answers 200', all.status, 200);
    const ids = (b: any) => (b?.rows ?? []).map((r: any) => r.id);
    check('four channels and stations plus the running event', ids(all.body).length, 5);
    check('the event next month is not a row', ids(all.body).includes(EV2), false);
    check('the radio station is a row for the owner', ids(all.body).includes(RD1), true);
    check('window echoed with now', typeof all.body?.window?.now, 'string');
    const radioRow = all.body.rows.find((r: any) => r.id === RD1);
    check('a station is kind radio', radioRow?.kind, 'radio');
    check('rows carry the server status roll-up', typeof radioRow?.status?.state, 'string');
    check('rows carry hypermedia links', radioRow?.links?.self, `/api/radio/${RD1}`);
    check('grouped by channel group', radioRow?.groupName, 'Radio');

    console.log('\n== permission filtering ==');
    const tv = await grid(`?${win}`, tvOnly);
    check('the TV desk is answered', tv.status, 200);
    check('and gets no radio rows at all', tv.body.rows.filter((r: any) => r.kind === 'radio').length, 0);
    check('but does get the TV channels', tv.body.rows.filter((r: any) => r.kind === 'channel').length, 3);
    check('and the event', ids(tv.body).includes(EV1), true);
    const askRadio = await grid(`?${win}&kinds=radio`, tvOnly);
    check('asking for radio by name still yields nothing', askRadio.body?.rows?.length, 0);
    check('kinds echoes what was allowed', (askRadio.body?.kinds ?? []).length, 0);

    console.log('\n== cursor paging ==');
    const p1 = await grid(`?${win}&limit=2`);
    check('page one holds two rows', p1.body.rows.length, 2);
    check('and offers a next cursor', typeof p1.body.next, 'string');
    check('the next link carries it', String(p1.body.links?.next).includes('cursor='), true);
    const seen = new Set<string>(ids(p1.body));
    let cursor = p1.body.next, pages = 1, overlap = false;
    while (cursor && pages < 10) {
      const p = await grid(`?${win}&limit=2&cursor=${encodeURIComponent(cursor)}`);
      for (const id of ids(p.body)) { if (seen.has(id)) overlap = true; seen.add(id); }
      cursor = p.body.next; pages++;
    }
    check('paging reaches every row', seen.size, 5);
    check('in three pages', pages, 3);
    check('with no row on two pages', overlap, false);
    const big = await grid(`?${win}&limit=51`);
    check('more than 50 a page is refused', big.status, 400);
    const otherWin = await grid(`?from=${encodeURIComponent(at(now - H))}&to=${encodeURIComponent(at(now + H))}&limit=2&cursor=${encodeURIComponent(p1.body.next)}`);
    check('a cursor is bound to its window', otherWin.status, 400);
    const g = await grid(`?${win}&groupId=${G2}`);
    check('groupId narrows to one channel group', g.body.rows.map((r: any) => r.id).join(','), RD1);

    console.log('\n== as-run preferred over scheduled ==');
    const alpha = all.body.rows.find((r: any) => r.id === TV1);
    const morning = alpha?.programmes?.find((p: any) => p.id === PR1);
    check('the aired programme starts at its as-run time', morning?.start, at(now - 85 * 60_000));
    check('and ends at its as-run time', morning?.end, at(now - 28 * 60_000));
    check('and says so', morning?.asRun, true);
    const afternoon = alpha?.programmes?.find((p: any) => p.id === PR2);
    check('the scheduled one keeps its schedule', afternoon?.start, at(now + 30 * 60_000));
    check('and carries a VOD state', typeof afternoon?.vodState, 'string');

    console.log('\n== gaps come from coverage, not declared windows ==');
    check('no media runs for a channel with nothing on disk', alpha?.media?.runs?.length, 0);
    const gap = alpha?.media?.gaps?.[0];
    check('the past is one gap, despite the recording row', alpha?.media?.gaps?.length, 1);
    check('starting at the window start', gap?.start, at(now - 2 * H));
    check('and stopping at now: the future never touches disk', Date.parse(gap?.end) <= Date.now(), true);
    check('the recording row is offered for the workbench click', alpha?.recordings?.[0]?.id, REC);

    console.log('\n== events placed from their window ==');
    const ev = all.body.rows.find((r: any) => r.id === EV1);
    check('an event row is kind event', ev?.kind, 'event');
    check('with one block', ev?.programmes?.length, 1);
    check('starting at its actual start', ev?.programmes?.[0]?.start, at(now - 50 * 60_000));
    check('ending at its scheduled end', ev?.programmes?.[0]?.end, at(now + H));
    check('the block is the event, not a programme', ev?.programmes?.[0]?.source, 'event');
  } finally {
    await query(`DELETE FROM users WHERE id=$1`, [U]).catch(() => {});
    await query(`DELETE FROM accounts WHERE id=$1`, [A]).catch(() => {});
    await pool.end().catch(() => {});
  }
}

(async () => {
  pure();
  if (process.env.GRID_PURE_ONLY === '1') {
    console.log('\nintegration skipped (GRID_PURE_ONLY=1)');
  } else {
    await integration();
  }
  console.log(`\ntimeline-grid: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
