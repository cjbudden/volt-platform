// ============================================================================
//  FAST CHANNEL BRAND: idents between programmes, the brand loop in gaps, and
//  the going-to-air rundown (services/fast/store.ts ChannelBrand, brandedFill,
//  timelineFor; lineup.ts identSec; modules/fast.ts /rundown).
//  Pure planner and fill rules first, then real rows over HTTP.
//    DATABASE_URL=... npx tsx test/fast-brand.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const { planLineup } = await import('../src/services/fast/lineup');
  const { brandedFill } = await import('../src/services/fast/store');

  // ---- planner: 'between' reserves the ident after every programme ----------
  const Z = 'UTC';
  const epoch = new Date('2030-01-01T00:00:00Z');
  const assets = new Map([['a', { id: 'a', title: 'Song A', durationSec: 200 }], ['b', { id: 'b', title: 'Song B', durationSec: 250 }]]);
  const slots: any[] = [{ id: 's1', kind: 'title', pool: [{ assetId: 'a' }] }, { id: 's2', kind: 'title', pool: [{ assetId: 'b' }] }];
  const to = new Date(epoch.getTime() + 3600_000);
  const plain = planLineup({ epoch, zone: Z, slots }, assets, epoch, to).programmes;
  const withId = planLineup({ epoch, zone: Z, slots, identSec: 6 }, assets, epoch, to).programmes;
  check('no ident: back to back on content', [plain[0].end.toISOString(), plain[1].start.toISOString()], ['2030-01-01T00:03:20.000Z', '2030-01-01T00:03:20.000Z']);
  check('ident 6 s: each programme ends 6 s after its content', (withId[0].end.getTime() - withId[0].start.getTime()) / 1000, 206);
  check('...the next starts after the ident', withId[1].start.toISOString(), '2030-01-01T00:03:26.000Z');
  check('...and the ident is in the pad', [withId[0].padSec, withId[1].padSec], [6, 6]);
  check('...content end unchanged', withId[0].contentEnd.toISOString(), '2030-01-01T00:03:20.000Z');
  const grid = planLineup({ epoch, zone: Z, slots, identSec: 6, gridMin: 5 }, assets, epoch, to).programmes;
  check('with a 5 min grid: ident first, grid pad after it, slot still on the grid', [grid[0].end.toISOString(), grid[0].padSec], ['2030-01-01T00:05:00.000Z', 100]);

  // ---- fill rules ----------------------------------------------------------
  const brand = { mode: 'pad' as const, idents: [{ assetId: 'i1', title: 'Sting', durationSec: 6 }, { assetId: 'i2', title: 'Swap', durationSec: 6 }], loopAssetId: 'L' };
  const rest = (sec: number) => [{ kind: 'slate' as const, assetId: 'S', master: 's', durationSec: sec }];
  let f = brandedFill(20, 0, brand, rest, { assetId: 'L', master: 'l' });
  check('gap of 20 s: ident, then the brand loop instead of the slate', f.map((x) => [x.kind, x.assetId, x.durationSec]), [['ident', 'i1', 6], ['slate', 'L', 14]]);
  check('idents rotate by gap', brandedFill(20, 1, brand, rest, null)[0].assetId, 'i2');
  check('no loop set: the slate stays', brandedFill(20, 0, brand, rest, null).map((x) => x.assetId), ['i1', 'S']);
  check('a gap shorter than the ident: no ident', brandedFill(4, 0, brand, rest, null).map((x) => x.kind), ['slate']);
  check('a gap exactly the ident: the ident alone', brandedFill(6, 0, brand, rest, null).map((x) => x.kind), ['ident']);
  check('brand off: as before', brandedFill(20, 0, { ...brand, mode: 'off' }, rest, null).map((x) => x.assetId), ['S']);

  // ---- database + HTTP ------------------------------------------------------
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { timelineFor, adsFor } = await import('../src/services/fast/store');
  const { assetsInUse } = await import('../src/services/fast/prepare');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`fb-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`fb-o-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `fb-${tag}@volt.test`]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name, max_channels) VALUES ($1,'G',50) RETURNING id`, [acct]))!.id;
  const og = (await one<any>(`INSERT INTO groups(account_id, name, max_channels) VALUES ($1,'O',50) RETURNING id`, [other]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, origin) VALUES ($1,'Rentak','playlist') RETURNING id`, [g]))!.id;
  const och = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Theirs') RETURNING id`, [og]))!.id;
  const asset = async (channel: string, title: string, sec: number) => (await one<any>(
    `INSERT INTO vod_assets(channel_id, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, metadata)
     VALUES ($1,'clip',$2,$3,0,$4,$4,'{}') RETURNING id`, [channel, title, `/clips/vod/${title}/master.m3u8`, sec * 1000]))!.id;
  const song = await asset(ch, 'Song', 200);
  const sting = await asset(ch, 'Rentak sting', 6);
  const swap = await asset(ch, 'Rentak swap', 6);
  const loopA = await asset(ch, 'Rentak loop', 30);
  const theirs = await asset(och, 'Their ident', 6);
  const lineup = (await one<any>(`INSERT INTO fast_lineups (channel_id, name, epoch, zone, status) VALUES ($1,'Main',now(),'UTC','active') RETURNING id`, [ch]))!.id;

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const call = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) as any };
  };
  try {
    check('another account\'s ident is refused (404)', (await call('PUT', `/api/fast/channels/${ch}/ads`, { brand: { mode: 'pad', identIds: [theirs] } })).s, 404);
    const put = await call('PUT', `/api/fast/channels/${ch}/ads`, { brand: { mode: 'pad', identIds: [sting, swap], loopAssetId: loopA } });
    check('brand saved: mode, idents resolved, loop', [put.s, put.j.brand.mode, put.j.brand.idents.map((i: any) => i.title), put.j.brand.loopAssetId === loopA], [200, 'pad', ['Rentak sting', 'Rentak swap'], true]);
    check('pad mode reserves no planner time', put.j.brand.identBetweenSec, 0);
    const pol = await call('PUT', `/api/fast/channels/${ch}/ads`, { mode: 'off', policy: { loadMinPerHour: 8 } });
    check('saving the ad policy keeps the brand', pol.j.brand.idents.length, 2);
    const btw = await call('PUT', `/api/fast/channels/${ch}/ads`, { brand: { mode: 'between', identIds: [sting, swap], loopAssetId: loopA } });
    check('between mode: the longest ident, whole segments, reaches the planner', [btw.j.brand.identBetweenSec, btw.j.policy.identBetweenSec], [6, 6]);
    const use = await assetsInUse(ch);
    check('idents and loop are prepared with the channel (roles)', [use.get(sting), use.get(swap), use.get(loopA)], ['ident', 'ident', 'loop']);

    // a programme with 20 s of gap after it, on air now
    const now = Date.now();
    const p1 = new Date(now - 100_000), p1end = new Date(now + 120_000);   // 200 s content + 20 s gap
    await query(`INSERT INTO programmes (channel_id, source_ref, title, starts_at, ends_at, metadata) VALUES ($1,$2,'Song',$3,$4,$5::jsonb)`,
      [ch, `fast:${lineup}:v1:a`, p1, p1end, JSON.stringify({ source: 'fast', vodAssetId: song, contentSec: 200 })]);
    await query(`INSERT INTO programmes (channel_id, source_ref, title, starts_at, ends_at, metadata) VALUES ($1,$2,'Song',$3,$4,$5::jsonb)`,
      [ch, `fast:${lineup}:v1:b`, p1end, new Date(p1end.getTime() + 206_000), JSON.stringify({ source: 'fast', vodAssetId: song, contentSec: 200 })]);
    const tl = await timelineFor(ch, new Date(now - 600_000), new Date(now + 3600_000));
    const filler = tl.items.filter((i: any) => i.kind === 'filler') as any[];
    check('timeline: each gap opens with an ident that carries its media', filler.map((x) => [x.fill[0].kind, !!x.fill[0].master]), [['ident', true], ['ident', true]]);
    check('...the 20 s gap: ident then 14 s of brand loop', filler[0].fill.map((x: any) => [x.kind, x.title, x.durationSec]), [['ident', filler[0].fill[0].title, 6], ['slate', 'Brand loop', 14]]);
    check('consecutive gaps take turns with the idents', filler[0].fill[0].assetId !== filler[1].fill[0].assetId, true);
    const again = await timelineFor(ch, new Date(now - 60_000), new Date(now + 3600_000));
    check('the same gap picks the same ident whatever the window', (again.items.find((i: any) => i.id === filler[0].id) as any)?.fill[0].assetId, filler[0].fill[0].assetId);

    const rd = await call('GET', `/api/fast/channels/${ch}/rundown?hours=1`);
    check('rundown: programme, ident, loop, programme, ident in order', rd.j.items.map((i: any) => i.kind), ['programme', 'ident', 'loop', 'programme', 'ident']);
    check('rundown: times run on without gaps', rd.j.items.every((x: any, i: number, a: any[]) => i === 0 || x.start === a[i - 1].end), true);
    check('rundown: the brand mode', rd.j.brandMode, 'between');
    check('rundown of another account\'s channel: 404', (await call('GET', `/api/fast/channels/${och}/rundown`)).s, 404);
    await call('PUT', `/api/fast/channels/${ch}/ads`, { brand: { mode: 'off', identIds: [sting] } });
    const off = await timelineFor(ch, new Date(now - 600_000), new Date(now + 3600_000));
    check('brand off: gaps are slate again', (off.items.find((i: any) => i.kind === 'filler') as any)?.fill.map((x: any) => x.kind), ['slate']);
    check('adsFor: off', (await adsFor(ch)).brand.mode, 'off');
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
