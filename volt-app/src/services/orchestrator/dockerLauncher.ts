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
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../config';
import type { TaskLauncher, LaunchResult, Liveness } from './launcher';
import type { Placement } from '../fleet/placement';
import { onboxPlacement } from '../fleet/onbox';
import { connect as netConnect } from 'node:net';
import { makeLocalLauncher, type LocalTaskLauncher } from './localLauncher';

interface Proc { taskArn: string; child: ChildProcess; name: string; kind: string; streamId?: string; }

// ----------------------------------------------------------------------------
//  A CONTAINER THAT DIES SILENTLY MUST STILL REACH THE EVENT LOG.
//
//  The encoder and radio.py report their own faults, but only once they are
//  running. When `docker run` itself fails (image not built, daemon refused,
//  bad mount) nothing inside the container ever executes, so nothing reports:
//  the console sat at "Input: connecting" forever and the event log showed only
//  start.requested. These helpers make the launcher report on the container's
//  behalf, through the same applyReport path the encoder uses, so the log, the
//  health gates and the teardown all see it.
// ----------------------------------------------------------------------------
function imagePresent(image: string): boolean {
  const r = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 8000 });
  return r.status === 0;
}

function buildHint(image: string): string {
  if (/volt-radio/.test(image)) return `docker build -f volt-encoder/Dockerfile.radio -t ${image} volt-encoder`;
  return `docker build -t ${image} volt-encoder`;
}

/** Last meaningful line of a task log, with docker's own boilerplate removed. */
function logTail(file: string): string {
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      .filter((l) => !/^Run 'docker run --help'/.test(l));
    return (lines.slice(-1)[0] ?? '').slice(0, 300);
  } catch { return ''; }
}

async function reportOnBehalf(streamId: string, events: { type: string; detail: Record<string, any> }[]): Promise<void> {
  try {
    // Lazy: modules/status imports the orchestrator, which imports this file.
    const { applyReport } = await import('../../modules/status');
    for (const kind of ['channel', 'event'] as const) {
      try {
        for (const event of events) await applyReport({ kind, id: streamId, event });
        return;
      } catch (e: any) {
        if (e?.status === 404 || e?.statusCode === 404 || /unknown stream/i.test(String(e?.message))) continue;
        console.error(`[docker-launcher] could not report for ${streamId}`, e);
        return;
      }
    }
  } catch (e) {
    console.error(`[docker-launcher] could not report for ${streamId}`, e);
  }
}

/** A container exited without being asked to. Say so, with the reason. */
function reportUnexpectedExit(streamId: string, what: string, image: string, code: number | null, logFile: string): void {
  const tail = logTail(logFile);
  const how = code != null ? `rc=${code}` : 'killed';
  const events: { type: string; detail: Record<string, any> }[] = [];
  // 125/126/127 = docker could not start the container at all, so the task
  // never ran and never reported. Anything else: the task ran and has
  // normally reported its own error already; only the stop is added here.
  if (code === 125 || code === 126 || code === 127 || /Unable to find image|pull access denied/i.test(tail)) {
    const missing = /Unable to find image|pull access denied/i.test(tail);
    events.push({
      type: 'input.error',
      detail: {
        message: missing
          ? `The ${what} container could not start: Docker image ${image} is not built. Build it with: ${buildHint(image)}`
          : `The ${what} container could not start (${how}): ${tail || 'no output'}`,
        rc: code, source: 'docker',
      },
    });
  }
  events.push({ type: 'channel.stop', detail: { reason: `${what} container exited ${how}${tail ? `: ${tail}` : ''}` } });
  void reportOnBehalf(streamId, events);
}

/** Every http(s), SRT or RTMP URL on loopback (not udp: the encoder's internal bus), anywhere in the job, pointed at the Docker host. */
export function toHostDocker<T>(v: T): T {
  const rx = /^((?:https?|srt|rtmp|rtmps):\/\/)(localhost|127\.0\.0\.1)(?=[:/?]|$)/i;
  const walk = (x: any): any => {
    if (typeof x === 'string') return rx.test(x) ? x.replace(rx, '$1host.docker.internal') : x;
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
    return x;
  };
  return walk(v);
}

