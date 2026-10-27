// Volt chaos and scaling harness: the plans, the run loop and the judge.
//
// Tier 3 of the test plan (e2e/README.md): break the Tier-2 AWS deployment on
// purpose and check that Volt comes back the way the design says it should.
// Five scenarios: kill an encoder task, lose a source, fail an availability
// zone, interrupt a Spot server, and scale out under viewer load.
//
// WHY A LIBRARY AND A THIN CLI (chaos.mjs). The plans and the judge are pure
// functions, so the check suite (volt-app/test/chaos-harness.check.ts) proves
// them with made-up timelines and a fake AWS, and a dry run prints exactly the
// commands a real run would send. Nothing here imports the AWS SDK: every AWS
// action is an `aws` CLI argv, shown in the dry run and run through one exec
// function, so what Christian reads is what runs.
//
// WHY THE BUDGETS ARE WHAT THEY ARE. They come from the code, not from hope:
//   - an encoder that dies is noticed by the orchestrator tick (ORCH_TICK_SECONDS,
//     30 s), and auto connect relaunches an armed stream on its next pass
//     (RESUME_RETRY_SECONDS, 20 s); an ECS task on a server with room starts in
//     about a minute, a new server adds two or three more (services/orchestrator).
//   - the source selector calls a source lost after loss_detect_sec (3 s) and
//     fails back after failback_hold (10 s) of a healthy primary
//     (volt-encoder/bin/source_selector.py).
//   - viewers ride over a gap of about three segments of player buffer.
//   - the viewer load test fails above p95 300 ms or 1 % errors (viewer-start.js).

export const DEFAULTS = {
  tickSec: 30,          // ORCH_TICK_SECONDS
  resumeSec: 20,        // RESUME_RETRY_SECONDS
  lossDetectSec: 3,     // source_selector loss_detect_sec
  failbackHoldSec: 10,  // source_selector failback_hold
  segmentSec: 4,        // the profile's segment length
  pollSec: 2,           // how often a run samples the API and the playlist
  relaunchSec: 240,     // killed encoder back on air, server with room
  newServerSec: 480,    // the same when a new server has to start first
  apiGapSec: 120,       // longest the API may be unreachable during an AZ loss
  p95Ms: 300,           // viewer-start.js threshold
  errorRate: 0.01,      // viewer-start.js threshold
  faultSec: 600,        // how long an AZ stays cut off
};

export const SCENARIOS = {
  'kill-encoder': 'Kill a live channel\'s encoder task; auto connect brings it back',
  'lose-source': 'Lose a channel\'s primary source; the backup (or filler) takes over and the picture never stops',
  'fail-az': 'Cut one availability zone off; the API stays up and every stream comes back in the other zones',
  'spot-interrupt': 'Interrupt one Spot server; its encoders come back on other servers',
  'scale-out': 'Viewer starts rise to the peak; api-public scales out and holds p95 and errors',
};

/**
 * What the run needs from the deployment, from `terraform output -json`.
 * Anything missing stays a <placeholder> so a dry run still reads.
 */
export function readStack(tf = {}, over = {}) {
  const v = (k) => (tf[k] && typeof tf[k] === 'object' && 'value' in tf[k]) ? tf[k].value : tf[k];
  const roles = v('role_services') || {};
  // chaos.tf's `chaos_stack` output carries the rest (name, region, database)
  const cs = v('chaos_stack') || {};
  const base = over.apiBase || v('api_edge_domain') || v('control_plane_url') || '<api base>';
  const s = {
    cluster: over.cluster || v('ecs_cluster') || '<ecs cluster>',
    apiBase: /^https?:\/\//.test(base) ? base.replace(/\/$/, '') : `https://${base}`,
    playBase: (over.playBase || (v('api_edge_domain') ? `https://${v('api_edge_domain')}` : null) || (/^https?:/.test(base) ? base : `https://${base}`)).replace(/\/$/, ''),
    region: over.region || cs.region || '<region>',
    apiPublicService: roles.api_public || roles.api_admin || '<api-public service>',
    dbInstance: over.dbInstance || cs.db_instance_id || '<db instance>',
    dbMultiAz: cs.db_multi_az === true,
    templates: v('chaos_experiment_templates') || {},
    stackName: over.stackName || cs.stack_name || '<stack>',
  };
  return s;
}

const aws = (stack, ...args) => ['aws', '--region', stack.region, ...args];

