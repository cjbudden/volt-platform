// ============================================================================
//  MIRROR AND ARCHIVE AT A SITE (build queue H3-2, HYBRID_SITES.md "Add-on:
//  Mirror and Archive to external storage").
//
//  The agent's side of the job lease (H3): lease the site's archive jobs,
//  run them here, report what the target holds.
//
//    archive.copy    download one object through the URL the cloud hands out
//                    for it, write it into the target folder beside its final
//                    name, rename it in, then READ IT BACK from the target and
//                    report that checksum. The cloud matches it against the
//                    original's before the copy counts.
//    archive.verify  read a copy back from the target again: present, its
//                    checksum and size, or gone.
//
//  Safe by construction:
//    - the file lands only inside the target's folder: the name is cleaned
//      with the cloud's own rules (volt-app services/archive/naming.ts,
//      compiled in from the same file) and the final path is checked to be
//      inside the folder before anything is written;
//    - an existing file is never overwritten: a taken name gets -2, -3;
//    - a copy that does not read back as it was downloaded is removed and the
//      attempt reported failed, so a half or damaged file never stays under
//      a name that looks finished;
//    - the target's bandwidth cap is kept, so a copy never competes with live
//      contribution; progress every few seconds keeps the lease.
//
//  OUTBOUND ONLY, like the rest of the agent.
// ============================================================================
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { freeName, safeFileName } from '../../volt-app/src/services/archive/naming';

export const ARCHIVE_JOB_TYPES = ['archive.copy', 'archive.verify'];

export interface ArchiveCtx {
  server: string;
  /** Read on every call: a rotated credential takes effect at once. */
  credential: () => string;
  fetch?: typeof fetch;
  log?: (s: string) => void;
  /** At most this many jobs per pass (the pass runs again soon after). */
  maxJobs?: number;
  /** How often to report progress, which also extends the lease. */
  progressEveryMs?: number;
}

class Refused extends Error { constructor(message: string, public code: string, public permanent = false) { super(message); } }

