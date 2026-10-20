// ============================================================================
//  FAST PLAYOUT PROCESSES, LOCAL LAUNCHER.
//
//  A FAST channel has no encoder; it has a playout (volt-encoder/bin/
//  fast_playout.py) that writes its live playlists from packaged VOD. With the
//  local launcher (a laptop, run-on-mac.sh) the control plane runs one per
//  channel with an active lineup, beside itself, and keeps it running:
//    - started when a lineup is activated;
//    - started on the scheduler tick for any active lineup without one
//      (a control-plane restart, a crash);
//    - stopped when the channel has no active lineup any more.
//  Output: ORIGIN_DIR/<channel>/fast/, served at /origin/<channel>/fast/.
//
//  With ECS or docker this is a task per channel (or one task running many
//  channels: a playout is a few kilobytes of text a second), which is the
//  next step (DESIGN_fast_channels.md, section 9). Until then those launchers
//  log that the playout must be run separately, once per channel.
// ============================================================================
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config';
import { query } from '../../db';

const running = new Map<string, ChildProcess>();
let warned = false;

export function playoutDir(channelId: string): string {
  return join(config.testStream.originDir, channelId, 'fast');
}

export function startPlayout(channelId: string): boolean {
  if (config.orchestrator.launcher !== 'local') {
    if (!warned) { console.log('[fast] playout runs as its own process with this launcher: fast_playout.py --channel <id>'); warned = true; }
    return false;
  }
  if (running.has(channelId)) return true;
  const out = playoutDir(channelId);
  mkdirSync(out, { recursive: true });
  const child = spawn(config.testStream.pythonBin, [
    join(config.testStream.encoderBin, 'fast_playout.py'),
    '--channel', channelId,
    '--api', `http://127.0.0.1:${config.port}`,
    '--token', config.ingestToken,
    '--out', out,
    '--clips-dir', config.clips.dir,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (b) => { const s = String(b).trim(); if (s && !/asset .* not readable/.test(s)) console.error(`[fast ${channelId.slice(0, 8)}] ${s.slice(0, 300)}`); });
  child.on('exit', () => running.delete(channelId));
  running.set(channelId, child);
  console.log(`[fast] playout started for ${channelId}`);
  return true;
}

export function stopPlayout(channelId: string): void {
  const c = running.get(channelId);
  if (c) { c.kill('SIGTERM'); running.delete(channelId); console.log(`[fast] playout stopped for ${channelId}`); }
}

/** Scheduler tick: a playout for every channel with an active lineup, none for the rest. */
export async function reconcilePlayouts(): Promise<void> {
  if (config.orchestrator.launcher !== 'local') return;
  const rows = await query<any>(
    `SELECT c.id FROM channels c JOIN fast_lineups l ON l.channel_id = c.id AND l.status = 'active' WHERE c.origin = 'playlist'`);
  const want = new Set(rows.map((r) => String(r.id)));
  for (const id of want) startPlayout(id);
  for (const id of [...running.keys()]) if (!want.has(id)) stopPlayout(id);
}

export function stopAllPlayouts(): void { for (const id of [...running.keys()]) stopPlayout(id); }
