// Shared builders for the fleet planner checks (no DB, no network).
import { capacityOf, type StreamLoad } from '../src/services/fleet/capacity';
import { reserve } from '../src/services/fleet/streamLoad';
import type { HostSnapshot, TaskSnapshot } from '../src/services/fleet/fleetModel';

let n = 0;
export const load = (cpuUnits: number, netMbps = 10, o: Partial<StreamLoad> = {}): StreamLoad => ({
  cpuUnits, memoryMib: 700, gpuShare: 0, gpus: 0, netInBps: netMbps * 0.5e6, netOutBps: netMbps * 0.5e6, ...o,
});

export const task = (l: StreamLoad = load(400), o: Partial<TaskSnapshot> = {}): TaskSnapshot => {
  n++;
  return {
    instanceId: `i${n}`, streamId: `ch${n}`, accountId: 'acct', kind: 'package_only',
    reservation: reserve(l), load: l, observedCpuUnitsP95: null, observedNetBpsP95: null,
    ingest: 'pull', healthy: true, onFallback: false, drm: false, dedicated: false,
    endsInMinutes: null, minutesSinceMove: null, pending: false, ...o,
  };
};

/** A c7i.xlarge (4 vCPU, ~7.7 GiB, 1.56 Gbps baseline, 3 task slots), measured. */
export const host = (id: string, tasks: TaskSnapshot[], o: Partial<HostSnapshot> & { cpuPct?: number; netPct?: number } = {}): HostSnapshot => {
  const type = o.instanceType ?? 'c7i.xlarge';
  const cap = capacityOf(type, {})!;
  const sumCpu = tasks.reduce((s, t) => s + t.load.cpuUnits, 0) + 100;
  const sumNet = tasks.reduce((s, t) => s + t.load.netInBps + t.load.netOutBps, 0);
  const { cpuPct, netPct, ...rest } = o;
  return {
    id, externalId: `i-${id}`, pool: 'shared', lifecycle: 'on_demand', capacityProvider: 'volt-ondemand',
    instanceType: type, availabilityZone: 'ap-southeast-2a', gpu: cap.gpus > 0, capacity: cap,
    observed: {
      cpuUnitsP95: cpuPct != null ? cap.cpuUnits * cpuPct / 100 : sumCpu,
      netBpsP95: netPct != null ? cap.netBps * netPct / 100 : sumNet,
      windowMinutes: 60, coverage: 1,
    },
    pinned: false, tasks, ...rest,
  };
};

export function checker() {
  let pass = 0, fail = 0;
  const check = (m: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) === JSON.stringify(want)) { console.log('PASS ' + m); pass++; }
    else { console.log(`FAIL ${m} -- expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`); fail++; }
  };
  const done = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };
  return { check, done };
}
