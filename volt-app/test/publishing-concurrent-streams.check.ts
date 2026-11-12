// ============================================================================
//  CONCURRENT STREAMS (build queue P3-4d; services/concurrentStreams.ts, the
//  play gate in modules/apps.ts, the beacon in modules/analytics.ts).
//
//  Decided by Christian, 11 Nov 2026: only signed-in viewers on content that
//  needs a sign-in (members-only, premium) are counted; free content is never
//  limited. Over the limit the OLDEST play is stopped and the new one starts;
//  the stopped play is told why on its next beacon (code concurrent_streams
//  and the words to show), and the gate refuses it if it asks again with the
//  same sid. Read from the title's stamp (or a channel's cached rules), so a
//  rule change reaches a published title with the restamp, and the warm gate
//  still makes no database read.
//
//  AT THE EDGE (P3-4d-2): the stopped play's sid goes on the edge stop list,
//  the sync writes it to the edge store as "x:<sid>" (and removes it once
//  every token from before the stop has expired), and the API's own token
//  check refuses the stopped play's on-demand addresses while the others'
//  still pass. The CloudFront and staging edge files are run on the same
//  cases in edge-tokens.check.ts.
//    DATABASE_URL=... npx tsx test/publishing-concurrent-streams.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++; } else { console.log(`FAIL ${m} -- expected [${w}] got [${g}]`); fail++; }
};

