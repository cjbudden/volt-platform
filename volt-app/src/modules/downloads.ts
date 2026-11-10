// ============================================================================
//  DOWNLOADS: the asset's files, for people whose role allows it.
//
//  Downloading is its own permission ("Downloads" in Roles & access), not part
//  of the Media Library: plenty of people need to see, describe and publish an
//  item without being allowed to take a copy of it away. Owners and admins
//  have it; any other role has it only when an admin grants it.
//
//    GET  /api/downloads/vod/:id          the files there are   (Downloads: view)
//    POST /api/downloads/vod/:id/link     a link for one file   (Downloads: operate)
//         { format: 'mp4' | 'mp3' | 'm4a' } -> { url, filename, expiresAt }
//    GET  /api/downloads/file?t=<token>   the file itself       (the token is the access)
//
//  THE TITLE'S RULE (Distribution, build queue P3-4b): when its publishing
//  rule says MP4 download is off (Premium and Rights-managed do, and DRM
//  forces it), the MP4 is not handed out here either: a clear MP4 of a title
//  the rule protects is the copy the rule exists to stop. The audio files are
//  not the MP4 and are not affected. The list says why the MP4 is missing.
//
//  WHY A LINK AND NOT THE FILE. A browser downloads a big file by navigating
//  to it, and a navigation cannot carry the console's bearer token. So the
//  authorised POST mints a five-minute, single-file token, and the file route
//  trusts only that. Every link minted is in the audit log: who took which file.
// ============================================================================
import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { z } from 'zod';
import { one } from '../db';
import { config } from '../config';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, badRequest, notFound, ApiError } from '../util/http';
import { writeAudit, actor } from '../services/audit';
import { isEncodeBucketKey, readThroughKey, openObject, objectSize } from '../services/media/clipsStore';
import { deliveryPolicyFor } from '../services/deliveryPolicy';

const MP4_OFF = "This title's publishing rule does not allow MP4 download. Change MP4 download under Distribution in its rule to take a copy.";

const AUD = 'volt-download';
const TTL_SEC = 300;
const UUID = /^[0-9a-f-]{36}$/i;

type Format = 'mp4' | 'mp3' | 'm4a';
const FILES: { format: Format; col: string; label: string; ext: string; mime: string }[] = [
  { format: 'mp4', col: 'progressive_key', label: 'MP4 (video and sound)', ext: 'mp4', mime: 'video/mp4' },
  { format: 'mp3', col: 'export_mp3_key', label: 'MP3 (sound)', ext: 'mp3', mime: 'audio/mpeg' },
  { format: 'm4a', col: 'export_m4a_key', label: 'AAC .m4a (sound, as broadcast)', ext: 'm4a', mime: 'audio/mp4' },
];

async function ownedAsset(id: string, acct: string) {
  if (!UUID.test(id)) return null;
  return one<any>(`
    SELECT v.id, v.title, v.progressive_key, v.export_mp3_key, v.export_m4a_key
      FROM vod_assets v
      LEFT JOIN channels c ON c.id = v.channel_id
      LEFT JOIN events e ON e.id = v.event_id
      LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
     WHERE v.id = $1 AND COALESCE(g.account_id, v.account_id) = $2`, [id, acct]);
}

/** A file name a person would keep: the title, made safe, and the format. */
export function downloadName(title: string | null | undefined, ext: string): string {
  const base = String(title || 'download').normalize('NFKD').replace(/[^\w\s.-]+/g, '').trim().replace(/\s+/g, ' ').slice(0, 120) || 'download';
  return `${base}.${ext}`;
}

/**
 * Where a stored key's bytes are: a local clips file (with its path under
 * /clips, for the bucket copy), an encode's bucket key, an absolute URL, or
 * nowhere. On an S3 deployment an encode's MP4 is stored as its bucket key
 * (vod/<id>/<file>, services/jobs/handlers/vodEncode.ts), which this did not
 * know, so every encode download on AWS answered "no longer here".
 */
