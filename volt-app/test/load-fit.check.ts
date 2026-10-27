// ============================================================================
//  Load learning, storage projection and the task disk check (build queue
//  2.4a). Pure: no database. The DB side is load-learning.check.ts.
//
//  Usage: npx tsx test/load-fit.check.ts
// ============================================================================
import { estimateEncoderLoad, type LoadEstimate } from '../src/services/fleet/streamLoad';
import { fitRuns, fitLoadModel, fitFor, applyFit, componentOf, DEFAULT_LOAD_FIT, type RunObservation } from '../src/services/fleet/loadFit';
import { projectStorage, scratchMibAt } from '../src/services/fleet/storageProjection';
import { summarizeProjection } from '../src/services/fleet/projectionReport';
import { fits, capacityOf, DISK_USABLE } from '../src/services/fleet/capacity';
import { choosePlacement, DEFAULT_PLACEMENT } from '../src/services/fleet/placementPlanner';
import { occupancyOf } from '../src/services/fleet/fleetModel';
import { checker, host, task, load } from './fleet-fixtures';

const { check, done } = checker();
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.abs(b);

// ---------------------------------------------------------------------------
// A world where the starting coefficients are wrong in known ways.
// ---------------------------------------------------------------------------
const TRUE: Record<string, number> = {
  'encode:x264': 1.35, 'decode:h264': 0.8, 'decode:hevc': 1.2, 'package': 1.15, 'ingest': 0.9, 'audio': 1.0, 'drm': 1.0,
};
const LADDERS = [
  [[1080, 5000], [720, 3000], [480, 1500], [360, 800]],
  [[720, 3000], [480, 1500]],
  [[1080, 6000], [720, 3500]],
  [[480, 1200], [360, 700], [240, 400]],
  [[1080, 4500], [540, 2000]],
  [[720, 2500]],
];
// Each run draws its settings independently (a fixed pseudo-random sequence),
// so every component varies on its own and the fit can tell them apart.
const pick = (i: number, salt: number, n: number) => Math.floor((((i + 1) * 2654435761 + salt * 40503) % 4294967296) / 4294967296 * n);
function job(i: number) {
  const ladder = LADDERS[pick(i, 1, LADDERS.length)].map(([height, bitrate_kbps]) => ({ height, bitrate_kbps }));
  const fps = [25, 30, 50][pick(i, 2, 3)];
  return {
    workflow: 'transcode', fps, gpu: false, ladder,
    inputs: [{ role: 'primary', protocol: 'srt', url: 'srt://x' }, ...(pick(i, 3, 4) === 0 ? [{ role: 'backup', protocol: 'srt', url: 'srt://y' }] : [])],
    drm: pick(i, 4, 5) === 0,
  };
}
function probe(i: number) {
  const h = [720, 1080, 2160][pick(i, 7, 3)];
  return {
    video: { codec: pick(i, 5, 2) ? 'hevc' : 'h264', width: Math.round(h * 16 / 9), height: h, fps: [25, 30, 50][pick(i, 2, 3)], bitrate_kbps: 4000 + pick(i, 6, 8) * 2000 },
    audio: Array.from({ length: 1 + pick(i, 8, 3) }, () => ({})),
  };
}
/** What the server would measure: each component at its TRUE cost. */
const trueCpu = (e: LoadEstimate) => e.lines.reduce((s, l) => s + l.cpuUnits * (TRUE[componentOf(l)] ?? 1), 0);
const trueNet = (e: LoadEstimate) => (e.load.netInBps + e.load.netOutBps) * 1.08;

function runs(count: number, family = 'c7i', from = 0): RunObservation[] {
  return Array.from({ length: count }, (_, k) => {
    const e = estimateEncoderLoad(job(from + k), probe(from + k));
    return { family, lines: e.lines, cpuUnitsP95: trueCpu(e), netBpsP95: trueNet(e), hours: 6 };
  });
}

