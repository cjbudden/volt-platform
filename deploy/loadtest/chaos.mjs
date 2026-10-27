#!/usr/bin/env node
// Volt chaos and scaling harness (build queue 2.8). The run sheet is CHAOS.md.
//
//   node deploy/loadtest/chaos.mjs <scenario> --dry-run [--tf-outputs out.json] [--channel <id>]
//   node deploy/loadtest/chaos.mjs <scenario> --tf-outputs out.json --confirm <stack> \
//        --key sk_live_... --channel <id> [--channel <id> ...] [scenario options]
//
// Scenarios: kill-encoder, lose-source, fail-az, spot-interrupt, scale-out.
// Options: --az <zone> (fail-az), --new-server (kill-encoder budget when no
// server has room), --stop-source/--start-source "<shell>" (lose-source; asks
// you to do it by hand otherwise), --hold <s>, --peak/--ramp/--hold-load and
// --app-key pk_... (scale-out), --api-base / --play-base / --region overrides,
// --out result.json (every sample and the verdict).
//
// A real run needs the AWS CLI signed in to the staging account and refuses
// without --confirm naming the stack, or against anything called prod.
// Exit code: 0 pass, 1 an expectation failed, 2 the run could not start.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { readStack, run, SCENARIOS } from './chaos-lib.mjs';

function args(argv) {
  const o = { channels: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    switch (a) {
      case '--dry-run': o.dryRun = true; break;
      case '--tf-outputs': o.tfOutputs = val(); break;
      case '--confirm': o.confirm = val(); break;
      case '--allow-prod': o.allowProd = true; break;
      case '--key': o.key = val(); break;
      case '--channel': o.channels.push(val()); break;
      case '--az': o.az = val(); break;
      case '--new-server': o.newServer = true; break;
      case '--db-failover': o.dbFailover = true; break;
      case '--stop-source': o.stopSource = val(); break;
      case '--start-source': o.startSource = val(); break;
      case '--hold': o.holdSec = Number(val()); break;
      case '--peak': o.peak = Number(val()); break;
      case '--ramp': o.ramp = val(); break;
      case '--hold-load': o.hold = val(); break;
      case '--app-key': o.appKey = val(); break;
      case '--api-base': o.apiBase = val(); break;
      case '--play-base': o.playBase = val(); break;
      case '--region': o.region = val(); break;
      case '--out': o.out = val(); break;
      default: rest.push(a);
    }
  }
  return { o, scenario: rest[0] };
}

const { o, scenario } = args(process.argv.slice(2));
if (!scenario || !SCENARIOS[scenario]) {
  console.error(`usage: chaos.mjs <${Object.keys(SCENARIOS).join('|')}> [--dry-run] ...  (see CHAOS.md)`);
  process.exit(2);
}
const tf = o.tfOutputs ? JSON.parse(readFileSync(o.tfOutputs, 'utf8')) : {};
const stack = readStack(tf, { apiBase: o.apiBase, playBase: o.playBase, region: o.region });
o.key = o.key || process.env.VOLT_KEY;
o.appKey = o.appKey || process.env.VOLT_APP_KEY;

const io = {
  log: (l) => console.log(l),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  exec: (argv) => {
    console.log(`$ ${argv.join(' ')}`);
    return execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  },
  getJson: async (url, headers = {}) => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  },
  getText: async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.text();
  },
  prompt: async (text) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question(`${text} `);
    rl.close();
  },
  spawn: (argv) => {
    console.log(`$ ${argv.join(' ')}`);
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
    let done = false;
    child.on('exit', () => { done = true; });
    return { finished: (ms) => new Promise((r) => setTimeout(() => r(done), ms)) };
  },
  readJson: (p) => JSON.parse(readFileSync(p, 'utf8')),
};

try {
  const r = await run(scenario, stack, o, io);
  if (r.dryRun) process.exit(0);
  for (const x of r.results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.id}: ${x.detail}`);
  console.log(r.pass ? `\n${scenario}: passed` : `\n${scenario}: FAILED`);
  if (o.out) writeFileSync(o.out, JSON.stringify(r, null, 2));
  process.exit(r.pass ? 0 : 1);
} catch (e) {
  console.error(`could not run ${scenario}: ${e.message}`);
  process.exit(2);
}
