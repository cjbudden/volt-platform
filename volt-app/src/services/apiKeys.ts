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
import { query, one } from '../db';

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
  const row = await one<ApiKeyRow>(
    `SELECT k.id, k.account_id, k.app_id, k.kind, k.scopes, k.enabled
       FROM api_keys k JOIN accounts a ON a.id = k.account_id
      WHERE k.key_hash=$1 AND k.enabled=true AND COALESCE(a.status,'active') <> 'suspended'`,
    [sha256(raw)]
  );
  if (!row) return null;
  await query(`UPDATE api_keys SET last_used_at=now(), request_count=request_count+1 WHERE id=$1`, [row.id]);
  return row;
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
}): { token: string; expiresIn: number } {
  const ttl = opts.ttlSec ?? 120;
  const token = jwt.sign(
    { typ: 'playback', aid: opts.accountId, app: opts.appId,
      asset: opts.assetId, kind: opts.assetKind, geo: opts.geo ?? null },
    config.jwt.accessSecret,
    { expiresIn: ttl }
  );
  return { token, expiresIn: ttl };
}

export function verifyPlaybackToken(token: string): any {
  const d = jwt.verify(token, config.jwt.accessSecret) as any;
  if (d.typ !== 'playback') throw new Error('not a playback token');
  return d;
}
