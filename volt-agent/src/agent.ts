// ============================================================================
//  THE AGENT LOOP — watch folders, decide the route, move the file.
//
//  For every new, quiet file under a watched folder:
//    1. If it sits in a cloud drive sync root, ask Volt to locate it in the
//       linked account and fetch it cloud to cloud. A cloud-only placeholder
//       is never read from disk: that would make the sync client download it
//       first and send it twice over this connection.
//    2. Otherwise upload it with tus, resumable, with the relative path and
//       the provenance in the metadata so the ingest rules see the same facts
//       a folder pick in the panel would give them.
//  State (what was handled, by path + size + mtime) lives in a JSON file so a
//  restart does not re-upload.
// ============================================================================
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { homedir } from 'node:os';
import { syncRootFor, isCloudOnly, type Provider } from './syncRoots';
import { tusUploadFile } from './tus';

export interface AgentConfig {
  server: string;                 // https://volt.example.com
  token: string;                  // account secret key (sk_...) or a console JWT
  folders: { path: string; source?: string; schemaId?: string | null; preferCloud?: boolean; extra?: { path: string; provider: Provider }[] }[];
  quietMs?: number;               // default 10 s
  intervalMs?: number;            // default 30 s
  stateFile?: string;
  chunkBytes?: number;
}

interface StateEntry { size: number; mtimeMs: number; route: 'cloud' | 'tus' | 'skipped'; at: string; url?: string | null }
type State = Record<string, StateEntry>;

const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini|~\$.*|\..*\.swp|.*\.(part|crdownload|tmp|download))$/i;

export async function walk(root: string, max = 5000): Promise<string[]> {
  const out: string[] = [];
  const rec = async (d: string) => {
    let ents; try { ents = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= max) return;
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!/^(_review|\.)/.test(e.name)) await rec(p); }
      else if (e.isFile() && !JUNK.test(e.name)) out.push(p);
    }
  };
  await rec(root);
  return out;
}

export interface Deps {
  fetch?: typeof fetch;
  home?: string; platform?: NodeJS.Platform;
  now?: () => number;
  log?: (s: string) => void;
}

/** One pass over every folder. Returns what it did, for tests and for the log. */
export async function pass(cfg: AgentConfig, state: State, deps: Deps = {}): Promise<{ handled: { path: string; route: string; note?: string }[] }> {
  const f = deps.fetch ?? fetch; const home = deps.home ?? homedir(); const platform = deps.platform ?? process.platform; const now = deps.now ?? Date.now;
  const log = deps.log ?? ((s) => console.log(s));
  const quiet = cfg.quietMs ?? 10_000;
  const H = { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' };
  const handled: { path: string; route: string; note?: string }[] = [];
  for (const folder of cfg.folders) {
    for (const p of await walk(folder.path)) {
      const st = await stat(p).catch(() => null); if (!st) continue;
      const key = p; const prev = state[key];
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
      if (now() - st.mtimeMs < quiet) continue;
      const rel = relative(folder.path, p).replace(/\\/g, '/');
      const sync = syncRootFor(p, home, platform, folder.extra);
      const cloudOnly = isCloudOnly(st as any);
      const source = folder.source ?? 'agent';
      try {
        if (sync && (folder.preferCloud !== false)) {
          // Ask Volt whether the linked account has it; if so, fetch cloud to cloud.
          const loc = await f(`${cfg.server}/api/ingest/locate`, { method: 'POST', headers: H, body: JSON.stringify({ files: [{ name: p.split(/[\\/]/).pop(), bytes: st.size, relativePath: sync.relativePath }] }) });
          const hit = loc.ok ? ((await loc.json()) as any[])[0]?.hit : null;
          if (hit) {
            const r = await f(`${cfg.server}/api/ingest/remote`, { method: 'POST', headers: H, body: JSON.stringify({ ref: hit.ref, name: p.split(/[\\/]/).pop(), bytes: st.size, relativePath: rel, schemaId: folder.schemaId ?? null, providerAccountId: hit.providerAccountId }) });
            if (r.ok) { state[key] = { size: st.size, mtimeMs: st.mtimeMs, route: 'cloud', at: new Date().toISOString() }; handled.push({ path: p, route: 'cloud', note: `${sync.provider} via ${hit.label}` }); log(`cloud  ${rel}  (${sync.provider}, never left the cloud)`); continue; }
          }
          if (cloudOnly) { handled.push({ path: p, route: 'skipped', note: 'cloud-only placeholder and the account is not linked; link it in Volt or make the file available offline' }); log(`skip   ${rel}  (cloud-only ${sync.provider} file; link the account in Volt)`); state[key] = { size: st.size, mtimeMs: st.mtimeMs, route: 'skipped', at: new Date().toISOString() }; continue; }
        }
        const md: Record<string, string> = { relativePath: rel, source, ...(folder.schemaId ? { schemaId: folder.schemaId } : {}), ...(sync ? { provider: sync.provider, providerPath: sync.relativePath } : {}) };
        const { url } = await tusUploadFile(p, { endpoint: `${cfg.server}/api/tus`, token: cfg.token, metadata: md, chunkBytes: cfg.chunkBytes, resumeUrl: prev?.url ?? null, fetch: f, onProgress: (s, t) => { if (s === t) log(`tus    ${rel}  done`); } });
        state[key] = { size: st.size, mtimeMs: st.mtimeMs, route: 'tus', at: new Date().toISOString(), url };
        handled.push({ path: p, route: 'tus' });
      } catch (e: any) {
        log(`error  ${rel}  ${e?.message ?? e}`);
        handled.push({ path: p, route: 'error', note: String(e?.message ?? e) });
      }
    }
  }
  return { handled };
}

export async function loadState(file: string): Promise<State> { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; } }
export async function saveState(file: string, s: State): Promise<void> { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(s, null, 2)); }

export async function run(cfg: AgentConfig, deps: Deps = {}): Promise<never> {
  const file = cfg.stateFile ?? join(homedir(), '.volt-agent', 'state.json');
  const state = await loadState(file);
  for (;;) {
    const r = await pass(cfg, state, deps);
    if (r.handled.length) await saveState(file, state);
    await new Promise((res) => setTimeout(res, cfg.intervalMs ?? 30_000));
  }
}