// ----------------------------------------------------------------------------
//  CAN THE STATION CONTAINER REACH ITS SOURCE? (24 Oct 2026)
//
//  A station pulls its source from the Internet from INSIDE the container. On
//  a Mac that goes through Docker Desktop's own network, which is not the
//  Mac's: a proxy configured in Docker Desktop (Settings > Resources >
//  Proxies) is applied transparently to container traffic on ports 80 and 443,
//  and a VPN or firewall on the Mac can treat Docker's traffic differently.
//  The symptom was a station that played everywhere else and in Docker died
//  with "Connection to tcp://ice5.somafm.com:443 failed: Connection refused",
//  so the console had nothing to play.
//
//  Before a station starts, the launcher dials the source host from this
//  machine and from a throwaway container of the same image. When this machine
//  reaches it and the container cannot, the station runs on this machine
//  instead (the same radio.py, LocalTaskLauncher) and the event log says why.
//  Both failing is a real source fault: it is left to the station to report.
//  RADIO_DOCKER_PREFLIGHT=0 turns the check off.
// ----------------------------------------------------------------------------
function sourceEndpoint(url: unknown): { host: string; port: number } | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : 0;
    if (!port || !/^https?:$/.test(u.protocol)) return null;
    if (/^(localhost|127\.0\.0\.1|host\.docker\.internal)$/i.test(u.hostname)) return null;
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port };
  } catch { return null; }
}

function hostReaches(host: string, port: number, timeoutMs = 5000): Promise<string | null> {
  return new Promise((done) => {
    const sock = netConnect({ host, port });
    const t = setTimeout(() => { sock.destroy(); done('timed out'); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(t); sock.destroy(); done(null); });
    sock.once('error', (e: any) => { clearTimeout(t); done(String(e?.code ?? e?.message ?? e)); });
  });
}

function containerReaches(image: string, host: string, port: number, timeoutMs = 15000): Promise<string | null> {
  const py = 'import socket,sys\ntry:\n socket.create_connection((sys.argv[1],int(sys.argv[2])),6).close()\nexcept Exception as e:\n print(e); sys.exit(3)';
  return new Promise((done) => {
    const c = spawn('docker', ['run', '--rm', '--add-host', 'host.docker.internal:host-gateway', '--entrypoint', 'python3', image, '-c', py, host, String(port)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout?.on('data', (d) => { out += d; });
    c.stderr?.on('data', (d) => { out += d; });
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } done(null); }, timeoutMs);   // undecided: do not fall back
    c.on('exit', (code) => { clearTimeout(t); done(code === 0 ? null : (out.trim().split('\n').pop() || `exit ${code}`).slice(0, 200)); });
    c.on('error', () => { clearTimeout(t); done(null); });
  });
}

export class DockerTaskLauncher implements TaskLauncher {
  private procs = new Map<string, Proc>();
  private n = 0;
  /** Stations that run on this machine because Docker could not reach their source. */
  private native: LocalTaskLauncher | null = null;
  private nativeArns = new Set<string>();
  private image() { return config.orchestrator.encoderImage; }
  private radioImage() { return config.orchestrator.radioImage; }
  private originDir() { return resolve(config.testStream.originDir); }
  private originFor(streamId: string) { return resolve(this.originDir(), streamId); }
  private encoderBin() { return resolve(config.testStream.encoderBin); }
  private rendererJs() { return resolve(config.testStream.encoderBin, '..', 'gfx', 'burn_renderer.js'); }

  /**
   * Refuse to launch from an image that is not there, and say so in the
   * stream's own event log. Without this, `docker run` tried to pull a local
   * tag from Docker Hub, failed, and the start looked accepted.
   */
  private async requireImage(streamId: string, image: string, what: string): Promise<void> {
    if (imagePresent(image)) return;
    const message = `The ${what} cannot start: Docker image ${image} is not built. Build it with: ${buildHint(image)} (or restart with run-on-mac.sh, which builds it).`;
    await reportOnBehalf(streamId, [{ type: 'input.error', detail: { message, source: 'docker' } }]);
    throw new Error(message);
  }

