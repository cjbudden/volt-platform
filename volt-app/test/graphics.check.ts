// ============================================================================
//  HTML GRAPHICS end to end against Postgres and the real HTTP app:
//  templates (paste, upload, checks, publish, immutability, serving), Volt
//  defaults, data sources (poll + push), setups, assignments (packaging and
//  radio refused), live state (overrides, log), the day plan, event rundowns
//  (take next, feed cues, timers, CSV, copy), tenancy and permissions.
//
//  Usage: DATABASE_URL=... npx tsx test/graphics.check.ts   (a migrated, disposable database)
// ============================================================================
import { createServer as httpServer } from 'node:http';
process.env.GRAPHICS_ALLOW_PRIVATE_FEEDS = '1';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { ensureDefaultTemplates } = await import('../src/services/graphics/defaults');
  const { tick } = await import('../src/services/graphics/runtime');
  const { writeZip } = await import('../src/services/graphics/zip');
  const { requirementFor } = await import('../src/auth/roles');

  // ---- a feed to poll ----
  let feed: any = { score: { home: 21, away: 17 }, clock: '62:14' };
  const feedSrv = httpServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(feed)); }).listen(0);
  const feedUrl = `http://127.0.0.1:${(feedSrv.address() as any).port}/match.json`;

  // ---- seed ----
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`gfx-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`gfx-other-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `gfx-${tag}@volt.test`]))!.id;
  const otherUser = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `gfx-o-${tag}@volt.test`]))!.id;
  const profT = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const profP = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'P','[]','package_only') RETURNING id`, [acct]))!.id;
  const gT = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'GT',$2) RETURNING id`, [acct, profT]))!.id;
  const gP = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'GP',$2) RETURNING id`, [acct, profP]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'TV1 News','live') RETURNING id`, [gT]))!.id;
  const chPkg = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'TV2 Sport') RETURNING id`, [gP]))!.id;
  const radio = (await one<any>(`INSERT INTO channels(group_id, name, kind) VALUES ($1,'Radio 1','radio') RETURNING id`, [gT]))!.id;
  const now = Date.now();
  const ev = (await one<any>(`INSERT INTO events(group_id, name, status, scheduled_start, scheduled_end, actual_start) VALUES ($1,'Super Rugby R9','live',$2,$3,$2) RETURNING id`,
    [gT, new Date(now - 5 * 60_000), new Date(now + 2 * 3600_000)]))!.id;
  const ev2 = (await one<any>(`INSERT INTO events(group_id, name, scheduled_start, scheduled_end) VALUES ($1,'Super Rugby R10',$2,$3) RETURNING id`,
    [gT, new Date(now + 7 * 86400_000), new Date(now + 7 * 86400_000 + 7200_000)]))!.id;
  const P = (title: string, a: number, b: number, md: any) =>
    query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at, metadata) VALUES ($1,$2,$3,$4,$5::jsonb)`, [ch, title, new Date(now + a * 60_000), new Date(now + b * 60_000), JSON.stringify(md)]);
  await P('Morning Show', -120, -30, { genre: 'Entertainment' });
  await P('Midday News', -30, 30, { genre: 'News', subtitle: 'Live from the harbour' });
  await P('Ad break', 30, 33, { kind: 'ad' });
  await P('Evening Bulletin', 33, 90, { genre: ['News'] });

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const tokOther = signAccess({ sub: otherUser, account_id: other, role: 'owner' });
  const api = async (method: string, path: string, body?: any, o: { token?: string; type?: string; raw?: Buffer | string } = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${o.token ?? tok}` };
    let b: any;
    if (o.raw !== undefined) { b = o.raw; headers['content-type'] = o.type ?? 'application/octet-stream'; }
    else if (body !== undefined) { b = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    const r = await fetch(base + path, { method, headers, body: b });
    const text = await r.text(); let j: any = null; try { j = JSON.parse(text); } catch { j = text; }
    return { s: r.status, j, h: r.headers };
  };

  try {
    console.log('== Volt defaults ==');
    const added = await ensureDefaultTemplates();
    const again = await ensureDefaultTemplates();
    ok(again === 0, `defaults are idempotent (added ${added}, then ${again})`);
    let r = await api('GET', '/api/graphics/templates');
    if (!r.j.items) console.log("DEBUG", r.s, JSON.stringify(r.j).slice(0, 400));
    const volt = r.j.items.filter((t: any) => t.owner === 'volt');
    ok(r.s === 200 && volt.length >= 5 && volt.every((t: any) => t.latest?.version >= 1 && t.latest.publishable), `5 Volt templates, published (${volt.length})`);
    const scorebug = volt.find((t: any) => t.kind === 'scorebug');
    const lower = volt.find((t: any) => t.kind === 'lower_third');
    r = await api('PATCH', `/api/graphics/templates/${scorebug.id}`, { name: 'Mine' });
    ok(r.s === 400 && /read-only/.test(r.j.error ?? r.j.message ?? JSON.stringify(r.j)), 'Volt templates are read-only');
    r = await api('GET', '/api/graphics/templates', undefined, { token: tokOther });
    ok(r.j.items.some((t: any) => t.id === scorebug.id), 'every account sees the Volt templates');

    console.log('== paste, checks, publish ==');
    const bad = `<script type="application/json" id="volt-manifest">{"name":"Results bar","canvas":[1920,1080],"fields":[{"id":"title","type":"text"},{"id":"counted","type":"number"}]}</script>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow"><div id="b"></div>
      <script>function update(d){} function play(){} function stop(){}</script>`;
    r = await api('POST', '/api/graphics/templates', { html: bad, kind: 'lower_third' });
    const results = r.j;
    ok(r.s === 201 && results.name === 'Results bar' && results.draft && !results.draft.publishable, 'paste makes a draft, named from the manifest, not publishable', JSON.stringify(r.j).slice(0, 200));
    r = await api('POST', `/api/graphics/templates/${results.id}/draft/publish`);
    ok(r.s === 409 && /internet/i.test(JSON.stringify(r.j)), 'publishing is refused with the reason', JSON.stringify(r.j).slice(0, 200));
    r = await api('PUT', `/api/graphics/templates/${results.id}/draft`, { html: bad.replace(/<link[^>]+>/, '') });
    ok(r.s === 200 && r.j.publishable, 'replacing the draft clears the check');
    r = await api('POST', `/api/graphics/templates/${results.id}/draft/publish`, { note: 'first' });
    const v1 = r.j;
    ok(r.s === 200 && v1.version === 1 && v1.status === 'published', 'published as v1');
    r = await api('POST', `/api/graphics/templates/${results.id}/draft/publish`);
    ok(r.s === 404, 'no draft left to publish');
    let blocked = false;
    try { await query(`UPDATE gfx_files SET content = 'x' WHERE version_id = $1`, [v1.id]); } catch { blocked = true; }
    ok(blocked, 'the database refuses to change a published version’s files');
    blocked = false;
    try { await query(`UPDATE gfx_template_versions SET manifest = '{}' WHERE id = $1`, [v1.id]); } catch { blocked = true; }
    ok(blocked, 'and its manifest');

    console.log('== upload ==');
    const zip = writeZip([
      { path: 'sponsor/index.html', data: Buffer.from(`<script type="application/json" id="volt-manifest">{"name":"Sponsor bug","canvas":[1920,1080],"fields":[{"id":"logo","type":"image"}]}</script><img src="img/a.png"><script>function update(){} function play(){} function stop(){}</script>`) },
      { path: 'sponsor/img/a.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    r = await api('POST', '/api/graphics/templates/import?kind=bug&filename=sponsor.zip', undefined, { raw: zip, type: 'application/zip' });
    const sponsor = r.j;
    ok(r.s === 201 && sponsor.source === 'upload' && sponsor.draft.fileCount === 2 && sponsor.draft.publishable, 'zip upload: folder stripped, 2 files, publishable', JSON.stringify(r.j).slice(0, 300));
    r = await api('POST', '/api/graphics/templates/import', undefined, { raw: Buffer.from('PK\x03\x04garbage'), type: 'application/zip' });
    ok(r.s === 400, 'a damaged zip is a 400, not a 500', JSON.stringify(r.j));
    r = await api('GET', `/api/graphics/templates/${sponsor.id}/versions/${sponsor.draft.id}/files`);
    ok(r.j.items?.map((f: any) => f.path).join() === 'img/a.png,index.html', 'file list');

    console.log('== serving ==');
    let f = await fetch(`${base}/gfx/${sponsor.draft.id}/index.html`);
    let body = await f.text();
    ok(f.status === 200 && /sandbox allow-scripts/.test(f.headers.get('content-security-policy') ?? '') && new RegExp(`connect-src http://[^ ;]+/gfx/${sponsor.draft.id}/;`).test(f.headers.get('content-security-policy') ?? ''), 'served sandboxed, network limited to its own package', f.headers.get('content-security-policy') ?? '');
    ok(body.includes("type!=='volt-gfx'") && body.includes('<img src="img/a.png">'), 'bridge injected, file otherwise as uploaded');
    ok(f.headers.get('cache-control') === 'no-store', 'a draft is never cached');
    f = await fetch(`${base}/gfx/${v1.id}/index.html`);
    ok(/immutable/.test(f.headers.get('cache-control') ?? ''), 'a published version is cached for good');
    f = await fetch(`${base}/gfx/${sponsor.draft.id}/img/a.png`);
    ok(f.status === 200 && f.headers.get('content-type') === 'image/png' && (await f.arrayBuffer()).byteLength === 4, 'package files served with their type');
    f = await fetch(`${base}/gfx/${sponsor.draft.id}/..%2F..%2Fetc%2Fpasswd`);
    ok(f.status === 404, 'nothing outside the package');
    r = await api('GET', `/api/graphics/templates/${sponsor.id}/versions/${sponsor.draft.id}/download`);
    ok(r.s === 200 && r.h.get('content-type') === 'application/zip', 'download as zip');

    console.log('== ograf ==');
    {
      const { readdirSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const dir = join(__dirname, 'fixtures', 'ograf', 'scoreboard');
      const ozip = writeZip(readdirSync(dir).map((n) => ({ path: `scoreboard/${n}`, data: readFileSync(join(dir, n)) })));
      r = await api('POST', '/api/graphics/templates/import?kind=scorebug&filename=scoreboard.zip', undefined, { raw: ozip, type: 'application/zip' });
      const og = r.j;
      ok(r.s === 201 && og.name === 'Live Scoreboard' && og.draft?.manifest?.contract === 'ograf' && og.draft.publishable && og.draft.manifest.fields.length === 8, 'EBU OGraf zip imports: named, 8 fields, publishable', JSON.stringify(r.j).slice(0, 300));
      let g = await fetch(`${base}/gfx/${og.draft.id}/index.html`);
      let page = await g.text();
      ok(g.status === 200 && /text\/html/.test(g.headers.get('content-type') ?? '') && page.includes("customElements.define('volt-ograf-graphic'") && page.includes("type!=='volt-gfx'"), 'index.html is the generated host page, with the bridge');
      ok(/sandbox allow-scripts/.test(g.headers.get('content-security-policy') ?? '') && g.headers.get('cache-control') === 'no-store', 'host page sandboxed, draft not cached');
      g = await fetch(`${base}/gfx/${og.draft.id}/graphic.mjs`);
      ok(g.status === 200 && /text\/javascript/.test(g.headers.get('content-type') ?? '') && g.headers.get('access-control-allow-origin') === '*', 'the module is served for import from the sandbox');
      r = await api('GET', `/api/graphics/templates/${og.id}/versions/${og.draft.id}/source`);
      ok(r.s === 200 && r.j.path === 'graphic.mjs' && /export default/.test(r.j.html), 'Edit code opens the main module');
      r = await api('PUT', `/api/graphics/templates/${og.id}/draft`, { path: 'graphic.mjs', html: r.j.html.replace('Live Scoreboard', 'Live Scoreboard (edited)'), keep: true });
      ok(r.s === 200 && r.j.manifest?.contract === 'ograf' && r.j.fileCount === 2 && r.j.publishable, 'saving the module keeps the manifest: still OGraf, publishable', JSON.stringify(r.j).slice(0, 300));
      r = await api('POST', `/api/graphics/templates/${og.id}/draft/publish`);
      const ogV = r.j;
      g = await fetch(`${base}/gfx/${ogV.id}/index.html`);
      ok(g.status === 200 && /immutable/.test(g.headers.get('cache-control') ?? ''), 'published host page cached for good');
      const dl = await fetch(`${base}/api/graphics/templates/${og.id}/versions/${ogV.id}/download`, { headers: { authorization: `Bearer ${tok}` } });
      const back = (await import('../src/services/graphics/zip')).readZip(Buffer.from(await dl.arrayBuffer()), { maxEntries: 50, maxTotalBytes: 1e8 });
      ok(back.map((x: any) => x.path).sort().join() === 'graphic.mjs,scoreboard.ograf.json', 'download is the OGraf package as uploaded, no host page');
      r = await api('PUT', `/api/graphics/templates/${og.id}/draft`, { html: '<p>x</p>' });
      ok(r.s === 200 && r.j.manifest?.contract !== 'ograf' && r.j.fileCount === 1, 'a paste without keep replaces the whole package (as before)');
      await api('DELETE', `/api/graphics/templates/${og.id}/draft`);
    }

    console.log('== duplicate ==');
    r = await api('POST', `/api/graphics/templates/${scorebug.id}/duplicate`, { name: 'Rugby scorebug' });
    const rugby = r.j;
    ok(r.s === 201 && rugby.source === 'duplicate' && rugby.draft?.publishable, 'duplicate of a Volt template is an editable draft');
    r = await api('POST', `/api/graphics/templates/${rugby.id}/draft/publish`);
    const rugbyV1 = r.j;

    console.log('== data sources ==');
    r = await api('POST', '/api/graphics/sources', { name: 'Match feed', kind: 'json', url: feedUrl, everySec: 1, staleAfterSec: 30 });
    const src = r.j;
    ok(r.s === 201 && src.status === 'waiting', 'json source created');
    r = await api('POST', `/api/graphics/sources/${src.id}/test`);
    ok(r.j.ok && r.j.payload?.score?.home === 21, 'test fetch returns the payload');
    r = await api('POST', '/api/graphics/sources', { name: 'Push', kind: 'push' });
    const push = r.j;
    r = await api('POST', `/api/graphics/sources/${push.id}/push`, { lastEvent: { type: 'kickoff' } });
    ok(r.s === 200 && r.j.changed === true, 'push accepted');
    r = await api('POST', `/api/graphics/sources/${src.id}/push`, { x: 1 });
    ok(r.s === 400, 'a polled source refuses pushes');
    process.env.GRAPHICS_ALLOW_PRIVATE_FEEDS = '0';
    r = await api('POST', '/api/graphics/sources', { name: 'Sneaky', kind: 'json', url: 'http://169.254.169.254/latest/meta-data' });
    ok(r.s === 400 && /private/.test(JSON.stringify(r.j)), 'private network feed URLs refused');
    process.env.GRAPHICS_ALLOW_PRIVATE_FEEDS = '1';

    console.log('== setups ==');
    r = await api('POST', '/api/graphics/setups', { name: 'Bad', versionId: rugbyV1.id, fields: { nope: { source: 'text', value: 'x' } } });
    ok(r.s === 400 && /no such field/.test(JSON.stringify(r.j)), 'unknown field refused');
    r = await api('POST', '/api/graphics/setups', { name: 'Blues v Chiefs', versionId: rugbyV1.id, placement: { anchor: 'top_left', x: 0, y: 0, scale: 1, layer: 2 },
      fields: { home: { source: 'text', value: 'BLUES' }, away: { source: 'text', value: 'CHIEFS' },
        homeScore: { source: 'feed', sourceId: src.id, path: 'score.home' }, awayScore: { source: 'feed', sourceId: src.id, path: 'score.away' },
        clock: { source: 'feed', sourceId: src.id, path: 'clock' }, period: { source: 'operator', value: '1ST HALF' } } });
    const setup = r.j;
    ok(r.s === 201 && setup.version === 1 && setup.sources.sort().join() === 'feed,operator,text', 'setup saved, pinned to v1', JSON.stringify(r.j).slice(0, 300));
    r = await api('POST', '/api/graphics/setups', { name: 'Presenter super', versionId: lower.latest.id, fields: { name: { source: 'operator' }, title: { source: 'operator' } } });
    const superSetup = r.j;
    r = await api('POST', '/api/graphics/setups', { name: 'Programme title', versionId: lower.latest.id, fields: { name: { source: 'guide', guide: 'now_title' }, title: { source: 'guide', guide: 'now_subtitle' } } });
    const titleSetup = r.j;
    r = await api('GET', `/api/graphics/templates/${rugby.id}`);
    ok(r.j.usedBy?.length === 1 && r.j.usedBy[0].setupName === 'Blues v Chiefs', 'template shows the setups using it');

    console.log('== assignments ==');
    r = await api('POST', '/api/graphics/assignments', { setupId: setup.id, channelId: chPkg, targets: 'burn' });
    ok(r.s === 400 && /packaging only/.test(JSON.stringify(r.j)), 'burn on a packaging-only channel refused');
    r = await api('POST', '/api/graphics/assignments', { setupId: setup.id, channelId: radio });
    ok(r.s === 400 && /Radio/.test(JSON.stringify(r.j)), 'radio refused');
    r = await api('POST', '/api/graphics/assignments', { setupId: setup.id, channelId: chPkg, targets: 'player' });
    ok(r.s === 201, 'player overlay on a packaging-only channel is fine');
    r = await api('POST', '/api/graphics/assignments', { setupId: setup.id, channelId: ch, targets: 'burn', runMode: 'always' });
    const aAlways = r.j;
    ok(r.s === 201 && aAlways.describe === 'Whenever the channel is on air', 'always assignment', JSON.stringify(r.j));
    r = await api('POST', '/api/graphics/assignments', { setupId: titleSetup.id, channelId: ch, targets: 'both', runMode: 'rule', rule: { genre: 'News' } });
    const aRule = r.j;
    r = await api('POST', '/api/graphics/assignments', { setupId: superSetup.id, channelId: ch, runMode: 'trigger', rule: { at: 'programme_end', offsetSec: 120, durationSec: 12 } });
    const aTrig = r.j;
    ok(aTrig.describe === '2 min before each programme ends, for 12 s', 'trigger described');
    r = await api('POST', '/api/graphics/assignments', { setupId: superSetup.id, channelId: ch, runMode: 'rule', rule: { nonsense: 1 } });
    ok(r.s === 422, 'unknown rule keys refused', `${r.s} ${JSON.stringify(r.j).slice(0, 200)}`);

    console.log('== live ==');
    await api('POST', `/api/graphics/sources/${src.id}/test`);
    r = await api('GET', `/api/graphics/live?channel_id=${ch}`);
    const byId = (id: string) => r.j.items.find((i: any) => i.id === id);
    ok(r.s === 200 && byId(aAlways.id)?.onAir && byId(aAlways.id).values.homeScore === 21 && byId(aAlways.id).values.home === 'BLUES' && byId(aAlways.id).values.period === '1ST HALF', 'always on, values from text, feed and operator', JSON.stringify(byId(aAlways.id)?.values));
    ok(byId(aRule.id)?.onAir && byId(aRule.id).values.name === 'Midday News' && byId(aRule.id).values.title === 'Live from the harbour', 'rule on during News, title from the guide', JSON.stringify(byId(aRule.id)));
    ok(byId(aTrig.id)?.onAir === false, 'trigger waiting');
    r = await api('PATCH', `/api/graphics/assignments/${aAlways.id}/state`, { values: { homeScore: 'x' } });
    ok(r.s === 400 && /number/.test(JSON.stringify(r.j)), 'type-checked values');
    r = await api('PATCH', `/api/graphics/assignments/${aAlways.id}/state`, { values: { homeScore: 28, period: '2ND HALF' } });
    ok(r.s === 200 && r.j.state.values.homeScore === 28 && r.j.state.origin.homeScore === 'override' && r.j.state.overrides.includes('homeScore'), 'a feed field set by hand is taken over');
    r = await api('PATCH', `/api/graphics/assignments/${aAlways.id}/state`, { values: { homeScore: 28 } });
    ok(r.j.changed === 0, 'the same value again is a no-op');
    feed = { score: { home: 35, away: 17 }, clock: '70:00' };
    await api('POST', `/api/graphics/sources/${src.id}/test`);
    r = await api('GET', `/api/graphics/assignments/${aAlways.id}/state`);
    ok(r.j.values.homeScore === 28 && r.j.values.clock === '70:00', 'the feed keeps updating other fields, not the taken-over one');
    r = await api('PATCH', `/api/graphics/assignments/${aAlways.id}/state`, { release: ['homeScore'] });
    ok(r.j.state.values.homeScore === 35 && r.j.state.origin.homeScore === 'feed', 'handed back to the feed');
    r = await api('POST', `/api/graphics/assignments/${aTrig.id}/air`, { on: true, forSec: 30 });
    ok(r.j.state.onAir && r.j.state.reason === 'taken on by hand' && r.j.state.offAt, 'a trigger graphic taken by hand, with a timer');
    r = await api('GET', `/api/graphics/log?assignment_id=${aAlways.id}`);
    const actions = r.j.items.map((l: any) => `${l.action}:${l.field ?? ''}`);
    ok(actions.includes('set:homeScore') && actions.includes('release:homeScore') && r.j.items.every((l: any) => l.actor), 'every change logged with who', actions.join());
    const setLog = r.j.items.find((l: any) => l.action === 'set' && l.field === 'period');
    ok(setLog && setLog.old == null && setLog.new === '2ND HALF', 'old and new values logged');

    console.log('== plan ==');
    const from = new Date(now - 3 * 3600_000).toISOString(), to = new Date(now + 3 * 3600_000).toISOString();
    r = await api('GET', `/api/graphics/plan?channel_id=${ch}&from=${from}&to=${to}`);
    const pl = (id: string) => r.j.assignments.find((a: any) => a.id === id);
    ok(r.s === 200 && r.j.programmes.length === 4, 'plan has the guide');
    ok(pl(aRule.id)?.windows.length === 2, 'rule: both News programmes', JSON.stringify(pl(aRule.id)));
    ok(pl(aAlways.id)?.windows.length === 2, 'always: split by the ad break');
    ok(pl(aTrig.id)?.windows.length === 3, 'trigger: one per content programme');

    console.log('== rundown ==');
    r = await api('POST', `/api/graphics/rundowns/${ev}/items`, { segment: 'Pre-match', title: 'Host: Kate Rowe', setupId: superSetup.id, values: { name: 'Kate Rowe', title: 'Host' }, staysSec: 8 });
    ok(r.s === 201 && r.j.items.length === 1, 'item added');
    await api('POST', `/api/graphics/rundowns/${ev}/items`, { segment: 'Pre-match', title: 'Commentator', setupId: superSetup.id, values: { name: 'Justin Marshall', title: 'Commentator' } });
    await api('POST', `/api/graphics/rundowns/${ev}/items`, { segment: 'First half', title: 'Try scorer', setupId: superSetup.id, values: { name: '[TRY]' }, cue: { kind: 'feed', sourceId: push.id, path: 'lastEvent.type', equals: 'try' }, staysSec: 10 });
    r = await api('POST', `/api/graphics/rundowns/${ev}/items`, { title: 'Sponsor', setupId: superSetup.id, cue: { kind: 'repeat', everySec: 600 } });
    ok(r.s === 400 && /stays/.test(JSON.stringify(r.j)), 'repeat needs a duration');
    r = await api('POST', `/api/graphics/rundowns/${ev}/items`, { title: 'Player of the match', setupId: superSetup.id, values: {} , position: 2 });
    ok(r.j.items.map((i: any) => i.title).join('|') === 'Host: Kate Rowe|Player of the match|Commentator|Try scorer', 'insert at a position shifts the rest');
    ok(r.j.items.find((i: any) => i.title === 'Player of the match')?.needsContent === true, 'an item with operator fields left empty needs content');
    r = await api('POST', `/api/graphics/rundowns/${ev}/take`);
    ok(r.s === 200 && r.j.onAir.length === 1 && r.j.items[0].status === 'on_air', 'Take next: the first manual item');
    const liveEv = await api('GET', `/api/graphics/live?event_id=${ev}`);
    const sup = liveEv.j.items.find((i: any) => i.setupId === superSetup.id);
    ok(sup?.onAir && sup.values.name === 'Kate Rowe' && sup.targets === 'burn', 'the item’s content is on air, burned (transcode event)');
    r = await api('POST', `/api/graphics/rundowns/${ev}/items/${r.j.items[1].id}/skip`);
    r = await api('POST', `/api/graphics/rundowns/${ev}/take`);
    ok(r.j.items[0].status === 'done' && r.j.items[1].status === 'skipped' && r.j.items[2].status === 'on_air', 'Take next skips skipped items; the previous item on the same graphic is done');
    r = await api('POST', `/api/graphics/rundowns/${ev}/take`);
    ok(r.s === 409, 'nothing manual left');
    r = await api('POST', `/api/graphics/rundowns/${ev}/take-off`);
    ok(r.j.takenOff === 1 && r.j.onAir.length === 0, 'take off');
    await api('POST', `/api/graphics/sources/${push.id}/push`, { lastEvent: { type: 'penalty' } });
    r = await api('GET', `/api/graphics/rundowns/${ev}`);
    ok(r.j.items.find((i: any) => i.title === 'Try scorer').status === 'ready', 'feed cue ignores other values');
    await api('POST', `/api/graphics/sources/${push.id}/push`, { lastEvent: { type: 'try' } });
    r = await api('GET', `/api/graphics/rundowns/${ev}`);
    ok(r.j.items.find((i: any) => i.title === 'Try scorer').status === 'on_air', 'feed cue fires on a try');
    await query(`UPDATE gfx_state SET off_at = now() - interval '1 second' WHERE rundown_item_id = $1`, [r.j.items.find((i: any) => i.title === 'Try scorer').id]);
    const t = await tick();
    r = await api('GET', `/api/graphics/rundowns/${ev}`);
    ok(t.offs >= 1 && r.j.items.find((i: any) => i.title === 'Try scorer').status === 'done', 'the timer takes it off and marks it done');
    await api('POST', `/api/graphics/rundowns/${ev}/items`, { title: 'Timed', setupId: superSetup.id, cue: { kind: 'time', at: new Date(Date.now() - 5000).toISOString() }, staysSec: 5 });
    const t2 = await tick();
    r = await api('GET', `/api/graphics/rundowns/${ev}`);
    ok(t2.cues >= 1 && r.j.items.find((i: any) => i.title === 'Timed').status === 'on_air', 'a time cue fires on the tick');
    r = await api('POST', `/api/graphics/rundowns/${ev}/reorder`, { ids: [r.j.items[0].id] });
    ok(r.s === 400, 'reorder must name every item');
    const ids = (await api('GET', `/api/graphics/rundowns/${ev}`)).j.items.map((i: any) => i.id).reverse();
    r = await api('POST', `/api/graphics/rundowns/${ev}/reorder`, { ids });
    ok(r.j.items.map((i: any) => i.id).join() === ids.join(), 'reorder');

    r = await api('POST', `/api/graphics/rundowns/${ev2}/import-csv?tz=Australia/Brisbane`, undefined,
      { raw: 'segment,title,setup,cue,stays,values\nPre-match,Host,Presenter super,manual,8,name=Kate Rowe;title=Host\n,Soon,Nope,manual,,\n', type: 'text/csv' });
    ok(r.s === 400 && /line 3: no setup called "Nope"/.test(r.j.error ?? ''), 'CSV errors name the line', JSON.stringify(r.j));
    r = await api('POST', `/api/graphics/rundowns/${ev2}/import-csv?tz=Australia/Brisbane`, undefined,
      { raw: 'segment,title,setup,cue,stays,values\nPre-match,Host,presenter super,manual,8,name=Kate Rowe;title=Host\nPre-match,Countdown,Presenter super,+300,,\n', type: 'text/csv' });
    ok(r.s === 201 && r.j.imported === 2 && r.j.items[0].values.name === 'Kate Rowe' && r.j.items[1].cue.kind === 'offset', 'CSV import, setup by name', JSON.stringify(r.j).slice(0, 200));
    r = await api('POST', `/api/graphics/rundowns/${ev2}/copy-from`, { eventId: ev });
    ok(r.j.copied >= 5 && r.j.items.length === 2 + r.j.copied && r.j.items.every((i: any) => i.cue.kind !== 'time'), 'copy from another event; clock cues become manual');

    console.log('== player feed ==');
    {
      const { generateKey } = await import('../src/services/apiKeys');
      const { recordSnapshots } = await import('../src/services/graphics/playerFeed');
      const appRow = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Web','web','{}') RETURNING id`, [acct]);
      const k = generateKey('publishable');
      await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [acct, appRow!.id, k.prefix, k.hash]);
      const kOther = generateKey('publishable');
      const appOther = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Web','web','{}') RETURNING id`, [other]);
      await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [other, appOther!.id, kOther.prefix, kOther.hash]);
      const pub = async (path: string, init?: RequestInit) => { const rr = await fetch(base + path, init); const t = await rr.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; } return { s: rr.status, j, h: rr.headers }; };
      r = await api('POST', '/api/graphics/assignments', { setupId: superSetup.id, channelId: ch, targets: 'player', runMode: 'manual' });
      const aPlayer = r.j;
      await api('PATCH', `/api/graphics/assignments/${aPlayer.id}/state`, { values: { name: 'Secret guest' } });
      await recordSnapshots();
      const t0 = Date.now();
      r = await pub(`/api/player/graphics?appKey=${k.raw}&streamId=${ch}&since=${t0}`);
      const def = r.j.graphics?.find((g: any) => g.id === aPlayer.id);
      ok(r.s === 200 && def && def.url.startsWith('/gfx/') && def.canvas[0] === 1920, 'feed lists the player graphic with its template', JSON.stringify(r.j).slice(0, 300));
      ok(!r.j.graphics.some((g: any) => g.id === aAlways.id), 'a burned-only graphic is not in the player feed');
      const last = r.j.snapshots[r.j.snapshots.length - 1];
      ok(last && last.state[aPlayer.id]?.on === false && JSON.stringify(last.state[aPlayer.id].v) === '{}', 'off air: no values sent (nothing leaks before it is shown)', JSON.stringify(last));
      ok(r.j.snapshots.every((x: any) => !(aAlways.id in x.state)), 'snapshots carry only player graphics');
      ok(/max-age=1/.test(r.h.get('cache-control') ?? ''), 'cacheable for a second');
      await new Promise((res2) => setTimeout(res2, 20));
      await api('POST', `/api/graphics/assignments/${aPlayer.id}/air`, { on: true });
      await new Promise((res2) => setTimeout(res2, 300));
      const t1 = Date.now();
      await new Promise((res2) => setTimeout(res2, 20));
      await api('PATCH', `/api/graphics/assignments/${aPlayer.id}/state`, { values: { name: 'Kate Rowe' } });
      await new Promise((res2) => setTimeout(res2, 300));
      r = await pub(`/api/player/graphics?appKey=${k.raw}&streamId=${ch}&since=${t0 - 20_000}`);
      const at = (t: number) => [...r.j.snapshots].filter((x: any) => x.at <= t).pop();
      ok(at(t0)?.state[aPlayer.id]?.on === false, 'state at the first moment: off', JSON.stringify(r.j.snapshots.map((x: any) => [x.at, x.state[aPlayer.id]])));
      ok(at(t1)?.state[aPlayer.id]?.on === true && at(t1).state[aPlayer.id].v.name === 'Secret guest', 'taken on: on, with the value then');
      ok(at(Date.now())?.state[aPlayer.id]?.v.name === 'Kate Rowe', 'and the later change after it: a viewer behind live gets each in turn');
      r = await pub(`/api/player/graphics?appKey=${kOther.raw}&streamId=${ch}`);
      ok(r.s === 404, 'another account’s key: not found');
      r = await pub(`/api/player/graphics?appKey=pk_nope_123456&streamId=${ch}`);
      ok(r.s === 401, 'bad key: 401');
      r = await pub(`/api/player/graphics?appKey=${k.raw}&streamId=${radio}`);
      ok(r.s === 200 && r.j.graphics.length === 0, 'a stream without player graphics: empty');
      const imp = (body: any) => pub('/api/player/graphics/impressions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      r = await imp({ appKey: k.raw, streamId: ch, sessionId: 'web-test-1', items: [{ id: aPlayer.id, at: Date.now() }, { id: aRule.id }] });
      ok(r.s === 204, 'impressions accepted');
      r = await imp({ appKey: k.raw, streamId: ch, sessionId: 'web-test-1', items: [{ id: '11111111-1111-1111-1111-111111111111' }] });
      const n = await one<any>(`SELECT count(*)::int AS n FROM gfx_impressions WHERE account_id = $1`, [acct]);
      ok(n?.n === 2, 'an id that is not this stream’s is dropped', String(n?.n));
      r = await api('GET', `/api/graphics/assignments?channel_id=${ch}`);
      const rows = r.j.items;
      ok(rows.find((x: any) => x.id === aPlayer.id)?.impressions24h === 1 && rows.find((x: any) => x.id === aAlways.id)?.impressions24h === null, 'impressions counted per graphic; burned graphics have none');
      await api('POST', `/api/graphics/assignments/${aPlayer.id}/air`, { on: false });
      const f = await fetch(`${base}/gfx/${def.url.split('/')[2]}/index.html`);
      ok(f.status === 200 && f.headers.get('access-control-allow-origin') === '*', 'template files load from any site the player is on');
      const { scaleConfig } = await import('../src/scale/config');
      ok(scaleConfig.publicPrefixes.includes('/gfx/') && scaleConfig.publicPrefixes.includes('/api/player/'), 'template files and the feed are on the public tier');
    }

    console.log('== guards ==');
    r = await api('DELETE', `/api/graphics/templates/${rugby.id}`);
    ok(r.s === 409, 'a template in use cannot be deleted');
    r = await api('DELETE', `/api/graphics/setups/${superSetup.id}`);
    ok(r.s === 409 && /rundown/.test(JSON.stringify(r.j)), 'a setup in a rundown cannot be deleted');
    r = await api('DELETE', `/api/graphics/assignments/${aTrig.id}`);
    ok(r.s === 409 && /on air/.test(JSON.stringify(r.j)), 'an assignment on air cannot be deleted');
    r = await api('DELETE', `/api/graphics/sources/${src.id}`);
    ok(r.s === 409, 'a data source in use cannot be deleted');

    console.log('== tenancy ==');
    r = await api('GET', `/api/graphics/templates/${rugby.id}`, undefined, { token: tokOther });
    ok(r.s === 404, 'another account cannot see this template');
    r = await api('GET', `/api/graphics/live?channel_id=${ch}`, undefined, { token: tokOther });
    ok(r.s === 404, 'or this channel’s graphics');
    r = await api('PATCH', `/api/graphics/assignments/${aAlways.id}/state`, { values: { homeScore: 1 } }, { token: tokOther });
    ok(r.s === 404, 'or drive them');
    r = await api('POST', '/api/graphics/setups', { name: 'x', versionId: rugbyV1.id }, { token: tokOther });
    ok(r.s === 404, 'or build a setup on its template');

    console.log('== permissions ==');
    const need = async (m: string, p: string) => { const q = await requirementFor(m, p); return q ? `${q.features.join('/')}:${q.level}` : 'none'; };
    const U = '11111111-1111-1111-1111-111111111111';
    ok(await need('PATCH', `/api/graphics/assignments/${U}/state`) === 'graphics:operate', 'driving values is operate');
    ok(await need('POST', `/api/graphics/assignments/${U}/air`) === 'graphics:operate', 'on and off air is operate');
    ok(await need('POST', `/api/graphics/rundowns/${U}/take`) === 'graphics:operate', 'take is operate');
    ok(await need('POST', `/api/graphics/rundowns/${U}/items/${U}/skip`) === 'graphics:operate', 'skip is operate');
    ok(await need('POST', '/api/graphics/templates') === 'graphics:manage', 'authoring templates is manage');
    ok(await need('PATCH', `/api/graphics/assignments/${U}`) === 'graphics:manage', 'changing how it runs is manage');
    ok(await need('GET', '/api/graphics/live') === 'graphics:view', 'reading is view');
  } finally {
    srv.close(); feedSrv.close();
    await query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [[acct, other]]).catch((e) => console.error('cleanup', e.message));
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
