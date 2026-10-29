// ============================================================================
//  THE REST OF 1.14-G5b (build queue 1.14-G5b-2): radio, part (l).
//
//  Pinned over real HTTP:
//    (l1) PATCH /api/radio/:id/log/:entryId corrects a log entry's class: an
//         operator may, a viewer may not (403), another account or another
//         station gets 404, a guide entry that is not from the ICY log is not
//         a log entry (404); the raw block stays, the classifier's reading is
//         kept as class_auto, the log answer shows who corrected it and the
//         class tabs count it in its new class; the change is audited
//    (l2) the Recordings search finds a station by a song in its log that
//         aired inside one of its recordings, and says so (match.by = aired,
//         the title); a guide entry with no recording under it is not a hit;
//         a name hit says name; another account's songs are never found
//    (l3) DELETE /api/radio/:id deletes a station the way DELETE
//         /api/channels/:id does: administrators only (403 for an operator
//         with Radio: manage), 404 for another account and for a TV channel,
//         refused while live, 204 and gone otherwise; delete-impact answers
//    DATABASE_URL=... npx tsx test/g5b2-fixes.check.ts
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
  const acct = (await one<any>(`INSERT INTO accounts(name, max_channels) VALUES ($1, 50) RETURNING id`, [`g5b2-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name, max_channels) VALUES ($1, 50) RETURNING id`, [`g5b2-o-${tag}`]))!.id;
  const mkUser = async (a: string, key: string, role: string, perms?: any) => {
    const id = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x',$3,'active') RETURNING id`,
      [a, `g5b2-${key}-${tag}@volt.test`, role]))!.id;
    if (perms) {
      const g = (await one<any>(`INSERT INTO user_groups(account_id, name, permissions) VALUES ($1,$2,$3::jsonb) RETURNING id`, [a, `${key} ${tag}`, JSON.stringify(perms)]))!.id;
      await query(`INSERT INTO user_group_members(user_id, group_id) VALUES ($1,$2)`, [id, g]);
    }
    return { id, role, a };
  };
  const admin = await mkUser(acct, 'admin', 'admin');
  const radioOp = await mkUser(acct, 'op', 'operator', { radio: 'operate', recordings: 'view' });
  const radioView = await mkUser(acct, 'view', 'operator', { radio: 'view' });
  const radioMgr = await mkUser(acct, 'mgr', 'operator', { radio: 'manage' });
  const otherOwner = await mkUser(other, 'oo', 'owner');

  const g = (await one<any>(`INSERT INTO groups(account_id, name, max_channels, max_concurrent) VALUES ($1,'Audio',20,5) RETURNING id`, [acct]))!.id;
  const og = (await one<any>(`INSERT INTO groups(account_id, name, max_channels, max_concurrent) VALUES ($1,'Theirs',20,5) RETURNING id`, [other]))!.id;
  const station = async (grp: string, name: string, status = 'ended') =>
    (await one<any>(`INSERT INTO channels(group_id, name, kind, status) VALUES ($1,$2,'radio',$3) RETURNING id`, [grp, name, status]))!.id;
  const fm = await station(g, 'Volt FM'), gold = await station(g, 'Volt Gold');
  const theirs = await station(og, 'Their FM');
  const tv = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Volt News') RETURNING id`, [g]))!.id;

  const H = 3600_000, now = Date.now();
  const at = (ms: number) => new Date(ms).toISOString();
  const rec = async (ch: string, from: number, to: number) =>
    query(`INSERT INTO recordings(kind, channel_id, day_utc, status, start_epoch_ms, end_epoch_ms, duration_ms)
           VALUES ('channel_day',$1,$2,'complete',$3,$4,$5)`, [ch, at(from).slice(0, 10), from, to, to - from]);
  const icy = async (ch: string, title: string, from: number, to: number, cls: string) =>
    (await one<any>(`INSERT INTO programmes(channel_id, source_ref, title, starts_at, ends_at, status, metadata)
       VALUES ($1,$2,$3,$4,$5,'aired',$6::jsonb) RETURNING id`,
      [ch, `icy:${from}:${Math.random()}`, title, at(from), at(to), JSON.stringify({ source: 'icy', class: cls, raw: `StreamTitle='${title}';`, stream_url: null })]))!.id;

  // Volt FM recorded 6 h ago to 2 h ago. A song inside it, an ad inside it, a song
  // after the recording ended (nothing holds it). Their FM played the same song.
  await rec(fm, now - 6 * H, now - 2 * H);
  const song = await icy(fm, 'Queen - Bohemian Rhapsody', now - 5 * H, now - 5 * H + 354_000, 'song');
  const ident = await icy(fm, 'Volt FM - the hits', now - 4 * H, now - 4 * H + 8_000, 'song');      // the classifier's mistake
  await icy(fm, 'Daft Punk - Around the World', now - 1 * H, now - 1 * H + 400_000, 'song');        // after the recording
  await rec(theirs, now - 6 * H, now - 2 * H);
  await icy(theirs, 'Queen - Bohemian Rhapsody', now - 5 * H, now - 5 * H + 354_000, 'song');
  const guideOnly = (await one<any>(`INSERT INTO programmes(channel_id, title, starts_at, ends_at) VALUES ($1,'Breakfast with Sam',$2,$3) RETURNING id`,
    [fm, at(now - 5 * H), at(now - 4 * H)]))!.id;
  const goldSong = await icy(gold, 'Abba - Waterloo', now - 3 * H, now - 3 * H + 160_000, 'song');

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, who: { id: string; role: string; a: string }, body?: any) => {
    const tok = signAccess({ sub: who.id, account_id: who.a, role: who.role as any });
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}) });
    const j = await res.json().catch(() => null) as any;
    return { s: res.status, j };
  };
  const meta = async (id: string) => (await one<any>(`SELECT metadata FROM programmes WHERE id = $1`, [id]))!.metadata;
  const from = encodeURIComponent(at(now - 7 * H)), to = encodeURIComponent(at(now));

  try {
    console.log('== (l1) correcting a log entry\'s class ==');
    const before = await call('GET', `/api/radio/${fm}/log?from=${from}&to=${to}`, radioOp);
    check('the log reads (200)', before.s, 200);
    check('...three songs counted before the correction', before.j?.counts?.song, 3);
    check('a viewer cannot correct (403)', (await call('PATCH', `/api/radio/${fm}/log/${ident}`, radioView, { class: 'content' })).s, 403);
    check('another account gets 404', (await call('PATCH', `/api/radio/${fm}/log/${ident}`, otherOwner, { class: 'content' })).s, 404);
    check('an entry of another station is not found (404)', (await call('PATCH', `/api/radio/${fm}/log/${goldSong}`, radioOp, { class: 'content' })).s, 404);
    check('a guide entry that is not from the log is not found (404)', (await call('PATCH', `/api/radio/${fm}/log/${guideOnly}`, radioOp, { class: 'ad' })).s, 404);
    check('an unknown class is refused (422, a validation answer)', (await call('PATCH', `/api/radio/${fm}/log/${ident}`, radioOp, { class: 'jingle' })).s, 422);
    const fix = await call('PATCH', `/api/radio/${fm}/log/${ident}`, radioOp, { class: 'content' });
    check('a radio operator corrects it (200)', fix.s, 200);
    check('...the answer has the new class and what the classifier said', [fix.j?.class, fix.j?.classAuto], ['content', 'song']);
    const m = await meta(ident);
    check('...stored: class, class_auto, who', [m.class, m.class_auto, typeof m.class_by], ['content', 'song', 'string']);
    check('...the raw ICY block is untouched', [m.source, m.raw], ['icy', `StreamTitle='Volt FM - the hits';`]);
    const again = await call('PATCH', `/api/radio/${fm}/log/${ident}`, radioOp, { class: 'ad' });
    check('a second correction keeps the classifier\'s first reading', [again.j?.class, again.j?.classAuto], ['ad', 'song']);
    const after = await call('GET', `/api/radio/${fm}/log?from=${from}&to=${to}`, radioOp);
    const row = (after.j?.entries ?? []).find((e: any) => e.id === ident);
    check('the log shows the class and who corrected it', [row?.class, row?.class_auto, typeof row?.class_by], ['ad', 'song', 'string']);
    check('...and the tabs count it as an ad', [after.j?.counts?.song, after.j?.counts?.ad], [2, 1]);
    const songRow = (after.j?.entries ?? []).find((e: any) => e.id === song);
    check('an uncorrected entry has no corrector', [songRow?.class, songRow?.class_by ?? null], ['song', null]);
    const audit = await one<any>(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'radio_log_entry' AND entity_id = $1`, [ident]);
    check('both corrections are in the audit log', audit?.n, 2);

    console.log('== (l2) the Recordings search finds what was played ==');
    const hit = await call('GET', `/api/recordings/sources?q=${encodeURIComponent('bohemian')}`, admin);
    check('search (200)', hit.s, 200);
    const names = (hit.j?.sources ?? []).map((s: any) => s.name);
    check('Volt FM is found by a song in its log', names.includes('Volt FM'), true);
    check('...the other account\'s station with the same song is not', names.includes('Their FM'), false);
    const fmRow = (hit.j?.sources ?? []).find((s: any) => s.id === fm);
    check('...it says why: the song and when', [fmRow?.match?.by, fmRow?.match?.title, fmRow?.match?.count], ['aired', 'Queen - Bohemian Rhapsody', 1]);
    check('...the recording counts are the whole source, not the matching part', fmRow?.recordings, 1);
    check('a song after the recording ended is not a hit (nothing holds it)',
      ((await call('GET', `/api/recordings/sources?q=${encodeURIComponent('around the world')}`, admin)).j?.sources ?? []).length, 0);
    const guide = await call('GET', `/api/recordings/sources?q=${encodeURIComponent('breakfast')}`, admin);
    check('a guide programme inside a recording is a hit too', (guide.j?.sources ?? []).map((s: any) => s.match?.title), ['Breakfast with Sam']);
    const byName = await call('GET', `/api/recordings/sources?q=${encodeURIComponent('volt fm')}`, admin);
    check('a name hit says name', (byName.j?.sources ?? []).map((s: any) => s.match?.by), ['name']);
    const none = await call('GET', `/api/recordings/sources`, admin);
    check('no search, no match field', (none.j?.sources ?? []).every((s: any) => s.match === null), true);

    console.log('== (l3) deleting a station through the radio API ==');
    const doomed = await station(g, 'Volt Talk'), onAir = await station(g, 'Volt Live', 'live');
    const imp = await call('GET', `/api/radio/${doomed}/delete-impact`, admin);
    check('delete-impact answers for a station (200)', [imp.s, imp.j?.kind, imp.j?.blocker], [200, 'radio', null]);
    check('delete-impact names the blocker while live', (await call('GET', `/api/radio/${onAir}/delete-impact`, admin)).j?.blocker, 'Stop the channel before deleting it');
    check('another account cannot delete it (404)', (await call('DELETE', `/api/radio/${doomed}`, otherOwner)).s, 404);
    check('a TV channel is not a station (404)', (await call('DELETE', `/api/radio/${tv}`, admin)).s, 404);
    check('...and the TV channel is still there', !!(await one(`SELECT 1 FROM channels WHERE id = $1`, [tv])), true);
    check('an operator with Radio: manage is not an administrator (403)', (await call('DELETE', `/api/radio/${doomed}`, radioMgr)).s, 403);
    check('a live station is refused (400)', (await call('DELETE', `/api/radio/${onAir}`, admin)).s, 400);
    const del = await call('DELETE', `/api/radio/${doomed}`, admin);
    check('an administrator deletes it (204)', del.s, 204);
    check('...it is gone', !!(await one(`SELECT 1 FROM channels WHERE id = $1`, [doomed])), false);
    check('...a second delete is 404', (await call('DELETE', `/api/radio/${doomed}`, admin)).s, 404);
    check('the channels route still deletes a station too (204)', (await call('DELETE', `/api/channels/${gold}`, admin)).s, 204);
  } catch (e) {
    console.log('FAIL threw: ' + ((e as any)?.stack ?? e)); fail++;
  } finally {
    srv.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
