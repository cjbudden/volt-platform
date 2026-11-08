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
//    archive.copy-folder, archive.verify-folder (H3-11)
//                    the same for a FOLDER of many files (an asset's HLS and
//                    DASH package): every file fetched through its own URL
//                    into a folder beside its final name, the folder renamed
//                    in, every file read back; reported as two checksums over
//                    the whole set (volt-app services/archive/packageManifest.ts,
//                    compiled in from the same file).
//
//  Two kinds of target: a FOLDER on the site's server or a mounted NAS share
//  (`path`, H3-2), and an on-prem S3-COMPATIBLE STORE such as MinIO (`s3`,
//  H3-4), written through its S3 API with keys that never leave this host
//  (s3Target.ts). Both get the same promises below.
//
//  Safe by construction:
//    - the file lands only inside the target's folder: the name is cleaned
//      with the cloud's own rules (volt-app services/archive/naming.ts,
//      compiled in from the same file) and the final path is checked to be
//      inside the folder before anything is written;
//    - an existing file is never overwritten: a taken name gets -2, -3 (in a
//      store, also `If-None-Match: *` on the write, so a name taken between
//      the look and the write answers 412 instead of being replaced);
//    - a copy that does not read back as it was downloaded is removed and the
//      attempt reported failed, so a half or damaged file never stays under
//      a name that looks finished;
//    - the target's bandwidth cap is kept, so a copy never competes with live
//      contribution; progress every few seconds keeps the lease.
//
//  OUTBOUND ONLY, like the rest of the agent.
// ============================================================================
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { freeName, nameValue, safeFileName } from '../../volt-app/src/services/archive/naming';
import { cleanPackagePath, packageLayout, packageManifest, type PackageFile } from '../../volt-app/src/services/archive/packageManifest';
import * as S3 from './s3Target';

export const ARCHIVE_JOB_TYPES = ['archive.copy', 'archive.verify', 'archive.copy-folder', 'archive.verify-folder'];

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
  /**
   * The owner-only file with the keys of S3-compatible targets (s3Target.ts),
   * read on every job. Default: VOLT_ARCHIVE_KEYS, else none (environment
   * variables only); `site run` passes archive-keys.json beside its state.
   */
  keysFile?: string;
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
  if (job?.payload?.target?.kind !== 'path' || typeof raw !== 'string' || !isAbsolute(raw)) throw new Refused('A folder target needs an absolute path', 'target_not_supported', true);
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

/** A store target's client, with this host's keys for it. */
function storeFor(ctx: ArchiveCtx, job: any): S3.S3Client {
  const t = job?.payload?.target;
  const keys = S3.keysFor(t?.s3?.credentialRef, ctx.keysFile ?? process.env.VOLT_ARCHIVE_KEYS);
  return S3.clientFor(t?.s3, keys, ctx.fetch ?? fetch);
}

/**
 * Stream the job's source from the cloud through `sink`, keeping the target's
 * bandwidth cap and reporting progress (which keeps the lease). Returns what
 * was downloaded: its size and checksum.
 */
interface Progress { last: number; done: number; total: number }

async function pump(ctx: ArchiveCtx, job: any, sink: (chunk: Uint8Array) => Promise<void>, name = 'source', shared?: Progress): Promise<{ bytes: number; sha256: string; total: number }> {
  const transfer = (job.transfers ?? []).find((t: any) => t.name === name);
  if (!transfer) throw new Refused(`The job lists no transfer ${name} to copy`, 'no_source', true);
  const u = await call(ctx, `/api/site-agent/jobs/${job.id}/transfer-url`, { leaseId: job.leaseId, name });
  if (u.status !== 200 || !u.body?.url) throw new Refused(u.body?.error ?? `transfer URL refused (HTTP ${u.status})`, u.body?.code ?? 'transfer_refused');
  const url = /^https?:\/\//.test(u.body.url) ? u.body.url : ctx.server.replace(/\/+$/, '') + u.body.url;
  const f = ctx.fetch ?? fetch;
  const r = await f(url, { method: 'GET' });
  if (!r.ok || !r.body) throw new Refused(`download failed (HTTP ${r.status})`, 'download_failed');

  const total = Number(transfer.bytes ?? r.headers.get('content-length') ?? NaN);
  const capBps = Number(job.payload?.target?.bandwidthMbps) > 0 ? Number(job.payload.target.bandwidthMbps) * 1e6 / 8 : 0;
  const down = createHash('sha256');
  // A folder copy shares one progress across its files, so the lease is
  // kept while many small files go by (each alone too quick to report).
  const prog: Progress = shared ?? { last: Date.now(), done: 0, total };
  let bytes = 0; const t0 = Date.now();
  const reader = (r.body as any).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    down.update(value); bytes += value.length;
    await sink(value);
    // THE BANDWIDTH CAP: never ahead of the target's rate.
    if (capBps) {
      const due = (bytes / capBps) * 1000 - (Date.now() - t0);
      if (due > 5) await new Promise((res) => setTimeout(res, due));
    }
    prog.done += value.length;
    if (Date.now() - prog.last >= (ctx.progressEveryMs ?? 10_000)) await report(ctx, job, prog);
  }
  if (shared && Date.now() - prog.last >= (ctx.progressEveryMs ?? 10_000)) await report(ctx, job, prog);
  return { bytes, sha256: down.digest('hex'), total };
}

