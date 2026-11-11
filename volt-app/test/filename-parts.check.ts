// ============================================================================
//  THE FILE NAME IN PARTS, MAPPED BY HAND (Read from file name > Parts of the
//  name; services/ingest/filenameParse.ts splitParts and guessMapping,
//  filenameApply.ts parts in ApplyChoice).
//
//    - pure: the strongest separator splits (21_josh-woodward_saboteurs_1080p is
//      21 | Josh Woodward | Saboteurs | 1080p), a number and a recognised tag are
//      marked, weaker separators stay inside a part; the guess for a music type is
//      artist then title, and nothing for other types;
//    - through the API: the preview lists parts, targets and the guess; applying a
//      mapping writes the server's part values (never the browser's), replaces a
//      value, wins over the reading, records provenance; the asset title can be
//      mapped; a part or field that does not exist is refused; ingest never maps.
//
//  Usage: DATABASE_URL=... npx tsx test/filename-parts.check.ts
// ============================================================================
let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${JSON.stringify(d)}` : '')); } };

(async () => {
  const F = await import('../src/services/ingest/filenameParse');
  console.log('== parts (pure) ==');
  let p = F.splitParts('21_josh-woodward_saboteurs_1080p.mp4');
  ok(JSON.stringify(p.map((x) => x.value)) === JSON.stringify(['21', 'Josh Woodward', 'Saboteurs', '1080p']), 'underscores split; the dash stays inside the artist', p.map((x) => x.value));
  ok(p[0].number && !p[0].signal, 'the leading 21 is a number, nothing more', p[0]);
  ok(p[3].signal?.kind === 'resolution', '1080p is recognised as the resolution', p[3]);
  ok(!p[1].signal && !p[2].signal, 'artist and title are plain text');
  p = F.splitParts('Josh Woodward - Saboteurs (Official Video).mov');
  ok(p.length === 2 && p[0].value === 'Josh Woodward' && p[1].text === 'Saboteurs (Official Video)', 'a spaced dash is stronger than spaces', p.map((x) => x.text));
  p = F.splitParts('artist.name.song-title.mp3');
  ok(p.length === 3 && p[2].value === 'Song Title', 'dots split between words, a dash stays inside', p.map((x) => x.value));
  p = F.splitParts('Concert 5.1 mix.wav');
  ok(p.every((x) => x.text !== '5' && x.text !== '1'), 'a dot between digits does not split', p.map((x) => x.text));
  ok(F.splitParts('Saboteurs.mp4').length === 1, 'a one-word name is one part');
  ok(F.splitParts('MyBand_Track.mp3')[0].value === 'MyBand', 'a mixed-case part keeps its capitals');
  const parts = F.splitParts('21_josh-woodward_saboteurs_1080p.mp4');
  let g = F.guessMapping(parts, 'music-video', ['title', 'artist', 'album']);
  ok(g[1] === 'artist' && g[2] === 'title' && g[0] === undefined && g[3] === undefined, 'music video: artist then title, the number and the tag left alone', g);
  g = F.guessMapping(parts, 'song', ['title', 'artist']);
  ok(g[1] === 'artist' && g[2] === 'title', 'the same for a song');
  ok(Object.keys(F.guessMapping(parts, 'movie', ['title'])).length === 0, 'no guess for other types');
  ok(Object.keys(F.guessMapping(F.splitParts('saboteurs_1080p.mp4'), 'song', ['title', 'artist'])).length === 0, 'no guess with only one plain part');

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { ensureStandardTypes } = await import('../src/services/contentTypes');
  const tag = Date.now().toString(36);
  const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`fp-${tag}`]))!.id;
  const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `fp-${tag}@volt.test`]))!.id;
  await ensureStandardTypes(a);
  const types: Record<string, string> = {};
  for (const r of await query<any>(`SELECT id, standard_key FROM metadata_schemas WHERE account_id = $1 AND standard_key IS NOT NULL`, [a])) types[r.standard_key] = r.id;
  const tok = signAccess({ sub: u, account_id: a, role: 'owner' } as any);
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) as any };
  };
  const rec = async (file: string, typeKey: string | null, metadata: any = {}) => (await one<any>(
    `INSERT INTO vod_assets (account_id, source_kind, kind, title, original_filename, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status, schema_id, metadata)
     VALUES ($1,'upload','clip',$2,$2,0,60000,60000,'ready',$3,$4::jsonb) RETURNING id`, [a, file, typeKey ? types[typeKey] : null, JSON.stringify(metadata)]))!.id;

  console.log('== preview ==');
  const mv = await rec('21_josh-woodward_saboteurs_1080p.mp4', 'music-video', { artist: 'Someone Else' });
  let r = await call('GET', `/api/vod/${mv}/from-filename`);
  ok(r.s === 200 && r.j.parts?.length === 4 && r.j.parts[1].value === 'Josh Woodward', 'the preview lists the parts', r.j?.parts);
  ok(r.j.targets?.[0]?.field === '@title' && r.j.targets.some((t: any) => t.field === 'artist') && !r.j.targets.some((t: any) => t.field === 'image'), 'targets: the asset title and the text fields, no image', r.j?.targets?.map((t: any) => t.field));
  ok(r.j.guess?.['1'] === 'artist' && r.j.guess?.['2'] === 'title', 'the guess for a music video', r.j?.guess);

  console.log('== apply a mapping ==');
  r = await call('POST', `/api/vod/${mv}/from-filename`, { parts: [{ index: 1, field: 'artist' }, { index: 2, field: 'title' }, { index: 2, field: '@title' }, { index: 0, field: 'album' }] });
  const row = await one<any>(`SELECT title, metadata, metadata_provenance FROM vod_assets WHERE id = $1`, [mv]);
  ok(r.s === 200 && row.metadata.artist === 'Josh Woodward' && row.metadata.title === 'Saboteurs', 'artist and title written from the parts, replacing the old artist', { r: r.j, m: row.metadata });
  ok(row.title === 'Saboteurs', 'the asset title mapped too', row.title);
  ok(row.metadata.album === '21', 'any text field can take a part', row.metadata.album);
  ok(row.metadata_provenance.artist?.source === 'filename' && row.metadata_provenance.artist.mapped === true && /Part 2 of the file name, mapped by/.test(row.metadata_provenance.artist.reason) && row.metadata_provenance.artist.was === 'Someone Else',
    'provenance says which part, who mapped it and what it replaced', row.metadata_provenance.artist);
  r = await call('POST', `/api/vod/${mv}/from-filename`, { parts: [{ index: 9, field: 'artist' }] });
  ok(r.s === 400, 'a part that does not exist is refused', r);
  r = await call('POST', `/api/vod/${mv}/from-filename`, { parts: [{ index: 1, field: 'image' }] });
  ok(r.s === 400, 'a field a part cannot go into is refused', r);
  r = await call('POST', `/api/vod/${mv}/from-filename`, { parts: [{ index: 1, field: 'artist', value: 'Injected' }] });
  ok(r.s === 422 || r.s === 400, 'a value from the browser is not accepted', r.s);
  const two = await rec('the_chain_live_at_wembley.mp4', 'music-video');
  r = await call('POST', `/api/vod/${two}/from-filename`, { parts: [{ index: 0, field: 'title' }, { index: 1, field: 'title' }] });
  ok((await one<any>(`SELECT metadata FROM vod_assets WHERE id = $1`, [two])).metadata.title === 'The Chain', 'two parts to one field are joined in order');
  const named = await rec('7_fleetwood-mac_dreams.mp4', 'music-video');
  await call('POST', `/api/vod/${named}/from-filename`, { parts: [{ index: 1, field: 'artist' }, { index: 2, field: 'title' }] });
  ok((await one<any>(`SELECT title FROM vod_assets WHERE id = $1`, [named])).title === 'Dreams', 'a Title mapped by hand also names an asset still called by its file name');
  const kept = await rec('8_band_song.mp4', 'music-video');
  await query(`UPDATE vod_assets SET title = 'Named by a person' WHERE id = $1`, [kept]);
  await call('POST', `/api/vod/${kept}/from-filename`, { parts: [{ index: 2, field: 'title' }] });
  ok((await one<any>(`SELECT title FROM vod_assets WHERE id = $1`, [kept])).title === 'Named by a person', 'but never renames one a person named');
  const yr = await rec('ep_2019_x.mp4', 'movie');
  const pv = (await call('GET', `/api/vod/${yr}/from-filename`)).j;
  ok(Object.keys(pv.guess ?? {}).length === 0, 'a movie gets no guess');

  console.log('== ingest never maps ==');
  const { applyReading } = await import('../src/services/ingest/filenameApply');
  const safe = await rec('99_band_song.mp4', 'music-video');
  await applyReading(a, safe, { parts: [{ index: 1, field: 'artist' }] } as any, null, 'safe');
  ok(!(await one<any>(`SELECT metadata FROM vod_assets WHERE id = $1`, [safe])).metadata.artist, 'the safe (ingest, bulk) mode ignores a mapping');

  srv.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
