/**
 * Share links: time-limited, standalone, single-resource preview grants.
 *
 * A creator (account admin) shares ONE asset (a VOD, a live channel, or an event)
 * with external recipients. They get a link to an isolated page that shows only
 * that asset: a watermarked preview player, its metadata, an optional note, and
 * (if allowed) a hi-res/metadata download. No login, no console, no other views.
 *
 * Security model:
 *   • The raw token is shown ONCE at creation; only its sha256 is stored (api_keys
 *     pattern). Lookup is by hash.
 *   • The resource must belong to the creator's account (checked at creation).
 *   • The public resolve path returns ONLY this resource, never accepts an admin
 *     credential, and enforces expiry / revoke / max-views / optional PIN. A leaked
 *     link therefore reaches exactly one asset and nothing else.
 *   • Geo/rights are evaluated the same as normal public playback.
 *
 * Pure token + policy helpers are unit-tested; DB paths are covered by the module
 * test against a live database.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { query, one, tx } from '../db';
import { config } from '../config';
import { liveDirFor, liveUrlBase } from './liveOrigin';
import { mintPlaybackToken } from './apiKeys';
import { evaluateAccess } from './rights';

/** Is a live channel/event's origin manifest advancing right now? (share preview
 *  availability: the link only shows content while the source is active and output
 *  is being created — NOT tied to on-air). */
function liveOutputFresh(resourceId: string): boolean {
  try {
    const dir = liveDirFor(resourceId);   // per-run namespace: probe the CURRENT run
    if (!existsSync(dir)) return false;
    let newest = 0;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.m3u8') || f.endsWith('.mpd')) {
        try { const m = statSync(join(dir, f)).mtimeMs; if (m > newest) newest = m; } catch { /* ignore */ }
      }
    }
    return newest > 0 && (Date.now() - newest) < 15000;
  } catch { return false; }
}

export type ShareResourceKind = 'vod' | 'channel' | 'event';
export type ShareAccessType = 'preview_only' | 'allow_download';

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Mint a raw share token. raw = shr_<base64url>; shown once, stored as hash. */
export function generateShareToken(): { raw: string; prefix: string; hash: string } {
  const raw = `shr_${randomBytes(24).toString('base64url')}`;
  return { raw, prefix: raw.slice(0, 12), hash: sha256(raw) };
}

export const ACCESS_PERIODS: Record<string, number> = {
  '1 day': 86400, '3 days': 3 * 86400, '7 days': 7 * 86400,
  '14 days': 14 * 86400, '30 days': 30 * 86400,
};

/** Reason codes a resolve can fail with (kept stable for the page + tests). */
export type ShareDenyReason = 'not_found' | 'revoked' | 'expired' | 'view_cap' | 'pin_required' | 'pin_wrong';

export interface ShareRow {
  id: string; account_id: string; resource_kind: ShareResourceKind; resource_id: string;
  message: string | null; recipients: string[];
  access_type: ShareAccessType; allow_hi_res: boolean; allow_player: boolean; allow_metadata: boolean;
  watermark: boolean; notify_on_open: boolean; pin_hash: string | null;
  expires_at: string; max_views: number | null; view_count: number; first_opened_at: string | null;
  revoked: boolean; created_by: string | null; created_at: string;
}

/** Pure policy check: is this share currently usable? (time passed in for testability) */
export function evaluateSharePolicy(row: Pick<ShareRow, 'revoked' | 'expires_at' | 'max_views' | 'view_count' | 'pin_hash'>, nowMs: number, pin?: string): { ok: true } | { ok: false; reason: ShareDenyReason } {
  if (row.revoked) return { ok: false, reason: 'revoked' };
  if (new Date(row.expires_at).getTime() <= nowMs) return { ok: false, reason: 'expired' };
  if (row.max_views != null && row.view_count >= row.max_views) return { ok: false, reason: 'view_cap' };
  if (row.pin_hash) {
    if (!pin) return { ok: false, reason: 'pin_required' };
    if (sha256(pin) !== row.pin_hash) return { ok: false, reason: 'pin_wrong' };
  }
  return { ok: true };
}

const cdn = () => config.aws.cdnBaseUrl.replace(/\/$/, '');

