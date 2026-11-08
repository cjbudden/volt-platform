// ============================================================================
//  ON-PREM WATCHFOLDERS AT A SITE (build queue H2, HYBRID_SITES.md).
//
//  The agent scans the site's watchfolders on the customer's own storage with
//  the cloud's scanner and rules (volt-app services/watchfolder/scanner.ts and
//  rules.ts, compiled into the agent from the same files: the console's dry
//  run and the decision here cannot disagree). One pass per folder:
//
//    1. Report any refusal an earlier pass could not report (the outbox).
//    2. Move back the refused files an operator pressed Reprocess on.
//    3. Scan: a file is considered once it has been quiet for the folder's
//       minimum age; a refused file is moved into the review folder HERE and
//       never leaves the site; an accepted file is reported to the cloud,
//       which decides it again with its own copy of the rules.
//    4. Placement "Upload and encode in the cloud": upload each accepted
//       file with tus (video and audio, and since H2b-5 images, slates and
//       companions). The cloud keeps the upload on the item and says how far
//       it got, so after a restart the agent resumes from there; the state
//       file only saves re-reading files that have not changed.
//    4b. Placement "Encode at site" (H4-3): a video or audio file is not
//       uploaded. The agent REGISTERS it: size, checksum, the first bytes
//       and the encoder's probe. The cloud runs the ingest on those facts and
//       queues the encode at this site; the original stays where it is.
//       Images, captions, slates and loops still upload as in step 4.
//    5. Move into the review folder the files the CLOUD sent to review (a
//       caption with no video after 24 hours, one over 25 MB): it decided,
//       but the file is here (H2b-5).
//
//  OUTBOUND ONLY, like the rest of the agent: every step is a call to the
//  cloud with the host credential; nothing listens.
// ============================================================================
import { stat, open } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
  scanFolder, checksumFile, moveToQuarantine,
  type ScanFolder, type ItemStore, type RecordedItem, type ScanResult,
} from '../../volt-app/src/services/watchfolder/scanner';
import { tusUploadFile } from './tus';

export interface SiteFolder extends ScanFolder { name: string; placement: 'upload_cloud' | 'encode_site' }

export interface WatchCtx {
  server: string;
  /** Read on every call: a rotated credential takes effect at once. */
  credential: () => string;
  fetch?: typeof fetch;
  log?: (s: string) => void;
  /** Remembered between passes (and in the state file): see SiteWatchMemory. */
  memory: SiteWatchMemory;
  now?: () => number;
  chunkBytes?: number;
  retries?: number;
  /** The encoder's probe of a file to register (siteEncode.ts siteProbe); none: registered without one. */
  probe?: (abs: string) => Promise<Record<string, unknown> | null>;
}

/** How much of the file's start a registration carries (the cloud takes up to 192 KiB). */
export const REGISTER_HEAD_BYTES = 192 * 1024;

async function headOf(abs: string, n: number): Promise<Buffer> {
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

/**
 * What the agent remembers. Nothing here is the truth (the cloud holds the
 * queue and the uploads); it only saves work:
 *   sums     path -> checksum for a file whose size and mtime have not moved,
 *            so an hour-long master on a NAS is not re-read every pass;
 *   known    folder:key:checksum the cloud already has, so it is not asked again;
 *   outbox   refusals moved into the review folder whose report failed, sent
 *            first next pass (else the file would sit in review unlisted).
 */
export interface SiteWatchMemory {
  sums: Record<string, { size: number; mtimeMs: number; sum: string }>;
  known: Record<string, true>;
  outbox: { folderId: string; item: RecordedItem }[];
}
export const emptyMemory = (): SiteWatchMemory => ({ sums: {}, known: {}, outbox: [] });

export interface FolderPass {
  folderId: string; name: string;
  scan?: ScanResult; error?: string;
  returned: number; uploaded: string[]; uploadErrors: { objectKey: string; error: string }[];
  /** Encode at site: files registered this pass (they stay here). */
  registered: string[];
  /** Files moved into the review folder because the cloud sent them there. */
  reviewed: number;
}

class AgentHttpError extends Error { constructor(msg: string, public status: number, public code?: string) { super(msg); } }

function client(ctx: WatchCtx) {
  const f = ctx.fetch ?? fetch;
  const base = ctx.server.replace(/\/+$/, '');
  return async (method: string, path: string, body?: unknown) => {
    const r = await f(base + path, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.credential()}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) throw new AgentHttpError(json?.error ?? `HTTP ${r.status}`, r.status, json?.code);
    return json;
  };
}