// 1. Known synthetic runs recover their coefficients.
const obs = runs(60);
const fit = fitRuns('c7i', obs)!;
console.log('   fitted:', Object.fromEntries(Object.entries(fit.cpu).map(([k, v]) => [k, v.multiplier])), 'net', fit.net.multiplier);
check('fit: made from all 60 runs, none set aside', [fit.runs, fit.setAside], [60, 0]);
check('fit: x264 encode recovered within 3 %', near(fit.cpu['encode:x264'].multiplier, 1.35, 0.03), true);
check('fit: H.264 decode recovered within 5 %', near(fit.cpu['decode:h264'].multiplier, 0.8, 0.05), true);
check('fit: HEVC decode recovered within 5 %', near(fit.cpu['decode:hevc'].multiplier, 1.2, 0.05), true);
// Packaging, ingest and audio all scale with bitrates and track counts that
// move with the source and the ladder, so the history cannot fully tell them
// apart: they can trade off against each other (and against decode) while the
// total stays right. The total is what sizes a stream, so that is checked, on
// every run and not only on the median.
const totalErr = obs.map((o) => {
  const f = o.lines.reduce((s2, l) => s2 + l.cpuUnits * (fit.cpu[componentOf(l)]?.multiplier ?? 1), 0);
  return Math.abs(f - o.cpuUnitsP95) / o.cpuUnitsP95;
}).sort((a, b) => a - b);
console.log(`   total CPU error per run: median ${totalErr[30].toFixed(3)}, worst ${totalErr[59].toFixed(3)}`);
check('fit: every run\'s total CPU within 5 % of what it measured', totalErr[59] < 0.05, true);
check('fit: network overhead recovered within 2 %', near(fit.net.multiplier, 1.08, 0.02), true);
check('fit: projection error drops (median, before > after)', fit.cpuErrorBefore > 0.15 && fit.cpuErrorAfter < 0.02, true);

// 2. One odd run cannot move it far.
const odd = [...obs, { ...obs[0], cpuUnitsP95: obs[0].cpuUnitsP95 * 10 }, { ...obs[1], cpuUnitsP95: obs[1].cpuUnitsP95 * 0.05 }];
const fitOdd = fitRuns('c7i', odd)!;
check('outliers: both odd runs set aside', fitOdd.setAside, 2);
check('outliers: x264 multiplier moves less than 1 %', near(fitOdd.cpu['encode:x264'].multiplier, fit.cpu['encode:x264'].multiplier, 0.01), true);
// Even when every run is wildly off, the clamp holds.
const wild = obs.map((o) => ({ ...o, cpuUnitsP95: o.cpuUnitsP95 * 6 }));
const fitWild = fitRuns('c7i', wild)!;
check('bound: no multiplier above 2x however high the readings', Object.values(fitWild.cpu).every((c) => c.multiplier <= DEFAULT_LOAD_FIT.bound), true);
check('bound: the clamp is reported', fitWild.cpu['encode:x264'].clamped, true);
const tiny = obs.map((o) => ({ ...o, cpuUnitsP95: o.cpuUnitsP95 * 0.1 }));
check('floor: no multiplier below 0.5x however low the readings', Object.values(fitRuns('c7i', tiny)!.cpu).every((c) => c.multiplier >= DEFAULT_LOAD_FIT.floor), true);
// Few runs: the prior holds a component near its starting value.
const few = fitRuns('c7i', runs(5))!;
check('prior: five runs move x264 towards the truth but not all the way', few.cpu['encode:x264'].multiplier > 1.02 && few.cpu['encode:x264'].multiplier < 1.35, true);
check('too few runs: no fit', fitRuns('c7i', runs(4)), null);

// 3. Per family, with the all-family fit as fallback.
const fams = fitLoadModel([...runs(30, 'c7i'), ...runs(3, 'c5', 30)]);
check('family: c7i has its own fit, c5 (3 runs) does not', [!!fams.byFamily.c7i, !!fams.byFamily.c5], [true, false]);
check('family: c5 falls back to all families', fitFor(fams, 'c5')?.family, '*');
check('family: c7i uses its own', fitFor(fams, 'c7i')?.family, 'c7i');

// 4. A NEW ladder (never run) starts nearer its real cost.
const newJob = { workflow: 'transcode', fps: 30, gpu: false, ladder: [{ height: 1080, bitrate_kbps: 7000 }, { height: 900, bitrate_kbps: 5000 }, { height: 540, bitrate_kbps: 1800 }], inputs: [{ role: 'primary' }] };
const newProbe = { video: { codec: 'h264', width: 1920, height: 1080, fps: 30, bitrate_kbps: 9000 }, audio: [{}] };
const raw = estimateEncoderLoad(newJob, newProbe);
const learned = applyFit(raw, fit);
const truth = trueCpu(raw);
console.log(`   new ladder: constants ${raw.load.cpuUnits}, learned ${learned.load.cpuUnits}, true ${Math.round(truth)}`);
check('new ladder: learned estimate is closer to the real cost than the constants', Math.abs(learned.load.cpuUnits - truth) < Math.abs(raw.load.cpuUnits - truth) * 0.25, true);
check('new ladder: basis says fitted, and from which fit', [learned.basis, learned.fit], ['fitted', { family: 'c7i', runs: 60 }]);
check('new ladder: the unfitted lines are kept for later learning', learned.baseLines?.[0].cpuUnits, raw.lines[0].cpuUnits);
check('new ladder: reservation follows the learned load', learned.reservation.cpuUnits >= learned.load.cpuUnits, true);
check('no fit: estimate unchanged', applyFit(raw, null), raw);

