// ============================================================================
//  SINGLE SIGN-ON ROUTES (ACCESS_CONTROL.md section 14).
//
//  Public, mounted at /api/auth/sso:
//    GET  /discover?email=           connections offered for that address's domain
//    GET  /start/:id[?return=/path]  off to the provider (302)
//    GET  /oidc/callback             the provider sends people back here (302 to the console)
//    POST /saml/acs/:id              SAML Assertion Consumer Service (302 to the console)
//    GET  /saml/metadata/:id         Volt's SAML metadata for the provider
//    POST /finish { code }           the console exchanges the one-time code for a
//                                    session, or a two-step challenge
//
//  Admin, mounted at /api/sso-connections (feature "Admin users", admin tier):
//    GET / | POST / | PATCH /:id | DELETE /:id
//    POST /metadata { xml | url }    read an identity provider's SAML metadata
//    POST /:id/test                  check the provider answers as configured
//    POST /:id/domains { domain } | POST /:id/domains/:domain/verify | DELETE /:id/domains/:domain
// ============================================================================
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { one, query } from '../../db';
import { asyncHandler, badRequest, forbidden, notFound, unauthorized } from '../../util/http';
import { requireAuth, accountId } from '../middleware';
import { rankOf, ROLE_RANK } from '../roles';
import { writeAudit, actor } from '../../services/audit';
import { limit } from '../../scale/ratelimit';
import { seal, open } from '../secretBox';
import { issueAdminSession } from '../routes';
import { loadPrincipal, challengeResponse } from '../identity';
import * as S from './sso';
import * as O from './oidc';
import * as M from './saml';

// ================================================================= public

export const ssoRouter = Router();

ssoRouter.get('/discover', asyncHandler(async (req, res) => {
  await limit(`sso-discover-ip:${req.ip}`, 120, 300);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await S.discover(String(req.query.email ?? '')));
}));

const conn = async (id: string) => (/^[0-9a-f-]{36}$/i.test(id) ? one<any>(`SELECT * FROM sso_connections WHERE id = $1`, [id]) : null);

/** Back to the console with a problem it shows on the sign-in page. */
function fail(res: Response, message: string, connectionId: string | null = null) {
  void S.recordError(connectionId, message);
  res.redirect(302, `${S.consoleBase()}/?sso_error=${encodeURIComponent(message.slice(0, 300))}`);
}

ssoRouter.get('/start/:id', asyncHandler(async (req, res) => {
  await limit(`sso-start-ip:${req.ip}`, 60, 300);
  const c = await conn(String(req.params.id));
  if (!c || !c.enabled) return fail(res, 'That sign-in is not available.');
  const ret = S.safeReturn(req.query.return);
  const hint = typeof req.query.login_hint === 'string' ? req.query.login_hint.slice(0, 200) : null;
  const sp = S.spInfo(c.id);
  try {
    if (c.protocol === 'oidc') {
      const d = await O.discover(c.oidc_issuer);
      const state = O.randomToken(), nonce = O.randomToken(), verifier = O.randomToken(48);
      await S.saveRequest(state, 'oidc', c.id, { nonce, verifier, ret });
      return res.redirect(302, O.authorizeUrl({ discovery: d, clientId: c.oidc_client_id, redirectUri: sp.redirectUri, scopes: c.oidc_scopes, state, nonce, verifier, loginHint: hint }));
    }
    const relay = O.randomToken();
    await S.saveRequest(relay, 'saml-relay', c.id, { ret });
    return res.redirect(302, await M.samlStartUrl(c, sp, relay));
  } catch (e: any) { return fail(res, `${c.name}: ${String(e?.message ?? e)}`, c.id); }
}));

/** The provider vouched for someone: who they are in Volt, then a one-time code for the console. */
async function finishProvider(res: Response, c: any, raw: Record<string, any>, ret: string | null) {
  const p = S.profileFrom(c.protocol, raw, c);
  let r;
  try { r = await S.resolveUser(c, p); }
  catch (e: any) {
    if (e instanceof S.SsoRefusal) {
      await writeAudit(null, { accountId: c.account_id, userId: null, label: `sso:${c.name}`, action: 'create', entityType: 'sso_refused', entityId: c.id, snapshot: { email: p.email, reason: e.message } }).catch(() => {});
      return fail(res, e.message, c.id);
    }
    throw e;
  }
  const amr = p.mfa && c.trust_idp_mfa ? ['ext', 'mfa'] : ['ext'];
  const code = await S.createHandoff(r.userId, c.id, amr, ret);
  await writeAudit(null, { accountId: c.account_id, userId: r.userId, label: `sso:${c.name}`, action: r.created ? 'create' : 'update', entityType: 'sso_sign_in', entityId: r.userId,
    snapshot: { connection: c.name, protocol: c.protocol, email: p.email, created: r.created, linked: r.linked, providerMfa: p.mfa, groups: p.groups.slice(0, 50) } }).catch(() => {});
  res.redirect(302, `${S.consoleBase()}/?sso=${encodeURIComponent(code)}`);
}

