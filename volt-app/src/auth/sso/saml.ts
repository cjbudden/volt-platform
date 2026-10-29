// ============================================================================
//  SINGLE SIGN-ON: SAML 2.0 (ACCESS_CONTROL.md section 14).
//
//  Service-provider-initiated sign-in: Volt sends an AuthnRequest to the
//  identity provider (HTTP-Redirect), the provider posts a signed response to
//  Volt's Assertion Consumer Service. The response is checked by
//  @node-saml/node-saml (MIT): XML signature against the provider's
//  certificate(s), issuer, audience (Volt's entity ID), destination, time
//  conditions, and InResponseTo against requests Volt actually sent (kept in
//  the database, so any server can finish a sign-in another started, and a
//  response can be used once). Unsolicited (IdP-initiated) responses are refused.
//
//  The library is loaded when first needed, so the rest of Volt runs without it
//  (npm install adds it; package.json lists it).
// ============================================================================
import { query, one } from '../../db';

export interface IdpMetadata { entityId: string | null; ssoUrl: string | null; ssoBinding: 'redirect' | 'post' | null; certs: string[] }

const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1] ?? null;

/** What an identity provider's metadata says: its entity ID, sign-in URL and signing certificates. */
export function parseIdpMetadata(xml: string): IdpMetadata {
  const s = xml.replace(/<!--[\s\S]*?-->/g, '');
  const ed = /<(?:\w+:)?EntityDescriptor\b[^>]*>/i.exec(s)?.[0] ?? '';
  const idp = /<(?:\w+:)?IDPSSODescriptor\b[\s\S]*?<\/(?:\w+:)?IDPSSODescriptor>/i.exec(s)?.[0] ?? s;
  const services = [...idp.matchAll(/<(?:\w+:)?SingleSignOnService\b[^>]*>/gi)].map((m) => m[0]);
  const pick = (b: string) => services.find((t) => (attr(t, 'Binding') ?? '').endsWith(b));
  const red = pick('HTTP-Redirect'), post = pick('HTTP-POST');
  const certs: string[] = [];
  for (const kd of idp.matchAll(/<(?:\w+:)?KeyDescriptor\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?KeyDescriptor>/gi)) {
    const use = attr(`<x ${kd[1]}>`, 'use');
    if (use && use !== 'signing') continue;
    for (const c of kd[2].matchAll(/<(?:\w+:)?X509Certificate>([\s\S]*?)<\/(?:\w+:)?X509Certificate>/gi)) {
      const b = c[1].replace(/\s+/g, '');
      if (b && !certs.includes(b)) certs.push(b);
    }
  }
  return { entityId: attr(ed, 'entityID'), ssoUrl: attr(red ?? post ?? '', 'Location'), ssoBinding: red ? 'redirect' : post ? 'post' : null, certs };
}

/** A certificate as PEM, whether pasted as PEM or bare base64. */
export function toPem(cert: string): string {
  const b = cert.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  return `-----BEGIN CERTIFICATE-----\n${b.match(/.{1,64}/g)?.join('\n') ?? b}\n-----END CERTIFICATE-----`;
}

/** InResponseTo store in the database: a response must answer a request Volt sent in the last 10 minutes, once. */
const cacheProvider = {
  async saveAsync(key: string, value: string) {
    await query(`INSERT INTO sso_requests (state, kind, payload, expires_at) VALUES ($1, 'saml', $2, now() + interval '10 minutes') ON CONFLICT (state) DO NOTHING`, [`saml:${key}`, JSON.stringify({ v: value })]);
    return { value, createdAt: Date.now() };
  },
  async getAsync(key: string) {
    const r = await one<any>(`SELECT payload FROM sso_requests WHERE state = $1 AND expires_at > now()`, [`saml:${key}`]);
    return r ? String(r.payload?.v ?? '') : null;
  },
  async removeAsync(key: string | null) {
    if (!key) return null;
    const r = await one<any>(`DELETE FROM sso_requests WHERE state = $1 RETURNING payload`, [`saml:${key}`]);
    return r ? String(r.payload?.v ?? '') : null;
  },
};

export interface SamlConn { id: string; saml_idp_entity_id: string | null; saml_idp_sso_url: string | null; saml_idp_certs: string[] }
export interface SpInfo { entityId: string; acsUrl: string }

const LIB = '@node-saml/node-saml';
async function lib(): Promise<any> {
  try { return await import(LIB); }
  catch { throw new Error('SAML needs the @node-saml/node-saml package: run npm install in volt-app.'); }
}

async function saml(c: SamlConn, sp: SpInfo): Promise<any> {
  if (!c.saml_idp_sso_url || !c.saml_idp_certs?.length) throw new Error('This SAML connection needs the provider\'s sign-in URL and signing certificate.');
  const { SAML } = await lib();
  return new SAML({
    callbackUrl: sp.acsUrl, entryPoint: c.saml_idp_sso_url, issuer: sp.entityId, audience: sp.entityId,
    idpCert: c.saml_idp_certs.map(toPem), idpIssuer: c.saml_idp_entity_id || undefined,
    wantAssertionsSigned: true, wantAuthnResponseSigned: false,
    validateInResponseTo: 'always', requestIdExpirationPeriodMs: 600_000, cacheProvider,
    acceptedClockSkewMs: 60_000, disableRequestedAuthnContext: true, identifierFormat: null,
    signatureAlgorithm: 'sha256', digestAlgorithm: 'sha256',
  });
}

export async function samlStartUrl(c: SamlConn, sp: SpInfo, relayState: string): Promise<string> {
  return (await saml(c, sp)).getAuthorizeUrlAsync(relayState, undefined, {});
}

/** Check a posted SAMLResponse and answer the profile (attributes, NameID, issuer). */
export async function samlValidate(c: SamlConn, sp: SpInfo, body: Record<string, string>): Promise<Record<string, any>> {
  const r = await (await saml(c, sp)).validatePostResponseAsync(body);
  if (r.loggedOut || !r.profile) throw new Error('The provider sent a sign-out, not a sign-in');
  return r.profile;
}

export async function spMetadata(c: SamlConn, sp: SpInfo): Promise<string> {
  const { SAML } = await lib();
  return new SAML({ callbackUrl: sp.acsUrl, issuer: sp.entityId, idpCert: c.saml_idp_certs?.length ? c.saml_idp_certs.map(toPem) : 'MIIB', audience: sp.entityId, wantAssertionsSigned: true })
    .generateServiceProviderMetadata(null, null);
}