/**
 * The plan for one scenario: what must be true first, what is done, what is
 * expected (each with its time budget) and how the fault is undone.
 */
export function plan(name, stack, o = {}) {
  const d = { ...DEFAULTS, ...o };
  const ch = o.channels?.length ? o.channels : ['<channel id>'];
  const pre = [
    { id: 'stack', what: `The Tier-2 stack ${stack.stackName} answers at ${stack.apiBase}/health/ready` },
  ];
  const liveChannels = { id: 'live', what: `Channel(s) ${ch.join(', ')} live, on air, auto connect on and armed (healthy once this run)` };
  switch (name) {
    case 'kill-encoder': {
      const budget = o.newServer ? d.newServerSec : d.relaunchSec;
      return {
        scenario: name, title: SCENARIOS[name],
        preconditions: [...pre, liveChannels],
        steps: [
          { kind: 'api', what: `Read the running task of ${ch[0]} (GET /api/channels/${ch[0]} instances[0].task_arn)` },
          { kind: 'aws', argv: aws(stack, 'ecs', 'stop-task', '--cluster', stack.cluster, '--task', '<task arn>', '--reason', 'volt chaos: kill-encoder'), what: 'Stop that task, as a crash or an out-of-memory kill would' },
        ],
        expect: [
          { id: 'noticed', what: 'The control plane sees the encoder is gone', budgetSec: d.tickSec + 15 },
          { id: 'back', what: 'A new encoder task is on air and the public playlist advances again', budgetSec: budget },
          { id: 'one-relaunch', what: 'Exactly one replacement task (no relaunch storm)' },
        ],
        revert: [{ kind: 'none', what: 'Nothing: auto connect is the revert. If it gave up, press Start in the console and read the reason on the channel.' }],
      };
    }
    case 'lose-source':
      return {
        scenario: name, title: SCENARIOS[name],
        preconditions: [...pre, liveChannels, { id: 'backup', what: 'The channel has a backup source sending, or a filler set (Loops & Fillers)' }],
        steps: [
          o.stopSource
            ? { kind: 'shell', argv: ['sh', '-c', o.stopSource], what: 'Stop the primary source' }
            : { kind: 'manual', what: 'Stop the primary source (the ffmpeg or encoder feeding it), then press Enter' },
          { kind: 'wait', what: `Hold the fault ${o.holdSec ?? 60} s` },
          o.startSource
            ? { kind: 'shell', argv: ['sh', '-c', o.startSource], what: 'Start the primary source again' }
            : { kind: 'manual', what: 'Start the primary source again, then press Enter' },
        ],
        expect: [
          { id: 'switched', what: 'The active source moves off primary (backup, or filler when there is none)', budgetSec: d.lossDetectSec + 3 * d.pollSec + 5 },
          { id: 'no-stall', what: 'The public playlist never stops advancing for longer than three segments', budgetSec: 3 * d.segmentSec },
          { id: 'failback', what: 'Back on primary after the source returns', budgetSec: d.failbackHoldSec + d.lossDetectSec + 3 * d.pollSec + 10 },
        ],
        revert: [{ kind: 'manual', what: 'Make sure the primary source is sending again' }],
      };
    case 'fail-az': {
      const az = o.az || '<az>';
      const t = stack.templates?.[`az-${az}`] || stack.templates?.[az] || '<template id for az>';
      const steps = [
        { kind: 'aws', argv: aws(stack, 'fis', 'start-experiment', '--experiment-template-id', t, '--tags', 'Name=volt-chaos-fail-az'), what: `Cut ${az}'s private subnet off for ${d.faultSec} s (FIS network disruption)` },
        { kind: 'aws', argv: aws(stack, 'ec2', 'describe-instances', '--filters', `Name=availability-zone,Values=${az}`, 'Name=tag:AmazonECSManaged,Values=true', 'Name=instance-state-name,Values=running', '--query', 'Reservations[].Instances[].InstanceId', '--output', 'text'), what: `List the ECS servers in ${az}` },
        { kind: 'aws', argv: aws(stack, 'ec2', 'stop-instances', '--instance-ids', '<instances in az>'), what: `Stop them, as a zone loss would` },
      ];
      if (stack.dbMultiAz || o.dbFailover) {
        steps.push({ kind: 'aws', argv: aws(stack, 'rds', 'reboot-db-instance', '--db-instance-identifier', stack.dbInstance, '--force-failover'), what: 'Fail the database over to its standby' });
      }
      return {
        scenario: name, title: SCENARIOS[name],
        preconditions: [...pre, liveChannels,
          { id: 'spread', what: `control_plane_desired (and api_public_min) at 2 or more, so a task runs in each zone` },
          { id: 'not-nat', what: `${az} is not the zone with the NAT gateway (staging has one; losing it cuts every zone's way out, a known single point)` }],
        steps,
        expect: [
          { id: 'api-up', what: 'The API never stays unreachable longer than the budget', budgetSec: d.apiGapSec },
          { id: 'streams-back', what: 'Every channel is on air with an advancing playlist again', budgetSec: d.newServerSec },
        ],
        revert: [
          { kind: 'aws', argv: aws(stack, 'fis', 'stop-experiment', '--id', '<experiment id>'), what: 'End the network disruption early (it ends by itself after the fault time)' },
          { kind: 'none', what: 'The Auto Scaling groups replace the stopped servers; nothing to start by hand' },
        ],
      };
    }
    case 'spot-interrupt': {
      const t = stack.templates?.['spot-interrupt'] || '<spot template id>';
      return {
        scenario: name, title: SCENARIOS[name],
        preconditions: [...pre, liveChannels, { id: 'on-spot', what: 'At least one live encoder runs on a Spot server' }],
        steps: [
          { kind: 'aws', argv: aws(stack, 'fis', 'start-experiment', '--experiment-template-id', t, '--tags', 'Name=volt-chaos-spot'), what: 'Send a Spot interruption (two-minute notice) to one encoder server' },
        ],
        expect: [
          { id: 'back', what: 'Every channel on the interrupted server is on air again, on another server', budgetSec: 120 + d.newServerSec },
          { id: 'one-relaunch', what: 'One replacement task per channel' },
        ],
        revert: [{ kind: 'none', what: 'Nothing: the Spot group and the on-demand base replace the server' }],
      };
    }
    case 'scale-out':
      return {
        scenario: name, title: SCENARIOS[name],
        preconditions: [...pre, liveChannels, { id: 'k6', what: 'k6 installed on the load machine; an app key (pk_...) for a web app' }],
        steps: [
          { kind: 'k6', argv: ['k6', 'run', '--summary-export', '<summary.json>', '-e', `BASE=${stack.playBase}`, '-e', 'APP_KEY=<pk_...>', '-e', `ASSET=${ch[0]}`, '-e', `PEAK=${o.peak ?? 2000}`, '-e', `RAMP=${o.ramp ?? '120s'}`, '-e', `HOLD=${o.hold ?? '300s'}`, 'deploy/loadtest/viewer-start.js'], what: 'Drive viewer starts up to the peak' },
          { kind: 'aws', argv: aws(stack, 'ecs', 'describe-services', '--cluster', stack.cluster, '--services', stack.apiPublicService, '--query', 'services[0].[desiredCount,runningCount]', '--output', 'text'), what: 'Sample api-public desired and running tasks while it runs' },
        ],
        expect: [
          { id: 'scaled-out', what: 'api-public runs more tasks at the peak than at the start' },
          { id: 'p95', what: `Play gate p95 at or under ${d.p95Ms} ms` },
          { id: 'errors', what: `Failed requests at or under ${(d.errorRate * 100).toFixed(0)} %` },
        ],
        revert: [{ kind: 'none', what: 'Nothing: api-public scales back in by itself (watch it return to api_public_min)' }],
      };
    default:
      throw new Error(`unknown scenario "${name}" (one of: ${Object.keys(SCENARIOS).join(', ')})`);
  }
}

