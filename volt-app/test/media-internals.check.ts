// ============================================================================
//  MEDIA LIBRARY ACCESS AND INTERNALS KEPT FROM CUSTOMERS (build queue 1.14-G3a-2).
//
//  Found writing the media guides:
//    - adding a file asks the ingest rules what they will do (POST
//      /api/ingest/preview), and that and three other lookups sat under
//      Account settings, so only Account settings: Manage could upload and the
//      Media Librarian template could not. They are now view-level lookups for
//      Files, uploads & storage or Account settings; the rules and linking a
//      provider stay Account settings: Manage.
//    - GET /api/workflows/map returned each stage's source file names (`impl`).
//    - Storage named the server setting behind a missing archive
//      (MEDIA_ARCHIVE_ENABLED) and each copy's raw address, and a refused
//      ladder answered in action keys (to_cold) and storage class names.
//      The setting and the address now go only to whoever runs Volt
//      (services/serverSetup.ts); messages use the Storage page's words.
//  Over real HTTP, plus the access map and the ladder check directly.
//    DATABASE_URL=... npx tsx test/media-internals.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};
/** What a customer must not be shown on these surfaces. */
const INTERNAL = /MEDIA_ARCHIVE_ENABLED|\bto_cold\b|\bto_archive\b|\bs3_[a-z_]+|Glacier|\bS3\b|\.(ts|py)\b/;

