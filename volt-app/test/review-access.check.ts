// ============================================================================
//  REVIEW FROM THE CONSOLE, AND RECORDING DOWNLOADS (build queue 1.14-G3a).
//
//  The console now sends a clip for review from the Media Library and offers
//  only the moves the server takes (Review.tsx mirrors services/review.ts
//  LEGAL). This suite pins the server side of that contract over real HTTP:
//    - draft -> in_review needs no note; changes requested cannot go straight
//      to approved, it goes back into review first; rejecting needs a note
//    - deciding is Media library: manage; a View role is refused (403)
//  and the access fix found writing the media guides:
//    - GET /api/recordings/:id/download needs Downloads: operate, not only
//      Recordings: view (it used to export and hand over the whole recording
//      to any role that could see it)
//    DATABASE_URL=... npx tsx test/review-access.check.ts
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
  const acct = (await one<any>(`INSERT INTO accounts(name, max_channels) VALUES ($1, 50) RETURNING id`, [`ra-${tag}`]))!.id;
  const users: Record<string, { id: string; tier: string }> = {};
  const person = async (key: string, tier: string, perms: any | null) => {
    const id = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x',$3,'active') RETURNING id`,
      [acct, `ra-${key}-${tag}@volt.test`, tier]))!.id;
    if (perms) {
      const g = (await one<any>(`INSERT INTO user_groups(account_id, name, permissions) VALUES ($1,$2,$3::jsonb) RETURNING id`, [acct, `${key} ${tag}`, JSON.stringify(perms)]))!.id;
      await query(`INSERT INTO user_group_members(user_id, group_id) VALUES ($1,$2)`, [id, g]);
    }
    users[key] = { id, tier };
  };
  await person('libView', 'operator', { vod: 'view', recordings: 'view' });
  await person('libManage', 'operator', { vod: 'manage', recordings: 'manage' });
  await person('recOnly', 'operator', { recordings: 'manage', vod: 'manage' });          // no Downloads
  await person('recDl', 'operator', { recordings: 'view', downloads: 'operate' });
  await person('dlView', 'operator', { recordings: 'view', downloads: 'view' });
  await person('viewerTier', 'viewer', { recordings: 'manage', downloads: 'manage' });  // tier caps at view
  await person('owner', 'owner', null);

  const g = (await one<any>(`INSERT INTO groups(account_id, name, max_channels) VALUES ($1,'Main',50) RETURNING id`, [acct]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Ra News') RETURNING id`, [g]))!.id;
  const now = Date.now();
  const rec = (await one<any>(
    `INSERT INTO recordings(kind, channel_id, day_utc, status, start_epoch_ms, end_epoch_ms, master_key)
     VALUES ('channel_day', $1, current_date, 'complete', $2, $3, $4) RETURNING id`,
    [ch, now - 120_000, now - 60_000, `channel/${ch}`]))!.id;
  const clip = async (title: string) => (await one<any>(
    `INSERT INTO vod_assets(channel_id, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms)
     VALUES ($1,'clip',$2,'',$3,$4,60000) RETURNING id`, [ch, title, now - 120_000, now - 60_000]))!.id;

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = (k: string) => signAccess({ sub: users[k].id, account_id: acct, role: users[k].tier });
  const call = async (method: string, path: string, k: string, body?: any) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok(k)}`, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const j = await res.json().catch(() => null) as any;
    return { s: res.status, j };
  };
  const review = (id: string, k: string, to: string, note?: string) => call('POST', `/api/vod/${id}/review`, k, { to, ...(note ? { note } : {}) });

  try {
    // ---- the moves the console offers
    const a = await clip(`Ra clip ${tag}`);
    check('a new clip is a draft and not in the queue',
      [(await call('GET', `/api/vod/${a}/review`, 'libManage')).j?.state, (await call('GET', '/api/vod/review/queue', 'libManage')).j?.queue?.some((r: any) => r.id === a)], ['draft', false]);
    check('a View role cannot send it for review (403), so the console shows no button', (await review(a, 'libView', 'in_review')).s, 403);
    check('...and cannot re-run QC (403)', (await call('POST', `/api/vod/${a}/qc`, 'libView')).s, 403);
    const sent = await review(a, 'libManage', 'in_review');
    check('Send for review from the Media Library: draft -> in review with no note (200)', [sent.s, sent.j?.review_state], [200, 'in_review']);
    check('...and the clip is now in the queue', (await call('GET', '/api/vod/review/queue', 'libManage')).j?.queue?.some((r: any) => r.id === a), true);
    check('Request changes without a note is refused (400)', (await review(a, 'libManage', 'changes_requested')).s, 400);
    check('Request changes with a note (200)', (await review(a, 'libManage', 'changes_requested', 'Trim the last 4 s')).j?.review_state, 'changes_requested');
    const straight = await review(a, 'libManage', 'approved');
    check('Approve is refused on Changes requested (400), so the console offers Send back for review instead', [straight.s, /changes_requested to approved/.test(straight.j?.error ?? straight.j?.message ?? '')], [400, true]);
    check('Send back for review (200)', (await review(a, 'libManage', 'in_review')).j?.review_state, 'in_review');
    check('...then Approve (200)', (await review(a, 'libManage', 'approved')).j?.review_state, 'approved');
    check('an approved clip leaves the queue', (await call('GET', '/api/vod/review/queue', 'libManage')).j?.queue?.some((r: any) => r.id === a), false);
    check('Send back for review from the Media Library on an approved clip (200)', (await review(a, 'libManage', 'in_review')).j?.review_state, 'in_review');
    check('Reject without a note is refused (400)', (await review(a, 'libManage', 'rejected')).s, 400);
    check('Reject with a note (200)', (await review(a, 'libManage', 'rejected', 'Wrong match')).j?.review_state, 'rejected');
    check('a rejected clip can be sent for review again (200)', (await review(a, 'libManage', 'in_review')).j?.review_state, 'in_review');
    const hist = (await call('GET', `/api/vod/${a}/review`, 'libView')).j?.history ?? [];
    check('a View role reads the whole history (7 decisions)', hist.length, 7);

    // ---- recording downloads follow the Downloads permission
    const dl = (k: string) => call('GET', `/api/recordings/${rec}/download`, k);
    const refused = await dl('recOnly');
    check('Recordings and Media library manage without Downloads: 403 forbidden_feature on Downloads',
      [refused.s, refused.j?.code ?? refused.j?.error?.code, refused.j?.feature ?? refused.j?.error?.feature], [403, 'forbidden_feature', 'downloads']);
    check('Downloads: view is not enough to take a copy (403)', (await dl('dlView')).s, 403);
    check('a viewer-tier user is capped at view (403)', (await dl('viewerTier')).s, 403);
    check('Downloads: operate gets through to the export (not 403)', (await dl('recDl')).s !== 403, true);
    check('the owner gets through (not 403)', (await dl('owner')).s !== 403, true);
    check('seeing the recording itself still needs only Recordings: view (200)', (await call('GET', `/api/recordings/${rec}`, 'recDl')).s, 200);
  } finally {
    srv.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
