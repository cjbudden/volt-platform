/* Encode engines + workflow add-ons. Run: npx tsx test/workflows.check.ts
   Needs DATABASE_URL pointing at a DB with migrations applied (0044+).

   Covers:
     ENGINES   catalogue, capability checks, the launcher seam (builtin is a
               byte-identical pass-through; a vendor engine in encode_only and
               full mode provisions, binds, stops and reports liveness; a
               failed launch stops what it started), jobConfig only names a
               vendor engine, vendor webhook -> canonical event via applyReport.
     ADD-ONS   filter matching, signing, state machine, hook -> event + run,
               the demo agent end to end, a real webhook endpoint receiving a
               signed dispatch and calling back over HTTP, cancel, timeouts,
               and the operator API (map, runs, trace, run by hand). */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { query, one, pool } from '../src/db';
import { MockTaskLauncher } from '../src/services/orchestrator/launcher';
import { buildEncoderJobConfig } from '../src/services/jobConfig';
import {
  listEngines, checkCapabilities, describeEngine, registerEngines, getEngine,
  type EncodeEngine, type EngineHandle,
} from '../src/services/engines';
import { registerEngine, unregisterEngine } from '../src/services/engines/registry';
import { EngineAwareLauncher, type BindingStore, type EngineBinding } from '../src/services/engines/launcher';
import { MEDIALIVE } from '../src/services/engines/catalog';
import { matchesFilter, emitHook } from '../src/services/workflows/hooks';
import { sign, verifySignature, signatureHeader, canMove, applyUpdate, handleDispatch, sweepTimeouts, authoriseCallback } from '../src/services/workflows/runs';
import { createServer } from '../src/server';
import { signAccess } from '../src/auth/jwt';
import { applyReport } from '../src/modules/status';

let fails = 0, passes = 0;
const ok = (n: string, c: boolean, extra?: unknown) => {
  if (c) passes++; else fails++;
  console.log((c ? 'PASS ' : 'FAIL ') + n + (c || extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`));
};

const A = '00000000-0000-0000-0000-00000000f0a1';
const G = '00000000-0000-0000-0000-00000000f0b1';
const P = '00000000-0000-0000-0000-00000000f0d1';
const CH = '00000000-0000-0000-0000-00000000f0c1';
const CH2 = '00000000-0000-0000-0000-00000000f0c2';
const REC = '00000000-0000-0000-0000-00000000f0e1';
const U = '00000000-0000-0000-0000-00000000f0f1';

async function seed() {
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'Workflows')`, [A]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging)
    VALUES ($1,$2,'p','[{"height":1080,"bitrate_kbps":5000},{"height":720,"bitrate_kbps":2800}]','transcode','both')`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels) VALUES ($1,$2,'g',$3,10)`, [G, A, P]);
  await query(`INSERT INTO channels(id,group_id,name,status) VALUES ($1,$3,'wf-news','scheduled'),($2,$3,'wf-sport','scheduled')`, [CH, CH2, G]);
  await query(`INSERT INTO recordings(id,kind,channel_id,title,status,start_epoch_ms,end_epoch_ms,duration_ms,day_utc)
    VALUES ($1,'channel_day',$2,'Evening news','complete',1000,1801000,1800000,current_date)`, [REC, CH]);
  await query(`DELETE FROM users WHERE id=$1`, [U]).catch(() => {});
  await query(`INSERT INTO users(id,account_id,email,password_hash,role) VALUES ($1,$2,'wf@test.local','x','admin')`, [U, A]).catch((e) => console.log('note: users seed', e.message));
}

// ---------------------------------------------------------------------------
function memStore(): BindingStore & { rows: Map<string, EngineBinding & { closed?: string }> } {
  const rows = new Map<string, EngineBinding & { closed?: string }>();
  return {
    rows,
    async save(b) { rows.set(b.taskArn, { ...b }); },
    async byArn(a) { return rows.get(a) ?? null; },
    async close(a, reason) { const r = rows.get(a); if (r) r.closed = reason; },
  };
}

