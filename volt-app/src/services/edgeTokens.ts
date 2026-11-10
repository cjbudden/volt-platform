// ============================================================================
//  EDGE PLAY TOKENS FOR ON-DEMAND MEDIA (build queue P2, PUBLISHING_POLICIES.md
//  "Enforcement: every public path honours the policy").
//
//  Hiding a title from a list does not stop a copied play URL. So when the
//  play gate (/api/availability) lets a viewer play an on-demand asset, the
//  URLs it hands back carry a short signed token IN THE PATH:
//
//    https://cdn/vod/<id>/master.m3u8  ->  https://cdn/t/<token>/vod/<id>/master.m3u8
//
//  In the path, not the query, because every playlist and MPD Volt packages
//  names its segments relatively: a player resolves "720p/seg_3.m4s" against
//  the manifest's URL, so every segment request carries the token too, with
//  no player code and no manifest rewriting (a query string is dropped by
//  Safari's native HLS on segment requests). The edge checks the token and
//  strips the prefix, so the cache key stays the plain path and every viewer
//  shares one cached copy of each segment.
//
//  The token: "<claims>.<sig>", claims = base64url JSON, sig = the first 32
//  hex of HMAC-SHA256(key, "<claims>"), the same shape as the rights-class
//  claim (services/edgeRights.ts) so the edge code is the same few lines:
//    a  asset id                     (the revocation set is keyed on it)
//    p  the path prefix it opens     ("/vod/<id>/" or "/clips/vod/<id>/")
//    c  the viewer's country         ("" when the gate did not know it)
//    k  policy class                 open | members | premium | rights
//    d  DRM flag                     0 today: on-demand packaging is clear (H5-4)
//    s  the play attempt's sid       when the player sent one
//    n  issued at = not before       (epoch seconds)
//    e  expiry                       the earlier of now + lifetime and the end
//                                    of the asset's effective window, so the
//                                    edge ends playback on the exact second
//                                    without knowing any dates
//
//  The edge (deploy/edge/vod-token-viewer-request.js on CloudFront, and
//  deploy/staging/edge-token.js in the staging nginx on the Mac) refuses with
//  403 a bad signature, an expired or not-yet-valid token, a path outside `p`,
//  a viewer country that is not `c` (a URL shared across a border), and a
//  token issued before the asset's revocation time ("r:<asset id>"), which the
//  control plane writes when a title stops being public before its window ends
//  (withdrawn, archived, restricted). Tokens issued after that (republished)
//  play again, so a revocation never needs undoing.
//
//  VOLT_EDGE_TOKENS: "off" (default: URLs as before), "issue" (the gate hands
//  out tokenised URLs; the edge checks every /t/ request; plain paths still
//  play, so nothing breaks while players and caches turn over). Refusing plain
//  paths ("enforce") comes with the console and share previews carrying tokens
//  (build queue P2-2).
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';
import { query } from '../db';
import { config } from '../config';
import type { EdgeStore } from './edgeRights';

export type PolicyClass = 'open' | 'members' | 'premium' | 'rights';
export interface EdgeClaims { a: string; p: string; c: string; k: PolicyClass; d: 0 | 1; s?: string; n: number; e: number }

/** Where the edge reads the key ("k:pt") and the revocations ("r:<asset id>"). */
export const TOKEN_KEY = 'k:pt';
export const revocationKey = (assetId: string) => `r:${assetId}`;

export function edgeTokensMode(): 'off' | 'issue' {
  const v = String(process.env.VOLT_EDGE_TOKENS ?? '').trim().toLowerCase();
  return v === 'issue' || v === 'on' || v === 'enforce' ? 'issue' : 'off';
}

/**
 * The key tokens are signed with and that the sync publishes at "k:pt". Its own
 * derivation, so the edge never holds a key that signs anything else.
 */
export function edgeTokenKey(): string {
  return process.env.EDGE_TOKEN_KEY
    || createHmac('sha256', config.jwt.accessSecret).update('volt-edge-play-token-v1').digest('hex');
}

/**
 * How long a token lives before its window clamps it. No renewal exists yet,
 * so a restricted title's token must outlast a long viewing: 4 hours; open
 * content 24 hours (it still ends on its exact date through the clamp). A
 * publishing rule's token lifetime (Protection, build queue P3-4b) replaces
 * these for the titles it governs: the play gate passes it as `lifetimeSec`.
 */
