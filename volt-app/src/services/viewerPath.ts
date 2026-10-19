/**
 * THE VIEWER PATH'S LOOKUPS, CACHED.
 *
 * Everything a viewer start reads that is CONFIGURATION rather than per-viewer
 * state lives here, behind scale/cache.ts. Before this a start made 6 to 20
 * database round trips; with a warm cache an anonymous start makes none and a
 * signed-in viewer makes at most one (their identity, every 15 minutes).
 *
 * Each function returns exactly what the query it replaces returned, so the
 * callers' logic is unchanged. Tags match the triggers in migration 0046:
 *
 *   keyhash:<sha>  key:<id>  acct:<id>  app:<id>  asset:<id>  rules:<acct>
 *   profile:<id>   viewer:<id>
 */
import { one } from '../db';
import { cached } from '../scale/cache';
import { scaleConfig } from '../scale/config';

const C = () => scaleConfig.cache;

// ---- keys and apps ------------------------------------------------------------

export interface KeyLookupRow {
  id: string; account_id: string; app_id: string | null;
  kind: 'secret' | 'publishable'; scopes: string[]; enabled: boolean;
}

/** api_keys row for a key hash, only if enabled and its account is not suspended. */
export function keyByHash(hash: string): Promise<KeyLookupRow | null> {
  return cached<KeyLookupRow | null>(
    `key:${hash}`,
    {
      ttlSec: C().keyTtlSec,
      tags: (r) => r ? [`keyhash:${hash}`, `key:${r.id}`, `acct:${r.account_id}`] : [`keyhash:${hash}`],
      l2: true,
    },
    () => one<KeyLookupRow>(
      `SELECT k.id, k.account_id, k.app_id, k.kind, k.scopes, k.enabled
         FROM api_keys k JOIN accounts a ON a.id = k.account_id
        WHERE k.key_hash=$1 AND k.enabled=true AND COALESCE(a.status,'active') <> 'suspended'`,
      [hash]
    )
  );
}

export interface AppLookupRow {
  id: string; type: 'web' | 'ios' | 'android' | 'tv' | 'roku' | 'server';
  restrictions: any; enabled: boolean;
}

export function appById(id: string | null | undefined): Promise<AppLookupRow | null> {
  if (!id) return Promise.resolve(null);
  return cached<AppLookupRow | null>(
    `app:${id}`,
    { ttlSec: C().keyTtlSec, tags: [`app:${id}`], l2: true },
    () => one<AppLookupRow>(`SELECT id, type, restrictions, enabled FROM apps WHERE id=$1`, [id])
  );
}

// ---- assets -------------------------------------------------------------------

/** Which kind of asset this account owns under this id, or null (not theirs / none). */
export function assetKindFor(acct: string, assetId: string): Promise<'channel' | 'event' | 'vod' | null> {
  return cached<'channel' | 'event' | 'vod' | null>(
    `assetkind:${acct}:${assetId}`,
    { ttlSec: C().assetTtlSec, tags: [`asset:${assetId}`, `acct:${acct}`], l2: true },
    async () => {
      const row = await one<any>(
        `SELECT 'channel' AS kind
           FROM channels c JOIN groups g ON g.id = c.group_id
          WHERE c.id = $1 AND g.account_id = $2
          UNION ALL
         SELECT 'event' FROM events e JOIN groups g2 ON g2.id = e.group_id
          WHERE e.id = $1 AND g2.account_id = $2
          UNION ALL
         SELECT 'vod' FROM vod_assets v
           LEFT JOIN channels c2 ON c2.id = v.channel_id
           LEFT JOIN events   e2 ON e2.id = v.event_id
           LEFT JOIN groups g3 ON g3.id = COALESCE(c2.group_id, e2.group_id)
          WHERE v.id = $1 AND COALESCE(g3.account_id, v.account_id) = $2
          LIMIT 1`,
        [assetId, acct]
      );
      return (row?.kind as any) ?? null;
    }
  );
}

/** The vod_assets availability columns onDemandAccess reads. */
export function vodAvailabilityRow(assetId: string): Promise<any | null> {
  return cached<any | null>(
    `vodavail:${assetId}`,
    { ttlSec: C().rulesTtlSec, tags: [`asset:${assetId}`] },
    () => one<any>(
      `SELECT availability_state, availability, availability_sources, available_from, available_until, published, schema_id, channel_id, event_id
         FROM vod_assets WHERE id = $1`, [assetId])
  );
}

/** A live owner (channel or event) by id, with its metadata schema. */
export function liveOwner(assetId: string): Promise<{ id: string; schema_id: string | null; kind: 'channel' | 'event'; geo_mode?: string | null; geo_countries?: string[] | null } | null> {
  return cached(
    `owner:${assetId}`,
    { ttlSec: C().assetTtlSec, tags: [`asset:${assetId}`] },
    () => one<any>(
      `SELECT c.id, c.schema_id, 'channel' AS kind, c.geo_mode, c.geo_countries FROM channels c WHERE c.id = $1
       UNION ALL SELECT e.id, e.schema_id, 'event', NULL, NULL FROM events e WHERE e.id = $1`, [assetId])
  );
}

/**
 * The publishing-rules ladder for a live owner. Wraps resolveForAsset, which is
 * passed in to keep this module free of an import cycle.
 */
export function cachedPlan<T>(accountId: string, owner: { id: string; schema_id: string | null; kind: string },
  resolve: () => Promise<T>): Promise<T> {
  return cached<T>(
    `plan:${accountId}:${owner.schema_id ?? '-'}:${owner.id}`,
    { ttlSec: C().rulesTtlSec, tags: [`rules:${accountId}`, `asset:${owner.id}`] },
    resolve
  );
}

