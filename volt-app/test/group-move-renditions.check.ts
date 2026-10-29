// ============================================================================
//  MOVING STREAMS BETWEEN GROUPS, AND EDITING RENDITIONS (build queue 1.14-G3a-5).
//
//  Fixes found writing the media guides, pinned over real HTTP:
//    - POST /api/channels/:id/group and /api/events/:id/group move a stream
//      to another of the account's groups, checked like creating it there:
//      the same workflow, room in the target's share (channels and stations
//      together) or in its running at once (an event that has not ended)
//    - access is Manage on the stream's own feature (TV channels, Radio,
//      FAST, Events); View is not enough and one kind's manager cannot move
//      another kind
//    - each move is in the audit log; the answer says when the target's
//      output profile differs and the stream is running
//    - the Live Streams list filters by group (Channel Groups' View its streams)
//    - PATCH /api/encode-profiles/:id is checked like the create: bounds, a
//      name taken (409 in words), no second rung of one height in a ladder,
//      a stale version refused; Encoding profiles: View cannot change it
//    DATABASE_URL=... npx tsx test/group-move-renditions.check.ts
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
  const acct = (await one<any>(`INSERT INTO accounts(name, max_channels) VALUES ($1, 50) RETURNING id`, [`gm-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name, max_channels) VALUES ($1, 50) RETURNING id`, [`gm-other-${tag}`]))!.id;
  const prof = async (a: string, name: string, wf: string) =>
    (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,$2,'[]',$3) RETURNING id`, [a, name, wf]))!.id;
  const grp = async (a: string, name: string, p: string, max: number, conc: number) =>
    (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id, max_channels, max_concurrent) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [a, name, p, max, conc]))!.id;
  const pT = await prof(acct, 'HD', 'transcode'), pT2 = await prof(acct, 'SD', 'transcode'), pP = await prof(acct, 'Pass', 'package_only');
  const home = await grp(acct, 'Home', pT, 10, 5);
  const sport = await grp(acct, 'Sport', pT2, 2, 1);      // another profile: profileChanges
  const same = await grp(acct, 'Same profile', pT, 1, 1);
  const pack = await grp(acct, 'Packaged', pP, 10, 5);
  const theirs = await grp(other, 'Theirs', await prof(other, 'T', 'transcode'), 10, 5);
  const ch = async (name: string, extra = '') =>
    (await one<any>(`INSERT INTO channels(group_id, name${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ($1,$2${extra ? `,'${extra.split('=')[1]}'` : ''}) RETURNING id`, [home, name]))!.id;
  const tv1 = await ch('Volt One'), tv2 = await ch('Volt Two'), tv3 = await ch('Volt Three');
  const station = await ch('Volt FM', 'kind=radio');
  const fast = await ch('Volt Movies', 'origin=playlist');
  await query(`UPDATE channels SET status = 'live' WHERE id = $1`, [tv1]);
  const ev = async (name: string, status = 'scheduled') => (await one<any>(
    `INSERT INTO events(group_id, name, scheduled_start, scheduled_end, status) VALUES ($1,$2, now() + interval '1 day', now() + interval '1 day 2 hours', $3) RETURNING id`,
    [home, name, status]))!.id;
  const e1 = await ev('Cup Final'), e2 = await ev('Cup Final replay'), eDone = await ev('Last season', 'ended');

  const users: Record<string, { id: string; tier: string }> = {};
  const person = async (key: string, tier: string, perms: any | null) => {
    const id = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x',$3,'active') RETURNING id`,
      [acct, `gm-${key}-${tag}@volt.test`, tier]))!.id;
    if (perms) {
      const g = (await one<any>(`INSERT INTO user_groups(account_id, name, permissions) VALUES ($1,$2,$3::jsonb) RETURNING id`, [acct, `${key} ${tag}`, JSON.stringify(perms)]))!.id;
      await query(`INSERT INTO user_group_members(user_id, group_id) VALUES ($1,$2)`, [id, g]);
    }
    users[key] = { id, tier };
  };
  // fast: none, or a role without a fast key keeps its TV channels level for FAST (cleanPerms)
  await person('tvManager', 'operator', { channels: 'manage', fast: 'none', monitoring: 'view' });
  await person('tvOperator', 'operator', { channels: 'operate' });
  await person('radioManager', 'operator', { radio: 'manage' });
  await person('fastManager', 'operator', { fast: 'manage' });
  await person('eventManager', 'operator', { events: 'manage' });
  await person('eventView', 'operator', { events: 'view' });
  await person('encManage', 'operator', { encoding: 'manage' });
  await person('encView', 'operator', { encoding: 'view' });
  await person('admin', 'admin', null);

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = (k: string) => signAccess({ sub: users[k].id, account_id: acct, role: users[k].tier });
  const call = async (method: string, path: string, k: string, body?: any) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok(k)}`, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const j = await res.json().catch(() => null) as any;
    return { s: res.status, j };
  };
  const msg = (r: { j: any }) => String(r.j?.error?.message ?? r.j?.error ?? r.j?.message ?? '');
  const groupOf = async (t: string, id: string) => (await one<any>(`SELECT group_id FROM ${t} WHERE id = $1`, [id]))?.group_id;
  const move = (kind: string, id: string, k: string, groupId: string) => call('POST', `/api/${kind}/${id}/group`, k, { groupId });

  try {
    console.log('== moving channels and stations ==');
    const m1 = await move('channels', tv1, 'tvManager', sport);
    check('a TV channels manager moves a channel to another transcode group (200)', m1.s, 200);
    check('...it is in the new group', await groupOf('channels', tv1), sport);
    check('...the answer names both groups', [m1.j?.from?.name, m1.j?.to?.name], ['Home', 'Sport']);
    check('...and says the profile differs and it is running (applies at the next start)', [m1.j?.profileChanges, m1.j?.running], [true, true]);
    const aud = await one<any>(`SELECT detail FROM audit_log WHERE entity_id = $1 AND action = 'update' ORDER BY created_at DESC LIMIT 1`, [tv1]);
    check('...and the move is in the audit log', [aud?.detail?.changes?.group?.from, aud?.detail?.changes?.group?.to], ['Home', 'Sport']);

    const m2 = await move('channels', station, 'radioManager', sport);
    check('a Radio Manager moves their station (200)', m2.s, 200);
    check('...a stopped stream on another profile is not running', [m2.j?.profileChanges, m2.j?.running], [true, false]);
    const full = await move('channels', tv2, 'tvManager', sport);
    check('a third into a group given 2 is refused (409, says full and counts TV and radio)',
      [full.s, /Sport is full/.test(msg(full)), /1 TV channel and 1 radio station/.test(msg(full))], [409, true, true]);
    check('...and the channel stays where it was', await groupOf('channels', tv2), home);
    const wf = await move('channels', tv2, 'tvManager', pack);
    check('a move to a packaging group is refused (409, names both workflows)',
      [wf.s, /Packaging group/.test(msg(wf)), /Transcode/.test(msg(wf))], [409, true, true]);
    check('a move to the group it is in is refused (400)', (await move('channels', tv2, 'tvManager', home)).s, 400);
    check('another account\'s group is not found (404)', (await move('channels', tv2, 'tvManager', theirs)).s, 404);
    check('an unknown group is not found (404)', (await move('channels', tv2, 'tvManager', '00000000-0000-4000-8000-0000000000ab')).s, 404);
    check('a body without a group is refused (422, the validation answer)', (await call('POST', `/api/channels/${tv2}/group`, 'tvManager', {})).s, 422);
    const sameProf = await move('channels', tv3, 'tvManager', same);
    check('a move to a group on the same profile says nothing changes for the output', [sameProf.s, sameProf.j?.profileChanges], [200, false]);

    console.log('== who may move what ==');
    check('a TV operator cannot move a channel (403)', (await move('channels', tv2, 'tvOperator', sport)).s, 403);
    check('a Radio Manager cannot move a TV channel (403)', (await move('channels', tv2, 'radioManager', home)).s, 403);
    check('a TV channels manager cannot move a station (403)', (await move('channels', station, 'tvManager', home)).s, 403);
    check('a TV channels manager cannot move a FAST channel (403)', (await move('channels', fast, 'tvManager', pack)).s, 403);
    const fm = await move('channels', fast, 'fastManager', sport);
    check('a FAST Manager moves a FAST channel, refused here only because Sport is full (409)', fm.s, 409);
    await query(`UPDATE groups SET max_channels = 3 WHERE id = $1`, [sport]);
    check('...and with room it moves (200)', (await move('channels', fast, 'fastManager', sport)).s, 200);
    check('a channel of another account cannot be moved (404)',
      (await move('channels', (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Not yours') RETURNING id`, [theirs]))!.id, 'admin', home)).s, 404);

    console.log('== moving events ==');
    const em = await move('events', e1, 'eventManager', sport);
    check('an Event Manager moves an event (200)', [em.s, await groupOf('events', e1)], [200, sport]);
    const over = await move('events', e2, 'eventManager', sport);
    check('an overlapping event into a group that runs 1 at once is refused (409)',
      [over.s, /already has 1 event at the same time/.test(msg(over))], [409, true]);
    check('an ended event moves whatever overlaps (200)', (await move('events', eDone, 'eventManager', sport)).s, 200);
    check('an Events viewer cannot move one (403)', (await move('events', e2, 'eventView', same)).s, 403);
    check('a TV channels manager cannot move an event (403)', (await move('events', e2, 'tvManager', same)).s, 403);
    check('an event to a packaging group is refused (409)', (await move('events', e2, 'eventManager', pack)).s, 409);
    check('an administrator moves one too (200)', (await move('events', e2, 'admin', same)).s, 200);

    console.log('== the group filter on the Live Streams list ==');
    const ls = await call('GET', `/api/live-streams?group_id=${sport}&limit=50`, 'admin');
    check('the list filtered to Sport has what was moved there', [ls.s, (ls.j ?? []).map((r: any) => r.name).sort()],
      [200, ['Cup Final', 'Last season', 'Volt FM', 'Volt Movies', 'Volt One']]);
    const ls2 = await call('GET', `/api/live-streams?group_id=${sport}&limit=50`, 'tvManager');
    // the list shows FAST channels to TV channels: View (modules/liveStreams.ts), not stations or events
    check('...a TV channels manager sees only TV and FAST in it', (ls2.j ?? []).map((r: any) => r.name).sort(), ['Volt Movies', 'Volt One']);

    console.log('== editing a rendition ==');
    const r = async (name: string, h: number, k: number) =>
      (await one<any>(`INSERT INTO encode_profiles(account_id, name, height, bitrate_kbps) VALUES ($1,$2,$3,$4) RETURNING id, version`, [acct, name, h, k]))!;
    const r720 = await r('720p 3000k', 720, 3000), r480 = await r('480p 1200k', 480, 1200), r1080 = await r('1080p 6000k', 1080, 6000);
    const lad = (await one<any>(`INSERT INTO encode_ladder_groups(account_id, name) VALUES ($1,'Web') RETURNING id`, [acct]))!.id;
    await query(`INSERT INTO encode_ladder_members(group_id, profile_id, ordinal) VALUES ($1,$2,0),($1,$3,1)`, [lad, r720.id, r480.id]);

    check('Encoding profiles: View reads the renditions (200)', (await call('GET', '/api/encode-profiles', 'encView')).s, 200);
    check('...but cannot change one (403)', (await call('PATCH', `/api/encode-profiles/${r720.id}`, 'encView', { bitrateKbps: 3500 })).s, 403);
    const ok = await call('PATCH', `/api/encode-profiles/${r720.id}`, 'encManage', { bitrateKbps: 3500, version: r720.version });
    check('Encoding profiles: Manage changes the bitrate (200, version bumped)', [ok.s, ok.j?.bitrate_kbps, ok.j?.version], [200, 3500, r720.version + 1]);
    const stale = await call('PATCH', `/api/encode-profiles/${r720.id}`, 'encManage', { bitrateKbps: 3600, version: r720.version });
    check('an edit from an older version is refused (409, says someone else changed it)', [stale.s, /Someone else changed/.test(msg(stale))], [409, true]);
    const two = await call('PATCH', `/api/encode-profiles/${r480.id}`, 'encManage', { height: 720 });
    check('a height its ladder already has is refused (409, names the ladder)', [two.s, /Web already has a 720p rendition/.test(msg(two))], [409, true]);
    check('...the same height for an unused rendition is fine (200)', (await call('PATCH', `/api/encode-profiles/${r1080.id}`, 'encManage', { height: 720 })).s, 200);
    const nm = await call('PATCH', `/api/encode-profiles/${r480.id}`, 'encManage', { name: '720p 3000k' });
    check('a name already taken is refused in words (409)', [nm.s, /a rendition called "720p 3000k" already exists/.test(msg(nm))], [409, true]);
    const bad = await call('PATCH', `/api/encode-profiles/${r480.id}`, 'encManage', { height: 50 });
    check('a height out of bounds is refused (400, says the bounds)', [bad.s, /between 90 and 4320/.test(msg(bad))], [400, true]);
    check('...and a text bitrate too (400)', (await call('PATCH', `/api/encode-profiles/${r480.id}`, 'encManage', { bitrateKbps: 'lots' })).s, 400);
    check('a rendition of another account is not found (404)',
      (await call('PATCH', `/api/encode-profiles/${(await one<any>(`INSERT INTO encode_profiles(account_id, name, height, bitrate_kbps) VALUES ($1,'x',720,1000) RETURNING id`, [other]))!.id}`, 'encManage', { bitrateKbps: 1000 })).s, 404);
    check('a rendition in a ladder still cannot be deleted (409)', (await call('DELETE', `/api/encode-profiles/${r480.id}`, 'encManage')).s, 409);
    check('an unused one can (204)', (await call('DELETE', `/api/encode-profiles/${r1080.id}`, 'encManage')).s, 204);
  } catch (e) {
    console.log('FAIL unexpected error', e); fail++;
  } finally {
    srv.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
