// ============================================================================
//  FAST PLAYOUTS: one per channel with an active lineup, kept running.
//
//  A FAST channel has no encoder; it has a playout (volt-encoder/bin/
//  fast_playout.py) that writes its live playlists from packaged VOD. This
//  supervises them, on the scheduler tick (every 30 s) and at once when a
//  lineup is activated:
//
//    local   a child process of the control plane, writing to ORIGIN_DIR.
//    ecs     an ECS task of the volt-fast image (FAST_TASK_DEF), writing to the
//            origin bucket. Spot-preferring like every other task: a playout
//            that is interrupted is relaunched, and carries on from the state
//            it sent with its last heartbeat (fast_playouts.state), so the
//            channel's media sequence never starts again.
//    other   (mock, docker) nothing is launched; the playout runs on its own.
//
//  Supervision, per channel:
//    - wanted (an active lineup) and nothing running: launch.
//    - ECS says the task is dead: relaunch (restarts counted).
//    - alive but silent for 3 minutes: stop it and relaunch (a hung process).
//    - not wanted any more: stop, mark stopped, the channel ends.
//  The channel row follows: 'live' while the playout's heartbeat is fresh,
//  'ended' when it is stopped. The orchestrator's own reconcile leaves playlist
//  channels alone (they have no instances to check).
// ============================================================================
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config';
import { query, one } from '../../db';
import { fastConfig, channelPrefix } from './media';

const children = new Map<string, ChildProcess>();
/**
 * How FAST playouts run here. ECS on AWS; otherwise a child process on this
 * box. The Docker launcher (run-on-mac.sh with the encoder image) runs
 * TELEVISION encoders in containers, but a FAST playout only copies packaged
 * segments, so it runs on the host like 'local': before this, launcher=docker
 * started no playout at all and every FAST channel sat at "Starting" with
 * nothing to preview. FAST_LAUNCHER overrides (local | ecs | off).
 */
function fastLauncher(): string {
  const v = process.env.FAST_LAUNCHER;
  if (v) return v;
  const l = config.orchestrator.launcher;
  return l === 'docker' ? 'local' : l;
}
let warned = false;
const HUNG_MS = 3 * 60_000;

export function playoutDir(channelId: string): string {
  return join(config.testStream.originDir, channelId, 'fast');
}

/** What the playout is handed (FAST_CONFIG_JSON on ECS, the same keys as its flags). */
export function playoutJob(channelId: string): Record<string, any> {
  const s3 = fastConfig.output === 's3';
  return {
    channel_id: channelId,
    api: config.internalApiBaseUrl,
    token: config.ingestToken,
    dvr_seconds: 120,
    ...(s3
      ? { s3: { bucket: config.aws.s3Bucket, prefix: channelPrefix(channelId) }, url_prefix: fastConfig.cdn ?? '' }
      : { out_dir: playoutDir(channelId), clips_dir: config.clips.dir }),
  };
}

async function record(channelId: string, launcher: string, taskRef: string | null, restart: boolean) {
  await query(
    `INSERT INTO fast_playouts (channel_id, launcher, task_ref, status, started_at, error)
     VALUES ($1, $2, $3, 'starting', now(), NULL)
     ON CONFLICT (channel_id) DO UPDATE SET launcher = $2, task_ref = $3, status = 'starting', started_at = now(), error = NULL,
       restarts = fast_playouts.restarts + CASE WHEN $4 THEN 1 ELSE 0 END, updated_at = now()`,
    [channelId, launcher, taskRef, restart]);
}

async function ecs() {
  const { EcsTaskLauncher } = await import('../orchestrator/launcher');
  return new EcsTaskLauncher();
}

