// ============================================================================
//  WHERE FAST READS AND WRITES, local or production.
//
//  Two deployments, one code path:
//
//    local       library media under the control plane's clips dir
//                (master_key '/clips/vod/<id>/master.m3u8'); channel playlists
//                in ORIGIN_DIR/<channel>/fast/, served at /origin/<channel>/fast/.
//    production  library media in the origin bucket (master_key
//                'vod/<id>/master.m3u8', see vodStore.ts); channel playlists in
//                the same bucket at channel/<channel>/fast/; viewers fetch both
//                from CloudFront. The playout runs as an ECS task.
//
//  `output` decides which, from FAST_OUTPUT, else from the launcher (ECS means
//  production). Segment URLs in the playlists are absolute on the CDN in
//  production, so the same playlist works from the CDN and from the per-viewer
//  stitcher, which is served by the API on another host.
// ============================================================================
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../config';

export const fastConfig = {
  get output(): 'local' | 's3' {
    const v = process.env.FAST_OUTPUT;
    if (v === 'local' || v === 's3') return v;
    return config.orchestrator.launcher === 'ecs' ? 's3' : 'local';
  },
  get taskDef(): string { return process.env.FAST_TASK_DEF ?? 'volt-fast'; },
  /**
   * The CDN, when this deployment has a real one: in production, or wherever
   * the playout writes to the bucket (its playlists are only reachable there).
   */
  get cdn(): string | null {
    const c = config.aws?.cdnBaseUrl;
    return c && (config.env === 'production' || this.output === 's3') && !/example\.com/.test(c) ? c.replace(/\/$/, '') : null;
  },
  /** No heartbeat for this long and a playout is not trusted. */
  staleSec: Number(process.env.FAST_STALE_SEC ?? 30),
};

/** Where a channel's playlists live, as a key (S3) and as a URL path (local). */
export const channelPrefix = (channelId: string) => `channel/${channelId}/fast`;

/** The public URL of one of a channel's playlists. */
export function channelPlaylistUrl(channelId: string, file: string): string {
  if (fastConfig.output === 's3' && fastConfig.cdn) return `${fastConfig.cdn}/${channelPrefix(channelId)}/${file}`;
  return `/origin/${channelId}/fast/${file}`;
}

let s3: any = null;
async function client() {
  if (!s3) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    s3 = new S3Client({ region: config.aws.region, endpoint: process.env.AWS_ENDPOINT_URL || undefined, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' });
  }
  return s3;
}

async function getObject(key: string): Promise<string> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const r = await (await client()).send(new GetObjectCommand({ Bucket: config.aws.s3Bucket, Key: key }));
  return await (r.Body as any).transformToString();
}

/**
 * Read a library or channel text object by key: '/clips/...' from the local
 * clips dir, anything else from the origin bucket.
 */
export async function readKey(key: string): Promise<string> {
  if (key.startsWith('/clips/')) return readFile(join(config.clips.dir, key.slice('/clips'.length)), 'utf8');
  return getObject(key.replace(/^\//, ''));
}

/** A channel playlist as the playout last wrote it. */
export async function readChannelPlaylist(channelId: string, file: string): Promise<string | null> {
  try {
    if (fastConfig.output === 's3') return await getObject(`${channelPrefix(channelId)}/${file}`);
    return await readFile(join(config.testStream.originDir, channelId, 'fast', file), 'utf8');
  } catch { return null; }
}

/** The URL base for an asset's segments (folder of its master), as the playout writes them. */
export function assetUrlBase(masterKey: string): string {
  const folder = '/' + masterKey.replace(/^\//, '').replace(/\/[^/]+$/, '');
  const prefix = !masterKey.startsWith('/clips/') && fastConfig.cdn ? fastConfig.cdn : '';
  return `${prefix}${folder}/`;
}
