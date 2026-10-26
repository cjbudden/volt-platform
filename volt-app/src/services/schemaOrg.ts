import { config } from '../config';

/**
 * schema.org representations of Volt resources — the interoperable standard for
 * the public API, the portal's JSON-LD (SEO), and social-platform metadata.
 *
 * A VOD asset  -> https://schema.org/VideoObject (a Clip is a VideoObject with
 *                 start/end offsets), with associatedMedia MediaObjects for the
 *                 HLS/DASH/progressive renditions, thumbnails as ImageObject,
 *                 publications as PublicationEvent/BroadcastEvent, and view
 *                 counts as an InteractionCounter(WatchAction).
 * A live channel/event -> VideoObject with publication BroadcastEvent and
 *                 isLiveBroadcast=true.
 */

const cdn = (key?: string | null) =>
  key ? `${config.aws.cdnBaseUrl.replace(/\/$/, '')}/${key.replace(/^\//, '')}` : undefined;

/** milliseconds -> ISO-8601 duration, e.g. PT1H2M3S */
export function isoDuration(ms?: number | null): string | undefined {
  if (!ms || ms < 0) return undefined;
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `PT${h ? h + 'H' : ''}${m ? m + 'M' : ''}${sec || (!h && !m) ? sec + 'S' : ''}`;
}

function imageObject(key?: string | null) {
  const url = cdn(key);
  return url ? { '@type': 'ImageObject', contentUrl: url, url } : undefined;
}

const PLATFORM_TYPE: Record<string, string> = {
  portal: 'PublicationEvent',
  youtube: 'BroadcastEvent',
  facebook: 'BroadcastEvent',
  x: 'PublicationEvent',
  tiktok: 'PublicationEvent',
  dailymotion: 'BroadcastEvent',
  instagram: 'PublicationEvent',
};

export interface AssetForSchema {
  id: string;
  title?: string | null;
  kind: string;
  metadata?: Record<string, any> | null;
  duration_ms?: number | null;
  start_epoch_ms?: number | null;
  end_epoch_ms?: number | null;
  created_at?: string | Date | null;
  master_key?: string | null; // HLS master
  progressive_key?: string | null;
  poster_key?: string | null;
  thumbs_vtt_key?: string | null;
  formats?: { hls?: boolean; dash?: boolean; progressive?: boolean } | null;
  portal_visible?: boolean;
}
export interface PublicationForSchema {
  platform: string;
  external_url?: string | null;
  views?: number;
  published_at?: string | Date | null;
  status?: string;
}

/** Build a schema.org VideoObject (JSON-LD) for a VOD asset. */
export function videoObjectFromAsset(a: AssetForSchema, pubs: PublicationForSchema[] = []): Record<string, any> {
  const md = a.metadata ?? {};
  const associatedMedia: any[] = [];
  if (a.formats?.hls !== false && a.master_key)
    associatedMedia.push({ '@type': 'MediaObject', encodingFormat: 'application/vnd.apple.mpegurl', contentUrl: cdn(a.master_key) });
  if (a.formats?.dash && a.master_key)
    associatedMedia.push({ '@type': 'MediaObject', encodingFormat: 'application/dash+xml', contentUrl: cdn(a.master_key.replace(/master\.m3u8$/, 'manifest.mpd')) });
  if (a.formats?.progressive && a.progressive_key)
    associatedMedia.push({ '@type': 'MediaObject', encodingFormat: 'video/mp4', contentUrl: cdn(a.progressive_key) });

  const totalViews = pubs.reduce((n, p) => n + (p.views ?? 0), 0);
  const portalUrl = `${config.aws.cdnBaseUrl.replace(/\/$/, '')}/portal/watch/${a.id}`;

  const obj: Record<string, any> = {
    '@context': 'https://schema.org',
    '@type': a.kind === 'clip' ? 'Clip' : 'VideoObject',
    '@id': `${config.internalApiBaseUrl}/api/vod/${a.id}`,
    name: a.title ?? md.title ?? 'Untitled',
    description: md.description ?? md.synopsis ?? undefined,
    uploadDate: a.created_at ? new Date(a.created_at).toISOString() : undefined,
    duration: isoDuration(a.duration_ms),
    thumbnail: imageObject(a.poster_key),
    thumbnailUrl: cdn(a.poster_key),
    contentUrl: a.formats?.progressive ? cdn(a.progressive_key) : undefined,
    embedUrl: portalUrl,
    isLiveBroadcast: false,
    genre: md.genre,
    keywords: Array.isArray(md.tags) ? md.tags.join(', ') : md.keywords,
    associatedMedia,
    isFamilyFriendly: md.rating ? undefined : undefined,
  };
  if (a.kind === 'clip' && a.start_epoch_ms != null && a.end_epoch_ms != null) {
    // Clip offsets are seconds from the parent recording start (approx here).
    obj.startOffset = Math.round((a.start_epoch_ms % 86_400_000) / 1000);
    obj.endOffset = obj.startOffset + Math.round((a.duration_ms ?? 0) / 1000);
  }
  if (pubs.length) {
    obj.publication = pubs
      .filter((p) => p.status === 'published')
      .map((p) => ({
        '@type': PLATFORM_TYPE[p.platform] ?? 'PublicationEvent',
        ...(p.external_url ? { url: p.external_url } : {}),
        publishedOn: { '@type': 'BroadcastService', name: p.platform },
        ...(p.published_at ? { startDate: new Date(p.published_at).toISOString() } : {}),
      }));
  }
  if (totalViews > 0) {
    obj.interactionStatistic = {
      '@type': 'InteractionCounter',
      interactionType: { '@type': 'WatchAction' },
      userInteractionCount: totalViews,
    };
  }
  obj.potentialAction = { '@type': 'WatchAction', target: portalUrl };
  // prune undefined
  return JSON.parse(JSON.stringify(obj));
}

/** VideoObject for a live channel/event (isLiveBroadcast + BroadcastEvent). */
export function liveVideoObject(owner: {
  id: string;
  name?: string | null;
  kind: 'channel' | 'event';
  master_key?: string | null;
  server_start?: string | Date | null;
  server_stop?: string | Date | null;
}): Record<string, any> {
  const url = `${config.aws.cdnBaseUrl.replace(/\/$/, '')}/${owner.kind}/${owner.id}/master.m3u8`;
  return JSON.parse(
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      '@id': `${config.internalApiBaseUrl}/api/${owner.kind}s/${owner.id}`,
      name: owner.name ?? owner.id,
      isLiveBroadcast: true,
      contentUrl: cdn(owner.master_key) ?? url,
      publication: {
        '@type': 'BroadcastEvent',
        isLiveBroadcast: true,
        ...(owner.server_start ? { startDate: new Date(owner.server_start).toISOString() } : {}),
        ...(owner.server_stop ? { endDate: new Date(owner.server_stop).toISOString() } : {}),
      },
    })
  );
}
