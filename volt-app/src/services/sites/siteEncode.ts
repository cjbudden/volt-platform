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
//  WHERE THE PACKAGE LANDS.
//    - VOD_STORE local (the single Mac server): each file is PUT to this API
//      through a signed URL, into a staging folder on this disk, and checked
//      against its SHA-256 as it arrives.
//    - VOD_STORE s3 (AWS, build queue H4-4): each file is PUT straight to the
//      origin bucket under site-staging/<asset>/<job>-a<attempt>/ with a
//      presigned URL that also signs the file's SHA-256, so S3 itself refuses
//      other bytes and no byte of the upload passes through the API or its
//      load balancer. On complete the cloud reads the package back from the
//      bucket (in region, so no transfer charge), hashes every file against
//      what was declared, and then verifies and records it exactly as on the
//      Mac: the same verifyPackage and the same finishEncode, which puts the
//      package under vod/<id>/ as it does after a cloud encode. The staging
//      prefix is removed either way; a lifecycle rule in deploy/terraform
//      sweeps whatever a dead task left behind.
//
//  A FAST CHANNEL'S LADDER VARIANT AT A SITE (build queue H4-6). A site-kept
//  original that a channel with a ladder needs packaged to that ladder is
//  packaged at the site too, in the same two jobs with `variant` in the
//  payload: the probe goes to the site, the cloud plans the variant with the
//  SAME settings vod.ladder uses (handlers/vodLadder.ts: every rung, the 16:9
//  box, the ladder's frame rate, one folder per version of the ladder), and
//  the verified package lands in that variant's folder under ladders/ with its
//  vod_asset_ladders row. It is not the asset's own encode: the asset keeps
//  its media, state, encode result and stills, and a failure fails only the
//  variant's row.
// ============================================================================
import { mkdir, rename, rm, stat, readFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { join, dirname, posix } from 'node:path';
import { config } from '../../config';
import { isS3Uri, mediaS3Client, parseS3Uri } from '../media/s3Driver';
import { vodStore } from '../fast/vodStore';
import { one, query } from '../../db';
import { ApiError, badRequest, conflict, notFound } from '../../util/http';
import { enqueue, sitePool, type JobRow } from '../jobs/queue';
import { JobLog } from '../jobs/jobLog';
import { PermanentError } from '../jobs/worker';
import { planEncode, encoderJobFor, finishEncode, outDirFor, publicBase, type EncodePlan } from '../jobs/handlers/vodEncode';
import type { JobTransfer } from './siteJobs';
import { setRow, ladderNotes, variantFolder, ladderEncoderSettings, variantLadder } from '../jobs/handlers/vodLadder';
import { variantRel } from '../fast/ladder';

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
  /**
   * Package to a FAST channel's ladder instead of the asset's own encode
   * (a variant beside it, H4-6). ladderGroupId, segmentSeconds and loudnorm
   * above are then ignored.
   */
  variant?: SiteVariant | null;
}

/** Which variant of a channel ladder a site job makes (as vod.ladder's payload names it). */
export interface SiteVariant { ladderGroupId: string; segmentSeconds: number; loudnorm: boolean; channelId?: string | null }

/** The dedupe key part of a variant: one in flight per asset and variant, beside the asset's own encode. */
const variantKey = (v: SiteVariant) => variantRel(v.ladderGroupId, v.segmentSeconds, !!v.loudnorm);

function variantOf(raw: any): SiteVariant | null {
  if (!raw) return null;
  if (!UUID.test(String(raw.ladderGroupId)) || !(Number(raw.segmentSeconds) > 0) || Number(raw.segmentSeconds) > 60) throw badRequest('variant needs a ladderGroupId and segmentSeconds');
  return { ladderGroupId: String(raw.ladderGroupId), segmentSeconds: Number(raw.segmentSeconds), loudnorm: !!raw.loudnorm, channelId: raw.channelId && UUID.test(String(raw.channelId)) ? String(raw.channelId) : null };
}