/** Start a channel's playout now. Returns how it is running. */
export async function startPlayout(channelId: string, restart = false): Promise<'running' | 'starting' | 'run separately'> {
  const launcher = fastLauncher();
  if (launcher === 'local') {
    if (children.has(channelId)) return 'running';
    // the same job an ECS task gets (so FAST_OUTPUT=s3 works here too), with
    // the API on this box and the local clips dir for /clips/ media
    const job: Record<string, any> = { ...playoutJob(channelId), api: `http://127.0.0.1:${config.port}`, clips_dir: config.clips.dir };
    if (job.out_dir) mkdirSync(job.out_dir, { recursive: true });
    const child = spawn(config.testStream.pythonBin, [join(config.testStream.encoderBin, 'fast_playout.py')], {
      stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, FAST_CONFIG_JSON: JSON.stringify(job) },
    });
    child.stderr?.on('data', (b) => { const s = String(b).trim(); if (s && !/not readable/.test(s)) console.error(`[fast ${channelId.slice(0, 8)}] ${s.slice(0, 300)}`); });
    child.on('exit', () => children.delete(channelId));
    children.set(channelId, child);
    await record(channelId, 'local', String(child.pid ?? ''), restart).catch(() => null);
    console.log(`[fast] playout started for ${channelId} (local)`);
    return 'running';
  }
  if (launcher === 'ecs') {
    try {
      const r = await (await ecs()).launchFast(channelId, playoutJob(channelId), fastConfig.taskDef);
      await record(channelId, 'ecs', r.taskArn, restart);
      console.log(`[fast] playout task ${r.taskArn} for ${channelId}`);
      return 'starting';
    } catch (e: any) {
      await query(
        `INSERT INTO fast_playouts (channel_id, launcher, status, error) VALUES ($1, 'ecs', 'failed', $2)
         ON CONFLICT (channel_id) DO UPDATE SET status = 'failed', error = $2, updated_at = now()`,
        [channelId, String(e?.message ?? e).slice(0, 500)]).catch(() => null);
      console.error(`[fast] could not launch the playout for ${channelId}`, e);
      throw e;
    }
  }
  if (!warned) { console.log(`[fast] launcher "${launcher}" runs no playouts: run fast_playout.py --channel <id> separately`); warned = true; }
  return 'run separately';
}

export async function stopPlayout(channelId: string, reason = 'lineup deactivated'): Promise<void> {
  const c = children.get(channelId);
  if (c) { c.kill('SIGTERM'); children.delete(channelId); }
  const row = await one<any>(`SELECT * FROM fast_playouts WHERE channel_id = $1`, [channelId]).catch(() => null);
  if (row?.launcher === 'ecs' && row.task_ref && row.status !== 'stopped') {
    await (await ecs()).stopTask(row.task_ref, `volt fast: ${reason}`).catch((e) => console.warn('[fast] stop task failed', e));
  }
  await query(`UPDATE fast_playouts SET status = 'stopped', updated_at = now() WHERE channel_id = $1`, [channelId]).catch(() => null);
  await query(`UPDATE channels SET status = 'ended', updated_at = now() WHERE id = $1 AND origin = 'playlist' AND status = 'live'`, [channelId]).catch(() => null);
  console.log(`[fast] playout stopped for ${channelId} (${reason})`);
}

const lastPrepared = new Map<string, number>();
const PREPARE_EVERY_MS = 5 * 60_000;

