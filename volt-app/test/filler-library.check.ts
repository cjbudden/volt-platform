// ============================================================================
//  LOOPS & FILLERS IS THE ONE HOME FOR FALLBACKS (22 Oct 2026), against
//  Postgres and the real HTTP app: which streams use each asset, fallbacks
//  still held as Image Library addresses, the one-step copy that relinks every
//  stream using one (and nothing in another account), what the encoder is then
//  handed, tenancy on fillerAssetId for channels and events, and the delete
//  guard that replaced the silent ON DELETE SET NULL.
//
//  Usage: DATABASE_URL=... npx tsx test/filler-library.check.ts   (a migrated, disposable database)
// ============================================================================
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

(async () => {
  const { readFile } = await import('node:fs/promises');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { imageStore } = await import('../src/services/imageStore');
  const { fillerPath } = await import('../src/services/uploads');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`fill-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`fill-o-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `fill-${tag}@volt.test`]))!.id;
  const otherUser = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `fill-o-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type, codec_backend, packaging)
      VALUES ($1,'HD','[{"height":720,"bitrate_kbps":3000}]','transcode','x264','hls') RETURNING id`, [acct]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const og = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'OG') RETURNING id`, [other]))!.id;

  // An Image Library slate, with real bytes in the image store.
  const storeKey = `library/${acct}/slates/berita-${tag}.png`;
  const bytes = Buffer.from('89504e470d0a1a0a' + 'ab'.repeat(300), 'hex');
  await imageStore().put(storeKey, bytes, 'image/png');
  const mf = (await one<any>(`INSERT INTO media_files(account_id, kind, path, folder, name, content_type, size_bytes, width, height, store_key)
      VALUES ($1,'slate',$2,'slates','Berita slate','image/png',$3,1920,1080,$4) RETURNING id`, [acct, `slates/berita-${tag}.png`, bytes.length, storeKey]))!.id;
  const ref = '/' + storeKey;

  const chan = async (name: string, o: Record<string, any> = {}) => (await one<any>(
    `INSERT INTO channels(group_id, name, kind, input_failover_enabled, input_loss_behavior, filler_slate_ref)
     VALUES ($1,$2,$3,true,$4,$5) RETURNING id`, [o.group ?? g, name, o.kind ?? 'tv', o.loss ?? 'slate', o.ref ?? null]))!.id;
  const C1 = await chan('Berita HD', { ref });
  const R1 = await chan('Berita FM', { ref, kind: 'radio', loss: 'vod_loop' });
  const C2 = await chan('Pasted URL TV', { ref: 'https://cdn.example/slate.jpg' });
  const C3 = await chan('No fallback', { ref, loss: 'black' });             // ref present but not used: not listed
  const OC = await chan('Other account TV', { ref, group: og });            // same string, another account
  const E1 = (await one<any>(`INSERT INTO events(group_id, name, scheduled_start, scheduled_end, input_loss_behavior, filler_slate_ref)
      VALUES ($1,'Cup Final',now(),now() + interval '2 hours','slate',$2) RETURNING id`, [g, ref]))!.id;

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' } as any);
  const tokOther = signAccess({ sub: otherUser, account_id: other, role: 'owner' } as any);
  const api = async (method: string, path: string, body?: any, token = tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    return { status: r.status, j };
  };
  const rows = (j: any) => (Array.isArray(j) ? j : j?.member ?? j?.items ?? []);

  try {
    console.log('== fallbacks not in Loops & Fillers yet ==');
    let el = await api('GET', '/api/filler-assets/elsewhere');
    ok(el.status === 200, 'elsewhere answers 200', String(el.status));
    const lib = el.j.items.find((i: any) => i.ref === ref);
    ok(!!lib && lib.canCopy && lib.libraryFile?.id === mf, 'the library slate is listed and copyable');
    ok(lib && lib.usedBy.map((u: any) => u.id).sort().join() === [C1, R1, E1].sort().join(), 'used by the channel, the station and the event, and not by the stream whose behaviour ignores it',
      JSON.stringify(lib?.usedBy));
    ok(lib && lib.usedBy.find((u: any) => u.id === R1)?.kind === 'radio' && lib.usedBy.find((u: any) => u.id === R1)?.href === `/radio/${R1}`, 'a station is named and linked as a station');
    const url = el.j.items.find((i: any) => i.ref === 'https://cdn.example/slate.jpg');
    ok(!!url && url.canCopy === false, 'a pasted URL is listed but not copyable');
    ok(!el.j.items.some((i: any) => i.usedBy.some((u: any) => u.id === OC)), 'another account\'s stream is never listed');

    console.log('== copy into Loops & Fillers ==');
    ok((await api('POST', '/api/filler-assets/copy-from-library', { ref }, tokOther)).status === 404, 'another account cannot copy this account\'s library file');
    ok((await api('POST', '/api/filler-assets/copy-from-library', { ref: '/library/nope.png' })).status === 404, 'an address that is not a library file is refused');
    const cp = await api('POST', '/api/filler-assets/copy-from-library', { ref });
    ok(cp.status === 201, 'copy answers 201', JSON.stringify(cp.j));
    const A = cp.j.asset;
    ok(A.kind === 'slate' && A.status === 'ready' && A.width === 1920 && A.name === 'Berita slate', 'a ready slate with the library name and size');
    ok(A.source_key === `filler/${acct}/${A.id}.png`, 'stored under the filler key', A.source_key);
    const disk = await readFile(fillerPath(acct, A.id, `berita-${tag}.png`));
    ok(disk.equals(bytes) && Number(A.bytes) === bytes.length, 'the bytes are an exact copy');
    ok(cp.j.relinked.map((u: any) => u.id).sort().join() === [C1, R1, E1, C3].sort().join(), 'every stream on that address moved over, including the one not using it today',
      JSON.stringify(cp.j.relinked));
    const c1 = await one<any>(`SELECT filler_asset_id, filler_slate_ref FROM channels WHERE id=$1`, [C1]);
    ok(c1.filler_asset_id === A.id && c1.filler_slate_ref === null, 'the channel now points at the asset, not the address');
    ok((await one<any>(`SELECT filler_asset_id FROM events WHERE id=$1`, [E1])).filler_asset_id === A.id, 'so does the event');
    const oc = await one<any>(`SELECT filler_asset_id, filler_slate_ref FROM channels WHERE id=$1`, [OC]);
    ok(oc.filler_asset_id === null && oc.filler_slate_ref === ref, 'the other account\'s channel is untouched');
    ok(!!(await one<any>(`SELECT 1 FROM media_files WHERE id=$1`, [mf])), 'the library image is left where it was');
    ok(!!(await one<any>(`SELECT 1 FROM audit_log WHERE entity_type='filler_asset' AND entity_id=$1`, [A.id])), 'the copy is audit-logged');
    el = await api('GET', '/api/filler-assets/elsewhere');
    ok(!el.j.items.some((i: any) => i.ref === ref) && el.j.items.length === 1, 'only the pasted URL is left on the list');

    console.log('== what the encoder is handed ==');
    const { orchestrator } = await import('../src/services/orchestrator');
    const ctx: any = await orchestrator.loadContext('channel', C1);
    ok(ctx?.owner?.filler_ref === A.source_key, 'the channel\'s fallback resolves to the copied file', ctx?.owner?.filler_ref);

    console.log('== used by ==');
    const list = await api('GET', '/api/filler-assets');
    const la = rows(list.j).find((r: any) => r.id === A.id);
    ok(la && la.used_by.length === 4, 'the list says who uses each asset', JSON.stringify(la?.used_by));
    ok((await api('GET', `/api/filler-assets/${A.id}`)).j.used_by.length === 4, 'so does the single item');
    ok(rows((await api('GET', '/api/filler-assets', undefined, tokOther)).j).every((r: any) => r.id !== A.id), 'another account does not see it');

    console.log('== fillerAssetId is checked on channels and events ==');
    const theirs = (await one<any>(`INSERT INTO filler_assets(account_id, kind, name, status, source_key) VALUES ($1,'slate','Theirs','ready','filler/x/y.png') RETURNING id`, [other]))!.id;
    const half = (await one<any>(`INSERT INTO filler_assets(account_id, kind, name, status) VALUES ($1,'loop','Half uploaded','uploading') RETURNING id`, [acct]))!.id;
    let r = await api('PATCH', `/api/channels/${C2}`, { fillerAssetId: theirs });
    ok(r.status === 404, 'a channel cannot point at another account\'s asset', `${r.status} ${JSON.stringify(r.j)}`);
    r = await api('PATCH', `/api/channels/${C2}`, { fillerAssetId: half });
    ok(r.status === 409, 'nor at one still uploading', String(r.status));
    r = await api('PATCH', `/api/channels/${C2}`, { fillerAssetId: A.id, fillerSlateRef: null });
    ok(r.status === 200 && (await one<any>(`SELECT filler_asset_id FROM channels WHERE id=$1`, [C2])).filler_asset_id === A.id, 'its own ready asset is accepted', `${r.status} ${JSON.stringify(r.j)}`);
    const ev = await one<any>(`SELECT version FROM events WHERE id=$1`, [E1]);
    r = await api('PATCH', `/api/events/${E1}`, { fillerAssetId: theirs, version: ev.version });
    ok(r.status === 404, 'an event cannot point at another account\'s asset', `${r.status} ${JSON.stringify(r.j)}`);
    r = await api('PATCH', `/api/events/${E1}`, { fillerAssetId: null, version: ev.version });
    ok(r.status === 200 && (await one<any>(`SELECT filler_asset_id FROM events WHERE id=$1`, [E1])).filler_asset_id === null, 'an event\'s fallback can be cleared', `${r.status} ${JSON.stringify(r.j)}`);

    console.log('== deleting an asset in use ==');
    r = await api('DELETE', `/api/filler-assets/${A.id}`);
    ok(r.status === 409 && r.j.inUseBy?.length === 4 && /Berita HD/.test(r.j.message), 'refused while in use, naming the streams', `${r.status} ${JSON.stringify(r.j)}`);
    ok(!!(await one<any>(`SELECT 1 FROM filler_assets WHERE id=$1`, [A.id])), 'and nothing was deleted');
    r = await api('DELETE', `/api/filler-assets/${A.id}?force=true`);
    ok(r.status === 204, 'force deletes it', String(r.status));
    ok((await one<any>(`SELECT filler_asset_id FROM channels WHERE id=$1`, [C1])).filler_asset_id === null, 'and the link is cleared, as before');
    r = await api('DELETE', `/api/filler-assets/${half}`);
    ok(r.status === 204, 'an unused asset deletes without force', String(r.status));
  } catch (e: any) {
    fail++; console.log('FAIL threw: ' + (e?.stack ?? e));
  } finally {
    srv.close(); await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