/** Where a site's package is uploaded to wait for verification, in the origin bucket. */
export const SITE_STAGING_PREFIX = 'site-staging/';

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
  const variant = variantOf(r.variant);
  if (variant) {
    // A variant leaves the asset alone: it keeps playing its own encode, and
    // the readiness of the channel follows the variant's row.
    const payload = {
      vodAssetId: r.vodAssetId, accountId: r.accountId, siteId: r.siteId, sitePath, variant,
      sourceBytes: Number.isSafeInteger(r.sourceBytes) ? r.sourceBytes : null,
    };
    const job = await enqueue({ type: SITE_VOD_PROBE, payload, pool: sitePool(r.siteId), dedupeKey: `${SITE_VOD_PROBE}:${r.vodAssetId}:${variantKey(variant)}`, priority: 60, channelId: variant.channelId ?? null });
    await setRow({ vodAssetId: r.vodAssetId, ...variant }, { state: 'queued', error: null, job_id: job.id });
    return job;
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
  if (job.payload?.variant) return judgeVariantProbe(job, probe);
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

/**
 * The probe of a variant: plan it exactly as vod.ladder would here, and queue
 * the encode at the site with that plan in its payload (the folder, the rungs
 * and the frame rate it is verified and recorded against).
 */
async function judgeVariantProbe(job: JobRow, probe: Record<string, any>): Promise<Verdict> {
  const p = job.payload as SiteEncodeRequest & { variant: SiteVariant };
  const v = p.variant;
  const log = await JobLog.open(job.id, job.attempts || 1);
  try {
    log.step(`probe from the site: ${probe.width ?? '?'}x${probe.height ?? '?'}${probe.fps ? ` ${probe.fps} fps` : ''}${probe.durationMs ? `, ${(probe.durationMs / 1000).toFixed(1)} s` : ''}`);
    if (probe.hasVideo === false) throw new PermanentError('this file has no video track, so it cannot go on a video ladder', 'no_video');
    const ladder = await variantLadder(v.ladderGroupId, p.accountId);
    const asset = await one<any>(`SELECT ingest FROM vod_assets WHERE id = $1`, [p.vodAssetId]);
    if (!asset) throw new PermanentError('the asset is gone', 'asset_missing');
    const notes = ladderNotes(asset, probe, ladder);
    const rel = variantFolder(ladder, v);
    const encoder = ladderEncoderSettings(ladder, v, probe);
    return {
      ok: true,
      apply: async () => {
        try {
          const enc = await enqueue({
            type: SITE_VOD_ENCODE, pool: job.pool, priority: 60, dedupeKey: `${SITE_VOD_ENCODE}:${p.vodAssetId}:${variantKey(v)}`, channelId: v.channelId ?? null,
            payload: {
              vodAssetId: p.vodAssetId, accountId: p.accountId, siteId: p.siteId, sitePath: p.sitePath, sourceBytes: p.sourceBytes ?? null,
              probe, encoder, transfers: [],
              variant: { ...v, rel, rungs: ladder.rungs, fps: ladder.fps, notes, groupName: ladder.groupName },
            },
          });
          await setRow({ vodAssetId: p.vodAssetId, ...v }, { state: 'encoding', error: null, job_id: enc.id });
          log.step(`queued the ladder variant at the site: ${ladder.groupName}, ${ladder.rungs.map((r) => `${r.height}p`).join(', ')}, ${v.segmentSeconds} s segments${v.loudnorm ? ', loudness normalised' : ''}`);
          for (const n of notes) log.step(`  ${n}`);
        } finally {
          await log.close();
        }
      },
    };
  } catch (e: any) {
    log.err(`FAILED: ${String(e?.message ?? e)}\n`);
    await log.close();
    if (e instanceof PermanentError) return { ok: false, status: 422, message: e.message, code: e.code, permanent: true };
    throw e;
  }
}

/* ---------------------------------------------------- declared outputs */

export interface DeclaredFile { path: string; bytes: number; sha256: string }

/** A package path: plain segments, no dot files, no way out. */
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}){0,6}$/;

/**
 * Where this attempt's upload waits until it is verified: a folder on this
 * disk, or (packages in the origin bucket) an s3:// prefix of its own.
 */
export function stagingDirFor(job: Pick<JobRow, 'id' | 'attempts' | 'payload'>): string {
  if (vodStore() === 's3') return `s3://${config.aws.s3Bucket}/${SITE_STAGING_PREFIX}${job.payload.vodAssetId}/${job.id}-a${job.attempts || 1}`;
  return localCopyFor(job);
}

/** The folder on this disk the package is verified and recorded from (on S3, where it is read back to). */
function localCopyFor(job: Pick<JobRow, 'id' | 'attempts' | 'payload'>): string {
  return `${outDirFor(job.payload.vodAssetId)}.site-${job.id}-a${job.attempts || 1}`;
}

