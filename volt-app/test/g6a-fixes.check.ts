// ============================================================================
//  FIXES FOUND WRITING THE DEVELOPER GUIDES (build queue 1.14-G6a).
//
//  Pinned over real HTTP:
//    (a) an upload opened through the API keeps the name it was given as the
//        asset's title when nothing better is given: no content type, a name
//        that is not just the file name. A name that only repeats the file
//        name (what the console sends) still gets the title read from the file
//        name. `metadata.title` and `metadata.name` sent with no content type
//        title the asset too, before the upload's name. The finish answer and
//        the stored asset agree.
//    (b) a TV channel and a radio station answer the same `kind` in the list
//        (GET /api/channels) and the item (GET /api/channels/{id}), in plain
//        JSON and in JSON-LD.
//    DATABASE_URL=... npx tsx test/g6a-fixes.check.ts
// ============================================================================
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// Uploads land in throwaway folders, never in the repo's own.
const scratch = mkdtempSync(join(tmpdir(), 'g6a-'));
for (const k of ['UPLOAD_STAGING_DIR', 'FILLER_DIR', 'CLIPS_DIR', 'IMAGE_STORE_DIR']) if (!process.env[k]) process.env[k] = join(scratch, k.toLowerCase());

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { givenTitle } = await import('../src/services/ingest/pipeline');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, max_channels) VALUES ($1, 50) RETURNING id`, [`g6a-${tag}`]))!.id;
  const admin = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','admin','active') RETURNING id`,
    [acct, `g6a-admin-${tag}@volt.test`]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name, max_channels, max_concurrent) VALUES ($1,'Main',20,5) RETURNING id`, [acct]))!.id;
  const tv = (await one<any>(`INSERT INTO channels(group_id, name, kind) VALUES ($1,'Volt News','tv') RETURNING id`, [g]))!.id;
  const fm = (await one<any>(`INSERT INTO channels(group_id, name, kind) VALUES ($1,'Volt FM','radio') RETURNING id`, [g]))!.id;

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: admin, account_id: acct, role: 'admin' as any });
  const call = async (method: string, path: string, body?: any, headers: Record<string, string> = {}, bearer = tok) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const j = await res.json().catch(() => null) as any;
    return { s: res.status, j };
  };
  /** Open, send one chunk, finish: what upload.sh does. */
  const upload = async (open: Record<string, any>) => {
    const bytes = randomBytes(4096);
    const o = await call('POST', '/api/uploads', { purpose: 'vod', contentType: 'video/mp4', totalBytes: bytes.length, ...open });
    if (o.s !== 201) return { s: o.s, j: o.j, title: null as string | null };
    const put = await call('PUT', `/api/uploads/${o.j.id}/chunks/0`, bytes, { 'content-type': 'application/octet-stream' }, o.j.token);
    const fin = await call('POST', `/api/uploads/${o.j.id}/finish`, undefined, {}, o.j.token);
    const stored = fin.j?.assetId ? (await one<any>(`SELECT title FROM vod_assets WHERE id = $1`, [fin.j.assetId]))?.title ?? null : null;
    return { s: put.s === 200 ? fin.s : put.s, j: fin.j, title: stored };
  };

  try {
    console.log('== (a) which names are chosen titles ==');
    check('a name unlike the file name is a chosen title', givenTitle('Evening news', 'evening-news.mp4'), 'Evening news');
    check('the file name without its extension is not (the console sends that)', givenTitle('evening-news', 'evening-news.mp4'), null);
    check('the file name itself is not', givenTitle('evening-news.mp4', 'evening-news.mp4'), null);
    check('blank is not', givenTitle('  ', 'evening-news.mp4'), null);

    console.log('== (a) uploads through the API keep their name ==');
    const named = await upload({ name: 'Evening news', filename: 'evening-news.mp4' });
    check('an upload named "Evening news" with no content type finishes (200)', named.s, 200);
    check('...ingested', named.j?.ingest?.status, 'ingested');
    check('...titled with its name in the finish answer', named.j?.ingest?.title, 'Evening news');
    check('...and on the stored asset', named.title, 'Evening news');

    const stem = await upload({ name: 'evening-news', filename: 'evening-news.mp4' });
    check('a name that only repeats the file name still gets the title read from the file name', [stem.j?.ingest?.title, stem.title], ['Evening News', 'Evening News']);

    const withMeta = await upload({ name: 'evening-news', filename: 'evening-news.mp4', metadata: { title: 'Evening news, 24 October' } });
    check('metadata.title with no content type titles the asset', [withMeta.j?.ingest?.title, withMeta.title], ['Evening news, 24 October', 'Evening news, 24 October']);

    const both = await upload({ name: 'Evening news', filename: 'evening-news.mp4', metadata: { name: 'The 6 o\'clock news' } });
    check('metadata.name comes before the upload\'s name', both.title, 'The 6 o\'clock news');

    console.log('== (b) a channel\'s kind is the same in the list and the item ==');
    for (const [label, accept] of [['plain JSON', 'application/json'], ['JSON-LD', 'application/ld+json']] as const) {
      const list = await call('GET', '/api/channels', undefined, { accept });
      const rows: any[] = Array.isArray(list.j) ? list.j : (list.j?.items ?? list.j?.data ?? list.j?.member ?? list.j?.['hydra:member'] ?? []);
      for (const [name, id, want] of [['TV channel', tv, 'tv'], ['radio station', fm, 'radio']] as const) {
        const row = rows.find((r: any) => r.id === id);
        const item = await call('GET', `/api/channels/${id}`, undefined, { accept });
        check(`${label}: the ${name}'s kind, list then item`, [list.s, row?.kind, item.s, item.j?.kind], [200, want, 200, want]);
      }
    }
  } catch (e) {
    console.log('FAIL the run threw: ' + ((e as any)?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end().catch(() => {});
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
