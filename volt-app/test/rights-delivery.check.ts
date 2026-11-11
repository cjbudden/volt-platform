// ============================================================================
//  RIGHTS DELIVERY COUNTS (services/rightsDelivery.ts). No database needed.
//
//  1. Viewers: the HyperLogLog is exact-ish when small, within a few per cent
//     when large, and merging two halves gives the count of the whole.
//  2. The request path: a counter in memory per channel, 15 s bucket, country
//     and outcome; 200 000 requests from 50 000 viewers stay a handful of
//     counters and take well under a second.
//  3. The CDN log lines: the channel's own playlists are "viewed", variant
//     paths "replaced", 451s "blocked"; masters and segments are not counted.
//  4. Attribution: each bucket goes to the programme on air at its middle; a
//     change of programme at 21:00 splits viewers correctly.
//  5. The report pivot: per programme in schedule order, totals and per
//     country, viewers merged across countries without double counting.
//    npx tsx test/rights-delivery.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected ${w} got ${g}`); fail++ }
};
const near = (m: string, got: number, want: number, tol: number) => check(`${m} (${got} vs ${want})`, Math.abs(got - want) <= tol * want, true);

(async () => {
  const rd = await import('../src/services/rightsDelivery');
  const R = () => new Uint8Array(rd.REGISTERS);

  // ---- 1. viewers ------------------------------------------------------------------------------
  for (const n of [1, 10]) { const r = R(); for (let i = 0; i < n; i++) rd.hllAdd(r, `v${i}`); check(`${n} viewers counted as ${n}`, rd.hllCount(r), n); }
  for (const n of [100, 300]) { const r = R(); for (let i = 0; i < n; i++) rd.hllAdd(r, `v${i}`); near(`${n} viewers within 2 %`, rd.hllCount(r), n, 0.02); }
  for (const n of [1000, 100000]) { const r = R(); for (let i = 0; i < n; i++) rd.hllAdd(r, `v${i}`); near(`${n} viewers within 4 %`, rd.hllCount(r), n, 0.04); }
  { const r = R(); for (let k = 0; k < 5; k++) for (let i = 0; i < 300; i++) rd.hllAdd(r, `v${i}`); const one = R(); for (let i = 0; i < 300; i++) rd.hllAdd(one, `v${i}`); check('a viewer reloading many times is one viewer (300 viewers x 5 reloads count as 300 do)', rd.hllCount(r), rd.hllCount(one)); }
  { const a = R(), b = R(), all = R(); for (let i = 0; i < 20000; i++) { rd.hllAdd(i % 2 ? a : b, `v${i}`); rd.hllAdd(all, `v${i}`); } check('two halves merged count as the whole', rd.hllCount(rd.hllMerge(a, b)), rd.hllCount(all)); }

  // ---- 2. the request path ---------------------------------------------------------------------
  rd.resetDelivery();
  const CH = '11111111-1111-1111-1111-111111111111';
  const t0 = Date.UTC(2027, 0, 1, 20, 59, 0);
  const s = Date.now();
  for (let i = 0; i < 200000; i++) rd.recordDelivery({ channelId: CH, outcome: i % 5 ? 'viewed' : 'replaced', country: i % 5 ? 'AU' : 'GB', viewer: `p${i % 50000}`, at: t0 + (i % 8) * 15000 });
  const took = Date.now() - s;
  const held = rd.deliveryPending();
  check(`200 000 requests from 50 000 viewers over 2 minutes: ${held.length} counters (8 buckets x 2 outcomes)`, held.length, 16);
  check(`...recorded in under 3 s on this machine (${took} ms)`, took < 3000, true);
  check('nothing written on the request path (no flush ran)', rd.rightsDeliveryStats.flushes, 0);
  rd.recordDelivery({ channelId: 'not-a-uuid', outcome: 'viewed' });
  check('a bad channel id is ignored, never thrown', rd.rightsDeliveryStats.ignored, 1);

  // ---- 3. CDN log lines ------------------------------------------------------------------------
  rd.resetDelivery();
  const at = t0 + 30000;
  const L = (path: string, status = 200) => rd.recordEdgeLine({ path, status, country: 'GB', at }, 'sid:x');
  L(`/channel/${CH}/fast/v720.m3u8`); L(`/channel/${CH}/v/vabcdef01/fast/v720.m3u8`); L(`/channel/${CH}/fast/manifest.mpd`, 451);
  L(`/channel/${CH}/fast/master.m3u8`); L(`/clips/vod/aaaa/720p/seg_1.m4s`); L(`/channel/${CH}/fast/v720.m3u8`, 503);
  check('CDN lines: own playlist viewed, variant replaced, 451 blocked; master, segments and errors not counted',
    rd.deliveryPending().map((c) => c.outcome).sort(), ['blocked', 'replaced', 'viewed']);

  // ---- 4. attribution --------------------------------------------------------------------------
  rd.resetDelivery();
  const P1 = { id: 'p1', title: 'Film (AU, NZ)', starts_at: new Date(Date.UTC(2027, 0, 1, 19, 30)), ends_at: new Date(Date.UTC(2027, 0, 1, 21, 0)) };
  const P2 = { id: 'p2', title: 'Open show', starts_at: new Date(Date.UTC(2027, 0, 1, 21, 0)), ends_at: new Date(Date.UTC(2027, 0, 1, 22, 0)) };
  for (let i = 0; i < 40; i++) rd.recordDelivery({ channelId: CH, outcome: 'replaced', country: 'GB', viewer: `g${i}`, at: Date.UTC(2027, 0, 1, 20, 59, 50) });
  for (let i = 0; i < 40; i++) rd.recordDelivery({ channelId: CH, outcome: 'viewed', country: 'GB', viewer: `g${i}`, at: Date.UTC(2027, 0, 1, 21, 0, 20) });
  for (let i = 0; i < 25; i++) rd.recordDelivery({ channelId: CH, outcome: 'viewed', country: 'AU', viewer: `a${i}`, at: Date.UTC(2027, 0, 1, 20, 59, 50) });
  const rows = rd.rowsFor(rd.deliveryPending(), new Map([[CH, { accountId: '22222222-2222-2222-2222-222222222222' }]]), new Map([[CH, [P1, P2]]]));
  const brief = rows.map((r) => [r.programme_id, r.country, r.outcome, Math.round(rd.hllCount(r.regs) / 5) * 5]).sort();
  check('the 20:59:50 bucket goes to the film, 21:00:20 to the show (viewers to the nearest 5)', brief, [['p1', 'AU', 'viewed', 25], ['p1', 'GB', 'replaced', 40], ['p2', 'GB', 'viewed', 40]].sort());
  check('...each row carries its programme\'s schedule', rows.find((r) => r.programme_id === 'p2')!.starts_at, P2.starts_at.toISOString());
  check('a channel that is not FAST writes nothing', rd.rowsFor(rd.deliveryPending(), new Map([[CH, null]]), new Map()).length, 0);

  // ---- 5. the pivot ----------------------------------------------------------------------------
  const stored = rows.map((r) => ({ ...r, hll: Buffer.from(r.regs) }));
  const pv = rd.pivot(stored);
  check('report: programmes in schedule order', pv.programmes.map((p) => p.title), ['Film (AU, NZ)', 'Open show']);
  const tot = pv.programmes[0].totals;
  check('...the film: 25 saw it (AU), 40 saw the replacement (GB), 0 refused (within 1)', [Math.abs(tot.viewed.viewers - 25) <= 1, Math.abs(tot.replaced.viewers - 40) <= 1, tot.blocked.viewers], [true, true, 0]);
  check('...per country, largest first', pv.programmes[0].countries.map((c) => c.country), ['GB', 'AU']);
  check(`...the period's viewers: 65 (${pv.totals.viewers}), the 40 GB viewers counted once across both programmes`, Math.abs(pv.totals.viewers - 65) <= 1, true);

  // ---- 6. stored form and the roll-up -----------------------------------------------------------
  { const r = R(); for (let i = 0; i < 20; i++) rd.hllAdd(r, `v${i}`); const e = rd.encodeRegs(r);
    check(`20 viewers stored sparse: ${e.length} bytes, not 4097`, e.length < 100 && e[0] === 1, true);
    check('...and read back the same', Buffer.from(rd.decodeRegs(e)).equals(Buffer.from(r)), true); }
  { const r = R(); for (let i = 0; i < 20000; i++) rd.hllAdd(r, `v${i}`); const e = rd.encodeRegs(r);
    check('20 000 viewers stored dense (4097 bytes) and read back the same', [e.length, Buffer.from(rd.decodeRegs(e)).equals(Buffer.from(r))], [4097, true]); }
  { const base = { account_id: 'a', channel_id: 'c', day: '2027-01-01', programme_id: 'p1', country: 'GB', outcome: 'replaced', title: 'Film', starts_at: null, ends_at: null };
    const enc = (from: number, to: number) => { const r = R(); for (let i = from; i < to; i++) rd.hllAdd(r, `v${i}`); return rd.encodeRegs(r); };
    const rolled = [{ ...base, requests: 100, hll: enc(0, 50) }];
    const mins = [{ ...base, requests: 30, hll: enc(40, 80) }, { ...base, requests: 20, hll: enc(70, 90) }, { ...base, country: 'US', requests: 5, hll: enc(0, 5) }];
    const out = rd.rollUp(rolled as any, mins as any);
    const gb = out.find((x) => x.country === 'GB')!;
    check('roll-up: GB keeps one row, requests added (150), viewers merged (90 distinct)', [out.length, gb.requests, Math.abs(rd.hllCount(rd.decodeRegs(gb.hll)) - 90) <= 2], [2, 150, true]); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