export function tokenLifetimeSec(k: PolicyClass): number {
  const n = (v: string | undefined, dflt: number) => { const x = Number(v); return Number.isFinite(x) && x >= 60 ? Math.floor(x) : dflt; };
  return k === 'open' ? n(process.env.EDGE_TOKEN_OPEN_TTL_SEC, 24 * 3600) : n(process.env.EDGE_TOKEN_TTL_SEC, 4 * 3600);
}
/** The longest token lifetime a publishing rule may set (modules/publishingRules.ts allows 30 s to 24 h). */
export const POLICY_MAX_TOKEN_LIFETIME_SEC = 86_400;
/**
 * The longest a token can live: how long a revocation must be kept at the
 * edge. A rule may set up to a day whatever the defaults are, so a revocation
 * is kept at least that long, or a long-lived token would outlast it.
 */
export const maxTokenLifetimeSec = () => Math.max(tokenLifetimeSec('open'), tokenLifetimeSec('rights'), POLICY_MAX_TOKEN_LIFETIME_SEC);

const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const sig = (key: string, body: string) => createHmac('sha256', key).update(body).digest('hex').slice(0, 32);

export function signEdgeToken(c: EdgeClaims, key = edgeTokenKey()): string {
  const body = b64u(JSON.stringify(c));
  return `${body}.${sig(key, body)}`;
}

/**
 * Mint a token for a play. `effectiveUntil` is the end of the window the
 * viewer may play in (publish window inside the rights window).
 */
export function mintEdgeToken(o: {
  assetId: string; prefix: string; country?: string | null; policyClass: PolicyClass; drm?: boolean; sid?: string | null;
  effectiveUntil?: Date | null; nowSec?: number; key?: string;
  /** The title's rule's token lifetime (Protection); null or absent: the policy class default. */
  lifetimeSec?: number | null;
}): { token: string; claims: EdgeClaims } {
  const n = o.nowSec ?? Math.floor(Date.now() / 1000);
  const life = o.lifetimeSec && o.lifetimeSec > 0 ? Math.min(Math.floor(o.lifetimeSec), POLICY_MAX_TOKEN_LIFETIME_SEC) : tokenLifetimeSec(o.policyClass);
  let e = n + life;
  if (o.effectiveUntil) e = Math.min(e, Math.floor(o.effectiveUntil.getTime() / 1000));
  const claims: EdgeClaims = { a: o.assetId, p: o.prefix, c: (o.country ?? '').toUpperCase(), k: o.policyClass, d: o.drm ? 1 : 0, ...(o.sid ? { s: o.sid } : {}), n, e };
  return { token: signEdgeToken(claims, o.key), claims };
}

export type EdgeVerdict = 'ok' | 'malformed' | 'signature' | 'early' | 'expired' | 'path' | 'country' | 'revoked';

/**
 * The words in an edge refusal's body (build queue P2-2), the same at both
 * edges and on the play gate: a URL taken across a border says what the gate
 * would have said (DEFAULT_BLOCK_MESSAGE). The edge cannot read an account's
 * own block message (it has no database), so it always uses the default words;
 * players show the account's message from the gate's 451 before they get here.
 */
export const EDGE_REFUSAL_TEXT: Record<Exclude<EdgeVerdict, 'ok'>, string> = {
  malformed: 'Not available', signature: 'Not available', path: 'Not available',
  early: 'This link has expired', expired: 'This link has expired',
  country: 'Not available in your region', revoked: 'No longer available',
};

/**
 * THE EDGE'S CHECK, in TypeScript: the reference the two edge files are tested
 * against (test/edge-tokens.check.ts runs all three on the same cases).
 * `uri` is the path after the /t/<token> prefix.
 */
export function verifyEdgeToken(token: string, uri: string, o: { country?: string | null; nowSec: number; revokedAt?: number | null; key?: string }): { verdict: EdgeVerdict; claims?: EdgeClaims } {
  const m = /^([A-Za-z0-9_-]{8,2048})\.([0-9a-f]{32})$/.exec(token);
  if (!m) return { verdict: 'malformed' };
  const want = Buffer.from(sig(o.key ?? edgeTokenKey(), m[1])), got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { verdict: 'signature' };
  let c: EdgeClaims;
  try { c = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return { verdict: 'malformed' }; }
  if (o.nowSec + 60 < c.n) return { verdict: 'early', claims: c };
  if (o.nowSec >= c.e) return { verdict: 'expired', claims: c };
  if (!c.p || uri.indexOf(c.p) !== 0 || uri.indexOf('/../') >= 0) return { verdict: 'path', claims: c };
  const cc = (o.country ?? '').toUpperCase();
  if (c.c && cc && c.c !== cc) return { verdict: 'country', claims: c };
  if (o.revokedAt != null && c.n <= o.revokedAt) return { verdict: 'revoked', claims: c };
  return { verdict: 'ok', claims: c };
}

