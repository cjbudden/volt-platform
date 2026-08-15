// ============================================================================
//  LocalTaskLauncher — runs the REAL encoder.py / thumbnailer.py as local child
//  processes instead of ECS tasks. This is the on-box path that makes the full
//  production-shaped pipeline (ingest → x264 transcode → Shaka CMAF HLS+DASH →
//  DVR window + recording → thumbnailer poster/storyboard/VTT) run and be
//  testable on a developer machine, with NO AWS.
//
//  It implements the same TaskLauncher interface the ECS launcher does, so the
//  orchestrator's recording/finalize/retention logic is reused unchanged. Select
//  it with ORCH_LAUNCHER=local.
//
//  Storage: the encoder writes CMAF straight into ORIGIN_DIR/<streamId> (served
//  by the control plane at /origin/<streamId>), so the origin directory IS the
//  live edge + DVR + recording. The S3 uploader is skipped (encoder local mode).
// ============================================================================
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../../config';
import type { TaskLauncher, LaunchResult } from './launcher';
import { reserveUdpBase, releaseUdpBase } from './encoderPorts';
import { reapStreamEncoder } from './encoderCleanup';

interface Proc {
  taskArn: string;
  child: ChildProcess;
  kind: 'encoder' | 'thumbnailer' | 'captions';
  streamId?: string;
  udpBase?: number;   // reserved bus-port block, released on stop
}

/**
 * Kill a child AND its whole process group (ffmpeg + Shaka packager are its
 * children). The child is spawned detached (its own group leader), so signalling
 * -pid reaps the entire tree and nothing orphans to hold the bus ports. Falls
 * back to a plain child kill if the group signal is unavailable.
 */
function killTree(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid == null) return;
  try { process.kill(-pid, sig); }
  catch { try { child.kill(sig); } catch { /* ignore */ } }
}

export class LocalTaskLauncher implements TaskLauncher {
  private procs = new Map<string, Proc>();
  private n = 0;

  private originFor(streamId: string) {
    return resolve(config.testStream.originDir, streamId);
  }
  private encoderBin() {
    return config.testStream.encoderBin;
  }
  private python() {
    return config.testStream.pythonBin;
  }

  /** True when the real encoder can run here (scripts + ffmpeg + Shaka packager). */
  static available(): boolean {
    return existsSync(join(config.testStream.encoderBin, 'encoder.py'));
  }

  // ---- encoder -------------------------------------------------------------
  async launchEncoder(streamId: string, job: Record<string, any>): Promise<LaunchResult> {
    const out = this.originFor(streamId);
    // ACTIVE CLEANUP first: reap any leftover encoder/ffmpeg/packager for THIS stream
    // from a previous run so we start clean (not merely relocate the port).
    reapStreamEncoder(config.testStream.originDir, streamId);
    // fresh timeline: clear any stale output so the player doesn't replay an old edge
    try { rmSync(out, { recursive: true, force: true }); } catch { /* ignore */ }
    mkdirSync(out, { recursive: true });

    // Inject local-storage mode: write CMAF to the origin dir, skip the S3 uploader.
    const localJob = { ...job, output: { mode: 'local', dir: out } };
    // PROBE for a free UDP bus block (never reuse a busy port -> no EADDRINUSE on
    // restart, even if a previous run's ffmpeg/packager is still dying).
    const udpBase = await reserveUdpBase(8);
    const taskArn = `local:encoder:${streamId}:${++this.n}`;

    const logFd = openSync(join(out, 'encoder.log'), 'a');
    const child = spawn(this.python(), [join(this.encoderBin(), 'encoder.py')], {
      cwd: this.encoderBin(),
      env: {
        ...process.env,
        JOB_CONFIG_JSON: JSON.stringify(localJob),
        WORK_DIR: out,
        UDP_BASE_PORT: String(udpBase),
      },
      stdio: ['ignore', logFd, logFd],
      detached: true,   // own process group so we can reap ffmpeg + packager together
    });
    this.procs.set(taskArn, { taskArn, child, kind: 'encoder', streamId, udpBase });
    child.on('exit', (code) => {
      this.procs.delete(taskArn);
      // sweep any lingering media child, then release the reserved bus block
      reapStreamEncoder(config.testStream.originDir, streamId);
      releaseUdpBase(udpBase);
      console.log(`[local-launcher] encoder ${streamId} exited rc=${code} (udpBase ${udpBase} released, swept)`);
    });
    console.log(`[local-launcher] encoder ${streamId} pid=${child.pid} out=${out} udpBase=${udpBase}`);
    return { taskArn, lifecycle: 'on_demand' };
  }

