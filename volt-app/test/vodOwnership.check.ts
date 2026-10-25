/**
 * AN UPLOADED ASSET IS THE ACCOUNT'S OWN. A VOD asset that came from an upload
 * or a watch folder has no channel or event, so it belongs to its account
 * directly (vod.ts OWNER_ACCOUNT). Eight code paths checked ownership through a
 * channel or event group only, so such an asset showed in the library and then
 * was "not found" everywhere else. This walks every one of them with a real
 * uploaded asset, plus an asset of ANOTHER account that must stay invisible.
 *   DATABASE_URL=... npx tsx test/vodOwnership.check.ts
 */
(async () => {
  const { createServer } = await import('../src/server');
  const { query, one } = await import('../src/db');
  const { loadResource } = await import('../src/services/shareLinks');
  const { clipPieces } = await import('../src/services/thumbnails/clips');
  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  let fails = 0;
  const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fails++; };
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.DOCS_TEST_EMAIL ?? 'admin@volt.test', password: process.env.DOCS_TEST_PASSWORD ?? 'VoltTest!2026' }) });
  const token = (await login.json() as any).access;
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const acct = (await (await fetch(`${base}/api/auth/me`, { headers: H })).json() as any)?.account?.id
    ?? (await one<any>(`SELECT account_id FROM users WHERE email=$1`, [process.env.DOCS_TEST_EMAIL ?? 'admin@volt.test']))?.account_id;

  const mine = (await one<any>(
    `INSERT INTO vod_assets (account_id, source_kind, title, review_state, qc_state, start_epoch_ms, end_epoch_ms, duration_ms)
     VALUES ($1, 'upload', 'Ownership check upload ' || gen_random_uuid(), 'in_review', 'failed', 0, 60000, 60000) RETURNING id, title`, [acct]));
  const other = (await one<any>(`SELECT id FROM accounts WHERE id <> $1 LIMIT 1`, [acct]))?.id
    ?? (await one<any>(`INSERT INTO accounts (name) VALUES ('Ownership check other') RETURNING id`)).id;
  const theirs = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, title, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1, 'upload', 'Not yours', 0, 60000, 60000) RETURNING id`, [other]));

  try {
    const lib = await (await fetch(`${base}/api/vod?limit=200&q=${encodeURIComponent('Ownership check upload')}`, { headers: H })).json() as any[];
    ok(lib.some((v) => v.id === mine.id), 'library lists the uploaded asset');
    ok((await fetch(`${base}/api/publications?assetId=${mine.id}`, { headers: H })).status === 200, 'its publications can be listed');
    ok((await fetch(`${base}/api/publications?assetId=${theirs.id}`, { headers: H })).status === 404, "another account's asset: still 404");
    const s = await (await fetch(`${base}/api/search?q=${encodeURIComponent(mine.title)}`, { headers: H })).json() as any;
    ok(JSON.stringify(s).includes(mine.id), 'global search finds it');
    const share = await fetch(`${base}/api/share-links`, { method: 'POST', headers: H, body: JSON.stringify({ resourceKind: 'vod', resourceId: mine.id }) });
    ok(share.status === 201 || share.status === 200, `it can be shared (${share.status})`);
    const shareTheirs = await fetch(`${base}/api/share-links`, { method: 'POST', headers: H, body: JSON.stringify({ resourceKind: 'vod', resourceId: theirs.id }) });
    ok(shareTheirs.status === 404, `another account's asset cannot be shared (${shareTheirs.status})`);
    ok(!!(await loadResource('vod', mine.id, acct)) && !(await loadResource('vod', theirs.id, acct)), 'share page loads it, and only for its account');
    ok((await clipPieces(mine.id, acct)) !== null && (await clipPieces(theirs.id, acct)) === null, 'clip thumbnails resolve it, and only for its account');
    const reviewQ = await (await fetch(`${base}/api/vod/review/queue`, { headers: H })).json() as any;
    ok(JSON.stringify(reviewQ).includes(mine.id), 'review queue includes it');
    const mon = await fetch(`${base}/api/monitoring/overview`, { headers: H });
    ok(mon.status === 200, 'monitoring overview (QC and review counts) answers');
    // Publishing resolves the asset's account too (build queue 1.14-G5: Publish
    // and Remove access on an upload answered "Asset not found").
    const { assetAccount } = await import('../src/services/availability');
    const found = await assetAccount(mine.id);
    ok(found?.accountId === acct, 'publishing resolves the upload to its own account');
    ok((await assetAccount(theirs.id))?.accountId === other, "and another account's upload to that account");
    ok((await fetch(`${base}/api/publishing-rules/resolve?assetId=${mine.id}`, { headers: H })).status === 200, 'its publishing plan can be resolved');
    ok((await fetch(`${base}/api/publishing-rules/resolve?assetId=${theirs.id}`, { headers: H })).status === 404, "another account's plan: still 404");
    const pub = await fetch(`${base}/api/vod/${mine.id}/publish`, { method: 'POST', headers: H, body: '{}' });
    const pubBody = await pub.json().catch(() => ({})) as any;
    ok(pub.status !== 404 && pubBody.code !== 'not_found', `Publish reaches the gate instead of "not found" (${pub.status} ${pubBody.code ?? pubBody.state ?? ''})`);
    const wd = await fetch(`${base}/api/vod/${mine.id}/withdraw`, { method: 'POST', headers: H, body: '{}' });
    ok(wd.status === 200, `Remove access works on it (${wd.status})`);
  } finally {
    await query(`DELETE FROM share_links WHERE resource_id = ANY($1)`, [[mine.id, theirs.id]]).catch(() => {});
    await query(`DELETE FROM vod_assets WHERE id = ANY($1)`, [[mine.id, theirs.id]]);
  }
  srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