ssoRouter.get('/oidc/callback', asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const st = q.state ? await S.takeRequest(String(q.state), 'oidc') : null;
  if (!st) return fail(res, 'That sign-in has expired or was already used. Start again.');
  const c = await conn(st.connection_id);
  if (!c || !c.enabled) return fail(res, 'That sign-in is not available.');
  if (q.error) return fail(res, `${c.name} did not sign you in: ${q.error_description || q.error}`, c.id);
  if (!q.code) return fail(res, `${c.name} sent no sign-in code.`, c.id);
  try {
    const d = await O.discover(c.oidc_issuer);
    const t = await O.exchangeCode({ discovery: d, clientId: c.oidc_client_id, clientSecret: open(c.oidc_client_secret), redirectUri: S.spInfo(c.id).redirectUri, code: q.code, verifier: st.payload.verifier });
    const claims = await O.verifyIdToken(t.id_token, { discovery: d, clientId: c.oidc_client_id, nonce: st.payload.nonce });
    // Groups or the email are sometimes only in userinfo (Google, some Okta set-ups).
    const extra = (!claims.email || (c.claim_groups && !claims[c.claim_groups])) ? await O.userinfo(d, t.access_token).catch(() => ({})) : {};
    if ((extra as any).sub && (extra as any).sub !== claims.sub) return fail(res, `${c.name} answered for two different people.`, c.id);
    return await finishProvider(res, c, { ...extra, ...claims }, st.payload.ret ?? null);
  } catch (e: any) { return fail(res, `${c.name}: ${String(e?.message ?? e)}`, c.id); }
}));

ssoRouter.post('/saml/acs/:id', express.urlencoded({ extended: false, limit: '2mb' }), asyncHandler(async (req, res) => {
  const c = await conn(String(req.params.id));
  if (!c || !c.enabled || c.protocol !== 'saml') return fail(res, 'That sign-in is not available.');
  const body = (req.body ?? {}) as Record<string, string>;
  if (!body.SAMLResponse) return fail(res, `${c.name} sent no response.`, c.id);
  const st = body.RelayState ? await S.takeRequest(String(body.RelayState), 'saml-relay') : null;
  if (!st || st.connection_id !== c.id) return fail(res, 'That sign-in has expired, was already used, or was not started from Volt. Start again from the Volt sign-in page.', c.id);
  try {
    const profile = await M.samlValidate(c, S.spInfo(c.id), { SAMLResponse: body.SAMLResponse, RelayState: body.RelayState });
    return await finishProvider(res, c, profile, st.payload.ret ?? null);
  } catch (e: any) { return fail(res, `${c.name}: ${String(e?.message ?? e)}`, c.id); }
}));

ssoRouter.get('/saml/metadata/:id', asyncHandler(async (req, res) => {
  const c = await conn(String(req.params.id));
  if (!c || c.protocol !== 'saml') throw notFound('No such SAML connection');
  res.type('application/samlmetadata+xml').send(await M.spMetadata(c, S.spInfo(c.id)));
}));

/** The console's one-time code for a session. A two-step challenge when Volt still needs one. */
ssoRouter.post('/finish', express.json(), asyncHandler(async (req, res) => {
  await limit(`sso-finish-ip:${req.ip}`, 60, 300);
  const { code } = z.object({ code: z.string().min(20).max(200) }).parse(req.body ?? {});
  const h = await S.takeHandoff(code);
  if (!h) throw unauthorized('That sign-in link has expired or was already used. Sign in again.');
  const u = await one<any>(`SELECT u.id, u.status, a.status AS account_status, a.require_admin_mfa FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.id = $1`, [h.user_id]);
  if (!u || u.status !== 'active') throw unauthorized('Your Volt user is not active.');
  if (u.account_status === 'suspended') throw unauthorized('This account is suspended, contact support');
  const amr: string[] = h.amr ?? ['ext'];
  if (!amr.includes('mfa')) {
    const p = await loadPrincipal('user', u.id);
    const step = p ? await challengeResponse(p, { required: !!u.require_admin_mfa }) : null;
    if (step) return res.json({ ...step, returnTo: h.return_to ?? null });
  }
  res.json({ ...(await issueAdminSession(u.id, amr)), returnTo: h.return_to ?? null });
}));

