// ============================================================================
//  MIRROR AND ARCHIVE: PACKAGED OUTPUTS AS A COPY SOURCE (build queue H3-11,
//  HYBRID_SITES.md "Copy rules": "optionally packaged outputs").
//
//  A copy rule can ask for `what: ['packages']`. Each target then gets the
//  asset's HLS and DASH package as a FOLDER: the master playlist and the
//  DASH manifest, each rendition's playlist, init and media segments, the
//  I-frame and trick-play files, laid out as the player reads them, so the
//  folder plays from the target as it is:
//    `MorningNews-package/master.m3u8`
//    `MorningNews-package/manifest.mpd`
//    `MorningNews-package/720p/seg_1.m4s` ...
//  Left out: the progressive MP4 (it is the "source" or the clip), FAST
//  ladder variants (`ladders/`, rebuilt from the package when needed) and
//  reframed versions (`reframe/`), which are outputs of their own.
//
//  HOW BIG. Measured on the 56 encoded assets of the Mac test library
//  (7 Nov 2026): a package is 1.7 times its original at the median, from
//  0.1 times (a lightly compressed original) to 6 times (a small phone
//  file), 11 to 460 files. HLS and DASH share one set of CMAF segments, so
//  the second format adds only its manifest. The console says this beside
//  the tick box.
//
//  ONE JOB PER PACKAGE, NOT ONE PER FILE. A package is a few hundred files
//  and can be a few thousand. A job per file would mean a job row, a lease,
//  a completion and a copy row per segment, and a package half copied would
//  look half archived. One `archive.copy-folder` job lists every file as a
//  transfer of its own (the transfer URLs stay one object each); the agent
//  writes them into a folder beside its final name, renames the folder in,
//  reads every file back, and reports two checksums over the whole set
//  (packageManifest.ts). The copy counts only when both match: a package
//  missing a file, or with one file changed, is never archived.
//
//  New job types (`archive.copy-folder`, `archive.verify-folder`) rather
//  than new payloads on the old ones: an agent from before this release
//  never leases a package job, so it cannot mistake a folder for a file.
//
//  FOLDER TARGETS AND STORES (H3-12). Into an S3-compatible store the
//  folder is a key prefix, `<prefix>/<name>-package/`, written by the same
//  two job types: the agent picks a folder name no object uses yet (so a
//  taken name gets -2 for the whole folder), writes every object with
//  `If-None-Match: *` and removes what it wrote if the package does not
//  finish or read back whole (volt-agent/src/siteArchive.ts). The cloud's
//  side is the same for both: one job, one copy, judged by judgeFolder.
// ============================================================================
import { existsSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { one, query } from '../../db';
import { config } from '../../config';
import { REPACK_DIR } from '../fast/vodStore';
import { enqueue, sitePool } from '../jobs/queue';
import { ARCHIVE_COPY_FOLDER, ownedTarget, targetForAgent } from './archive';
import { baseNameFor, clipBaseName, isClipAsset, ownedAsset } from './sidecars';
import { sha256File } from './recordings';
import { nameValue } from './naming';
import { cleanPackagePath, packageLayout, packageManifest, type PackageFile } from './packageManifest';

export const PACKAGE_WHAT = 'package';
/** A package bigger than this many files is refused: one job lists them all. */
export const MAX_PACKAGE_FILES = 20_000;

const code = (message: string, c: string) => Object.assign(new Error(message), { code: c });

/** Files and folders of an asset's packaged folder that are not the package. */
const SKIP_TOP = new Set(['ladders', 'reframe']);
const skipName = (name: string, top: boolean) =>
  name.startsWith('.') || name.includes('.part-') || (top && (name === 'encode-job.json' || name === 'file.mp4' || SKIP_TOP.has(name)));

/**
 * Where an asset's package is, relative to the clips folder (the encode's
 * `/vod/<id>`, or a clip's `/<id>/<folder>`), from its master playlist.
 * The folder must be the asset's own: a master pointing anywhere else
 * gives no package. Pure.
 */
export function packageRootOf(a: { id: string; master_key?: string | null }): string | null {
  const k = String(a?.master_key ?? '');
  let rel: string | null = null;
  if (k.startsWith('/clips/')) rel = k.slice('/clips'.length);
  else if (/^vod\/[0-9a-f-]{36}\/[^/]/i.test(k)) rel = `/${k}`;
  if (!rel || !/\.(m3u8|mpd)$/i.test(rel)) return null;
  const dir = posix.dirname(posix.normalize(rel));
  if (dir.split('/').some((s) => s === '..')) return null;
  const parts = dir.split('/').filter(Boolean);
  const id = String(a.id).toLowerCase();
  // An encode's own folder, or the folder a repackage moved it into (P4-4).
  const own = (parts[0] === 'vod' && parts[1]?.toLowerCase() === id && (parts.length === 2 || (parts.length === 3 && REPACK_DIR.test(parts[2]))))
    || (parts[0]?.toLowerCase() === id && parts.length >= 2);
  return own ? dir : null;
}

export interface PackagePlanFile extends PackageFile { uri: string }
export interface PackagePlan { root: string; local: boolean; files: PackagePlanFile[] }

async function walkLocal(dir: string, rel = '', top = true, out: PackagePlanFile[] = []): Promise<PackagePlanFile[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (skipName(e.name, top)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkLocal(p, r, false, out);
    else if (e.isFile()) out.push({ path: r, bytes: (await stat(p)).size, uri: p });
    if (out.length > MAX_PACKAGE_FILES) break;
  }
  return out;
}

/** Lists a bucket prefix: key and size. Replaceable for the check suites. */
export type BucketLister = (bucket: string, prefix: string) => Promise<{ key: string; bytes: number }[]>;
let lister: BucketLister = async (bucket, prefix) => {
  const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const c = new S3Client({ region: config.aws.region, endpoint: process.env.AWS_ENDPOINT_URL || undefined, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' });
  const out: { key: string; bytes: number }[] = [];
  let token: string | undefined;
  do {
    const r: any = await c.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, bytes: Number(o.Size ?? 0) });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token && out.length <= MAX_PACKAGE_FILES);
  return out;
};
export function setBucketLister(l: BucketLister) { lister = l; }

/** Whether this deployment keeps packages in the origin bucket (services/fast/vodStore.ts, clipsStore). */
async function bucketHolds(): Promise<boolean> {
  const { vodStore } = await import('../fast/vodStore');
  return vodStore() === 's3' || config.mediaStore.driver === 's3';
}

/**
 * The files of an asset's package: from this server's disk while the folder
 * is here, otherwise (an S3 deployment, where another task made it) from the
 * origin bucket, each file then fetched through its own presigned URL.
 * Null when the asset has no package (not encoded yet, or a single file only).
 */
export async function planPackage(a: { id: string; master_key?: string | null }): Promise<PackagePlan | null> {
  const root = packageRootOf(a);
  if (!root) return null;
  const local = join(config.clips.dir, root);
  let files: PackagePlanFile[] = [];
  let isLocal = false;
  if (existsSync(local) && statSync(local).isDirectory()) {
    files = await walkLocal(local);
    isLocal = true;
  } else if (await bucketHolds()) {
    const prefix = root.startsWith('/vod/') ? `${root.slice(1)}/` : `clips${root}/`;
    const bucket = config.aws.s3Bucket;
    for (const o of await lister(bucket, prefix)) {
      const rel = o.key.slice(prefix.length);
      const parts = rel.split('/');
      if (!rel || parts.some((p, i) => skipName(p, i === 0))) continue;
      files.push({ path: rel, bytes: o.bytes, uri: `s3://${bucket}/${o.key}` });
    }
  }
  files = files.filter((f) => cleanPackagePath(f.path) !== null);
  if (!files.some((f) => /\.(m3u8|mpd)$/i.test(f.path))) return null;
  if (files.length > MAX_PACKAGE_FILES) throw code(`This package has more than ${MAX_PACKAGE_FILES} files`, 'package_too_big');
  files.sort((x, y) => (x.path < y.path ? -1 : 1));
  return { root, local: isLocal, files };
}

/** `<name>-package`: the original's or the clip's name, no dots, so `-2` lands at the end. */
export async function packageFolderName(a: any): Promise<string> {
  const base = isClipAsset(a) ? await clipBaseName(a) : baseNameFor(a);
  return `${nameValue(base).replace(/\./g, '_') || 'asset'}-package`;
}

/**
 * Copy an asset's package to one target, as one folder. One copy per target:
 * one verified or on its way is left alone; one that failed, changed or went
 * missing is copied afresh. Throws (with a code) when there is no package or
 * the target cannot take a folder; copyOnRule turns that into a skip.
 */
export async function requestPackageCopy(accountId: string, targetId: string, assetId: string, opts: { runAfter?: Date | null; userId?: string | null } = {}) {
  const t = await ownedTarget(accountId, targetId);
  if (t.status !== 'active') throw code('This storage target is disabled', 'target_disabled');
  if (t.site_status !== 'active') throw code('The site of this storage target is disabled', 'site_disabled');
  // Folder targets and S3-compatible stores (H3-12); any other kind a later
  // release adds has to say how a folder lands there first.
  if (t.kind !== 'path' && t.kind !== 's3') throw code('Packages are copied to folder targets and S3-compatible stores only', 'package_needs_folder_target');
  const a = await ownedAsset(accountId, assetId);
  if (!a) throw code('asset not found', 'not_found');

  const existing = await one<any>(
    `SELECT c.id, c.state, j.state AS job_state FROM archive_copies c LEFT JOIN jobs j ON j.id = c.job_id
      WHERE c.target_id = $1 AND c.vod_asset_id = $2 AND c.what = $3`, [t.id, a.id, PACKAGE_WHAT]);
  if (existing && (existing.state === 'verified' || (existing.state === 'queued' && ['queued', 'running'].includes(existing.job_state)))) {
    return { queued: [] as string[], kept: [existing.id as string] };
  }
  const plan = await planPackage(a);
  if (!plan) throw code('This asset has no HLS or DASH package yet', 'no_package');

  // Every file's checksum when the package is on this disk: the copy then
  // counts only when every byte matches. From the bucket the cloud knows
  // names and sizes only; the agent's own download and read-back must agree.
  if (plan.local) for (const f of plan.files) f.sha256 = await sha256File(f.uri);
  const folder = await packageFolderName(a);
  const manifest = plan.local ? packageManifest(plan.files) : null;
  const layout = packageLayout(plan.files);
  const sourceUri = plan.local ? join(config.clips.dir, plan.root) : `s3://${config.aws.s3Bucket}/${plan.root.startsWith('/vod/') ? plan.root.slice(1) : `clips${plan.root}`}/`;

  const row = await one<any>(
    `INSERT INTO archive_copies (account_id, target_id, vod_asset_id, what, source_uri, file_name, expected_sha256, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT id FROM users WHERE id = $8))
     ON CONFLICT (target_id, vod_asset_id, what) DO UPDATE
       SET source_uri = EXCLUDED.source_uri, file_name = EXCLUDED.file_name, expected_sha256 = EXCLUDED.expected_sha256,
           state = 'queued', stored_path = NULL, sha256 = NULL, bytes = NULL, error = NULL, error_code = NULL,
           copied_at = NULL, verified_at = NULL, checked_at = NULL, verify_job_id = NULL, updated_at = now()
     RETURNING id`,
    [accountId, t.id, a.id, PACKAGE_WHAT, sourceUri, folder, manifest, opts.userId ?? null]);

  const total = plan.files.reduce((s, f) => s + f.bytes, 0);
  const job = await enqueue({
    type: ARCHIVE_COPY_FOLDER, pool: sitePool(t.site_id), createdBy: opts.userId ?? null, maxAttempts: 5,
    runAfter: opts.runAfter ?? undefined,
    payload: {
      copyId: row.id, folder, target: targetForAgent(t),
      // The list the agent writes and reads back, and the re-checks read
      // again later (requestVerify takes it from this job).
      files: plan.files.map((f, i) => ({ path: f.path, transfer: `f${i}`, bytes: f.bytes, sha256: f.sha256 ?? null })),
      bytes: total, layoutSha256: layout,
      transfers: plan.files.map((f, i) => ({ name: `f${i}`, direction: 'download', uri: f.uri, bytes: f.bytes, sha256: f.sha256 ?? null })),
    },
  });
  await query(`UPDATE archive_copies SET job_id = $2 WHERE id = $1`, [row.id, job.id]);
  return { queued: [row.id as string], kept: [] as string[] };
}

/** The files a package copy wrote, from the job that made it (for re-checks). */
export async function packageFilesOf(copy: { job_id?: string | null }): Promise<{ path: string; bytes: number; sha256: string | null }[] | null> {
  if (!copy?.job_id) return null;
  const j = await one<any>(`SELECT payload->'files' AS files FROM jobs WHERE id = $1`, [copy.job_id]);
  return Array.isArray(j?.files) ? j.files.map((f: any) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 ?? null })) : null;
}
