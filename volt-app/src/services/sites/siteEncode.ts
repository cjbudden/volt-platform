// ============================================================================
//  HYBRID SITES 4: SITE ENCODING, THE CLOUD SIDE (build queue H4,
//  HYBRID_SITES.md "The on-prem flow", steps 3, 4, 6 and 7).
//
//  A file whose source stays on the customer's network is encoded there by a
//  site worker, and only the packaged output comes to the cloud. The cloud
//  keeps every decision:
//
//    1. site.vod-probe (in the site's pool): the worker probes the source with
//       the same vod_encoder.py and returns the probe.
//    2. The cloud fits the ladder to that probe with the SAME planEncode the
//       cloud encode uses (handlers/vodEncode.ts), so the upscale policy and
//       the ladder choice stay in one place, and queues
//    3. site.vod-encode (in the site's pool) with the encoder's job file minus
//       its paths: the worker runs vod_encoder.py with exactly these settings,
//       so segment length, codecs and packaging match a cloud encode.
//    4. The worker DECLARES what it produced (relative paths, sizes, SHA-256).
//       The cloud turns each file into an upload transfer of that one job, to a
//       staging folder of its own, so a host still never names a path here.
//    5. On complete the cloud VERIFIES before anything counts: every declared
//       file present at its size (the checksum was checked as it arrived), the
//       master playlist lists the planned renditions, every playlist, init and
//       segment it names is there, the segment counts fit the duration, the
//       DASH manifest is static. A failure discards the upload and the job is
//       retried; after its attempts the asset says why.
//    6. Verified, the package replaces the asset's media and the cloud
//       encode's own finish runs (finishEncode): the asset is recorded exactly
//       as one encoded here, then QC, stills and follow-up jobs.
//
//  WHERE THE PACKAGE LANDS. This build writes to the control plane's own disk
//  (the single Mac server, VOD_STORE local). With the origin bucket (AWS) the
//  upload should go straight to the bucket instead of through the control
//  plane, which is H4-2; until then a site encode is refused there rather
//  than moving every byte through the API.
// ============================================================================
import { mkdir, rename, rm, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { one, query } from '../../db';
import { ApiError, badRequest, conflict, notFound } from '../../util/http';
import { enqueue, sitePool, type JobRow } from '../jobs/queue';
import { JobLog } from '../jobs/jobLog';
import { PermanentError } from '../jobs/worker';
import { planEncode, encoderJobFor, finishEncode, outDirFor, publicBase, type EncodePlan } from '../jobs/handlers/vodEncode';
import type { JobTransfer } from './siteJobs';

export const SITE_VOD_PROBE = 'site.vod-probe';
export const SITE_VOD_ENCODE = 'site.vod-encode';
export const SITE_ENCODE_JOB_TYPES = [SITE_VOD_PROBE, SITE_VOD_ENCODE];
export const isSiteEncodeJob = (type: string) => SITE_ENCODE_JOB_TYPES.includes(type);

/** A package bigger than this is not an encode of one file (a 4K two-hour film is well under it). */
export const MAX_PACKAGE_FILES = Number(process.env.SITE_PACKAGE_MAX_FILES ?? 50_000);
export const MAX_PACKAGE_BYTES = Number(process.env.SITE_PACKAGE_MAX_BYTES ?? 500 * 2 ** 30);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (status: number, message: string, code: string) => Object.assign(new ApiError(status, message), { code });

export interface SiteEncodeRequest {
  vodAssetId: string;
  accountId: string;
  siteId: string;
  /** Where the source is ON THE SITE, as the site's agent knows it. Never read here. */
  sitePath: string;
  ladderGroupId?: string | null;
  segmentSeconds?: number | null;
  loudnorm?: boolean;
  /** The source's size, when the site reported it (shown on the asset). */
  sourceBytes?: number | null;
}

/** The origin the package would land in: only this server's disk in this build. */
async function storeIsLocal(): Promise<boolean> {
  const { vodStore } = await import('../fast/vodStore');
  return vodStore() === 'local';
}

/**
 * Queue an encode at a site. The asset reads Processing until the cloud has
 * verified what the site uploaded.
 */
export async function requestSiteEncode(r: SiteEncodeRequest): Promise<JobRow> {
  if (!UUID.test(String(r.vodAssetId)) || !UUID.test(String(r.siteId))) throw badRequest('vodAssetId and siteId must be ids');
  const sitePath = String(r.sitePath ?? '');
  if (!sitePath || sitePath.length > 2048 || /[\u0000-\u001f]/.test(sitePath)) throw badRequest('sitePath must name the source file at the site');
  const site = await one<any>(
    `SELECT s.id, s.status, a.licences FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.id = $1 AND s.account_id = $2`,
    [r.siteId, r.accountId]);
  if (!site) throw notFound('site not found');
  if (!(site.licences ?? []).includes('hybrid_sites')) throw err(403, 'Site encoding needs the Hybrid Sites add-on', 'licence_required');
  if (site.status !== 'active') throw conflict('This site is disabled');
  const asset = await one<any>(
    `SELECT v.id FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events e ON e.id = v.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.id = $1 AND COALESCE(g.account_id, v.account_id) = $2`, [r.vodAssetId, r.accountId]);
  if (!asset) throw notFound('asset not found');
  if (!(await storeIsLocal())) {
    throw err(409, 'Encoding at a site with the origin bucket arrives with build queue H4-2; this server stores packages in a bucket', 'site_encode_needs_local_store');
  }
  const payload = {
    vodAssetId: r.vodAssetId, accountId: r.accountId, siteId: r.siteId, sitePath,
    ladderGroupId: r.ladderGroupId ?? null, segmentSeconds: r.segmentSeconds ?? null, loudnorm: !!r.loudnorm,
    sourceBytes: Number.isSafeInteger(r.sourceBytes) ? r.sourceBytes : null,
  };
  const job = await enqueue({ type: SITE_VOD_PROBE, payload, pool: sitePool(r.siteId), dedupeKey: `${SITE_VOD_PROBE}:${r.vodAssetId}`, priority: 50 });
  await query(
    `UPDATE vod_assets SET media_state = 'processing', media_error = NULL, media_error_code = NULL, media_state_at = now(),
            encode_job_id = $2, updated_at = now() WHERE id = $1`, [r.vodAssetId, job.id]);
  return job;
}

/* ------------------------------------------------------------ the probe */

type Verdict =
  | { ok: true; apply: () => Promise<void> }
  | { ok: false; status: number; message: string; code: string; permanent?: boolean };

/** A probe as vod_encoder.py --probe_only answers it, checked for shape. */
function probeOf(raw: any): Record<string, any> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const num = (v: any) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
  if (!num(raw.width) || !num(raw.height) || !num(raw.fps) || !num(raw.durationMs)) return null;
  if (raw.audioTracks !== undefined && !Array.isArray(raw.audioTracks)) return null;
  if (JSON.stringify(raw).length > 32 * 1024) return null;
  return raw;
}