  /** True when docker is on PATH and the daemon is reachable. */
  static available(): boolean {
    const r = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 8000 });
    return r.status === 0;
  }

  async launchEncoder(streamId: string, job: Record<string, any>): Promise<LaunchResult> {
    const out = this.originFor(streamId);
    await this.requireImage(streamId, this.image(), 'encoder');
    // NEVER DELETE THE CHANNEL'S FOLDER HERE. It used to be removed and made
    // again on every start (from before runs/ existed), which (1) threw away
    // the previous runs, which ARE the channel's recordings, (2) deleted the
    // pre-built failover loop the control plane keeps in filler/prebuilt, and
    // (3) on Docker Desktop for Mac left the container a stale view of the
    // deleted folder, so the encoder died a second in with "No such file or
    // directory: .../origin/<id>/runs/<run>". The encoder does the per-run
    // housekeeping itself, by the recording retention (manage_runs).
    mkdirSync(resolve(out, 'runs'), { recursive: true });

    // The encoder runs INSIDE the container, so localhost is the container, not
    // the host. EVERY loopback address in the job is rewritten to
    // host.docker.internal: the status callback, and also the slate the filler
    // fetches, the timed-events (graphics triggers) feed, a source served from
    // the Mac, and anything added later. Only the status callback used to be
    // rewritten, so the encoder log said "filler slate: fetch failed
    // (Connection refused)" and "timed events: control plane not answering"
    // on every Docker start, and the slate was a plain generated one.
    const localJob: Record<string, any> = toHostDocker({ ...job, output: { mode: 'local', dir: out } });
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
      // The graphics renderer runs live from the repo too (its node_modules and
      // Chromium are in the image), so an edit to it needs no image rebuild.
      ...(existsSync(this.rendererJs()) ? ['-v', `${this.rendererJs()}:/app/gfx/burn_renderer.js:ro`] : []),
      // Headless Chromium (burned-in graphics) crashes on Docker's default 64 MB
      // /dev/shm under load; 512 MB is what it needs at 1080p.
      '--shm-size', '512m',
      '-e', `JOB_CONFIG_JSON=${JSON.stringify(localJob)}`,
      '-e', `WORK_DIR=${out}`,
      this.image(),
    ];
    const child = spawn('docker', args, { stdio: ['ignore', logFd, logFd] });
    this.procs.set(taskArn, { taskArn, child, name, kind: 'encoder', streamId });
    child.on('exit', (code) => {
      // Still registered = nobody called stopTask, so this exit is a surprise.
      const unexpected = this.procs.has(taskArn);
      this.procs.delete(taskArn);
      console.log(`[docker-launcher] encoder ${streamId} (container ${name}) exited rc=${code}`);
      if (unexpected && code !== 0) reportUnexpectedExit(streamId, 'encoder', this.image(), code, `${out}/encoder.log`);
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

  /**
   * A station in its own container, from the volt-radio image.
   *
   * Note what is NOT rewritten here that is rewritten for the encoder: the
   * icecast host. The status-report callback points at the host control plane
   * and so needs host.docker.internal, but the relay is a peer container that
   * the station reaches by its compose service name. Rewriting it would send
   * the station's audio to the developer's laptop instead of to Icecast.
   */
  async launchRadio(streamId: string, job: Record<string, any>): Promise<LaunchResult> {
    const out = this.originFor(streamId);
    await this.requireImage(streamId, this.radioImage(), 'station');
    mkdirSync(out, { recursive: true });

    const ep = process.env.RADIO_DOCKER_PREFLIGHT === '0' ? null : sourceEndpoint(job.url);
    if (ep) {
      const [fromHost, fromDocker] = await Promise.all([hostReaches(ep.host, ep.port), containerReaches(this.radioImage(), ep.host, ep.port)]);
      if (!fromHost && fromDocker) {
        const message = `Docker cannot reach ${ep.host}:${ep.port} (${fromDocker}), but this machine can, so the station runs here instead of in its container. `
          + `Usually a proxy in Docker Desktop (Settings > Resources > Proxies), a VPN or a firewall. RADIO_DOCKER_PREFLIGHT=0 turns this check off.`;
        console.warn(`[docker-launcher] radio ${streamId}: ${message}`);
        await reportOnBehalf(streamId, [{ type: 'source.notice', detail: { message, source: 'docker' } }]);
        if (!this.native) this.native = makeLocalLauncher();
        const r = await this.native.launchRadio(streamId, job);
        this.nativeArns.add(r.taskArn);
        return r;
      }
    }

    // EVERY loopback URL in the job points at the Docker host (the status
    // callback, the timed-events feed, a source served from this machine), the
    // same rule as the encoder (toHostDocker). The radio used to rewrite only
    // the status callback, so the log said "timed events: control plane not
    // answering" on every Docker start. The relay is a host, not a URL, and is
    // handled just below.
    const localJob: Record<string, any> = toHostDocker({ ...job, output: { mode: 'local', dir: out } });
    // Icecast on the developer's machine is published on the HOST (run-on-mac
    // maps :8000), and inside the container localhost is the container. Only a
    // loopback host is rewritten: a named relay (a compose service, a real
    // relay host) is reachable as-is and must not be touched.
    const ice = localJob.icecast;
    if (ice && typeof ice.host === 'string' && /^(localhost|127\.0\.0\.1)$/.test(ice.host)) {
      localJob.icecast = { ...ice, host: 'host.docker.internal' };
    }
    const name = `volt-radio-${streamId}`;
    const taskArn = `docker:radio:${name}:${++this.n}`;
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });

    const logFd = openSync(`${out}/radio-task.log`, 'a');
    const args = [
      'run', '--rm', '--name', name,
      '--add-host', 'host.docker.internal:host-gateway',
      '-v', `${this.originDir()}:${this.originDir()}`,
      '-v', `${this.encoderBin()}:/app/bin:ro`,   // live code, no rebuild for edits
      '-e', `JOB_CONFIG_JSON=${JSON.stringify(localJob)}`,
      '-e', `WORK_DIR=${out}`,
      this.radioImage(),
    ];
    const child = spawn('docker', args, { stdio: ['ignore', logFd, logFd] });
    this.procs.set(taskArn, { taskArn, child, name, kind: 'radio', streamId });
    child.on('exit', (code) => {
      const unexpected = this.procs.has(taskArn);
      this.procs.delete(taskArn);
      console.log(`[docker-launcher] radio ${streamId} (container ${name}) exited rc=${code}`);
      if (unexpected && code !== 0) reportUnexpectedExit(streamId, 'station', this.radioImage(), code, `${out}/radio-task.log`);
    });
    console.log(`[docker-launcher] radio ${streamId} -> container ${name} (image ${this.radioImage()}) out=${out}`);
    return { taskArn, lifecycle: 'on_demand' };
  }

  async launchCaptions(streamId: string, _job: Record<string, any>): Promise<LaunchResult> {
    const taskArn = `docker:captions:${streamId}:${++this.n}`;
    console.log(`[docker-launcher] captions requested for ${streamId}; not run in docker dev mode`);
    return { taskArn, lifecycle: 'on_demand' };
  }

  async stopTask(taskArn: string, reason: string): Promise<void> {
    if (this.nativeArns.has(taskArn)) { this.nativeArns.delete(taskArn); return this.native!.stopTask(taskArn, reason); }
    const p = this.procs.get(taskArn);
    if (!p) return;
    console.log(`[docker-launcher] stop ${p.name} (${reason})`);
    // graceful: docker stop sends SIGTERM to the encoder (runs its shutdown), 8s grace
    spawnSync('docker', ['stop', '-t', '8', p.name], { stdio: 'ignore', timeout: 15000 });
    try { p.child.kill('SIGTERM'); } catch { /* ignore */ }
    this.procs.delete(taskArn);
  }

  /**
   * Ask docker, not our own bookkeeping. `docker inspect -f {{.State.Running}}`
   * answers for a container that outlived this process and for one that died
   * without us noticing; a non-zero exit means no such container, which is the
   * same answer as stopped. A docker daemon we cannot reach is `unknown`, so a
   * daemon restart never reads as "every channel crashed".
   */
  async isRunning(taskArn: string): Promise<Liveness> {
    if (this.nativeArns.has(taskArn)) return this.native!.isRunning(taskArn);
    const p = this.procs.get(taskArn);
    if (!p) return 'dead';
    try {
      const r = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', p.name],
        { encoding: 'utf8', timeout: 5000 });
      if (r.error) return 'unknown';
      const out = String(r.stdout ?? '').trim();
      if (r.status !== 0) {
        // "No such object" is a definite dead; anything else is not ours to read.
        return /no such object/i.test(String(r.stderr ?? '')) ? 'dead' : 'unknown';
      }
      return out === 'true' ? 'alive' : 'dead';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Containers here share the docker host, which is this box. Reported as a
   * `local` host rather than a fourth kind: from the fleet view's point of
   * view a docker daemon on the control-plane machine and a bare process on
   * the control-plane machine are the same shared, measurable server, and
   * splitting them would report one physical box as two.
   */
  async describePlacement(taskArn: string): Promise<Placement | null> {
    return this.procs.has(taskArn) || this.nativeArns.has(taskArn) ? onboxPlacement() : null;
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