export interface ProgrammeRights {
  geo_mode: string; geo_countries: string[] | null; replacement_asset_id: string | null;
}

/**
 * The programme on air NOW on a channel, for the blackout check.
 *
 * Kept until the earliest of: its own end, the next programme's start, or
 * CACHE_PROGRAMME_TTL_SEC. A programme boundary therefore takes effect on
 * time without anyone invalidating anything, and an EPG edit invalidates at
 * once through the asset tag.
 */
export function currentProgramme(channelId: string): Promise<ProgrammeRights | null> {
  return currentProgrammeWindow(channelId).then((v) => v.cur);
}

/** As currentProgramme, plus `until`: the epoch ms after which the answer may change. */
export function currentProgrammeWindow(channelId: string): Promise<{ cur: ProgrammeRights | null; until: number }> {
  return cached<{ cur: ProgrammeRights | null; ttl: number; until: number }>(
    `prog:${channelId}`,
    { ttlSec: (v) => v.ttl, tags: [`asset:${channelId}`] },
    async () => {
      const r = await one<any>(
        `SELECT p.geo_mode, p.geo_countries, p.replacement_asset_id, p.ends_at,
                (SELECT min(n.starts_at) FROM programmes n WHERE n.channel_id = $1 AND n.starts_at > now()) AS next_start,
                now() AS db_now
           FROM (SELECT 1) x
           LEFT JOIN LATERAL (
             SELECT geo_mode, geo_countries, replacement_asset_id, ends_at
               FROM programmes WHERE channel_id=$1 AND span @> now()
              ORDER BY starts_at DESC LIMIT 1) p ON true`,
        [channelId]
      );
      const now = r?.db_now ? new Date(r.db_now).getTime() : Date.now();
      let ttl = C().programmeTtlSec;
      for (const t of [r?.ends_at, r?.next_start]) {
        if (t) ttl = Math.min(ttl, (new Date(t).getTime() - now) / 1000);
      }
      const cur = r && r.geo_mode != null
        ? { geo_mode: r.geo_mode, geo_countries: r.geo_countries, replacement_asset_id: r.replacement_asset_id }
        : null;
      const t = Math.max(0, ttl);
      return { cur, ttl: t, until: Date.now() + t * 1000 };
    }
  );
}

// ---- delivery -----------------------------------------------------------------

export interface ChannelDelivery {
  id: string; status: string; on_air: boolean; kind: string; name: string;
  input_failover_enabled: boolean | null; input_loss_behavior: string | null;
  captions_enabled: boolean | null; output_profile_id: string | null;
}

/** What the public delivery gate needs about a channel. On-air changes invalidate at once. */
export function channelDelivery(channelId: string): Promise<ChannelDelivery | null> {
  return cached<ChannelDelivery | null>(
    `chdel:${channelId}`,
    {
      ttlSec: C().rulesTtlSec,
      tags: (r) => r?.output_profile_id ? [`asset:${channelId}`, `profile:${r.output_profile_id}`] : [`asset:${channelId}`],
    },
    () => one<ChannelDelivery>(
      `SELECT c.id, c.status, c.on_air, c.kind, c.name, c.input_failover_enabled, c.input_loss_behavior,
              p.captions_enabled, g.output_profile_id
         FROM channels c JOIN groups g ON g.id = c.group_id
         LEFT JOIN output_profiles p ON p.id = g.output_profile_id
        WHERE c.id = $1`, [channelId])
  );
}

/**
 * Is a channel's output advancing, judged from the encoder's status reports.
 *
 * This is the ground truth when the API cannot see the origin directory, which
 * is every cloud deployment: the encoder writes to S3 and the API runs on
 * another machine. The encoder reports every few seconds; a report older than
 * 30 s, or one saying the output stopped, is not live. Cached for 2 s.
 */
export function reportedOutputLive(channelId: string): Promise<boolean> {
  return cached<boolean>(
    `outlive:${channelId}`,
    { ttlSec: 2, tags: [] },
    async () => {
      const r = await one<any>(
        `SELECT output_available AND updated_at > now() - interval '30 seconds' AS live
           FROM stream_status WHERE channel_id = $1`, [channelId]);
      return !!r?.live;
    }
  );
}

// ---- viewers --------------------------------------------------------------------

/**
 * Find-or-create the viewer, writing at most once per CACHE_VIEWER_TOUCH_SEC.
 *
 * upsertViewer wrote on every start. A viewer whose email and groups are
 * unchanged since the last write is answered from the cache; a changed email
 * or group list writes immediately, so membership changes still apply at once.
 */
export function touchViewer(accountId: string, externalId: string, opts: { email?: string | null; groups?: string[] },
  upsert: () => Promise<any>): Promise<any> {
  const sig = `${opts.email ?? ''}|${opts.groups ? [...opts.groups].sort().join(',') : '~'}`;
  return cached<any>(
    `viewer:${accountId}:${externalId}:${sig}`,
    { ttlSec: C().viewerTouchSec, tags: (v) => v?.id ? [`viewer:${v.id}`, `acct:${accountId}`] : [`acct:${accountId}`] },
    upsert
  );
}

export function cachedEntitlements<T>(viewerId: string, load: () => Promise<T>): Promise<T> {
  return cached<T>(`ent:${viewerId}`, { ttlSec: C().entitlementTtlSec, tags: [`viewer:${viewerId}`] }, load);
}