(async () => {
  process.env.VOLT_EDGE_TOKENS = 'issue';
  const C = await import('../src/services/concurrentStreams');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { signViewer } = await import('../src/auth/viewerTokens');
  const { invalidateTag } = await import('../src/scale/cache');
  const { randomUUID } = await import('node:crypto');
  const A = await import('../src/services/availability');

  // ---------------------------------------------------------------- pure
  check('concurrentLimitOf: none, 0 and junk are no limit; 2 is 2',
    [C.concurrentLimitOf(null), C.concurrentLimitOf({ protection: {} }), C.concurrentLimitOf({ protection: { concurrentStreams: 0 } }), C.concurrentLimitOf({ protection: { concurrentStreams: 'x' } }), C.concurrentLimitOf({ protection: { concurrentStreams: 2 } })],
    [null, null, null, null, 2]);
  check('countedPlay: only signed in, let in by members or an entitlement, with a limit',
    [C.countedPlay({ signedIn: true, via: 'members', limit: 1 }), C.countedPlay({ signedIn: true, via: 'entitlement', limit: 1 }),
     C.countedPlay({ signedIn: true, via: 'free', limit: 1 }), C.countedPlay({ signedIn: true, via: 'no_rule', limit: 1 }),
     C.countedPlay({ signedIn: false, via: 'members', limit: 1 }), C.countedPlay({ signedIn: true, via: 'members', limit: null })],
    [true, true, false, false, false, false]);
  const t0 = 1_000_000;
  const r1 = await C.admitPlay({ accountId: 'a', viewerId: 'v', sid: 'p1', assetId: 'x', limit: 1, now: t0 });
  const r2 = await C.admitPlay({ accountId: 'a', viewerId: 'v', sid: 'p2', assetId: 'x', limit: 1, now: t0 + 1000 });
  check('admitPlay: the second play over a limit of 1 stops the first', [r1, r2, await C.isStopped('p1', t0 + 2000), await C.isStopped('p2', t0 + 2000)],
    [{ open: 1, stopped: [] }, { open: 1, stopped: ['p1'] }, true, false]);
  const r3 = await C.admitPlay({ accountId: 'a', viewerId: 'v', sid: 'p3', assetId: 'x', limit: 1, now: t0 + 1000 + (C.PLAY_TTL_SEC + 1) * 1000 });
  check('a play not heard from for the TTL is closed, not stopped', [r3, await C.isStopped('p2', t0 + 1000 + (C.PLAY_TTL_SEC + 1) * 1000)], [{ open: 1, stopped: [] }, false]);
  C._resetForTests();

  // ---------------------------------------------------------------- the API
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`cs-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `cs-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const schema = async (name: string) => (await one<any>(`INSERT INTO metadata_schemas(account_id,name,target_kind,fields) VALUES ($1,$2,'vod','[]'::jsonb) RETURNING id`, [acct, name]))!.id as string;
  const membersT = await schema('Members film'), freeT = await schema('Free film'), seriesT = await schema('Series');
  const asset = async (title: string, schemaId: string) => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, schema_id, media_state, formats)
       VALUES ($1,'upload','clip',$2,'x',0,60000,60000,$3,'ready','{"hls":true}'::jsonb) RETURNING id`, [acct, title, schemaId]))!.id;
    await query(`UPDATE vod_assets SET master_key = $2 WHERE id = $1`, [id, `/clips/vod/${id}/master.m3u8`]);
    invalidateTag(`asset:${id}`);
    return String(id);
  };
  const srv = createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const http = async (method: string, path: string, body?: any, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j };
  };
  const admin = (method: string, path: string, body?: any) => http(method, path, body, { authorization: `Bearer ${tok}` });
  const MEMBERS = [{ id: 'm', for: { scopes: ['this', 'live', 'ondemand'] }, if: { geo: 'in', countries: ['WORLD'] }, then: { access: 'members' } }];
  try {
    check('the Members film rule: members only, 2 streams', (await admin('PUT', `/api/publishing-rules/schema/${membersT}`, { settings: { accessRules: MEMBERS, protection: { concurrentStreams: 2 } } })).s, 200);
    check('the Free film rule: free, 1 stream (never applies)', (await admin('PUT', `/api/publishing-rules/schema/${freeT}`, { settings: { protection: { concurrentStreams: 1 } } })).s, 200);
    check('the Series rule: members only, no limit yet', (await admin('PUT', `/api/publishing-rules/schema/${seriesT}`, { settings: { accessRules: MEMBERS } })).s, 200);
    const film = await asset('Film', membersT), free = await asset('Free', freeT), series = await asset('Series', seriesT);
    await A.publish(film, 'test'); await A.publish(free, 'test'); await A.publish(series, 'test');
    check('the stamp carries the limit', (await one<any>(`SELECT availability->'protection'->>'concurrentStreams' AS n FROM vod_assets WHERE id = $1`, [film]))!.n, '2');

    const web = (await admin('POST', '/api/apps', { name: 'Web', type: 'web' })).j.publishableKey.key;
    const vid = randomUUID(), other = randomUUID();
    const vt = signViewer({ id: vid, accountId: acct, appId: null, groups: [], entitlements: [] }).token;
    const ot = signViewer({ id: other, accountId: acct, appId: null, groups: [], entitlements: [] }).token;
    const gate = (id: string, sid: string | null, viewer: string | null = vt) =>
      http('POST', '/api/availability', { appKey: web, assetId: id, geo: 'GB', ...(sid ? { sid } : {}) }, viewer ? { authorization: `Bearer ${viewer}` } : {});
    const beacon = (playbackToken: string, sessionId: string, event = 'heartbeat') => http('POST', '/api/analytics/beacon', { playbackToken, sessionId, event, seconds: 30 });

    check('not signed in: members only refuses as before (403 sign_in)', [(await gate(film, 'anon-0001', null)).s, (await gate(film, 'anon-0001', null)).j.mode], [403, 'sign_in']);
    const p1 = await gate(film, 'play-0001');
    const p2 = await gate(film, 'play-0002');
    check('two plays within the limit both start, counted', [p1.s, p1.j.streams, p2.s, p2.j.streams], [200, { limit: 2, open: 1, stopped: 0 }, 200, { limit: 2, open: 2, stopped: 0 }]);
    const claims = JSON.parse(Buffer.from(p1.j.playbackToken.split('.')[1], 'base64url').toString());
    check('the counted play\'s token carries its sid and the viewer', [claims.sid, claims.v], ['play-0001', vid]);
    const media = async (url: string) => { const r = await fetch(base + url); return { s: r.status, t: (await r.text()).trim() }; };
    check('the play gate hands out tokenised addresses carrying the play\'s sid', [/^\/t\//.test(p1.j.delivery.hls),
      JSON.parse(Buffer.from(p1.j.delivery.hls.split('/')[2].split('.')[0], 'base64url').toString()).s], [true, 'play-0001']);
    check('before the stop, the first play\'s address passes the token check', (await media(p1.j.delivery.hls)).s !== 403, true);
    check('a heartbeat of an open play is answered as before (no stop)', [(await beacon(p1.j.playbackToken, 'play-0001')).s, (await beacon(p1.j.playbackToken, 'play-0001')).j.stop ?? null], [202, null]);
    await new Promise((r) => setTimeout(r, 5));
    const p3 = await gate(film, 'play-0003');
    check('a third play starts and stops the oldest', [p3.s, p3.j.streams], [200, { limit: 2, open: 2, stopped: 1 }]);
    const hb1 = await beacon(p1.j.playbackToken, 'play-0001');
    check('the stopped play is told on its next beacon, with the code and the words',
      [hb1.s, hb1.j.stop], [202, { code: 'concurrent_streams', message: 'Playback stopped because this account is playing on too many devices.' }]);
    check('the second play is not stopped', (await beacon(p2.j.playbackToken, 'play-0002')).j.stop ?? null, null);
    const again = await gate(film, 'play-0001');
    check('the stopped play asking again with its sid is refused (409 concurrent_streams), and stops nobody',
      [again.s, again.j.code, again.j.mode, again.j.message, (await C.openPlays(acct, vid)).map((p) => p.sid)],
      [409, 'concurrent_streams', 'stopped', 'Playing on too many devices', ['play-0002', 'play-0003']]);
    // ---- the edge (P3-4d-2)
    const ET = await import('../src/services/edgeTokens');
    const stops = await C.edgeStops();
    check('the stopped play is on the edge stop list, with when it stopped', stops.live.filter((x) => x.sid === 'play-0001').length === 1
      && Math.abs(stops.live.find((x) => x.sid === 'play-0001')!.at - Math.floor(Date.now() / 1000)) < 30, true);
    check('...and no play that still runs', stops.live.some((x) => x.sid === 'play-0002' || x.sid === 'play-0003'), false);
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
    const store = await ET.fileEdgeStore(join(mkdtempSync(join(tmpdir(), 'cs-edge-')), 'store.json'));
    const memo = new Map<string, string | null>();
    const sy = await ET.syncEdgeStops(store, memo);
    check('the edge sync writes "x:<sid>" with the stop time', [sy.put >= 1, (await store.get('x:play-0001')) === String(stops.live.find((x) => x.sid === 'play-0001')!.at)], [true, true]);
    check('...and only what changed on the next pass', (await ET.syncEdgeStops(store, memo)).put, 0);
    const refused = await media(p1.j.delivery.hls);
    check('the stopped play\'s old address is refused by the token check (403, the words)', [refused.s, refused.t], [403, 'Playing on too many devices']);
    check('...a segment below it too', (await media(p1.j.delivery.hls.replace('master.m3u8', '720p/seg_1.m4s'))).s, 403);
    check('the other plays\' addresses still pass', [(await media(p2.j.delivery.hls)).s !== 403, (await media(p3.j.delivery.hls)).s !== 403], [true, true]);
    const later = Math.floor(Date.now() / 1000) + ET.maxTokenLifetimeSec() + 1;
    check('kept as long as a token can live: gone after that', [(await C.edgeStops(later)).gone.includes('play-0001'), await C.edgeStoppedAt('play-0001', later)], [true, null]);
    const sy2 = await ET.syncEdgeStops(store, memo, later);
    check('...and the sync then removes it from the edge store and the list', [sy2.deleted >= 1, await store.get('x:play-0001'), (await C.edgeStops(later)).gone.includes('play-0001')], [true, null, false]);
    check('its end beacon is answered "stopped" too, and changes nothing', [(await beacon(p1.j.playbackToken, 'play-0001', 'end')).j.stop?.code, (await C.openPlays(acct, vid)).length], ['concurrent_streams', 2]);
    check('an end beacon of an open play closes it', [(await beacon(p3.j.playbackToken, 'play-0003', 'end')).s, (await C.openPlays(acct, vid)).map((p) => p.sid)], [202, ['play-0002']]);
    const p4 = await gate(film, 'play-0004');
    check('so a new play starts without stopping another', p4.j.streams, { limit: 2, open: 2, stopped: 0 });
    const o1 = await gate(film, 'other-0001', ot);
    check('another viewer has a count of their own', o1.j.streams, { limit: 2, open: 1, stopped: 0 });
    const ns = await gate(film, null);
    check('a play with no sid gets one from the gate, and is counted (stopping the oldest)',
      [ns.s, typeof ns.j.sid === 'string' && ns.j.sid.startsWith('cs-'), ns.j.streams.stopped, (await C.isStopped('play-0002'))], [200, true, 1, true]);

    // ---- free content is never limited
    const f = [await gate(free, 'free-0001'), await gate(free, 'free-0002'), await gate(free, 'free-0003')];
    check('free content: every play starts, nothing counted (the rule says 1)', [f.map((x) => x.s), f.map((x) => x.j.streams ?? null), await C.isStopped('free-0001')], [[200, 200, 200], [null, null, null], false]);

    // ---- a rule change reaches a published title with the restamp
    const s1 = await gate(series, 'ser-0001'), s2 = await gate(series, 'ser-0002');
    check('the Series has no limit: not counted', [s1.s, s1.j.streams ?? null, s2.j.streams ?? null], [200, null, null]);
    const put = await admin('PUT', `/api/publishing-rules/schema/${seriesT}`, { settings: { accessRules: MEMBERS, protection: { concurrentStreams: 1 } } });
    check('the Series rule now sets 1 stream; the published title is marked', [put.s, put.j.restamp?.marked ?? put.j.marked], [200, 1]);
    let stamped = false;
    for (let i = 0; i < 60 && !stamped; i++) {
      await A.restampStale();
      stamped = (await one<any>(`SELECT availability->'protection'->>'concurrentStreams' AS n FROM vod_assets WHERE id = $1`, [series]))?.n === '1';
      if (!stamped) await new Promise((r) => setTimeout(r, 100));
    }
    invalidateTag(`asset:${series}`);
    check('its stamp now carries the limit', stamped, true);
    // A viewer of their own: the count is the viewer's plays across all limited content, so the film plays above would count too.
    const st = signViewer({ id: randomUUID(), accountId: acct, appId: null, groups: [], entitlements: [] }).token;
    const s3 = await gate(series, 'ser-0003', st), s4 = await gate(series, 'ser-0004', st);
    check('and the second play stops the first', [s3.j.streams, s4.j.streams, await C.isStopped('ser-0003')], [{ limit: 1, open: 1, stopped: 0 }, { limit: 1, open: 1, stopped: 1 }, true]);

    // ---- a members-only channel, from its cached rules
    const grp = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'G') RETURNING id`, [acct]))!.id;
    const ch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Members TV') RETURNING id`, [grp]))!.id;
    check('the channel rule: members only, 1 stream', (await admin('PUT', `/api/publishing-rules/owner/${ch}`, { settings: { accessRules: MEMBERS, protection: { concurrentStreams: 1 } } })).s, 200);
    const ct = signViewer({ id: randomUUID(), accountId: acct, appId: null, groups: [], entitlements: [] }).token;
    const c1 = await gate(ch, 'chan-0001', ct), c2 = await gate(ch, 'chan-0002', ct);
    const c3 = await gate(film, 'chan-0003', ct);
    check('a channel: the second play stops the first', [c1.s, c1.j.streams, c2.j.streams, await C.isStopped('chan-0001')], [200, { limit: 1, open: 1, stopped: 0 }, { limit: 1, open: 1, stopped: 1 }, true]);
    check('the count is the viewer\'s plays of all limited content: a film (limit 2) beside the channel play starts, nothing stopped', [c3.s, c3.j.streams], [200, { limit: 2, open: 2, stopped: 0 }]);

    // ---- scale: a warm gate counting plays reads nothing
    await gate(film, 'warm-0001');
    const orig = (pool as any).query.bind(pool);
    let reads = 0;
    (pool as any).query = (...q: any[]) => { reads++; return orig(...q); };
    const w1 = await gate(film, 'warm-0002'), w2 = await gate(film, 'warm-0003'), w3 = await gate(film, 'warm-0001');
    (pool as any).query = orig;
    check('warm: counting, stopping and refusing with no database read', [w1.s, w2.j.streams?.stopped, w3.s, reads], [200, 1, 409, 0]);
  } catch (e: any) {
    console.log('FAIL threw: ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
