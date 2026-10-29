// ============================================================================
//  SINGLE SIGN-ON: connections, domains, who a provider's person is in Volt,
//  and the rules (ACCESS_CONTROL.md section 14). Protocols: oidc.ts, saml.ts.
//
//  THE RULES, in the order they are applied when a provider sends someone back:
//   1. The provider's subject already linked to a Volt user: that user.
//   2. Otherwise the email. Volt trusts a provider's email only for a domain
//      the connection has VERIFIED (DNS TXT), so a provider cannot claim
//      addresses it does not own. A user with that email in this account is
//      linked; one in another Volt account is refused (an email is one user).
//   3. Nobody yet: created on first sign-in when the connection allows it,
//      at the connection's tier with the roles its groups map to.
//   A disabled user stays out. Nobody becomes an owner through SSO.
//
//   Roles: the provider's groups map to Volt roles. On creation always; at
//   every sign-in when "sync" is on (mapped roles added and removed, roles the
//   map does not mention left alone). The tier follows the highest mapped role,
//   never above admin.
//
//   Two-step sign-in: when the provider says it did one (OIDC amr / acr, SAML
//   authentication context) and the connection trusts it, the Volt session
//   counts as two-step. Otherwise the person's own Volt methods apply, and an
//   account that requires two-step for admins asks for it as after a password.
//
//   Compulsory SSO: a connection that enforces it closes password sign-in for
//   users whose email is in its verified domains. Owners keep their password
//   (with two-step) so a broken provider cannot lock an account out.
// ============================================================================
import { createHash, randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { one, query, tx } from '../../db';
import { config } from '../../config';

export type Protocol = 'oidc' | 'saml';
export interface Profile { subject: string; email: string | null; emailVerified: boolean; name: string | null; groups: string[]; mfa: boolean }

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const domainOf = (email: string | null | undefined) => (String(email ?? '').split('@')[1] ?? '').trim().toLowerCase() || null;

/** Where the provider sends people back to, and Volt's SAML identity. */
export function spInfo(connectionId: string) {
  const base = (process.env.SSO_BASE_URL || config.publicBaseUrl).replace(/\/+$/, '');
  return {
    redirectUri: `${base}/api/auth/sso/oidc/callback`,
    entityId: `${base}/api/auth/sso/saml/metadata/${connectionId}`,
    acsUrl: `${base}/api/auth/sso/saml/acs/${connectionId}`,
    metadataUrl: `${base}/api/auth/sso/saml/metadata/${connectionId}`,
  };
}
/** The console, where a finished sign-in lands (?sso=<code> or ?sso_error=...). */
export const consoleBase = () => (process.env.CONSOLE_BASE_URL || process.env.SSO_BASE_URL || config.publicBaseUrl).replace(/\/+$/, '');

// ---------------------------------------------------------------- claims

const first = (...v: unknown[]) => { for (const x of v) { const s = Array.isArray(x) ? x[0] : x; if (typeof s === 'string' && s.trim()) return s.trim(); } return null; };
const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;]\s*/) : []).map((x) => String(x).trim()).filter(Boolean);
const looksEmail = (s: string | null) => !!s && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

const SAML_EMAIL = ['email', 'mail', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'urn:oid:0.9.2342.19200300.100.1.3', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn', 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6'];
const SAML_NAME = ['displayName', 'http://schemas.microsoft.com/identity/claims/displayname', 'name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name', 'cn', 'urn:oid:2.16.840.1.113730.3.1.241'];
const SAML_GROUPS = ['groups', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups', 'memberOf', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role', 'Role', 'urn:oid:1.3.6.1.4.1.5923.1.5.1.1'];
const MFA_AMR = new Set(['mfa', 'otp', 'hwk', 'swk', 'sms', 'fpt', 'face', 'iris', 'retina', 'pop', 'mca', 'sc', 'tel', 'vbm']);