(async () => {
  process.env.VOLT_DEPLOYMENT = 'saas';             // a shared Volt: the owner is a customer
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { config } = await import('../src/config');
  const { requirementFor } = await import('../src/auth/roles');
  const { validateStages } = await import('../src/services/media/retention');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, max_channels) VALUES ($1, 50) RETURNING id`, [`mi-${tag}`]))!.id;
  const users: Record<string, { id: string; tier: string }> = {};
  const person = async (key: string, tier: string, perms: any | null) => {
    const id = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x',$3,'active') RETURNING id`,
      [acct, `mi-${key}-${tag}@volt.test`, tier]))!.id;
    if (perms) {
      const g = (await one<any>(`INSERT INTO user_groups(account_id, name, permissions) VALUES ($1,$2,$3::jsonb) RETURNING id`, [acct, `${key} ${tag}`, JSON.stringify(perms)]))!.id;
      await query(`INSERT INTO user_group_members(user_id, group_id) VALUES ($1,$2)`, [id, g]);
    }
    users[key] = { id, tier };
  };
  // The Media Librarian template (volt-web/src/roleTemplates.ts), as saved.
  await person('librarian', 'operator', { media: 'manage', vod: 'manage', recordings: 'view', sharing: 'manage' });
  await person('mediaView', 'operator', { media: 'view', vod: 'view' });
  await person('settings', 'operator', { settings: 'manage' });
  await person('monitor', 'operator', { monitoring: 'view' });
  await person('owner', 'owner', null);

  const g = (await one<any>(`INSERT INTO groups(account_id, name, max_channels) VALUES ($1,'Main',50) RETURNING id`, [acct]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Mi News') RETURNING id`, [g]))!.id;
  const obj = (await one<any>(
    `INSERT INTO media_objects(logical_key, kind, state, channel_id, bytes) VALUES ($1,'run_rendition','available',$2,1000000) RETURNING id`,
    [`channel/${ch}/run-1/720p`, ch]))!.id;
  await query(`INSERT INTO media_locations(object_id, tier, uri, bytes) VALUES ($1,'local',$2,1000000)`, [obj, `/var/volt/origin/channel/${ch}/run-1/720p`]);

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = (k: string) => signAccess({ sub: users[k].id, account_id: acct, role: users[k].tier });
  const call = async (method: string, path: string, k: string, body?: any) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok(k)}`, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await res.text();
    let j: any = null; try { j = JSON.parse(text); } catch { /* not json */ }
    return { s: res.status, j, text };
  };

  try {
    // ---- the access map, without a request
    const need = async (m: string, p: string) => { const r = await requirementFor(m, p); return r ? `${r.features.join('|')}:${r.level}` : null; };
    check('POST /api/ingest/preview is a view-level lookup for media or settings', await need('POST', '/api/ingest/preview'), 'media|settings:view');
    check('POST /api/ingest/sanitise likewise', await need('POST', '/api/ingest/sanitise'), 'media|settings:view');
    check('GET /api/ingest/baseline likewise', await need('GET', '/api/ingest/baseline'), 'media|settings:view');
    check('GET /api/ingest/providers likewise', await need('GET', '/api/ingest/providers'), 'media|settings:view');
    check('linking a provider (POST /api/ingest/providers) stays Account settings: manage', await need('POST', '/api/ingest/providers'), 'settings:manage');
    check('writing a rule stays Account settings: manage', await need('POST', '/api/ingest/rules'), 'settings:manage');
    check('the held queue stays Files, uploads & storage', await need('GET', '/api/ingest/held'), 'media:view');

    // ---- the Media Librarian template can add files
    const files = { files: [{ name: 'Harbour Walk.mp4', bytes: 12_000_000, mime: 'video/mp4' }] };
    const pv = await call('POST', '/api/ingest/preview', 'librarian', files);
    check('Media Librarian: the upload panel\'s rule preview answers (200, one row)', [pv.s, Array.isArray(pv.j) ? pv.j.length : pv.j], [200, 1]);
    check('...the baseline (200)', (await call('GET', '/api/ingest/baseline', 'librarian')).s, 200);
    check('...the linked cloud drives (200)', (await call('GET', '/api/ingest/providers', 'librarian')).s, 200);
    check('...the name check (200)', (await call('POST', '/api/ingest/sanitise', 'librarian', { names: ['Harbour Walk.mp4'] })).s, 200);
    const up = await call('POST', '/api/uploads', 'librarian', { purpose: 'vod', name: 'Harbour Walk', filename: 'Harbour Walk.mp4', totalBytes: 12_000_000 });
    check('...and opens the upload (201)', up.s, 201);
    if (up.j?.id) await call('DELETE', `/api/uploads/${up.j.id}`, 'librarian');
    check('...but cannot write an ingest rule (403)', (await call('POST', '/api/ingest/rules', 'librarian', { rung: 'account', name: 'x', then: {} })).s, 403);
    check('...nor link a provider (403)', (await call('POST', '/api/ingest/providers', 'librarian', { provider: 'masv', label: 'x', config: {} })).s, 403);
    check('Files, uploads & storage: view can ask the preview (200)', (await call('POST', '/api/ingest/preview', 'mediaView', files)).s, 200);
    check('Account settings: manage alone can still Try a filename on Ingest Rules (200)', (await call('POST', '/api/ingest/preview', 'settings', files)).s, 200);
    check('a role with neither is refused (403)', (await call('POST', '/api/ingest/preview', 'monitor', files)).s, 403);

    // ---- the workflow map has no source file names
    const map = await call('GET', '/api/workflows/map', 'owner');
    const stages = map.j?.stages ?? [];
    check('the workflow map lists its stages (200, more than 5)', [map.s, stages.length > 5], [200, true]);
    check('no stage carries impl', stages.some((s: any) => 'impl' in s), false);
    check('no source file name anywhere in the map', /\.(ts|tsx|py)\b/.test(map.text), false);

    // ---- storage, for an owner on a shared Volt (a customer)
    const caps = await call('GET', '/api/storage/capabilities', 'owner');
    check('capabilities: a plain reason, no setting name and no setup hint',
      [caps.s, !!caps.j?.archiveUnavailableReason, caps.j?.archiveSetupHint ?? null, INTERNAL.test(caps.text)], [200, true, null, false]);
    const ret = await call('GET', '/api/storage/retention', 'owner');
    check('the retention page\'s capabilities likewise', [ret.j?.capabilities?.archiveSetupHint ?? null, INTERNAL.test(JSON.stringify(ret.j?.capabilities))], [null, false]);
    const det = await call('GET', `/api/storage/objects/${obj}`, 'owner');
    check('an object\'s copies show their tier and size, not their address',
      [det.s, det.j?.locations?.[0]?.tier, 'uri' in (det.j?.locations?.[0] ?? {}), det.text.includes('/var/volt/origin')], [200, 'local', false, false]);
    const list = await call('GET', `/api/storage/objects?channel_id=${ch}`, 'owner');
    const row = (list.j?.objects ?? []).find((o: any) => o.id === obj);
    check('the object list likewise', [!!row, row ? 'uri' in (row.locations?.[0] ?? {}) : null, list.text.includes('/var/volt/origin')], [true, false, false]);
    const cold = await call('PUT', '/api/storage/retention', 'owner', { name: 'Mi', accountScope: true, stages: [{ afterDays: 30, action: 'to_cold' }] });
    const coldMsg = String(cold.j?.error ?? cold.j?.message ?? cold.text);
    check('a ladder this service cannot do is refused in the page\'s words (400, "Move to cheaper storage", no keys or setting)',
      [cold.s, coldMsg.includes('Move to cheaper storage'), INTERNAL.test(coldMsg)], [400, true, false]);
    const back = await call('PUT', '/api/storage/retention', 'owner', { name: 'Mi', accountScope: true, stages: [{ afterDays: 5, action: 'delete' }, { afterDays: 10, action: 'keep' }] });
    const backMsg = String(back.j?.error ?? back.j?.message ?? back.text);
    check('a backwards ladder names Delete and Keep, not their keys', [back.s, /Delete at 5 days is followed by Keep at 10 days/.test(backMsg)], [400, true]);

    // ---- whoever runs Volt still sees the setup: the owner on a single-client deployment
    (config as any).deployment = 'single';
    const capsOp = await call('GET', '/api/storage/capabilities', 'owner');
    check('single-client owner: the setup hint is there', typeof capsOp.j?.archiveSetupHint === 'string' && capsOp.j.archiveSetupHint.length > 0, true);
    const detOp = await call('GET', `/api/storage/objects/${obj}`, 'owner');
    check('...and so is each copy\'s address', detOp.j?.locations?.[0]?.uri, `/var/volt/origin/channel/${ch}/run-1/720p`);
    (config as any).deployment = 'saas';

    // ---- the ladder check on an archive-capable service, in the page's words
    const ms = (config as any).mediaStore; const was = { driver: ms.driver, archiveEnabled: ms.archiveEnabled };
    ms.driver = 's3'; ms.archiveEnabled = true;
    try {
      const v1: any = validateStages([{ afterDays: 30, action: 'to_cold', targetTier: 's3_deep_archive' } as any]);
      check('cooling to deep archive: refused naming "Deep archive" and "Archive", no class name or key',
        [v1.ok, /Deep archive/.test(v1.message), /Choose Archive/.test(v1.message), INTERNAL.test(v1.message)], [false, true, true, false]);
      const v2: any = validateStages([{ afterDays: 30, action: 'to_archive', targetTier: 's3_ia' } as any]);
      check('archiving to infrequent access: refused naming "Infrequent access" and "Move to cheaper storage"',
        [v2.ok, /Infrequent access/.test(v2.message), /Move to cheaper storage/.test(v2.message), INTERNAL.test(v2.message)], [false, true, true, false]);
      const v3: any = validateStages([{ afterDays: 30, action: 'to_cold', targetTier: 'local' } as any]);
      check('a tier the service lacks: the available ones listed in words', [v3.ok, /Available: Standard, Infrequent access/.test(v3.message), INTERNAL.test(v3.message)], [false, true, false]);
    } finally { ms.driver = was.driver; ms.archiveEnabled = was.archiveEnabled; }
  } finally {
    srv.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
