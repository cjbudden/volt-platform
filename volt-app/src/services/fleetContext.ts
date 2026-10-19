// ============================================================================
//  WHAT SERVERS ARE AROUND A STREAM, for the words on a stopped Server gate
//  (docs/STATUS_MAP.md): NO SERVER, UNASSIGNED (a shared pool is running but
//  none is this stream's) or NOT CONNECTED (one server runs everything).
//
//  One small COUNT, cached for fifteen seconds per process: the channel page
//  polls every six seconds and the list shows every channel, and the answer
//  does not change that often.
// ============================================================================
import { one } from '../db';
import { config } from '../config';
import type { FleetContext } from './pipelineHealth';

let cache: { at: number; v: FleetContext } | null = null;

export async function fleetContext(): Promise<FleetContext> {
  if (cache && Date.now() - cache.at < 15_000) return cache.v;
  const launcher = config.orchestrator.launcher;
  const single = launcher === 'local' || launcher === 'docker' || launcher === 'mock';
  let serversUp = 0;
  try { serversUp = Number((await one<{ n: number }>(`SELECT count(*)::int AS n FROM compute_hosts WHERE state = 'up'`))?.n ?? 0); }
  catch { serversUp = 0; }
  const v = { serversUp, single };
  cache = { at: Date.now(), v };
  return v;
}
