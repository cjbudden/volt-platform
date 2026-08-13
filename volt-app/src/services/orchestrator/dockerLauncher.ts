// ============================================================================
//  DockerTaskLauncher — runs the REAL encoder inside the Linux encoder image
//  (ffmpeg WITH SRT + drawtext + Shaka), locally, via `docker run`. This gives
//  production-identical encoding on a dev machine and removes the host ffmpeg
//  quirks (no SRT / no drawtext on macOS Homebrew builds).
//
//  It mirrors LocalTaskLauncher: the `docker run` is ATTACHED (not -d) and its
//  stdout/stderr are piped to ORIGIN_DIR/<streamId>/encoder.log, so the control
//  plane's event log still surfaces the real ffmpeg/encoder errors. The encoder
//  writes CMAF straight into the mounted origin dir the control plane serves.
//
//  Select with ORCH_LAUNCHER=docker. Requires Docker running + the image built
//  (run-on-mac builds `volt-encoder:local`). NB: on Mac, Docker still uses the
//  host CPU, so keep dev ladders light.
// ============================================================================
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, openSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../config';
import type { TaskLauncher, LaunchResult } from './launcher';

interface Proc { taskArn: string; child: ChildProcess; name: string; kind: string; streamId?: string; }

export class DockerTaskLauncher implements TaskLauncher {
  private procs = new Map<string, Proc>();
  private n = 0;
  private image() { return config.orchestrator.encoderImage; }
  private originDir() { return resolve(config.testStream.originDir); }
  private originFor(streamId: string) { return resolve(this.originDir(), streamId); }
  private encoderBin() { return resolve(config.testStream.encoderBin); }

  /** True when docker is on PATH and the daemon is reachable. */
  static available(): boolean {
    const r = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 8000 });
    return r.status === 0;
  }

  async launchEncoder(streamId: string, job: Record<string, any>): Promise<LaunchResult> {
    const out = this.originFor(streamId);
    try { rmSync(out, { recursive: true, force: true }); } catch { /* ignore */ }
    mkdirSync(out, { recursive: true });

    const localJob: Record<string, any> = { ...job, output: { mode: 'local', dir: out } };
    // The encoder runs INSIDE the container, so localhost is the container, not
    // the host. Rewrite the status-report callback to host.docker.internal so the
    // encoder can POST live status/events back to the host control plane. (Only
    // this callback is rewritten — the API's public @id URLs stay on localhost.)
    const rep = localJob.status_report;
    if (rep && typeof rep.url === 'string') {
      localJob.status_report = {
        ...rep,
        url: rep.url.replace(/\/\/(localhost|127\.0\.0\.1)(:|\/|$)/, '//host.docker.internal$2'),
      };
    }
    const name = `volt-enc-${streamId}`;
    const taskArn = `docker:encoder:${name}:${++this.n}`;
    // clear any stale container with the same name (idempotent restart)
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });

    const logFd = openSync(`${out}/encoder.log`, 'a');
    const args = [
      'run', '--rm', '--name', name,
      // make host.docker.internal resolvable (Docker Desktop already defines it;
      // this makes it work on plain Linux docker too — harmless on Mac)
      '--add-host', 'host.docker.internal:host-gateway',
      '-v', `${this.originDir()}:${this.originDir()}`,   // out path resolves identically in-container
      '-v', `${this.encoderBin()}:/app/bin:ro`,          // live encoder code, no rebuild for edits
      '-e', `JOB_CONFIG_JSON=${JSON.stringify(localJob)}`,
      '-e', `WORK_DIR=${out}`,
      this.image(),
    ];
    const child = spawn('docker', args, { stdio: ['ignore', logFd, logFd] });
    this.procs.set(taskArn, { taskArn, child, name, kind: 'encoder', streamId });
    child.on('exit', (code) => {
      this.procs.delete(taskArn);
      console.log(`[docker-launcher] encoder ${streamId} (container ${name}) exited rc=${code}`);
    });
    console.log(`[docker-launcher] encoder ${streamId} -> container ${name} (image ${this.image()}) out=${out}`);
    return { taskArn, lifecycle: 'on_demand' };
  }

  // Thumbnails are a post-recording nicety and not needed for live feature tests;
  // run them via the local launcher path in dev, or skip cleanly here.
  async launchThumbnailer(_job: Record<string, any>): Promise<LaunchResult> {
    const taskArn = `docker:thumb:${++this.n}`;
    console.log('[docker-launcher] thumbnailer not run in docker dev mode (skipped)');
    return { taskArn, lifecycle: 'on_demand' };
  }

  async launchCaptions(streamId: string, _job: Record<string, any>): Promise<LaunchResult> {
    const taskArn = `docker:captions:${streamId}:${++this.n}`;
    console.log(`[docker-launcher] captions requested for ${streamId}; not run in docker dev mode`);
    return { taskArn, lifecycle: 'on_demand' };
  }

  async stopTask(taskArn: string, reason: string): Promise<void> {
    const p = this.procs.get(taskArn);
    if (!p) return;
    console.log(`[docker-launcher] stop ${p.name} (${reason})`);
    // graceful: docker stop sends SIGTERM to the encoder (runs its shutdown), 8s grace
    spawnSync('docker', ['stop', '-t', '8', p.name], { stdio: 'ignore', timeout: 15000 });
    try { p.child.kill('SIGTERM'); } catch { /* ignore */ }
    this.procs.delete(taskArn);
  }

  killAll(): void {
    for (const p of this.procs.values()) {
      spawnSync('docker', ['rm', '-f', p.name], { stdio: 'ignore' });
      try { p.child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    this.procs.clear();
  }
}

const dockerLaunchers = new Set<DockerTaskLauncher>();
export function makeDockerLauncher(): DockerTaskLauncher {
  const l = new DockerTaskLauncher();
  dockerLaunchers.add(l);
  return l;
}
for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const) {
  process.on(sig, () => { for (const inst of dockerLaunchers) inst.killAll(); });
}
