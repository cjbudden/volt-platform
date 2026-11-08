// ============================================================================
//  ENCODING AT A SITE: THE AGENT'S WORKER (build queue H4-2, HYBRID_SITES.md
//  "The on-prem flow"). The cloud side is volt-app services/sites/siteEncode.ts.
//
//  The source stays on the customer's network; only the packaged output goes
//  to the cloud. The cloud keeps every decision, this worker only runs them:
//
//    site.vod-probe   run vod_encoder.py with probe_only on the file at the
//                     site and hand the probe back. The cloud fits the ladder.
//    site.vod-encode  run vod_encoder.py with EXACTLY the settings the cloud
//                     put in the job (no paths: the input, output and scratch
//                     folders are this host's), then declare the package
//                     (relative paths, sizes, SHA-256, in parts so a long
//                     film's list fits a request), upload every file through
//                     the one URL the cloud hands out for it, and complete.
//                     The cloud verifies the whole package before it counts;
//                     a package it refuses is simply retried.
//
//  HOW THE ENCODER RUNS. With VOLT_ENCODER_IMAGE set (the normal case on a
//  site), vod_encoder.py runs inside the pinned volt-encoder image under
//  Docker: the source folder mounted read only, the scratch folder as /work,
//  no network (the encode needs none), and `--gpus all` only for a job the
//  cloud planned for NVENC. Without it, vod_encoder.py runs from
//  VOLT_ENCODER_BIN with the host's own python3, ffmpeg and packager (the
//  single Mac server and the test suites).
//
//  GPU JOBS ONLY TO GPU HOSTS. The cloud does not hand a job planned for
//  NVENC to a host that reported no NVIDIA GPU (services/sites/siteJobs.ts).
//  A GPU job that reaches this host anyway is handed back, not run on the
//  CPU: the package would not be the encode that was planned.
//
//  THE LEASE. Progress is reported every few seconds while the encoder runs
//  and while files upload, which keeps the lease. If the cloud says the lease
//  is lost (the job went to another host after this one went quiet), the
//  encoder is stopped and nothing more is sent for that job.
//
//  SCRATCH. Each attempt works in a folder of its own under the scratch
//  folder; it is removed once the job is finished either way (the cloud has
//  verified the package, or the attempt failed and the cloud retries it from
//  the start).
// ============================================================================
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import * as os from 'node:os';

export const ENCODE_JOB_TYPES = ['site.vod-probe', 'site.vod-encode'];

/** Files declared per request: a long film's package is declared in parts that each fit a request body. */
export const DECLARE_BATCH = 1000;

export interface EncoderRun { code: number | null; stdout: string; stderr: string }

/** Runs vod_encoder.py with one job file. `job` already carries this host's paths. */
export interface EncoderRunner {
  describe: string;
  run(job: Record<string, any>, opts: { sourceDir: string | null; scratch: string; onLine: (line: string) => void; signal: AbortSignal }): Promise<EncoderRun>;
}

export interface EncodeCtx {
  server: string;
  /** Read on every call: a rotated credential takes effect at once. */
  credential: () => string;
  fetch?: typeof fetch;
  log?: (s: string) => void;
  /** At most this many jobs per pass. */
  maxJobs?: number;
  /** How often to report progress, which also extends the lease. */
  progressEveryMs?: number;
  /** Where attempts work. Default: VOLT_SITE_SCRATCH, else ~/.volt-agent/encode. */
  scratchDir?: string;
  /** How vod_encoder.py is run. Default: encoderRunner() from the environment. */
  runner?: EncoderRunner;
  /** Whether this host has an NVIDIA GPU (what it reports in its heartbeat). */
  hasGpu?: boolean;
  declareBatch?: number;
}

class Refused extends Error { constructor(message: string, public code: string, public permanent = false) { super(message); } }
class LeaseLost extends Error { constructor() { super('the lease was lost'); } }

