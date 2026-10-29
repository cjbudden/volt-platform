// ============================================================================
//  WHERE PACKAGED LIBRARY MEDIA LIVES.
//
//    local  the control plane's clips dir (/clips/vod/<id>/), served by the API.
//           Right for a laptop. Wrong for production: on Fargate that disk is
//           the task's own and goes with it, and a FAST playout on another
//           server cannot read it.
//    s3     the origin bucket, vod/<id>/, served by the CDN beside the live
//           channels. master_key becomes 'vod/<id>/master.m3u8' (a key, no
//           leading slash), which every consumer already resolves against the
//           CDN (services/shareLinks.ts manifestUrls).
//
//  VOD_STORE chooses; unset, ECS deployments use s3 and everything else local.
//  The local copy is kept after upload (the skip-marker annotator and clip
//  extraction read it while the task lives); the bucket is the record.
// ============================================================================
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { config } from '../../config';

export function vodStore(): 'local' | 's3' {
  const v = process.env.VOD_STORE;
  if (v === 'local' || v === 's3') return v;
  return config.orchestrator.launcher === 'ecs' ? 's3' : 'local';
}

const TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl', '.mpd': 'application/dash+xml', '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment', '.vtt': 'text/vtt', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json',
};

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'encode-job.json') continue; // .enc intermediates, the job file
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

let s3: any = null;
async function client() {
  if (!s3) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    s3 = new S3Client({ region: config.aws.region, endpoint: process.env.AWS_ENDPOINT_URL || undefined, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' });
  }
  return s3;
}

/**
 * Upload an asset's packaged folder to vod/<id>/. Segments and init segments
 * first, playlists last, so a playlist never lists a file that is not there.
 */
export async function uploadVodDir(dir: string, assetId: string, opts: { concurrency?: number; subdir?: string } = {}): Promise<{ master: string; mpd: string; files: number; bytes: number }> {
  // subdir: a FAST ladder variant (ladders/<group>/<seg>s), under the asset's own folder
  const base = `vod/${assetId}${opts.subdir ? `/${opts.subdir.replace(/^\/+|\/+$/g, '')}` : ''}`;
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const c = await client();
  const files = await walk(dir);
  const isList = (f: string) => /\.(m3u8|mpd)$/.test(f);
  const media = files.filter((f) => !isList(f)), lists = files.filter(isList);
  let bytes = 0;
  const put = async (f: string) => {
    const key = `${base}/${relative(dir, f).split('\\').join('/')}`;
    const body = await readFile(f);
    bytes += (await stat(f)).size;
    await c.send(new PutObjectCommand({
      Bucket: config.aws.s3Bucket, Key: key, Body: body,
      ContentType: TYPES[extname(f)] ?? 'application/octet-stream',
      // segments never change; playlists may be re-written by a re-encode
      CacheControl: isList(f) ? 'public, max-age=60' : 'public, max-age=31536000, immutable',
    }));
  };
  const n = Math.max(1, opts.concurrency ?? 8);
  for (let i = 0; i < media.length; i += n) await Promise.all(media.slice(i, i + n).map(put));
  for (const f of lists) await put(f);
  return { master: `${base}/master.m3u8`, mpd: `${base}/manifest.mpd`, files: files.length, bytes };
}