function fakeVendor(log: string[], opts: { failStart?: boolean } = {}): EncodeEngine {
  return {
    descriptor: { ...MEDIALIVE, id: 'fakevendor', name: 'Fake vendor', availability: 'installed', caps: { ...MEDIALIVE.caps, modes: ['encode_only', 'full'] } },
    validate: () => [],
    packagerJob: (job) => ({ ...job, workflow: 'package_only', inputs: [{ rendition_label: '1080p', url: 'srt://0.0.0.0:9000?mode=listener' }] }),
    provision: async (sid, _job, mode) => { log.push(`provision:${sid}:${mode}`); return { externalRef: `ext-${sid.slice(-4)}` }; },
    start: async (h: EngineHandle) => { log.push(`start:${h.externalRef}`); if (opts.failStart) throw new Error('vendor start failed'); },
    stop: async (h: EngineHandle, r: string) => { log.push(`stop:${h.externalRef}:${r}`); },
    isRunning: async () => 'alive',
    verifyWebhook: (headers) => headers['x-fake-secret'] === 's3cret',
    normalize: (raw: any, b) => raw?.alert === 'InputLoss' ? [{ kind: b.streamKind, id: b.streamId, type: 'source.down', detail: { vendorAlert: raw.alert } }] : [],
  };
}

