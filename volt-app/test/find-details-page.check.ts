// ============================================================================
//  FIND DETAILS FROM A PASTED LINK (build queue F2): services/media/pageMeta.ts
//  (detailsFromHtml, readDetailsPage, fetchPage) and POST /api/vod/:id/details/page
//  with source 'page' on /details/use (modules/vodDetails.ts).
//
//  Pure, on stored pages: a Movie's JSON-LD among the site's own objects; a
//  TV episode in a @graph with its series and season; a news article for a
//  Clip; an Open Graph only page; a page with only a <title>.
//  Postgres + HTTP, with the pages served by a stand-in site: a Movie mapped
//  onto its fields by schema.org name; an Episode; an account's own Podcast
//  type; nothing saved by a read; only the ticked values written, with the
//  page as their provenance; a site that refuses programs, a page that says
//  nothing, a pasted image, a private address, a Song, no type, another
//  account; the song finder's own page reading unchanged.
//  Usage: npx tsx test/find-details-page.check.ts
// ============================================================================
import { createServer as httpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
const sorted = (o: any): any => (Array.isArray(o) ? o.map(sorted) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sorted(o[k])])) : o);
const eq = (got: unknown, want: unknown, m: string) => { const g = JSON.stringify(sorted(got)), w = JSON.stringify(sorted(want)); ok(g === w, m, `expected ${w} got ${g}`); };

const tmp = mkdtempSync(join(tmpdir(), 'find-page-'));
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=teal:s=320x320:d=1', '-frames:v', '1', join(tmp, 'poster.jpg')]);
const POSTER = readFileSync(join(tmp, 'poster.jpg'));
const ld = (o: any) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

// ---- stored pages, one per kind of site ------------------------------------
const MOVIE = `<!doctype html><html><head><title>Harbour Lights | Northlight Films</title>
<meta property="og:site_name" content="Northlight Films"><meta property="og:title" content="Harbour Lights | Northlight Films">
<meta property="og:image" content="/img/og-card.jpg">
${ld({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Northlight Films', url: 'https://northlight.example' })}
${ld({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Northlight Films', logo: '/logo.png' })}
${ld({ '@context': 'https://schema.org', '@type': 'Movie', name: 'Harbour Lights', description: 'A lighthouse keeper&#39;s last winter.',
  datePublished: '2004-03-12', director: { '@type': 'Person', name: 'Ana Ruiz' }, actor: [{ '@type': 'Person', name: 'Tom Vale' }, { '@type': 'Person', name: 'Mia Holt' }],
  genre: ['Drama', 'Documentary'], contentRating: 'PG', inLanguage: 'en', image: { '@type': 'ImageObject', url: '/img/harbour.jpg' }, duration: 'PT1H32M' })}
</head><body>…</body></html>`;
const EPISODE = `<html><head><title>The Long Tide - Coastal Kitchens</title>
${ld({ '@context': 'https://schema.org', '@graph': [
  { '@type': 'WebPage', name: 'The Long Tide', mainEntity: { '@type': 'TVEpisode', name: 'The Long Tide', episodeNumber: '3',
    partOfSeason: { '@type': 'TVSeason', seasonNumber: 2, name: 'Series 2' }, partOfSeries: { '@type': 'TVSeries', name: 'Coastal Kitchens' },
    description: 'Oysters at dawn.', genre: 'Documentary', thumbnailUrl: 'https://cdn.example/tide.jpg', contentRating: 'G' } },
  { '@type': 'BreadcrumbList', itemListElement: [] },
] })}</head></html>`;
const ARTICLE = `<html><head>
${ld({ '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'Storm closes the harbour', description: 'Ferries cancelled until Friday.',
  keywords: 'storm, harbour, ferries', image: ['https://cdn.example/storm-16x9.jpg', 'https://cdn.example/storm-4x3.jpg'], datePublished: '2026-11-10T07:30:00Z', author: { '@type': 'Person', name: 'Jo Park' } })}
</head></html>`;
const OG_ONLY = `<html><head><title>Night Ferry - Watch on Example TV</title>
<meta property="og:site_name" content="Example TV"><meta property="og:type" content="video.movie">
<meta content="Night Ferry | Example TV" property="og:title"><meta property="og:description" content="Two strangers cross the strait.">
<meta property="og:image" content="https://cdn.example/ferry.jpg"><meta property="video:release_date" content="2019-08-01">
<meta property="video:director" content="https://example.tv/people/1"><meta property="video:director" content="Lena Moss">
<meta property="video:duration" content="5400"><meta property="video:tag" content="thriller"><meta property="video:tag" content="sea">
</head></html>`;
const PODCAST = `<html><head>${ld({ '@context': 'https://schema.org', '@type': 'PodcastEpisode', name: 'Tides and Tables', url: 'https://pods.example/e/12',
  partOfSeries: { '@type': 'PodcastSeries', name: 'Harbour Talk' }, episodeNumber: 12, datePublished: '2026-10-01', duration: 'PT38M' })}</head></html>`;
