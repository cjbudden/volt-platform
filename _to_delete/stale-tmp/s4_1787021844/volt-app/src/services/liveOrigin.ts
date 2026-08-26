// ============================================================================
//  Live origin resolution — per-run output namespace.
//
//  Each encoder run writes into its OWN date-stamped directory:
//      <originDir>/<channelId>/runs/<runId>/   (runId like 20260818T023045Z)
//  and maintains a pointer file <originDir>/<channelId>/current_run.txt naming
//  the run that is live right now.
//
//  Why: segment and manifest names repeat across runs (master.m3u8, seg_N.m4s),
//  so writing runs over the top of each other destroyed the previous recording
//  and let players/caches mix two runs' timelines. With per-run directories
//  nothing is ever overwritten: every run's output is unique and ordered by its
//  runId, old runs survive restarts as recordings, retention rules decide what
//  gets pruned, and clip/VOD tooling can reference a run path that never changes.
//
//  Players use the STABLE url /origin/<id>/live/... which the server rewrites to
//  the current run dir, so share links and player URLs survive restarts. When no
//  pointer exists (test-stub runs, legacy layouts) everything falls back to the
//  channel root, which is where those producers write.
// ============================================================================
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../config';

/** The channel's origin root: <originDir>/<channelId>. */
export function originBaseFor(channelId: string): string {
  return resolve(config.testStream.originDir, channelId);
}

/** The current runId from the pointer file, or null (no run / legacy layout). */
export function currentRunId(channelId: string): string | null {
  try {
    const s = readFileSync(join(originBaseFor(channelId), 'current_run.txt'), 'utf8').trim();
    return /^[A-Za-z0-9._-]+$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** The directory the LIVE output is being written to right now: the current run
 *  dir when a run pointer exists, else the channel root (test stub / legacy). */
export function liveDirFor(channelId: string): string {
  const run = currentRunId(channelId);
  if (run) {
    const d = join(originBaseFor(channelId), 'runs', run);
    if (existsSync(d)) return d;
  }
  return originBaseFor(channelId);
}

/** Stable public URL base for the live output. The /origin router rewrites
 *  /origin/<id>/live/* to the current run dir (or the channel root when no run
 *  pointer exists), so this URL survives channel restarts. */
export function liveUrlBase(channelId: string): string {
  return `/origin/${channelId}/live`;
}