  // ---- thumbnailer ---------------------------------------------------------
  /**
   * Generate poster + storyboard sheet(s) + thumbs.vtt from the recorded origin.
   * Shaka's live media playlists carry no #EXT-X-ENDLIST, so ffmpeg would hang
   * treating them as live; we synthesize a VOD-terminated playlist over the
   * chosen rendition's on-disk segments and point the thumbnailer at that.
   */
  async launchThumbnailer(job: Record<string, any>): Promise<LaunchResult> {
    const streamId: string | undefined = job.stream_id;
    const taskArn = `local:thumb:${++this.n}`;
    if (!streamId) {
      console.warn('[local-launcher] thumbnailer: job has no stream_id; skipping');
      return { taskArn, lifecycle: 'on_demand' };
    }
    const origin = this.originFor(streamId);
    const rend = this.pickHiResRendition(origin);
    if (!rend) {
      console.warn(`[local-launcher] thumbnailer: no rendition segments under ${origin}; skipping`);
      return { taskArn, lifecycle: 'on_demand' };
    }
    const vodPlaylist = this.writeVodPlaylist(origin, rend, Number(job.segment_seconds) || 4);
    const outDir = join(origin, 'thumbs');
    mkdirSync(outDir, { recursive: true });

    const localJob: Record<string, any> = {
      ...job,
      source: vodPlaylist,
      out_dir: outDir,
    };
    delete localJob.out_s3;

    const logFd = openSync(join(outDir, 'thumbnailer.log'), 'a');
    const child = spawn(this.python(), [join(this.encoderBin(), 'thumbnailer.py')], {
      cwd: this.encoderBin(),
      env: { ...process.env, THUMB_CONFIG_JSON: JSON.stringify(localJob), WORK_DIR: outDir },
      stdio: ['ignore', logFd, logFd],
      detached: false,
    });
    this.procs.set(taskArn, { taskArn, child, kind: 'thumbnailer', streamId });
    child.on('exit', (code) => {
      this.procs.delete(taskArn);
      console.log(`[local-launcher] thumbnailer ${streamId} exited rc=${code}`);
    });
    console.log(`[local-launcher] thumbnailer ${streamId} pid=${child.pid} rendition=${rend} -> ${outDir}`);
    return { taskArn, lifecycle: 'on_demand' };
  }

  /** Pick the highest-resolution rendition dir (has init.mp4 + segments). */
  private pickHiResRendition(origin: string): string | null {
    let entries: string[];
    try { entries = readdirSync(origin, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
    catch { return null; }
    const cand = entries
      .filter((name) => !['audio', 'thumbs', 'subs'].includes(name))
      .filter((name) => existsSync(join(origin, name, 'init.mp4')))
      .map((name) => {
        const m = /^(\d+)\s*p?$/i.exec(name);
        return { name, height: m ? parseInt(m[1], 10) : 0 };
      })
      .sort((a, b) => b.height - a.height);
    return cand[0]?.name ?? null;
  }

  /** Synthesize a VOD (ENDLIST) HLS playlist over a rendition's on-disk segments. */
  private writeVodPlaylist(origin: string, rend: string, seg: number): string {
    const segs = readdirSync(join(origin, rend))
      .filter((f) => /^seg_\d+\.m4s$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)![0], 10);
        const nb = parseInt(b.match(/\d+/)![0], 10);
        return na - nb;
      });
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      `#EXT-X-TARGETDURATION:${Math.ceil(seg)}`,
      '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXT-X-MAP:URI="${rend}/init.mp4"`,
    ];
    for (const s of segs) {
      lines.push(`#EXTINF:${seg.toFixed(3)},`);
      lines.push(`${rend}/${s}`);
    }
    lines.push('#EXT-X-ENDLIST', '');
    // written in the origin ROOT so the `${rend}/seg_N.m4s` paths resolve correctly
    const path = join(origin, '_thumbsrc.m3u8');
    writeFileSync(path, lines.join('\n'));
    return path;
  }

  // ---- captions ------------------------------------------------------------
  async launchCaptions(streamId: string, _job: Record<string, any>): Promise<LaunchResult> {
    // The GPU whisper/NLLB add-on isn't run on-box in local mode (needs model
    // weights + GPU). Captions are best-effort in the orchestrator, so we record
    // intent and let the stream run. The test-caption sidecar covers demo subs.
    const taskArn = `local:captions:${streamId}:${++this.n}`;
    console.log(`[local-launcher] captions requested for ${streamId}; not run locally (no GPU/model)`);
    return { taskArn, lifecycle: 'on_demand' };
  }

  // ---- stop ----------------------------------------------------------------
  async stopTask(taskArn: string, reason: string): Promise<void> {
    const p = this.procs.get(taskArn);
    if (!p) return; // already gone (thumbnailer that finished, or an unknown arn)
    console.log(`[local-launcher] stop ${taskArn} (${reason})`);
    const child = p.child;
    // graceful: SIGTERM the whole group so the encoder runs its own teardown and
    // ffmpeg + packager go down with it (no orphans holding the bus ports).
    killTree(child, 'SIGTERM');
    // hard-kill the group after a grace period if it ignores SIGTERM
    setTimeout(() => { if (child.exitCode === null) killTree(child, 'SIGKILL'); }, 8000).unref?.();
    if (p.udpBase != null) releaseUdpBase(p.udpBase);
    this.procs.delete(taskArn);
  }

  /** Force-kill every tracked process TREE (used on control-plane shutdown). */
  killAll(): void {
    for (const p of this.procs.values()) {
      killTree(p.child, 'SIGKILL');
      if (p.udpBase != null) releaseUdpBase(p.udpBase);
    }
    this.procs.clear();
  }
}

// track instances so process-exit cleanup can reach their children
const localLaunchers = new Set<LocalTaskLauncher>();

export function makeLocalLauncher(): LocalTaskLauncher {
  const l = new LocalTaskLauncher();
  localLaunchers.add(l);
  return l;
}

// best-effort cleanup on process exit — kill any live encoder/thumbnailer children
for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const) {
  process.on(sig, () => {
    for (const inst of localLaunchers) inst.killAll();
  });
}