async function call(ctx: EncodeCtx, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const f = ctx.fetch ?? fetch;
  const r = await f(ctx.server.replace(/\/+$/, '') + path, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.credential()}` }, body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, body: json };
}

/** The last line of output that is a JSON object: vod_encoder.py's answer. */
export function lastJson(s: string): any | null {
  for (const l of s.trim().split('\n').reverse()) {
    const t = l.trim();
    if (!t.startsWith('{')) continue;
    try { return JSON.parse(t); } catch { /* keep looking */ }
  }
  return null;
}

/* ------------------------------------------------------------ the runners */

/**
 * The docker command for one run in the pinned image. Exported so the
 * suites check exactly what a site runs: the source read only, no network,
 * a GPU only when the job was planned for one.
 */
export function dockerArgs(image: string, job: Record<string, any>, sourceDir: string | null, scratch: string): string[] {
  return [
    'run', '--rm', '--network', 'none',
    ...(job.gpu === true ? ['--gpus', 'all'] : []),
    ...(sourceDir ? ['-v', `${sourceDir}:/src:ro`] : []),
    '-v', `${scratch}:/work`,
    '--entrypoint', 'python3',
    image, '/app/bin/vod_encoder.py', '/work/job.json',
  ];
}

function spawnRun(cmd: string, args: string[], env: NodeJS.ProcessEnv, onLine: (l: string) => void, signal: AbortSignal): Promise<EncoderRun> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', buf = '';
    const kill = () => { try { p.kill('SIGKILL'); } catch { /* gone */ } };
    if (signal.aborted) kill(); else signal.addEventListener('abort', kill, { once: true });
    p.stdout.on('data', (d: Buffer) => {
      const s = d.toString(); stdout += s; buf += s;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    // Only the tail is kept: an error message, not a whole ffmpeg log.
    p.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8000); });
    p.on('error', (e) => { signal.removeEventListener('abort', kill); res({ code: null, stdout, stderr: `${stderr}\n${e.message}` }); });
    p.on('close', (code) => { signal.removeEventListener('abort', kill); res({ code, stdout, stderr }); });
  });
}

/** The runner this host is configured for (see the header). */
export function encoderRunner(env: NodeJS.ProcessEnv = process.env): EncoderRunner {
  const image = env.VOLT_ENCODER_IMAGE;
  if (image) {
    const docker = env.VOLT_DOCKER_BIN || 'docker';
    return {
      describe: `the ${image} image`,
      async run(job, { sourceDir, scratch, onLine, signal }) {
        // Paths as the container sees them.
        const inner = { ...job, input: job.input ? `/src/${basename(job.input)}` : job.input, out_dir: '/work/out', work_dir: '/work/tmp' };
        await writeFile(join(scratch, 'job.json'), JSON.stringify(inner));
        return spawnRun(docker, dockerArgs(image, job, sourceDir, scratch), env, onLine, signal);
      },
    };
  }
  const bin = env.VOLT_ENCODER_BIN;
  const python = env.VOLT_PYTHON || 'python3';
  return {
    describe: bin ? `vod_encoder.py in ${bin}` : 'no encoder configured',
    async run(job, { scratch, onLine, signal }) {
      if (!bin) throw new Refused('This host has no encoder: set VOLT_ENCODER_IMAGE (the pinned volt-encoder image) or VOLT_ENCODER_BIN', 'no_encoder');
      const file = join(scratch, 'job.json');
      await writeFile(file, JSON.stringify(job));
      return spawnRun(python, [join(bin, 'vod_encoder.py'), file], env, onLine, signal);
    },
  };
}

/**
 * A probe of one file for its REGISTRATION (Encode at site, build queue
 * H4-3): the same vod_encoder.py probe the probe job gives, so the ingest
 * rules in the cloud see the duration and picture size before the file is
 * registered. Null when this host has no encoder or the probe gives no answer:
 * the file is still registered, on its name and its first bytes.
 */
export function siteProbe(opts: { runner?: EncoderRunner; scratchDir?: string; timeoutMs?: number } = {}) {
  return async (abs: string): Promise<Record<string, unknown> | null> => {
    const runner = opts.runner ?? encoderRunner();
    const scratch = join(opts.scratchDir ?? process.env.VOLT_SITE_SCRATCH ?? join(os.homedir(), '.volt-agent', 'encode'), `probe-${process.pid}-${Date.now().toString(36)}`);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 120_000);
    try {
      await mkdir(scratch, { recursive: true });
      const r = await runner.run({ input: abs, out_dir: join(scratch, 'out'), probe_only: true }, { sourceDir: dirname(abs), scratch, onLine: () => {}, signal: abort.signal });
      const probe = lastJson(r.stdout);
      return probe && typeof probe === 'object' ? probe : null;
    } catch { return null; } finally {
      clearTimeout(timer);
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  };
}

/* ------------------------------------------------------------- the jobs */

/** The source at the site, or why not. A missing share is a retry; a missing file is not. */
async function sourceOf(job: any): Promise<string> {
  const raw = job?.payload?.sitePath;
  if (typeof raw !== 'string' || !raw) throw new Refused('The job names no source file', 'bad_job', true);
  const p = resolve(raw);
  const s = await stat(p).catch(() => null);
  if (s?.isFile()) return p;
  if (s) throw new Refused(`${p} is not a file`, 'source_missing', true);
  if (!existsSync(dirname(p))) throw new Refused(`The folder ${dirname(p)} is not there (is the share mounted?)`, 'source_unavailable');
  throw new Refused(`The source file ${p} is not at the site`, 'source_missing', true);
}

/** Keeps the lease while something long runs: a progress call at most every progressEveryMs. */
function keeper(ctx: EncodeCtx, job: any, abort: AbortController) {
  let last = Date.now(); let pct: number | undefined; let note = 'started'; let lost = false; let sending = false;
  const send = async (force = false) => {
    if (lost || sending || (!force && Date.now() - last < (ctx.progressEveryMs ?? 10_000))) return;
    sending = true; last = Date.now();
    try {
      const r = await call(ctx, `/api/site-agent/jobs/${job.id}/progress`, { leaseId: job.leaseId, pct, note });
      if (r.status === 409 || r.status === 404) { lost = true; abort.abort(); }
    } catch { /* a network fault: the next tick tries again before the lease runs out */ } finally { sending = false; }
  };
  const timer = setInterval(() => { void send(); }, Math.max(250, Math.min(ctx.progressEveryMs ?? 10_000, 5000)));
  return {
    set(p: number | undefined, n: string) { if (p !== undefined) pct = Math.max(0, Math.min(99, Math.floor(p))); note = n; void send(); },
    async flush() { await send(true); },
    get lost() { return lost; },
    stop() { clearInterval(timer); },
  };
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const h = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { h.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
  return { sha256: h.digest('hex'), bytes };
}

async function filesIn(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await filesIn(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

async function runProbe(ctx: EncodeCtx, job: any, scratch: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const src = await sourceOf(job);
  const runner = ctx.runner ?? encoderRunner();
  const r = await runner.run({ input: src, out_dir: join(scratch, 'out'), probe_only: true }, { sourceDir: dirname(src), scratch, onLine: () => {}, signal });
  if (signal.aborted) throw new LeaseLost();
  const probe = lastJson(r.stdout);
  // An answer from the encoder, even "cannot read this file", is the cloud's
  // to judge. No answer at all is a fault here (the encoder did not run).
  if (!probe) throw new Refused(`the encoder gave no probe (exit ${r.code}): ${r.stderr.trim().slice(-400) || 'no output'}`, 'encoder_failed');
  return { probe };
}

async function runEncode(ctx: EncodeCtx, job: any, scratch: string, abort: AbortController, keep: ReturnType<typeof keeper>): Promise<Record<string, unknown>> {
  const settings = job?.payload?.encoder;
  if (!settings || typeof settings !== 'object') throw new Refused('The job carries no encoder settings', 'bad_job', true);
  if (settings.gpu === true && !ctx.hasGpu) throw new Refused('This job was planned for an NVIDIA GPU and this host has none', 'no_gpu');
  const src = await sourceOf(job);
  const runner = ctx.runner ?? encoderRunner();
  const out = join(scratch, 'out');
  // The cloud's settings, only the paths are this host's.
  const run = { ...settings, input: src, out_dir: out, work_dir: join(scratch, 'tmp') };
  keep.set(0, `encoding with ${runner.describe}`);
  const r = await runner.run(run, {
    sourceDir: dirname(src), scratch, signal: abort.signal,
    onLine: (line) => {
      const m = /progress encode ([\d.]+)%/.exec(line);
      // The encode is most of the work; the upload is the last fifth.
      if (m) keep.set(Number(m[1]) * 0.8, `encoding ${Number(m[1]).toFixed(0)}%`);
    },
  });
  if (abort.signal.aborted) throw new LeaseLost();
  const answer = lastJson(r.stdout);
  if (r.code !== 0 || answer?.ok === false) {
    throw new Refused(`the encoder failed (exit ${r.code}): ${String(answer?.error ?? '').slice(0, 300) || r.stderr.trim().slice(-400) || 'no output'}`, 'encoder_failed');
  }
  if (!existsSync(out)) throw new Refused('the encoder wrote no package', 'encoder_failed');

  // DECLARE: every file of the package, relative to its root.
  const files: { path: string; bytes: number; sha256: string; abs: string }[] = [];
  for (const abs of (await filesIn(out)).sort()) {
    const rel = relative(out, abs).split(sep).join('/');
    files.push({ path: rel, ...(await hashFile(abs)), abs });
  }
  if (!files.length) throw new Refused('the encoder wrote no package', 'encoder_failed');
  const batch = Math.max(1, ctx.declareBatch ?? DECLARE_BATCH);
  for (let i = 0; i < files.length; i += batch) {
    const d = await call(ctx, `/api/site-agent/jobs/${job.id}/outputs`, {
      leaseId: job.leaseId, append: i > 0, files: files.slice(i, i + batch).map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    });
    if (d.status === 409 && d.body?.code === 'lease_lost') throw new LeaseLost();
    if (d.status !== 200) throw new Refused(`the cloud refused the package list: ${d.body?.error ?? `HTTP ${d.status}`}`, d.body?.code ?? 'declare_refused');
  }

  // UPLOAD: one URL per file, each held by the cloud to the declared checksum.
  const total = files.reduce((a, f) => a + f.bytes, 0) || 1;
  let sent = 0;
  const f = ctx.fetch ?? fetch;
  for (const file of files) {
    const u = await call(ctx, `/api/site-agent/jobs/${job.id}/transfer-url`, { leaseId: job.leaseId, name: `out/${file.path}` });
    if (u.status === 409 && u.body?.code === 'lease_lost') throw new LeaseLost();
    if (u.status !== 200 || !u.body?.url) throw new Refused(`no upload URL for ${file.path}: ${u.body?.error ?? `HTTP ${u.status}`}`, u.body?.code ?? 'transfer_refused');
    const url = /^https?:\/\//.test(u.body.url) ? u.body.url : ctx.server.replace(/\/+$/, '') + u.body.url;
    // No credential on the request: the URL is the permission (a presigned
    // bucket URL would be refused with one).
    const body = await readFile(file.abs);
    const put = await f(url, { method: 'PUT', body: body as any, headers: { 'content-type': 'application/octet-stream' } });
    const text = await put.text().catch(() => '');
    if (put.status === 409) throw new LeaseLost();
    if (!put.ok) {
      let code = 'upload_failed'; try { code = JSON.parse(text)?.code ?? code; } catch { /* not JSON */ }
      throw new Refused(`uploading ${file.path} failed (HTTP ${put.status})`, code);
    }
    sent += file.bytes;
    keep.set(80 + (sent / total) * 19, `uploaded ${files.indexOf(file) + 1} of ${files.length} files`);
    if (keep.lost) throw new LeaseLost();
  }
  return { encoder: answer ?? {} };
}

/** One pass: lease the site's encode jobs and run them, one at a time. Returns how many ran. */
export async function encodePass(ctx: EncodeCtx): Promise<number> {
  const log = ctx.log ?? (() => {});
  const scratchRoot = ctx.scratchDir ?? process.env.VOLT_SITE_SCRATCH ?? join(os.homedir(), '.volt-agent', 'encode');
  let ran = 0;
  while (ran < (ctx.maxJobs ?? 5)) {
    const l = await call(ctx, '/api/site-agent/jobs/lease', { types: ENCODE_JOB_TYPES });
    if (l.status === 204 || l.status === 403) break;
    if (l.status !== 200) throw new Error(l.body?.error ?? `lease refused (HTTP ${l.status})`);
    const job = l.body; ran++;
    const scratch = join(scratchRoot, `${job.id}-a${job.attempt ?? 1}`);
    const abort = new AbortController();
    const keep = keeper(ctx, job, abort);
    try {
      await rm(scratch, { recursive: true, force: true });
      await mkdir(scratch, { recursive: true });
      const result = job.type === 'site.vod-probe' ? await runProbe(ctx, job, scratch, abort.signal)
        : job.type === 'site.vod-encode' ? await runEncode(ctx, job, scratch, abort, keep) : null;
      if (!result) throw new Refused(`this agent does not run ${job.type}`, 'unknown_type', true);
      keep.stop();
      if (keep.lost) throw new LeaseLost();
      const c = await call(ctx, `/api/site-agent/jobs/${job.id}/complete`, { leaseId: job.leaseId, result });
      if (c.status === 200) log(`[encode] ${job.type} ${job.id}: done`);
      // A package (or probe) the cloud refused: it has already counted the
      // attempt and discarded the upload; the job comes back to be redone.
      else log(`[encode] ${job.type} ${job.id}: refused by the cloud (${c.body?.code ?? c.status}): ${c.body?.error ?? ''}`);
    } catch (e: any) {
      keep.stop();
      if (e instanceof LeaseLost) {
        log(`[encode] ${job.type} ${job.id}: the lease was lost, stopped`);
      } else {
        const refused = e instanceof Refused;
        log(`[encode] ${job.type} ${job.id} failed: ${e?.message ?? e}`);
        await call(ctx, `/api/site-agent/jobs/${job.id}/fail`, {
          leaseId: job.leaseId, error: String(e?.message ?? e).slice(0, 2000), code: refused ? e.code : 'site_error', permanent: refused && e.permanent,
        }).catch(() => {});
      }
    } finally {
      // Nothing of an attempt is kept: verified, it is in the cloud; failed, the retry starts clean.
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
  return ran;
}