const TITLE_ONLY = '<html><head><title>Search results</title></head><body>12 results</body></html>';
const SONG = `<html><head>${ld({ '@context': 'https://schema.org', '@type': 'MusicRecording', name: 'Night Drive', byArtist: { name: 'Neon Coast' }, isrcCode: 'USX9P1900001' })}</head></html>`;
const PAGES: Record<string, string> = { '/movie': MOVIE, '/episode': EPISODE, '/article': ARTICLE, '/og': OG_ONLY, '/podcast': PODCAST, '/nothing': TITLE_ONLY, '/song': SONG };

const served: string[] = [];
const site = httpServer((q, r) => {
  const u = new URL(q.url!, 'http://x');
  served.push(u.pathname);
  if (PAGES[u.pathname]) { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(PAGES[u.pathname]); }
  if (u.pathname === '/poster.jpg' || u.pathname.startsWith('/img/')) { r.setHeader('content-type', 'image/jpeg'); return r.end(POSTER); }
  if (u.pathname === '/blocked') { r.statusCode = 403; r.setHeader('content-type', 'text/html'); return r.end('<html><head><title>Just a moment...</title></head></html>'); }
  r.statusCode = 404; r.end('not here');
}).listen(0);
const port = (site.address() as any).port;
const P = (p: string) => `http://127.0.0.1:${port}${p}`;
process.env.IMAGE_STORE_DIR = join(tmp, 'store');
process.env.GRAPHICS_ALLOW_PRIVATE_FEEDS = '1';   // the stand-in site is on 127.0.0.1