/** The longest time between two increases of the playlist's media sequence. */
export function longestStall(samples) {
  let last = null, lastT = null, worst = 0;
  for (const s of samples) {
    if (s.seq == null) continue;
    if (last == null || s.seq > last) {
      if (lastT != null) worst = Math.max(worst, s.t - lastT);
      last = s.seq; lastT = s.t;
    }
  }
  const end = samples.length ? samples[samples.length - 1].t : 0;
  if (lastT != null) worst = Math.max(worst, end - lastT);
  return worst;
}

const onAirish = (s) => s.status === 'live' && (s.overall === 'onair' || s.overall === 'ready');
const advancedAt = (samples, i) => {
  // the sequence went up at sample i compared with an earlier sample
  const s = samples[i];
  if (s.seq == null) return false;
  for (let j = i - 1; j >= 0; j--) if (samples[j].seq != null) return s.seq > samples[j].seq;
  return false;
};

/**
 * Judge a run. `samples` are what the loop saw, oldest first, `t` in seconds
 * from the moment of the fault: { t, api, status, overall, activeSource,
 * fallback, seq, taskArn, phase }. For channels, `samples` may be an object of
 * channel id -> samples. Returns each expectation with ok and what was seen.
 */
export function judge(name, samples, o = {}) {
  const p = plan(name, readStack({}), o);
  const budget = Object.fromEntries(p.expect.map((e) => [e.id, e.budgetSec]));
  const res = [];
  const add = (id, ok, detail) => res.push({ id, ok: !!ok, detail });
  const firstT = (arr, f) => { const i = arr.findIndex(f); return i < 0 ? null : arr[i].t; };

  if (name === 'kill-encoder' || name === 'spot-interrupt') {
    const per = Array.isArray(samples) ? { channel: samples } : samples;
    const orig = o.originalTasks || {};
    for (const [id, arr] of Object.entries(per)) {
      const was = orig[id] ?? arr.find((s) => s.t <= 0 && s.taskArn)?.taskArn ?? null;
      const after = arr.filter((s) => s.t > 0);
      if (name === 'kill-encoder') {
        // only an answer from the API counts: an unreachable API is not a notice
        const tN = firstT(after, (s) => s.api && (s.status !== 'live' || (s.taskArn && s.taskArn !== was)));
        add('noticed', tN != null && tN <= budget.noticed, tN == null ? `${id}: never seen as gone` : `${id}: seen at ${tN} s (budget ${budget.noticed} s)`);
      }
      let tB = null;
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (s.t > 0 && s.taskArn && s.taskArn !== was && onAirish(s) && advancedAt(arr, i)) { tB = s.t; break; }
      }
      add('back', tB != null && tB <= budget.back, tB == null ? `${id}: not back on air` : `${id}: back at ${tB} s (budget ${budget.back} s)`);
      const fresh = new Set(after.map((s) => s.taskArn).filter((a) => a && a !== was));
      add('one-relaunch', fresh.size <= 1, `${id}: ${fresh.size} replacement task(s)`);
    }
    return finish(name, res);
  }

  if (name === 'lose-source') {
    const arr = samples;
    const inj = arr.filter((s) => s.t > 0 && s.phase !== 'restored');
    const tS = firstT(inj, (s) => (s.activeSource && s.activeSource !== 'primary') || s.fallback);
    add('switched', tS != null && tS <= budget.switched, tS == null ? 'stayed on primary' : `moved at ${tS} s to ${inj.find((s) => s.t === tS).activeSource}${inj.find((s) => s.t === tS).fallback ? ' (filler)' : ''} (budget ${budget.switched} s)`);
    const stall = longestStall(arr.filter((s) => s.t >= 0));
    add('no-stall', stall <= budget['no-stall'], `longest gap ${stall} s (budget ${budget['no-stall']} s)`);
    const r = arr.find((s) => s.phase === 'restored');
    if (r) {
      const back = arr.filter((s) => s.t >= r.t);
      const tF = firstT(back, (s) => s.activeSource === 'primary' && !s.fallback);
      add('failback', tF != null && tF - r.t <= budget.failback, tF == null ? 'never returned to primary' : `primary again ${tF - r.t} s after it returned (budget ${budget.failback} s)`);
    } else add('failback', false, 'the source was never restored in this run');
    return finish(name, res);
  }

  if (name === 'fail-az') {
    const { api = [], channels = {} } = samples;
    let worst = 0, start = null;
    for (const s of api) {
      if (!s.api) { if (start == null) start = s.t; worst = Math.max(worst, s.t - start); }
      else start = null;
    }
    add('api-up', worst <= budget['api-up'], `longest outage ${worst} s (budget ${budget['api-up']} s)`);
    for (const [id, arr] of Object.entries(channels)) {
      // a channel never interrupted counts as back at 0; one that went down must come back
      const down = arr.some((s) => s.t > 0 && !onAirish(s));
      let tB = down ? null : 0;
      if (down) {
        const firstDown = arr.findIndex((s) => s.t > 0 && !onAirish(s));
        for (let i = firstDown; i < arr.length; i++) if (onAirish(arr[i]) && advancedAt(arr, i)) { tB = arr[i].t; break; }
      }
      add('streams-back', tB != null && tB <= budget['streams-back'], tB == null ? `${id}: not back` : `${id}: ${down ? `back at ${tB} s` : 'never interrupted'} (budget ${budget['streams-back']} s)`);
    }
    return finish(name, res);
  }

  if (name === 'scale-out') {
    const { tasks = [], k6 = {} } = samples;
    const first = tasks.find((s) => s.running != null)?.running ?? null;
    const peak = tasks.reduce((m, s) => Math.max(m, s.running ?? 0), 0);
    add('scaled-out', first != null && peak > first, `${first ?? '?'} to ${peak} running tasks`);
    const p95 = k6.p95Ms;
    add('p95', p95 != null && p95 <= (o.p95Ms ?? DEFAULTS.p95Ms), p95 == null ? 'no k6 summary' : `p95 ${Math.round(p95)} ms`);
    const er = k6.errorRate;
    add('errors', er != null && er <= (o.errorRate ?? DEFAULTS.errorRate), er == null ? 'no k6 summary' : `${(er * 100).toFixed(2)} % failed`);
    return finish(name, res);
  }
  throw new Error(`unknown scenario "${name}"`);
}