// ================================================================= admin

export const ssoAdminRouter = Router();
ssoAdminRouter.use(requireAuth);
/** Who signs in to an account is an administrator's decision: admin tier and up. */
ssoAdminRouter.use((req, _res, next) => (rankOf(String((req as any).auth?.role)) >= ROLE_RANK.admin ? next() : next(forbidden('Single sign-on is managed by administrators'))));

const isPrivate = (ip: string) => {
  if (isIP(ip) === 6) return /^(::1?$|fc|fd|fe80|::ffff:(127|10|192\.168|169\.254)\.)/i.test(ip) || /^::ffff:172\.(1[6-9]|2\d|3[01])\./i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};
/** Addresses an administrator gives Volt to fetch: https on a public address (no reaching into Volt's own network). */
async function publicHttps(raw: string, what: string): Promise<string> {
  let u: URL;
  try { u = new URL(raw); } catch { throw badRequest(`${what} is not a web address`); }
  const dev = process.env.NODE_ENV !== 'production' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  if (u.protocol !== 'https:' && !dev) throw badRequest(`${what} must start with https://`);
  if (!dev) {
    const addrs = await lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw badRequest(`${what}: ${u.hostname} does not resolve`);
    if (addrs.some((a) => isPrivate(a.address))) throw badRequest(`${what} points at a private network address`);
  }
  return u.toString().replace(/\/+$/, '');
}

function view(c: any, domains: any[]) {
  const sp = S.spInfo(c.id);
  return {
    id: c.id, protocol: c.protocol, name: c.name, enabled: c.enabled,
    oidc: c.protocol === 'oidc' ? { issuer: c.oidc_issuer, clientId: c.oidc_client_id, hasSecret: !!c.oidc_client_secret, scopes: c.oidc_scopes, redirectUri: sp.redirectUri } : null,
    saml: c.protocol === 'saml' ? { idpEntityId: c.saml_idp_entity_id, idpSsoUrl: c.saml_idp_sso_url, certificates: (c.saml_idp_certs ?? []).length, metadataUrl: c.saml_metadata_url,
      spEntityId: sp.entityId, acsUrl: sp.acsUrl, spMetadataUrl: sp.metadataUrl } : null,
    claims: { email: c.claim_email, name: c.claim_name, groups: c.claim_groups },
    jit: c.jit, defaultTier: c.default_tier, defaultGroupId: c.default_group_id, groupMap: c.group_map ?? [], syncGroups: c.sync_groups,
    enforce: c.enforce, trustIdpMfa: c.trust_idp_mfa, startUrl: `/api/auth/sso/start/${c.id}`,
    lastUsedAt: c.last_used_at, lastError: c.last_error, lastErrorAt: c.last_error_at, createdAt: c.created_at, updatedAt: c.updated_at,
    domains: domains.filter((d) => d.connection_id === c.id).map((d) => ({ domain: d.domain, verified: !!d.verified_at, verifiedAt: d.verified_at, checkedAt: d.checked_at, record: S.txtRecord(d.domain, d.verify_token) })),
    users: Number(c.users ?? 0),
  };
}

ssoAdminRouter.get('/', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const rows = await query<any>(`SELECT c.*, (SELECT count(DISTINCT user_id) FROM user_identities i WHERE i.connection_id = c.id)::int AS users FROM sso_connections c WHERE account_id = $1 ORDER BY created_at`, [acct]);
  const domains = await query<any>(`SELECT * FROM sso_domains WHERE account_id = $1 ORDER BY domain`, [acct]);
  const roles = await query<any>(`SELECT id, name, tier FROM user_groups WHERE account_id = $1 ORDER BY name`, [acct]);
  res.json({ connections: rows.map((c) => view(c, domains)), roles, base: S.spInfo('{id}') });
}));

