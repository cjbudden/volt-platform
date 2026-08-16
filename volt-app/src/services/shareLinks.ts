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
import { mintPlaybackToken } from './apiKeys';
import { evaluateAccess } from './rights';

/** Is a live channel/event's origin manifest advancing right now? (share preview
 *  availability: the link only shows content while the source is active and output
 *  is being created — NOT tied to on-air). */
function liveOutputFresh(resourceId: string): boolean {
  try {
    const dir = join(config.testStream.originDir, resourceId);
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

/** Hard ceiling for any share link's life (create, custom expiry, or extend). */
export const MAX_TTL_SEC = 90 * 86400;

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
  const base = useCdn ? `${cdn()}/${kind}/${resourceId}` : `/origin/${resourceId}`;
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
  /** relative expiry; ignored when expiresAt is supplied */
  ttlSec: number;
  /** absolute expiry (ISO) — a custom date/time picked in the console */
  expiresAt?: string;
  label?: string; message?: string; recipients?: string[];
  accessType?: ShareAccessType; allowHiRes?: boolean; allowPlayer?: boolean; allowMetadata?: boolean;
  watermark?: boolean; notifyOnOpen?: boolean; pin?: string; maxViews?: number | null;
}

/** Absolute expiry wins over a relative ttl. Rejects an expiry in the past. */
export function resolveExpiry(expiresAt: string | undefined, ttlSec: number, nowMs = Date.now()): string {
  if (expiresAt) {
    const t = new Date(expiresAt).getTime();
    if (!Number.isFinite(t)) throw Object.assign(new Error('expiresAt is not a valid date'), { status: 400 });
    if (t <= nowMs) throw Object.assign(new Error('expiresAt must be in the future'), { status: 400 });
    if (t > nowMs + MAX_TTL_SEC * 1000) throw Object.assign(new Error('expiresAt is beyond the 90 day maximum'), { status: 400 });
    return new Date(t).toISOString();
  }
  return new Date(nowMs + ttlSec * 1000).toISOString();
}

/** Create a share link. Returns the row + the ONE-TIME raw URL. */
export async function createShareLink(inp: CreateShareInput): Promise<{ id: string; url: string; token: string; expiresAt: string }> {
  const resource = await loadResource(inp.resourceKind, inp.resourceId, inp.accountId);
  if (!resource) throw Object.assign(new Error('resource not found in this account'), { status: 404 });
  const t = generateShareToken();
  const expiresAt = resolveExpiry(inp.expiresAt, inp.ttlSec);
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

/* -------------------------------------------------------------- mutate ---- */

export interface UpdateShareInput {
  label?: string | null; message?: string | null; recipients?: string[];
  /** absolute new expiry (ISO) */ expiresAt?: string;
  /** or push the CURRENT expiry out by this many seconds (extend) */ extendSec?: number;
  maxViews?: number | null;
  /** '' or null clears the PIN; a string sets a new one */ pin?: string | null;
  watermark?: boolean; notifyOnOpen?: boolean; revoked?: boolean;
}

/**
 * Edit a live link in place: rename it, extend or shorten its life, change the view
 * cap, set/clear the PIN, flip watermark / notify-on-open, revoke or un-revoke.
 * The token itself is untouched, so the URL already sent keeps working.
 */
export async function updateShareLink(id: string, accountId: string, inp: UpdateShareInput): Promise<any | null> {
  const row = await one<ShareRow>(`SELECT * FROM share_links WHERE id=$1 AND account_id=$2`, [id, accountId]);
  if (!row) return null;

  const set: string[] = []; const vals: any[] = [id, accountId]; const P = () => `$${vals.length + 1}`;
  const put = (col: string, v: any) => { set.push(`${col}=${P()}`); vals.push(v); };

  if (inp.label !== undefined) put('label', inp.label || null);
  if (inp.message !== undefined) put('message', inp.message || null);
  if (inp.recipients !== undefined) { set.push(`recipients=${P()}::jsonb`); vals.push(JSON.stringify(inp.recipients)); }
  if (inp.maxViews !== undefined) put('max_views', inp.maxViews);
  if (inp.watermark !== undefined) put('watermark', inp.watermark);
  if (inp.notifyOnOpen !== undefined) put('notify_on_open', inp.notifyOnOpen);
  if (inp.revoked !== undefined) put('revoked', inp.revoked);
  if (inp.pin !== undefined) {
    if (inp.pin === null || inp.pin === '') put('pin_hash', null);
    else {
      if (inp.pin.length < 3) throw Object.assign(new Error('pin must be at least 3 characters'), { status: 400 });
      put('pin_hash', sha256(inp.pin));
    }
  }
  if (inp.expiresAt !== undefined) put('expires_at', resolveExpiry(inp.expiresAt, 0));
  else if (inp.extendSec !== undefined) {
    // extend from whichever is later: now, or the current expiry (so extending a
    // link that already lapsed gives a full window rather than a past date)
    const base = Math.max(Date.now(), new Date(row.expires_at).getTime());
    put('expires_at', resolveExpiry(new Date(base + inp.extendSec * 1000).toISOString(), 0));
  }
  if (!set.length) return publicShareRow(row);

  const updated = await one<any>(
    `UPDATE share_links SET ${set.join(', ')} WHERE id=$1 AND account_id=$2 RETURNING *`, vals
  );
  return publicShareRow(updated);
}

/** Strip the secrets from a row before it leaves the API. */
export function publicShareRow(row: any): any {
  const { token_hash, pin_hash, ...rest } = row;
  return { ...rest, has_pin: !!pin_hash };
}

/**
 * Mint a NEW token for an existing link. The previously issued URL stops working
 * immediately, which is the recovery path when a link is sent to the wrong person
 * (or when the one-time URL was lost and it needs to be re-sent).
 */
export async function rotateShareToken(id: string, accountId: string): Promise<{ id: string; url: string; token: string; expiresAt: string } | null> {
  const row = await one<ShareRow>(`SELECT * FROM share_links WHERE id=$1 AND account_id=$2`, [id, accountId]);
  if (!row) return null;
  const t = generateShareToken();
  const updated = await one<any>(
    `UPDATE share_links SET token_prefix=$3, token_hash=$4, revoked=false WHERE id=$1 AND account_id=$2
      RETURNING id, expires_at`,
    [id, accountId, t.prefix, t.hash]
  );
  return { id: updated.id, url: `${config.publicBaseUrl.replace(/\/$/, '')}/share/${t.raw}`, token: t.raw, expiresAt: updated.expires_at };
}

/* -------------------------------------------------------------- deliver --- */

export interface ShareInviteInput {
  accountId: string; url: string; title: string; recipients: string[];
  sharedBy?: string | null; message?: string | null; expiresAt: string; hasPin?: boolean;
}

/**
 * Email the link to its recipients. The raw URL only exists in memory at create /
 * rotate time (we store a hash), so sending is bound to those two moments — there is
 * deliberately no "re-send" that could resurrect a token from the database.
 */
export async function sendShareInvite(inp: ShareInviteInput): Promise<{ sent: number }> {
  const to = (inp.recipients ?? []).map(r => r.trim()).filter(Boolean);
  if (!to.length) return { sent: 0 };
  const expires = new Date(inp.expiresAt).toUTCString();
  const body = [
    inp.message ? `${inp.message}\n` : '',
    `${inp.sharedBy ? inp.sharedBy + ' has' : 'You have been'} shared a private preview of "${inp.title}".`,
    '',
    inp.url,
    '',
    `This link expires ${expires}.`,
    inp.hasPin ? 'It is protected by a PIN, which is sent to you separately.' : '',
    'Please do not forward it.',
  ].filter(Boolean).join('\n');
  const { sendNotification } = await import('./notifications');
  const out = await sendNotification({
    accountId: inp.accountId, topic: 'share_link', recipients: to, channels: ['email'],
    subject: `A private preview of "${inp.title}" has been shared with you`, body,
  });
  return { sent: out.deliveries };
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
