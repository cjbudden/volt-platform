// ============================================================================
//  A RECORDING WEARS ITS SOURCE'S BRAND (modules/recordings.ts fetchOwned).
//  GET /api/recordings/:id answers the channel's or station's logo
//  (source_brand_ref; null for an event) and what the source is by
//  channels.kind (a station whose radio_config is not written yet is still a
//  station), so the console can show the logo and open the source.
//    DATABASE_URL=... npx tsx test/recording-source-brand.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${w}] got [${g}]`); fail++ }
};

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const mkAcct = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${n}-${tag}@volt.test`]))!.id;
    const p = (await one<any>(`INSERT INTO output_profiles(account_id,name,rungs,workflow_type) VALUES ($1,'p','[]','package_only') RETURNING id`, [a]))!.id;
    const g = (await one<any>(`INSERT INTO groups(account_id,name,output_profile_id) VALUES ($1,'g',$2) RETURNING id`, [a, p]))!.id;
    return { a, g, tok: signAccess({ sub: u, account_id: a, role: 'owner' }) };
  };
  const me = await mkAcct('rsb'), other = await mkAcct('rsbx');
  const CH = (await one<any>(`INSERT INTO channels(group_id, name, kind, brand_ref) VALUES ($1,'News 24','tv','/library/logo-news.png') RETURNING id`, [me.g]))!.id;
  // a station with no radio_config written yet: still a station
  const FM = (await one<any>(`INSERT INTO channels(group_id, name, kind, brand_ref) VALUES ($1,'Suria FM','radio','/library/logo-suria.png') RETURNING id`, [me.g]))!.id;
  const BARE = (await one<any>(`INSERT INTO channels(group_id, name, kind) VALUES ($1,'No logo','tv') RETURNING id`, [me.g]))!.id;
  const EV = (await one<any>(`INSERT INTO events(group_id,name,scheduled_start,scheduled_end) VALUES ($1,'Cup final', now(), now()+interval '2 hours') RETURNING id`, [me.g]))!.id;
  const rec = async (col: 'channel_id' | 'event_id', id: string, kind: string) => (await one<any>(
    `INSERT INTO recordings(kind,${col},status,start_epoch_ms,end_epoch_ms,duration_ms,master_key,day_utc) VALUES ($1,$2,'complete',0,60000,60000,$3,$4) RETURNING id`, [kind, id, `x/${id}`, kind === 'channel_day' ? '2026-11-12' : null]))!.id;
  const rCH = await rec('channel_id', CH, 'channel_day'), rFM = await rec('channel_id', FM, 'channel_day');
  const rBARE = await rec('channel_id', BARE, 'channel_day'), rEV = await rec('event_id', EV, 'event');

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const get = async (path: string, tok = me.tok) => { const r = await fetch(base + path, { headers: { authorization: `Bearer ${tok}` } }); return { s: r.status, j: await r.json().catch(() => null) }; };
  try {
    const ch = await get(`/api/recordings/${rCH}`);
    check('a channel recording: its channel, the channel\'s logo, type channel', [ch.s, ch.j.channel_id, ch.j.source_brand_ref, ch.j.source_type, ch.j.source_name], [200, CH, '/library/logo-news.png', 'channel', 'News 24']);
    const fm = await get(`/api/recordings/${rFM}`);
    check('a station recording: the station\'s logo, type radio by channels.kind (no radio_config yet)', [fm.j.source_brand_ref, fm.j.source_type], ['/library/logo-suria.png', 'radio']);
    check('a channel with no logo: null', (await get(`/api/recordings/${rBARE}`)).j.source_brand_ref, null);
    const ev = await get(`/api/recordings/${rEV}`);
    check('an event recording: its event, no logo, type event', [ev.j.event_id, ev.j.source_brand_ref, ev.j.source_type], [EV, null, 'event']);
    check('another account cannot read it', (await get(`/api/recordings/${rCH}`, other.tok)).s, 404);
    const list = await get(`/api/recordings?sourceId=${FM}`);
    const rows = Array.isArray(list.j) ? list.j : list.j?.items ?? list.j?.data ?? [];
    check('the list says the station is radio too', rows.find((r: any) => r.id === rFM)?.source_type, 'radio');
    const src = await get(`/api/recordings/sources`);
    const s = (src.j?.sources ?? []).find((x: any) => x.id === FM);
    check('the sources list gives the station\'s logo and type', [s?.brandRef, s?.type], ['/library/logo-suria.png', 'radio']);
  } finally { srv.close(); await pool.end(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