async function call(ctx: ArchiveCtx, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const f = ctx.fetch ?? fetch;
  const r = await f(ctx.server.replace(/\/+$/, '') + path, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.credential()}` }, body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, body: json };
}

/** sha256 and size of a file as it is on disk now. */
export async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const h = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { h.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
  return { sha256: h.digest('hex'), bytes };
}

/** The target's folder, as this host sees it. It must exist: an unmounted share is a retry, not a new folder. */
async function targetRoot(job: any): Promise<string> {
  const raw = job?.payload?.target?.path;
  if (job?.payload?.target?.kind !== 'path' || typeof raw !== 'string' || !isAbsolute(raw)) throw new Refused('This agent writes only to folder targets with an absolute path', 'target_not_supported', true);
  const root = resolve(raw);
  let s;
  try { s = await stat(root); } catch { throw new Refused(`The target folder ${root} is not there (is the share mounted?)`, 'target_unavailable'); }
  if (!s.isDirectory()) throw new Refused(`The target ${root} is not a folder`, 'target_unavailable', true);
  return root;
}

/** A path inside the target, or a refusal: nothing is ever written or read outside it. */
export function insideTarget(root: string, rel: string): string {
  const p = resolve(root, rel);
  const r = relative(root, p);
  if (!r || r.startsWith('..') || isAbsolute(r) || r.split(sep).includes('..')) throw new Refused('That path is outside the target folder', 'outside_target', true);
  return p;
}

async function runCopy(ctx: ArchiveCtx, job: any): Promise<Record<string, unknown>> {
  const root = await targetRoot(job);
  const transfer = (job.transfers ?? []).find((t: any) => t.name === 'source');
  if (!transfer) throw new Refused('The job lists no source to copy', 'no_source', true);
  const name = freeName(safeFileName(job.payload?.fileName, 'source'), (n) => existsSync(join(root, n)));
  const dest = insideTarget(root, name);

  const u = await call(ctx, `/api/site-agent/jobs/${job.id}/transfer-url`, { leaseId: job.leaseId, name: 'source' });
  if (u.status !== 200 || !u.body?.url) throw new Refused(u.body?.error ?? `transfer URL refused (HTTP ${u.status})`, u.body?.code ?? 'transfer_refused');
  const url = /^https?:\/\//.test(u.body.url) ? u.body.url : ctx.server.replace(/\/+$/, '') + u.body.url;
  const f = ctx.fetch ?? fetch;
  const r = await f(url, { method: 'GET' });
  if (!r.ok || !r.body) throw new Refused(`download failed (HTTP ${r.status})`, 'download_failed');

  const total = Number(transfer.bytes ?? r.headers.get('content-length') ?? NaN);
  const capBps = Number(job.payload?.target?.bandwidthMbps) > 0 ? Number(job.payload.target.bandwidthMbps) * 1e6 / 8 : 0;
  await mkdir(root, { recursive: true });
  const part = `${dest}.part-${randomBytes(6).toString('hex')}`;
  const down = createHash('sha256');
  let bytes = 0; const t0 = Date.now(); let lastProgress = Date.now();
  const out = createWriteStream(part, { flags: 'wx' });
  const write = (chunk: Uint8Array) => new Promise<void>((res, rej) => out.write(chunk, (e) => (e ? rej(e) : res())));
  try {
    const reader = (r.body as any).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      down.update(value); bytes += value.length;
      await write(value);
      // THE BANDWIDTH CAP: never ahead of the target's rate.
      if (capBps) {
        const due = (bytes / capBps) * 1000 - (Date.now() - t0);
        if (due > 5) await new Promise((res) => setTimeout(res, due));
      }
      if (Date.now() - lastProgress >= (ctx.progressEveryMs ?? 10_000)) {
        lastProgress = Date.now();
        const p = await call(ctx, `/api/site-agent/jobs/${job.id}/progress`, {
          leaseId: job.leaseId, pct: Number.isFinite(total) && total > 0 ? Math.min(99, Math.floor((bytes / total) * 100)) : undefined, note: `${bytes} bytes copied`,
        });
        if (p.status === 409) throw new Refused('the lease was lost while copying', 'lease_lost');
      }
    }
    await new Promise<void>((res, rej) => out.end((e?: any) => (e ? rej(e) : res())));
  } catch (e) {
    out.destroy();
    await unlink(part).catch(() => {});
    throw e;
  }
  // Renamed in only when whole. If the name was taken meanwhile, take the next one.
  let final = dest;
  if (existsSync(final)) final = insideTarget(root, freeName(name, (n) => existsSync(join(root, n))));
  await rename(part, final);
  // READ IT BACK from the target: the checksum reported is what the target holds.
  const back = await hashFile(final);
  const downloadSha256 = down.digest('hex');
  if (back.sha256 !== downloadSha256 || back.bytes !== bytes) {
    await unlink(final).catch(() => {});
    throw new Refused('The copy read back from the target does not match what was downloaded', 'checksum_mismatch');
  }
  return { storedPath: relative(root, final).split(sep).join('/'), bytes: back.bytes, sha256: back.sha256, downloadSha256 };
}

async function runVerify(_ctx: ArchiveCtx, job: any): Promise<Record<string, unknown>> {
  const root = await targetRoot(job);
  const p = insideTarget(root, String(job.payload?.storedPath ?? ''));
  try { const s = await stat(p); if (!s.isFile()) return { present: false }; } catch { return { present: false }; }
  const h = await hashFile(p);
  return { present: true, sha256: h.sha256, bytes: h.bytes };
}

/**
 * Lease and run this site's archive jobs until there are none (or maxJobs).
 * Returns how many ran. A 403 (the add-on not held) or 204 ends the pass.
 */
export async function archivePass(ctx: ArchiveCtx): Promise<number> {
  const log = ctx.log ?? (() => {});
  let ran = 0;
  while (ran < (ctx.maxJobs ?? 20)) {
    const l = await call(ctx, '/api/site-agent/jobs/lease', { types: ARCHIVE_JOB_TYPES });
    if (l.status === 204 || l.status === 403) break;
    if (l.status !== 200) throw new Error(l.body?.error ?? `lease refused (HTTP ${l.status})`);
    const job = l.body; ran++;
    try {
      const result = job.type === 'archive.copy' ? await runCopy(ctx, job) : job.type === 'archive.verify' ? await runVerify(ctx, job) : null;
      if (!result) throw new Refused(`this agent does not run ${job.type}`, 'unknown_type', true);
      const c = await call(ctx, `/api/site-agent/jobs/${job.id}/complete`, { leaseId: job.leaseId, result });
      if (c.status === 422 && job.type === 'archive.copy' && typeof result.storedPath === 'string') {
        // The cloud refused the copy (it does not match the original): remove
        // it, so only a verified copy ever stays at the target.
        await unlink(insideTarget(await targetRoot(job), result.storedPath)).catch(() => {});
        log(`[archive] ${job.type} ${job.id}: refused by the cloud (${c.body?.code ?? c.status}), copy removed; it will be retried`);
      } else if (c.status !== 200) {
        log(`[archive] ${job.type} ${job.id}: complete answered ${c.status} ${c.body?.code ?? ''}`);
      } else {
        log(`[archive] ${job.type} ${job.id}: done${result.storedPath ? ` (${result.storedPath})` : ''}`);
      }
    } catch (e: any) {
      const code = e instanceof Refused ? e.code : 'site_error';
      log(`[archive] ${job.type} ${job.id} failed: ${e?.message ?? e}`);
      if (code !== 'lease_lost') {
        await call(ctx, `/api/site-agent/jobs/${job.id}/fail`, { leaseId: job.leaseId, error: String(e?.message ?? e).slice(0, 2000), code, permanent: e instanceof Refused && e.permanent });
      }
    }
  }
  return ran;
}
