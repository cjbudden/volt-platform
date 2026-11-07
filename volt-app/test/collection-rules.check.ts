// ============================================================================
//  RULE-BASED COLLECTIONS (build queue C1, services/collectionRules.ts,
//  modules/collections.ts, migration 0138).
//
//  Every operator of every field type, against a small library with known
//  answers; AND, OR and nested groups; members = rule matches + manual adds
//  - exclusions; re-matching when an asset changes (the trigger and the
//  queue pass); the nightly and stale full re-checks; ordering by a field;
//  refusals; another account's media never matched. Then the scale check:
//  a full match over a 100,000-asset library, timed.
//    DATABASE_URL=... npx tsx test/collection-rules.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};
const ok = (m: string, cond: boolean, detail = '') => check(m + (detail ? ` (${detail})` : ''), cond, true);

(async () => {
  const CR = await import('../src/services/collectionRules');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const mk = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`cr-${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `cr-${n}-${tag}@volt.test`]))!.id;
    const g = (await one<any>(`INSERT INTO groups(account_id, name, max_channels) VALUES ($1,'G',50) RETURNING id`, [a]))!.id;
    const ch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Sport 24') RETURNING id`, [g]))!.id;
    return { a, u, ch, tok: signAccess({ sub: u, account_id: a, role: 'owner' }) };
  };
  const me = await mk('me'), them = await mk('them');

  const schema = (await one<any>(`INSERT INTO metadata_schemas(account_id, name, fields) VALUES ($1, 'Episode', $2::jsonb) RETURNING id`, [me.a, JSON.stringify([
    { key: 'season', label: 'Season', type: 'number' },
    { key: 'aired', label: 'Aired', type: 'date' },
    { key: 'keywords', label: 'Keywords', type: 'tags' },
    { key: 'rating', label: 'Rating', type: 'enum', options: ['G', 'PG', 'M'] },
    { key: 'live_sport', label: 'Live sport', type: 'boolean' },
    { key: 'cover', label: 'Cover', type: 'image' },
  ])]))!.id;
  const movie = (await one<any>(`INSERT INTO metadata_schemas(account_id, name, fields) VALUES ($1, 'Movie', '[]') RETURNING id`, [me.a]))!.id;
  const prov = async (acct: string, name: string, provider: string) => (await one<any>(
    `INSERT INTO rights_profiles(account_id, name, provider) VALUES ($1,$2,$3) RETURNING id`, [acct, name, provider]))!.id;
  const pLeague = await prov(me.a, 'League', 'Example League'), pFilms = await prov(me.a, 'Films', 'Example Films');

  const day = 86400_000;
  const asset = async (o: any, a: { title: string; meta?: any; schema?: string | null; mins?: number; ageDays?: number; profile?: string | null; channel?: boolean; aired?: number | null; state?: string }) => (await one<any>(
    `INSERT INTO vod_assets(account_id, channel_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, metadata, schema_id, created_at,
                            rights_profile_id, first_aired_at, availability_state)
     VALUES ($1,$2,$3,'clip',$4,'k',0,$5,$5,$6::jsonb,$7, now() - ($8 || ' days')::interval, COALESCE($9, (SELECT volt_rights_builtin($11, 'open'))), $10, $12) RETURNING id`,
    [a.channel ? null : o.a, a.channel ? o.ch : null, a.channel ? 'recording' : 'upload', a.title, (a.mins ?? 10) * 60000, JSON.stringify(a.meta ?? {}), a.schema ?? null,
     String(a.ageDays ?? 0), a.profile ?? null, a.aired == null ? null : new Date(Date.now() - a.aired * day).toISOString(), o.a, a.state ?? 'draft']))!.id;

  // THE LIBRARY, with known answers.
  const A = {
    finalH: await asset(me, { title: 'Pacific Cup final: highlights', schema, mins: 12, ageDays: 2, profile: pLeague, channel: true, aired: 2, state: 'available',
      meta: { season: 3, aired: '2026-10-01', keywords: ['cup', 'final'], rating: 'G', live_sport: 'true', genre: 'Sport', description: 'The 2026 final' } }),
    semi: await asset(me, { title: 'Pacific Cup semi 1', schema, mins: 95, ageDays: 9, profile: pLeague, channel: true, aired: 9,
      meta: { season: 3, aired: '2026-09-20', keywords: ['cup'], rating: 'PG', genre: 'Sport' } }),
    old: await asset(me, { title: 'Classic final 1996', schema, mins: 80, ageDays: 400, profile: pLeague,
      meta: { season: 1, aired: '1996-06-01', keywords: ['final', 'classic'], rating: 'PG', genre: 'Sport' } }),
    film: await asset(me, { title: 'Harbour Lights', schema: movie, mins: 104, ageDays: 30, profile: pFilms, meta: { genre: 'Drama' }, state: 'available' }),
    bare: await asset(me, { title: 'untitled upload', mins: 1, ageDays: 1, meta: {} }),
  };
  const theirs = await asset(them, { title: 'Pacific Cup final: highlights', mins: 12, meta: { genre: 'Sport', keywords: ['cup'] } });

  const fields = await CR.fieldsFor(me.a);
  const match = async (rules: any) => {
    const t = CR.validateRules(rules, fields);
    const m = CR.matchQuery(me.a, t, fields);
    const ids = new Set((await query<{ id: string }>(m.sql, m.params)).map((r) => r.id));
    return Object.entries(A).filter(([, id]) => ids.has(id)).map(([k]) => k).sort();
  };
  const all = (...conditions: any[]) => ({ match: 'all', conditions });
  const c = (field: string, op: string, value?: any) => ({ field, op, value });

  try {
    // ---------------------------------------------------------------- fields
    check('content type fields join the catalogue by their type (image left out)',
      ['meta:season', 'meta:aired', 'meta:keywords', 'meta:rating', 'meta:live_sport'].map((k) => fields.find((f) => f.key === k)?.type).concat(String(!!fields.find((f) => f.key === 'meta:cover'))),
      ['number', 'date', 'tags', 'list', 'boolean', 'false']);

    // ---------------------------------------------------------------- text
    check('text is (case does not matter)', await match(all(c('title', 'is', 'pacific cup semi 1'))), ['semi']);
    check('text is not', await match(all(c('genre', 'is_not', 'sport'))), ['bare', 'film']);
    check('text contains', await match(all(c('title', 'contains', 'FINAL'))), ['finalH', 'old']);
    check('text does not contain', await match(all(c('title', 'not_contains', 'cup'))), ['bare', 'film', 'old']);
    check('text starts with', await match(all(c('title', 'starts_with', 'pacific'))), ['finalH', 'semi']);
    check('text contains treats % and _ as plain characters', await match(all(c('title', 'contains', '%'))), []);
    check('text is empty / not empty', [await match(all(c('genre', 'is_empty'))), await match(all(c('description', 'is_not_empty')))], [['bare'], ['finalH']]);
    check('provider (through the rights profile)', await match(all(c('provider', 'is', 'Example Films'))), ['film']);
    check('channel or event name', await match(all(c('source_name', 'is', 'Sport 24'))), ['finalH', 'semi']);

    // ---------------------------------------------------------------- numbers
    check('number = and ≠', [await match(all(c('meta:season', 'eq', 3))), await match(all(c('meta:season', 'ne', 3)))], [['finalH', 'semi'], ['old']]);
    check('number < ≤ > ≥', [await match(all(c('duration_min', 'lt', 12))), await match(all(c('duration_min', 'lte', 12))), await match(all(c('duration_min', 'gt', 95))), await match(all(c('duration_min', 'gte', 95)))],
      [['bare'], ['bare', 'finalH'], ['film'], ['film', 'semi']]);
    check('number between (either order)', [await match(all(c('duration_min', 'between', [60, 100]))), await match(all(c('duration_min', 'between', [100, 60])))], [['old', 'semi'], ['old', 'semi']]);
    check('number is empty (no season)', await match(all(c('meta:season', 'is_empty'))), ['bare', 'film']);

    // ---------------------------------------------------------------- dates
    check('date before / after', [await match(all(c('meta:aired', 'before', '2000-01-01'))), await match(all(c('meta:aired', 'after', '2026-09-25')))], [['old'], ['finalH']]);
    check('date between', await match(all(c('meta:aired', 'between', ['2026-09-01', '2026-10-31']))), ['finalH', 'semi']);
    check('within the last 7 days (added to the library)', await match(all(c('created_at', 'within_last', { count: 7, unit: 'day' }))), ['bare', 'finalH']);
    check('within the last 2 weeks (first aired)', await match(all(c('first_aired_at', 'within_last', { count: 2, unit: 'week' }))), ['finalH', 'semi']);
    check('not within the last 6 months', await match(all(c('created_at', 'not_within_last', { count: 6, unit: 'month' }))), ['old']);
    check('date is empty (never aired)', await match(all(c('first_aired_at', 'is_empty'))), ['bare', 'film', 'old']);
    check('a metadata date that is not a date is empty, not an error', (await (async () => {
      await query(`UPDATE vod_assets SET metadata = metadata || '{"aired":"sometime"}'::jsonb WHERE id = $1`, [A.bare]);
      return match(all(c('meta:aired', 'is_empty')));
    })()), ['bare', 'film']);

    // ---------------------------------------------------------------- lists, refs, tags, booleans
    check('list is any of / none of', [await match(all(c('meta:rating', 'in', ['PG']))), await match(all(c('meta:rating', 'not_in', ['PG'])))], [['old', 'semi'], ['bare', 'film', 'finalH']]);
    check('list is empty', await match(all(c('meta:rating', 'is_empty'))), ['bare', 'film']);
    check('availability (list)', await match(all(c('availability_state', 'in', ['available']))), ['film', 'finalH']);
    check('how it was made (list)', await match(all(c('origin', 'in', ['upload']))), ['bare', 'film', 'old']);
    check('content type is any of', await match(all(c('content_type', 'in', [movie]))), ['film']);
    check('content type is not set', await match(all(c('content_type', 'is_empty'))), ['bare']);
    check('rights profile is none of', await match(all(c('rights_profile', 'not_in', [pLeague]))), ['bare', 'film']);
    check('channel is any of', await match(all(c('channel', 'in', [me.ch]))), ['finalH', 'semi']);
    check('tags has any / all / none', [await match(all(c('meta:keywords', 'has_any', ['classic', 'cup']))), await match(all(c('meta:keywords', 'has_all', ['cup', 'final']))), await match(all(c('meta:keywords', 'has_none', ['cup'])))],
      [['finalH', 'old', 'semi'], ['finalH'], ['bare', 'film', 'old']]);
    check('tags is empty', await match(all(c('meta:keywords', 'is_empty'))), ['bare', 'film']);
    check('boolean is yes / no', [await match(all(c('meta:live_sport', 'is_true'))), await match(all(c('meta:live_sport', 'is_false')))], [['finalH'], ['bare', 'film', 'old', 'semi']]);

    // ---------------------------------------------------------------- AND, OR, groups
    check('all of (AND)', await match(all(c('genre', 'is', 'Sport'), c('duration_min', 'lt', 60))), ['finalH']);
    check('any of (OR)', await match({ match: 'any', conditions: [c('genre', 'is', 'Drama'), c('duration_min', 'lt', 5)] }), ['bare', 'film']);
    check('nested: Sport AND (aired in the last 2 weeks OR tagged classic)',
      await match(all(c('genre', 'is', 'Sport'), { match: 'any', conditions: [c('first_aired_at', 'within_last', { count: 14, unit: 'day' }), c('meta:keywords', 'has_any', ['classic'])] })),
      ['finalH', 'old', 'semi']);
    check('another account\'s media never matches', (await (async () => {
      const t = CR.validateRules(all(c('title', 'contains', 'Pacific Cup final')), fields);
      const m = CR.matchQuery(me.a, t, fields);
      return (await query<any>(m.sql, m.params)).some((r) => r.id === theirs);
    })()), false);

    // ---------------------------------------------------------------- refusals
    const bad = (rules: any) => { try { CR.validateRules(rules, fields); return 'accepted' } catch (e: any) { return e instanceof CR.RuleError ? 'refused' : 'threw' } };
    check('refused: unknown field, wrong operator, missing value, bad date, bad number, empty group, too deep',
      [bad(all(c('nope', 'is', 'x'))), bad(all(c('title', 'gt', 'x'))), bad(all(c('title', 'is', ''))), bad(all(c('created_at', 'before', 'yesterday-ish'))),
       bad(all(c('duration_min', 'eq', 'ten'))), bad(all()), bad(all(all(all(all(c('title', 'is', 'x'))))))],
      ['refused', 'refused', 'refused', 'refused', 'refused', 'refused', 'refused']);
    check('refused: a list value not in the list, a reference that is not an id', [bad(all(c('origin', 'in', ['satellite']))), bad(all(c('content_type', 'in', ['Movie'])))], ['refused', 'refused']);

    // ---------------------------------------------------------------- over HTTP
    const srv = createServer().listen(0);
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const call = async (method: string, path: string, body?: any, tok = me.tok) => {
      const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let j: any = null; try { j = JSON.parse(t) } catch { j = t }
      return { s: r.status, j };
    };
    try {
      const fl = (await call('GET', '/api/collections/rules/fields')).j;
      check('fields: catalogue, operators and the account\'s choices', [fl.fields.some((f: any) => f.key === 'meta:season'), fl.fields.find((f: any) => f.key === 'content_type').values.length, !!fl.operators.date, fl.fields.some((f: any) => 'sql' in f)],
        [true, 2, true, false]);
      const pv = (await call('POST', '/api/collections/rules/preview', { rules: all(c('genre', 'is', 'Sport')) })).j;
      check('preview: the count and a sample', [pv.count, pv.sample.length], [3, 3]);
      check('preview of bad rules: 400 naming the place', [(await call('POST', '/api/collections/rules/preview', { rules: all(c('title', 'gt', 1)) })).s], [400]);

      const col = (await call('POST', '/api/collections', { name: `Cup ${tag}` })).j;
      // A manual item first, and one the rules will also match.
      await call('POST', `/api/collections/${col.id}/items`, { assetIds: [A.film, A.semi] });
      const saved = await call('PATCH', `/api/collections/${col.id}`, { rules: all(c('title', 'contains', 'cup')) });
      check('saving rules matches at once', [saved.s, saved.j.matched?.added], [200, 1]);
      const items = async () => (await call('GET', `/api/collections/${col.id}/items`)).j.items.map((i: any) => `${Object.entries(A).find(([, id]) => id === i.id)?.[0]}:${i.source}`).sort();
      check('members: rule matches plus what was added by hand (a hand-added match stays manual)', await items(), ['film:manual', 'finalH:rule', 'semi:manual']);

      // Leave one out: the rules do not put it back.
      const out = await call('POST', `/api/collections/${col.id}/items/remove`, { assetIds: [A.finalH] });
      check('taking a rule item out leaves it out', [out.j.leftOut, (await call('GET', `/api/collections/${col.id}/exclusions`)).j.items.length], [1, 1]);
      await call('POST', `/api/collections/${col.id}/recheck`);
      check('a full re-check respects the exclusion', await items(), ['film:manual', 'semi:manual']);
      const back = await call('POST', `/api/collections/${col.id}/exclusions/remove`, { assetIds: [A.finalH] });
      check('let back in: the rules take it again at once', [back.j.letBackIn, back.j.matched, (await items()).includes('finalH:rule')], [1, 1, true]);

      // A change to an asset: queued by the trigger, matched by the queue pass.
      await query(`UPDATE vod_assets SET title = 'Pacific Cup qualifier' WHERE id = $1`, [A.bare]);
      check('a changed asset is queued for re-matching', !!(await one(`SELECT 1 FROM collection_rechecks WHERE vod_asset_id = $1`, [A.bare])), true);
      let drained = 0; for (let i = 0; i < 5 && (drained === 0 || await one(`SELECT 1 FROM collection_rechecks WHERE vod_asset_id = $1`, [A.bare])); i++) drained += await CR.drainRechecks();
      check('the queue pass adds it', (await items()).includes('bare:rule'), true);
      await query(`UPDATE vod_assets SET title = 'untitled upload' WHERE id = $1`, [A.bare]);
      await CR.drainRechecks(); await CR.drainRechecks();
      check('and takes it out when it stops matching', (await items()).some((x: string) => x.startsWith('bare')), false);
      const newOne = await asset(me, { title: 'Pacific Cup round 1', mins: 20 });
      await CR.drainRechecks(); await CR.drainRechecks();
      check('a new asset that matches joins', (await call('GET', `/api/collections/${col.id}/items`)).j.items.some((i: any) => i.id === newOne), true);
      check('an update that changes nothing a rule reads is not queued', (await (async () => {
        await query(`DELETE FROM collection_rechecks`);
        await query(`UPDATE vod_assets SET updated_at = now() WHERE id = $1`, [A.film]);
        return !!(await one(`SELECT 1 FROM collection_rechecks WHERE vod_asset_id = $1`, [A.film]));
      })()), false);

      // The nightly full re-check, and stale after a provider change.
      const col2 = (await call('POST', '/api/collections', { name: `Films ${tag}` })).j;
      await call('PATCH', `/api/collections/${col2.id}`, { rules: all(c('provider', 'is', 'Example Films')) });
      check('provider rule', (await call('GET', `/api/collections/${col2.id}/items`)).j.items.map((i: any) => i.id), [A.film]);
      await call('PUT', `/api/rights/profiles/${pLeague}`, { name: 'League', provider: 'Example Films' });
      check('a provider change marks the collection stale', (await one<any>(`SELECT rules_checked_at FROM collections WHERE id = $1`, [col2.id]))!.rules_checked_at, null);
      await CR.recheckStale(50);
      check('and the stale pass matches it again', (await call('GET', `/api/collections/${col2.id}/items`)).j.items.length, 4);
      await query(`UPDATE collections SET rules_checked_at = now() - interval '2 days' WHERE id = $1`, [col2.id]);
      await query(`UPDATE rights_profiles SET provider = 'Example League' WHERE id = $1`, [pLeague]);   // no API: only the nightly pass sees it
      await CR.recheckStale(50);
      check('the nightly pass catches what nothing queued', (await call('GET', `/api/collections/${col2.id}/items`)).j.items.map((i: any) => i.id), [A.film]);

      // Ordering by a field.
      await call('PATCH', `/api/collections/${col.id}`, { orderBy: '-duration' });
      const ord = (await call('GET', `/api/collections/${col.id}`)).j;
      const lens = (await call('GET', `/api/collections/${col.id}/items`)).j.items.map((i: any) => i.durationMs);
      check('ordered by a field (longest first)', [ord.orderBy, lens.every((d: number, i: number) => i === 0 || lens[i - 1] >= d)], ['-duration', true]);
      check('ordering by hand is refused while ordered by a field', (await call('PUT', `/api/collections/${col.id}/items/order`, { assetIds: [] })).s, 400);
      check('detail: rules, counts and when they were last matched', [!!ord.rules, ord.counts.manual, ord.counts.rule > 0, !!ord.rulesCheckedAt], [true, 2, true, true]);
      check('list: which collections have rules', (await call('GET', '/api/collections')).j.items.find((x: any) => x.id === col.id).hasRules, true);

      // Rules off: what they added goes, what people added stays.
      await call('PATCH', `/api/collections/${col.id}`, { rules: null });
      check('rules taken off: rule items go, manual items stay', await items(), ['film:manual', 'semi:manual']);
      check('bad rules are refused and nothing is saved', [(await call('PATCH', `/api/collections/${col.id}`, { rules: all(c('nope', 'is', 'x')) })).s, (await call('GET', `/api/collections/${col.id}`)).j.rules], [400, null]);
      check('another account cannot read or change it', [(await call('GET', `/api/collections/${col.id}`, undefined, them.tok)).s, (await call('PATCH', `/api/collections/${col.id}`, { rules: null }, them.tok)).s], [404, 404]);
    } finally { srv.close() }

    // ---------------------------------------------------------------- scale
    const big = await mk('big');
    const t0 = Date.now();
    await query(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, metadata, created_at, rights_profile_id)
       SELECT $1, 'upload', 'clip', 'Item ' || g || CASE WHEN g % 10 = 0 THEN ' final' ELSE '' END, 'k', 0, (g % 120) * 60000, (g % 120) * 60000,
              jsonb_build_object('genre', CASE WHEN g % 3 = 0 THEN 'Sport' ELSE 'News' END, 'tags', CASE WHEN g % 7 = 0 THEN '["cup"]'::jsonb ELSE '[]'::jsonb END),
              now() - ((g % 365) || ' days')::interval, volt_rights_builtin($1, 'open')
         FROM generate_series(1, 100000) g`, [big.a]);
    const seedMs = Date.now() - t0;
    await query(`ANALYZE vod_assets`);
    const bc = (await one<any>(`INSERT INTO collections(account_id, name, rules) VALUES ($1, 'Sport finals', $2::jsonb) RETURNING id`,
      [big.a, JSON.stringify(all(c('genre', 'is', 'Sport'), { match: 'any', conditions: [c('title', 'contains', 'final'), c('tags', 'has_any', ['cup'])] }, c('created_at', 'within_last', { count: 6, unit: 'month' })))]))!.id;
    await query(`DELETE FROM collection_rechecks`);
    const r1 = await CR.recompute(bc);
    const r2 = await CR.recompute(bc);
    // The same question asked a different way: straight over the seeded rows.
    const expect = (await one<any>(`SELECT count(*)::int AS n FROM vod_assets WHERE account_id = $1 AND metadata->>'genre' = 'Sport'
        AND (title ILIKE '%final%' OR metadata->'tags' ? 'cup') AND created_at >= now() - interval '6 months'`, [big.a]))!.n;
    console.log(`  scale: seeded 100,000 assets in ${seedMs} ms; first full match ${r1?.ms} ms (${r1?.added} added), second ${r2?.ms} ms (${r2?.added} added, ${r2?.removed} removed)`);
    check('100k library: the full match finds what it should', r1?.members, expect);
    ok('100k library: a first full match in under 10 s', (r1?.ms ?? 1e9) < 10_000, `${r1?.ms} ms`);
    ok('100k library: a repeat full match in under 5 s', (r2?.ms ?? 1e9) < 5_000, `${r2?.ms} ms`);
    const pv0 = Date.now(); const pv = await CR.preview(big.a, CR.validateRules(all(c('genre', 'is', 'Sport')), await CR.fieldsFor(big.a)), await CR.fieldsFor(big.a));
    ok('100k library: the builder\'s live count in under 2 s', Date.now() - pv0 < 2000, `${Date.now() - pv0} ms, ${pv.count} matched`);
    const someIds = (await query<any>(`SELECT id FROM vod_assets WHERE account_id = $1 LIMIT 500`, [big.a])).map((r) => r.id);
    const q0 = Date.now(); await CR.matchAssets(someIds);
    ok('100k library: re-matching a batch of 500 changed assets in under 2 s', Date.now() - q0 < 2000, `${Date.now() - q0} ms`);
  } catch (e: any) {
    console.log('FAIL threw: ' + (e?.stack ?? e)); fail++;
  } finally {
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
