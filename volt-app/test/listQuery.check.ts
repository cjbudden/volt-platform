/**
 * The list standard (src/util/listQuery.ts) against a real Postgres: filters,
 * search, sort, cursor paging that never skips or repeats a row (with nulls,
 * ties and mixed sort directions), and refusals that say what is allowed.
 *   DATABASE_URL=... npx tsx test/listQuery.check.ts
 */
import { Pool } from 'pg';
import { parseList, pageSql, whereSql, countWhereSql, countParams, finishPage, defineList, listSpecsForDocs, type ListSpec } from '../src/util/listQuery';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fails++; };

const spec: ListSpec = defineList({
  path: '/api/widgets',
  fields: {
    id: { sql: 'w.id', type: 'uuid' },
    name: { sql: 'w.name', type: 'string' },
    state: { sql: 'w.state', type: 'enum', values: ['live', 'ended', 'scheduled'] },
    size: { sql: 'w.size', type: 'number' },
    archived: { sql: 'w.archived', type: 'boolean' },
    created_at: { sql: 'w.created_at', type: 'timestamp' },
    notes: { sql: 'w.notes', type: 'string', sort: false },
  },
  search: ['name', 'notes'],
  defaultSort: '-created_at',
  aliases: { createdAt: 'created_at' },
  allowOffset: true,
});

function fakeRes() {
  const h: Record<string, string> = {};
  return { h, setHeader: (k: string, v: string) => { h[k] = v; }, getHeader: (k: string) => h[k], append: (k: string, v: string) => { h[k] = h[k] ? `${h[k]}, ${v}` : v; } } as any;
}
async function list(qs: string) {
  const u = new URL('http://x/api/widgets?' + qs);
  const query: any = {};
  for (const [k, v] of u.searchParams) {
    const m = k.match(/^([^[]+)\[([^\]]+)\]$/);
    if (m) (query[m[1]] ??= {})[m[2]] = v; else query[k] = v;
  }
  const params: unknown[] = ['acct'];
  const pl = parseList(spec, query, params);
  const rows = (await pool.query(`SELECT * FROM widgets w WHERE w.account = $1${whereSql(pl)} ${pageSql(pl)}`, params)).rows;
  const total = pl.count ? Number((await pool.query(`SELECT count(*) AS n FROM widgets w WHERE w.account = $1${countWhereSql(pl)}`, countParams(pl, params))).rows[0].n) : undefined;
  const res = fakeRes();
  const page = finishPage({ originalUrl: u.pathname + u.search } as any, res, pl, rows, total);
  return { page, headers: res.h };
}
async function refuses(qs: string, expect: RegExp, label: string) {
  try { await list(qs); ok(false, `${label}: should refuse`); }
  catch (e: any) { ok(e.status === 400 && expect.test(e.message), `${label}: 400 "${e.message}"`); }
}

