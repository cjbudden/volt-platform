/**
 * PUBLIC (VIEWER) SESSIONS. See ACCESS_CONTROL.md, "Public users".
 *
 * A viewer is a member of a client's audience: they watch, sign in, keep a
 * profile, buy access. A viewer is NOT an admin user and can never become one:
 *
 *   - signed with a DIFFERENT key (VIEWER_JWT_SECRET) and audience
 *     (volt:viewer), so a viewer token cannot verify on the admin API and an
 *     admin token cannot verify here;
 *   - lives in `viewers`, not `users`; nothing joins the two.
 *
 * WHY THIS SCALES. The access token carries what the play gate needs to decide
 * (who, which account and app, groups, and a snapshot of entitlements), so
 * deciding whether a signed-in viewer may watch costs an HMAC check and no
 * database query. Freshness:
 *   - new purchases: the play gate re-checks the database (cached, dropped on
 *     purchase) only when the token's snapshot says no, and the app can
 *     refresh the token after checkout;
 *   - revocations (refund, disabled viewer, password change): every process
 *     keeps a revocation list fed by Postgres NOTIFY (migration 0047); tokens
 *     issued before the revocation are refused at once. Short access tokens
 *     (VIEWER_ACCESS_TTL, default 15 min) bound anything missed while a
 *     process was reconnecting.
 */
import jwt from 'jsonwebtoken';
import { createHmac, randomBytes, createHash } from 'node:crypto';
import argon2 from 'argon2';
import { config } from '../config';
import { onNotify, onReconnect } from '../scale/notify';

export const AUD_VIEWER = 'volt:viewer';
export const VIEWER_ACCESS_TTL = Number(process.env.VIEWER_ACCESS_TTL ?? 900);
export const VIEWER_REFRESH_TTL = Number(process.env.VIEWER_REFRESH_TTL ?? 60 * 24 * 3600);
/** Above this many entitlements the token carries a marker and the gate reads them (cached). */
const MAX_TOKEN_ENTITLEMENTS = 25;

function secret(): string {
  // A dedicated key when configured; otherwise one DERIVED from the access
  // secret, so the two token families never share a key even in dev.
  return process.env.VIEWER_JWT_SECRET
    || createHmac('sha256', config.jwt.accessSecret).update('volt-viewer-tokens-v1').digest('base64url');
}

export interface ViewerEntitlementClaim { g: any; u?: string | null; p?: string | null }

export interface ViewerClaims {
  typ: 'viewer';
  sub: string;          // viewers.id
  acct: string;         // account
  app: string | null;   // app the session was opened through
  grp: string[];        // client-defined groups (members-only rules)
  ent?: ViewerEntitlementClaim[];
  /** true when entitlements were too many to carry: read them instead. */
  entx?: boolean;
  /** issued at, epoch ms (finer than iat, for the revocation check) */
  ims?: number;
  iat: number;
  exp: number;
}

export function signViewer(v: { id: string; accountId: string; appId: string | null; groups: string[];
  entitlements: { grants: any; validUntil?: string | Date | null; productKey?: string | null }[] }): { token: string; expiresIn: number } {
  const ent = v.entitlements.slice(0, MAX_TOKEN_ENTITLEMENTS).map((e) => ({
    g: e.grants, u: e.validUntil ? new Date(e.validUntil).toISOString() : null, p: e.productKey ?? null,
  }));
  const token = jwt.sign(
    { typ: 'viewer', ims: Date.now(), acct: v.accountId, app: v.appId, grp: v.groups ?? [], ent, ...(v.entitlements.length > MAX_TOKEN_ENTITLEMENTS ? { entx: true } : {}) },
    secret(),
    { subject: v.id, audience: AUD_VIEWER, issuer: 'volt', expiresIn: VIEWER_ACCESS_TTL },
  );
  return { token, expiresIn: VIEWER_ACCESS_TTL };
}

// ---- revocation list -------------------------------------------------------------

/** viewer id -> epoch ms; tokens issued before it are refused. */
const revokedAt = new Map<string, number>();
let wired = false;

export function wireViewerRevocation(): void {
  if (wired) return;
  wired = true;
  onNotify('volt_viewer_revoke', (id) => { if (id) noteRevoked(id); });
  // While the listener was down a revocation may have been missed; the access
  // TTL bounds that window. Nothing to replay.
  onReconnect(() => { /* bounded by VIEWER_ACCESS_TTL */ });
}

export function noteRevoked(viewerId: string, atMs = Date.now()): void {
  revokedAt.set(viewerId, atMs);
  if (revokedAt.size > 200_000) {
    const cutoff = atMs - VIEWER_ACCESS_TTL * 1000;
    for (const [k, t] of revokedAt) if (t < cutoff) revokedAt.delete(k);
  }
}

export function verifyViewer(token: string): ViewerClaims {
  const d = jwt.verify(token, secret(), { audience: AUD_VIEWER, issuer: 'volt' }) as any;
  if (d?.typ !== 'viewer' || typeof d.sub !== 'string' || typeof d.acct !== 'string') throw new Error('not a viewer token');
  const r = revokedAt.get(d.sub);
  const issued = typeof d.ims === 'number' ? d.ims : d.iat * 1000;
  if (r !== undefined && issued < r) throw new Error('viewer session revoked');
  return d as ViewerClaims;
}

/** The evaluator's entitlement shape from a token's snapshot (expired ones dropped). */
export function entitlementsFromClaims(c: ViewerClaims, now = Date.now()) {
  return (c.ent ?? [])
    .filter((e) => !e.u || new Date(e.u).getTime() > now)
    .map((e) => ({ grants: e.g, validUntil: e.u ?? null, productKey: e.p ?? null }));
}

// ---- passwords and refresh tokens ---------------------------------------------------

/**
 * Viewer passwords: argon2id at the OWASP-recommended floor (19 MiB, t=2, p=1),
 * about 10-20 ms of CPU. Admin passwords keep the library default (stronger,
 * far fewer logins). Even so a mass login at kick-off is the costliest thing a
 * viewer can do: keep viewers signed in with long refresh tokens and prompt
 * sign-in before the event (SCALING.md).
 */
const VIEWER_ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export const hashViewerPassword = (pw: string) => argon2.hash(pw, VIEWER_ARGON);
export const verifyViewerPassword = (hash: string, pw: string) => argon2.verify(hash, pw);
export const DUMMY_VIEWER_HASH = '$argon2id$v=19$m=19456,t=2,p=1$aFKzzJIC5NOZ+2qoFMbHNA$gwxRixAEWLNbCF9ul1hORNutvKFdmQODKpB74LF0xTU';

export function newViewerRefresh(): { token: string; hash: string } {
  const token = 'vr_' + randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}
export const hashViewerRefresh = (t: string) => createHash('sha256').update(t).digest('hex');