const groupMap = z.array(z.object({ value: z.string().trim().min(1).max(300), groupId: z.string().uuid() })).max(100);
const body = z.object({
  protocol: z.enum(['oidc', 'saml']).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  oidcIssuer: z.string().trim().max(500).optional(),
  oidcClientId: z.string().trim().max(300).optional(),
  oidcClientSecret: z.string().max(2000).nullable().optional(),
  oidcScopes: z.string().trim().max(300).optional(),
  samlIdpEntityId: z.string().trim().max(500).nullable().optional(),
  samlIdpSsoUrl: z.string().trim().max(1000).optional(),
  samlIdpCerts: z.array(z.string().max(20000)).max(5).optional(),
  samlMetadataUrl: z.string().trim().max(1000).nullable().optional(),
  claimEmail: z.string().trim().max(300).nullable().optional(),
  claimName: z.string().trim().max(300).nullable().optional(),
  claimGroups: z.string().trim().max(300).nullable().optional(),
  jit: z.boolean().optional(),
  defaultTier: z.enum(['viewer', 'operator', 'admin']).optional(),
  defaultGroupId: z.string().uuid().nullable().optional(),
  groupMap: groupMap.optional(),
  syncGroups: z.boolean().optional(),
  enforce: z.boolean().optional(),
  trustIdpMfa: z.boolean().optional(),
});

