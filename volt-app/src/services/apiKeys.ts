/**
 * API key + app access model.
 *
 * - generateKey(): mint a raw key (sk_live_… / pk_live_…) shown ONCE; store only
 *   its sha256 + a display prefix.
 * - verifyKey(): resolve a presented raw key to its api_keys row (by prefix +
 *   hash), enforcing enabled + kind.
 * - checkRestrictions(): enforce the app's type-specific restriction (web
 *   referrer/origin allow-list, server IP allow-list, …). Native apps send no
 *   referrer — that is normal and never blocked here.
 * - playback token: a short-lived JWT bound to account/asset/session that the
 *   edge validates per request. The key says "who is asking"; the token says
 *   "authorised to watch this, now".
 */
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { keyByHash, appById } from './viewerPath';
import { noteKeyUse } from '../scale/keyUsage';

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Returns { raw, prefix, hash }. raw is shown to the user once and discarded. */
export function generateKey(kind: 'secret' | 'publishable', live = true): { raw: string; prefix: string; hash: string } {
  const p = kind === 'secret' ? 'sk' : 'pk';
  const env = live ? 'live' : 'test';
  const body = randomBytes(24).toString('base64url');
  const raw = `${p}_${env}_${body}`;
  return { raw, prefix: raw.slice(0, 14), hash: sha256(raw) };
}

export interface ApiKeyRow {
  id: string;
  account_id: string;
  app_id: string | null;
  kind: 'secret' | 'publishable';
  scopes: string[];
  enabled: boolean;
}

/**
 * Resolve a presented raw key to its row (enabled only). Bumps metering.
 * A SUSPENDED account's keys stop working immediately (SaaS control): the
 * join is the single choke point every key-authenticated surface goes through.
 */
export async function verifyKey(raw: string): Promise<ApiKeyRow | null> {
  if (!raw || !/^(sk|pk)_/.test(raw)) return null;
  // CACHED, AND METERED IN MEMORY. Every viewer of an app presents the same
  // publishable key, so the lookup is shared (scale/cache.ts; a disable or an
  // account suspension still applies at once through the change triggers) and
  // the usage counter is batched (scale/keyUsage.ts). The per-request UPDATE
  // that used to sit here queued every viewer on one row lock.
  const row = await keyByHash(sha256(raw));
  if (!row) return null;
  noteKeyUse(row.id);
  return row;
}

/** The app a publishable key belongs to, cached. Same columns as the old inline query. */
export function appForKey(key: ApiKeyRow): Promise<AppRow | null> {
  return appById(key.app_id);
}

export interface AppRow {
  id: string;
  type: 'web' | 'ios' | 'android' | 'tv' | 'roku' | 'server';
  restrictions: any;
  enabled: boolean;
}

/**
 * Enforce an app's restriction against the request context. Returns null on OK,
 * or a reason string on rejection. Web = referrer/origin allow-list; server = IP
 * allow-list. Mobile/TV attestation (App Attest / Play Integrity) is verified
 * upstream by the client SDK — represented here as a pass-through.
 */
export function checkRestrictions(app: AppRow, ctx: { referrer?: string; origin?: string; ip?: string }): string | null {
  if (!app.enabled) return 'app disabled';
  const r = app.restrictions || {};
  if (app.type === 'web') {
    const allow: string[] = r.referrers || r.origins || [];
    if (allow.length) {
      const host = hostOf(ctx.origin) || hostOf(ctx.referrer);
      if (!host) return 'referrer/origin required for this web app';
      if (!allow.some((a) => matchHost(a, host))) return `origin '${host}' not in allow-list`;
    }
  } else if (app.type === 'server') {
    const allow: string[] = r.ipAllowlist || [];
    if (allow.length && (!ctx.ip || !allow.includes(ctx.ip))) return `ip '${ctx.ip}' not allow-listed`;
  }
  // ios/android/tv/roku: attestation handled by the client SDK upstream.
  return null;
}

function hostOf(u?: string): string | null {
  if (!u) return null;
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return u.toLowerCase().replace(/^https?:\/\//, '').split('/')[0] || null;
  }
}
function matchHost(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (p.startsWith('*.')) return host === p.slice(2) || host.endsWith(p.slice(1));
  return host === p;
}

/** Mint a short-lived playback token bound to account/asset/session. */
export function mintPlaybackToken(opts: {
  accountId: string; appId: string | null; assetId: string;
  /**
   * WHAT the asset is. The beacon needs it to file the session under the right
   * scope, and it was never in the token: the consumer guessed with
   * `/^(chan|00000000)/.test(assetId)`, which no real channel uuid matches, so
   * every channel play session was recorded as `asset_kind='vod'`. Live
   * concurrency for a channel was therefore zero on every screen that asked
   * for it, and per-channel rollups landed under the wrong scope entirely.
   */
  assetKind: 'channel' | 'event' | 'vod';
  geo?: string; ttlSec?: number;
  /** Where the play came from, when it is not an app: 'share' for a share-link preview. */
  source?: 'share';
  /**
   * The play attempt's CMCD session id, when the player sent one: the same id
   * is on its CDN requests, its CMCD reports and its beacons, so a licence
   * proxy or the variant service reading the token logs the same session.
   */
  sid?: string;
}): { token: string; expiresIn: number } {
  const ttl = opts.ttlSec ?? 120;
  const token = jwt.sign(
    { typ: 'playback', aid: opts.accountId, app: opts.appId,
      asset: opts.assetId, kind: opts.assetKind, geo: opts.geo ?? null, ...(opts.source ? { src: opts.source } : {}), ...(opts.sid ? { sid: opts.sid } : {}) },
    playbackSecret(),
    { expiresIn: ttl }
  );
  return { token, expiresIn: ttl };
}

/**
 * The key playback tokens are signed with. PLAYBACK_TOKEN_SECRET when set,
 * otherwise the operator access secret as before. A separate secret is what
 * lets an edge function verify playback tokens without holding the key that
 * signs operator sessions.
 */
function playbackSecret(): string {
  return process.env.PLAYBACK_TOKEN_SECRET || config.jwt.accessSecret;
}

export function verifyPlaybackToken(token: string, opts: { graceSec?: number } = {}): any {
  // A playback token lives minutes, a viewing session hours. The token proves
  // the session STARTED legitimately; heartbeats and the end of that session
  // may carry it after it expires, within graceSec (the beacon allows six
  // hours). A start never gets grace.
  const d = (opts.graceSec
    ? jwt.verify(token, playbackSecret(), { clockTolerance: opts.graceSec })
    : jwt.verify(token, playbackSecret())) as any;
  if (d.typ !== 'playback') throw new Error('not a playback token');
  return d;
}