async function judgeProbe(job: JobRow, result: any): Promise<Verdict> {
  const p = job.payload as SiteEncodeRequest;
  const probe = probeOf(result?.probe);
  if (!probe) return { ok: false, status: 400, message: 'result.probe must be the probe vod_encoder.py returned', code: 'bad_result' };
  if (probe.ok === false) {
    return { ok: false, status: 422, message: `the source could not be read at the site (${String(probe.error ?? 'no reason given').slice(0, 300)})`, code: 'unreadable_source', permanent: true };
  }
  const log = await JobLog.open(job.id, job.attempts || 1);
  let plan: EncodePlan;
  try {
    log.step(`probe from the site: ${probe.width ?? '?'}x${probe.height ?? '?'}${probe.fps ? ` ${probe.fps} fps` : ''}${probe.durationMs ? `, ${(probe.durationMs / 1000).toFixed(1)} s` : ''}`);
    plan = await planEncode(p, probe, log);
  } catch (e: any) {
    log.err(`FAILED: ${String(e?.message ?? e)}\n`);
    await log.close();
    if (e instanceof PermanentError) return { ok: false, status: 422, message: e.message, code: e.code, permanent: true };
    throw e;
  }
  return {
    ok: true,
    apply: async () => {
      // The encode job carries the plan it was given, so the verification and
      // the finish judge the package against THAT plan, even if someone edits
      // the ladder while the site works.
      const enc = await enqueue({
        type: SITE_VOD_ENCODE, pool: job.pool, priority: 50, dedupeKey: `${SITE_VOD_ENCODE}:${p.vodAssetId}`,
        payload: {
          vodAssetId: p.vodAssetId, accountId: p.accountId, siteId: p.siteId, sitePath: p.sitePath,
          segmentSeconds: p.segmentSeconds ?? null, sourceBytes: p.sourceBytes ?? null,
          probe, plan, encoder: encoderJobFor(plan, p, probe), transfers: [],
        },
      });
      await query(`UPDATE vod_assets SET encode_job_id = $2, updated_at = now() WHERE id = $1`, [p.vodAssetId, enc.id]);
      log.step(`queued the encode at the site: ${plan.summary}`);
      await log.close();
    },
  };
}

