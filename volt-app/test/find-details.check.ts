// ============================================================================
//  FIND DETAILS (build queue F1): services/media/finders.ts,
//  services/media/wikidataLookup.ts, modules/vodDetails.ts, and the song
//  finder for Music videos (modules/vodImage.ts).
//
//  Pure: which finder a type uses, the default search term, Wikidata times,
//  values mapped onto fields by schema.org name and shaped to each field type.
//  Postgres + HTTP, with a fake Wikidata and a fake MusicBrainz:
//    a Movie gets the general finder with its title as the term; results are
//    mapped by schema.org name, the likely kind first; nothing is saved by a
//    search; only the ticked values are written, with provenance; bad values,
//    unknown fields, another account and Wikidata being down; a type an
//    account built (no standard key) gets the general finder through its
//    schema.org names; a Song is refused by the general finder; a Music video
//    uses the song service, keeps its type and its picture, empty fields only.
//  Usage: npx tsx test/find-details.check.ts
// ============================================================================
import { createServer as httpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
const eq = (got: unknown, want: unknown, m: string) => ok(JSON.stringify(got) === JSON.stringify(want), m, `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);

const tmp = mkdtempSync(join(tmpdir(), 'find-details-'));
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=orange:s=320x320:d=1', '-frames:v', '1', join(tmp, 'poster.jpg')]);
const POSTER = readFileSync(join(tmp, 'poster.jpg'));

// ---- a fake Wikidata (formatversion 2) and MusicBrainz -------------------------
const ent = (id: string, label: string, description: string | null, claims: Record<string, any[]>) => ({
  id, labels: { en: { language: 'en', value: label } }, descriptions: description ? { en: { language: 'en', value: description } } : {},
  claims: Object.fromEntries(Object.entries(claims).map(([p, vs]) => [p, vs.map((v: any) => ({ rank: v?.rank ?? 'normal', mainsnak: { snaktype: 'value', datavalue: { value: v?.rank ? v.v : v } } }))])),
});
const E = (id: string) => ({ id });
const T = (time: string, precision = 11) => ({ time, precision });
const ENTITIES: Record<string, any> = {
  Q1: ent('Q1', 'Alien', 'video game', { P31: [E('Q7889')], P577: [T('+1984-00-00T00:00:00Z', 9)] }),
  Q103569: ent('Q103569', 'Alien', '1979 film by Ridley Scott', {
    P31: [E('Q11424')], P57: [E('Q56005')], P161: [E('Q102642'), E('Q207596')], P136: [E('Q200092'), E('Q130232')],
    P577: [T('+1979-05-25T00:00:00Z'), T('+1979-09-06T00:00:00Z')], P364: [E('Q1860')], P18: ['Alien movie poster.jpg'],
    P856: ['https://www.example.org/alien'], P2047: [{ amount: '+117', unit: 'http://www.wikidata.org/entity/Q7727' }],
    P921: [{ rank: 'deprecated', v: E('Q999') }],
  }),
  Q55: ent('Q55', 'Harbour Lights', 'documentary', { P31: [E('Q93204')], P577: [T('+2004-03-00T00:00:00Z', 10)], P136: [E('Q130232')] }),
};
const NAMES: Record<string, string> = { Q7889: 'video game', Q11424: 'film', Q93204: 'documentary film', Q56005: 'Ridley Scott', Q102642: 'Sigourney Weaver',
  Q207596: 'Tom Skerritt', Q200092: 'horror film', Q130232: 'drama film', Q1860: 'English', Q999: 'never shown' };
const asked: string[] = [];
let down = false, busy = false;
const srv0 = httpServer((q, r) => {
  const u = new URL(q.url!, 'http://x');
  r.setHeader('content-type', 'application/json');
  if (u.pathname === '/w/api.php') {
    asked.push(`${u.searchParams.get('action')}:${u.searchParams.get('search') ?? u.searchParams.get('ids')}`);
    if (down) { r.statusCode = 503; return r.end('{}'); }
    if (busy) { r.statusCode = 429; return r.end('You are making too many requests to the API.'); }
    const ua = String(q.headers['user-agent'] ?? '');
    if (!/VoltStream/.test(ua)) { r.statusCode = 403; return r.end('{}'); }
    if (u.searchParams.get('action') === 'wbsearchentities') {
      const s = u.searchParams.get('search') ?? '';
      const ids = /^alien$/i.test(s) ? ['Q1', 'Q103569'] : /harbour/i.test(s) ? ['Q55'] : [];
      return r.end(JSON.stringify({ search: ids.map((id) => ({ id })) }));
    }
    if (u.searchParams.get('action') === 'wbgetentities') {
      const ids = (u.searchParams.get('ids') ?? '').split('|');
      if ((u.searchParams.get('props') ?? '').includes('claims')) return r.end(JSON.stringify({ entities: Object.fromEntries(ids.map((id) => [id, ENTITIES[id]])) }));
      return r.end(JSON.stringify({ entities: Object.fromEntries(ids.filter((id) => NAMES[id]).map((id) => [id, { id, labels: { en: { value: NAMES[id] } } }])) }));
    }
  }
  if (u.pathname === '/poster.jpg') { r.setHeader('content-type', 'image/jpeg'); return r.end(POSTER); }
  // MusicBrainz: one studio recording of the song, its ISRC, genres, release and label.
  if (u.pathname === '/ws/2/recording') return r.end(JSON.stringify({ recordings: [{
    id: 'mv1', score: 100, title: 'Night Drive', length: 240000, disambiguation: '', video: false, 'artist-credit': [{ name: 'Neon Coast' }],
    releases: [{ id: 'rel-mv1', title: 'Coastlines', status: 'Official', date: '2019-06-14', 'release-group': { id: 'rg-mv1', title: 'Coastlines', 'primary-type': 'Album', 'secondary-types': [] } }] }] }));
  if (u.pathname.startsWith('/ws/2/recording/mv1')) return r.end(JSON.stringify({ isrcs: ['USX9P1900001'], genres: [{ name: 'synth-pop', count: 3 }, { name: 'pop', count: 2 }] }));
  if (u.pathname.startsWith('/ws/2/release-group/')) return r.end(JSON.stringify({ 'first-release-date': '2019-06-14', genres: [] }));
  if (u.pathname.startsWith('/ws/2/release/')) return r.end(JSON.stringify({ 'label-info': [{ label: { name: 'Harbour Records' } }] }));
  if (u.pathname === '/ws/2/release-group') return r.end(JSON.stringify({ 'release-groups': [] }));
  r.statusCode = 404; r.end('{}');
}).listen(0);
const port = (srv0.address() as any).port;
process.env.WIKIDATA_API_BASE = `http://127.0.0.1:${port}/w/api.php`;
process.env.FIND_DETAILS_MIN_GAP_MS = '0';
process.env.MUSICBRAINZ_BASE = `http://127.0.0.1:${port}/ws/2`;
process.env.COVERART_BASE = `http://127.0.0.1:${port}/cover`;
process.env.TRACK_META_MIN_GAP_MS = '5';
process.env.IMAGE_STORE_DIR = join(tmp, 'store');
process.env.GRAPHICS_ALLOW_PRIVATE_FEEDS = '1';   // the fake servers are on 127.0.0.1

(async () => {
  const { finderFor, titleTerm } = await import('../src/services/media/finders');
  const { wikidataTime, mapToFields } = await import('../src/services/media/wikidataLookup');

  console.log('== which finder, which term ==');
  eq([finderFor('song'), finderFor('music-video'), finderFor('movie'), finderFor('episode'), finderFor(null), finderFor('a-type-added-later')],
    ['song', 'song', 'general', 'general', 'general', 'general'], 'Songs and Music videos use the song service; every other type, and any added later, the general finder');
  eq([titleTerm([{ key: 'title', type: 'string', epg: 'title' }], { title: 'Alien' }, 'alien_1979_master.mxf'),
      titleTerm([{ key: 'nom', type: 'string', schemaOrg: 'name' }], { nom: 'Le Mépris' }, 'x'),
      titleTerm([{ key: 'title', type: 'string', epg: 'title' }], {}, 'Upload 12')],
    ['Alien', 'Le Mépris', 'Upload 12'], 'the term: the title field (by guide slot, else schema.org name), else the asset title');

  console.log('== Wikidata values onto fields ==');
  eq([wikidataTime(T('+1979-05-25T00:00:00Z')), wikidataTime(T('+2004-03-00T00:00:00Z', 10)), wikidataTime(T('+1984-00-00T00:00:00Z', 9)), wikidataTime(T('+1900-00-00T00:00:00Z', 7))],
    [{ date: '1979-05-25', precision: 11 }, { date: '2004-03', precision: 10 }, { date: '1984', precision: 9 }, null], 'times: day, month and year precision; a century is not a date');
  const vals: any = { name: { kind: 'text', value: 'Alien' }, director: { kind: 'list', value: ['Ridley Scott'] }, actor: { kind: 'list', value: ['Sigourney Weaver', 'Tom Skerritt'] },
    genre: { kind: 'list', value: ['horror film', 'drama film'] }, datePublished: { kind: 'date', value: '1979', precision: 9 }, copyrightYear: { kind: 'number', value: 1979 },
    duration: { kind: 'number', value: 117 }, image: { kind: 'image', value: 'https://commons.wikimedia.org/x.jpg' } };
  eq(mapToFields(vals, [
    { key: 'title', type: 'string', schemaOrg: 'name' }, { key: 'dir', type: 'string', schemaOrg: 'director' }, { key: 'cast', type: 'tags', schemaOrg: 'actor' },
    { key: 'g', type: 'enum', options: ['Drama', 'Documentary'], multiple: true, schemaOrg: 'genre' }, { key: 'released', type: 'date', schemaOrg: 'datePublished' },
    { key: 'premiere', type: 'date', schemaOrg: 'datePublished', allowYear: false }, { key: 'year', type: 'number', schemaOrg: 'copyrightYear' },
    { key: 'poster', type: 'image', schemaOrg: 'image' }, { key: 'notes', type: 'text' }, { key: 'kids', type: 'boolean', schemaOrg: 'isFamilyFriendly' },
  ] as any),
  { title: 'Alien', dir: 'Ridley Scott', cast: ['Sigourney Weaver', 'Tom Skerritt'], g: ['Drama'], released: '1979', year: 1979, poster: 'https://commons.wikimedia.org/x.jpg' },
  'by schema.org name, shaped per field: tags a list, an enum one of its options, a year only where the date takes one; no schema.org name, nothing');

  // ---- the database ----------------------------------------------------------
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { ensureStandardTypes } = await import('../src/services/contentTypes');
  const { config } = await import('../src/config');
  config.trackMeta.providers.splice(0, Infinity, 'musicbrainz');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`find-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`find-o-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `find-${tag}@volt.test`]))!.id;
  const ouser = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `find-o-${tag}@volt.test`]))!.id;
  await ensureStandardTypes(acct);
  const typeId = async (key: string) => (await one<any>(`SELECT id FROM metadata_schemas WHERE account_id = $1 AND standard_key = $2`, [acct, key]))!.id;
  const movie = await typeId('movie'), songT = await typeId('song'), mvT = await typeId('music-video');
  const own = (await one<any>(`INSERT INTO metadata_schemas(account_id, name, fields, target_kind, schema_org_type) VALUES ($1, $2, $3::jsonb, 'vod', 'Movie') RETURNING id`,
    [acct, `Archive film ${tag}`, JSON.stringify([
      { key: 'naam', label: 'Naam', type: 'string', schemaOrg: 'name' }, { key: 'regie', label: 'Regie', type: 'string', schemaOrg: 'director' },
      { key: 'shelf', label: 'Shelf mark', type: 'string' },
    ])]))!.id;
  const asset = async (o: any) => (await one<any>(
    `INSERT INTO vod_assets (account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata, schema_id, poster_key, poster_source)
     VALUES ($1,'upload','clip',$2,0,600000,600000,$3::jsonb,$4,$5,$6) RETURNING id`,
    [o.acct ?? acct, o.title ?? 'Asset', JSON.stringify(o.metadata ?? {}), o.schema ?? null, o.poster ?? null, o.poster ? 'frame' : null]))!.id;
  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const otok = signAccess({ sub: ouser, account_id: other, role: 'owner' });
  const api = async (method: string, path: string, body?: any, t = tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${t}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let j: any = null; try { j = JSON.parse(text); } catch { j = text; } return { s: r.status, j };
  };

  try {
    console.log('== a Movie: the general finder ==');
    const alien = await asset({ title: 'alien_1979_master.mxf', schema: movie, metadata: { title: 'Alien', rating: '15' } });
    let r = await api('GET', `/api/vod/${alien}/finder`);
    ok(r.s === 200 && r.j.finder === 'general' && r.j.term === 'Alien' && r.j.contentType?.standardKey === 'movie' && r.j.song === null, 'GET finder: general, the title field as the term', JSON.stringify(r.j));
    const before = await one<any>(`SELECT metadata, metadata_provenance, updated_at FROM vod_assets WHERE id = $1`, [alien]);
    r = await api('POST', `/api/vod/${alien}/details/find`, {});
    const res = r.j?.results ?? [];
    ok(r.s === 200 && r.j.source === 'wikidata' && r.j.term === 'Alien' && res.length === 2, 'the search runs on the title with no term typed', JSON.stringify(r.j).slice(0, 300));
    eq(res.map((x: any) => [x.id, x.likely, x.kinds[0]]), [['Q103569', true, 'film'], ['Q1', false, 'video game']], 'the film comes first for a Movie (Wikidata had the game first)');
    eq(res[0]?.proposed, { title: 'Alien', description: '1979 film by Ridley Scott', year: 1979, genre: ['Drama'], cast: ['Sigourney Weaver', 'Tom Skerritt'], director: 'Ridley Scott',
      language: 'English', image: 'https://commons.wikimedia.org/wiki/Special:FilePath/Alien_movie_poster.jpg?width=1200' },
      'mapped onto the Movie fields by schema.org name (year from the earliest release, genre to the account list, cast a list)');
    ok(!JSON.stringify(res[0]).includes('never shown'), 'a deprecated statement is not used');
    ok(r.j.current?.metadata?.rating === '15' && r.j.current.fields.some((f: any) => f.key === 'rating' && f.schemaOrg === 'contentRating') && r.j.unmapped.includes('Content rating'),
      'what the asset has now comes back to compare, and the fields Wikidata cannot fill are named', JSON.stringify(r.j.unmapped));
    const after = await one<any>(`SELECT metadata, metadata_provenance, updated_at FROM vod_assets WHERE id = $1`, [alien]);
    eq([after.metadata, after.metadata_provenance, String(after.updated_at)], [before.metadata, before.metadata_provenance, String(before.updated_at)], 'a search saves nothing');
    r = await api('POST', `/api/vod/${alien}/details/find`, { q: 'Harbour Lights' });
    eq([r.j.term, r.j.results.map((x: any) => [x.id, x.likely]), r.j.results[0]?.proposed], ['Harbour Lights', [['Q55', true]], { title: 'Harbour Lights', description: 'documentary', year: 2004, genre: ['Drama'] }],
      'a typed term searches that instead; a release known to the month still gives the year');

    console.log('== applying: only what was ticked ==');
    r = await api('POST', `/api/vod/${alien}/details/use`, { source: 'wikidata', itemId: 'Q103569', link: 'https://www.wikidata.org/wiki/Q103569',
      values: { director: 'Ridley Scott', year: 1979, cast: ['Sigourney Weaver'], image: `http://127.0.0.1:${port}/poster.jpg` } });
    const row = await one<any>(`SELECT metadata, metadata_provenance FROM vod_assets WHERE id = $1`, [alien]);
    ok(r.s === 200 && JSON.stringify(r.j.changed.sort()) === JSON.stringify(['cast', 'director', 'image', 'year']), 'use: the ticked fields are written', JSON.stringify(r.j));
    ok(row.metadata.director === 'Ridley Scott' && row.metadata.year === 1979 && row.metadata.cast.join() === 'Sigourney Weaver' && row.metadata.title === 'Alien' && row.metadata.rating === '15'
      && row.metadata.description === undefined && row.metadata.genre === undefined, 'the rest is left as it was (nothing un-ticked is written)', JSON.stringify(row.metadata));
    ok(new RegExp(`^/library/${acct}/.+`).test(row.metadata.image ?? ''), 'a found image is copied into the Image Library; the field holds the library reference', row.metadata.image);
    const pv = row.metadata_provenance.director;
    ok(pv?.source === 'wikidata' && pv.item === 'Q103569' && pv.chosen === true && pv.link === 'https://www.wikidata.org/wiki/Q103569' && pv.was === null && !!pv.approvedBy && !row.metadata_provenance.title,
      'metadata_provenance records the source, the item, who chose it and what it replaced', JSON.stringify(pv));
    r = await api('POST', `/api/vod/${alien}/details/use`, { source: 'wikidata', itemId: 'Q103569', values: { director: 'R. Scott' } });
    const again = await one<any>(`SELECT metadata, metadata_provenance FROM vod_assets WHERE id = $1`, [alien]);
    ok(r.s === 200 && again.metadata.director === 'R. Scott' && again.metadata_provenance.director.was === 'Ridley Scott', 'an existing value changes when ticked, and its old value is kept in the provenance');
    const audit = await one<any>(`SELECT detail FROM audit_log WHERE entity_id = $1 AND detail->'changes' ? 'found_details' ORDER BY created_at DESC LIMIT 1`, [alien]);
    ok(!!audit?.detail?.changes?.found_details && audit.detail.changes.found_in?.to?.item === 'Q103569', 'audited', JSON.stringify(audit));
    const bad = [
      await api('POST', `/api/vod/${alien}/details/use`, { source: 'wikidata', itemId: 'Q103569', values: { shelfMark: 'A1' } }),
      await api('POST', `/api/vod/${alien}/details/use`, { source: 'wikidata', itemId: 'Q103569', values: { year: 'nineteen seventy-nine' } }),
      await api('POST', `/api/vod/${alien}/details/use`, { source: 'wikidata', itemId: 'Q103569', values: {} }),
      await api('POST', `/api/vod/${alien}/details/use`, { source: 'wikidata', itemId: 'nope', values: { director: 'x' } }),
    ];
    eq(bad.map((x) => x.s), [422, 422, 422, 422], 'refused: a field the type does not have, a value that does not fit it, nothing ticked, a bad item id');
    eq([(await api('POST', `/api/vod/${alien}/details/find`, {}, otok)).s, (await api('POST', `/api/vod/${alien}/details/use`, { source: 'wikidata', itemId: 'Q1', values: { director: 'x' } }, otok)).s,
        (await api('GET', `/api/vod/${alien}/finder`, undefined, otok)).s], [404, 404, 404], 'another account cannot search for, write or read this asset');

    console.log('== other types ==');
    const archive = await asset({ title: 'reel 7', schema: own, metadata: { naam: 'Alien' } });
    r = await api('POST', `/api/vod/${archive}/details/find`, {});
    eq([r.j.term, r.j.results[0]?.proposed, r.j.unmapped], ['Alien', { naam: 'Alien', regie: 'Ridley Scott' }, ['Shelf mark']], 'a type the account built: the general finder through its schema.org names');
    const untyped = await asset({ title: 'Alien' });
    eq([(await api('POST', `/api/vod/${untyped}/details/find`, {})).s, (await api('GET', `/api/vod/${untyped}/finder`)).j.finder], [400, 'general'], 'no content type: asked to choose one first');
    const song = await asset({ title: 'Neon Coast - Night Drive', schema: songT, metadata: { artist: 'Neon Coast', title: 'Night Drive' } });
    eq([(await api('GET', `/api/vod/${song}/finder`)).j.finder, (await api('POST', `/api/vod/${song}/details/find`, {})).s], ['song', 409], 'a Song uses the song finder; the general one refuses it');
    down = true;
    r = await api('POST', `/api/vod/${alien}/details/find`, {});
    ok(r.s === 200 && /Wikidata answered 503/.test(r.j.error ?? '') && r.j.results.length === 0, 'Wikidata down: said plainly, nothing found, nothing saved', JSON.stringify(r.j.error));
    down = false; busy = true;
    r = await api('POST', `/api/vod/${alien}/details/find`, {});
    ok(r.s === 200 && /Wikidata is busy/.test(r.j.error ?? ''), 'Wikidata rate-limiting this server (429): said as busy, to try again', JSON.stringify(r.j.error));
    busy = false;
    ok(asked.length > 0 && asked.every((a) => !a.includes('undefined')), 'every Wikidata call named what it asked for');

    console.log('== a Music video: the song service ==');
    const mv = await asset({ title: 'Night Drive (official video)', schema: mvT, metadata: { artist: 'Neon Coast', title: 'Night Drive', label: 'Own Label' }, poster: `assets/${tag}/frame.jpg` });
    r = await api('GET', `/api/vod/${mv}/finder`);
    eq([r.j.finder, r.j.song?.artist, r.j.song?.title], ['song', 'Neon Coast', 'Night Drive'], 'GET finder: the song service, with the song from its fields');
    const img = await api('GET', `/api/vod/${mv}/image`);
    ok(img.j.finder === 'song' && img.j.songIdentity?.title === 'Night Drive', 'the image panel offers Find song details on a music video', JSON.stringify([img.j.finder, img.j.songIdentity]));
    r = await api('POST', `/api/vod/${mv}/song/find`, { providers: ['musicbrainz'] });
    const hit = (r.j.results ?? []).find((x: any) => x.provider === 'musicbrainz');
    ok(r.s === 200 && hit?.state === 'hit' && r.j.contentType?.now?.keep === true && r.j.contentType.now.song === false, 'the song service finds it; the type is kept (Song not proposed)', JSON.stringify([hit?.state, hit?.reason, r.j.contentType]));
    // The song finder shows every value it found beside what is there (unchanged behaviour);
    // the console ticks only the empty ones, and only ticked fields are written (below).
    eq(hit?.proposed, { title: 'Night Drive', artist: 'Neon Coast', album: 'Coastlines', isrc: 'USX9P1900001', label: 'Harbour Records', released: '2019-06-14', genre: ['Pop'] },
      'proposed in the Music video fields: album, ISRC, label, release date, genre (genre mapped to the account list)');
    ok(r.j.current.fields.some((f: any) => f.key === 'director') && !r.j.current.fields.some((f: any) => f.key === 'artwork'), 'compared against the Music video fields, not the Song ones');
    r = await api('POST', `/api/vod/${mv}/song/use`, { provider: 'musicbrainz', artist: 'Neon Coast', title: 'Night Drive', album: hit.album, released: hit.released, label: hit.label, isrc: hit.isrc,
      genres: hit.genres, link: hit.link, fields: ['album', 'isrc', 'released', 'genre'], useImage: false, setSong: true });
    const mrow = await one<any>(`SELECT schema_id, metadata, metadata_provenance, poster_key, poster_source FROM vod_assets WHERE id = $1`, [mv]);
    ok(r.s === 200 && mrow.schema_id === mvT, 'it stays a Music video (even when asked to become a Song)', JSON.stringify([r.s, mrow.schema_id === songT]));
    eq([mrow.metadata.album, mrow.metadata.isrc, mrow.metadata.released, mrow.metadata.genre, mrow.metadata.label, mrow.metadata_provenance.album?.source],
      ['Coastlines', 'USX9P1900001', '2019-06-14', ['Pop'], 'Own Label', 'musicbrainz'], 'filled from the song service with provenance; its own label kept');
    eq([mrow.poster_key, mrow.poster_source, mrow.metadata.image], [`assets/${tag}/frame.jpg`, 'frame', undefined], 'its picture stays the video frame (the album cover only offered)');
  } finally {
    srv.close(); srv0.close(); await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