async function report(ctx: ArchiveCtx, job: any, prog: Progress) {
  prog.last = Date.now();
  const p = await call(ctx, `/api/site-agent/jobs/${job.id}/progress`, {
    leaseId: job.leaseId, pct: Number.isFinite(prog.total) && prog.total > 0 ? Math.min(99, Math.floor((prog.done / prog.total) * 100)) : undefined, note: `${prog.done} bytes copied`,
  });
  if (p.status === 409) throw new Refused('the lease was lost while copying', 'lease_lost');
}

async function runCopy(ctx: ArchiveCtx, job: any): Promise<Record<string, unknown>> {
  if (job?.payload?.target?.kind === 's3') return runCopyToStore(ctx, job);
  const root = await targetRoot(job);
  const name = freeName(safeFileName(job.payload?.fileName, 'source'), (n) => existsSync(join(root, n)));
  const dest = insideTarget(root, name);

  await mkdir(root, { recursive: true });
  const part = `${dest}.part-${randomBytes(6).toString('hex')}`;
  const out = createWriteStream(part, { flags: 'wx' });
  const write = (chunk: Uint8Array) => new Promise<void>((res, rej) => out.write(chunk, (e) => (e ? rej(e) : res())));
  let got: { bytes: number; sha256: string };
  try {
    got = await pump(ctx, job, write);
    await new Promise<void>((res, rej) => out.end((e?: any) => (e ? rej(e) : res())));
  } catch (e) {
    out.destroy();
    await unlink(part).catch(() => {});
    throw e;
  }
  const { bytes, sha256: downloadSha256 } = got;
  // Renamed in only when whole. If the name was taken meanwhile, take the next one.
  let final = dest;
  if (existsSync(final)) final = insideTarget(root, freeName(name, (n) => existsSync(join(root, n))));
  await rename(part, final);
  // READ IT BACK from the target: the checksum reported is what the target holds.
  const back = await hashFile(final);
  if (back.sha256 !== downloadSha256 || back.bytes !== bytes) {
    await unlink(final).catch(() => {});
    throw new Refused('The copy read back from the target does not match what was downloaded', 'checksum_mismatch');
  }
  return { storedPath: relative(root, final).split(sep).join('/'), bytes: back.bytes, sha256: back.sha256, downloadSha256 };
}

/**
 * A copy into an S3-compatible store (H3-4). Small files go up in one PUT;
 * larger ones as a multipart upload, part by part as they download, so the
 * host never holds more than one part. Every write says `If-None-Match: *`:
 * nothing already in the store is ever replaced. Then the object is READ
 * BACK from the store and that checksum is what the cloud judges.
 */
async function runCopyToStore(ctx: ArchiveCtx, job: any): Promise<Record<string, unknown>> {
  const c = storeFor(ctx, job);
  const wanted = safeFileName(job.payload?.fileName, 'source');
  const stem = wanted.lastIndexOf('.') > 0 ? wanted.slice(0, wanted.lastIndexOf('.')) : wanted;
  const pick = async () => { const taken = await S3.namesLike(c, stem); return freeName(wanted, (n) => taken.has(n)); };
  let name = await pick();
  const transfer = (job.transfers ?? []).find((t: any) => t.name === 'source');
  const partSize = S3.partSizeFor(Number(transfer?.bytes));

  let buf: Buffer[] = []; let held = 0;
  let uploadId: string | null = null; const etags: string[] = [];
  const flushPart = async () => {
    if (!uploadId) uploadId = await S3.startMultipart(c, S3.objectKey(c, name));
    etags.push(await S3.uploadPart(c, S3.objectKey(c, name), uploadId, etags.length + 1, Buffer.concat(buf, held)));
    buf = []; held = 0;
  };
  let got: { bytes: number; sha256: string };
  try {
    got = await pump(ctx, job, async (chunk) => {
      buf.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)); held += chunk.byteLength;
      if (held >= partSize) await flushPart();
    });
    if (!uploadId) {
      // Small enough for one write. A name taken between the look and the
      // write (412) takes the next free one, once.
      const body = Buffer.concat(buf, held);
      if (!(await S3.putNew(c, S3.objectKey(c, name), body))) {
        name = await pick();
        if (!(await S3.putNew(c, S3.objectKey(c, name), body))) throw new Refused('Another copy took this name at the same moment; it will be retried', 'name_taken');
      }
    } else {
      if (held) await flushPart();
      if (!(await S3.completeMultipart(c, S3.objectKey(c, name), uploadId, etags))) {
        await S3.abortMultipart(c, S3.objectKey(c, name), uploadId);
        throw new Refused('Another copy took this name while uploading; it will be retried under a free name', 'name_taken');
      }
      uploadId = null;
    }
  } catch (e) {
    if (uploadId) await S3.abortMultipart(c, S3.objectKey(c, name), uploadId);
    throw e;
  }
  const { bytes, sha256: downloadSha256 } = got;
  const back = await S3.readBack(c, S3.objectKey(c, name));
  if (!back || back.sha256 !== downloadSha256 || back.bytes !== bytes) {
    if (back) await S3.removeOwn(c, S3.objectKey(c, name));
    throw new Refused('The copy read back from the store does not match what was downloaded', 'checksum_mismatch');
  }
  return { storedPath: name, bytes: back.bytes, sha256: back.sha256, downloadSha256 };
}

