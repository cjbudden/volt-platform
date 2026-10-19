// ============================================================================
//  What a customer is told about their stream's server: running or not, and
//  for every problem, a fix they can act on (or a plain "this is ours").
//  No CPU units, instance types or capacity providers ever reach them.
//
//  Usage: npx tsx test/server-status.check.ts
// ============================================================================
import { describeServer } from '../src/services/fleet/serverStatus';
import { estimateEncoderLoad } from '../src/services/fleet/streamLoad';
import { checker } from './fleet-fixtures';

const { check, done } = checker();
const est = estimateEncoderLoad({ workflow: 'package_only', inputs: [{ role: 'primary', bitrate_kbps: 5000 }] });
const base = { streamLive: true, taskRunning: true, placed: true, minutesSinceLaunch: 30, decision: { action: 'existing_host' }, basis: 'estimate', estimate: est };

const ok = describeServer(base);
check('healthy: running, no issue', [ok.state, ok.headline, ok.issue], ['running', 'Running', null]);
check('sized from settings until measured', ok.sizedFrom, 'your settings');
check('...then from measured runs', describeServer({ ...base, basis: 'observed' }).sizedFrom, 'measured runs like this one');

const stopped = describeServer({ ...base, taskRunning: false, streamLive: false });
check('stopped: not running', [stopped.state, stopped.issue], ['stopped', null]);

const fresh = describeServer({ ...base, streamLive: false, placed: false, minutesSinceLaunch: 1, decision: { action: 'new_host' } });
check('new server starting: says so, no issue yet', [fresh.state, fresh.headline, fresh.issue], ['starting', 'Starting a server for this stream', null]);
const stuck = describeServer({ ...base, streamLive: false, placed: false, minutesSinceLaunch: 15, decision: { action: 'new_host' } });
check('server late: an issue that is ours to fix', [stuck.issue?.ours, stuck.issue?.fix.includes('our side')], [true, true]);

const big = describeServer({ ...base, decision: { action: 'unplaceable', reason: 'this stream is larger than the biggest configured server can run' } });
check('too big: a warning with a fix the person can do', [big.headline, big.issue?.ours, big.issue?.fix.includes('Remove the highest rendition')], ['Running, with a warning', false, true]);
const ded = describeServer({ ...base, decision: { action: 'unplaceable', reason: 'this account is on a dedicated plan but no dedicated server pool is configured for it' } });
check('dedicated pool missing: ours, contact support', [ded.issue?.ours, ded.issue?.fix.includes('Contact support')], [true, true]);
const gpu = describeServer({ ...base, decision: { action: 'unplaceable', reason: 'this stream needs a GPU and no GPU server pool is configured' } });
check('GPU not available: switch to CPU encoding', gpu.issue?.fix.startsWith('Switch the output profile'), true);

const all = [ok, stopped, fresh, stuck, big, ded, gpu].map((s) => JSON.stringify(s)).join(' ');
check('no load jargon reaches a customer', /cpu units|cpuUnits|xlarge|capacity provider|MiB|gbps/i.test(all), false);

done();