function finish(scenario, results) {
  return { scenario, pass: results.length > 0 && results.every((r) => r.ok), results };
}

/** The two figures the judge needs from `k6 run --summary-export`. */
export function readK6Summary(j) {
  const m = j?.metrics || {};
  const dur = m.gate_ms || m.http_req_duration || {};
  const fail = m.http_req_failed || {};
  return {
    p95Ms: dur['p(95)'] ?? dur.values?.['p(95)'] ?? null,
    errorRate: fail.value ?? fail.rate ?? fail.values?.rate ?? null,
  };
}

/** The media sequence of the first rendition behind a master playlist. */
export function mediaSequence(text) {
  const m = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text || '');
  if (!m) return null;
  // the last segment's number, so a playlist that keeps its window but adds a
  // segment still counts as advancing
  const segs = (text.match(/^#EXTINF/gm) || []).length;
  return Number(m[1]) + segs;
}
export function firstVariant(master, base) {
  const line = (master || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return line ? new URL(line, base).toString() : null;
}

/**
 * A real run refuses unless it is pointed at the stack it names, and never at
 * production (Tier 3 runs against the Tier-2 staging deployment).
 */
export function guard(stack, o) {
  const problems = [];
  if (!o.confirm || o.confirm !== stack.stackName) problems.push(`pass --confirm ${stack.stackName} to run against this stack`);
  if (/prod/i.test(stack.stackName) && !o.allowProd) problems.push('this looks like production; Tier 3 runs against staging (--allow-prod overrides)');
  if (/^</.test(stack.cluster) || /^</.test(stack.apiBase.replace(/^https?:\/\//, ''))) problems.push('the stack is not known: pass --tf-outputs <terraform output -json file>');
  return problems;
}

/**
 * Run a scenario. `io` does every outside action, so the dry run and the
 * check suite can swap it: exec(argv) -> stdout, getJson(url), getText(url),
 * prompt(text), sleep(ms), now(), log(line).
 */
export async function run(name, stack, o, io) {
  const p = plan(name, stack, o);
  const d = { ...DEFAULTS, ...o };
  if (o.dryRun) {
    io.log(`DRY RUN: ${p.title}`);
    for (const c of p.preconditions) io.log(`  first   ${c.what}`);
    for (const s of p.steps) io.log(`  do      ${s.what ?? ''}${s.argv ? `\n          $ ${s.argv.join(' ')}` : ''}`);
    for (const e of p.expect) io.log(`  expect  ${e.what}${e.budgetSec ? ` (within ${e.budgetSec} s)` : ''}`);
    for (const r of p.revert) io.log(`  undo    ${r.what ?? ''}${r.argv ? `\n          $ ${r.argv.join(' ')}` : ''}`);
    return { scenario: name, dryRun: true, plan: p };
  }
  const bad = guard(stack, o);
  if (bad.length) throw new Error(bad.join('; '));

  const chans = o.channels || [];
  const auth = o.key ? { authorization: `Bearer ${o.key}` } : {};
  const t0 = io.now();
  const at = () => Math.round((io.now() - t0) / 1000);
  const sample = async (id, phase) => {
    let row = null;
    try { row = await io.getJson(`${stack.apiBase}/api/channels/${id}`, auth); } catch { /* recorded as unreachable */ }
    let seq = null;
    try {
      const master = await io.getText(`${stack.playBase}/live/${id}/master.m3u8`);
      const v = firstVariant(master, `${stack.playBase}/live/${id}/`);
      if (v) seq = mediaSequence(await io.getText(v));
    } catch { /* no playlist: seq stays null */ }
    return {
      t: 0, api: !!row, phase,
      status: row?.status ?? null, overall: row?.health?.overall ?? null,
      activeSource: row?.statusBoard?.activeSource ?? null,
      fallback: row?.statusBoard?.fallback === 'Engaged',
      seq, taskArn: row?.instances?.[0]?.task_arn ?? null,
    };
  };
  const series = Object.fromEntries(chans.map((c) => [c, []]));
  const api = [];
  const poll = async (phase, untilSec) => {
    while (true) {
      for (const c of chans) { const s = await sample(c, phase); s.t = at(); series[c].push(s); }
      try { await io.getJson(`${stack.apiBase}/health/ready`); api.push({ t: at(), api: true }); } catch { api.push({ t: at(), api: false }); }
      if (at() >= untilSec) return;
      await io.sleep(d.pollSec * 1000);
    }
  };

  // a baseline before the fault, at negative time
  const before = {};
  for (const c of chans) { const s = await sample(c, 'before'); s.t = -1; series[c].push(s); before[c] = s.taskArn; }
  const window = Math.max(...p.expect.map((e) => e.budgetSec || 0), 60) + 30;

  if (name === 'kill-encoder') {
    const arn = before[chans[0]];
    if (!arn) throw new Error(`channel ${chans[0]} has no running task to kill`);
    io.exec(p.steps[1].argv.map((a) => (a === '<task arn>' ? arn : a)));
    await poll('inject', window);
    return { ...judge(name, { [chans[0]]: series[chans[0]] }, { ...o, originalTasks: before }), samples: series };
  }
  if (name === 'lose-source') {
    const [stop, , start] = p.steps;
    if (stop.kind === 'shell') io.exec(stop.argv); else await io.prompt(stop.what);
    await poll('inject', o.holdSec ?? 60);
    if (start.kind === 'shell') io.exec(start.argv); else await io.prompt(start.what);
    const s = await sample(chans[0], 'restored'); s.t = at(); series[chans[0]].push(s);
    await poll('restored', at() + 60);
    return { ...judge(name, series[chans[0]], o), samples: series };
  }
  if (name === 'fail-az') {
    const started = JSON.parse(io.exec(p.steps[0].argv) || '{}');
    const ids = String(io.exec(p.steps[1].argv) || '').split(/\s+/).filter(Boolean);
    if (ids.length) io.exec(p.steps[2].argv.flatMap((a) => (a === '<instances in az>' ? ids : [a])));
    if (p.steps[3]) io.exec(p.steps[3].argv);
    await poll('inject', window);
    io.log(`experiment ${started?.experiment?.id ?? '?'} ends by itself after ${d.faultSec} s`);
    return { ...judge(name, { api, channels: series }, o), samples: { api, channels: series } };
  }
  if (name === 'spot-interrupt') {
    io.exec(p.steps[0].argv);
    await poll('inject', window);
    return { ...judge(name, series, { ...o, originalTasks: before }), samples: series };
  }
  if (name === 'scale-out') {
    const tasks = [];
    const read = () => {
      const [desired, running] = String(io.exec(p.steps[1].argv) || '').trim().split(/\s+/).map(Number);
      tasks.push({ t: at(), desired, running });
    };
    read();
    const summary = o.summaryPath || 'k6-summary.json';
    const k6argv = p.steps[0].argv.map((a) => (a === '<summary.json>' ? summary : a === 'APP_KEY=<pk_...>' ? `APP_KEY=${o.appKey}` : a));
    const done = io.spawn(k6argv);
    while (!(await done.finished(d.pollSec * 1000))) read();
    read();
    const k6 = readK6Summary(io.readJson(summary));
    return { ...judge(name, { tasks, k6 }, o), samples: { tasks } };
  }
  throw new Error(`unknown scenario "${name}"`);
}
