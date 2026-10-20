// ============================================================================
//  THE STREAM AGGREGATE (services/streamModel.ts, /api/live-streams): a
//  channel or event as production + distribution planes, its preset
//  (origin x lifecycle), schema.org BroadcastEvent JSON-LD and the
//  source-provider contract per tier. Real rows, real HTTP.
//    DATABASE_URL=... npx tsx test/stream-model.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const sm = await import('../src/services/streamModel');
  check('preset: live channel', sm.presetOf('channel', { origin: 'live' }).key, 'live_channel');
  check('preset: FAST channel is scheduled playout, continuous', [sm.presetOf('channel', { origin: 'playlist' }).key, sm.presetOf('channel', { origin: 'playlist' }).origin], ['fast_channel', 'scheduled_playout']);
  check('preset: event is live ingest, bounded', [sm.presetOf('event', {}).key, sm.presetOf('event', {}).lifecycle], ['live_event', 'bounded']);
  check('every preset is a distinct origin x lifecycle', new Set(sm.PRESETS.map((p) => `${p.origin}|${p.lifecycle}`)).size, sm.PRESETS.length);

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`sm-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`sm-o-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `sm-${tag}@volt.test`]))!.id;
  const otherUser = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `sm-o-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type, drm_enabled, captions_enabled, caption_source_lang, caption_targets)
     VALUES ($1,'HD transcode','[{"height":1080,"bitrate_kbps":6000},{"height":720,"bitrate_kbps":3000}]','transcode',true,true,'en','["ms"]') RETURNING id`, [acct]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status, on_air, input_failover_enabled, geo_mode, geo_countries, watermark_enabled)
     VALUES ($1,'SM News','live',true,true,'allow',ARRAY['GB'],true) RETURNING id`, [g]))!.id;
  await query(`INSERT INTO stream_inputs(channel_id, role, protocol, ingest_url) VALUES ($1,'primary','srt','srt://a'),($1,'backup','srt','srt://b')`, [ch]);
  const fast = (await one<any>(`INSERT INTO channels(group_id, name, origin) VALUES ($1,'SM FAST','playlist') RETURNING id`, [g]))!.id;
  const sch = (await one<any>(`INSERT INTO metadata_schemas(account_id, name, target_kind, fields, schema_org_type) VALUES ($1,'Football match','event','[]','SportsEvent') RETURNING id`, [acct]).catch(() => null))?.id ?? null;
  const ev = (await one<any>(`INSERT INTO events(group_id, name, status, scheduled_start, scheduled_end, schema_id, metadata) VALUES ($1,'Final','scheduled',now() + interval '1 day', now() + interval '1 day 2 hours',$2,$3) RETURNING id`,
    [g, sch, JSON.stringify({ homeTeam: { name: 'Reds' }, awayTeam: { name: 'Blues' } })]))!.id;

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const get = async (path: string, u = user, a = acct) => {
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${signAccess({ sub: u, account_id: a, role: 'owner' })}` } });
    return { s: res.status, t: res.headers.get('content-type'), j: await res.json().catch(() => null) as any };
  };
  try {
    let r = await get(`/api/live-streams/channel/${ch}`);
    check('channel aggregate: 200', r.s, 200);
    check('...preset live channel', r.j?.preset?.key, 'live_channel');
    check('production: live inputs with failover', [r.j?.production?.origin?.type, r.j?.production?.origin?.inputs?.length, r.j?.production?.origin?.failover], ['live_inputs', 2, true]);
    check('production: processing from the profile', [r.j?.production?.processing?.workflow, r.j?.production?.processing?.ladder?.length, r.j?.production?.processing?.drm], ['transcode', 2, true]);
    check('...watermark burned in on transcode', r.j?.production?.processing?.watermark?.burned_in, true);
    check('...captions source and targets', r.j?.production?.processing?.captions?.targets, ['ms']);
    check('distribution: on air, geo allow list', [r.j?.distribution?.availability?.on_air, r.j?.distribution?.availability?.geo?.mode], [true, 'allow']);
    check('distribution: VideoObject published by a BroadcastEvent on a BroadcastService', [r.j?.distribution?.video_object?.['@type'], r.j?.distribution?.video_object?.publication?.['@type'], r.j?.distribution?.video_object?.publication?.publishedOn?.['@type']], ['VideoObject', 'BroadcastEvent', 'BroadcastService']);
    const tiers = Object.keys(r.j?.provider ?? {});
    check('provider contract: the six tiers', tiers, ['delivery', 'descriptive', 'guide', 'timed', 'rights', 'control']);
    check('...delivery has DRM (cbcs, three systems) and captions', [r.j?.provider?.delivery?.drm?.scheme, r.j?.provider?.delivery?.drm?.systems?.length, r.j?.provider?.delivery?.captions?.format], ['cbcs', 3, 'WebVTT']);
    check('...guide links XMLTV and as-run', [!!r.j?.provider?.guide?.xmltv, !!r.j?.provider?.guide?.as_run], [true, true]);
    r = await get(`/api/live-streams/channel/${fast}`);
    check('FAST channel: scheduled playout origin, a lineup instead of inputs', [r.j?.preset?.key, r.j?.production?.origin?.type], ['fast_channel', 'playlist']);
    r = await get(`/api/live-streams/event/${ev}`);
    check('event: live event preset', r.j?.preset?.key, 'live_event');
    const ld = await get(`/api/live-streams/event/${ev}/schema.org`);
    check('event JSON-LD served as application/ld+json', /application\/ld\+json/.test(ld.t ?? ''), true);
    check('...a BroadcastEvent with dates', [ld.j?.publication?.['@type'], !!ld.j?.publication?.startDate, !!ld.j?.publication?.endDate], ['BroadcastEvent', true, true]);
    check('...broadcast OF the sports fixture (SportsEvent with both teams)', [ld.j?.publication?.broadcastOfEvent?.['@type'], ld.j?.publication?.broadcastOfEvent?.homeTeam?.name, ld.j?.publication?.broadcastOfEvent?.awayTeam?.name], ['SportsEvent', 'Reds', 'Blues']);
    const pv = await get(`/api/live-streams/event/${ev}/provider`);
    check('provider endpoint on its own', Object.keys(pv.j ?? {}).length, 6);
    check('presets list', (await get('/api/live-streams/presets')).j?.length, sm.PRESETS.length);
    check("another account's channel: 404", (await get(`/api/live-streams/channel/${ch}`, otherUser, other)).s, 404);
    check('bad kind: 400', (await get(`/api/live-streams/vod/${ch}`)).s, 400);
    check('not an id: 404', (await get(`/api/live-streams/channel/nope`)).s, 404);
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