/** The object key a reported path stands for in a store, checked like a folder path. */
function storeKey(c: S3.S3Client, rel: unknown): string {
  const r = String(rel ?? '');
  if (!r || r.startsWith('/') || r.split('/').some((x) => !x || x === '.' || x === '..')) throw new Refused('That path is outside the target folder', 'outside_target', true);
  return S3.objectKey(c, r);
}

async function runVerify(ctx: ArchiveCtx, job: any): Promise<Record<string, unknown>> {
  if (job?.payload?.target?.kind === 's3') {
    const c = storeFor(ctx, job);
    const back = await S3.readBack(c, storeKey(c, job.payload?.storedPath));
    return back ? { present: true, sha256: back.sha256, bytes: back.bytes } : { present: false };
  }
  const root = await targetRoot(job);
  const p = insideTarget(root, String(job.payload?.storedPath ?? ''));
  try { const s = await stat(p); if (!s.isFile()) return { present: false }; } catch { return { present: false }; }
  const h = await hashFile(p);
  return { present: true, sha256: h.sha256, bytes: h.bytes };
}

// ---- folders: an asset's HLS/DASH package (H3-11) ---------------------------------

/** The files a folder job lists, each with a path that stays inside the folder. */
function folderFiles(job: any): { path: string; transfer: string; bytes: number }[] {
  const raw = Array.isArray(job?.payload?.files) ? job.payload.files : null;
  if (!raw || !raw.length) throw new Refused('The job lists no files to copy', 'no_source', true);
  return raw.map((f: any) => {
    const path = cleanPackagePath(f?.path);
    if (!path) throw new Refused('A file of this folder has a path outside it', 'outside_target', true);
    return { path, transfer: String(f?.transfer ?? ''), bytes: Number(f?.bytes) };
  });
}

/** Read every listed file of a folder back: its checksum, or counted missing. */
async function readFolder(dir: string, files: { path: string }[]): Promise<{ list: PackageFile[]; missing: number; bytes: number }> {
  const list: PackageFile[] = []; let missing = 0; let bytes = 0;
  for (const f of files) {
    const p = insideTarget(dir, f.path);
    let isFile = false;
    try { isFile = (await stat(p)).isFile(); } catch { isFile = false; }
    if (!isFile) { missing++; continue; }
    const h = await hashFile(p);
    list.push({ path: f.path, bytes: h.bytes, sha256: h.sha256 });
    bytes += h.bytes;
  }
  return { list, missing, bytes };
}

/**
 * Copy a folder of files (a package) into a folder target. Written into
 * `<name>.part-<random>` and renamed in only when every file is there, so a
 * half package never stays under a name that looks finished; then every
 * file is READ BACK from its final place.
 */