/** A provider's answer as Volt needs it. `conn` may name the claims to use. */
export function profileFrom(protocol: Protocol, raw: Record<string, any>, conn: { claim_email?: string | null; claim_name?: string | null; claim_groups?: string | null }): Profile {
  if (protocol === 'oidc') {
    const email = first(conn.claim_email ? raw[conn.claim_email] : null, raw.email, looksEmail(raw.preferred_username) ? raw.preferred_username : null, raw.upn);
    const amr = list(raw.amr).map((x) => x.toLowerCase());
    return {
      subject: String(raw.sub), email: email?.toLowerCase() ?? null,
      // A provider that says the address is NOT verified is not believed about it.
      emailVerified: raw.email_verified !== false && raw.email_verified !== 'false',
      name: first(conn.claim_name ? raw[conn.claim_name] : null, raw.name, [raw.given_name, raw.family_name].filter(Boolean).join(' ')),
      groups: list(conn.claim_groups ? raw[conn.claim_groups] : raw.groups ?? raw.roles),
      mfa: amr.some((a) => MFA_AMR.has(a)) || /mfa|multi/i.test(String(raw.acr ?? '')),
    };
  }
  const attrs = (keys: string[]) => keys.map((k) => raw[k]);
  const nameId = typeof raw.nameID === 'string' ? raw.nameID : null;
  const email = first(conn.claim_email ? raw[conn.claim_email] : null, ...attrs(SAML_EMAIL), looksEmail(nameId) ? nameId : null);
  const xml: string = typeof raw.getAssertionXml === 'function' ? String(raw.getAssertionXml()) : '';
  const ctx = /AuthnContextClassRef>([^<]+)</.exec(xml)?.[1] ?? '';
  const methods = list(raw['http://schemas.microsoft.com/claims/authnmethodsreferences']);
  const groups = conn.claim_groups ? list(raw[conn.claim_groups]) : [...new Set(SAML_GROUPS.flatMap((k) => list(raw[k])))];
  return {
    subject: `${raw.issuer ?? ''}|${nameId ?? ''}`, email: email?.toLowerCase() ?? null, emailVerified: true,
    name: first(conn.claim_name ? raw[conn.claim_name] : null, ...attrs(SAML_NAME),
      [raw['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'], raw['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname']].filter(Boolean).join(' ')),
    groups,
    mfa: methods.some((m) => /multipleauthn|mfa|otp/i.test(m)) || /multifactor|mfa|refeds\.org\/profile\/mfa|TimeSyncToken|Smartcard/i.test(ctx),
  };
}

// ---------------------------------------------------------------- domains

const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
/** Addresses at these are personal mail, not an organisation's: no connection may claim them. */
const PUBLIC_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'web.de', 'yandex.com', 'mail.com', 'zoho.com', 'bigpond.com', 'qq.com', '163.com']);

export function txtRecord(domain: string, token: string) { return { name: `_volt-sso.${domain}`, value: `volt-sso-verification=${token}` }; }

export async function addDomain(acct: string, connectionId: string, raw: string) {
  const domain = raw.trim().toLowerCase().replace(/^@/, '');
  if (!DOMAIN.test(domain)) throw Object.assign(new Error(`"${raw}" is not a domain`), { status: 400 });
  if (PUBLIC_MAIL.has(domain)) throw Object.assign(new Error(`${domain} is a public mail service: anyone can have an address there, so it cannot be one organisation's sign-in`), { status: 400 });
  const taken = await one<any>(`SELECT connection_id, account_id FROM sso_domains WHERE domain = $1`, [domain]);
  if (taken && taken.connection_id !== connectionId) throw Object.assign(new Error(taken.account_id === acct ? `${domain} already belongs to another of this account's connections` : `${domain} is already used for sign-in by another Volt account`), { status: 409 });
  const token = randomBytes(18).toString('base64url');
  await query(`INSERT INTO sso_domains (domain, connection_id, account_id, verify_token) VALUES ($1,$2,$3,$4) ON CONFLICT (domain) DO NOTHING`, [domain, connectionId, acct, token]);
  return (await one<any>(`SELECT * FROM sso_domains WHERE domain = $1`, [domain]))!;
}

let resolver: (name: string) => Promise<string[][]> = resolveTxt;
export function _setResolver(f: typeof resolver) { resolver = f; }

/** Look for the TXT record now. Verified stays verified; a domain can be re-checked any time. */
export async function verifyDomain(acct: string, connectionId: string, domain: string): Promise<{ verified: boolean; found: string[]; expected: { name: string; value: string } }> {
  const d = await one<any>(`SELECT * FROM sso_domains WHERE domain = $1 AND connection_id = $2 AND account_id = $3`, [domain.toLowerCase(), connectionId, acct]);
  if (!d) throw Object.assign(new Error('No such domain on this connection'), { status: 404 });
  const rec = txtRecord(d.domain, d.verify_token);
  let found: string[] = [];
  try { found = (await resolver(rec.name)).map((parts) => parts.join('')); } catch { found = []; }
  const ok = found.includes(rec.value);
  await query(`UPDATE sso_domains SET checked_at = now(), verified_at = CASE WHEN $2 THEN COALESCE(verified_at, now()) ELSE verified_at END WHERE domain = $1`, [d.domain, ok]);
  return { verified: ok || !!d.verified_at, found, expected: rec };
}