// 5. Lines stored before components were tagged are still recognised.
check('old lines: components from their wording',
  ['encode 720p @ 3000 kbps (x264)', 'encode 720p @ 3000 kbps (NVENC)', 'decode HEVC 1080p', 'decode H.264 1080p on GPU', 'source in (1080p, 8 Mbps)', 'relay 2 renditions in', 'package + upload to origin', 'audio: 2 AAC tracks']
    .map((what) => componentOf({ what, cpuUnits: 1, memoryMib: 0, gpuShare: 0, netInBps: 0, netOutBps: 0 })),
  ['encode:x264', 'encode:nvenc', 'decode:hevc', 'decode:gpu', 'ingest', 'ingest', 'package', 'audio']);
check('new lines: every CPU line of a transcode carries its component', raw.lines.filter((l) => l.cpuUnits > 0).every((l) => !!l.component), true);

// ---------------------------------------------------------------------------
// Storage projection
// ---------------------------------------------------------------------------
const ladder4 = [{ height: 1080, bitrate_kbps: 5000 }, { height: 720, bitrate_kbps: 3000 }, { height: 480, bitrate_kbps: 1500 }, { height: 360, bitrate_kbps: 800 }];
const t4 = estimateEncoderLoad({ workflow: 'transcode', fps: 25, ladder: ladder4, inputs: [{ role: 'primary' }], recording: { enabled: true, retention_sec: 7 * 86400 } },
  { video: { codec: 'h264', width: 1920, height: 1080, fps: 25, bitrate_kbps: 8000 }, audio: [{}] });
const arithmetic = (10300 + 128) * 1000 / 8 * 3600; // the ladder's bitrates plus one AAC track, bytes per hour
console.log(`   4-rung ladder: ${t4.storage.s3BytesPerHour} bytes/h projected, ${arithmetic} by the bitrates; ${t4.storage.scratchMibPerHour} MiB/h on the task disk`);
check('storage: S3 per hour within 10 % of the bitrate arithmetic', near(t4.storage.s3BytesPerHour, arithmetic, 0.10), true);
check('storage: task disk per hour = the same bytes in MiB', near(t4.storage.scratchMibPerHour, t4.storage.scratchBytesPerHour / 1048576, 0.001), true);
check('storage: held under a 7 day retention = 7 x 24 hours of output', t4.storage.s3HeldBytesAtSteadyState, t4.storage.s3BytesPerHour * 24 * 7);
check('storage: retention reported in days', t4.storage.retentionDays, 7);
check('storage: no retention means kept until deleted (null, not a guess)', projectStorage(1000, null).s3HeldBytesAtSteadyState, null);
const pkg = estimateEncoderLoad({ workflow: 'package_only', inputs: [{ role: 'primary', bitrate_kbps: 5000 }, { role: 'primary', bitrate_kbps: 3000 }, { role: 'backup', bitrate_kbps: 5000 }] });
check('storage: package-only stores what it passes through, not its backup', pkg.storage.outKbps, Math.round((8000 + 128) * 1.05));
check('storage: scratch at the horizon counts what is already written', scratchMibAt(100, 5, 24), 2900);