/** Scheduler tick: a healthy playout for every channel with an active lineup, none for the rest. */
export async function reconcilePlayouts(): Promise<{ started: number; stopped: number; restarted: number }> {
  const out = { started: 0, stopped: 0, restarted: 0 };
  const launcher = fastLauncher();
  if (launcher !== 'local' && launcher !== 'ecs') return out;
  const want = new Set((await query<any>(
    `SELECT c.id FROM channels c JOIN fast_lineups l ON l.channel_id = c.id AND l.status = 'active' WHERE c.origin = 'playlist'`)).map((r) => String(r.id)));
  const rows = new Map((await query<any>(`SELECT * FROM fast_playouts`)).map((r) => [String(r.channel_id), r]));
  for (const id of want) {
    const r = rows.get(id);
    // BEHIND THE SCENES (ladder.ts): every few minutes, whatever an on-air channel
    // uses that is not packaged to its ladder (a re-encoded title, a series'
    // newest episode, a changed ladder) is queued without anyone pressing Prepare.
    if (Date.now() - (lastPrepared.get(id) ?? 0) > PREPARE_EVERY_MS) {
      lastPrepared.set(id, Date.now());
      void import('./prepare').then((m) => m.prepare(id, { auto: true })).catch((e) => console.error('[fast] prepare failed for', id, e?.message ?? e));
    }
    try {
      if (launcher === 'local') {
        if (!children.has(id)) { await startPlayout(id, !!r); r ? out.restarted++ : out.started++; }
        continue;
      }
      if (!r || r.status === 'stopped' || r.status === 'failed' || !r.task_ref) { await startPlayout(id, !!r); r ? out.restarted++ : out.started++; continue; }
      const alive = await (await ecs()).isRunning(r.task_ref);
      const silent = Date.now() - new Date(r.last_seen_at ?? r.started_at).getTime() > HUNG_MS;
      if (alive === 'dead') {
        console.warn(`[fast] playout task for ${id} is gone; relaunching`);
        await startPlayout(id, true); out.restarted++;
      } else if (alive === 'alive' && silent) {
        console.warn(`[fast] playout for ${id} has been silent for ${Math.round(HUNG_MS / 60000)} min; replacing it`);
        await (await ecs()).stopTask(r.task_ref, 'volt fast: no heartbeat').catch(() => null);
        await startPlayout(id, true); out.restarted++;
      }
    } catch (e) { console.error('[fast] reconcile failed for', id, e); }
  }
  for (const [id, r] of rows) {
    if (!want.has(id) && r.status !== 'stopped') { await stopPlayout(id, 'no active lineup'); out.stopped++; }
  }
  for (const id of [...children.keys()]) if (!want.has(id)) { await stopPlayout(id, 'no active lineup'); out.stopped++; }
  return out;
}

/**
 * The playout's heartbeat (every 5 s): its state, what it last published, and
 * any media it could not read. Marks the channel live.
 */
export async function heartbeat(channelId: string, b: { state?: unknown; lastPdt?: string | null; mediaSequence?: number; unreadable?: string[]; stopping?: boolean }) {
  await query(
    `INSERT INTO fast_playouts (channel_id, launcher, status, last_seen_at, last_pdt, media_sequence, state, unreadable)
     VALUES ($1, $2, $3, now(), $4, $5, $6::jsonb, $7::jsonb)
     ON CONFLICT (channel_id) DO UPDATE SET status = $3, last_seen_at = now(), last_pdt = $4, media_sequence = $5,
       state = COALESCE($6::jsonb, fast_playouts.state), unreadable = $7::jsonb, updated_at = now()`,
    [channelId, fastLauncher(), b.stopping ? 'stopped' : 'running', b.lastPdt ?? null, b.mediaSequence ?? null,
     b.state ? JSON.stringify(b.state) : null, JSON.stringify(b.unreadable ?? [])]);
  if (!b.stopping) {
    await query(`UPDATE channels SET status = 'live', updated_at = now() WHERE id = $1 AND origin = 'playlist' AND status <> 'live'`, [channelId]);
  }
}

export async function savedState(channelId: string): Promise<unknown | null> {
  const r = await one<any>(`SELECT state FROM fast_playouts WHERE channel_id = $1`, [channelId]);
  return r?.state ?? null;
}

/** Is the channel's playout alive (heartbeat within FAST_STALE_SEC)? Cached 2 s per channel. */
const freshCache = new Map<string, { at: number; v: boolean }>();
export async function playoutFresh(channelId: string): Promise<boolean> {
  const hit = freshCache.get(channelId);
  if (hit && Date.now() - hit.at < 2000) return hit.v;
  const r = await one<any>(
    `SELECT (last_seen_at > now() - make_interval(secs => $2)) AS fresh FROM fast_playouts WHERE channel_id = $1 AND status = 'running'`,
    [channelId, fastConfig.staleSec]).catch(() => null);
  const v = !!r?.fresh;
  freshCache.set(channelId, { at: Date.now(), v });
  return v;
}

export function stopAllPlayouts(): void { for (const [id, c] of children) { c.kill('SIGTERM'); children.delete(id); } }