async function runCopyFolder(ctx: ArchiveCtx, job: any): Promise<Record<string, unknown>> {
  if (job?.payload?.target?.kind !== 'path') throw new Refused('Packages are copied to folder targets only', 'package_needs_folder_target', true);
  const root = await targetRoot(job);
  const files = folderFiles(job);
  const name = freeName(nameValue(job.payload?.folder) || 'package', (n) => existsSync(join(root, n)));
  const dest = insideTarget(root, name);
  const part = insideTarget(root, `${name}.part-${randomBytes(6).toString('hex')}`);
  await mkdir(part, { recursive: true });
  const down: PackageFile[] = [];
  const prog: Progress = { last: Date.now(), done: 0, total: files.reduce((s, f) => s + (Number.isFinite(f.bytes) ? f.bytes : 0), 0) };
  try {
    for (const f of files) {
      const p = insideTarget(part, f.path);
      await mkdir(dirname(p), { recursive: true });
      const out = createWriteStream(p, { flags: 'wx' });
      const write = (chunk: Uint8Array) => new Promise<void>((res, rej) => out.write(chunk, (e) => (e ? rej(e) : res())));
      try {
        const got = await pump(ctx, job, write, f.transfer, prog);
        await new Promise<void>((res, rej) => out.end((e?: any) => (e ? rej(e) : res())));
        down.push({ path: f.path, bytes: got.bytes, sha256: got.sha256 });
      } catch (e) { out.destroy(); throw e; }
    }
  } catch (e) {
    await rm(part, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  let final = dest;
  if (existsSync(final)) final = insideTarget(root, freeName(name, (n) => existsSync(join(root, n))));
  await rename(part, final);
  // READ IT BACK from the target: what is reported is what the folder holds.
  const back = await readFolder(final, files);
  const downloadSha256 = packageManifest(down);
  const sha256 = packageManifest(back.list);
  if (back.missing || sha256 !== downloadSha256) {
    await rm(final, { recursive: true, force: true }).catch(() => {});
    throw new Refused(`The package read back from the target does not match what was downloaded (${back.missing} file(s) missing)`, 'checksum_mismatch');
  }
  return {
    storedPath: relative(root, final).split(sep).join('/'), files: back.list.length, bytes: back.bytes,
    sha256, downloadSha256, layoutSha256: packageLayout(back.list),
  };
}

/** Read a package back again: every listed file, as one checksum, with how many are gone. */
async function runVerifyFolder(ctx: ArchiveCtx, job: any): Promise<Record<string, unknown>> {
  void ctx;
  const root = await targetRoot(job);
  const dir = insideTarget(root, String(job.payload?.storedPath ?? ''));
  try { if (!(await stat(dir)).isDirectory()) return { present: false }; } catch { return { present: false }; }
  const files = Array.isArray(job.payload?.files) ? job.payload.files : [];
  const listed = files.map((f: any) => ({ path: cleanPackagePath(f?.path), bytes: Number(f?.bytes) })).filter((f: any) => f.path) as { path: string; bytes: number }[];
  const back = await readFolder(dir, listed);
  const changed = back.list.filter((f) => { const want = listed.find((l) => l.path === f.path); return want && want.bytes !== f.bytes; }).length;
  return { present: true, sha256: packageManifest(back.list), bytes: back.bytes, files: back.list.length, missingFiles: back.missing, changedFiles: changed };
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
      const result = job.type === 'archive.copy' ? await runCopy(ctx, job) : job.type === 'archive.verify' ? await runVerify(ctx, job)
        : job.type === 'archive.copy-folder' ? await runCopyFolder(ctx, job) : job.type === 'archive.verify-folder' ? await runVerifyFolder(ctx, job) : null;
      if (!result) throw new Refused(`this agent does not run ${job.type}`, 'unknown_type', true);
      const c = await call(ctx, `/api/site-agent/jobs/${job.id}/complete`, { leaseId: job.leaseId, result });
      if (c.status === 422 && job.type === 'archive.copy-folder' && typeof result.storedPath === 'string') {
        // A package the cloud refused (incomplete, or not what it has): the
        // whole folder this job wrote goes, so no half package stays.
        await rm(insideTarget(await targetRoot(job), result.storedPath), { recursive: true, force: true }).catch(() => {});
        log(`[archive] ${job.type} ${job.id}: refused by the cloud (${c.body?.code ?? c.status}), folder removed; it will be retried`);
      } else if (c.status === 422 && job.type === 'archive.copy' && typeof result.storedPath === 'string') {
        // The cloud refused the copy (it does not match the original): remove
        // it, so only a verified copy ever stays at the target.
        if (job.payload?.target?.kind === 's3') { const c = storeFor(ctx, job); await S3.removeOwn(c, storeKey(c, result.storedPath)); }
        else await unlink(insideTarget(await targetRoot(job), result.storedPath)).catch(() => {});
        log(`[archive] ${job.type} ${job.id}: refused by the cloud (${c.body?.code ?? c.status}), copy removed; it will be retried`);
      } else if (c.status !== 200) {
        log(`[archive] ${job.type} ${job.id}: complete answered ${c.status} ${c.body?.code ?? ''}`);
      } else {
        log(`[archive] ${job.type} ${job.id}: done${result.storedPath ? ` (${result.storedPath})` : ''}`);
      }
    } catch (e: any) {
      const refused = e instanceof Refused || e instanceof S3.S3Refused;
      const code = refused ? e.code : 'site_error';
      log(`[archive] ${job.type} ${job.id} failed: ${e?.message ?? e}`);
      if (code !== 'lease_lost') {
        await call(ctx, `/api/site-agent/jobs/${job.id}/fail`, { leaseId: job.leaseId, error: String(e?.message ?? e).slice(0, 2000), code, permanent: refused && e.permanent });
      }
    }
  }
  return ran;
}