// ---------------------------------------------------------------------------
// The task disk check in placement
// ---------------------------------------------------------------------------
const cap30 = capacityOf('c7i.2xlarge', {}, { diskGib: 30 })!;
check('disk: capacity carries the configured task disk', cap30.diskMib, 30720);
check('disk: no disk configured, no disk in capacity', 'diskMib' in capacityOf('c7i.2xlarge', {})!, false);
const add = { reservation: { cpuUnits: 512, memoryMib: 512, gpus: 0 }, load: load(300) };
const occ = { reserved: { cpuUnits: 0, memoryMib: 0, gpus: 0 }, tasks: 0, cpuUnits: 0, netBps: 0, gpuShare: 0, diskMib: 20000 };
check('disk: fits while the total stays under the usable share', fits(cap30, occ, { ...add, diskMib: 30720 * DISK_USABLE - 20000 - 1 }).ok, true);
const short = fits(cap30, occ, { ...add, diskMib: 8000 });
check('disk: refused when the task disk would run short', [short.ok, short.reason], [false, 'task disk would run short (27 of 30 GiB)']);
check('disk: unknown disk is not checked', fits(capacityOf('c7i.2xlarge', {})!, occ, { ...add, diskMib: 1e9 }).ok, true);

// A host whose streams will fill its disk is passed over for one that has room.
const policy = { ...DEFAULT_PLACEMENT, taskDiskGib: 30 };
const fullDisk = host('disk-full', [task(load(300), { diskMibAtHorizon: 24000 })], { cpuPct: 20 });
const roomy = host('disk-roomy', [task(load(300), { diskMibAtHorizon: 2000 })], { cpuPct: 10 });
fullDisk.capacity = capacityOf('c7i.xlarge', {}, { diskGib: 30 })!;
roomy.capacity = capacityOf('c7i.xlarge', {}, { diskGib: 30 })!;
check('disk: occupancy sums what the streams will hold', occupancyOf(fullDisk, 'conservative')!.diskMib, 24000);
const req = { streamId: 's', streamClass: 'channel' as const, accountId: null, isolation: 'shared' as const, load: load(300), reservation: { cpuUnits: 512, memoryMib: 768, gpus: 0 }, needsGpu: false, diskMib: 4000 };
const d1 = choosePlacement(req, [fullDisk, roomy], policy);
check('disk: the fuller-CPU server is passed over because its disk would run short', [d1.action, (d1 as any).hostId], ['existing_host', 'disk-roomy']);
check('disk: the reason is recorded', d1.considered.find((c) => c.hostId === 'disk-full')?.reason?.startsWith('task disk would run short'), true);
const d2 = choosePlacement({ ...req, diskMib: 40000 }, [fullDisk, roomy], policy);
check('disk: a stream bigger than an empty server\'s disk is unplaceable, and says why', [d2.action, d2.reason.includes('30 GiB task disk')], ['unplaceable', true]);
const plainHosts = [host('plain-a', [task(load(300))], { cpuPct: 20 }), host('plain-b', [task(load(300))], { cpuPct: 10 })];
check('disk: without a configured disk size placement is unchanged', [choosePlacement({ ...req, diskMib: 40000 }, plainHosts).action, (choosePlacement({ ...req, diskMib: 40000 }, plainHosts) as any).hostId], ['existing_host', 'plain-a']);

// ---------------------------------------------------------------------------
// Projection against actual, per class
// ---------------------------------------------------------------------------
const rep = summarizeProjection([
  { taskKind: 'transcode', basis: 'estimate', projectedCpuUnits: 2000, actualCpuUnitsP95: 2600, projectedNetBps: 2e7, actualNetBpsP95: 2.1e7, projectedStoreBytesPerHour: 4.5e9, actualOutBpsMean: 1e7 },
  { taskKind: 'transcode', basis: 'fitted', projectedCpuUnits: 2500, actualCpuUnitsP95: 2550, projectedNetBps: 2e7, actualNetBpsP95: 2e7, projectedStoreBytesPerHour: 4.5e9, actualOutBpsMean: 1e7 },
  { taskKind: 'package_only', basis: 'estimate', projectedCpuUnits: 400, actualCpuUnitsP95: 380, projectedNetBps: 1.7e7, actualNetBpsP95: null, projectedStoreBytesPerHour: null, actualOutBpsMean: 8e6 },
]);
check('report: one row per class', rep.map((r) => [r.taskKind, r.runs]), [['package_only', 1], ['transcode', 2]]);
const tx = rep.find((r) => r.taskKind === 'transcode')!;
check('report: basis counted', tx.basis, { estimate: 1, fitted: 1 });
check('report: CPU median ratio actual/projected', tx.cpu.medianRatio, 1.16);
check('report: share of runs under-projected by more than 10 %', tx.cpu.underProjected, 0.5);
check('report: storage compares bytes stored per hour', tx.storage.medianRatio, 1);
check('report: a missing measurement is not counted', rep[0].network.runs, 0);

done();