/** The scanner's store, answered by the cloud. */
function remoteStore(ctx: WatchCtx, folderId: string): ItemStore {
  const call = client(ctx);
  const mem = ctx.memory;
  const k = (key: string, sum: string) => `${folderId}:${key}:${sum}`;
  return {
    async isKnown(_fid, objectKey, checksum) {
      if (mem.known[k(objectKey, checksum)]) return true;
      const r = await call('POST', `/api/site-agent/watchfolders/${folderId}/known`, { objectKey, checksum });
      if (r?.known) mem.known[k(objectKey, checksum)] = true;
      return !!r?.known;
    },
    async record(_fid, _acct, item) {
      try {
        await call('POST', `/api/site-agent/watchfolders/${folderId}/items`, item);
        mem.known[k(item.objectKey, item.checksum)] = true;
      } catch (e: any) {
        // A REFUSED FILE IS ALREADY IN THE REVIEW FOLDER, which the scan does
        // not walk: if this report is lost, nobody is ever told. Keep it and
        // send it first next pass. An accepted file is still in the drop, so
        // the next pass simply decides and reports it again.
        if (item.status === 'quarantined' && !(e instanceof AgentHttpError && e.status < 500 && e.status !== 408 && e.status !== 429)) {
          mem.outbox.push({ folderId, item });
        }
        throw e;
      }
    },
    async quarantineKeysInUse() {
      const r = await call('GET', `/api/site-agent/watchfolders/${folderId}/quarantine-keys`);
      return new Set<string>(r?.items ?? []);
    },
  };
}

/** Checksum, remembered while the file's size and mtime stay the same. */
function rememberingChecksum(mem: SiteWatchMemory) {
  return async (abs: string, st: { size: number; mtimeMs: number }) => {
    const hit = mem.sums[abs];
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sum;
    const sum = await checksumFile(abs);
    mem.sums[abs] = { size: st.size, mtimeMs: st.mtimeMs, sum };
    return sum;
  };
}

/** The site's folders with their current rules. A pending host gets a 403 here. */
export async function siteFolders(ctx: WatchCtx): Promise<SiteFolder[]> {
  return (await client(ctx)('GET', '/api/site-agent/watchfolders'))?.items ?? [];
}