/** Which connections to offer for an email address (by its domain only: nothing about whether the person exists). */
export async function discover(email: string) {
  const domain = domainOf(email);
  if (!domain) return { connections: [], required: false };
  const rows = await query<any>(`SELECT c.id, c.name, c.protocol, c.enforce FROM sso_domains d JOIN sso_connections c ON c.id = d.connection_id
                                  WHERE d.domain = $1 AND d.verified_at IS NOT NULL AND c.enabled`, [domain]);
  return { connections: rows.map((r) => ({ id: r.id, name: r.name, protocol: r.protocol })), required: rows.some((r) => r.enforce) };
}

/** Must this user sign in through SSO (password closed)? Owners never: they are the way back in. */
export async function ssoRequiredFor(user: { id: string; account_id: string; role: string; email?: string }): Promise<{ id: string; name: string } | null> {
  if (user.role === 'owner') return null;
  const email = user.email ?? (await one<any>(`SELECT email::text AS email FROM users WHERE id = $1`, [user.id]))?.email;
  const domain = domainOf(email);
  if (!domain) return null;
  return one<any>(`SELECT c.id, c.name FROM sso_domains d JOIN sso_connections c ON c.id = d.connection_id
                    WHERE d.domain = $1 AND d.verified_at IS NOT NULL AND c.enabled AND c.enforce AND c.account_id = $2 LIMIT 1`, [domain, user.account_id]);
}

// ---------------------------------------------------------------- requests and hand-offs

export async function saveRequest(state: string, kind: string, connectionId: string, payload: Record<string, unknown>) {
  await query(`DELETE FROM sso_requests WHERE expires_at < now() - interval '1 hour'`).catch(() => {});
  await query(`INSERT INTO sso_requests (state, kind, connection_id, payload, expires_at) VALUES ($1,$2,$3,$4, now() + interval '10 minutes')`, [state, kind, connectionId, JSON.stringify(payload)]);
}
/** Single use: the row is deleted as it is read. */
export async function takeRequest(state: string, kind: string): Promise<{ connection_id: string; payload: any } | null> {
  return one<any>(`DELETE FROM sso_requests WHERE state = $1 AND kind = $2 AND expires_at > now() RETURNING connection_id, payload`, [state, kind]);
}

export async function createHandoff(userId: string, connectionId: string, amr: string[], returnTo: string | null): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  await query(`INSERT INTO sso_handoffs (code_hash, user_id, connection_id, amr, return_to, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '2 minutes')`, [sha(code), userId, connectionId, amr, returnTo]);
  return code;
}
export async function takeHandoff(code: string) {
  return one<any>(`UPDATE sso_handoffs SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id, connection_id, amr, return_to`, [sha(code)]);
}

/** Only a path inside the console: never another site. */
export const safeReturn = (r: unknown) => (typeof r === 'string' && /^\/(?!\/)[^\s\\]*$/.test(r) ? r : null);

// ---------------------------------------------------------------- the person

export class SsoRefusal extends Error { constructor(message: string) { super(message); this.name = 'SsoRefusal'; } }

const TIER_RANK: Record<string, number> = { viewer: 1, operator: 2, admin: 3 };

