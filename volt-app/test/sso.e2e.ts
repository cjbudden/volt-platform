// ============================================================================
//  SINGLE SIGN-ON END TO END (auth/sso/, ACCESS_CONTROL.md section 14): a mock
//  OpenID provider and a mock SAML IdP that signs real responses. Set-up and
//  domains, OIDC and SAML sign-in, refusals (unverified domain, other account,
//  disabled, unverified email, forged or replayed tokens, unsigned, wrong cert,
//  wrong audience, unsolicited), two-step policy, compulsory SSO, role sync.
//  Needs DATABASE_URL, openssl, and npm install (xml-crypto comes with node-saml).
//  Usage: npx tsx test/sso.e2e.ts
// ============================================================================
import express from 'express';
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import jwt from 'jsonwebtoken';
process.env.SSO_BASE_URL = 'http://127.0.0.1:47811';
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

async function main() {
  await (await import('../src/services/migrate')).migrate();
  const { one, query, pool } = await import('../src/db');
  const { authRouter } = await import('../src/auth/routes');
  const { ssoRouter, ssoAdminRouter } = await import('../src/auth/sso/routes');
  const S = await import('../src/auth/sso/sso');
  const { signAccess } = await import('../src/auth/jwt');
  const { hashPassword } = await import('../src/auth/password');
  const { ensureDefaultRoles } = await import('../src/auth/defaultRoles');
  const { errorHandler } = await import('../src/util/http');
  const tag = randomBytes(3).toString('hex');
  const D = `acme-${tag}.test`, D2 = `unverified-${tag}.test`;

  // ---- Volt
  const app = express();
  app.use(express.json());
  app.use('/api/auth/sso', ssoRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/sso-connections', ssoAdminRouter);
  app.use(errorHandler);
  const volt = app.listen(47811);
  const V = 'http://127.0.0.1:47811';

  const acct = (await one<any>(`INSERT INTO accounts (name) VALUES ('Acme ${tag}') RETURNING id`))!.id;
  const other = (await one<any>(`INSERT INTO accounts (name) VALUES ('Other ${tag}') RETURNING id`))!.id;
  await ensureDefaultRoles(acct); await ensureDefaultRoles(other);
  const pw = await hashPassword('correct horse battery');
  const mkUser = async (a: string, email: string, role: string, status = 'active') => (await one<any>(`INSERT INTO users (account_id, email, password_hash, role, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [a, email, pw, role, status]))!.id;
  const owner = await mkUser(acct, `owner@${D}`, 'owner');
  const alice = await mkUser(acct, `alice@${D}`, 'operator');
  await mkUser(other, `bob@${D}`, 'operator');
  await mkUser(acct, `dan@${D}`, 'operator', 'disabled');
  const adminTok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const api = (p: string, init: RequestInit = {}) => fetch(`${V}/api/sso-connections${p}`, { ...init, headers: { authorization: `Bearer ${adminTok}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const adminRole = (await one<any>(`SELECT id FROM user_groups WHERE account_id = $1 AND role_key = 'administrator'`, [acct]))!.id;

  // ---- a mock OpenID provider
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const P = 'http://127.0.0.1:47812';
  const codes = new Map<string, any>();
  let next: { email: string; groups?: string[]; amr?: string[]; key?: any; nonce?: string; emailVerified?: boolean } = { email: `alice@${D}` };
  const op = express();
  op.use(express.urlencoded({ extended: false }));
  op.get('/.well-known/openid-configuration', (_q, r) => r.json({ issuer: P, authorization_endpoint: `${P}/authorize`, token_endpoint: `${P}/token`, jwks_uri: `${P}/jwks`, userinfo_endpoint: `${P}/userinfo` }));
  op.get('/jwks', (_q, r) => r.json({ keys: [jwk] }));
  op.get('/authorize', (q, r) => {
    const p = q.query as Record<string, string>;
    const code = randomBytes(8).toString('hex');
    codes.set(code, { ...p, who: next });
    r.redirect(`${p.redirect_uri}?code=${code}&state=${encodeURIComponent(p.state)}`);
  });
  let lastClientAuth = '';
  op.post('/token', (q, r) => {
    const c = codes.get(q.body.code); codes.delete(q.body.code);
    lastClientAuth = String(q.headers.authorization ?? '');
    if (!c) return r.status(400).json({ error: 'invalid_grant' });
    const challenge = createHash('sha256').update(q.body.code_verifier ?? '').digest('base64url');
    if (challenge !== c.code_challenge) return r.status(400).json({ error: 'invalid_grant', error_description: 'PKCE' });
    const w = c.who;
    const idt = jwt.sign({ sub: `sub-${w.email}`, email: w.email, email_verified: w.emailVerified ?? true, name: 'Test Person', groups: w.groups ?? [], amr: w.amr ?? ['pwd'], nonce: w.nonce ?? c.nonce },
      w.key ?? privateKey, { algorithm: 'RS256', keyid: 'k1', issuer: P, audience: 'volt-client', expiresIn: 300 });
    r.json({ id_token: idt, access_token: 'at', token_type: 'Bearer' });
  });
  const provider = op.listen(47812);

  const follow = async (url: string) => { // the browser: Volt -> provider -> Volt callback -> console
    let u = url;
    for (let i = 0; i < 4; i++) {
      const r = await fetch(u, { redirect: 'manual' });
      const loc = r.headers.get('location');
      if (!loc) return { status: r.status, url: u };
      if (loc.startsWith(`${V}/?`)) return { console: new URL(loc) };
      u = loc;
    }
    return { url: u };
  };

  console.log('== set up an OIDC connection ==');
  let r = await api('', { method: 'POST', body: JSON.stringify({ protocol: 'oidc', name: 'Acme Entra', oidcIssuer: P, oidcClientId: 'volt-client', oidcClientSecret: 's3cret',
    jit: true, defaultTier: 'operator', groupMap: [{ value: 'volt-admins', groupId: adminRole }] }) });
  const c1 = await r.json() as any;
  ok(r.status === 201 && c1.oidc.hasSecret && !JSON.stringify(c1).includes('s3cret') && c1.oidc.redirectUri === `${V}/api/auth/sso/oidc/callback`, 'created; the secret is never sent back', JSON.stringify(c1).slice(0, 300));
  ok((await one<any>(`SELECT oidc_client_secret FROM sso_connections WHERE id = $1`, [c1.id]))!.oidc_client_secret.startsWith('enc:v1:'), 'the client secret is sealed at rest');
  r = await api(`/${c1.id}/domains`, { method: 'POST', body: JSON.stringify({ domain: 'gmail.com' }) });
  ok(r.status === 400, 'a public mail domain cannot be claimed');
  r = await api(`/${c1.id}/domains`, { method: 'POST', body: JSON.stringify({ domain: D }) });
  const dom = await r.json() as any;
  ok(r.status === 201 && dom.record.name === `_volt-sso.${D}` && !dom.verified, 'a domain starts unverified, with the TXT record to add');
  ok((await (await fetch(`${V}/api/auth/sso/discover?email=x@${D}`)).json() as any).connections.length === 0, 'an unverified domain is not offered at sign-in');
  S._setResolver(async () => [['nothing']]);
  ok(!(await (await api(`/${c1.id}/domains/${D}/verify`, { method: 'POST' })).json() as any).verified, 'no record yet: not verified');
  S._setResolver(async (name) => (name === `_volt-sso.${D}` ? [[dom.record.value]] : []));
  ok((await (await api(`/${c1.id}/domains/${D}/verify`, { method: 'POST' })).json() as any).verified, 'with the TXT record: verified');
  r = await api(`/${c1.id}/domains`, { method: 'POST', body: JSON.stringify({ domain: D2 }) });  // stays unverified
  const otherConn = await (await fetch(`${V}/api/sso-connections`, { method: 'POST', headers: { authorization: `Bearer ${signAccess({ sub: owner, account_id: other, role: 'owner' } as any)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: 'oidc', name: 'Rival', oidcIssuer: P, oidcClientId: 'x' }) })).json() as any;
  r = await fetch(`${V}/api/sso-connections/${otherConn.id}/domains`, { method: 'POST', headers: { authorization: `Bearer ${signAccess({ sub: owner, account_id: other, role: 'owner' } as any)}`, 'content-type': 'application/json' }, body: JSON.stringify({ domain: D }) });
  ok(r.status === 409, 'another Volt account cannot claim the same domain');
  const disc = await (await fetch(`${V}/api/auth/sso/discover?email=someone@${D}`)).json() as any;
  ok(disc.connections.length === 1 && disc.connections[0].name === 'Acme Entra' && !disc.required, 'discovery by domain');
  const test = await (await api(`/${c1.id}/test`, { method: 'POST' })).json() as any;
  ok(test.ok, 'the connection test passes', JSON.stringify(test));
  const opAuthz = signAccess({ sub: alice, account_id: acct, role: 'operator' } as any);
  ok((await fetch(`${V}/api/sso-connections`, { headers: { authorization: `Bearer ${opAuthz}` } })).status === 403, 'an operator cannot manage SSO');

  console.log('== OIDC sign-in ==');
  const start = (ret = '/vod') => `${V}/api/auth/sso/start/${c1.id}?return=${encodeURIComponent(ret)}`;
  next = { email: `alice@${D}` };
  let f = await follow(start());
  const code1 = f.console?.searchParams.get('sso');
  ok(!!code1, 'back at the console with a one-time code', JSON.stringify(f));
  ok(lastClientAuth.startsWith('Basic '), 'the client authenticated to the token endpoint');
  let fin = await (await fetch(`${V}/api/auth/sso/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code1 }) })).json() as any;
  ok(!!fin.access && !!fin.refresh && fin.returnTo === '/vod' && JSON.stringify(fin.amr) === '["ext"]', 'the code is a session for the existing user, with where to go', JSON.stringify(fin).slice(0, 200));
  ok((jwt.decode(fin.access) as any).sub === alice, 'it is alice');
  ok(!!(await one(`SELECT 1 FROM user_identities WHERE user_id = $1 AND connection_id = $2`, [alice, c1.id])), 'linked by subject for next time');
  ok((await fetch(`${V}/api/auth/sso/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code1 }) })).status === 401, 'the code works once');

  next = { email: `carol@${D}`, groups: ['volt-admins', 'other'], amr: ['pwd', 'mfa'] };
  f = await follow(start('/'));
  fin = await (await fetch(`${V}/api/auth/sso/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: f.console?.searchParams.get('sso') }) })).json() as any;
  const carol = await one<any>(`SELECT id, role, status FROM users WHERE email = $1`, [`carol@${D}`]);
  ok(!!carol && carol.status === 'active' && carol.role === 'admin', 'a new person is created on first sign-in, tier from the mapped role', JSON.stringify(carol));
  ok(!!(await one(`SELECT 1 FROM user_group_members WHERE user_id = $1 AND group_id = $2`, [carol?.id, adminRole])), 'with the role their group maps to');
  ok(JSON.stringify(fin.amr) === '["ext","mfa"]', 'the provider\'s two-step sign-in counts');

  console.log('== refusals ==');
  const errOf = (x: any) => x.console?.searchParams.get('sso_error') ?? '';
  next = { email: `eve@${D2}` };
  f = await follow(start()); ok(/not a verified domain/.test(errOf(f)), 'an address at an unverified domain is refused', errOf(f));
  next = { email: `bob@${D}` };
  f = await follow(start()); ok(/another Volt account/.test(errOf(f)), 'a user of another Volt account is refused', errOf(f));
  next = { email: `dan@${D}` };
  f = await follow(start()); ok(/disabled/.test(errOf(f)), 'a disabled user is refused');
  next = { email: `frank@${D}`, emailVerified: false };
  f = await follow(start()); ok(/not verified/.test(errOf(f)), 'an address the provider says is unverified is refused');
  next = { email: `alice@${D}`, key: rogue.privateKey };
  f = await follow(start()); ok(/signature|invalid/i.test(errOf(f)), 'a token signed by someone else is refused', errOf(f));
  next = { email: `alice@${D}`, nonce: 'not-this-one' };
  f = await follow(start()); ok(/nonce/.test(errOf(f)), 'a token for another sign-in (nonce) is refused');
  // Replay: start, intercept the callback, use it twice.
  next = { email: `alice@${D}` };
  const s1 = await fetch(start(), { redirect: 'manual' });
  const az = await fetch(s1.headers.get('location')!, { redirect: 'manual' });
  const cb = az.headers.get('location')!;
  const once = await fetch(cb, { redirect: 'manual' });
  const twice = await fetch(cb, { redirect: 'manual' });
  ok(/sso=/.test(once.headers.get('location') ?? '') && /expired or was already used/.test(decodeURIComponent(twice.headers.get('location') ?? '')), 'a callback works once (state is single use)');
  ok(/sso_error/.test((await fetch(`${V}/api/auth/sso/start/${c1.id}?return=https://evil.example`, { redirect: 'manual' })).headers.get('location') ?? '') === false, 'start still works with a foreign return');
  ok(S.safeReturn('https://evil.example') === null && S.safeReturn('//evil.example') === null && S.safeReturn('/vod') === '/vod', 'return paths stay inside the console');

  console.log('== policies ==');
  await query(`UPDATE accounts SET require_admin_mfa = true WHERE id = $1`, [acct]);
  next = { email: `alice@${D}`, amr: ['pwd'] };
  f = await follow(start());
  fin = await (await fetch(`${V}/api/auth/sso/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: f.console?.searchParams.get('sso') }) })).json() as any;
  ok(!fin.access && (fin.mfaSetupRequired || fin.mfaRequired) && !!fin.challenge, 'two-step required by the account and not done at the provider: Volt asks for it', JSON.stringify(fin).slice(0, 160));
  next = { email: `alice@${D}`, amr: ['pwd', 'otp'] };
  f = await follow(start());
  fin = await (await fetch(`${V}/api/auth/sso/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: f.console?.searchParams.get('sso') }) })).json() as any;
  ok(!!fin.access, 'done at the provider and trusted: straight in');
  await api(`/${c1.id}`, { method: 'PATCH', body: JSON.stringify({ trustIdpMfa: false }) });
  f = await follow(start());
  fin = await (await fetch(`${V}/api/auth/sso/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: f.console?.searchParams.get('sso') }) })).json() as any;
  ok(!fin.access && !!fin.challenge, 'not trusted: Volt asks even after the provider\'s two-step');
  await query(`UPDATE accounts SET require_admin_mfa = false WHERE id = $1`, [acct]);
  await api(`/${c1.id}`, { method: 'PATCH', body: JSON.stringify({ trustIdpMfa: true }) });

  const login = (email: string) => fetch(`${V}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) });
  ok((await login(`alice@${D}`)).status === 200, 'before enforcing: password works');
  await api(`/${c1.id}`, { method: 'PATCH', body: JSON.stringify({ enforce: true }) });
  const lr = await login(`alice@${D}`); const lj = await lr.json() as any;
  ok(lr.status === 403 && lj.code === 'sso_required' && lj.details?.connectionId === c1.id, 'enforced: password sign-in is closed for the domain', JSON.stringify(lj));
  ok((await fetch(`${V}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `alice@${D}`, password: 'wrong' }) })).status === 401, 'a wrong password still just says invalid (nothing learned)');
  ok((await login(`owner@${D}`)).status === 200, 'the owner keeps a password: the way back in');
  ok((await (await fetch(`${V}/api/auth/sso/discover?email=x@${D}`)).json() as any).required === true, 'discovery says SSO is required');
  ok(!!(await login(`carol@${D}`).then((x) => x.status === 403 || x.status === 401)), 'an SSO-created user has no working password');

  await api(`/${c1.id}`, { method: 'PATCH', body: JSON.stringify({ syncGroups: true }) });
  next = { email: `carol@${D}`, groups: ['other'], amr: ['mfa'] };
  f = await follow(start());
  const carol2 = await one<any>(`SELECT role FROM users WHERE email = $1`, [`carol@${D}`]);
  ok(!(await one(`SELECT 1 FROM user_group_members WHERE user_id = $1 AND group_id = $2`, [carol!.id, adminRole])) && carol2.role === 'operator', 'with sync: leaving the group at the provider takes the role and tier away', JSON.stringify(carol2));

  console.log('== SAML ==');
  const T = mkdtempSync(join(tmpdir(), 'saml-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(T, 'k.pem'), '-out', join(T, 'c.pem'), '-days', '30', '-subj', '/CN=idp.acme.test'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(T, 'k2.pem'), '-out', join(T, 'c2.pem'), '-days', '30', '-subj', '/CN=rogue'], { stdio: 'ignore' });
  const key = readFileSync(join(T, 'k.pem'), 'utf8'), cert = readFileSync(join(T, 'c.pem'), 'utf8'), key2 = readFileSync(join(T, 'k2.pem'), 'utf8');
  const b64cert = cert.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const meta = `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.acme.test/saml"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${b64cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.acme.test/sso/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="http://127.0.0.1:47813/sso"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
  const parsed = await (await api('/metadata', { method: 'POST', body: JSON.stringify({ xml: meta }) })).json() as any;
  ok(parsed.entityId === 'https://idp.acme.test/saml' && parsed.ssoUrl === 'http://127.0.0.1:47813/sso' && parsed.ssoBinding === 'redirect' && parsed.certs.length === 1 && /idp\.acme\.test/.test(parsed.certInfo[0].subject), 'IdP metadata read: entity ID, redirect sign-in URL, certificate', JSON.stringify(parsed).slice(0, 200));
  r = await api('', { method: 'POST', body: JSON.stringify({ protocol: 'saml', name: 'Acme Okta SAML', samlIdpEntityId: parsed.entityId, samlIdpSsoUrl: parsed.ssoUrl, samlIdpCerts: parsed.certs, jit: true }) });
  const c2 = await r.json() as any;
  ok(r.status === 201 && c2.saml.acsUrl === `${V}/api/auth/sso/saml/acs/${c2.id}`, 'SAML connection created, with Volt\'s ACS URL and entity ID to give the IdP', JSON.stringify(c2.saml));
  await query(`UPDATE sso_domains SET connection_id = $2 WHERE domain = $1`, [D2, c2.id]);
  await query(`UPDATE sso_domains SET verified_at = now() WHERE domain = $1`, [D2]);
  const md = await (await fetch(`${V}/api/auth/sso/saml/metadata/${c2.id}`)).text();
  ok(md.includes(`entityID="${c2.saml.spEntityId}"`) && md.includes(c2.saml.acsUrl), 'Volt\'s SP metadata');
  const { SignedXml } = await import('xml-crypto');
  const startSaml = async () => {
    const s = await fetch(`${V}/api/auth/sso/start/${c2.id}?return=/images`, { redirect: 'manual' });
    const u = new URL(s.headers.get('location')!);
    const reqXml = inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest')!, 'base64')).toString();
    return { relay: u.searchParams.get('RelayState')!, id: /ID="([^"]+)"/.exec(reqXml)![1], url: u };
  };
  const response = (o: { inResponseTo?: string | null; email: string; sign?: 'good' | 'rogue' | 'none'; audience?: string; groups?: string[] }) => {
    const now = new Date(), later = new Date(Date.now() + 300_000);
    const irt = o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : '';
    const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a${randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${now.toISOString()}"><saml:Issuer>https://idp.acme.test/saml</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later.toISOString()}" Recipient="${c2.saml.acsUrl}"${irt}/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${new Date(Date.now() - 60000).toISOString()}" NotOnOrAfter="${later.toISOString()}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? c2.saml.spEntityId}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now.toISOString()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"><saml:AttributeValue>${o.email}</saml:AttributeValue></saml:Attribute>${(o.groups ?? []).map((g) => `<saml:Attribute Name="groups"><saml:AttributeValue>${g}</saml:AttributeValue></saml:Attribute>`).join('')}</saml:AttributeStatement></saml:Assertion>`;
    let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r${randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${c2.saml.acsUrl}"${irt}><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://idp.acme.test/saml</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;
    if (o.sign !== 'none') {
      const sig = new SignedXml({ privateKey: o.sign === 'rogue' ? key2 : key, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
      sig.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256', transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] });
      sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
      xml = sig.getSignedXml();
    }
    return Buffer.from(xml).toString('base64');
  };
  const post = (body: Record<string, string>) => fetch(c2.saml.acsUrl, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const loc = (x: Response) => decodeURIComponent(x.headers.get('location') ?? '');
  let st = await startSaml();
  ok(st.url.origin + st.url.pathname === 'http://127.0.0.1:47813/sso' && !!st.relay, 'SAML start: an AuthnRequest to the IdP');
  let pr = await post({ SAMLResponse: response({ inResponseTo: st.id, email: `grace@${D2}`, groups: ['volt-admins'] }), RelayState: st.relay });
  const samlCode = new URL(pr.headers.get('location') ?? `${V}/`).searchParams.get('sso');
  ok(!!samlCode, 'a signed response signs in', loc(pr));
  fin = await (await fetch(`${V}/api/auth/sso/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: samlCode }) })).json() as any;
  ok(!!fin.access && fin.returnTo === '/images' && !!(await one(`SELECT 1 FROM users WHERE email = $1`, [`grace@${D2}`])), 'SAML: session, new user created');
  pr = await post({ SAMLResponse: response({ inResponseTo: st.id, email: `grace@${D2}` }), RelayState: st.relay });
  ok(/expired|already used/.test(loc(pr)), 'a response cannot be used twice');
  st = await startSaml();
  pr = await post({ SAMLResponse: response({ inResponseTo: st.id, email: `grace@${D2}`, sign: 'none' }), RelayState: st.relay });
  console.log('  unsigned ->', loc(pr).split('sso_error=')[1]); ok(/sso_error/.test(loc(pr)) && !/sso=/.test(pr.headers.get('location') ?? ''), 'an unsigned response is refused');
  st = await startSaml();
  pr = await post({ SAMLResponse: response({ inResponseTo: st.id, email: `grace@${D2}`, sign: 'rogue' }), RelayState: st.relay });
  console.log('  ', 'a response signed with another certificate is refused', '->', loc(pr).split('sso_error=')[1]); ok(/sso_error/.test(loc(pr)), 'a response signed with another certificate is refused');
  st = await startSaml();
  pr = await post({ SAMLResponse: response({ inResponseTo: st.id, email: `grace@${D2}`, audience: 'https://someone-else' }), RelayState: st.relay });
  console.log('  ', 'a response for another service (audience) is refused', '->', loc(pr).split('sso_error=')[1]); ok(/sso_error/.test(loc(pr)), 'a response for another service (audience) is refused');
  st = await startSaml();
  pr = await post({ SAMLResponse: response({ inResponseTo: null, email: `grace@${D2}` }), RelayState: st.relay });
  console.log('  ', 'an unsolicited response (no InResponseTo) is refused', '->', loc(pr).split('sso_error=')[1]); ok(/sso_error/.test(loc(pr)), 'an unsolicited response (no InResponseTo) is refused');
  pr = await post({ SAMLResponse: response({ inResponseTo: 'made-up', email: `grace@${D2}` }), RelayState: 'made-up' });
  ok(/not started from Volt|expired/.test(loc(pr)), 'a response to a request Volt did not send is refused');

  volt.close(); provider.close(); await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