(async () => {
  const pm = await import('../src/services/media/pageMeta');
  const { mapToFields } = await import('../src/services/media/wikidataLookup');

  console.log('== reading pages (pure) ==');
  const mv = pm.detailsFromHtml(MOVIE, P('/movie'), 'Movie');
  eq([mv.kind, mv.likely, mv.label, mv.site], ['Movie', true, 'Harbour Lights', '127.0.0.1'], 'a film page: the Movie among the site\'s own WebSite and Organization');
  eq([mv.values.director, mv.values.actor, mv.values.datePublished, mv.values.copyrightYear, mv.values.duration, mv.values.image, mv.values.description],
    [{ kind: 'list', value: ['Ana Ruiz'] }, { kind: 'list', value: ['Tom Vale', 'Mia Holt'] }, { kind: 'date', value: '2004-03-12', precision: 11 }, { kind: 'number', value: 2004 },
      { kind: 'number', value: 92 }, { kind: 'image', value: P('/img/harbour.jpg') }, { kind: 'text', value: "A lighthouse keeper's last winter." }],
    'its properties by schema.org name: people as names, the year from the date, the running time in minutes, a relative image made absolute, entities decoded');
  ok(mv.from.director === 'json-ld' && mv.from.image === 'json-ld' && !JSON.stringify(mv.values).includes('logo.png'), 'JSON-LD wins over Open Graph, and the site\'s logo is not the film\'s', JSON.stringify(mv.from));
  const ep = pm.detailsFromHtml(EPISODE, P('/episode'), 'Episode');
  eq([ep.kind, ep.likely, ep.values.partOfSeries, ep.values.partOfSeason, ep.values.episodeNumber, ep.values.genre, ep.values.image],
    ['TVEpisode', true, { kind: 'text', value: 'Coastal Kitchens' }, { kind: 'number', value: 2 }, { kind: 'number', value: 3 }, { kind: 'list', value: ['Documentary'] }, { kind: 'image', value: 'https://cdn.example/tide.jpg' }],
    'an episode in a @graph (a WebPage\'s mainEntity): series by name, the season\'s number, the episode number, the thumbnail as its image');
  const ar = pm.detailsFromHtml(ARTICLE, P('/article'), 'VideoObject');
  eq([ar.kind, ar.likely, ar.values.headline, ar.values.name, ar.values.keywords, ar.values.thumbnailUrl, ar.values.datePublished?.value, ar.values.author],
    ['NewsArticle', false, { kind: 'text', value: 'Storm closes the harbour' }, { kind: 'text', value: 'Storm closes the harbour' }, { kind: 'list', value: ['storm', 'harbour', 'ferries'] },
      { kind: 'image', value: 'https://cdn.example/storm-16x9.jpg' }, '2026-11-10', { kind: 'list', value: ['Jo Park'] }],
    'a news article: headline and name fill each other, keywords split, the first image, the date without its time');
  const og = pm.detailsFromHtml(OG_ONLY, P('/og'), 'Movie');
  eq([og.kind, og.likely, og.label, og.values.description?.value, og.values.datePublished?.value, og.values.director, og.values.duration, og.values.keywords, og.from.name],
    ['Movie', true, 'Night Ferry', 'Two strangers cross the strait.', '2019-08-01', { kind: 'list', value: ['Lena Moss'] }, { kind: 'number', value: 90 }, { kind: 'list', value: ['thriller', 'sea'] }, 'og'],
    'Open Graph only: og:type as the kind, the site name taken off the title, a director given as a link left out, seconds as minutes, tags as keywords');
  const nothing = pm.detailsFromHtml(TITLE_ONLY, P('/nothing'), 'Movie');
  eq([pm.pageSaysNothing(nothing), pm.pageSaysNothing(og), pm.pageSaysNothing(pm.imageDetails(P('/poster.jpg'), 'x'))], [true, false, false], 'a page with only a <title> says nothing; a pasted image is not nothing');
  eq([pm.kindMatches('TVEpisode', 'Episode'), pm.kindMatches('NewsArticle', 'Article'), pm.kindMatches('Movie', 'Movie'), pm.kindMatches('Person', 'Movie'), pm.kindMatches(null, 'Movie')],
    [true, true, true, false, false], 'a narrower schema.org type is the content type\'s kind (TVEpisode for Episode)');
  eq(mapToFields(og.values, [{ key: 'title', type: 'string', schemaOrg: 'name' }, { key: 'year', type: 'number', schemaOrg: 'copyrightYear' }, { key: 'dir', type: 'string', schemaOrg: 'director' },
    { key: 'shelf', type: 'string' }] as any), { title: 'Night Ferry', year: 2019, dir: 'Lena Moss' }, 'mapped onto fields the way Wikidata\'s values are; a field with no schema.org name gets nothing');

  console.log('== the song finder\'s page reading is unchanged ==');
  const sp = await pm.readSongPage(P('/song'));
  const si = await pm.readSongPage(P('/poster.jpg'));
  eq([sp.title, sp.artist, sp.isrc, sp.imageOnly, si.imageOnly, si.image], ['Night Drive', 'Neon Coast', 'USX9P1900001', false, true, P('/poster.jpg')], 'readSongPage: a song page and a pasted image read as before');
  let threw = '';
  try { await pm.readSongPage(P('/blocked')); } catch (e: any) { threw = e instanceof pm.PageBlocked ? e.message : 'other'; }
  ok(/does not let programs read its pages\. Open the page in your browser, right-click the cover/.test(threw), 'a blocked site still tells a song\'s finder to copy the cover\'s address', threw);

  // ---- the database ----------------------------------------------------------
  const { createServer } = await import('../src/server');
  const { pool, one } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { ensureStandardTypes } = await import('../src/services/contentTypes');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`page-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`page-o-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `page-${tag}@volt.test`]))!.id;
  const ouser = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `page-o-${tag}@volt.test`]))!.id;
  await ensureStandardTypes(acct);
  const typeId = async (key: string) => (await one<any>(`SELECT id FROM metadata_schemas WHERE account_id = $1 AND standard_key = $2`, [acct, key]))!.id;
  const movie = await typeId('movie'), episode = await typeId('episode'), clip = await typeId('clip'), songT = await typeId('song');
  const podcast = (await one<any>(`INSERT INTO metadata_schemas(account_id, name, fields, target_kind, schema_org_type) VALUES ($1, $2, $3::jsonb, 'vod', 'PodcastEpisode') RETURNING id`,
    [acct, `Podcast ${tag}`, JSON.stringify([
      { key: 'title', label: 'Title', type: 'string', schemaOrg: 'name' }, { key: 'show', label: 'Show', type: 'string', schemaOrg: 'partOfSeries' },
      { key: 'number', label: 'Number', type: 'number', schemaOrg: 'episodeNumber' }, { key: 'aired', label: 'Aired', type: 'date', schemaOrg: 'datePublished' },
      { key: 'minutes', label: 'Minutes', type: 'number', schemaOrg: 'duration' }, { key: 'page', label: 'Page', type: 'url', schemaOrg: 'url' }, { key: 'host', label: 'Host', type: 'string' },
    ])]))!.id;
  const asset = async (o: any) => (await one<any>(
    `INSERT INTO vod_assets (account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata, schema_id)
     VALUES ($1,'upload','clip',$2,0,600000,600000,$3::jsonb,$4) RETURNING id`,
    [o.acct ?? acct, o.title ?? 'Asset', JSON.stringify(o.metadata ?? {}), o.schema ?? null]))!.id;
  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const otok = signAccess({ sub: ouser, account_id: other, role: 'owner' });
  const api = async (method: string, path: string, body?: any, t = tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${t}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let j: any = null; try { j = JSON.parse(text); } catch { j = text; } return { s: r.status, j };
  };

  try {
    console.log('== a Movie: paste its page ==');
    const film = await asset({ title: 'harbour_master.mxf', schema: movie, metadata: { title: 'Harbour Lights', rating: '12' } });
    const before = await one<any>(`SELECT metadata, metadata_provenance, updated_at FROM vod_assets WHERE id = $1`, [film]);
    let r = await api('POST', `/api/vod/${film}/details/page`, { url: P('/movie') });
    const res = r.j?.result;
    ok(r.s === 200 && r.j.source === 'page' && r.j.error === null && res?.likely === true && res.kinds[0] === 'Movie' && res.label === 'Harbour Lights' && res.site === '127.0.0.1',
      'the page is read and answered like a search result: its kind, label and site', JSON.stringify(r.j).slice(0, 300));
    eq(res?.proposed, { title: 'Harbour Lights', description: "A lighthouse keeper's last winter.", year: 2004, genre: ['Drama', 'Documentary'], cast: ['Tom Vale', 'Mia Holt'],
      director: 'Ana Ruiz', rating: 'PG', language: 'en', image: P('/img/harbour.jpg') }, 'mapped onto the Movie fields by schema.org name');
    eq([res?.from?.director, res?.imageUrl, r.j.unmapped, r.j.current?.metadata?.rating], ['json-ld', P('/img/harbour.jpg'), [], '12'], 'where each came from, the picture, nothing unmappable, what the asset has now');
    const after = await one<any>(`SELECT metadata, metadata_provenance, updated_at FROM vod_assets WHERE id = $1`, [film]);
    eq([after.metadata, after.metadata_provenance, String(after.updated_at)], [before.metadata, before.metadata_provenance, String(before.updated_at)], 'reading a page saves nothing');

    console.log('== applying: only what was ticked, the page as the source ==');
    r = await api('POST', `/api/vod/${film}/details/use`, { source: 'page', link: P('/movie'), values: { director: 'Ana Ruiz', cast: ['Tom Vale', 'Mia Holt'], image: P('/img/harbour.jpg') } });
    const row = await one<any>(`SELECT metadata, metadata_provenance FROM vod_assets WHERE id = $1`, [film]);
    eq(r.j?.changed?.slice().sort(), ['cast', 'director', 'image'], 'use: the ticked fields are written');
    ok(row.metadata.rating === '12' && row.metadata.year === undefined && row.metadata.description === undefined && new RegExp(`^/library/${acct}/.+`).test(row.metadata.image ?? ''),
      'nothing un-ticked is written; the image is copied into the Image Library', JSON.stringify(row.metadata));
    const pv = row.metadata_provenance.director;
    ok(pv?.source === 'page' && pv.site === '127.0.0.1' && pv.link === P('/movie') && pv.chosen === true && pv.was === null && !!pv.approvedBy && pv.item === undefined,
      'metadata_provenance: the page, its site and address, who chose it, what it replaced', JSON.stringify(pv));
    const audit = await one<any>(`SELECT detail FROM audit_log WHERE entity_id = $1 AND detail->'changes' ? 'found_details' ORDER BY created_at DESC LIMIT 1`, [film]);
    ok(audit?.detail?.changes?.found_in?.to?.source === 'page' && audit.detail.changes.found_in.to.link === P('/movie'), 'audited with the page', JSON.stringify(audit?.detail?.changes?.found_in));
    const bad = [
      await api('POST', `/api/vod/${film}/details/use`, { source: 'page', values: { director: 'x' } }),
      await api('POST', `/api/vod/${film}/details/use`, { source: 'page', link: 'ftp://files.example/x', values: { director: 'x' } }),
      await api('POST', `/api/vod/${film}/details/use`, { source: 'wikidata', link: P('/movie'), values: { director: 'x' } }),
      await api('POST', `/api/vod/${film}/details/use`, { source: 'page', link: P('/movie'), values: { year: 'two thousand and four' } }),
    ];
    eq(bad.map((x) => x.s), [422, 422, 422, 422], 'refused: a page with no address or not a web one, a Wikidata use with no item, a value that does not fit');
    r = await api('POST', `/api/vod/${film}/details/use`, { source: 'wikidata', itemId: 'Q103569', values: { director: 'Ridley Scott' } });
    ok(r.s === 200 && (await one<any>(`SELECT metadata_provenance FROM vod_assets WHERE id = $1`, [film])).metadata_provenance.director.item === 'Q103569', 'a Wikidata use works as before');

    console.log('== other types ==');
    const ep = await asset({ title: 'ck_s2e3.mp4', schema: episode });
    r = await api('POST', `/api/vod/${ep}/details/page`, { url: P('/episode') });
    eq(r.j?.result?.proposed, { title: 'The Long Tide', series: 'Coastal Kitchens', season: 2, episodeNumber: 3, description: 'Oysters at dawn.', genre: ['Documentary'], image: 'https://cdn.example/tide.jpg', rating: 'G' },
      'an Episode from a broadcaster\'s page: series, season and episode numbers');
    const cl = await asset({ title: 'storm clip', schema: clip });
    r = await api('POST', `/api/vod/${cl}/details/page`, { url: P('/article') });
    eq([r.j?.result?.proposed, r.j?.result?.likely], [{ headline: 'Storm closes the harbour', description: 'Ferries cancelled until Friday.', keywords: ['storm', 'harbour', 'ferries'], thumbnail: 'https://cdn.example/storm-16x9.jpg' }, false],
      'a Clip from a news article: headline, keywords, thumbnail (an article is not a video, so not marked as the same kind)');
    const pod = await asset({ title: 'ep12.mp3', schema: podcast });
    r = await api('POST', `/api/vod/${pod}/details/page`, { url: P('/podcast') });
    eq([r.j?.result?.proposed, r.j?.result?.likely, r.j?.unmapped], [{ title: 'Tides and Tables', show: 'Harbour Talk', number: 12, aired: '2026-10-01', minutes: 38, page: 'https://pods.example/e/12' }, true, ['Host']],
      'an account\'s own Podcast type through its schema.org names; its field with none is named');
    const og = await asset({ title: 'ferry', schema: movie });
    r = await api('POST', `/api/vod/${og}/details/page`, { url: `  ${P('/og')}  ` });
    eq([r.s, r.j?.result?.proposed], [200, { title: 'Night Ferry', description: 'Two strangers cross the strait.', year: 2019, director: 'Lena Moss', image: 'https://cdn.example/ferry.jpg' }],
      'Open Graph only, pasted with spaces around it');

    console.log('== pages that cannot help ==');
    r = await api('POST', `/api/vod/${film}/details/page`, { url: P('/blocked') });
    ok(r.s === 200 && r.j.blocked === true && r.j.result === null && /does not let programs read its pages\. Open the page in your browser and copy the details/.test(r.j.error ?? ''), 'a site that refuses programs: said, with what to do instead', JSON.stringify(r.j.error));
    r = await api('POST', `/api/vod/${film}/details/page`, { url: P('/nothing') });
    ok(r.s === 200 && r.j.result === null && /publishes no details on that page/.test(r.j.error ?? ''), 'a page with only a title: says it has nothing to read', JSON.stringify(r.j.error));
    r = await api('POST', `/api/vod/${film}/details/page`, { url: P('/gone') });
    ok(r.s === 200 && r.j.result === null && /answered 404/.test(r.j.error ?? ''), 'a missing page: its answer said', JSON.stringify(r.j.error));
    r = await api('POST', `/api/vod/${ep}/details/page`, { url: P('/poster.jpg') });
    eq([r.j?.result?.imageOnly, r.j?.result?.proposed, r.j?.result?.label], [true, { image: P('/poster.jpg') }, 'An image from 127.0.0.1'], 'a pasted image fills the image field only');
    delete process.env.GRAPHICS_ALLOW_PRIVATE_FEEDS;
    const n = served.length;
    r = await api('POST', `/api/vod/${film}/details/page`, { url: P('/movie') });
    ok(r.s === 400 && /private network/.test(r.j?.error ?? r.j?.message ?? JSON.stringify(r.j)) && served.length === n, 'a private network address is refused and never fetched', JSON.stringify(r.j));
    process.env.GRAPHICS_ALLOW_PRIVATE_FEEDS = '1';
    const song = await asset({ title: 'Night Drive', schema: songT, metadata: { artist: 'Neon Coast', title: 'Night Drive' } });
    const untyped = await asset({ title: 'Harbour Lights' });
    eq([(await api('POST', `/api/vod/${song}/details/page`, { url: P('/song') })).s, (await api('POST', `/api/vod/${untyped}/details/page`, { url: P('/movie') })).s,
        (await api('POST', `/api/vod/${film}/details/page`, { url: P('/movie') }, otok)).s, (await api('POST', `/api/vod/${film}/details/page`, {})).s],
      [409, 400, 404, 422], 'a Song keeps Find song details; no content type asks for one; another account cannot read for this asset; no address refused');
  } finally {
    srv.close(); site.close(); await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
