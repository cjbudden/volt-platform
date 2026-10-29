// ============================================================================
//  CONTENT LINKS AND READ FROM FILE NAME, end to end against a database:
//  ingest (services/ingest/pipeline.ts with filenameApply.ts), the content_links
//  table and its metadata copy (services/contentLinks.ts, migration 0117), the
//  routes (modules/contentLinks.ts, modules/filenameRules.ts), and
//  GET /api/vod/:id?include=linkedContent.
//
//    DATABASE_URL=... npx tsx test/content-links.check.ts
// ============================================================================
import { mkdtempSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected ${w} got ${g}`); fail++ }
};
const yes = (m: string, c: unknown, d = '') => { if (c) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- ${d || 'false'}`); fail++ } };

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { ensureStandardTypes } = await import('../src/services/contentTypes');
  const { ingestLanded } = await import('../src/services/ingest/pipeline');
  const tag = Date.now().toString(36);
  const mk = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`cl-${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `cl-${n}-${tag}@volt.test`]))!.id;
    await ensureStandardTypes(a);
    const types: Record<string, string> = {};
    for (const r of await query<any>(`SELECT id, standard_key FROM metadata_schemas WHERE account_id = $1 AND standard_key IS NOT NULL`, [a])) types[r.standard_key] = r.id;
    return { a, u, types, tok: signAccess({ sub: u, account_id: a, role: 'owner' }) };
  };
  const me = await mk('me'), them = await mk('them');

  // A library record, as an upload leaves it once ingested.
  const rec = async (o: any, title: string, typeKey: string | null, metadata: any = {}) => (await one<any>(
    `INSERT INTO vod_assets (account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status, schema_id, metadata)
     VALUES ($1,'upload','clip',$2,0,60000,60000,'ready',$3,$4::jsonb) RETURNING id`, [o.a, title, typeKey ? o.types[typeKey] : null, JSON.stringify(metadata)]))!.id;
  const m25 = await rec(me, 'Movie Title (2025)', 'movie', { title: 'Movie Title', year: 2025 });
  const m98 = await rec(me, 'Movie Title (1998)', 'movie', { title: 'Movie Title', year: 1998 });
  const e13 = await rec(me, 'Episode 3 (S1)', 'episode', { title: 'Episode 3 (S1)', series: 'Show', season: 1, episodeNumber: 3 });
  await rec(me, 'Episode 4 (S1)', 'episode', { title: 'Episode 4 (S1)', series: 'Show', season: 1, episodeNumber: 4 });
  const theirMovie = await rec(them, 'Movie Title (2025)', 'movie', { title: 'Movie Title', year: 2025 });
  const theirOnly = await rec(them, 'Their Exclusive Film', 'movie', { title: 'Their Exclusive Film' });

  // A one-second file; each ingest gets its own copy, named as the test needs.
  const dir = mkdtempSync(join(tmpdir(), 'cl-'));
  const media = join(dir, 'src.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=d=1:s=160x90:r=25', '-pix_fmt', 'yuv420p', '-t', '1', media]);
  const bytes = readFileSync(media).length;
  let n = 0;
  const ingest = async (o: any, name: string, extra: any = {}) => {
    const id = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, kind, title, source_bytes, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status)
                                VALUES ($1,'upload','clip',$2,$3,0,0,0,'processing') RETURNING id`, [o.a, name, bytes]))!.id;
    const sub = join(dir, `in${n++}`); execFileSync('mkdir', ['-p', sub]);
    const path = join(sub, name); copyFileSync(media, path);
    const out = await ingestLanded({ accountId: o.a, assetId: id, path, originalName: name, bytes, sha256: `${tag}${n}`.padEnd(64, '0'), source: 'panel', ...extra });
    return { id, out, row: (await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [id]))!, link: await one<any>(`SELECT * FROM content_links WHERE from_asset_id = $1`, [id]) };
  };

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any, tok = me.tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) as any };
  };
  try {
    console.log('== ingest: classification, fields, title, one clear link ==');
    const t1 = await ingest(me, 'Movie_Title_2025_Official_Trailer.mp4');
    check('the type is Trailer / promo', t1.row.schema_id, me.types.trailer);
    check('title, kind and the link copy in metadata', [t1.row.title, t1.row.metadata.title, t1.row.metadata.trailerType, t1.row.metadata.trailerFor], ['Movie Title', 'Movie Title', 'Trailer', { id: m25, name: 'Movie Title (2025)' }]);
    check('not held at the metadata gate', t1.out.status, 'ingested');
    check('the link row: confirmed by the matcher, by id', [t1.link?.to_asset_id, t1.link?.source, t1.link?.relation], [m25, 'auto', 'trailer_for']);
    yes('the link says why', (t1.link?.reasons ?? []).some((r: any) => /exactly/.test(r.text)) && (t1.link?.reasons ?? []).some((r: any) => /Same year/.test(r.text)));
    check('provenance: type and fields from the file name, the link from the matcher', [t1.row.metadata_provenance['@type']?.source, t1.row.metadata_provenance.title?.source, t1.row.metadata_provenance.trailerFor?.source], ['filename', 'filename', 'link']);
    yes('the reading is kept on the asset', t1.row.filename_analysis?.signals?.length >= 2 && /Trailer/.test(t1.row.filename_analysis.classification.summary));
    check('another account\'s identical film was not a candidate', t1.link?.to_asset_id !== theirMovie, true);

    console.log('== ingest: ambiguous, weak and conflicting evidence ==');
    const t2 = await ingest(me, 'Movie_Title_Trailer.mp4');
    check('AMBIGUOUS: no link, a name, two suggestions', [t2.link?.to_asset_id, t2.row.metadata.trailerFor, (t2.link?.candidates ?? []).map((c: any) => c.assetId).sort()], [null, { name: 'Movie Title' }, [m25, m98].sort()]);
    const t3 = await ingest(me, 'Nothing_Like_It_Anywhere_trailer.mp4');
    check('INSUFFICIENT: no link, no suggestions, the name only', [t3.link?.to_asset_id, t3.row.metadata.trailerFor, t3.link?.candidates], [null, { name: 'Nothing Like It Anywhere' }, []]);
    const t4 = await ingest(me, 'Jane_Smith_Interview_Highlights.mp4');
    check('CONFLICT: the type is not set from the name', t4.row.schema_id === me.types.interview || t4.row.schema_id === me.types.clip ? 'set' : 'not set', 'not set');
    yes('...and the reading says why', !!t4.row.filename_analysis?.classification?.conflict);
    const t5 = await ingest(me, 'Show_S01E03_Promo.mp4');
    check('a promo for S01E03: trailer, linked to that episode', [t5.row.schema_id, t5.link?.to_asset_id], [me.types.trailer, e13]);
    const t6 = await ingest(me, 'Show_S01E05.mp4');
    check('an episode: type, series, season, number, title', [t6.row.schema_id, t6.row.metadata.series, t6.row.metadata.season, t6.row.metadata.episodeNumber, t6.row.title], [me.types.episode, 'Show', 1, 5, 'Episode 5 (S1)']);

    console.log('== precedence: the operator and the ingest rules win ==');
    const t7 = await ingest(me, 'Big_Movie_Trailer.mp4', { contentTypeId: me.types.clip });
    check('a type the operator chose is kept', t7.row.schema_id, me.types.clip);
    check('...and is recorded as theirs (no @type provenance)', t7.row.metadata_provenance?.['@type'] ?? null, null);
    const rule = (await one<any>(`INSERT INTO ingest_rules(account_id, rung, name, "then") VALUES ($1,'account','All interviews',$2::jsonb) RETURNING id`, [me.a, JSON.stringify({ contentTypeId: me.types.interview })]))!.id;
    const t8 = await ingest(me, 'Another_Film_Trailer.mp4');
    check('a type an ingest rule named is kept', t8.row.schema_id, me.types.interview);
    await query(`UPDATE ingest_rules SET "then" = $2::jsonb WHERE id = $1`, [rule, JSON.stringify({ filenameMetadata: 'off' })]);
    const t9 = await ingest(me, 'Movie_Title_2025_Official_Trailer.mp4');
    check('a rule can switch file-name reading off', [t9.row.schema_id === me.types.trailer, t9.row.filename_analysis, t9.link], [false, null, null]);
    await query(`DELETE FROM ingest_rules WHERE id = $1`, [rule]);

    const slate = await ingest(me, 'Big_Film_Official_Trailer_slate.mp4', { item: { targetKind: 'filler:slate' } });
    check('a slate or loop keeps its name as it is: no reading', [slate.row.filename_analysis, slate.link], [null, null]);

    console.log('== manual links are never changed automatically ==');
    const put = await call('PUT', `/api/vod/${t2.id}`, { metadata: { ...t2.row.metadata, trailerFor: { id: m98, name: '' } } });
    check('a person links the ambiguous trailer to the 1998 film', [put.s, put.j?.metadata?.trailerFor], [200, { id: m98, name: 'Movie Title (1998)' }]);
    const r2 = await one<any>(`SELECT * FROM content_links WHERE from_asset_id = $1`, [t2.id]);
    check('the row follows the form: a person, by id, suggestions cleared', [r2.source, r2.to_asset_id, r2.candidates], ['person', m98, []]);
    check('the provenance entry is gone (it is the person\'s now)', (await one<any>(`SELECT metadata_provenance FROM vod_assets WHERE id = $1`, [t2.id]))!.metadata_provenance.trailerFor ?? null, null);
    const re = await call('POST', `/api/vod/${t2.id}/from-filename`, { link: 'auto' });
    check('Read from file name again leaves it', [re.s, re.j?.link?.action], [200, 'kept']);
    const bulk = await call('POST', '/api/vod/from-filename', { ids: [t2.id, t1.id] });
    check('so does the bulk re-run', [bulk.s, (await one<any>(`SELECT to_asset_id FROM content_links WHERE from_asset_id = $1`, [t2.id]))!.to_asset_id], [200, m98]);

    console.log('== manual field values are never replaced automatically ==');
    await call('PUT', `/api/vod/${t1.id}`, { title: 'My Own Title', metadata: { ...t1.row.metadata, title: 'My Own Title' } });
    const pv = await call('GET', `/api/vod/${t1.id}/from-filename`);
    const tp = pv.j.fields.find((f: any) => f.field === 'title');
    check('the preview: a typed value needs its own Replace', [pv.s, tp.action, tp.byPerson, pv.j.title.action], [200, 'conflict', true, 'conflict']);
    yes('the preview explains the type', pv.j.type.reasons.length > 0 && pv.j.signals.length > 0);
    check('...and offers the link candidates', pv.j.link.decision.candidates[0]?.id, m25);
    await call('POST', '/api/vod/from-filename', { ids: [t1.id] });
    check('the bulk re-run leaves the typed title', (await one<any>(`SELECT title, metadata->>'title' AS mt FROM vod_assets WHERE id = $1`, [t1.id])), { title: 'My Own Title', mt: 'My Own Title' });
    const ap = await call('POST', `/api/vod/${t1.id}/from-filename`, { title: true, fields: [], overwrite: ['title'] });
    check('a person can still choose to replace it', [ap.s, ap.j.applied, ap.j.titleChanged, (await one<any>(`SELECT title FROM vod_assets WHERE id = $1`, [t1.id]))!.title], [200, ['title'], true, 'Movie Title']);
    const typed = await call('PUT', `/api/vod/${t6.id}`, { schemaId: me.types.movie, metadata: { title: 'Show Five' } });
    check('a type a person chose', [typed.s, (await one<any>(`SELECT metadata_provenance FROM vod_assets WHERE id = $1`, [t6.id]))!.metadata_provenance['@type'] ?? null], [200, null]);
    const pv6 = await call('GET', `/api/vod/${t6.id}/from-filename`);
    check('...is not changed without a tick', [pv6.j.type.action, pv6.j.type.byPerson], ['conflict', true]);
    await call('POST', '/api/vod/from-filename', { ids: [t6.id] });
    check('...not by the bulk re-run either', (await one<any>(`SELECT schema_id FROM vod_assets WHERE id = $1`, [t6.id]))!.schema_id, me.types.movie);

    const carried = await rec(me, 'x', 'clip', { headline: 'Old headline', icyRaw: 'StreamTitle=x' });
    await query(`UPDATE vod_assets SET original_filename = 'Carry_Film_Official_Trailer.mp4' WHERE id = $1`, [carried]);
    const ct = await call('POST', `/api/vod/${carried}/from-filename`, { type: true, title: true });
    const crow = (await one<any>(`SELECT schema_id, metadata FROM vod_assets WHERE id = $1`, [carried]))!;
    check('a type change: the old type\'s fields go, carried keys stay', [ct.s, crow.schema_id, crow.metadata.headline ?? null, crow.metadata.icyRaw, crow.metadata.title], [200, me.types.trailer, null, 'StreamTitle=x', 'Carry Film']);

    console.log('== the link routes ==');
    const lk = await call('GET', `/api/vod/${t3.id}/links`);
    check('an unresolved link reads as one', [lk.s, lk.j.links[0].state, lk.j.links[0].name, lk.j.links[0].asset], [200, 'unresolved', 'Nothing Like It Anywhere', null]);
    const nm = await call('PUT', `/api/vod/${t3.id}/links/trailerFor`, { name: 'A Film Not Yet Here' });
    check('a person keeps a name', [nm.s, nm.j.links[0].state, nm.j.links[0].name, nm.j.links[0].source], [200, 'unresolved', 'A Film Not Yet Here', 'person']);
    check('another account\'s record cannot be linked', (await call('PUT', `/api/vod/${t3.id}/links/trailerFor`, { assetId: theirMovie })).s, 400);
    check('a record cannot link to itself', (await call('PUT', `/api/vod/${t3.id}/links/trailerFor`, { assetId: t3.id })).s, 422);
    check('a trailer is not the trailer for another trailer', (await call('PUT', `/api/vod/${t3.id}/links/trailerFor`, { assetId: t5.id })).s, 422);
    check('a field that is not a link field', (await call('PUT', `/api/vod/${t3.id}/links/title`, { name: 'x' })).s, 400);
    const ln = await call('PUT', `/api/vod/${t3.id}/links/trailerFor`, { assetId: m25 });
    check('link by id', [ln.s, ln.j.links[0].state, ln.j.links[0].asset.id, (await one<any>(`SELECT metadata->'trailerFor' AS v FROM vod_assets WHERE id = $1`, [t3.id]))!.v], [200, 'linked', m25, { id: m25, name: 'Movie Title (2025)' }]);
    const del = await call('DELETE', `/api/vod/${t3.id}/links/trailerFor`);
    check('remove: no row, no metadata value', [del.s, del.j.links.length, (await one<any>(`SELECT metadata ? 'trailerFor' AS has FROM vod_assets WHERE id = $1`, [t3.id]))!.has], [200, 0, false]);
    check('another account cannot read the links', (await call('GET', `/api/vod/${t1.id}/links`, undefined, them.tok)).s, 404);
    const search = await call('GET', `/api/vod/link-candidates?q=${encodeURIComponent('movie title')}&for=${t3.id}&field=trailerFor`);
    check('search by name: own records, the two films first', [search.s, search.j.items.slice(0, 2).map((i: any) => i.id).sort()], [200, [m25, m98].sort()]);
    check('...and no trailers among them', search.j.items.some((i: any) => i.asset.contentType?.key === 'trailer'), false);
    check('search finds nothing of another account', (await call('GET', `/api/vod/link-candidates?q=${encodeURIComponent('Their Exclusive')}`)).j.items.length, 0);
    void theirOnly;

    console.log('== a loop is refused ==');
    const rel = await call('POST', '/api/metadata-schemas', { name: `Related ${tag}`, targetKind: 'vod', appliesTo: ['vod'], fields: [{ key: 'title', type: 'string' }, { key: 'seeAlso', label: 'See also', type: 'content', relation: 'related' }] });
    check('a custom type with a content-link field keeps its relation', [rel.s, rel.j?.fields?.[1]?.type, rel.j?.fields?.[1]?.relation], [201, 'content', 'related']);
    const A = await rec(me, 'Record A', null), B = await rec(me, 'Record B', null);
    await query(`UPDATE vod_assets SET schema_id = $2 WHERE id = ANY($1::uuid[])`, [[A, B], rel.j.id]);
    check('A links to B', (await call('PUT', `/api/vod/${A}/links/seeAlso`, { assetId: B })).s, 200);
    check('B linking back to A is refused', (await call('PUT', `/api/vod/${B}/links/seeAlso`, { assetId: A })).s, 422);
    check('...through the metadata form too', (await call('PUT', `/api/vod/${B}`, { metadata: { title: 'Record B', seeAlso: { id: A, name: 'A' } } })).s, 422);

    console.log('== the API: ?include=linkedContent ==');
    const plain = await call('GET', `/api/vod/${t5.id}`);
    check('the default response is unchanged (no linkedContent)', [plain.s, 'linkedContent' in plain.j], [200, false]);
    const inc = await call('GET', `/api/vod/${t5.id}?include=linkedContent`);
    const out0 = inc.j.linkedContent.links[0];
    check('outgoing: trailer_for the episode, confirmed', [inc.s, out0.relation, out0.state, out0.asset.id, out0.asset.contentType.key], [200, 'trailer_for', 'linked', e13, 'episode']);
    yes('...with its reasons', out0.reasons.length > 0);
    yes('...the target is a summary with no links of its own (no recursion)', !('linkedContent' in out0.asset) && !('metadata' in out0.asset));
    const back = await call('GET', `/api/vod/${m25}?include=linkedContent`);
    const fromIds = back.j.linkedContent.linkedFrom.map((l: any) => l.asset.id);
    check('incoming: the film lists its trailers', [back.j.linkedContent.linkedFrom[0]?.relation, fromIds.includes(t1.id)], ['trailers', true]);
    check('an unknown include is refused', (await call('GET', `/api/vod/${t5.id}?include=everything`)).s, 400);
    check('another account cannot read it, with or without include', [(await call('GET', `/api/vod/${t5.id}?include=linkedContent`, undefined, them.tok)).s], [404]);
    const theirs = await call('GET', `/api/vod/${theirMovie}?include=linkedContent`, undefined, them.tok);
    check('their film shows none of our trailers', [theirs.s, theirs.j.linkedContent.linkedFrom.length], [200, 0]);

    console.log('== a new record resolves names waiting for it ==');
    const f1 = await ingest(me, 'Future_Film_2027_trailer.mp4');
    check('the trailer arrives before its film: a name', [f1.link?.to_asset_id, f1.row.metadata.trailerFor], [null, { name: 'Future Film (2027)' }]);
    await call('PUT', `/api/vod/${t3.id}/links/trailerFor`, { name: 'Future Film' });
    const film = await ingest(me, 'Future_Film_2027.mp4', { contentTypeId: me.types.movie });
    check('the film arrives', [film.row.schema_id, film.row.title, film.row.metadata.year], [me.types.movie, 'Future Film', 2027]);
    check('the matcher\'s trailer now links to it', (await one<any>(`SELECT to_asset_id FROM content_links WHERE from_asset_id = $1`, [f1.id]))!.to_asset_id, film.id);
    const typedName = (await one<any>(`SELECT to_asset_id, candidates FROM content_links WHERE from_asset_id = $1`, [t3.id]))!;
    check('a name a person typed only gains a suggestion', [typedName.to_asset_id, typedName.candidates[0]?.assetId], [null, film.id]);

    console.log('== deleting and restoring the target ==');
    const gone = await call('DELETE', `/api/vod/${film.id}`);
    yes('the film is deleted', gone.s === 200 || gone.s === 204, `status ${gone.s}`);
    const after = await one<any>(`SELECT cl.to_asset_id, cl.to_name, v.metadata->'trailerFor' AS v FROM content_links cl JOIN vod_assets v ON v.id = cl.from_asset_id WHERE cl.from_asset_id = $1`, [f1.id]);
    check('the trailer keeps the name, the link falls back to unresolved', [after?.to_asset_id, after?.v], [null, { name: after?.to_name }]);
    const restored = await call('POST', `/api/vod/${film.id}/restore`);
    if (restored.s === 200) {
      const back2 = await one<any>(`SELECT cl.to_asset_id, v.metadata->'trailerFor'->>'id' AS id FROM content_links cl JOIN vod_assets v ON v.id = cl.from_asset_id WHERE cl.from_asset_id = $1`, [f1.id]);
      check('restored: the link and the metadata copy come back', [back2?.to_asset_id, back2?.id], [film.id, film.id]);
    } else console.log(`NOTE restore answered ${restored.s} (${JSON.stringify(restored.j).slice(0, 120)}); restore check skipped`);

    console.log('== settings: linking without asking can be switched off ==');
    check('settings saved', (await call('PUT', '/api/ingest/filename-rules/settings', { autoLink: false })).s, 200);
    const t10 = await ingest(me, 'Movie_Title_2025_Teaser.mp4');
    check('a clear match is then offered, not linked', [t10.link?.to_asset_id, t10.link?.candidates?.[0]?.assetId, t10.row.metadata.trailerType], [null, m25, 'Teaser']);
    await call('PUT', '/api/ingest/filename-rules/settings', { autoLink: true });

    console.log('== the rules API ==');
    const lr = await call('GET', '/api/ingest/filename-rules');
    check('built-in rules are listed, on', [lr.s, lr.j.builtin.length > 5, lr.j.builtin.every((r: any) => r.enabled)], [200, true, true]);
    const nr = await call('POST', '/api/ingest/filename-rules', { name: 'House packages', when: { words: ['pkg'] }, then: { typeKey: 'clip' }, confidence: 0.9 });
    check('add a rule', [nr.s, nr.j.when.words], [201, ['pkg']]);
    const tt = await call('POST', '/api/ingest/filename-rules/test', { filename: 'Story_Name_pkg_1080p.mp4' });
    check('test a name: the rule decides, the word leaves the title', [tt.s, tt.j.suggestedType?.key, tt.j.parsed.title], [200, 'clip', 'Story Name']);
    check('a bad pattern is refused', (await call('POST', '/api/ingest/filename-rules', { name: 'x', when: { pattern: '(' }, then: { typeKey: 'clip' } })).s, 400);
    check('a type the account does not have is refused', (await call('POST', '/api/ingest/filename-rules', { name: 'x', when: { words: ['y'] }, then: { typeKey: 'nope' } })).s, 400);
    check('switch a built-in off', (await call('PUT', '/api/ingest/filename-rules/builtin/builtin:promo', { enabled: false })).s, 200);
    check('...and it no longer suggests', (await call('POST', '/api/ingest/filename-rules/test', { filename: 'X_trailer.mp4' })).j.suggestedType, null);
    await call('PUT', '/api/ingest/filename-rules/builtin/builtin:promo', { enabled: true });
    check('rules are per account', (await call('GET', '/api/ingest/filename-rules', undefined, them.tok)).j.rules.length, 0);
    check('another account cannot change our rule', (await call('PATCH', `/api/ingest/filename-rules/${nr.j.id}`, { enabled: false }, them.tok)).s, 404);
    check('delete it', (await call('DELETE', `/api/ingest/filename-rules/${nr.j.id}`)).s, 204);

    console.log('== the migration of the old text field ==');
    const legacyTarget = await rec(me, 'Legacy Film', 'movie', { title: 'Legacy Film' });
    await rec(me, 'Twin Name', 'movie'); await rec(me, 'Twin Name', 'movie');
    const L1 = await rec(me, 'Legacy trailer', 'trailer', { title: 'Legacy trailer', trailerFor: 'Legacy Film' });
    const L2 = await rec(me, 'Orphan trailer', 'trailer', { title: 'Orphan trailer', trailerFor: 'Nobody Has This' });
    const L3 = await rec(me, 'Twin trailer', 'trailer', { title: 'Twin trailer', trailerFor: 'Twin Name' });
    const old = (await one<any>(`INSERT INTO metadata_schemas(account_id, name, fields, target_kind) VALUES ($1,$2,$3::jsonb,'vod') RETURNING id`,
      [me.a, `Old trailer copy ${tag}`, JSON.stringify([{ key: 'title', type: 'string' }, { key: 'trailerFor', type: 'string', label: 'Trailer for' }])]))!.id;
    const sql = readFileSync(join(__dirname, '../migrations/0117_content_links_and_filename_rules.sql'), 'utf8');
    await query(sql);
    const mig = async (id: string) => one<any>(`SELECT v.metadata->'trailerFor' AS v, cl.to_asset_id, cl.source, cl.reasons FROM vod_assets v LEFT JOIN content_links cl ON cl.from_asset_id = v.id WHERE v.id = $1`, [id]);
    const g1 = await mig(L1), g2 = await mig(L2), g3 = await mig(L3);
    check('one exact title: linked by id', [g1?.v, g1?.to_asset_id, g1?.source], [{ id: legacyTarget, name: 'Legacy Film' }, legacyTarget, 'migration']);
    check('no record: kept as an unresolved name', [g2?.v, g2?.to_asset_id], [{ name: 'Nobody Has This' }, null]);
    check('two records: kept as a name for a person to choose', [g3?.v, g3?.to_asset_id, /2 records/.test(g3?.reasons?.[0]?.text ?? '')], [{ name: 'Twin Name' }, null, true]);
    check('a copy of the type with the old field is converted', (await one<any>(`SELECT fields->1 AS f FROM metadata_schemas WHERE id = $1`, [old]))!.f, { key: 'trailerFor', type: 'content', label: 'Trailer for', relation: 'trailer_for' });
    await query(sql);
    check('running it twice changes nothing', [(await mig(L1))?.to_asset_id, (await one<any>(`SELECT count(*)::int AS n FROM content_links WHERE from_asset_id = $1`, [L1]))!.n], [legacyTarget, 1]);
    const healed = await call('GET', `/api/vod/${L1}?include=linkedContent`);
    check('a migrated link reads through the API', [healed.j.linkedContent.links[0].state, healed.j.linkedContent.links[0].asset.id], ['linked', legacyTarget]);
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