async function save(acct: string, id: string | null, b: z.infer<typeof body>) {
  const cur = id ? await one<any>(`SELECT * FROM sso_connections WHERE id = $1 AND account_id = $2`, [id, acct]) : null;
  if (id && !cur) throw notFound('No such connection');
  const protocol = cur?.protocol ?? b.protocol;
  if (!protocol) throw badRequest('Say whether this is an OIDC or a SAML connection');
  const v: Record<string, any> = {};
  if (b.name !== undefined) v.name = b.name;
  if (b.enabled !== undefined) v.enabled = b.enabled;
  if (protocol === 'oidc') {
    if (b.oidcIssuer !== undefined) v.oidc_issuer = await publicHttps(b.oidcIssuer, 'The issuer');
    if (b.oidcClientId !== undefined) v.oidc_client_id = b.oidcClientId;
    if (b.oidcClientSecret !== undefined) v.oidc_client_secret = b.oidcClientSecret ? seal(b.oidcClientSecret) : null;
    if (b.oidcScopes !== undefined) v.oidc_scopes = /\bopenid\b/.test(b.oidcScopes) ? b.oidcScopes : `openid ${b.oidcScopes}`.trim();
  } else {
    if (b.samlIdpEntityId !== undefined) v.saml_idp_entity_id = b.samlIdpEntityId || null;
    if (b.samlIdpSsoUrl !== undefined) v.saml_idp_sso_url = await publicHttps(b.samlIdpSsoUrl, 'The sign-in URL');
    if (b.samlIdpCerts !== undefined) {
      const certs = b.samlIdpCerts.map((c) => c.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')).filter(Boolean);
      for (const c of certs) { try { new X509Certificate(Buffer.from(c, 'base64')); } catch { throw badRequest('A signing certificate is not a valid X.509 certificate'); } }
      v.saml_idp_certs = certs;
    }
    if (b.samlMetadataUrl !== undefined) v.saml_metadata_url = b.samlMetadataUrl ? await publicHttps(b.samlMetadataUrl, 'The metadata URL') : null;
  }
  for (const [k, col] of [['claimEmail', 'claim_email'], ['claimName', 'claim_name'], ['claimGroups', 'claim_groups']] as const) if (b[k] !== undefined) v[col] = b[k] || null;
  if (b.jit !== undefined) v.jit = b.jit;
  if (b.defaultTier !== undefined) v.default_tier = b.defaultTier;
  if (b.syncGroups !== undefined) v.sync_groups = b.syncGroups;
  if (b.enforce !== undefined) v.enforce = b.enforce;
  if (b.trustIdpMfa !== undefined) v.trust_idp_mfa = b.trustIdpMfa;
  const roleIds = [...(b.defaultGroupId ? [b.defaultGroupId] : []), ...(b.groupMap ?? []).map((m) => m.groupId)];
  if (roleIds.length) {
    const ok = await query<any>(`SELECT id FROM user_groups WHERE account_id = $1 AND id = ANY($2::uuid[])`, [acct, roleIds]);
    if (ok.length !== new Set(roleIds).size) throw badRequest('A role in the mapping is not one of this account\'s roles');
  }
  if (b.defaultGroupId !== undefined) v.default_group_id = b.defaultGroupId;
  if (b.groupMap !== undefined) v.group_map = JSON.stringify(b.groupMap);
  if (!cur) {
    if (!v.name) throw badRequest('Give the connection a name, for example "Microsoft Entra ID"');
    if (protocol === 'oidc' && (!v.oidc_issuer || !v.oidc_client_id)) throw badRequest('An OIDC connection needs the issuer URL and the client ID');
    if (protocol === 'saml' && !v.saml_idp_sso_url) throw badRequest('A SAML connection needs the provider\'s sign-in URL (or its metadata)');
    const cols = ['account_id', 'protocol', ...Object.keys(v)];
    const vals = [acct, protocol, ...Object.values(v)];
    return (await one<any>(`INSERT INTO sso_connections (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals))!;
  }
  if (!Object.keys(v).length) return cur;
  const sets = Object.keys(v).map((k, i) => `${k} = $${i + 3}`).join(', ');
  return (await one<any>(`UPDATE sso_connections SET ${sets}, updated_at = now() WHERE id = $1 AND account_id = $2 RETURNING *`, [id, acct, ...Object.values(v)]))!;
}

async function answer(req: Request, id: string) {
  const acct = accountId(req);
  const c = await one<any>(`SELECT c.*, (SELECT count(DISTINCT user_id) FROM user_identities i WHERE i.connection_id = c.id)::int AS users FROM sso_connections c WHERE id = $1 AND account_id = $2`, [id, acct]);
  if (!c) throw notFound('No such connection');
  return view(c, await query<any>(`SELECT * FROM sso_domains WHERE connection_id = $1 ORDER BY domain`, [id]));
}
const audit = (req: Request, action: 'create' | 'update' | 'delete', id: string, snapshot: any) => {
  const { userId, label } = actor(req);
  return writeAudit(null, { accountId: accountId(req), userId, label, action, entityType: 'sso_connection', entityId: id, snapshot });
};
const safe = (b: any) => ({ ...b, ...(b.oidcClientSecret !== undefined ? { oidcClientSecret: b.oidcClientSecret ? '(set)' : null } : {}), ...(b.samlIdpCerts ? { samlIdpCerts: `${b.samlIdpCerts.length} certificate(s)` } : {}) });

ssoAdminRouter.post('/', express.json(), asyncHandler(async (req, res) => {
  const b = body.parse(req.body ?? {});
  const c = await save(accountId(req), null, b);
  await audit(req, 'create', c.id, safe(b));
  res.status(201).json(await answer(req, c.id));
}));

ssoAdminRouter.patch('/:id', express.json(), asyncHandler(async (req, res) => {
  const b = body.omit({ protocol: true }).parse(req.body ?? {});
  const c = await save(accountId(req), String(req.params.id), b);
  await audit(req, 'update', c.id, safe(b));
  res.json(await answer(req, c.id));
}));

ssoAdminRouter.delete('/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const c = await one<any>(`DELETE FROM sso_connections WHERE id = $1 AND account_id = $2 RETURNING id, name`, [String(req.params.id), acct]);
  if (!c) throw notFound('No such connection');
  await audit(req, 'delete', c.id, { name: c.name });
  res.json({ deleted: true });
}));

/** An identity provider's SAML metadata (pasted, or fetched from its URL): entity ID, sign-in URL, certificates. */
ssoAdminRouter.post('/metadata', express.json({ limit: '2mb' }), asyncHandler(async (req, res) => {
  const b = z.object({ xml: z.string().max(1_500_000).optional(), url: z.string().max(1000).optional() }).parse(req.body ?? {});
  let xml = b.xml ?? '';
  if (!xml && b.url) {
    const url = await publicHttps(b.url, 'The metadata URL');
    const r = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error' }).catch((e) => { throw badRequest(`The metadata did not load: ${e.message}`); });
    if (!r.ok) throw badRequest(`The metadata did not load (${r.status})`);
    xml = (await r.text()).slice(0, 1_500_000);
  }
  if (!xml) throw badRequest('Paste the metadata XML or give its URL');
  const m = M.parseIdpMetadata(xml);
  if (!m.ssoUrl) throw badRequest('No SingleSignOnService found in that metadata');
  const certs = m.certs.map((c) => {
    try { const x = new X509Certificate(Buffer.from(c, 'base64')); return { subject: x.subject, validTo: x.validTo }; } catch { return { subject: '?', validTo: null }; }
  });
  res.json({ ...m, certInfo: certs });
}));

ssoAdminRouter.post('/:id/test', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const c = await one<any>(`SELECT * FROM sso_connections WHERE id = $1 AND account_id = $2`, [String(req.params.id), acct]);
  if (!c) throw notFound('No such connection');
  const checks: { ok: boolean; check: string; detail?: string }[] = [];
  if (c.protocol === 'oidc') {
    try {
      const d = await O.discover(c.oidc_issuer, true);
      checks.push({ ok: true, check: 'Discovery document', detail: d.issuer });
      const r = await fetch(d.jwks_uri, { signal: AbortSignal.timeout(8000) });
      const n = ((await r.json().catch(() => ({}))) as any).keys?.length ?? 0;
      checks.push({ ok: r.ok && n > 0, check: 'Signing keys', detail: `${n} key${n === 1 ? '' : 's'}` });
    } catch (e: any) { checks.push({ ok: false, check: 'Discovery document', detail: String(e?.message ?? e) }); }
    checks.push({ ok: !!c.oidc_client_id, check: 'Client ID' });
    checks.push({ ok: true, check: 'Client secret', detail: c.oidc_client_secret ? 'set' : 'none (a public client with PKCE: allowed when the provider permits it)' });
  } else {
    checks.push({ ok: !!c.saml_idp_sso_url, check: 'Sign-in URL', detail: c.saml_idp_sso_url ?? 'missing' });
    for (const cert of c.saml_idp_certs ?? []) {
      try { const x = new X509Certificate(Buffer.from(cert, 'base64')); const left = (Date.parse(x.validTo) - Date.now()) / 86400_000;
        checks.push({ ok: left > 0, check: 'Signing certificate', detail: `${x.subject.split('\n').find((l) => l.startsWith('CN=')) ?? x.subject}, valid to ${x.validTo}${left < 30 && left > 0 ? ' (renew soon)' : left <= 0 ? ' (EXPIRED)' : ''}` });
      } catch { checks.push({ ok: false, check: 'Signing certificate', detail: 'not readable' }); }
    }
    if (!(c.saml_idp_certs ?? []).length) checks.push({ ok: false, check: 'Signing certificate', detail: 'missing' });
    try { await M.spMetadata(c, S.spInfo(c.id)); checks.push({ ok: true, check: 'SAML library' }); } catch (e: any) { checks.push({ ok: false, check: 'SAML library', detail: String(e?.message ?? e) }); }
  }
  const verified = await one<any>(`SELECT count(*) FILTER (WHERE verified_at IS NOT NULL)::int AS v, count(*)::int AS n FROM sso_domains WHERE connection_id = $1`, [c.id]);
  checks.push({ ok: Number(verified?.v) > 0, check: 'Verified domains', detail: `${verified?.v ?? 0} of ${verified?.n ?? 0}` });
  res.json({ ok: checks.every((x) => x.ok), checks });
}));

ssoAdminRouter.post('/:id/domains', express.json(), asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const id = String(req.params.id);
  if (!(await one(`SELECT 1 FROM sso_connections WHERE id = $1 AND account_id = $2`, [id, acct]))) throw notFound('No such connection');
  const { domain } = z.object({ domain: z.string().trim().min(3).max(253) }).parse(req.body ?? {});
  const d = await S.addDomain(acct, id, domain);
  await audit(req, 'update', id, { domainAdded: d.domain });
  res.status(201).json({ domain: d.domain, verified: !!d.verified_at, record: S.txtRecord(d.domain, d.verify_token) });
}));

ssoAdminRouter.post('/:id/domains/:domain/verify', asyncHandler(async (req, res) => {
  const r = await S.verifyDomain(accountId(req), String(req.params.id), String(req.params.domain));
  if (r.verified) await audit(req, 'update', String(req.params.id), { domainVerified: String(req.params.domain) });
  res.json(r);
}));

ssoAdminRouter.delete('/:id/domains/:domain', asyncHandler(async (req, res) => {
  const r = await one<any>(`DELETE FROM sso_domains WHERE domain = $1 AND connection_id = $2 AND account_id = $3 RETURNING domain`, [String(req.params.domain).toLowerCase(), String(req.params.id), accountId(req)]);
  if (!r) throw notFound('No such domain on this connection');
  await audit(req, 'update', String(req.params.id), { domainRemoved: r.domain });
  res.json({ removed: r.domain });
}));
