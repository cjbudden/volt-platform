// ============================================================================
//  FAST ELIGIBLE (build queue P3-4c, PUBLISHING_POLICIES.md Distribution):
//  a title whose publishing policy turns FAST eligibility off is not in the
//  FAST library (fast/store.ts libraryFor, deliveryPolicy.fastOffIds), a run
//  order naming it is refused, and the active lineups it is in are planned
//  again without it (dropFastIneligible): a draft as soon as the rule is
//  saved (read from its rules), a published title once the restamp gives it
//  the new stamp (read from the stamp), its own override and a bulk save too.
//  The programme on air is never cut; turning it back on lets it in again.
//    DATABASE_URL=... npx tsx test/publishing-fast-eligible.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${w}] got [${g}]`); fail++ }
};

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { libraryFor, dropFastIneligible } = await import('../src/services/fast/store');
  const { restampStale } = await import('../src/services/availability');
  const tag = Date.now().toString(36);
  const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`fe-${tag}`]))!.id;
  const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `fe-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: u, account_id: a, role: 'owner' });
  const g = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'G') RETURNING id`, [a]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status, tz, kind, origin, fast_media) VALUES ($1,'Movies','ended','UTC','tv','playlist','video') RETURNING id`, [g]))!.id;
  const schema = async (name: string) => (await one<any>(`INSERT INTO metadata_schemas(account_id,name,target_kind,fields) VALUES ($1,$2,'vod','[]'::jsonb) RETURNING id`, [a, name]))!.id;
  const film = await schema('Film'), docu = await schema('Documentary');
  const asset = async (title: string, schemaId: string, set = '') => {
    const id = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, schema_id, encode_result, qc_state)
       VALUES ($1,'upload','export',$2,$3,0,0,1800000,$4,'{"zeroStart":true,"segmentSeconds":4}'::jsonb,'pass') RETURNING id`, [a, title, `/clips/vod/${title}/master.m3u8`, schemaId]))!.id;
    if (set) await query(`UPDATE vod_assets SET ${set} WHERE id = $1`, [id]);
    return id as string;
  };
  // A published film with a stamp from before the distribution section, and a draft documentary.
  const A = await asset('Harbour', film, `availability_state = 'available', published = true, available_from = now() - interval '1 day', availability = '{"access":"free"}'::jsonb`);
  const B = await asset('Valley', docu);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch { j = txt; }
    return { s: r.status, j };
  };
  const upcoming = async (id: string) => (await one<any>(
    `SELECT count(*)::int AS n FROM programmes WHERE channel_id = $1 AND source_ref LIKE 'fast:%' AND metadata->>'vodAssetId' = $2 AND starts_at > now()`, [ch, id]))!.n;
  const started = async () => (await query<any>(
    `SELECT id, metadata->>'vodAssetId' AS asset FROM programmes WHERE channel_id = $1 AND source_ref LIKE 'fast:%' AND starts_at <= now() ORDER BY starts_at`, [ch])).map((r) => `${r.id}:${r.asset}`);
  const wait = async (f: () => Promise<boolean>) => { for (let i = 0; i < 60; i++) { if (await f()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
  const slots = (...ids: string[]) => ids.map((id, i) => ({ id: `s${i}`, kind: 'title', pool: [{ assetId: id }] }));

  try {
    let lib = await libraryFor(a);
    check('both titles are in the FAST library to start with (no rule says otherwise)', [lib.has(A), lib.has(B)], [true, true]);
    let r = await call('POST', `/api/fast/channels/${ch}/lineups`, { name: 'Main', slots: slots(A, B) });
    check('a run order of both is saved', r.s, 201);
    const lid = r.j.id ?? r.j.lineup?.id;
    r = await call('POST', `/api/fast/lineups/${lid}/activate`);
    check('activated, and its guide written', [r.s, (await upcoming(A)) > 0, (await upcoming(B)) > 0], [200, true, true]);
    const onAir = await started();

    // ---- a draft, from its rules: the Documentary rule turns FAST off
    r = await call('PUT', `/api/publishing-rules/schema/${docu}`, { settings: { distribution: { fastEligible: false } }, lockedFields: [] });
    check('the Documentary rule turns FAST eligible off', r.s, 200);
    check('the draft documentary leaves the guide to come, without waiting for a sweep', await wait(async () => (await upcoming(B)) === 0), true);
    check('the film stays in it', (await upcoming(A)) > 0, true);
    check('the programme on air is not cut', await started(), onAir);
    lib = await libraryFor(a);
    check('the FAST library leaves the documentary out', [lib.has(A), lib.has(B)], [true, false]);
    r = await call('POST', `/api/fast/channels/${ch}/lineups`, { name: 'Second', slots: slots(B) });
    check('a run order naming it is refused, with the title and the reason', [r.s, r.j.error],
      [400, 'Valley cannot go on a FAST channel: its publishing rule turns FAST eligible off (Distribution).']);
    r = await call('PUT', `/api/fast/lineups/${lid}`, { slots: slots(A, B), settings: { backfill: [B] } });
    check('and so is putting it back in the run order, or as backfill', r.s, 400);

    // ---- a published title, from its stamp, once the restamp has stamped it
    r = await call('PUT', `/api/publishing-rules/schema/${film}`, { settings: { distribution: { fastEligible: false } }, lockedFields: [] });
    check('the Film rule turns FAST off: the published film is marked for the restamp', [r.s, r.j.restamp?.marked ?? r.j.marked], [200, 1]);
    // The save starts the restamp itself; the sweep's call is made here too, in case it has not run yet.
    check('its stamp now says FAST is off', await wait(async () => { await restampStale();
      return (await one<any>(`SELECT availability->'distribution'->>'fastEligible' AS f FROM vod_assets WHERE id = $1`, [A]))?.f === 'false'; }), true);
    check('and it has left the guide to come', await wait(async () => (await upcoming(A)) === 0), true);
    check('the programme on air still is not cut', await started(), onAir);
    check('nothing left to drop: a second pass plans nothing again', (await dropFastIneligible(a)).lineups, []);

    // ---- the title's own override wins, both ways
    r = await call('PATCH', `/api/vod/${B}/availability`, { override: { distribution: { fastEligible: true } } });
    check('the documentary\'s own policy turns FAST back on for it', r.s, 200);
    check('it is in the library again', (await libraryFor(a)).has(B), true);
    r = await call('POST', `/api/fast/lineups/${lid}/apply`, { days: 1 });
    check('Apply puts it back in the guide', [r.s, (await upcoming(B)) > 0], [200, true]);
    r = await call('PATCH', `/api/vod/${B}/availability`, { override: { distribution: { fastEligible: false } } });
    check('its own policy turning FAST off takes it out at once', [r.s, await upcoming(B)], [200, 0]);

    // ---- a bulk save
    await call('PATCH', `/api/vod/${B}/availability`, { override: {} });
    await call('PUT', `/api/publishing-rules/schema/${docu}`, { settings: {}, lockedFields: [] });
    await call('POST', `/api/fast/lineups/${lid}/apply`, { days: 1 });
    check('back on the rules with FAST on, it is in the guide again', await wait(async () => (await upcoming(B)) > 0), true);
    r = await call('POST', '/api/vod/bulk/availability', { ids: [B], action: 'apply', override: { distribution: { fastEligible: false } } });
    check('a bulk save turning FAST off takes it out', [r.s, r.j.ok, await upcoming(B)], [200, 1, 0]);
  } finally {
    srv.close(); await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