/** Manifest URLs for a resource. VOD uses its master_key; live uses kind/id. */
export function manifestUrls(kind: ShareResourceKind, resourceId: string, masterKey?: string, formats?: { hls?: boolean; dash?: boolean }) {
  if (kind === 'vod') {
    const base = `${cdn()}/${(masterKey ?? '').replace(/^\//, '')}`;
    return {
      hls: formats?.hls !== false ? `${base}/master.m3u8` : null,
      dash: formats?.dash ? `${base}/manifest.mpd` : null,
    };
  }
  // live channel/event: the packager writes to the origin. The SHARE preview plays
  // this directly, independent of on-air — same-origin locally, via the CDN in prod.
  const useCdn = config.env === 'production' && !/example\.com/.test(config.aws.cdnBaseUrl);
  // local: the STABLE /live/ url — it follows the current run across restarts, so a
  // share link created before a restart keeps playing after it.
  const base = useCdn ? `${cdn()}/${kind}/${resourceId}` : liveUrlBase(resourceId);
  return { hls: `${base}/master.m3u8`, dash: `${base}/manifest.mpd` };
}

/** Load the shared resource's view model (title/metadata/manifest), scoped to the account. */
export async function loadResource(kind: ShareResourceKind, resourceId: string, accountId: string): Promise<any | null> {
  if (kind === 'vod') {
    const a = await one<any>(
      `SELECT v.* FROM vod_assets v
         JOIN channels c ON c.id=v.channel_id
         JOIN groups g   ON g.id=c.group_id
        WHERE v.id=$1 AND g.account_id=$2`,
      [resourceId, accountId]
    );
    if (!a) return null;
    const m = manifestUrls('vod', a.id, a.master_key, a.formats);
    return {
      kind: 'vod', id: a.id, title: a.title ?? 'Untitled', durationMs: Number(a.duration_ms ?? 0),
      metadata: a.metadata ?? {}, formats: a.formats ?? {}, hls: m.hls, dash: m.dash, masterKey: a.master_key,
    };
  }
  const table = kind === 'channel' ? 'channels' : 'events';
  const r = await one<any>(
    `SELECT x.*, g.account_id FROM ${table} x JOIN groups g ON g.id=x.group_id WHERE x.id=$1 AND g.account_id=$2`,
    [resourceId, accountId]
  );
  if (!r) return null;
  const m = manifestUrls(kind, r.id);
  return { kind, id: r.id, title: r.name ?? 'Live', durationMs: 0, metadata: r.metadata ?? {}, hls: m.hls, dash: m.dash };
}

export interface CreateShareInput {
  accountId: string; createdBy?: string | null;
  resourceKind: ShareResourceKind; resourceId: string;
  ttlSec: number; label?: string; message?: string; recipients?: string[];
  accessType?: ShareAccessType; allowHiRes?: boolean; allowPlayer?: boolean; allowMetadata?: boolean;
  watermark?: boolean; notifyOnOpen?: boolean; pin?: string; maxViews?: number | null;
}

/** Create a share link. Returns the row + the ONE-TIME raw URL. */
export async function createShareLink(inp: CreateShareInput): Promise<{ id: string; url: string; token: string; expiresAt: string }> {
  const resource = await loadResource(inp.resourceKind, inp.resourceId, inp.accountId);
  if (!resource) throw Object.assign(new Error('resource not found in this account'), { status: 404 });
  const t = generateShareToken();
  const expiresAt = new Date(Date.now() + inp.ttlSec * 1000).toISOString();
  const download = inp.accessType === 'allow_download';
  const row = await one<any>(
    `INSERT INTO share_links
      (account_id, resource_kind, resource_id, token_prefix, token_hash, label, message, recipients,
       access_type, allow_hi_res, allow_player, allow_metadata, watermark, notify_on_open, pin_hash,
       expires_at, max_views, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id, expires_at`,
    [
      inp.accountId, inp.resourceKind, inp.resourceId, t.prefix, t.hash, inp.label ?? null, inp.message ?? null,
      JSON.stringify(inp.recipients ?? []),
      inp.accessType ?? 'preview_only',
      download ? !!inp.allowHiRes : false, download ? !!inp.allowPlayer : false, download ? !!inp.allowMetadata : false,
      inp.watermark ?? true, !!inp.notifyOnOpen, inp.pin ? sha256(inp.pin) : null,
      expiresAt, inp.maxViews ?? null, inp.createdBy ?? null,
    ]
  );
  const url = `${config.publicBaseUrl.replace(/\/$/, '')}/share/${t.raw}`;
  return { id: row.id, url, token: t.raw, expiresAt: row.expires_at };
}

