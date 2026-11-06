// ============================================================================
//  THE SITE AGENT (build queue H1, HYBRID_SITES.md).
//
//  On a customer's server or VM at a Hybrid Site:
//    enrol    spend the one-time token from Admin, Sites for this host's own
//             credential, reporting what the host has (cores, memory, GPUs
//             and their encode sessions, free disk). The host then waits for
//             approval in the console.
//    run      every heartbeatSeconds report the same facts; pull config when
//             the cloud says it changed; take a rotated credential when one is
//             handed over and keep using it from then on. Once the host is
//             approved, also watch the site's on-prem watchfolders and upload
//             what they accept (siteWatch.ts, build queue H2), beside the
//             heartbeat rather than inside it, so a long upload never makes
//             the host look stale. And lease the site's Mirror and Archive
//             jobs (siteArchive.ts, build queue H3-2) in a loop of their own.
//
//  OUTBOUND ONLY: the agent calls the cloud over HTTPS and listens on nothing.
//  The credential lives in the state file, readable by its owner only.
// ============================================================================
import { readFile, writeFile, mkdir, statfs, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import * as os from 'node:os';

import { watchPass, emptyMemory, type SiteWatchMemory } from './siteWatch';
import { archivePass } from './siteArchive';

export const AGENT_VERSION = '0.5.0';

export interface SiteState {
  server: string;
  siteId: string;
  siteName?: string;
  hostId: string;
  credential: string;
  configVersion?: number | null;
  config?: any;
  status?: string;
  lastHeartbeatAt?: string;
  /** What the watchfolder passes remember (siteWatch.ts); never the truth, only saved work. */
  watch?: SiteWatchMemory;
}

export interface HostFacts {
  hostname: string; cpuCores: number; memoryBytes: number;
  gpus: { name: string; vendor: string | null; memoryBytes: number | null; encodeSessions: number | null }[];
  diskFreeBytes: number | null; diskTotalBytes: number | null;
  os: string; arch: string; agentVersion: string; encoderVersion: string | null;
}

export const defaultStateFile = () => join(os.homedir(), '.volt-agent', 'site.json');

function run(cmd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/**
 * NVIDIA GPUs through nvidia-smi, when it is there. Encode sessions: a
 * consumer card's driver allows a limited number of concurrent NVENC
 * sessions and data-centre cards are not limited, so the agent reports what
 * the operator configured (VOLT_NVENC_SESSIONS) and otherwise leaves it
 * unknown rather than guessing.
 */
export async function nvidiaGpus(): Promise<HostFacts['gpus']> {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (!out) return [];
  const sessions = Number(process.env.VOLT_NVENC_SESSIONS);
  return out.trim().split('\n').filter(Boolean).map((line) => {
    const [name, mem] = line.split(',').map((s) => s.trim());
    return { name, vendor: 'nvidia', memoryBytes: Number.isFinite(Number(mem)) ? Number(mem) * 1024 * 1024 : null, encodeSessions: Number.isFinite(sessions) && sessions > 0 ? sessions : null };
  });
}

export async function gatherFacts(opts: { dataDir?: string; encoderVersion?: string | null } = {}): Promise<HostFacts> {
  let diskFreeBytes: number | null = null, diskTotalBytes: number | null = null;
  try {
    const s = await statfs(opts.dataDir ?? os.homedir());
    diskFreeBytes = Number(s.bavail) * Number(s.bsize);
    diskTotalBytes = Number(s.blocks) * Number(s.bsize);
  } catch { /* unknown is better than wrong */ }
  return {
    hostname: os.hostname(), cpuCores: os.cpus().length, memoryBytes: os.totalmem(),
    gpus: await nvidiaGpus(), diskFreeBytes, diskTotalBytes,
    os: `${os.type()} ${os.release()}`, arch: os.arch(), agentVersion: AGENT_VERSION,
    encoderVersion: opts.encoderVersion ?? process.env.VOLT_ENCODER_VERSION ?? null,
  };
}

async function call(server: string, path: string, init: { method: string; body?: unknown; credential?: string }) {
  const r = await fetch(server.replace(/\/+$/, '') + path, {
    method: init.method,
    headers: { 'content-type': 'application/json', ...(init.credential ? { authorization: `Bearer ${init.credential}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await r.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) throw Object.assign(new Error(json?.error ?? `HTTP ${r.status}`), { status: r.status, code: json?.code });
  return json;
}

export async function loadSiteState(file: string): Promise<SiteState | null> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}
export async function saveSiteState(file: string, s: SiteState) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

export async function enrol(server: string, token: string, stateFile: string, facts?: HostFacts): Promise<SiteState> {
  const r = await call(server, '/api/site-agent/enrol', { method: 'POST', body: { token, host: facts ?? await gatherFacts() } });
  const s: SiteState = { server, siteId: r.siteId, siteName: r.siteName, hostId: r.hostId, credential: r.credential, status: r.status, configVersion: null };
  await saveSiteState(stateFile, s);
  return s;
}

/** One heartbeat, and a config pull when the cloud says the agent is behind. */
export async function beat(state: SiteState, stateFile: string, facts?: HostFacts) {
  const r = await call(state.server, '/api/site-agent/heartbeat', {
    method: 'POST', credential: state.credential, body: { host: facts ?? await gatherFacts(), configVersion: state.configVersion ?? null },
  });
  state.status = r.status; state.lastHeartbeatAt = new Date().toISOString();
  // Save the rotated credential BEFORE using it: if we died in between, the
  // old one still works until the new one is first used.
  if (r.rotate?.credential) { state.credential = r.rotate.credential; await saveSiteState(stateFile, state); }
  if (r.pullConfig) {
    state.config = await call(state.server, '/api/site-agent/config', { method: 'GET', credential: state.credential });
    state.configVersion = state.config.configVersion;
  }
  await saveSiteState(stateFile, state);
  return r;
}

/** Heartbeat for ever. Network faults are logged and retried; a refusal stops the agent. */
export async function runSite(stateFile: string, log: (s: string) => void = console.log, signal?: AbortSignal, opts: { watchEverySeconds?: number; archiveEverySeconds?: number } = {}) {
  const state = await loadSiteState(stateFile);
  if (!state) throw new Error(`No enrolment in ${stateFile}. Run: volt-agent site enrol <server> <token>`);
  let every = 30;
  // THE WATCH LOOP, one pass at a time, started beside the heartbeat. A pass
  // that is still uploading when the next one is due is simply not doubled.
  state.watch = state.watch ?? emptyMemory();
  let watching = false; let lastWatch = 0;
  const watchEvery = (opts.watchEverySeconds ?? 15) * 1000;
  // A site with only Mirror and Archive has no watchfolders: do not ask.
  const hybrid = () => !Array.isArray(state.config?.addOns) || state.config.addOns.includes('hybrid_sites');
  const watch = async () => {
    if (watching || signal?.aborted || state.status !== 'approved' || !hybrid() || Date.now() - lastWatch < watchEvery) return;
    watching = true; lastWatch = Date.now();
    try {
      await watchPass({ server: state.server, credential: () => state.credential, memory: state.watch!, log });
      await saveSiteState(stateFile, state);
    } catch (e: any) {
      log(`[watch] pass failed, retrying: ${e?.message ?? e}`);
    } finally { watching = false; lastWatch = Date.now(); }
  };
  const watchTimer = setInterval(() => { void watch(); }, Math.min(watchEvery, 5000));
  signal?.addEventListener('abort', () => clearInterval(watchTimer), { once: true });
  // THE ARCHIVE LOOP (H3-2): lease and run the site's copy and check jobs.
  // The cloud hands out only the work the account's add-ons cover, so a
  // site without Mirror and Archive simply gets nothing (204).
  let archiving = false; let lastArchive = 0;
  const archiveEvery = (opts.archiveEverySeconds ?? 15) * 1000;
  const archive = async () => {
    if (archiving || signal?.aborted || state.status !== 'approved' || Date.now() - lastArchive < archiveEvery) return;
    archiving = true; lastArchive = Date.now();
    try {
      await archivePass({ server: state.server, credential: () => state.credential, log });
    } catch (e: any) {
      log(`[archive] pass failed, retrying: ${e?.message ?? e}`);
    } finally { archiving = false; lastArchive = Date.now(); }
  };
  const archiveTimer = setInterval(() => { void archive(); }, Math.min(archiveEvery, 5000));
  signal?.addEventListener('abort', () => clearInterval(archiveTimer), { once: true });
  while (!signal?.aborted) {
    try {
      const r = await beat(state, stateFile);
      every = r.heartbeatSeconds ?? every;
      log(`[site] ${state.siteName ?? state.siteId}: host ${r.status}${r.rotate ? ', credential rotated' : ''}${r.pullConfig ? `, config ${state.configVersion}` : ''}`);
      void watch();
    } catch (e: any) {
      if (e.status === 401 || e.status === 403) { clearInterval(watchTimer); clearInterval(archiveTimer); log(`[site] refused: ${e.message}`); throw e; }
      log(`[site] heartbeat failed, retrying: ${e.message}`);
    }
    await new Promise((res) => { const t = setTimeout(res, every * 1000); signal?.addEventListener('abort', () => { clearTimeout(t); res(null); }, { once: true }); });
  }
  clearInterval(watchTimer);
  clearInterval(archiveTimer);
}
