// ============================================================================
//  THE BOX WE ARE ON.
//
//  When ORCH_LAUNCHER is `local` or `docker`, every task runs on the machine
//  running the control plane. That machine is a compute host like any other
//  and belongs in the registry: an operator running the on-prem build asks the
//  same questions an operator on AWS asks, and gets them answered from /proc
//  instead of CloudWatch.
//
//  CPU HERE IS SAMPLED, NOT READ. There is no instantaneous CPU percentage in
//  Linux; /proc/stat holds monotonically increasing jiffy counters, and a
//  percentage only exists between two reads. Anything that reports a single
//  read as a utilisation is reporting the average since boot, which on a
//  long-lived server is a number that barely moves and is therefore useless
//  precisely when the machine is in trouble. The first call after start-up
//  returns null rather than a number, because at that point there genuinely is
//  no interval to divide by.
//
//  The same applies to network: /proc/net/dev is a byte counter, so bits per
//  second is a delta over a measured wall-clock gap or it is nothing.
// ============================================================================
import { hostname, cpus, totalmem, freemem } from 'node:os';
import { readFile } from 'node:fs/promises';
import type { Placement } from './placement';

/** The host row for this machine. Stable across restarts, which is the point. */
export function onboxPlacement(kind: 'local' = 'local'): Placement {
  return {
    hostKind: kind,
    externalId: hostname(),
    instanceType: `${cpus().length}vcpu-onbox`,
    availabilityZone: null,
    region: null,
    lifecycle: 'on_demand',
    vcpus: cpus().length,
    memoryMib: Math.round(totalmem() / (1024 * 1024)),
  };
}

interface CpuSnapshot { total: number; idle: number; at: number; }
interface NetSnapshot { rx: number; tx: number; at: number; }

let lastCpu: CpuSnapshot | null = null;
let lastNet: NetSnapshot | null = null;

async function readCpu(): Promise<CpuSnapshot | null> {
  try {
    const text = await readFile('/proc/stat', 'utf8');
    const line = text.split('\n').find((l) => l.startsWith('cpu '));
    if (!line) return null;
    const f = line.trim().split(/\s+/).slice(1).map(Number);
    if (f.length < 5 || f.some((n) => !Number.isFinite(n))) return null;
    // user nice system idle iowait irq softirq steal …
    const idle = f[3] + (f[4] ?? 0);
    const total = f.reduce((a, b) => a + b, 0);
    return { total, idle, at: Date.now() };
  } catch { return null; }
}

async function readNet(): Promise<NetSnapshot | null> {
  try {
    const text = await readFile('/proc/net/dev', 'utf8');
    let rx = 0, tx = 0;
    for (const line of text.split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!rest) continue;
      const iface = name.trim();
      // The loopback carries the control plane talking to itself, including
      // every status report from a local container. Counting it would make an
      // idle box look busy on the network and would not correspond to
      // anything anybody pays for.
      if (iface === 'lo' || iface.startsWith('veth') || iface.startsWith('docker')) continue;
      const f = rest.trim().split(/\s+/).map(Number);
      if (f.length < 9) continue;
      rx += f[0] || 0;
      tx += f[8] || 0;
    }
    return { rx, tx, at: Date.now() };
  } catch { return null; }
}

export interface OnboxReading {
  cpuPct: number | null;
  memPct: number | null;
  netInBps: number | null;
  netOutBps: number | null;
}

/**
 * Take a reading. Every field is independently nullable, because the ways this
 * can fail are independent: a container with /proc/stat masked still has a
 * readable memory figure, and reporting the whole reading as unavailable
 * because one file was missing would throw away the part that worked.
 */
export async function sampleOnbox(): Promise<OnboxReading> {
  const out: OnboxReading = { cpuPct: null, memPct: null, netInBps: null, netOutBps: null };

  const total = totalmem();
  if (total > 0) out.memPct = Math.round(((total - freemem()) / total) * 10000) / 100;

  const cpu = await readCpu();
  if (cpu) {
    if (lastCpu && cpu.total > lastCpu.total) {
      const dTotal = cpu.total - lastCpu.total;
      const dIdle = cpu.idle - lastCpu.idle;
      const pct = ((dTotal - dIdle) / dTotal) * 100;
      out.cpuPct = Math.min(100, Math.max(0, Math.round(pct * 100) / 100));
    }
    lastCpu = cpu;
  }

  const net = await readNet();
  if (net) {
    const gapMs = lastNet ? net.at - lastNet.at : 0;
    if (lastNet && gapMs > 0) {
      // A counter that went BACKWARDS means the interface was reset or the
      // container was replaced. A negative rate is not a smaller rate, it is
      // a broken measurement, so the sample is dropped rather than clamped.
      const dRx = net.rx - lastNet.rx;
      const dTx = net.tx - lastNet.tx;
      if (dRx >= 0) out.netInBps = Math.round((dRx * 8 * 1000) / gapMs);
      if (dTx >= 0) out.netOutBps = Math.round((dTx * 8 * 1000) / gapMs);
    }
    lastNet = net;
  }
  return out;
}

/** Test seam: forget the previous read so the next sample has no interval. */
export const __testing = {
  reset() { lastCpu = null; lastNet = null; },
  seed(cpu: CpuSnapshot | null, net: NetSnapshot | null) { lastCpu = cpu; lastNet = net; },
};