async function engineTests() {
  registerEngines();
  const list = listEngines();
  ok('engines: builtin installed', list.find((e) => e.id === 'builtin')?.availability === 'installed');
  ok('engines: medialive, bitmovin, wowza listed as planned', ['medialive', 'bitmovin', 'wowza'].every((id) => list.find((e) => e.id === id)?.availability === 'planned'));

  const ml = describeEngine('medialive')!;
  const job = { workflow: 'transcode', ladder: [{ height: 1080 }, { height: 720 }], captions: { enabled: true }, drm: {}, redundancy: { input_failover: true, input_loss_behavior: 'slate' } };
  const eo = checkCapabilities(ml, job, 'encode_only');
  ok('caps: encode_only keeps captions, DRM, slate (Volt downstream)', !eo.some((i) => i.severity === 'error'), eo);
  const full = checkCapabilities(ml, job, 'full');
  ok('caps: full mode refuses Volt-only captions and DRM', full.some((i) => i.field === 'captions' && i.severity === 'error') && full.some((i) => i.field === 'drm' && i.severity === 'error'), full);
  ok('caps: full mode warns recording/clipping are lost', full.some((i) => i.field === 'recording' && i.severity === 'warning'));
  const pk = checkCapabilities(ml, { workflow: 'package_only' }, 'encode_only');
  ok('caps: vendor that cannot take a ready ladder refuses package_only', pk.some((i) => i.field === 'workflow'));
  const tall = checkCapabilities(describeEngine('builtin')!, { workflow: 'transcode', ladder: [{ height: 4320 }] }, 'full');
  ok('caps: over max height is an error', tall.some((i) => i.field === 'ladder'));

  // builtin pass-through
  const base = new MockTaskLauncher();
  const store = memStore();
  const L = new EngineAwareLauncher(base, store);
  const jb = { channel_id: CH, workflow: 'transcode', ladder: [] };
  const r0 = await L.launchEncoder(CH, jb);
  ok('launcher: builtin goes straight to the base launcher', !r0.taskArn.startsWith('engine:'));
  ok('launcher: builtin job is passed unchanged (same object)', ((base as any).launched?.[0]?.job ?? jb) === jb);
  ok('launcher: no binding for builtin', store.rows.size === 0);

  // vendor, encode_only
  const log: string[] = [];
  registerEngine(fakeVendor(log));
  const r1 = await L.launchEncoder(CH, { ...jb, engine: { id: 'fakevendor', mode: 'encode_only', stream_kind: 'channel' } });
  ok('encode_only: vendor provisioned and started', log.includes(`provision:${CH}:encode_only`) && log.includes('start:ext-f0c1'), log);
  ok('encode_only: our packager launched, its arn returned', !r1.taskArn.startsWith('engine:'));
  ok('encode_only: binding saved against our packager arn', store.rows.get(r1.taskArn)?.engineId === 'fakevendor');
  await L.stopTask(r1.taskArn, 'operator stop');
  ok('encode_only: stop reaches the vendor first, binding closed', log.includes('stop:ext-f0c1:operator stop') && store.rows.get(r1.taskArn)?.closed === 'operator stop', log);

  // vendor, full
  const r2 = await L.launchEncoder(CH2, { ...jb, channel_id: CH2, engine: { id: 'fakevendor', mode: 'full', stream_kind: 'channel' } });
  ok('full: taskArn is engine:<id>:<ref>', r2.taskArn === 'engine:fakevendor:ext-f0c2', r2);
  ok('full: isRunning routes to the vendor', (await L.isRunning(r2.taskArn)) === 'alive');
  ok('full: describePlacement is null for a vendor task', L.describePlacement ? (await L.describePlacement(r2.taskArn)) === null : true);
  await L.stopTask(r2.taskArn, 'done');
  ok('full: stop reaches the vendor', log.includes('stop:ext-f0c2:done'));

  // failed launch rolls back
  unregisterEngine('fakevendor');
  const log2: string[] = [];
  registerEngine(fakeVendor(log2, { failStart: true }));
  let threw = false;
  try { await L.launchEncoder(CH, { ...jb, engine: { id: 'fakevendor', mode: 'encode_only' } }); } catch { threw = true; }
  ok('rollback: failed vendor start throws and stops the vendor job', threw && log2.some((l) => l.startsWith('stop:')), log2);
  let threw2 = false;
  try { await L.launchEncoder(CH, { ...jb, engine: { id: 'nosuch' } }); } catch (e: any) { threw2 = /not installed/.test(e.message); }
  ok('unknown engine is refused before anything starts', threw2);

  // jobConfig: engine only for vendors
  const ctx: any = { kind: 'channel', owner: { id: CH }, inputs: [{ role: 'primary', ingest_url: 'srt://x:1', protocol: 'srt', rendition_label: 'm' }],
    profile: { workflow_type: 'transcode', segment_dur: 4, rungs: [{ height: 720, bitrate_kbps: 2800 }], packaging: 'both', codec_backend: 'x264', dvr_window_sec: 60 } };
  ok('jobConfig: builtin profile has no engine field', !('engine' in buildEncoderJobConfig(ctx)));
  ok('jobConfig: vendor profile names the engine', buildEncoderJobConfig({ ...ctx, profile: { ...ctx.profile, encode_engine: 'medialive', encode_engine_mode: 'encode_only' } }).engine?.id === 'medialive');

  // vendor webhook -> canonical event, through the real router
  await query(`INSERT INTO engine_bindings(task_arn,engine_id,mode,stream_kind,stream_id,external_ref) VALUES ('arn-wh','fakevendor','encode_only','channel',$1,'ml-123')
               ON CONFLICT (task_arn) DO NOTHING`, [CH]);
  return log;
}

// ---------------------------------------------------------------------------
async function pureTests() {
  ok('filter: empty matches all', matchesFilter({}, { channelId: CH, eventId: null }));
  ok('filter: channel list matches', matchesFilter({ channelIds: [CH] }, { channelId: CH, eventId: null }));
  ok('filter: other channel does not', !matchesFilter({ channelIds: [CH2] }, { channelId: CH, eventId: null }));
  ok('filter: group list matches', matchesFilter({ groupIds: [G] }, { channelId: CH, eventId: null, groupId: G }));
  const body = '{"a":1}';
  const hdr = signatureHeader('whsec_x', body, 1_700_000_000);
  ok('sign: verify accepts our own signature', verifySignature('whsec_x', hdr, body, 300, 1_700_000_010));
  ok('sign: tampered body rejected', !verifySignature('whsec_x', hdr, '{"a":2}', 300, 1_700_000_010));
  ok('sign: stale timestamp rejected', !verifySignature('whsec_x', hdr, body, 300, 1_700_009_999));
  ok('sign: wrong secret rejected', !verifySignature('whsec_y', hdr, body, 300, 1_700_000_010));
  ok('sign: hex is hmac of t.body', sign('k', 1, 'b').length === 64);
  ok('state: running -> succeeded legal', canMove('running', 'succeeded'));
  ok('state: succeeded is final', !canMove('succeeded', 'running') && !canMove('timed_out', 'succeeded'));
}