/** Who the provider's person is in Volt (creating or linking them as the rules allow). Answers the user id. */
export async function resolveUser(conn: any, p: Profile): Promise<{ userId: string; created: boolean; linked: boolean }> {
  const linked = await one<any>(`SELECT u.id, u.status, u.account_id FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.connection_id = $1 AND i.subject = $2`, [conn.id, p.subject]);
  let userId: string | null = null, created = false, link = false;
  if (linked) {
    if (linked.account_id !== conn.account_id) throw new SsoRefusal('This sign-in is linked to another Volt account.');
    if (linked.status === 'disabled') throw new SsoRefusal('Your Volt user is disabled. Ask an administrator.');
    userId = linked.id;
  } else {
    if (!p.email) throw new SsoRefusal('The provider did not send an email address, so Volt cannot tell who you are. Ask your administrator to release the email claim.');
    if (!p.emailVerified) throw new SsoRefusal(`The provider says ${p.email} is not verified.`);
    const domain = domainOf(p.email);
    const ok = await one<any>(`SELECT 1 AS x FROM sso_domains WHERE domain = $1 AND connection_id = $2 AND verified_at IS NOT NULL`, [domain, conn.id]);
    if (!ok) throw new SsoRefusal(`${domain} is not a verified domain of the ${conn.name} sign-in, so Volt does not accept addresses there from it.`);
    const u = await one<any>(`SELECT id, account_id, status, role FROM users WHERE email = $1`, [p.email]);
    if (u) {
      if (u.account_id !== conn.account_id) throw new SsoRefusal(`${p.email} is a user of another Volt account.`);
      if (u.status === 'disabled') throw new SsoRefusal('Your Volt user is disabled. Ask an administrator.');
      userId = u.id; link = true;
      if (u.status === 'invited') await query(`UPDATE users SET status = 'active' WHERE id = $1`, [u.id]);
    } else {
      if (!conn.jit) throw new SsoRefusal(`There is no Volt user for ${p.email}. Ask an administrator to invite you.`);
      // A real argon2id hash of random bytes nobody holds: no password works until one is set.
      const unusable = await (await import('../password')).hashPassword(randomBytes(32).toString('base64url'));
      userId = (await one<any>(`INSERT INTO users (account_id, email, password_hash, role, status) VALUES ($1,$2,$3,$4,'active') RETURNING id`,
        [conn.account_id, p.email, unusable, conn.default_tier]))!.id;
      created = true; link = true;
      if (p.name) await query(`UPDATE users SET display_name = $2 WHERE id = $1`, [userId, p.name]).catch(() => {});
    }
    await query(`INSERT INTO user_identities (user_id, connection_id, subject, email) VALUES ($1,$2,$3,$4) ON CONFLICT (connection_id, subject) DO NOTHING`, [userId, conn.id, p.subject, p.email]);
  }
  if (created || conn.sync_groups) await applyRoles(conn, userId!, p.groups, created);
  await query(`UPDATE user_identities SET last_login_at = now(), email = COALESCE($3, email) WHERE connection_id = $1 AND subject = $2`, [conn.id, p.subject, p.email]);
  await query(`UPDATE sso_connections SET last_used_at = now(), last_error = NULL WHERE id = $1`, [conn.id]);
  return { userId: userId!, created, linked: link };
}

/** The provider's groups to Volt roles (and the tier with them, never above admin, never on an owner). */
export async function applyRoles(conn: any, userId: string, groups: string[], created: boolean) {
  const map: { value: string; groupId: string }[] = Array.isArray(conn.group_map) ? conn.group_map : [];
  const want = new Set(map.filter((m) => groups.some((g) => g.toLowerCase() === String(m.value).toLowerCase())).map((m) => m.groupId));
  if (created && !want.size && conn.default_group_id) want.add(conn.default_group_id);
  const mapped = new Set(map.map((m) => m.groupId));
  await tx(async (c) => {
    const u = (await c.query(`SELECT role FROM users WHERE id = $1`, [userId])).rows[0];
    if (!u || u.role === 'owner') return;
    for (const g of want) await c.query(`INSERT INTO user_group_members (user_id, group_id) SELECT $1, id FROM user_groups WHERE id = $2 AND account_id = $3 ON CONFLICT DO NOTHING`, [userId, g, conn.account_id]);
    if (!created) {
      const drop = [...mapped].filter((g) => !want.has(g));
      if (drop.length) await c.query(`DELETE FROM user_group_members WHERE user_id = $1 AND group_id = ANY($2::uuid[])`, [userId, drop]);
    }
    const tiers = (await c.query(`SELECT tier FROM user_groups WHERE id = ANY($1::uuid[])`, [[...want]])).rows.map((r: any) => r.tier);
    const best = [conn.default_tier, ...tiers].filter((t) => TIER_RANK[t]).sort((a, b) => TIER_RANK[b] - TIER_RANK[a])[0] ?? 'operator';
    if (created || conn.sync_groups) await c.query(`UPDATE users SET role = $2 WHERE id = $1 AND role <> 'owner'`, [userId, best]);
  });
}

export async function recordError(connectionId: string | null, message: string) {
  if (connectionId) await query(`UPDATE sso_connections SET last_error = $2, last_error_at = now() WHERE id = $1`, [connectionId, message.slice(0, 500)]).catch(() => {});
}