export function locate(key: string | null | undefined): { file?: string; rel?: string; bucketKey?: string; url?: string } | null {
  if (!key) return null;
  if (/^https?:\/\//i.test(key)) return { url: key };
  if (isEncodeBucketKey(key)) return { bucketKey: key };
  const m = /^\/?clips\/(.+)$/.exec(key);
  if (!m) return null;
  const root = normalize(config.clips.dir);
  const file = normalize(join(root, m[1]));
  if (!file.startsWith(root)) return null;          // never climb out of the clips dir
  return { file, rel: '/' + m[1] };
}

/**
 * Where to read the bytes from on THIS task: its own disk when the file is
 * there, otherwise the bucket copy the job made (services/media/clipsStore.ts),
 * so a clip cut or an encode run on another task downloads from any task.
 */
export async function resolveBytes(key: string | null | undefined): Promise<{ file?: string; bucketKey?: string; url?: string } | null> {
  const l = locate(key);
  if (!l) return null;
  if (l.url) return { url: l.url };
  if (l.bucketKey) return { bucketKey: l.bucketKey };
  if (l.file && existsSync(l.file)) return { file: l.file };
  const k = l.rel ? await readThroughKey(l.rel) : null;
  return k ? { bucketKey: k } : null;
}

async function sizeOf(key: string | null | undefined): Promise<number | null> {
  const w = await resolveBytes(key).catch(() => null);
  if (w?.file) { try { return statSync(w.file).size; } catch { return null; } }
  if (w?.bucketKey) return objectSize(w.bucketKey).catch(() => null);
  return null;
}

// ---- the file itself: no session, the token is the access -----------------
export const downloadFileRouter = Router();
downloadFileRouter.get('/file', asyncHandler(async (req: Request, res: Response) => {
  let claims: any;
  try { claims = jwt.verify(String(req.query.t ?? ''), config.jwt.accessSecret, { audience: AUD }); }
  catch { res.status(403).json({ error: 'This download link has expired or is not valid. Ask for a new one.' }); return; }
  const a = await ownedAsset(String(claims.a), String(claims.acct));
  const spec = FILES.find((f) => f.format === claims.f);
  if (!a || !spec) throw notFound('That file is no longer here');
  const where = await resolveBytes(a[spec.col]);
  const name = downloadName(a.title, spec.ext);
  res.setHeader('Cache-Control', 'private, no-store');
  if (where?.url) { res.redirect(302, where.url); return; }
  if (where?.bucketKey) {
    // Streamed through the task rather than redirected to the CDN: the CDN
    // cannot name the file, and a download is rare next to playback.
    const o = await openObject(where.bucketKey);
    if (!o) throw notFound('That file is no longer here');
    res.attachment(name);
    res.setHeader('Content-Type', spec.mime);
    if (o.length != null) res.setHeader('Content-Length', String(o.length));
    o.body.on('error', () => res.destroy());
    o.body.pipe(res);
    return;
  }
  if (!where?.file) throw notFound('That file is no longer here');
  res.download(where.file, name, { headers: { 'Content-Type': spec.mime } });
}));

// ---- the authorised part -----------------------------------------------------
export const downloadsRouter = Router();
downloadsRouter.use(requireAuth);

downloadsRouter.get('/vod/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const a = await ownedAsset(String(req.params.id), acct);
  if (!a) throw notFound('VOD asset not found');
  const mp4 = a.progressive_key ? (await deliveryPolicyFor(a.id, acct))?.mp4Download !== false : true;
  res.json({
    files: await Promise.all(FILES.filter((f) => a[f.col]).map(async (f) => ({
      format: f.format, label: f.label, filename: downloadName(a.title, f.ext), bytes: await sizeOf(a[f.col]),
      ...(f.format === 'mp4' && !mp4 ? { allowed: false, reason: MP4_OFF } : {}),
    }))),
  });
}));

const linkSchema = z.object({ format: z.enum(['mp4', 'mp3', 'm4a']) });
downloadsRouter.post('/vod/:id/link', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const a = await ownedAsset(String(req.params.id), acct);
  if (!a) throw notFound('VOD asset not found');
  const { format } = linkSchema.parse(req.body ?? {});
  const spec = FILES.find((f) => f.format === format)!;
  if (!a[spec.col]) throw badRequest(`There is no ${format.toUpperCase()} file for this item. Ask for one on the Encode tab.`);
  if (format === 'mp4' && (await deliveryPolicyFor(a.id, acct))?.mp4Download === false)
    throw Object.assign(new ApiError(403, MP4_OFF), { code: 'mp4_off' });
  const t = jwt.sign({ a: a.id, f: format, acct }, config.jwt.accessSecret, { audience: AUD, expiresIn: TTL_SEC });
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'download', entityType: 'vod_asset', entityId: a.id,
    changes: { download: { from: null, to: { format, file: downloadName(a.title, spec.ext) } } } });
  res.json({ url: `/api/downloads/file?t=${encodeURIComponent(t)}`, filename: downloadName(a.title, spec.ext), expiresAt: new Date(Date.now() + TTL_SEC * 1000).toISOString() });
}));