/** Resolve a raw token to its row (by hash). No policy check here. */
export async function findShareByToken(raw: string): Promise<ShareRow | null> {
  if (!raw || !raw.startsWith('shr_')) return null;
  return one<ShareRow>(`SELECT * FROM share_links WHERE token_hash=$1`, [sha256(raw)]);
}

/**
 * Build the full recipient view model for the standalone page, mint a short-lived
 * playback token, count the view, and fire the notify-on-first-open hook. Runs the
 * geo/rights gate. Returns a denial object if the policy rejects.
 */
export async function openShare(raw: string, opts: { pin?: string; geo?: string; nowMs?: number }): Promise<
  | { ok: false; reason: ShareDenyReason }
  | { ok: true; view: any }
> {
  const row = await findShareByToken(raw);
  if (!row) return { ok: false, reason: 'not_found' };
  const now = opts.nowMs ?? Date.now();
  const policy = evaluateSharePolicy(row, now, opts.pin);
  if (!policy.ok) return policy;

  const resource = await loadResource(row.resource_kind, row.resource_id, row.account_id);
  if (!resource) return { ok: false, reason: 'not_found' };

  // geo/rights: same gate as public playback (VOD has an assetId to evaluate)
  let mode: 'play' | 'replacement' | 'blocked' = 'play';
  let playAssetId = resource.id;
  if (row.resource_kind === 'vod') {
    const rights = await evaluateAccess(resource.id, opts.geo);
    if (!rights.allowed) {
      if (rights.replacementAssetId) { mode = 'replacement'; playAssetId = rights.replacementAssetId; }
      else return { ok: false, reason: 'not_found' }; // treat a hard blackout as no-content on a share page
    }
  }

  const account = await one<any>(`SELECT name FROM accounts WHERE id=$1`, [row.account_id]);
  const creator = row.created_by ? await one<any>(`SELECT display_name, email FROM users WHERE id=$1`, [row.created_by]) : null;

  // view accounting + first-open stamp (atomic)
  const firstOpen = !row.first_opened_at;
  await query(
    `UPDATE share_links SET view_count=view_count+1, last_viewed_at=now(),
        first_opened_at=COALESCE(first_opened_at, now()) WHERE id=$1`,
    [row.id]
  );
  if (firstOpen && row.notify_on_open && row.created_by) {
    try {
      const { sendNotification } = await import('./notifications');
      const who = creator?.email ?? 'the recipient';
      await sendNotification({
        accountId: row.account_id, subject: `Your shared link was opened: ${resource.title}`,
        body: `The share link for "${resource.title}" was opened for the first time.`,
        recipients: [creator?.email ?? who], channels: ['in_app'],
      } as any);
    } catch { /* notify is best-effort */ }
  }

  const tok = mintPlaybackToken({ accountId: row.account_id, appId: null, assetId: playAssetId, geo: opts.geo, ttlSec: 300 });
  const download = row.access_type === 'allow_download';
  return {
    ok: true,
    view: {
      title: resource.title,
      kind: resource.kind,
      live: resource.kind !== 'vod',
      // live preview is only watchable while the source is active and output is being
      // created; VOD is always available. The page shows a waiting state otherwise.
      available: resource.kind === 'vod' ? true : liveOutputFresh(resource.id),
      durationMs: resource.durationMs,
      metadata: row.allow_metadata || row.access_type === 'preview_only' ? resource.metadata : resource.metadata, // metadata always visible on the page; download is separate
      hls: resource.hls, dash: resource.dash,
      mode,
      playbackToken: tok.token, expiresIn: tok.expiresIn,
      brand: { account: account?.name ?? 'Volt' },
      sharedBy: creator?.display_name ?? creator?.email ?? null,
      message: row.message,
      expiresAt: row.expires_at,
      watermark: row.watermark,
      access: {
        preview: true,
        download,
        hiRes: download && row.allow_hi_res,
        player: download && row.allow_player,
        metadata: download && row.allow_metadata,
        signInRequired: false,
      },
    },
  };
}