/**
 * The prefix a token opens: the folder both manifests live in. Null when the
 * URLs share no folder at least two levels deep (never open "/" or "/clips/").
 */
export function tokenPrefix(urls: (string | null | undefined)[]): string | null {
  const paths = urls.filter((u): u is string => !!u).map((u) => { try { return new URL(u, 'http://x').pathname; } catch { return null; } });
  if (!paths.length || paths.some((p) => !p)) return null;
  const dirs = (paths as string[]).map((p) => p.slice(0, p.lastIndexOf('/') + 1));
  let pre = dirs[0];
  for (const d of dirs.slice(1)) { while (pre && !d.startsWith(pre)) pre = pre.slice(0, pre.slice(0, -1).lastIndexOf('/') + 1); }
  return pre && pre.split('/').filter(Boolean).length >= 2 ? pre : null;
}

/** "/clips/vod/x/master.m3u8" or "https://cdn/vod/x/master.m3u8" with the token put in front of the path. */
export function withToken(url: string | null | undefined, token: string): string | null {
  if (!url) return url ?? null;
  const abs = /^https?:\/\//i.test(url);
  const u = new URL(url, 'http://x');
  u.pathname = `/t/${token}${u.pathname}`;
  return abs ? u.toString() : u.pathname + u.search;
}

/** The policy class from the asset's rights and the gate's decision. */
export function policyClassOf(o: { territoryMode?: string | null; via?: string | null }): PolicyClass {
  if (o.territoryMode && o.territoryMode !== 'worldwide') return 'rights';
  if (o.via === 'entitlement') return 'premium';
  if (o.via === 'members') return 'members';
  return 'open';
}

// ---------------------------------------------------------------------------
//  The revocation set
// ---------------------------------------------------------------------------
/**
 * A title stopped being public: refuse its tokens issued until now. Kept as
 * long as a token can live, then dropped (by then every such token expired).
 */
export async function revokeAsset(assetId: string, reason: string, nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  await query(
    `INSERT INTO edge_revocations (asset_id, revoked_at, expires_at, reason)
     VALUES ($1, to_timestamp($2), to_timestamp($2) + make_interval(secs => $3), $4)
     ON CONFLICT (asset_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at, expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason`,
    [assetId, nowSec, maxTokenLifetimeSec(), reason.slice(0, 200)]);
}

/**
 * Keep the edge store in step: the key at "k:pt", one "r:<id>" per live
 * revocation (value: revoked-at epoch seconds), expired ones removed from the
 * store and the table. Writes only what changed (memo).
 */
export async function syncEdgeTokens(store: EdgeStore, memo?: Map<string, string | null>, key = edgeTokenKey()):
  Promise<{ put: number; deleted: number }> {
  const res = { put: 0, deleted: 0 };
  const cur = memo?.has(TOKEN_KEY) ? memo.get(TOKEN_KEY)! : await store.get(TOKEN_KEY);
  if (cur !== key) { await store.put(TOKEN_KEY, key); res.put++; }
  memo?.set(TOKEN_KEY, key);
  const rows = await query<any>(`SELECT asset_id, extract(epoch FROM revoked_at)::bigint AS at, expires_at <= now() AS gone FROM edge_revocations`);
  for (const r of rows) {
    const k = revocationKey(r.asset_id);
    if (r.gone) {
      await store.delete(k); memo?.set(k, null); res.deleted++;
      await query(`DELETE FROM edge_revocations WHERE asset_id = $1 AND expires_at <= now()`, [r.asset_id]);
      continue;
    }
    const v = String(r.at);
    const was = memo?.has(k) ? memo.get(k)! : await store.get(k);
    if (was !== v) { await store.put(k, v); res.put++; }
    memo?.set(k, v);
  }
  return res;
}

/**
 * The staging edge's store (the Mac): one JSON file of the same keys the
 * CloudFront KeyValueStore holds, on the volume the nginx edge mounts. Written
 * whole to a temporary file and renamed, so the edge never reads half a file.
 */
export async function fileEdgeStore(path: string): Promise<EdgeStore> {
  const fs = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const read = async (): Promise<Record<string, string>> => {
    try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return {}; }
  };
  const write = async (o: Record<string, string>) => {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(o));
    await fs.rename(tmp, path);
  };
  return {
    async get(k) { const o = await read(); return k in o ? o[k] : null; },
    async put(k, v) { const o = await read(); o[k] = v; await write(o); },
    async delete(k) { const o = await read(); if (k in o) { delete o[k]; await write(o); } },
  };
}
