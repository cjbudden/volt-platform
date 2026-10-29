// ============================================================================
//  SINGLE SIGN-ON: OpenID Connect (ACCESS_CONTROL.md section 14).
//
//  Authorization code flow with PKCE (S256), state and nonce, for any
//  OpenID Provider with a discovery document: Microsoft Entra ID, Okta, Google
//  Workspace, Auth0, Keycloak, Ping, OneLogin. No library beyond what Volt
//  already uses: the discovery document and the provider's signing keys
//  (JWKS) are fetched and cached, keys become Node KeyObjects, and the ID
//  token is checked with jsonwebtoken: signature, issuer, audience,
//  expiry, nonce, and azp when there is more than one audience.
// ============================================================================
import { createHash, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';

export interface OidcDiscovery {
  issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string;
  userinfo_endpoint?: string; end_session_endpoint?: string; id_token_signing_alg_values_supported?: string[];
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));
export const pkceChallenge = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

const TTL_MS = 3600_000;
const discoveryCache = new Map<string, { at: number; doc: OidcDiscovery }>();
const jwksCache = new Map<string, { at: number; keys: Map<string, KeyObject>; any: KeyObject[] }>();

type Fetch = typeof fetch;
let fetcher: Fetch = (...a) => fetch(...a);
/** Tests point this at a local provider. */
export function _setFetch(f: Fetch) { fetcher = f; discoveryCache.clear(); jwksCache.clear(); }

/** Issuer URL to discovery document (cached an hour). The issuer in the document must be the one configured. */
export async function discover(issuer: string, force = false): Promise<OidcDiscovery> {
  const iss = issuer.replace(/\/+$/, '');
  const hit = discoveryCache.get(iss);
  if (hit && !force && Date.now() - hit.at < TTL_MS) return hit.doc;
  const r = await fetcher(`${iss}/.well-known/openid-configuration`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`The provider's discovery document did not load (${r.status}) from ${iss}/.well-known/openid-configuration`);
  const doc = await r.json() as OidcDiscovery;
  for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) if (!doc[k]) throw new Error(`The discovery document has no ${k}`);
  if (doc.issuer.replace(/\/+$/, '') !== iss) throw new Error(`The discovery document says its issuer is ${doc.issuer}, not ${iss}`);
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) if (!/^https:\/\//.test(doc[k]) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(doc[k])) throw new Error(`${k} must be https`);
  discoveryCache.set(iss, { at: Date.now(), doc });
  return doc;
}

async function signingKeys(jwksUri: string, force = false) {
  const hit = jwksCache.get(jwksUri);
  if (hit && !force && Date.now() - hit.at < TTL_MS) return hit;
  const r = await fetcher(jwksUri, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`The provider's signing keys did not load (${r.status})`);
  const body = await r.json() as { keys?: any[] };
  const keys = new Map<string, KeyObject>(), any: KeyObject[] = [];
  for (const k of body.keys ?? []) {
    if (k.use && k.use !== 'sig') continue;
    try { const ko = createPublicKey({ key: k, format: 'jwk' }); any.push(ko); if (k.kid) keys.set(k.kid, ko); } catch { /* a key type we do not use */ }
  }
  const v = { at: Date.now(), keys, any };
  jwksCache.set(jwksUri, v);
  return v;
}

export interface AuthorizeInput { discovery: OidcDiscovery; clientId: string; redirectUri: string; scopes: string; state: string; nonce: string; verifier: string; loginHint?: string | null; prompt?: string | null }
export function authorizeUrl(i: AuthorizeInput): string {
  const u = new URL(i.discovery.authorization_endpoint);
  const q: Record<string, string> = {
    response_type: 'code', client_id: i.clientId, redirect_uri: i.redirectUri, scope: i.scopes || 'openid email profile',
    state: i.state, nonce: i.nonce, code_challenge: pkceChallenge(i.verifier), code_challenge_method: 'S256',
  };
  if (i.loginHint) q.login_hint = i.loginHint;
  if (i.prompt) q.prompt = i.prompt;
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
}

export interface TokenInput { discovery: OidcDiscovery; clientId: string; clientSecret: string | null; redirectUri: string; code: string; verifier: string }
/** Code for tokens: client_secret_basic when there is a secret (public client with PKCE alone otherwise). */
export async function exchangeCode(i: TokenInput): Promise<{ id_token: string; access_token?: string }> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: i.code, redirect_uri: i.redirectUri, code_verifier: i.verifier });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (i.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(i.clientId)}:${encodeURIComponent(i.clientSecret)}`).toString('base64')}`;
  else body.set('client_id', i.clientId);
  const r = await fetcher(i.discovery.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`The provider refused the sign-in code: ${j.error_description || j.error || r.status}`);
  if (!j.id_token) throw new Error('The provider answered without an ID token (is the openid scope allowed?)');
  return j;
}

/** Check an ID token and answer its claims. A key we have not seen makes one fresh fetch of the key set (rotation). */
export async function verifyIdToken(idToken: string, o: { discovery: OidcDiscovery; clientId: string; nonce: string; clockSkewSec?: number }): Promise<Record<string, any>> {
  const header = jwt.decode(idToken, { complete: true })?.header;
  if (!header) throw new Error('The ID token is not a JWT');
  const allowed = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];
  if (!allowed.includes(header.alg)) throw new Error(`ID tokens signed with ${header.alg} are not accepted`);
  let ks = await signingKeys(o.discovery.jwks_uri);
  let key = header.kid ? ks.keys.get(header.kid) : ks.any[0];
  if (!key) { ks = await signingKeys(o.discovery.jwks_uri, true); key = header.kid ? ks.keys.get(header.kid) : ks.any[0]; }
  if (!key) throw new Error('The ID token was signed with a key the provider does not publish');
  const claims = jwt.verify(idToken, key, {
    algorithms: allowed as jwt.Algorithm[], issuer: o.discovery.issuer, audience: o.clientId, clockTolerance: o.clockSkewSec ?? 60,
  }) as Record<string, any>;
  if (claims.nonce !== o.nonce) throw new Error('The ID token does not answer this sign-in (nonce)');
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== o.clientId) throw new Error('The ID token was issued to another client (azp)');
  if (!claims.sub) throw new Error('The ID token has no subject');
  return claims;
}

/** Extra claims some providers keep out of the ID token (Google groups, Okta profile): from userinfo, when offered. */
export async function userinfo(discovery: OidcDiscovery, accessToken?: string): Promise<Record<string, any>> {
  if (!discovery.userinfo_endpoint || !accessToken) return {};
  const r = await fetcher(discovery.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  return r.ok ? (await r.json().catch(() => ({}))) as Record<string, any> : {};
}