/* ---------------------------------------------------- declared outputs */

export interface DeclaredFile { path: string; bytes: number; sha256: string }

/** A package path: plain segments, no dot files, no way out. */
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}){0,6}$/;

/** Where this attempt's upload waits until it is verified. */
export function stagingDirFor(job: Pick<JobRow, 'id' | 'attempts' | 'payload'>): string {
  return `${outDirFor(job.payload.vodAssetId)}.site-${job.id}-a${job.attempts || 1}`;
}

/**
 * The worker says what it produced. Each file becomes one upload transfer of
 * this job (`out/<path>`), into this attempt's staging folder, with the
 * checksum the upload is held to. Declaring again replaces the list; with
 * `append` it adds to it, so a long film's package can be declared in parts
 * that each fit a request body.
 */
export function declareOutputs(job: JobRow, raw: unknown, append = false): { declared: DeclaredFile[]; transfers: JobTransfer[]; staging: string } {
  if (job.type !== SITE_VOD_ENCODE) throw err(409, 'Only an encode job declares outputs', 'not_an_encode');
  if (!Array.isArray(raw) || !raw.length) throw badRequest('files must list what the encode produced');
  const before: DeclaredFile[] = append && Array.isArray(job.payload?.declared) ? job.payload.declared : [];
  if (before.length + raw.length > MAX_PACKAGE_FILES) throw badRequest(`a package is limited to ${MAX_PACKAGE_FILES} files`);
  const seen = new Set<string>(before.map((d) => d.path));
  let total = before.reduce((a, d) => a + d.bytes, 0);
  const declared: DeclaredFile[] = raw.map((f: any, i: number) => {
    const path = String(f?.path ?? '');
    if (!SAFE_PATH.test(path)) throw badRequest(`files[${i}].path must be a plain relative path inside the package`);
    if (seen.has(path)) throw badRequest(`files[${i}].path is listed twice`);
    seen.add(path);
    const bytes = Number(f?.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw badRequest(`files[${i}].bytes must be a whole number of bytes`);
    const sha256 = String(f?.sha256 ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw badRequest(`files[${i}].sha256 must be the file's SHA-256 in hex`);
    total += bytes;
    return { path, bytes, sha256 };
  });
  if (total > MAX_PACKAGE_BYTES) throw badRequest(`a package is limited to ${MAX_PACKAGE_BYTES} bytes`);
  const root = stagingDirFor(job);
  const all = [...before, ...declared];
  const transfers: JobTransfer[] = all.map((d) => ({ name: `out/${d.path}`, direction: 'upload', uri: join(root, ...d.path.split('/')), bytes: d.bytes, sha256: d.sha256 }));
  return { declared: all, transfers, staging: root };
}

/* --------------------------------------------------------- verification */

/** The URIs a playlist names (segments, maps, child playlists), relative to the package root. */
function urisIn(text: string, base: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#')) {
      const m = /URI="([^"]+)"/.exec(l);
      if (m && /^#EXT-X-(MAP|MEDIA|I-FRAME-STREAM-INF)/.test(l)) out.push(m[1]);
      continue;
    }
    out.push(l);
  }
  return out.map((u) => (/^[a-z]+:\/\//i.test(u) || u.startsWith('/') ? `\u0000${u}` : posix.normalize(posix.join(base, u))));
}

/**
 * Is the uploaded package the encode that was planned? Every problem found is
 * listed, so the job's error says what was wrong rather than the first thing.
 */
export async function verifyPackage(dir: string, declared: DeclaredFile[], payload: any): Promise<string[]> {
  const problems: string[] = [];
  const have = new Set(declared.map((d) => d.path));
  for (const d of declared) {
    const s = await stat(join(dir, ...d.path.split('/'))).catch(() => null);
    if (!s?.isFile()) problems.push(`${d.path} was declared but not uploaded`);
    else if (s.size !== d.bytes) problems.push(`${d.path} is ${s.size} bytes, declared ${d.bytes}`);
  }
  if (problems.length) return problems;
  const plan = payload.plan as EncodePlan;
  const packaging = String(payload.encoder?.packaging ?? 'both');
  if (packaging !== 'dash' && !have.has('master.m3u8')) return ['the package has no master.m3u8'];
  if (packaging !== 'hls' && !have.has('manifest.mpd')) return ['the package has no manifest.mpd'];
  const seg = Number(payload.encoder?.segment_seconds) || 0;
  const durSec = Number(payload.probe?.durationMs) > 0 ? Number(payload.probe.durationMs) / 1000 : 0;
  const read = (p: string) => readFile(join(dir, ...p.split('/')), 'utf8');

  if (packaging !== 'dash') {
    const master = await read('master.m3u8');
    if (!master.startsWith('#EXTM3U')) problems.push('master.m3u8 is not an HLS playlist');
    const variants = (master.match(/^#EXT-X-STREAM-INF/gm) ?? []).length;
    const want = plan.audioOnly ? 1 : plan.fit.kept.length;
    if (plan.audioOnly ? variants < 1 : variants !== want) {
      problems.push(`master.m3u8 lists ${variants} rendition(s); the plan has ${want}`);
    }
    for (const child of urisIn(master, '')) {
      if (child.startsWith('\u0000') || child.startsWith('..')) { problems.push(`master.m3u8 points outside the package (${child.replace('\u0000', '')})`); continue; }
      if (!have.has(child)) { problems.push(`master.m3u8 names ${child}, which is not in the package`); continue; }
      const text = await read(child);
      if (!/^#EXT-X-ENDLIST/m.test(text)) problems.push(`${child} is not a finished (VOD) playlist`);
      const segs = (text.match(/^#EXTINF/gm) ?? []).length;
      if (!segs) problems.push(`${child} has no segments`);
      else if (seg > 0 && durSec > 0) {
        const lo = Math.max(1, Math.floor(durSec / seg) - 1), hi = Math.ceil(durSec / seg) + 1;
        if (segs < lo || segs > hi) problems.push(`${child} has ${segs} segments; ${durSec.toFixed(1)} s in ${seg} s segments needs ${lo} to ${hi}`);
      }
      for (const u of urisIn(text, posix.dirname(child))) {
        if (u.startsWith('\u0000') || u.startsWith('..')) problems.push(`${child} points outside the package`);
        else if (!have.has(u)) problems.push(`${child} names ${u}, which is not in the package`);
      }
    }
  }
  if (packaging !== 'hls') {
    const mpd = await read('manifest.mpd');
    if (!/<MPD[\s>]/.test(mpd)) problems.push('manifest.mpd is not a DASH manifest');
    else if (!/type="static"/.test(mpd)) problems.push('manifest.mpd is not static (a finished file must not be served as live)');
  }
  return problems.slice(0, 50);
}

async function judgeEncode(job: JobRow, result: any): Promise<Verdict> {
  const declared: DeclaredFile[] = Array.isArray(job.payload?.declared) ? job.payload.declared : [];
  if (!declared.length) return { ok: false, status: 400, message: 'declare the package first (POST /jobs/:id/outputs) and upload it', code: 'nothing_declared' };
  // Verified where it was declared to go (a lease reaped mid-upload leaves a
  // declaration of its own attempt, which the next attempt replaces).
  const staging = typeof job.payload?.staging === 'string' ? job.payload.staging : stagingDirFor(job);
  const problems = await verifyPackage(staging, declared, job.payload);
  if (problems.length) {
    // THE UPLOAD IS DISCARDED, never half kept: the retry uploads into a
    // staging folder of its own attempt.
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    return { ok: false, status: 422, message: `the package did not verify: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (and ${problems.length - 5} more)` : ''}`, code: 'verification_failed' };
  }
  const encoderResult = result?.encoder && typeof result.encoder === 'object' ? result.encoder : {};
  return {
    ok: true,
    apply: async () => {
      const p = job.payload;
      const log = await JobLog.open(job.id, job.attempts || 1);
      try {
        log.step(`package from the site verified: ${declared.length} files`);
        // Swapped in whole: the asset never shows a mix of the old and new encode.
        const outDir = outDirFor(p.vodAssetId);
        await mkdir(dirname(outDir), { recursive: true });
        const old = existsSync(outDir) ? `${outDir}.replaced-${Date.now()}` : null;
        if (old) await rename(outDir, old);
        await rename(staging, outDir);
        if (old) await rm(old, { recursive: true, force: true }).catch(() => {});
        const master = existsSync(join(outDir, 'master.m3u8')) ? `${publicBase(p.vodAssetId)}/master.m3u8` : null;
        const mpd = existsSync(join(outDir, 'manifest.mpd')) ? `${publicBase(p.vodAssetId)}/manifest.mpd` : null;
        await finishEncode({ progress: async () => {} }, log, {
          p: { vodAssetId: p.vodAssetId, accountId: p.accountId, segmentSeconds: p.segmentSeconds ?? null },
          probe: p.probe, plan: p.plan, master, mpd, outDir, sourcePath: null, srcBytes: p.sourceBytes ?? null, result: encoderResult,
        });
        // Where it was encoded, on the asset (HYBRID_SITES.md: the asset page says so).
        await query(
          `UPDATE vod_assets SET encode_result = COALESCE(encode_result, '{}'::jsonb) || jsonb_build_object('encodedAt', jsonb_build_object('site', $2::text, 'job', $3::text)) WHERE id = $1`,
          [p.vodAssetId, p.siteId, job.id]);
      } catch (e: any) {
        log.err(`FAILED after verification: ${String(e?.message ?? e)}\n`);
        await markFailed(p.vodAssetId, `the package from the site was verified but could not be recorded: ${String(e?.message ?? e).slice(0, 300)}`, 'site_finish_failed');
      } finally {
        await log.close();
      }
    },
  };
}

/** Judge a site encode job's result before it counts (called by siteJobs.complete). */
export async function judgeSiteEncode(job: JobRow, result: any): Promise<Verdict> {
  if (job.type === SITE_VOD_PROBE) return judgeProbe(job, result);
  if (job.type === SITE_VOD_ENCODE) return judgeEncode(job, result);
  return { ok: false, status: 400, message: 'not a site encode job', code: 'bad_job' };
}

async function markFailed(assetId: string, message: string, code: string) {
  await query(
    `UPDATE vod_assets SET media_state = 'failed', media_error = $2, media_error_code = $3, media_state_at = now(), updated_at = now() WHERE id = $1`,
    [assetId, message.slice(0, 1000), code.slice(0, 60)]);
}

/** An attempt failed (reported by the worker, or refused here). The last one fails the asset with the reason. */
export async function siteEncodeAttemptFailed(job: JobRow, message: string, code: string, final: boolean) {
  if (!job.payload?.vodAssetId) return;
  if (job.type === SITE_VOD_ENCODE) {
    // The next attempt starts clean: no declaration, no upload transfers, no staging.
    await rm(typeof job.payload?.staging === 'string' ? job.payload.staging : stagingDirFor(job), { recursive: true, force: true }).catch(() => {});
    await query(
      `UPDATE jobs SET payload = (payload - 'declared' - 'staging') || jsonb_build_object('transfers', '[]'::jsonb) WHERE id = $1`, [job.id]);
  }
  if (final) await markFailed(job.payload.vodAssetId, `encoding at the site failed: ${message}`, code);
}