(async () => {
  await pool.query(`CREATE TEMP TABLE widgets (id uuid primary key, account text, name text, state text, size numeric, archived boolean, created_at timestamptz, notes text)`);
  // 57 rows: ties on created_at, some null sizes and names, mixed states.
  for (let i = 0; i < 57; i++) {
    await pool.query(`INSERT INTO widgets VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`, [
      i === 56 ? 'other' : 'acct', i % 11 === 0 ? null : `Widget ${i} ${i % 2 ? 'Alpha' : 'Beta'}`,
      ['live', 'ended', 'scheduled'][i % 3], i % 7 === 0 ? null : (i * 37) % 50, i % 5 === 0,
      new Date(Date.UTC(2026, 9, 1 + (i % 9))), i === 3 ? 'has 50% off_sale' : null,
    ]);
  }
  const all = (await pool.query(`SELECT * FROM widgets WHERE account='acct'`)).rows;

  // default page
  let r = await list('');
  ok(r.page.length === 50 && !!r.headers['X-Next-Cursor'] && /rel="next"/.test(r.headers.Link), 'default: 50 rows, a next link');

  // walk every page with each sort and confirm a perfect partition
  for (const sort of ['-created_at', 'name', '-size,name', 'state,-created_at,size', 'archived,-size']) {
    const seen: string[] = [];
    let qs = `sort=${sort}&limit=7`;
    for (let n = 0; n < 30; n++) {
      const { page, headers } = await list(qs);
      seen.push(...page.map((x: any) => x.id));
      if (!headers['X-Next-Cursor']) break;
      qs = `sort=${sort}&limit=7&cursor=${headers['X-Next-Cursor']}`;
    }
    ok(seen.length === all.length && new Set(seen).size === all.length, `cursor paging sort=${sort}: ${seen.length}/${all.length} rows, no repeats`);
  }

  // Both directions (20 Oct 2026): walk forward collecting pages, then walk
  // back with rel="prev" from the end and get exactly the same pages; last
  // is the final rows in view order; first drops the cursor.
  const linkRel = (h: Record<string, string>, rel: string) => {
    const m = (h.Link || '').split(/,\s*(?=<)/).map((x) => x.match(/^<([^>]+)>;\s*rel="([^"]+)"/)).find((x) => x && x[2] === rel);
    return m ? new URL(m[1], 'http://x').search.slice(1) : null;
  };
  for (const sort of ['-created_at', 'name', 'state,-created_at,size', 'archived,-size']) {
    const fwd: string[][] = [];
    let qs: string | null = `sort=${sort}&limit=6`;
    let lastHeaders: Record<string, string> = {};
    for (let n = 0; n < 30 && qs; n++) {
      const { page, headers } = await list(qs);
      fwd.push(page.map((x: any) => x.id));
      lastHeaders = headers;
      qs = linkRel(headers, 'next');
    }
    const back: string[][] = [];
    qs = linkRel(lastHeaders, 'prev');
    for (let n = 0; n < 30 && qs; n++) {
      const { page, headers } = await list(qs);
      back.unshift(page.map((x: any) => x.id));
      qs = linkRel(headers, 'prev');
    }
    back.push(fwd[fwd.length - 1]);
    ok(JSON.stringify(back) === JSON.stringify(fwd), `prev walks back over the same ${fwd.length} pages, sort=${sort}`);
    const firstQs = linkRel(lastHeaders, 'first');
    ok(!!firstQs && !/cursor=/.test(firstQs) && JSON.stringify((await list(firstQs!)).page.map((x: any) => x.id)) === JSON.stringify(fwd[0]), `first link is page one, sort=${sort}`);
    const lastQs = linkRel((await list(`sort=${sort}&limit=6`)).headers, 'last');
    const flat = fwd.flat();
    const lastPage = await list(lastQs!);
    ok(JSON.stringify(lastPage.page.map((x: any) => x.id)) === JSON.stringify(flat.slice(-6)) && !linkRel(lastPage.headers, 'next') && !!linkRel(lastPage.headers, 'prev'), `last is the final 6 rows in view order, no next, sort=${sort}`);
  }
  r = await list('limit=6');
  ok(!linkRel(r.headers, 'prev') && !!linkRel(r.headers, 'first') && !!linkRel(r.headers, 'last'), 'page one: no prev, has first and last');
  r = await list('limit=200');
  ok(!linkRel(r.headers, 'prev') && !linkRel(r.headers, 'first') && !linkRel(r.headers, 'next'), 'one page: no paging links at all');
  r = await list('offset=12&limit=6');
  ok(!!linkRel(r.headers, 'prev') && JSON.stringify((await list(linkRel(r.headers, 'prev')!)).page.map((x: any) => x.id)) === JSON.stringify((await list('offset=6&limit=6')).page.map((x: any) => x.id)), 'prev from an offset page is the page before it');
  const pc = (await list('sort=name&limit=5&offset=5')).headers['X-Prev-Cursor'];
  await refuses(`sort=-name&limit=5&cursor=${pc}`, /different search, filter or sort/, 'prev cursor reused with another sort');

  // Microsecond timestamps (20 Oct 2026). Postgres keeps microseconds, a JS
  // Date (and so a cursor) keeps milliseconds. Rows written in one statement
  // share now(), and rows a few microseconds apart share a millisecond: paging
  // must neither repeat the anchor row (ascending) nor skip its neighbours
  // (descending), in either direction.
  await pool.query(`CREATE TEMP TABLE ticks (id uuid primary key, account text, name text, state text, size numeric, archived boolean, created_at timestamptz, notes text)`);
  await pool.query(`INSERT INTO ticks SELECT gen_random_uuid(), 'acct', 'T'||g, 'live', g, false, timestamptz '2026-10-20 10:00:00.123' + (g % 5) * interval '1 microsecond' + (g / 5) * interval '1 millisecond', null FROM generate_series(1, 23) g`);
  const ticks = (await pool.query(`SELECT id FROM ticks`)).rows.length;
  for (const sort of ['created_at', '-created_at']) {
    const seen: string[] = [];
    let qs: string | null = `sort=${sort}&limit=4`;
    let lastH: Record<string, string> = {};
    for (let n = 0; n < 30 && qs; n++) {
      const u = new URL('http://x/api/widgets?' + qs);
      const query: any = Object.fromEntries(u.searchParams);
      const params: unknown[] = ['acct'];
      const pl = parseList(spec, query, params);
      const rows = (await pool.query(`SELECT * FROM ticks w WHERE w.account = $1${whereSql(pl)} ${pageSql(pl)}`, params)).rows;
      const res = fakeRes();
      const page = finishPage({ originalUrl: u.pathname + u.search } as any, res, pl, rows);
      seen.push(...page.map((x: any) => x.id));
      lastH = res.h;
      qs = linkRel(res.h, 'next');
    }
    ok(seen.length === ticks && new Set(seen).size === ticks, `microsecond timestamps, sort=${sort}: ${seen.length}/${ticks} rows, ${new Set(seen).size} distinct`);
  }

  // filters
  r = await list('state=live&limit=200');
  ok(r.page.length === all.filter((x) => x.state === 'live').length && r.page.every((x: any) => x.state === 'live'), 'state=live');
  r = await list('state=live,ended&limit=200');
  ok(r.page.length === all.filter((x) => x.state !== 'scheduled').length, 'state=live,ended (any of)');
  r = await list('state[ne]=live&limit=200');
  ok(r.page.every((x: any) => x.state !== 'live'), 'state[ne]=live');
  r = await list('size[gte]=20&size[lt]=30&limit=200');
  ok(r.page.length === all.filter((x) => x.size !== null && +x.size >= 20 && +x.size < 30).length, 'size range gte/lt');
  r = await list('size[exists]=false&limit=200');
  ok(r.page.length === all.filter((x) => x.size === null).length, 'size[exists]=false');
  r = await list('created_at[gte]=2026-10-05&limit=200');
  ok(r.page.every((x: any) => new Date(x.created_at) >= new Date('2026-10-05')), 'created_at[gte] date');
  r = await list('createdAt[lt]=2026-10-03&limit=200');
  ok(r.page.length > 0 && r.page.every((x: any) => new Date(x.created_at) < new Date('2026-10-03')), 'alias createdAt');
  r = await list('archived=true&limit=200');
  ok(r.page.length === all.filter((x) => x.archived).length, 'archived=true');
  r = await list('name[starts]=widget 1&limit=200');
  ok(r.page.length > 0 && r.page.every((x: any) => /^Widget 1/.test(x.name)), 'name[starts] (case-insensitive)');

  // search: every word must match, wildcards are literal
  r = await list('q=alpha widget&limit=200');
  ok(r.page.length === all.filter((x) => x.name && /alpha/i.test(x.name)).length, 'q: two words, AND');
  r = await list('q=50%25 off_sale&limit=200');
  ok(r.page.length === 1, 'q: % and _ are literal, searches notes');
  r = await list('q=zzz');
  ok(r.page.length === 0, 'q: no match');

  // tenant scope comes from the caller
  r = await list('limit=200');
  ok(r.page.every((x: any) => x.account === 'acct') && r.page.length === all.length, 'caller tenant filter kept');

  // offset + count
  r = await list('offset=50&count=true');
  ok(r.page.length === all.length - 50 && r.headers['X-Total-Count'] === String(all.length), 'offset + count header');
  // The total is the same on every page: the cursor is not part of the count.
  const p1 = await list('state=live&sort=name&limit=4&count=true');
  const p2 = await list(`state=live&sort=name&limit=4&count=true&cursor=${p1.headers['X-Next-Cursor']}`);
  const live = String(all.filter((x) => x.state === 'live').length);
  ok(p1.headers['X-Total-Count'] === live && p2.headers['X-Total-Count'] === live, `count=true is stable across pages (${p1.headers['X-Total-Count']}, ${p2.headers['X-Total-Count']} of ${live})`);

  r = await list('_=1718000000000&limit=3');
  ok(r.page.length === 3, 'cache-buster _= is ignored, not refused');

  // refusals that explain themselves
  await refuses('colour=red', /Unknown filter "colour". Filter on: id, name, state/, 'unknown filter');
  await refuses('sort=notes', /Cannot sort by "notes"/, 'unsortable field');
  await refuses('state=gone', /must be one of: live, ended, scheduled/, 'bad enum');
  await refuses('size[gt]=big', /size must be a number/, 'bad number');
  await refuses('size[contains]=1', /"contains" is not available for size/, 'op not allowed for type');
  await refuses('limit=1000', /limit must be 1 to 200/, 'limit too big');
  await refuses('created_at[gte]=yesterday', /ISO 8601/, 'bad date');
  await refuses('id=1', /must be an id/, 'bad uuid');
  const { headers } = await list('sort=name&limit=5');
  await refuses(`sort=-name&limit=5&cursor=${headers['X-Next-Cursor']}`, /different search, filter or sort/, 'cursor reused with another sort');
  await refuses('cursor=garbage', /cursor/, 'garbage cursor');
  r = await list("name=x'; DROP TABLE widgets;--&limit=1");
  ok(r.page.length === 0, 'injection attempt is just a value that matches nothing');
  ok((await pool.query('SELECT count(*) FROM widgets')).rows[0].count === '57', 'table intact after injection attempt');

  const docs = listSpecsForDocs();
  ok(docs.length === 1 && docs[0].fields.size.ops.includes('gte') && docs[0].search.join() === 'name,notes', 'docs export');
  await pool.end();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