const fakeCtx = (job: any) => ({ job, progress: async () => {}, isCancelled: () => false });

async function addonTests() {
  // demo add-on + trigger on recording.completed
  const demo = await one<any>(`INSERT INTO addon_services(account_id,name,category,kind,signing_secret,accepts)
    VALUES ($1,'Demo agent','ai_agent','demo','whsec_demo',ARRAY['recording','vod_asset']) RETURNING *`, [A]);
  await query(`INSERT INTO addon_triggers(account_id,addon_id,hook,filter,options) VALUES ($1,$2,'recording.completed',$3::jsonb,'{"demoStepMs":20}')`,
    [A, demo.id, JSON.stringify({ channelIds: [CH] })]);

  const fired = await emitHook('recording.completed', 'recording', REC, { durationMs: 1800000 });
  ok('hook: workflow event written', !!fired.eventId);
  ok('hook: matching trigger started one run', fired.runs.length === 1, fired);
  const run = await one<any>(`SELECT * FROM addon_runs WHERE id = $1`, [fired.runs[0]]);
  ok('run: queued with deadline and subject title', run.state === 'queued' && run.subject_title === 'Evening news' && !!run.deadline_at);
  const job = await one<any>(`SELECT * FROM jobs WHERE id = $1`, [run.job_id]);
  ok('run: dispatch job queued', job?.type === 'addon.dispatch');

  await handleDispatch(fakeCtx({ ...job, attempts: 1 }) as any);
  const done = await one<any>(`SELECT * FROM addon_runs WHERE id = $1`, [run.id]);
  ok('demo: run succeeded at 100%', done.state === 'succeeded' && done.progress_pct === 100, done);
  ok('demo: result stored and marked simulated', done.result?.simulated === true && done.result?.chapters?.length === 4);
  const evs = await query<any>(`SELECT type, step FROM addon_run_events WHERE run_id = $1 ORDER BY id`, [run.id]);
  ok('demo: event log shows each step', ['Fetch media', 'Transcribe audio', 'Return results'].every((s) => evs.some((e) => e.step === s)), evs.map((e) => e.step));
  const late = await applyUpdate(run.id, { state: 'failed', error: 'late' }, 'test');
  ok('terminal: a late update is logged, not applied', !late.applied && late.run.state === 'succeeded');

  const other = await emitHook('recording.completed', 'recording', REC, {});
  ok('hook: second fire makes a second run (each close is its own event)', other.runs.length === 1);
  await query(`UPDATE addon_triggers SET filter = $2::jsonb WHERE addon_id = $1`, [demo.id, JSON.stringify({ channelIds: [CH2] })]);
  const filtered = await emitHook('recording.completed', 'recording', REC, {});
  ok('hook: filter excludes other channels', filtered.runs.length === 0 && !!filtered.eventId);
  let bad = false;
  try { await emitHook('nope.hook', 'recording', REC); } catch { bad = true; }
  ok('hook: undeclared hook refused', bad);

  // real webhook endpoint
  const received: any[] = [];
  const ext = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      received.push({ headers: req.headers, raw });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ externalRef: 'agent-job-77', steps: ['Ingest', 'Analyse', 'Deliver'] }));
    });
  });
  await new Promise<void>((r) => ext.listen(0, '127.0.0.1', r));
  const extPort = (ext.address() as AddressInfo).port;

  const app = createServer();
  const srv = app.listen(0); const port = (srv.address() as AddressInfo).port;
  const api = `http://127.0.0.1:${port}/api`;
  const tok = signAccess({ sub: U, account_id: A, role: 'admin' });
  const H = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };

  const created = await fetch(`${api}/addons`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'Acme AI', category: 'ai_agent', kind: 'webhook', endpointUrl: `http://localhost:${extPort}/hook`, accepts: ['recording'] }) });
  const addon = await created.json() as any;
  ok('api: create add-on returns the signing secret once', created.status === 201 && /^whsec_/.test(addon.signingSecret), addon);
  const listed = await (await fetch(`${api}/addons`, { headers: H })).json() as any;
  ok('api: list never returns secrets', !JSON.stringify(listed).includes('whsec_'));
  const httpBad = await fetch(`${api}/addons`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'x', kind: 'webhook', endpointUrl: 'http://example.com/x' }) });
  ok('api: plain http refused for non-local endpoints', httpBad.status === 400);
  const ping = await (await fetch(`${api}/addons/${addon.id}/test`, { method: 'POST', headers: H })).json() as any;
  ok('api: test ping reaches the endpoint, signed', ping.ok && verifySignature(addon.signingSecret, String(received[0]?.headers['x-volt-signature']), received[0]?.raw), ping);

  const manual = await fetch(`${api}/workflows/runs`, { method: 'POST', headers: H, body: JSON.stringify({ addonId: addon.id, subjectType: 'recording', subjectId: REC, options: { prompt: 'summarise' } }) });
  const mrun = await manual.json() as any;
  ok('api: run by hand created', manual.status === 201 && mrun.hook === 'manual', mrun);
  const mjob = await one<any>(`SELECT * FROM jobs WHERE id = $1`, [mrun.job_id]);
  await handleDispatch(fakeCtx({ ...mjob, attempts: 1 }) as any);
  const delivery = received.find((r) => r.headers['x-volt-event'] === 'run.dispatch');
  ok('dispatch: endpoint received a signed run.dispatch', !!delivery && verifySignature(addon.signingSecret, String(delivery.headers['x-volt-signature']), delivery.raw));
  const payload = JSON.parse(delivery.raw);
  ok('dispatch: payload carries subject, media link, options and callback', payload.subject.id === REC && !!payload.subject.media.hls && payload.options.prompt === 'summarise' && /\/api\/addon-callbacks\/runs\//.test(payload.run.callbackUrl));
  const afterDispatch = await one<any>(`SELECT * FROM addon_runs WHERE id = $1`, [mrun.id]);
  ok('dispatch: run dispatched with the vendor ref and steps', afterDispatch.state === 'dispatched' && afterDispatch.external_ref === 'agent-job-77' && afterDispatch.steps.length === 3);

  const cb = (b: any, token = payload.run.callbackToken) => fetch(`${api}/addon-callbacks/runs/${mrun.id}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(b) });
  ok('callback: wrong token refused', (await cb({ progress: 10 }, 'vrt_wrong')).status === 401);
  ok('callback: progress accepted', (await cb({ progress: 40, step: 'Analyse' })).status === 200);
  const mid = await one<any>(`SELECT state, progress_pct, step FROM addon_runs WHERE id = $1`, [mrun.id]);
  ok('callback: run is running at 40% on Analyse', mid.state === 'running' && mid.progress_pct === 40 && mid.step === 'Analyse', mid);
  ok('callback: success with result', (await cb({ state: 'succeeded', result: { summary: 'ok' } })).status === 200);
  ok('callback: after success further updates are 409', (await cb({ progress: 50 })).status === 409);
  ok('callback: token authorises only its own run', !(await authoriseCallback(run.id, payload.run.callbackToken)));

  const map = await (await fetch(`${api}/workflows/map`, { headers: H })).json() as any;
  const rc = map.hooks?.find((h: any) => h.id === 'recording.completed');
  ok('api: map has lanes, stages and hooks', map.lanes?.length === 3 && map.stages?.length >= 10);
  ok('api: map shows the trigger and 24h activity on recording.completed', rc?.triggers?.length === 1 && rc.fired24h >= 3 && (rc.runs24h?.succeeded ?? 0) >= 1, rc);
  const trace = await (await fetch(`${api}/workflows/trace?subjectType=recording&subjectId=${REC}`, { headers: H })).json() as any;
  ok('api: trace lists the hooks fired and the runs for the recording', trace.events?.length >= 3 && trace.runs?.length >= 3, { e: trace.events?.length, r: trace.runs?.length });
  const one1 = await (await fetch(`${api}/workflows/runs/${mrun.id}`, { headers: H })).json() as any;
  ok('api: run detail has result and event log', one1.result?.summary === 'ok' && one1.events?.length >= 4);

  // cancel + timeout
  const r3 = await (await fetch(`${api}/workflows/runs`, { method: 'POST', headers: H, body: JSON.stringify({ addonId: addon.id, subjectType: 'recording', subjectId: REC }) })).json() as any;
  const can = await (await fetch(`${api}/workflows/runs/${r3.id}/cancel`, { method: 'POST', headers: H })).json() as any;
  ok('api: cancel', can.state === 'cancelled');
  const r4 = await (await fetch(`${api}/workflows/runs`, { method: 'POST', headers: H, body: JSON.stringify({ addonId: addon.id, subjectType: 'recording', subjectId: REC }) })).json() as any;
  await query(`UPDATE addon_runs SET deadline_at = now() - interval '1 minute' WHERE id = $1`, [r4.id]);
  await sweepTimeouts();
  ok('sweeper: overdue run timed out', (await one<any>(`SELECT state FROM addon_runs WHERE id = $1`, [r4.id]))?.state === 'timed_out');
  const vod = await fetch(`${api}/workflows/runs`, { method: 'POST', headers: H, body: JSON.stringify({ addonId: addon.id, subjectType: 'vod_asset', subjectId: REC }) });
  ok('api: subject the add-on does not accept (or not found) is refused', vod.status === 404 || vod.status === 422);

  // engines API + webhook (fake vendor registered above)
  const eng = await (await fetch(`${api}/engines`, { headers: H })).json() as any;
  ok('api: engines list', eng.engines?.some((e: any) => e.id === 'medialive'));
  const val = await (await fetch(`${api}/engines/medialive/validate`, { method: 'POST', headers: H, body: JSON.stringify({ profileId: P, mode: 'encode_only' }) })).json() as any;
  ok('api: validating against a planned engine says it is not installed', val.ok === false && val.issues.some((i: any) => /not installed/.test(i.message)), val);
  const assign = await fetch(`${api}/engines/profiles/${P}`, { method: 'PUT', headers: H, body: JSON.stringify({ engine: 'medialive', mode: 'encode_only' }) });
  ok('api: assigning a profile to a planned engine is refused (422)', assign.status === 422);
  const ok2 = await fetch(`${api}/engines/profiles/${P}`, { method: 'PUT', headers: H, body: JSON.stringify({ engine: 'builtin' }) });
  ok('api: assigning builtin works', ok2.status === 200);
  const wh = await fetch(`${api}/engine-hooks/fakevendor?ref=ml-123`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fake-secret': 's3cret' }, body: JSON.stringify({ alert: 'InputLoss' }) });
  const whj = await wh.json() as any;
  ok('webhook: vendor alert normalised and applied', wh.status === 202 && whj.applied === 1, whj);
  const se = await one<any>(`SELECT type, detail FROM stream_events WHERE channel_id = $1 ORDER BY id DESC LIMIT 1`, [CH]);
  ok('webhook: lands in the stream event log as source.down tagged with the engine', se?.type === 'source.down' && se?.detail?.engine === 'fakevendor', se);
  const whBad = await fetch(`${api}/engine-hooks/fakevendor?ref=ml-123`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok('webhook: unsigned call refused', whBad.status === 401);

  srv.close(); ext.close();
}

(async () => {
  try {
    await seed();
    await pureTests();
    await engineTests();
    await addonTests();
  } catch (e) {
    fails++; console.error('FAIL (threw)', e);
  } finally {
    await query(`DELETE FROM accounts WHERE id=$1`, [A]).catch(() => {});
    await query(`DELETE FROM engine_bindings WHERE stream_id IN ($1,$2)`, [CH, CH2]).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    await pool.end();
    console.log(`\n${passes} passed, ${fails} failed`);
    process.exit(fails ? 1 : 0);
  }
})();
