// ============================================================================
//  Encoder cleanup service.
//
//  Picking a free port lets a restart SUCCEED, but we must never LEAVE a failed
//  encoder (or its ffmpeg/packager) running holding a socket — that is an unstable
//  system. This module actively reaps anything VOLT started, at three moments:
//    - BOOT: a control-plane (re)start reaps every VOLT encoder + child, so a crash
//            or restart never leaves orphans behind.
//    - PRE-LAUNCH (per stream): before (re)starting a channel, reap that channel's
//            leftovers so the restart is clean, not just relocated.
//    - ON EXIT (per stream): sweep any lingering child after the encoder stops.
//
//  Identification is by the paths VOLT uses (unique to us), so we never touch an
//  unrelated ffmpeg on the box:
//    - the encoder script:      <encoderBin>/encoder.py
//    - its media children:      any process whose argv references <originDir>
//    - docker encoders:         containers named volt-enc-*
//
//  Dev/local + docker only. In cloud (ECS) the encoder is a separate task and
//  StopTask owns teardown; pgrep matches nothing there, so this is a safe no-op.
// ============================================================================
import { execFileSync } from 'node:child_process';

function sh(cmd: string, args: string[]): string {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }   // pgrep exits 1 with no match; treat any failure as "nothing"
}

function pgrep(pattern: string): number[] {
  return sh('pgrep', ['-f', pattern])
    .split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 1 && n !== process.pid);
}

/** SIGKILL every pid matching any pattern (minus this process). Returns count. */
function killMatching(patterns: string[], log: (m: string) => void): number {
  const pids = new Set<number>();
  for (const p of patterns) for (const pid of pgrep(p)) pids.add(pid);
  let killed = 0;
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); killed++; } catch { /* already gone */ }
  }
  if (killed) log(`[encoder-cleanup] reaped ${killed} process(es) matching ${patterns.map((p) => `"${p}"`).join(', ')}`);
  return killed;
}

function reapDocker(nameFilter: string, log: (m: string) => void): void {
  const ids = sh('docker', ['ps', '-q', '--filter', `name=${nameFilter}`]).split(/\s+/).filter(Boolean);
  for (const id of ids) { sh('docker', ['rm', '-f', id]); log(`[encoder-cleanup] removed docker container ${id} (${nameFilter})`); }
}

/** BOOT: reap ALL VOLT encoders/children + volt-enc-* containers (nothing valid runs yet). */
export function reapAllEncoders(encoderBin: string, originDir: string, log: (m: string) => void = console.log): void {
  const n = killMatching([`${encoderBin}/encoder.py`, `${encoderBin}/thumbnailer.py`, originDir], log);
  reapDocker('volt-enc-', log);
  if (n === 0) log('[encoder-cleanup] boot: no orphaned encoders to reap');
}

/** PER-STREAM: reap this stream's leftovers (safe — the stream is not validly running). */
export function reapStreamEncoder(originDir: string, streamId: string, log: (m: string) => void = console.log): void {
  // media children reference <originDir>/<streamId> in their argv (segment/-i paths)
  killMatching([`${originDir}/${streamId}`], log);
  reapDocker(`volt-enc-${streamId}`, log);
}
