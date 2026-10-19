/**
 * EVERY LIST ENDPOINT, EVERY SORT, EVERY FILTER, against a real database.
 *
 * Reads the registered list definitions (src/util/listQuery.ts defineList) and,
 * for each endpoint without path parameters (or with params given below):
 *   - the default request, and limit=1 with its next cursor
 *   - sort by every sortable field, both directions
 *   - every filterable field with every operator, using a value from a real
 *     row when there is one and a type-correct dummy when there is not
 *   - q (when the endpoint searches)
 *   - an unknown filter, which must be a 400 that lists the allowed fields
 * Postgres checks every column and cast even on empty tables, so a definition
 * that names a wrong column fails here, not in front of a customer.
 *
 *   DATABASE_URL=... DOCS_TEST_EMAIL=... DOCS_TEST_PASSWORD=... npx tsx test/listStandard.check.ts [pathFilter]
 */
const only = process.argv[2] ?? '';
(async () => {
  const { createServer } = await import('../src/server');
  const { listSpecsForDocs } = await import('../src/util/listQuery');
  const { query } = await import('../src/db');
  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.DOCS_TEST_EMAIL ?? 'admin@volt.test', password: process.env.DOCS_TEST_PASSWORD ?? 'VoltTest!2026' }) });
  const token = (await login.json() as any).access;
  if (!token) { console.error('FAIL sign-in for the test failed'); process.exit(1); }
  const H = { authorization: `Bearer ${token}` };
  let fails = 0, calls = 0;
  const bad = (m: string) => { console.log(`FAIL ${m}`); fails++; };

  // Path parameters: fill from a real row when there is one.
  async function resolvePath(path: string): Promise<string | null> {
    if (!path.includes(':')) return path;
    const pick = async (sql: string) => (await query<any>(sql)).at(0)?.id ?? null;
    let out = path;
    for (const m of path.matchAll(/:(\w+)/g)) {
      const seg = path.split('/')[path.split('/').indexOf(`:${m[1]}`) - 1];
      const table = { channels: 'channels', events: 'events', watchfolders: 'watchfolders', recordings: 'recordings', radio: 'channels' }[seg as string];
      const id = table ? await pick(`SELECT id FROM ${table} LIMIT 1`) : null;
      if (!id) return null;
      out = out.replace(`:${m[1]}`, id);
    }
    return out;
  }
  const rowsOf = (body: any): any[] => (Array.isArray(body) ? body : Object.values(body ?? {}).find(Array.isArray) as any[] ?? []);
  async function get(url: string, expect = 200) {
    calls++;
    const r = await fetch(base + url.replace(/\?([^?]*)\?/, '?$1&'), { headers: H });
    const text = await r.text();
    let body: any; try { body = JSON.parse(text); } catch { body = text; }
    if (r.status !== expect) bad(`${url} -> ${r.status} (expected ${expect}) ${typeof body === 'object' ? (body.error ?? '') : String(body).slice(0, 120)}`);
    return { status: r.status, body, headers: r.headers };
  }
  const dummy = (t: string, values?: string[]) => ({ number: '1', boolean: 'true', timestamp: '2026-01-01T00:00:00Z', uuid: '00000000-0000-0000-0000-000000000000', enum: values?.[0] ?? 'x', string: 'a' } as any)[t];

  // Lists that need an owner in the query string: filled from the first row
  // the signed-in account can see (so it is always one of its own).
  const REQUIRED: Record<string, [string, string]> = {
    '/api/epg': ['channelId', '/api/channels?limit=1'],
    '/api/publications': ['assetId', '/api/vod?limit=1'],
  };
  const specs = listSpecsForDocs().filter((s) => s.path.includes(only));
  for (const s of specs) {
    let path = await resolvePath(s.path);
    if (path && REQUIRED[s.path]) {
      const [name, from] = REQUIRED[s.path];
      const id = rowsOf(await (await fetch(base + from, { headers: H })).json())[0]?.id;
      path = id ? `${path}?${name}=${id}` : null;
    }
    if (!path) { console.log(`SKIP ${s.path} (no row to fill its path or required parameter)`); continue; }
    const before = fails;
    const first = await get(path);
    const sample = rowsOf(first.body)[0] ?? {};
    const one = await get(`${path}?limit=1`);
    const next = one.headers.get('x-next-cursor');
    if (next) await get(`${path}?limit=1&cursor=${encodeURIComponent(next)}`);
    for (const [name, f] of Object.entries<any>(s.fields)) {
      if (f.sort) { await get(`${path}?sort=${name}&limit=5`); await get(`${path}?sort=-${name}&limit=5`); }
      for (const op of f.ops) {
        const real = sample[name];
        let v = real === undefined || real === null || typeof real === 'object' ? dummy(f.type, f.values) : String(real);
        if (f.type === 'timestamp' && real) v = new Date(real).toISOString();
        if (op === 'exists') v = 'true';
        if (op === 'contains' || op === 'starts') v = String(v).slice(0, 3) || 'a';
        await get(`${path}?${encodeURIComponent(name)}[${op}]=${encodeURIComponent(v)}&limit=5`);
      }
    }
    if (s.search.length) await get(`${path}?q=${encodeURIComponent('a 1')}&limit=5`);
    await get(`${path}?count=true&limit=2`);
    const unknown = await get(`${path}?no_such_field=1`, 400);
    if (unknown.status === 400 && !/Filter on:/.test(unknown.body?.error ?? '')) bad(`${s.path}: unknown-filter error does not list the fields`);
    console.log(`${fails === before ? 'PASS' : 'FAIL'} ${s.path} (${Object.keys(s.fields).length} fields)`);
  }
  srv.close();
  console.log(`${specs.length} list endpoints, ${calls} requests, ${fails ? `${fails} FAILED` : 'ALL PASSED'}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
