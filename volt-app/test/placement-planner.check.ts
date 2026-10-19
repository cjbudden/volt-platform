// ============================================================================
//  Placement planner: a new stream goes on the fullest running server that
//  can take it without its existing streams noticing, in the right pool for
//  its plan and its hardware, and only gets a new server when none can.
//
//  Usage: npx tsx test/placement-planner.check.ts
// ============================================================================
import { choosePlacement, lifecyclesFor, DEFAULT_PLACEMENT, DEFAULT_POOLS, type PlacementRequest } from '../src/services/fleet/placementPlanner';
import { reserve, estimateEncoderLoad } from '../src/services/fleet/streamLoad';
import { host, task, load, checker } from './fleet-fixtures';

const { check, done } = checker();

const req = (o: Partial<PlacementRequest> = {}): PlacementRequest => {
  const l = o.load ?? load(500, 20);
  return { streamId: 's', streamClass: 'channel', accountId: 'acct', isolation: 'shared', load: l, reservation: reserve(l), needsGpu: false, ...o };
};

// 1. Packs onto the FULLEST running server with room.
{
  const d = choosePlacement(req(), [host('a', [task(load(300))]), host('b', [task(load(900))]), host('c', [])]);
  check('goes to an existing server', d.action, 'existing_host');
  check('...the fullest one that fits', d.action === 'existing_host' && d.hostId, 'b');
  check('...and names its EC2 instance for the placement constraint', d.action === 'existing_host' && d.ec2InstanceId, 'i-b');
}

// 2. Never pushes a server past the ceiling: the existing streams come first.
{
  const busy = host('a', [task(load(2200))], { cpuPct: 60 });
  const d = choosePlacement(req(), [busy]);
  check('busy server refused: a new one is started', d.action, 'new_host');
  check('...and the reason is recorded', d.considered[0]?.reason.startsWith('CPU would reach'), true);
}

// 3. Network is a ceiling too (package-only runs out of NIC before CPU).
{
  const heavyNet = host('a', [task(load(200, 900))]);
  const d = choosePlacement(req({ load: load(200, 200) }), [heavyNet]);
  check('network-bound server refused', d.considered[0]?.reason.startsWith('network would reach'), true);
}

// 4. 24/7 channels on on-demand; events may use Spot first.
{
  check('channels: on-demand only by default', lifecyclesFor('channel', DEFAULT_PLACEMENT), ['on_demand']);
  check('events: Spot first, on-demand fallback', lifecyclesFor('event', DEFAULT_PLACEMENT), ['spot', 'on_demand']);
  const spotHost = host('s', [task()], { lifecycle: 'spot', capacityProvider: 'volt-spot' });
  const ch = choosePlacement(req(), [spotHost]);
  check('channel does not land on Spot', [ch.action, ch.action === 'new_host' && ch.lifecycle], ['new_host', 'on_demand']);
  const ev = choosePlacement(req({ streamClass: 'event' }), [spotHost, host('o', [task()])]);
  check('event prefers the Spot server', ev.action === 'existing_host' && ev.hostId, 's');
}

// 5. GPU work only on GPU servers; CPU work never takes a GPU server.
{
  const gpuHost = host('g', [], { instanceType: 'g4dn.xlarge', capacityProvider: 'volt-gpu' });
  const cpu = choosePlacement(req(), [gpuHost]);
  check('CPU stream skips the GPU server', cpu.considered[0]?.reason, 'GPU server (kept for GPU work)');
  const gl = load(300, 20, { gpus: 1, gpuShare: 0.2 });
  const gpuReq = req({ load: gl, reservation: reserve(gl), needsGpu: true });
  check('GPU stream goes to the GPU server', choosePlacement(gpuReq, [gpuHost]).action, 'existing_host');
  const taken = host('g2', [task(gl)], { instanceType: 'g4dn.xlarge' });
  check('GPU already reserved: not shared by default', choosePlacement(gpuReq, [taken]).considered[0]?.reason, 'GPU already taken');
  check('no GPU pool configured: unplaceable with a reason', choosePlacement(gpuReq, []).action, 'unplaceable');
  const withPool = choosePlacement(gpuReq, [], { ...DEFAULT_PLACEMENT, pools: [...DEFAULT_POOLS, { provider: 'volt-gpu', lifecycle: 'on_demand', gpu: true, pool: 'shared', types: ['g4dn.xlarge'] }] });
  check('GPU pool configured: new GPU server', [withPool.action, withPool.action === 'new_host' && withPool.instanceType], ['new_host', 'g4dn.xlarge']);
}