/** One pass over one folder. Never throws: a fault is reported on the folder and returned. */
export async function passFolder(ctx: WatchCtx, folder: SiteFolder): Promise<FolderPass> {
  const call = client(ctx);
  const log = ctx.log ?? ((s) => console.log(s));
  const out: FolderPass = { folderId: folder.id, name: folder.name, returned: 0, uploaded: [], uploadErrors: [], reviewed: 0, registered: [] };
  try {
    // 1. The outbox.
    const waiting = ctx.memory.outbox.filter((o) => o.folderId === folder.id);
    for (const o of waiting) {
      await call('POST', `/api/site-agent/watchfolders/${folder.id}/items`, o.item);
      ctx.memory.outbox.splice(ctx.memory.outbox.indexOf(o), 1);
    }

    // 2. Files an operator sent back from review.
    const back = (await call('GET', `/api/site-agent/watchfolders/${folder.id}/returns`))?.items ?? [];
    for (const r of back) {
      try {
        await moveToQuarantine(folder.path, r.quarantineKey, r.objectKey);   // the same safe move, the other way
        await call('POST', `/api/site-agent/watchfolders/${folder.id}/returns/${r.itemId}`, { ok: true });
        for (const key of Object.keys(ctx.memory.known)) if (key.startsWith(`${folder.id}:${r.objectKey}:`)) delete ctx.memory.known[key];
        out.returned++;
        log(`[watch] ${folder.name}: ${r.objectKey} back from review`);
      } catch (e: any) {
        await call('POST', `/api/site-agent/watchfolders/${folder.id}/returns/${r.itemId}`, { ok: false, error: String(e?.message ?? e) }).catch(() => {});
      }
    }

    // 3. The scan, with the cloud's rules.
    const scan = await scanFolder({ ...folder, checksum: rememberingChecksum(ctx.memory) }, remoteStore(ctx, folder.id), (ctx.now ?? Date.now)());
    out.scan = scan;
    for (const q of scan.quarantined) log(`[watch] ${folder.name}: ${q.objectKey} refused, moved to ${q.quarantineKey} (${q.reason})`);
    for (const a of scan.accepted) log(`[watch] ${folder.name}: ${a.objectKey} accepted as ${a.targetKind}`);

    // 4b. Registrations (Encode at site): the file stays here.
    if (folder.placement === 'encode_site') {
      const regs = (await call('GET', `/api/site-agent/watchfolders/${folder.id}/registrations`))?.items ?? [];
      for (const r of regs) {
        const abs = join(folder.path, String(r.objectKey).split('/').join(sep));
        try {
          const st = await stat(abs).catch(() => null);
          if (!st) throw new Error('the file is no longer in the folder');
          if (st.size !== r.sizeBytes) throw new Error('the file changed after it was accepted; the next pass decides it again');
          const head = await headOf(abs, REGISTER_HEAD_BYTES);
          const probe = ctx.probe ? await ctx.probe(abs).catch(() => null) : null;
          const done = await call('POST', `/api/site-agent/watchfolders/${folder.id}/registrations/${r.itemId}`,
            { sizeBytes: r.sizeBytes, checksum: r.checksum, head: head.toString('base64'), probe });
          out.registered.push(r.objectKey);
          log(`[watch] ${folder.name}: ${r.objectKey} registered${done?.asset?.title ? ` as "${done.asset.title}"` : ''}, encoded here`);
        } catch (e: any) {
          out.uploadErrors.push({ objectKey: r.objectKey, error: String(e?.message ?? e) });
          log(`[watch] ${folder.name}: ${r.objectKey} not registered: ${e?.message ?? e} (tried again next pass)`);
        }
      }
    }

    // 4. Uploads. In an Encode at site folder the cloud lists only what is
    //    still uploaded there (images, captions, slates, loops).
    {
      const pending = (await call('GET', `/api/site-agent/watchfolders/${folder.id}/uploads`))?.items ?? [];
      for (const u of pending) {
        const abs = join(folder.path, String(u.objectKey).split('/').join(sep));
        try {
          const st = await stat(abs).catch(() => null);
          if (!st) throw new Error('the file is no longer in the folder');
          if (st.size !== u.sizeBytes) throw new Error('the file changed after it was accepted; the next pass decides it again');
          const base = ctx.server.replace(/\/+$/, '');
          await tusUploadFile(abs, {
            endpoint: `${base}/api/site-agent/tus`, token: ctx.credential(), metadata: { itemId: String(u.itemId) },
            resumeUrl: u.upload?.url ? base + u.upload.url : null, chunkBytes: ctx.chunkBytes, retries: ctx.retries, fetch: ctx.fetch,
          });
          out.uploaded.push(u.objectKey);
          log(`[watch] ${folder.name}: ${u.objectKey} uploaded`);
        } catch (e: any) {
          out.uploadErrors.push({ objectKey: u.objectKey, error: String(e?.message ?? e) });
          log(`[watch] ${folder.name}: ${u.objectKey} upload stopped: ${e?.message ?? e} (resumes next pass)`);
        }
      }
    }

    // 5. Files the cloud sent to review. A cloud from before H2b-5 has no
    //    such list (404): nothing to do.
    const toReview = (await call('GET', `/api/site-agent/watchfolders/${folder.id}/reviews`)
      .catch((e) => { if (e instanceof AgentHttpError && e.status === 404) return null; throw e; }))?.items ?? [];
    for (const r of toReview) {
      try {
        await moveToQuarantine(folder.path, r.objectKey, r.quarantineKey);
        await call('POST', `/api/site-agent/watchfolders/${folder.id}/reviews/${r.itemId}`, { ok: true });
        out.reviewed++;
        log(`[watch] ${folder.name}: ${r.objectKey} sent to review by Volt, moved to ${r.quarantineKey}`);
      } catch (e: any) {
        await call('POST', `/api/site-agent/watchfolders/${folder.id}/reviews/${r.itemId}`, { ok: false, error: String(e?.message ?? e) }).catch(() => {});
      }
    }

    const problems = [...scan.errors.map((x) => `${x.objectKey}: ${x.error}`), ...out.uploadErrors.map((x) => `${x.objectKey}: ${x.error}`)];
    await call('POST', `/api/site-agent/watchfolders/${folder.id}/scanned`, { error: problems.length ? problems.slice(0, 3).join('; ') : null }).catch(() => {});
  } catch (e: any) {
    out.error = String(e?.message ?? e);
    log(`[watch] ${folder.name}: pass failed: ${out.error}`);
    await call('POST', `/api/site-agent/watchfolders/${folder.id}/scanned`, { error: out.error }).catch(() => {});
  }
  return out;
}

/** One pass over every folder of the site. */
export async function watchPass(ctx: WatchCtx): Promise<FolderPass[]> {
  const folders = await siteFolders(ctx);
  const out: FolderPass[] = [];
  for (const f of folders) out.push(await passFolder(ctx, f));
  return out;
}