/** Remove an attempt's upload, wherever it waits. Never throws: a leftover is swept, not fatal. */
export async function removeStaging(staging: string): Promise<void> {
  if (!isS3Uri(staging)) { await rm(staging, { recursive: true, force: true }).catch(() => {}); return; }
  const loc = parseS3Uri(`${staging.replace(/\/+$/, '')}/`);
  // Only ever a site-staging prefix: a bad payload must not empty anything else.
  if (!loc || !loc.key.startsWith(SITE_STAGING_PREFIX) || loc.key.split('/').length < 4) return;
  try {
    const { ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
    const c = await mediaS3Client(config.aws.region);
    let token: string | undefined;
    do {
      const r: any = await c.send(new ListObjectsV2Command({ Bucket: loc.bucket, Prefix: loc.key, ContinuationToken: token }));
      const keys = (r.Contents ?? []).map((o: any) => ({ Key: o.Key }));
      if (keys.length) await c.send(new DeleteObjectsCommand({ Bucket: loc.bucket, Delete: { Objects: keys, Quiet: true } }));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  } catch (e) {
    console.error(`[site encode] staging ${staging} not removed (the lifecycle rule sweeps it):`, e);
  }
}

/**
 * Read an attempt's upload back from the bucket into `dest`, hashing every
 * file on the way: present, at its declared size, with its declared SHA-256.
 * Every problem is listed. In region this costs GET requests, not transfer.
 */
export async function readBackFromBucket(staging: string, declared: DeclaredFile[], dest: string): Promise<string[]> {
  const loc = parseS3Uri(`${staging.replace(/\/+$/, '')}/`);
  if (!loc) return ['the upload has no place in the bucket'];
  const { ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const c = await mediaS3Client(config.aws.region);
  const sizes = new Map<string, number>();
  let token: string | undefined;
  do {
    const r: any = await c.send(new ListObjectsV2Command({ Bucket: loc.bucket, Prefix: loc.key, ContinuationToken: token }));
    for (const o of r.Contents ?? []) sizes.set(String(o.Key).slice(loc.key.length), Number(o.Size ?? 0));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  const problems: string[] = [];
  for (const d of declared) {
    const size = sizes.get(d.path);
    if (size === undefined) problems.push(`${d.path} was declared but not uploaded`);
    else if (size !== d.bytes) problems.push(`${d.path} is ${size} bytes, declared ${d.bytes}`);
  }
  if (problems.length) return problems.slice(0, 50);
  await mkdir(dest, { recursive: true });
  const fetchOne = async (d: DeclaredFile) => {
    const target = join(dest, ...d.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    const r: any = await c.send(new GetObjectCommand({ Bucket: loc.bucket, Key: loc.key + d.path }));
    const h = createHash('sha256');
    const tap = new Transform({ transform(chunk, _e, cb) { h.update(chunk); cb(null, chunk); } });
    await pipeline(r.Body as Readable, tap, createWriteStream(target));
    if (h.digest('hex') !== d.sha256) problems.push(`${d.path} does not match its declared SHA-256`);
  };
  const n = 8;
  for (let i = 0; i < declared.length && problems.length < 50; i += n) await Promise.all(declared.slice(i, i + n).map(fetchOne));
  return problems.slice(0, 50);
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
  const uriOf = (path: string) => (isS3Uri(root) ? `${root}/${path}` : join(root, ...path.split('/')));
  const transfers: JobTransfer[] = all.map((d) => ({ name: `out/${d.path}`, direction: 'upload', uri: uriOf(d.path), bytes: d.bytes, sha256: d.sha256 }));
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
  // A ladder variant carries every rung of the ladder; an encode the rungs it kept.
  const variantRungs: number | null = payload.variant ? (Array.isArray(payload.variant.rungs) ? payload.variant.rungs.length : 0) : null;
  const audioOnly = variantRungs === null && !!plan?.audioOnly;
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
    const want = variantRungs ?? (audioOnly ? 1 : plan.fit.kept.length);
    if (audioOnly ? variants < 1 : variants !== want) {
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
  // In the bucket: read back and hashed into a folder here first, so what is
  // verified and recorded is exactly the bytes that were declared.
  const local = isS3Uri(staging) ? localCopyFor(job) : staging;
  let problems: string[];
  try {
    if (local !== staging) await rm(local, { recursive: true, force: true });
    problems = local !== staging ? await readBackFromBucket(staging, declared, local) : [];
    if (!problems.length) problems = await verifyPackage(local, declared, job.payload);
  } catch (e: any) {
    problems = [`the upload could not be read back (${String(e?.message ?? e).slice(0, 200)})`];
  }
  if (problems.length) {
    // THE UPLOAD IS DISCARDED, never half kept: the retry uploads into a
    // staging folder of its own attempt.
    await removeStaging(staging);
    if (local !== staging) await rm(local, { recursive: true, force: true }).catch(() => {});
    return { ok: false, status: 422, message: `the package did not verify: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (and ${problems.length - 5} more)` : ''}`, code: 'verification_failed' };
  }
  const encoderResult = result?.encoder && typeof result.encoder === 'object' ? result.encoder : {};
  if (job.payload?.variant) return { ok: true, apply: () => finishVariant(job, declared, local, staging, encoderResult) };
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
        await rename(local, outDir);
        // A RE-ENCODE MUST NOT TAKE THE FAST PACKAGES WITH IT (H4-5). A FAST
        // channel's ladder variants (vod.ladder, `ladders/` inside this folder)
        // were made from the same original and a running playout may be reading
        // them, so they are carried into the new folder, not removed with the old.
        if (old && existsSync(join(old, 'ladders')) && !existsSync(join(outDir, 'ladders'))) await rename(join(old, 'ladders'), join(outDir, 'ladders'));
        // Read back and verified: the bucket's staging copy is done with.
        if (local !== staging) await removeStaging(staging);
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

/**
 * A verified ladder variant from the site: into its own folder under the
 * asset's ladders/ (on AWS uploaded under vod/<id>/<folder>, as vod.ladder
 * does), and its row ready. The asset's own encode is not touched.
 */
async function finishVariant(job: JobRow, declared: DeclaredFile[], local: string, staging: string, encoderResult: any): Promise<void> {
  const p = job.payload;
  const v = p.variant;
  const key = { vodAssetId: p.vodAssetId, ladderGroupId: v.ladderGroupId, segmentSeconds: v.segmentSeconds, loudnorm: !!v.loudnorm };
  const log = await JobLog.open(job.id, job.attempts || 1);
  try {
    log.step(`ladder variant from the site verified: ${declared.length} files`);
    const rel = String(v.rel);
    if (!/^ladders\/[0-9a-f-]{36}\/\d+s(-loud)?\/[0-9a-f]{8}$/.test(rel)) throw new Error(`the variant's folder is not a ladder folder (${rel})`);
    const outDir = join(outDirFor(p.vodAssetId), ...rel.split('/'));
    await mkdir(dirname(outDir), { recursive: true });
    // Same version of the ladder: replaced whole, as vod.ladder starts fresh.
    await rm(outDir, { recursive: true, force: true });
    await rename(local, outDir);
    if (local !== staging) await removeStaging(staging);
    let master = existsSync(join(outDir, 'master.m3u8')) ? `${publicBase(p.vodAssetId)}/${rel}/master.m3u8` : null;
    let mpd = existsSync(join(outDir, 'manifest.mpd')) ? `${publicBase(p.vodAssetId)}/${rel}/manifest.mpd` : null;
    if (vodStore() === 's3') {
      const { uploadVodDir } = await import('../fast/vodStore');
      const up = await uploadVodDir(outDir, p.vodAssetId, { subdir: rel });
      master = master ? up.master : null;
      mpd = mpd ? up.mpd : null;
    }
    await setRow(key, {
      state: 'ready', master_key: master, mpd_key: mpd, zero_start: encoderResult?.zero_start === true,
      rungs: v.rungs, fps: v.fps, notes: [...(Array.isArray(v.notes) ? v.notes : []), `packaged at the site that keeps the original`],
      error: null, job_id: job.id,
    });
    log.step(`ready: ${master ?? mpd}`);
  } catch (e: any) {
    log.err(`FAILED after verification: ${String(e?.message ?? e)}\n`);
    await setRow(key, { state: 'failed', error: `the variant from the site was verified but could not be recorded: ${String(e?.message ?? e).slice(0, 300)}`, job_id: job.id }).catch(() => {});
  } finally {
    await log.close();
  }
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
    await removeStaging(typeof job.payload?.staging === 'string' ? job.payload.staging : stagingDirFor(job));
    await query(
      `UPDATE jobs SET payload = (payload - 'declared' - 'staging') || jsonb_build_object('transfers', '[]'::jsonb) WHERE id = $1`, [job.id]);
  }
  if (!final) return;
  const v = job.payload.variant;
  // A variant's failure is the variant's: the asset keeps its own encode.
  if (v) await setRow({ vodAssetId: job.payload.vodAssetId, ladderGroupId: v.ladderGroupId, segmentSeconds: v.segmentSeconds, loudnorm: !!v.loudnorm }, { state: 'failed', error: `packaging at the site failed: ${message}`.slice(0, 1000), job_id: job.id });
  else await markFailed(job.payload.vodAssetId, `encoding at the site failed: ${message}`, code);
}