// 6. Isolation follows the plan.
{
  const ded = host('d', [], { pool: 'dedicated:acct', capacityProvider: 'volt-ded-acct' });
  check('shared account never lands in a dedicated pool', choosePlacement(req(), [ded]).action, 'new_host');
  const dreq = req({ isolation: 'dedicated' });
  check('dedicated account uses its own pool', choosePlacement(dreq, [host('a', []), ded]).action === 'existing_host', true);
  check('dedicated account never lands in the shared pool', choosePlacement(dreq, [host('a', [])]).action, 'unplaceable');
}

// 7. Reservation and task slots are enforced (ECS would refuse otherwise).
{
  const full = host('a', [task(load(100)), task(load(100)), task(load(100))]);
  check('no task slot left', choosePlacement(req(), [full]).considered[0]?.reason, 'no task slot (network interfaces) left');
}

// 8. A new server comes from the smallest pool whose servers hold the stream.
{
  const small = choosePlacement(req(), []);
  check('a light stream gets a small server', small.action === 'new_host' && [small.capacityProvider, small.instanceType], ['volt-ondemand', 'c7i.xlarge']);
  const big = load(3500, 50);
  const d = choosePlacement(req({ load: big, reservation: reserve(big) }), []);
  check('a 3.5-vCPU stream goes to the large pool', d.action === 'new_host' && [d.capacityProvider, d.instanceType], ['volt-ondemand-large', 'c7i.2xlarge']);
  const ladder = estimateEncoderLoad({ workflow: 'transcode', fps: 25, ladder: [{ height: 1080, bitrate_kbps: 5000 }, { height: 720, bitrate_kbps: 3000 }, { height: 480, bitrate_kbps: 1500 }, { height: 360, bitrate_kbps: 800 }], inputs: [{ role: 'primary' }] });
  const lp = choosePlacement(req({ load: ladder.load, reservation: ladder.reservation }), []);
  check('a real 4-rung 1080p x264 ladder gets a large server', lp.action === 'new_host' && lp.capacityProvider, 'volt-ondemand-large');
  const pk = estimateEncoderLoad({ workflow: 'package_only', inputs: [{ role: 'primary', bitrate_kbps: 5000 }, { role: 'primary', bitrate_kbps: 3000 }] });
  const pp = choosePlacement(req({ load: pk.load, reservation: pk.reservation }), []);
  check('a package-only channel gets a small server', pp.action === 'new_host' && pp.capacityProvider, 'volt-ondemand');
  const huge = load(9000, 50);
  const u = choosePlacement(req({ load: huge, reservation: reserve(huge) }), []);
  check('bigger than any configured server: said plainly', [u.action, u.reason.includes('larger than the biggest')], ['unplaceable', true]);
  const ev = choosePlacement(req({ streamClass: 'event' }), []);
  check('an event with nothing running gets a Spot server', ev.action === 'new_host' && ev.capacityProvider, 'volt-spot');
}

// 9. A freshly booted server (no full telemetry window) is still packed, on estimates.
{
  const fresh = host('f', [task(load(600), { pending: true })], { observed: null });
  check('fresh server is filled on estimates', choosePlacement(req(), [fresh]).action, 'existing_host');
}

done();
