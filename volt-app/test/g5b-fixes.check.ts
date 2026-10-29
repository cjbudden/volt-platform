// ============================================================================
//  THE REST OF THE G5 FIXES, FIRST PART (build queue 1.14-G5b: (b), (d), (k)).
//
//  Pinned over real HTTP:
//    (b) DELETE /api/vod/:id finds a watch folder asset (no channel, owned
//        through vod_assets.account_id) and moves it to the restore bin;
//        another account gets 404 and the asset stays
//    (d) the guide strip's data says what is nearest when its window (2 h
//        back to 8 h ahead) is empty but the guide is not: the channel page
//        no longer says "No programme guide yet" to a guide that starts
//        tomorrow; a stream with no programmes at all still has no neighbours
//    (k) a channel's Settings > Subtitles writes the shared output profile, so
//        a change is refused (409 locked_while_running, naming them) while
//        another channel or an event on that profile runs; re-sending the
//        stored value is not a change; once they stop it saves; a channel on
//        another profile is not held back by them
//    DATABASE_URL=... npx tsx test/g5b-fixes.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, max_channels) VALUES ($1, 50) RETURNING id`, [`g5b-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name, max_channels) VALUES ($1, 50) RETURNING id`, [`g5b-other-${tag}`]))!.id;
  const prof = async (name: string) =>
    (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,$2,'[]','transcode') RETURNING id`, [acct, name]))!.id;
  const grp = async (name: string, p: string) =>
    (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id, max_channels, max_concurrent) VALUES ($1,$2,$3,10,5) RETURNING id`, [acct, name, p]))!.id;
  const shared = await prof('Shared HD'), own = await prof('Own HD');
  const gA = await grp('News', shared), gB = await grp('Sport', shared), gC = await grp('Kids', own);
  const ch = async (g: string, name: string) => (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,$2) RETURNING id`, [g, name]))!.id;
  const news = await ch(gA, 'Volt News'), news2 = await ch(gA, 'Volt News 2'), kids = await ch(gC, 'Volt Kids');
  const ev = (await one<any>(`INSERT INTO events(group_id, name, scheduled_start, scheduled_end, status)
      VALUES ($1,'Cup Final', now(), now() + interval '2 hours', 'live') RETURNING id`, [gB]))!.id;
  const run = async (col: 'channel_id' | 'event_id', id: string) =>
    (await one<any>(`INSERT INTO instances(${col}, role, state, launched_at, task_kind) VALUES ($1,'primary','running',now(),'transcode') RETURNING id`, [id]))!.id;
  const stop = (inst: string) => query(`UPDATE instances SET terminated_at = now(), state = 'terminated' WHERE id = $1`, [inst]);

  const admin = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','admin','active') RETURNING id`,
    [acct, `g5b-${tag}@volt.test`]))!.id;
  const otherOwner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`,
    [other, `g5b-o-${tag}@volt.test`]))!.id;

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, who: 'admin' | 'other' = 'admin') => {
    const tok = who === 'admin' ? signAccess({ sub: admin, account_id: acct, role: 'admin' }) : signAccess({ sub: otherOwner, account_id: other, role: 'owner' });
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}) });
    const j = await res.json().catch(() => null) as any;
    return { s: res.status, j };
  };
  const msg = (r: { j: any }) => String(r.j?.error?.message ?? r.j?.error ?? r.j?.message ?? '');
  const capsOf = async (p: string) => (await one<any>(`SELECT captions_enabled, caption_offset_sec FROM output_profiles WHERE id = $1`, [p]))!;

  try {
    console.log('== (b) deleting a watch folder asset ==');
    const wf = (await one<any>(`INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status)
        VALUES ($1,'watchfolder','clip','Dropped in a folder',0,0,0,'ready') RETURNING id`, [acct]))!.id;
    const theirs = await call('DELETE', `/api/vod/${wf}`, undefined, 'other');
    check('another account cannot delete it (404)', theirs.s, 404);
    check('...and it is still there', !!(await one(`SELECT 1 FROM vod_assets WHERE id = $1`, [wf])), true);
    const del = await call('DELETE', `/api/vod/${wf}`);
    check('its own account deletes it (200)', del.s, 200);
    check('...it is gone from the library', !!(await one(`SELECT 1 FROM vod_assets WHERE id = $1`, [wf])), false);
    check('...and held in the restore bin', !!(await one(`SELECT 1 FROM trash_items WHERE kind = 'vod_asset' AND subject_id = $1 AND account_id = $2 AND state = 'held'`, [wf, acct])), true);
    check('...the answer names the bin item', typeof del.j?.bin, 'string');

    console.log('== (d) a guide outside the strip window ==');
    const empty = await call('GET', `/api/channels/${kids}`);
    check('a channel with no programmes has an empty lane', empty.j?.epg?.lane?.length, 0);
    check('...and nothing either side ("No programme guide yet" stays right)', [empty.j?.epg?.outside?.previous ?? null, empty.j?.epg?.outside?.upcoming ?? null], [null, null]);
    await query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at) VALUES ($1,'Morning Show', now() + interval '1 day', now() + interval '1 day 2 hours')`, [news]);
    await query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at) VALUES ($1,'Late Film', now() - interval '3 days', now() - interval '3 days' + interval '2 hours')`, [news]);
    const later = await call('GET', `/api/channels/${news}`);
    check('a guide that starts tomorrow: the lane is empty', later.j?.epg?.lane?.length, 0);
    check('...but the next programme is named', later.j?.epg?.outside?.upcoming?.name, 'Morning Show');
    check('...with its start about a day away', Math.round((later.j?.epg?.outside?.upcoming?.startMs - Date.now()) / 3600e3), 24);
    check('...and the last one before it', later.j?.epg?.outside?.previous?.name, 'Late Film');
    await query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at) VALUES ($1,'News at Noon', now() - interval '10 minutes', now() + interval '20 minutes')`, [news]);
    const inWin = await call('GET', `/api/channels/${news}`);
    check('a programme in the window fills the lane as before', [inWin.j?.epg?.lane?.length, inWin.j?.epg?.now?.name], [1, 'News at Noon']);
    check('...and carries no outside block', inWin.j?.epg?.outside === undefined, true);
    const evd = await call('GET', `/api/events/${ev}/detail`);
    check('the event page carries the same outside block', evd.s === 200 && 'outside' in (evd.j?.epg ?? {}), true);

    console.log('== (k) subtitles on a shared output profile ==');
    const before = await capsOf(shared);
    const evInst = await run('event_id', ev);
    let r = await call('PATCH', `/api/channels/${news}`, { captions: { enabled: !before.captions_enabled } });
    check('a change while an event on the same profile runs is refused (409)', [r.s, r.j?.code], [409, 'locked_while_running']);
    check('...naming the event', [/Cup Final/.test(msg(r)), (r.j?.running ?? []).map((x: any) => x.kind + ':' + x.name)], [true, ['event:Cup Final']]);
    check('...and the profile is unchanged', (await capsOf(shared)).captions_enabled, before.captions_enabled);
    r = await call('PATCH', `/api/channels/${news}`, { captions: { enabled: !!before.captions_enabled, offsetSec: Number(before.caption_offset_sec ?? 0) } });
    check('re-sending the stored value is not a change (200)', r.s, 200);
    const n2Inst = await run('channel_id', news2);
    r = await call('PATCH', `/api/channels/${news}`, { captions: { offsetSec: 3 } });
    check('with a second channel of the group running too, both are named',
      [r.s, (r.j?.running ?? []).map((x: any) => x.name).sort()], [409, ['Cup Final', 'Volt News 2']]);
    r = await call('PATCH', `/api/channels/${kids}`, { captions: { enabled: true } });
    check('a channel on another profile saves while they run (200)', [r.s, (await capsOf(own)).captions_enabled], [200, true]);
    r = await call('PATCH', `/api/channels/${news}`, { name: 'Volt News HD' });
    check('other settings of the channel still save while they run (200)', r.s, 200);
    await stop(evInst); await stop(n2Inst);
    r = await call('PATCH', `/api/channels/${news}`, { captions: { offsetSec: 3 } });
    check('once they stop the change saves (200)', [r.s, Number((await capsOf(shared)).caption_offset_sec)], [200, 3]);
    const selfInst = await run('channel_id', news);
    r = await call('PATCH', `/api/channels/${news}`, { captions: { offsetSec: 4 } });
    check('the channel running itself is still the channel lock (409, Subtitles)', [r.s, r.j?.code, r.j?.fields], [409, 'locked_while_running', ['Subtitles']]);
    await stop(selfInst);
  } catch (e) {
    fail++; console.log('FAIL threw', e);
  } finally {
    srv.close(); await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
