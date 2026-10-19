/**
 * BUILD THE API REFERENCE FROM A LIVE RUN.
 *
 * Runs every request below, in order, against a running API (BASE_URL), keeps
 * the real response of each, and writes from that one capture:
 *
 *   api/Volt.postman_collection.json    Postman collection, a saved example per request
 *   api/Volt.postman_environment.json   its environment (variables, no secrets)
 *   docs/API.md                          the request-by-request reference
 *   docs/api-playground.html             a searchable page of the same
 *   $TMPDIR/volt-api-captured.json        the raw capture (CAPTURE_OUT to move it)
 *
 * Every request says which API it belongs to (public, admin, platform,
 * machine), the credential it takes, its parameters and, for admin routes, the
 * feature and level a role needs (looked up in docs/api-routes.json, which
 * scripts/api-routes.ts reads from the running app).
 *
 * Use api/capture_api.sh: it makes an empty database, seeds it, starts the API
 * with SECURITY_CODE_ECHO=1 and runs this. A step marked `external` (none today)
 * is written to the collection but not run here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { totpAt } from '../src/services/totp';

const ROOT = join(__dirname, '..');
const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const TS = String(Date.now());

/* ---- what a step is ---------------------------------------------------------------- */
type Auth = 'none' | 'admin' | 'viewer' | 'platform' | 'secret' | 'ops' | 'radio' | 'sysviewer' | 'staff' | 'ingest' | 'challenge';
interface Param { name: string; in: 'body' | 'query' | 'path' | 'header'; type: string; required?: boolean; desc: string }
interface Step {
  folder: string; name: string; method: string; path: string; auth: Auth
  body?: any; desc: string; params?: Param[]
  /** env var -> dotted path in the JSON response */
  save?: Record<string, string>
  /** TOTP: the env var holding the base32 secret, and a time offset in steps */
  totp?: { secretVar: string; offset?: number }
  expect?: number[]
  headers?: Record<string, string>
  external?: boolean
}
const TOKEN_VAR: Record<Auth, string | null> = {
  none: null, challenge: null, ingest: null,
  admin: 'adminToken', viewer: 'viewerToken', platform: 'platformToken', secret: 'secretKey',
  ops: 'opsToken', radio: 'radioToken', sysviewer: 'sysViewerToken', staff: 'staffAdminToken',
};
const AUTH_LABEL: Record<Auth, string> = {
  none: 'none', challenge: 'none (the sign-in challenge is in the body)', ingest: 'X-Volt-Ingest-Token header',
  admin: 'admin session (Bearer {{adminToken}})', viewer: 'public user session (Bearer {{viewerToken}})',
  platform: 'platform session (Bearer {{platformToken}})', secret: 'account secret key (Bearer {{secretKey}})',
  ops: 'admin session of the test user (Bearer {{opsToken}})', radio: 'Radio Manager session (Bearer {{radioToken}})',
  sysviewer: 'System Viewer session (Bearer {{sysViewerToken}})', staff: 'admin session of platform staff (Bearer {{staffAdminToken}})',
};

const P = (name: string, type: string, desc: string, required = true, where: Param['in'] = 'body'): Param => ({ name, in: where, type, required, desc });
const pw = P('password', 'string', 'The current password (re-authentication).');
const code = P('code', 'string', '6-digit code. On a test server with SECURITY_CODE_ECHO=1 the previous response carries it as devCode.');
const ch = P('challenge', 'string', 'The challenge from the sign-in response (10 minutes, single use).');

/* ---- the run ------------------------------------------------------------------------------ */
const steps: Step[] = [
  // ===== 0. discovery =====
  { folder: '0 · Health & discovery', name: 'Health', method: 'GET', path: '/health', auth: 'none', desc: 'Liveness. Every tier answers it.' },
  { folder: '0 · Health & discovery', name: 'Readiness', method: 'GET', path: '/health/ready', auth: 'none', desc: 'Ready to serve: database, Valkey, migrations, listener. Load balancers use this.' },
  { folder: '0 · Health & discovery', name: 'Service document (Hydra)', method: 'GET', path: '/api', auth: 'none', headers: { Accept: 'application/ld+json' }, desc: 'Entry point with links to every collection. Send Accept: application/ld+json for the hypermedia form.' },

  // ===== 1. admin sign-in =====
  { folder: '1 · Admin · sign-in & my account', name: 'Sign in', method: 'POST', path: '/api/auth/login', auth: 'none',
    body: { email: '{{adminEmail}}', password: '{{password}}' }, save: { adminToken: 'access', adminRefresh: 'refresh' },
    params: [P('email', 'string', 'Admin user email.'), P('password', 'string', 'Password.')],
    desc: 'Returns {access, refresh, expiresIn, amr} when no second step is due. If the user has two-step sign-in on, the answer is {mfaRequired, challenge, methods, email, phone} instead (see the "two-step" requests below). If the account requires it and the user has none, {mfaSetupRequired, challenge, available}. Rate limited per email and per address.' },
  { folder: '1 · Admin · sign-in & my account', name: 'Who am I (access map)', method: 'GET', path: '/api/auth/me', auth: 'admin',
    desc: 'The user, their tier, roles, the effective level per feature (permissions) and the catalogue. The console builds its menu and buttons from this.' },
  { folder: '1 · Admin · sign-in & my account', name: 'Refresh the session', method: 'POST', path: '/api/auth/refresh', auth: 'none',
    body: { refresh: '{{adminRefresh}}' }, save: { adminToken: 'access', adminRefresh: 'refresh' },
    params: [P('refresh', 'string', 'The refresh token. It rotates: use the new one next time.')],
    desc: 'New access token. Answers 401 code mfa_required when the account now requires two-step sign-in and this session did not use it.' },
  { folder: '1 · Admin · sign-in & my account', name: 'Sign-in security summary', method: 'GET', path: '/api/auth/security', auth: 'admin',
    desc: 'Email and mobile (verified or not), methods on, backup codes left, whether the account requires two-step sign-in.' },
  { folder: '1 · Admin · sign-in & my account', name: 'Update my display name', method: 'PATCH', path: '/api/auth/me', auth: 'admin',
    body: { displayName: 'Ada Administrator' }, params: [P('displayName', 'string|null', 'Shown in the console and on records you change.')], desc: 'Own profile. Access is never self-service.' },

  // ===== 2. admin users & roles =====
  { folder: '2 · Admin · users & roles', name: 'Feature catalogue', method: 'GET', path: '/api/access-roles/catalogue', auth: 'admin', desc: 'Every feature with its label, area and what operate means for it. Use it to build a role editor.' },
  { folder: '2 · Admin · users & roles', name: 'List roles', method: 'GET', path: '/api/access-roles', auth: 'admin', save: { radioRoleId: '@role:radio_manager', adminRoleId: '@role:administrator' },
    desc: 'Default (system) roles and the account\'s own. A default role cannot be edited, copy it instead.' },
  { folder: '2 · Admin · users & roles', name: 'Create a role', method: 'POST', path: '/api/access-roles', auth: 'admin',
    body: { name: 'Postman desk {{$timestamp}}', description: 'Runs stations and views the live board', tier: 'operator', permissions: { radio: 'operate', monitoring: 'view' } },
    save: { roleId: 'id' },
    params: [P('name', 'string', 'Unique in the account.'), P('description', 'string', 'Optional.', false), P('tier', '"operator"|"viewer"', 'viewer caps every level at view.', false),
      P('permissions', 'object', 'feature -> none|view|operate|manage. Cannot exceed your own access (no escalation).')],
    desc: 'A named set of levels per feature.' },
  { folder: '2 · Admin · users & roles', name: 'Copy a role', method: 'POST', path: '/api/access-roles/{{radioRoleId}}/copy', auth: 'admin', body: { name: 'Radio desk copy {{$timestamp}}' },
    save: { copiedRoleId: 'id' }, params: [P('name', 'string', 'Name of the copy.', false)], desc: 'Start a custom role from a default one.' },
  { folder: '2 · Admin · users & roles', name: 'Edit a role', method: 'PATCH', path: '/api/access-roles/{{roleId}}', auth: 'admin',
    body: { permissions: { radio: 'manage', monitoring: 'view' } }, params: [P('name', 'string', '', false), P('description', 'string', '', false), P('permissions', 'object', 'Replaces the levels.', false)],
    desc: 'Members get the new access on their next request (the access cache is dropped by trigger).' },
  { folder: '2 · Admin · users & roles', name: 'Add an admin user', method: 'POST', path: '/api/users', auth: 'admin',
    body: { email: 'ops+{{$timestamp}}@{{domain}}', password: '{{password}}', displayName: 'Olly Ops', roleIds: ['{{roleId}}'] },
    save: { userId: 'id', opsEmail: 'email' },
    params: [P('email', 'string', 'Unique across the platform.'), P('password', 'string', 'At least 10 characters.'), P('displayName', 'string', '', false),
      P('roleIds', 'uuid[]', 'Roles to hold. The tier follows the highest role. Each must be within your own access.'), P('tier', 'string', 'owner/admin only, and only by someone of that tier.', false)],
    desc: 'Creates a user in your account.' },
  { folder: '2 · Admin · users & roles', name: 'List admin users', method: 'GET', path: '/api/users', auth: 'admin', desc: 'Users with roles, tier, status and two-step status (mfa).' },
  { folder: '2 · Admin · users & roles', name: 'Get an admin user', method: 'GET', path: '/api/users/{{userId}}', auth: 'admin',
    desc: 'Adds effective access, security summary (masked mobile, methods) and manageable: whether you may change them.' },
  { folder: '2 · Admin · users & roles', name: 'Change roles or status', method: 'PATCH', path: '/api/users/{{userId}}', auth: 'admin',
    body: { roleIds: ['{{roleId}}', '{{copiedRoleId}}'], displayName: 'Olly Ops' },
    params: [P('roleIds', 'uuid[]', 'Replaces the roles.', false), P('status', '"active"|"disabled"', 'Disabling ends their sessions at once.', false), P('displayName', 'string|null', '', false)],
    desc: 'You cannot change yourself, someone above your tier, or someone whose access you do not cover. Access or status changes end their refresh tokens.' },
  { folder: '2 · Admin · users & roles', name: 'Sign in as the Radio Manager', method: 'POST', path: '/api/auth/login', auth: 'none',
    body: { email: '{{radioEmail}}', password: '{{password}}' }, save: { radioToken: 'access' }, desc: 'A second user, for the refusal examples.' },
  { folder: '2 · Admin · users & roles', name: 'Refused: grant more than you hold', method: 'POST', path: '/api/users', auth: 'radio', expect: [403],
    body: { email: 'nope+{{$timestamp}}@{{domain}}', password: '{{password}}', roleIds: ['{{adminRoleId}}'] },
    desc: 'The Radio Manager has no users access: 403 forbidden_feature with the feature and level needed. A user manager trying to grant a role above their own access gets 403 too (no escalation).' },
  { folder: '2 · Admin · users & roles', name: 'Account security policy', method: 'GET', path: '/api/users/security-policy', auth: 'admin',
    desc: 'requireAdminMfa, and how many active users have two-step sign-in on.' },
  { folder: '2 · Admin · users & roles', name: 'Require two-step sign-in (off again)', method: 'PUT', path: '/api/users/security-policy', auth: 'admin', body: { requireAdminMfa: false },
    params: [P('requireAdminMfa', 'boolean', 'On: anyone without a method sets one up at next sign-in, and sessions that did not use one end at their next refresh.')],
    desc: 'Needs users:manage and the admin tier.' },

  // ===== 3. my account security (on the new user, so the seeded admin stays as it is) =====
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Sign in as the new user', method: 'POST', path: '/api/auth/login', auth: 'none',
    body: { email: '{{opsEmail}}', password: '{{password}}' }, save: { opsToken: 'access' }, desc: 'The requests in this folder change this user\'s own settings.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Turn on email codes: send', method: 'POST', path: '/api/auth/mfa/email/start', auth: 'ops',
    body: { password: '{{password}}' }, save: { code: 'devCode' }, params: [pw], desc: 'Sends a code to the account email. Receiving it also verifies the address.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Turn on email codes: confirm', method: 'POST', path: '/api/auth/mfa/email/confirm', auth: 'ops',
    body: { code: '{{code}}' }, params: [code], desc: 'The first method on also returns 10 backup codes, shown once.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Sign in: now a challenge', method: 'POST', path: '/api/auth/login', auth: 'none',
    body: { email: '{{opsEmail}}', password: '{{password}}' }, save: { challenge: 'challenge' }, desc: 'Answers {mfaRequired, challenge, methods, email} instead of tokens.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Second step: send the code', method: 'POST', path: '/api/auth/mfa/challenge/send', auth: 'challenge',
    body: { challenge: '{{challenge}}', method: 'email' }, save: { code: 'devCode' },
    params: [ch, P('method', '"email"|"sms"', 'Where to send it. Authenticator and backup codes need no send.')], desc: 'Limited to 10 sends per person and per destination per 15 minutes.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Second step: verify', method: 'POST', path: '/api/auth/mfa/challenge/verify', auth: 'challenge',
    body: { challenge: '{{challenge}}', method: 'email', code: '{{code}}' }, save: { opsToken: 'access' },
    params: [ch, P('method', '"totp"|"email"|"sms"|"backup"', 'The method the code is from.'), P('code', 'string', '6 digits, or a backup code (xxxx-xxxx).')],
    desc: 'Returns the session, with amr ["pwd","mfa",...]. 5 wrong guesses kill a code. A finished challenge cannot be reused.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Authenticator app: start', method: 'POST', path: '/api/auth/mfa/totp/start', auth: 'ops',
    body: { password: '{{password}}' }, save: { totpSecret: 'secret' }, params: [pw],
    desc: 'Returns the base32 secret and the otpauth:// URI (draw it as a QR code). During a required set-up at sign-in, send {challenge} instead of password.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Authenticator app: confirm', method: 'POST', path: '/api/auth/mfa/totp/confirm', auth: 'ops',
    body: { code: '{{totpCode}}' }, totp: { secretVar: 'totpSecret' }, params: [P('code', 'string', 'The current code from the app. The Postman pre-request script works it out from {{totpSecret}}.')],
    desc: 'Turns the authenticator on.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Change email: send code to the new address', method: 'POST', path: '/api/auth/email/change', auth: 'ops',
    body: { newEmail: 'ops-new+{{$timestamp}}@{{domain}}', password: '{{password}}' }, save: { code: 'devCode' },
    params: [P('newEmail', 'string', 'The new address. Must be free.'), pw], desc: 'Nothing changes until the code is entered.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Change email: confirm', method: 'POST', path: '/api/auth/email/change/confirm', auth: 'ops',
    body: { code: '{{code}}' }, save: { opsEmail: 'email' }, params: [code], desc: 'Changes and verifies the email. A notice goes to the old address. The old address stops signing in.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Mobile number: send code', method: 'POST', path: '/api/auth/phone', auth: 'ops',
    body: { phone: '+61412345678', password: '{{password}}' }, save: { code: 'devCode' },
    params: [P('phone', 'string', 'International format (E.164), for example +61412345678.'), pw], desc: 'Texts a code (AWS SNS, or the log on a test server).' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Mobile number: confirm', method: 'POST', path: '/api/auth/phone/confirm', auth: 'ops', body: { code: '{{code}}' }, params: [code], desc: 'Saves and verifies the number.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Text codes: send', method: 'POST', path: '/api/auth/mfa/sms/start', auth: 'ops', body: { password: '{{password}}' }, save: { code: 'devCode' },
    params: [pw, P('phone', 'string', 'Another number to use. Defaults to the verified mobile.', false)], desc: 'Texts a code to turn on sign-in codes by text.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Text codes: confirm', method: 'POST', path: '/api/auth/mfa/sms/confirm', auth: 'ops', body: { code: '{{code}}' }, params: [code], desc: 'Turns on text codes.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'New backup codes', method: 'POST', path: '/api/auth/mfa/backup-codes', auth: 'ops', body: { password: '{{password}}' }, params: [pw], desc: '10 new codes. The old ones stop working.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Remove a method', method: 'DELETE', path: '/api/auth/mfa/sms', auth: 'ops', body: { password: '{{password}}' },
    params: [P('method', '"totp"|"email"|"sms"', 'In the path.', true, 'path'), pw], desc: 'Refused (400) for the last method while the account requires two-step sign-in.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Refused: wrong password (403, session kept)', method: 'DELETE', path: '/api/auth/mfa/email', auth: 'ops', body: { password: 'not-my-password' }, expect: [403],
    desc: 'A wrong password answers 403 reauth_failed, and a wrong code 400 invalid_code, never 401, so a typo does not sign anyone out.' },
  { folder: '3 · Admin · email, mobile & two-step sign-in', name: 'Admin: reset a user\'s two-step sign-in', method: 'POST', path: '/api/users/{{userId}}/mfa/reset', auth: 'admin',
    desc: 'For a lost phone. Removes their methods and backup codes and ends their sessions. Needs users:manage and covering their access.' },

  // ===== 4. apps & keys =====
  { folder: '4 · Admin · apps & keys', name: 'Register an app', method: 'POST', path: '/api/apps', auth: 'admin',
    body: { name: 'Postman web player {{$timestamp}}', type: 'web', restrictions: {} }, save: { appId: 'id', appKey: 'publishableKey.key' },
    params: [P('name', 'string', ''), P('type', '"web"|"ios"|"android"|"tv"|"roku"|"server"', ''), P('restrictions', 'object', 'Allowed web origins, bundle ids, IPs, trustAssertedViewer.', false)],
    desc: 'Returns the app and its publishable key (pk_…), shown once. The key goes in public API calls as appKey.' },
  { folder: '4 · Admin · apps & keys', name: 'List apps', method: 'GET', path: '/api/apps', auth: 'admin', desc: 'Apps with their keys (prefixes only).' },
  { folder: '4 · Admin · apps & keys', name: 'Issue an account secret key', method: 'POST', path: '/api/apps/secret-keys', auth: 'admin', save: { secretKey: 'key' },
    desc: 'sk_live_… with management scope, shown once. For the client\'s servers only (token exchange, server-to-server admin calls). Needs apps:manage and the admin tier.' },

  // ===== 5. public users (viewers) =====
  { folder: '5 · Public · account', name: 'Register', method: 'POST', path: '/api/public/auth/register', auth: 'none',
    body: { appKey: '{{appKey}}', email: 'new+{{$timestamp}}@{{domain}}', password: '{{password}}', displayName: 'New Viewer' },
    params: [P('appKey', 'string', 'The app\'s publishable key: it names the client account.'), P('email', 'string', ''), P('password', 'string', 'At least 10 characters.'), P('displayName', 'string', '', false)],
    desc: 'Creates a public user in the app\'s account and signs them in. The same answer whether or not the email exists.' },
  { folder: '5 · Public · account', name: 'Sign in', method: 'POST', path: '/api/public/auth/login', auth: 'none',
    body: { appKey: '{{appKey}}', email: '{{viewerEmail}}', password: '{{password}}' }, save: { viewerToken: 'access', viewerRefresh: 'refresh', viewerId: 'viewer.id' },
    params: [P('appKey', 'string', 'Publishable key.'), P('email', 'string', ''), P('password', 'string', '')],
    desc: 'Returns {viewer, access, refresh, expiresIn}. With two-step sign-in on: {mfaRequired, challenge, methods}.' },
  { folder: '5 · Public · account', name: 'My profile', method: 'GET', path: '/api/public/me', auth: 'viewer', desc: 'The signed-in public user.' },
  { folder: '5 · Public · account', name: 'Update my profile', method: 'PATCH', path: '/api/public/me', auth: 'viewer',
    body: { displayName: 'Fran Fan', profile: { language: 'en', newsletter: false } },
    params: [P('displayName', 'string|null', '', false), P('avatarRef', 'string|null', '', false), P('profile', 'object', 'Up to 50 free-form preferences. Never access.', false)],
    desc: 'Groups and entitlements are not editable here.' },
  { folder: '5 · Public · account', name: 'Refresh', method: 'POST', path: '/api/public/auth/refresh', auth: 'none', body: { refresh: '{{viewerRefresh}}' }, save: { viewerToken: 'access', viewerRefresh: 'refresh' },
    params: [P('refresh', 'string', 'Rotates: a reused one is refused.')], desc: 'New viewer access token carrying current groups and entitlements.' },
  { folder: '5 · Public · account', name: 'My entitlements', method: 'GET', path: '/api/public/me/entitlements', auth: 'viewer', desc: 'What the viewer holds (subscriptions, pay-per-view).' },
  { folder: '5 · Public · account', name: 'My purchases', method: 'GET', path: '/api/public/me/purchases', auth: 'viewer', desc: '' },
  { folder: '5 · Public · account', name: 'My sessions', method: 'GET', path: '/api/public/me/sessions', auth: 'viewer', desc: 'Devices signed in.' },
  { folder: '5 · Public · account', name: 'Request a password reset', method: 'POST', path: '/api/public/auth/password-reset', auth: 'none', body: { appKey: '{{appKey}}', email: '{{viewerEmail}}' },
    params: [P('appKey', 'string', ''), P('email', 'string', '')], desc: 'Emails a 6-digit code (15 minutes). The same answer whether or not the email exists. Then POST /password-reset/confirm {appKey, email, code, password}.' },
  { folder: '5 · Public · account', name: 'Token exchange (client\'s own sign-in)', method: 'POST', path: '/api/public/auth/token-exchange', auth: 'secret',
    body: { externalId: 'crm-{{$timestamp}}', email: 'member+{{$timestamp}}@{{domain}}', displayName: 'Club Member', groups: ['members'] },
    params: [P('externalId', 'string', 'Your id for the person.'), P('email', 'string', '', false), P('displayName', 'string', '', false), P('groups', 'string[]', 'Feeds members-only rules.', false), P('appId', 'uuid', '', false)],
    desc: 'For clients with their own identity provider: their SERVER (secret key) vouches for a viewer and gets Volt viewer tokens to hand to the app. Never call this from an app.' },

  // ===== 6. public security =====
  { folder: '6 · Public · email, mobile & two-step sign-in', name: 'Security summary', method: 'GET', path: '/api/public/me/security', auth: 'viewer', desc: 'Same shape as the admin one. Two-step sign-in is optional for public users.' },
  { folder: '6 · Public · email, mobile & two-step sign-in', name: 'Turn on email codes: send', method: 'POST', path: '/api/public/me/mfa/email/start', auth: 'viewer', body: { password: '{{password}}' }, save: { code: 'devCode' }, params: [pw], desc: '' },
  { folder: '6 · Public · email, mobile & two-step sign-in', name: 'Turn on email codes: confirm', method: 'POST', path: '/api/public/me/mfa/email/confirm', auth: 'viewer', body: { code: '{{code}}' }, params: [code], desc: 'Returns backup codes the first time.' },
  { folder: '6 · Public · email, mobile & two-step sign-in', name: 'Sign in: now a challenge', method: 'POST', path: '/api/public/auth/login', auth: 'none',
    body: { appKey: '{{appKey}}', email: '{{viewerEmail}}', password: '{{password}}' }, save: { challenge: 'challenge' }, desc: '' },
  { folder: '6 · Public · email, mobile & two-step sign-in', name: 'Second step: send', method: 'POST', path: '/api/public/auth/mfa/challenge/send', auth: 'challenge',
    body: { challenge: '{{challenge}}', method: 'email' }, save: { code: 'devCode' }, params: [ch, P('method', '"email"|"sms"', '')], desc: '' },
  { folder: '6 · Public · email, mobile & two-step sign-in', name: 'Second step: verify', method: 'POST', path: '/api/public/auth/mfa/challenge/verify', auth: 'challenge',
    body: { challenge: '{{challenge}}', method: 'email', code: '{{code}}' }, save: { viewerToken: 'access', viewerRefresh: 'refresh' },
    params: [ch, P('method', '"totp"|"email"|"sms"|"backup"', ''), P('code', 'string', '')], desc: 'Returns {viewer, access, refresh}.' },
  { folder: '6 · Public · email, mobile & two-step sign-in', name: 'Change email: send', method: 'POST', path: '/api/public/me/email/change', auth: 'viewer',
    body: { newEmail: 'fan-new+{{$timestamp}}@{{domain}}', password: '{{password}}' }, save: { code: 'devCode' }, params: [P('newEmail', 'string', 'Unique within the client account.'), pw], desc: '' },
  { folder: '6 · Public · email, mobile & two-step sign-in', name: 'Change email: confirm', method: 'POST', path: '/api/public/me/email/change/confirm', auth: 'viewer', body: { code: '{{code}}' }, save: { viewerEmail: 'email' }, params: [code], desc: '' },
  { folder: '6 · Public · email, mobile & two-step sign-in', name: 'Mobile number: send', method: 'POST', path: '/api/public/me/phone', auth: 'viewer', body: { phone: '+61498765432', password: '{{password}}' }, save: { code: 'devCode' }, params: [P('phone', 'string', 'E.164.'), pw], desc: '' },
  { folder: '6 · Public · email, mobile & two-step sign-in', name: 'Mobile number: confirm', method: 'POST', path: '/api/public/me/phone/confirm', auth: 'viewer', body: { code: '{{code}}' }, params: [code], desc: '' },
  { folder: '6 · Public · email, mobile & two-step sign-in', name: 'Remove email codes', method: 'DELETE', path: '/api/public/me/mfa/email', auth: 'viewer', body: { password: '{{password}}' }, params: [pw], desc: 'Removing the last method also removes the backup codes.' },

  // ===== 7. playback =====
  { folder: '7 · Public · who can watch', name: 'Play gate (anonymous, edge cached)', method: 'GET', path: '/api/public/availability?appKey={{appKey}}&assetId={{channelId}}', auth: 'none',
    params: [P('appKey', 'string', 'Publishable key.', true, 'query'), P('assetId', 'string', 'Channel, event or VOD id.', true, 'query'), P('geo', 'string', 'ISO country. Ignored when the edge supplies it.', false, 'query')],
    desc: 'Allowed or not, why, and a short-lived playback token. The anonymous GET is cached at the edge per app, asset and country.' },
  { folder: '7 · Public · who can watch', name: 'Play gate (signed-in viewer)', method: 'POST', path: '/api/public/availability', auth: 'viewer',
    body: { appKey: '{{appKey}}', assetId: '{{channelId}}' },
    params: [P('appKey', 'string', ''), P('assetId', 'string', ''), P('geo', 'string', '', false)],
    desc: 'The viewer token decides groups and entitlements. Body viewer/entitled are ignored unless the app has trustAssertedViewer. Never edge cached.' },
  { folder: '7 · Public · who can watch', name: 'Access check (booleans, no token)', method: 'POST', path: '/api/public/access/check', auth: 'none',
    body: { appKey: '{{appKey}}', assetId: '{{channelId}}' }, params: [P('appKey', 'string', ''), P('assetId', 'string', '')], desc: 'For catalogue screens: can this be played, without minting a token.' },

  // ===== 8. admin: public users =====
  { folder: '8 · Admin · public users', name: 'Find public users', method: 'GET', path: '/api/viewers?q=fan&limit=20', auth: 'admin',
    params: [P('q', 'string', 'Email, name or external id.', false, 'query'), P('status', '"active"|"disabled"|"deleted"', '', false, 'query'), P('limit', 'number', '1 to 200.', false, 'query'), P('offset', 'number', '', false, 'query')],
    desc: 'Needs viewers:view.' },
  { folder: '8 · Admin · public users', name: 'Get a public user', method: 'GET', path: '/api/viewers/{{viewerId}}', auth: 'admin', desc: 'With entitlements, purchases, active sessions and two-step status.' },
  { folder: '8 · Admin · public users', name: 'Change groups', method: 'PATCH', path: '/api/viewers/{{viewerId}}', auth: 'admin', body: { groups: ['members'] },
    params: [P('status', '"active"|"disabled"', '', false), P('groups', 'string[]', '', false), P('displayName', 'string|null', '', false)],
    desc: 'Group changes end the viewer\'s tokens so the next one carries them. Needs viewers:manage.' },
  { folder: '8 · Admin · public users', name: 'Sign out everywhere', method: 'POST', path: '/api/viewers/{{viewerId}}/sign-out', auth: 'admin', desc: 'Needs viewers:operate.' },
  { folder: '8 · Admin · public users', name: 'Reset two-step sign-in', method: 'POST', path: '/api/viewers/{{viewerId}}/mfa/reset', auth: 'admin', desc: 'Needs viewers:manage.' },

  // ===== 9. broadcast (groups, channels, stations, events) =====
  { folder: '9 · Admin · channel groups, channels, stations, events', name: 'List channel groups', method: 'GET', path: '/api/groups', auth: 'admin',
    desc: 'The group name is the line shown under each item in the lists. Readable by any admin user (form lookups).' },
  { folder: '9 · Admin · channel groups, channels, stations, events', name: 'Rename a group', method: 'PATCH', path: '/api/groups/{{groupId}}', auth: 'admin', body: { name: 'News & Current Affairs' },
    params: [P('name', 'string', 'Unique in the account.', false), P('outputProfileId', 'uuid', 'Another profile of the SAME workflow type.', false)],
    desc: 'Needs settings:manage. Caps (max channels, running at once) are set by platform staff.' },
  { folder: '9 · Admin · channel groups, channels, stations, events', name: 'Create a TV channel', method: 'POST', path: '/api/channels', auth: 'admin',
    body: { groupId: '{{groupId}}', name: 'Postman TV {{$timestamp}}', kind: 'tv' }, save: { newChannelId: 'id' },
    params: [P('groupId', 'uuid', 'The channel group.'), P('name', 'string', ''), P('kind', '"tv"|"radio"', 'radio needs radio:manage instead of channels:manage.', false), P('sources', 'object[]', 'Inputs.', false), P('outputLadder', 'object[]', 'Renditions (transcode groups).', false), P('dvrWindowSec', 'number', '', false)],
    desc: 'Enforces the group\'s max channels.' },
  { folder: '9 · Admin · channel groups, channels, stations, events', name: 'Create a radio station', method: 'POST', path: '/api/channels', auth: 'radio',
    body: { groupId: '{{groupId}}', name: 'Postman FM {{$timestamp}}', kind: 'radio' }, save: { stationId: 'id' },
    desc: 'Stations are channels with kind radio. The Radio Manager can create them and cannot touch TV.' },
  { folder: '9 · Admin · channel groups, channels, stations, events', name: 'List stations', method: 'GET', path: '/api/radio', auth: 'radio', desc: 'Needs radio:view.' },
  { folder: '9 · Admin · channel groups, channels, stations, events', name: 'Refused: Radio Manager opens a TV channel', method: 'GET', path: '/api/channels/{{newChannelId}}', auth: 'radio', expect: [403],
    desc: '403 forbidden_feature, feature channels, level view.' },
  { folder: '9 · Admin · channel groups, channels, stations, events', name: 'Sign in as the System Viewer', method: 'POST', path: '/api/auth/login', auth: 'none',
    body: { email: '{{sysViewerEmail}}', password: '{{password}}' }, save: { sysViewerToken: 'access' }, desc: 'Read-only role.' },
  { folder: '9 · Admin · channel groups, channels, stations, events', name: 'Refused: System Viewer starts a channel', method: 'POST', path: '/api/channels/{{newChannelId}}/start', auth: 'sysviewer', body: {}, expect: [403],
    desc: 'Start and stop need channels:operate.' },
  { folder: '9 · Admin · channel groups, channels, stations, events', name: 'Delete the test channel', method: 'DELETE', path: '/api/channels/{{newChannelId}}', auth: 'admin', expect: [200, 204], desc: '' },

  // ===== 10. content (carried from the original collection, recaptured) =====
  ...(JSON.parse(readFileSync(join(__dirname, 'content-steps.json'), 'utf8')) as Step[]).map((s) =>
    s.auth === 'ingest' ? { ...s, folder: '12 · Machine · encoder report', headers: { 'X-Volt-Ingest-Token': '{{ingestToken}}' } } : { ...s, folder: s.folder.replace('Admin · content:', '10 · Admin · content:') }),

  // ===== 11. platform =====
  { folder: '11 · Platform (Volt staff)', name: 'Platform sign-in: password', method: 'POST', path: '/api/platform/auth/login', auth: 'none',
    body: { email: '{{staffEmail}}', password: '{{password}}' }, save: { mfaToken: 'mfaToken', staffTotpSecret: 'secret' },
    params: [P('email', 'string', 'A user with a platform role.'), P('password', 'string', '')],
    desc: 'First time: {enroll, secret, otpauthUri, mfaToken} (set up the authenticator). After that: {mfa_required, mfaToken}.' },
  { folder: '11 · Platform (Volt staff)', name: 'Platform sign-in: authenticator code', method: 'POST', path: '/api/platform/auth/mfa', auth: 'none',
    body: { mfaToken: '{{mfaToken}}', code: '{{totpCode}}' }, totp: { secretVar: 'staffTotpSecret' }, save: { platformToken: 'accessToken' },
    params: [P('mfaToken', 'string', 'From the password step, 5 minutes.'), P('code', 'string', 'Authenticator code.')],
    desc: 'Returns the platform session (audience volt:platform, 1 hour). The only token /api/platform accepts.' },
  { folder: '11 · Platform (Volt staff)', name: 'Client accounts', method: 'GET', path: '/api/platform/accounts', auth: 'platform', save: { platformAccountId: '0.id' }, desc: 'Every client account.' },
  { folder: '11 · Platform (Volt staff)', name: 'An account\'s groups', method: 'GET', path: '/api/platform/accounts/{{accountId}}/groups', auth: 'platform', desc: 'Groups with caps and use.' },
  { folder: '11 · Platform (Volt staff)', name: 'Change a group\'s caps', method: 'PATCH', path: '/api/platform/accounts/{{accountId}}/groups/{{groupId}}', auth: 'platform',
    body: { maxChannels: 12, maxConcurrent: 6 },
    params: [P('name', 'string', '', false), P('maxChannels', 'number', 'Not below the channels in use.', false), P('maxConcurrent', 'number', '', false)], desc: 'Entitlements: platform only. Audit logged.' },
  { folder: '11 · Platform (Volt staff)', name: 'Sign in to the admin console as staff', method: 'POST', path: '/api/auth/login', auth: 'none',
    body: { email: '{{staffEmail}}', password: '{{password}}' }, save: { challenge: 'challenge' },
    desc: 'The authenticator set up for the platform is also a second step for the console, so this answers with a challenge.' },
  { folder: '11 · Platform (Volt staff)', name: 'Console second step with the authenticator', method: 'POST', path: '/api/auth/mfa/challenge/verify', auth: 'challenge',
    body: { challenge: '{{challenge}}', method: 'totp', code: '{{totpCode}}' }, totp: { secretVar: 'staffTotpSecret', offset: 1 }, save: { staffAdminToken: 'access' },
    desc: 'An admin session (audience volt:admin). It is still not a platform session.' },
  { folder: '11 · Platform (Volt staff)', name: 'Refused: platform API with a password-only session', method: 'GET', path: '/api/platform/accounts', auth: 'staff', expect: [403],
    desc: '403 platform_mfa_required: the console then asks for the authenticator code (step-up).' },
  { folder: '11 · Platform (Volt staff)', name: 'Step-up to a platform session', method: 'POST', path: '/api/platform/auth/step-up', auth: 'staff',
    body: { code: '{{totpCode}}' }, totp: { secretVar: 'staffTotpSecret', offset: 0 }, save: { platformToken: 'accessToken' },
    params: [P('code', 'string', 'Authenticator code. Without it, the answer says whether set-up or a code is needed.', false)], desc: 'From an admin session to a platform session, without signing in again.' },

  // ===== 13. the splits =====
  { folder: '13 · The splits: tokens never cross', name: 'Viewer token on the admin API', method: 'GET', path: '/api/channels', auth: 'viewer', expect: [401], desc: 'Viewer tokens are signed with another key: 401.' },
  { folder: '13 · The splits: tokens never cross', name: 'Admin token on the public account API', method: 'GET', path: '/api/public/me', auth: 'admin', expect: [401], desc: 'The public API takes only viewer sessions: 401.' },
  { folder: '13 · The splits: tokens never cross', name: 'A sign-in challenge is not a session', method: 'GET', path: '/api/channels', auth: 'challenge', headers: { Authorization: 'Bearer {{challenge}}' }, expect: [401], desc: '401.' },
  { folder: '13 · The splits: tokens never cross', name: 'No credential', method: 'GET', path: '/api/channels', auth: 'none', expect: [401], desc: '401.' },
  { folder: '13 · The splits: tokens never cross', name: 'Admin sign-out', method: 'POST', path: '/api/auth/logout', auth: 'admin', body: { refresh: '{{adminRefresh}}' }, expect: [204], desc: 'Revokes the refresh token.' },
  { folder: '13 · The splits: tokens never cross', name: 'Public sign-out', method: 'POST', path: '/api/public/auth/logout', auth: 'none', body: { refresh: '{{viewerRefresh}}' }, expect: [204], desc: 'Revokes the viewer refresh token.' },
];

/* ---- run it ------------------------------------------------------------------------------- */
const env: Record<string, string> = {
  baseUrl: BASE, domain: process.env.SEED_DOMAIN ?? 'volt.test', password: process.env.SEED_PASSWORD ?? 'VoltTest!2026',
  adminEmail: `admin@${process.env.SEED_DOMAIN ?? 'volt.test'}`, radioEmail: `radio@${process.env.SEED_DOMAIN ?? 'volt.test'}`,
  sysViewerEmail: `viewer@${process.env.SEED_DOMAIN ?? 'volt.test'}`, viewerEmail: `fan@${process.env.SEED_DOMAIN ?? 'volt.test'}`,
  staffEmail: `staff@${process.env.SEED_DOMAIN ?? 'volt.test'}`, ingestToken: process.env.INGEST_TOKEN ?? 'dev-ingest',
  accountId: process.env.ACCOUNT_ID ?? '', vodId: process.env.VOD_ID ?? '', groupId: process.env.GROUP_ID ?? '', channelId: process.env.CHANNEL_ID ?? '', recordingId: process.env.RECORDING_ID ?? '',
};
const sub = (v: any): any => {
  if (typeof v === 'string') return v.replace(/\{\{\$timestamp\}\}/g, TS).replace(/\{\{(\w+)\}\}/g, (_, k) => env[k] ?? `{{${k}}}`);
  if (Array.isArray(v)) return v.map(sub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
  return v;
};
const pick = (j: any, path: string): any => {
  if (path.startsWith('@role:')) return Array.isArray(j) ? j.find((r: any) => r.role_key === path.slice(6) || r.key === path.slice(6) || r.roleKey === path.slice(6))?.id : undefined;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), j);
};

/** Long strings (tokens, keys) shortened in saved examples so the docs stay readable. */
function trim(v: any, depth = 0): any {
  if (typeof v === 'string') return v.length > 90 && !v.includes(' ') ? `${v.slice(0, 24)}…(${v.length} chars)` : v;
  if (Array.isArray(v)) { const a = v.slice(0, 3).map((x) => trim(x, depth + 1)); if (v.length > 3) a.push(`… ${v.length - 3} more`); return a; }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k,
    // Secrets are shortened even in a throwaway capture: the docs are shared.
    k === 'secret' && typeof x === 'string' ? `${x.slice(0, 4)}…(base32, ${x.length} chars)`
      : k === 'key' && typeof x === 'string' && /^(sk|pk)_/.test(x) ? `${x.slice(0, 12)}…(shown once)`
      : k === 'key' && typeof x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(x) ? `${x.slice(0, 6)}…(image signing key)`
      : k === 'backupCodes' && Array.isArray(x) ? [...x.slice(0, 2).map(() => 'xxxx-xxxx'), `… ${x.length} codes, shown once`]
      : trim(x, depth + 1)]));
  return v;
}

interface Captured extends Step { status: number; response: any; access: string; credential: string; api: string; ran: boolean; ok: boolean; url: string }
const routes: any[] = JSON.parse(readFileSync(join(ROOT, 'docs', 'api-routes.json'), 'utf8'));
const norm = (p: string) => p.split('?')[0].replace(/\{\{[^}]+\}\}/g, '*').replace(/:[A-Za-z_]+(\([^)]*\))?/g, '*').replace(/\/+$/, '');
function routeFor(method: string, path: string) {
  const want = norm(path).split('/');
  const cands = routes.filter((r) => r.method === method && norm(r.path).split('/').length === want.length);
  const literal = path.split('?')[0].split('/');
  return cands.find((r) => norm(r.path).split('/').every((seg: string, i: number) => seg === want[i] || (seg === '*' && want[i] !== undefined)) &&
      r.path.split('/').every((seg: string, i: number) => !/^:\w+\(/.test(seg) || seg.slice(seg.indexOf('(') + 1, -1).split('|').includes(literal[i])))
    ?? cands.find((r) => norm(r.path) === norm(path));
}

async function run(): Promise<Captured[]> {
  const out: Captured[] = [];
  let failures = 0;
  for (const s of steps) {
    const r = routeFor(s.method, s.path);
    const meta = { access: r?.access ?? '', credential: r?.credential ?? '', api: r?.api ?? '' };
    if (s.external) { out.push({ ...s, ...meta, status: 0, response: null, ran: false, ok: true, url: s.path }); continue; }
    if (s.totp) {
      const secret = env[s.totp.secretVar];
      env.totpCode = secret ? totpAt(secret, Math.floor(Date.now() / 1000) + 30 * (s.totp.offset ?? 0)) : '';
    }
    const url = BASE + sub(s.path);
    const headers: Record<string, string> = { 'content-type': 'application/json', ...sub(s.headers ?? {}) };
    const tv = TOKEN_VAR[s.auth];
    if (tv && env[tv]) headers.authorization = `Bearer ${env[tv]}`;
    const body = s.body === undefined ? undefined : JSON.stringify(sub(s.body));
    let status = 0, json: any = null;
    try {
      const res = await fetch(url, { method: s.method, headers, body });
      status = res.status;
      const ct = res.headers.get('content-type') ?? '';
      if (ct.startsWith('image/')) json = `(${ct}, ${(await res.arrayBuffer()).byteLength} bytes, X-Image-Cache: ${res.headers.get('x-image-cache')})`;
      else {
        const text = await res.text();
        try { json = text ? JSON.parse(text) : null; } catch { json = text.slice(0, 400); }
      }
    } catch (e: any) { json = { error: e.message }; }
    const ok = s.expect ? s.expect.includes(status) : status >= 200 && status < 300;
    if (!ok) { failures++; console.log(`FAIL ${s.method} ${s.path} (${s.name}) -> ${status} ${JSON.stringify(json).slice(0, 200)}`); }
    else console.log(`ok   ${status} ${s.method} ${s.path}`);
    for (const [k, p] of Object.entries(s.save ?? {})) { const v = pick(json, p); if (v != null) env[k] = String(v); }
    if (s.path === '/api/platform/accounts' && Array.isArray(json)) {
      const mine = json.find((a: any) => a.id === env.accountId) ?? json[0];
      if (mine && !env.accountId) env.accountId = mine.id;
    }
    out.push({ ...s, ...meta, status, response: trim(json), ran: true, ok, url: sub(s.path) });
  }
  console.log(`\n${out.filter((o) => o.ran).length} requests run, ${failures} not as expected`);
  if (failures) process.exitCode = 1;
  return out;
}

/* ---- Postman --------------------------------------------------------------------------------- */
const TOTP_SCRIPT = (secretVar: string, offset = 0) => [
  `// Works out the authenticator code from {{${secretVar}}} (RFC 6238, SHA-1, 30 s).`,
  `const CJ = require('crypto-js');`,
  `const b32 = (pm.environment.get('${secretVar}') || pm.collectionVariables.get('${secretVar}') || '').replace(/\\s|=/g, '').toUpperCase();`,
  `const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';`,
  `for (const c of b32) bits += A.indexOf(c).toString(2).padStart(5, '0');`,
  `let hex = ''; for (let i = 0; i + 8 <= bits.length; i += 8) hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, '0');`,
  `const counter = Math.floor(Date.now() / 1000 / 30) + ${offset};`,
  `const msg = CJ.enc.Hex.parse(counter.toString(16).padStart(16, '0'));`,
  `const h = CJ.HmacSHA1(msg, CJ.enc.Hex.parse(hex)).toString();`,
  `const o = parseInt(h.slice(-1), 16);`,
  `const n = (parseInt(h.substr(o * 2, 8), 16) & 0x7fffffff) % 1000000;`,
  `pm.environment.set('totpCode', String(n).padStart(6, '0'));`,
];

function describe(c: Captured): string {
  const lines = [c.desc || ''];
  lines.push('', `**API:** ${c.api || 'n/a'} · **Credential:** ${AUTH_LABEL[c.auth]}${c.access ? ` · **Access:** ${c.access}` : ''}`);
  if (c.params?.length) {
    lines.push('', '| Parameter | In | Type | Required | Notes |', '|---|---|---|---|---|');
    for (const p of c.params) lines.push(`| \`${p.name}\` | ${p.in} | ${p.type.replace(/\|/g, '\\|')} | ${p.required ? 'yes' : 'no'} | ${p.desc.replace(/\|/g, '\\|')} |`);
  }
  if (c.expect && !c.expect.some((x) => x < 300)) lines.push('', `Expected answer: **${c.expect.join(' or ')}** (this request shows a refusal on purpose).`);
  return lines.join('\n').trim();
}

function postmanItem(c: Captured) {
  const raw = (c.path.startsWith('{{') ? '' : '{{baseUrl}}') + c.path;
  const [p, q] = raw.split('?');
  const url: any = { raw, host: [p.startsWith('{{baseUrl}}') ? '{{baseUrl}}' : p.split('/')[0]], path: p.replace(/^\{\{\w+\}\}\/?/, '').split('/').filter(Boolean) };
  if (q) url.query = q.split('&').map((kv) => { const [key, value] = kv.split('='); return { key, value }; });
  const header = Object.entries(c.headers ?? {}).filter(([k]) => k.toLowerCase() !== 'authorization').map(([key, value]) => ({ key, value }));
  if (c.body !== undefined) header.push({ key: 'Content-Type', value: 'application/json' });
  const tv = TOKEN_VAR[c.auth];
  const auth = c.headers?.Authorization ? { type: 'bearer', bearer: [{ key: 'token', value: c.headers.Authorization.replace(/^Bearer /, ''), type: 'string' }] }
    : tv ? { type: 'bearer', bearer: [{ key: 'token', value: `{{${tv}}}`, type: 'string' }] } : { type: 'noauth' };
  const event: any[] = [];
  if (c.external) event.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: [
    `// Needs a service outside this API. Set externalUp=1 in the environment when it runs.`,
    `if (!pm.environment.get('externalUp')) pm.execution.skipRequest();`] } });
  if (c.totp) event.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: TOTP_SCRIPT(c.totp.secretVar, c.totp.offset ?? 0) } });
  const test = [
    c.expect ? `pm.test('answers ${c.expect.join(' or ')}', () => pm.expect([${c.expect.join(',')}]).to.include(pm.response.code));`
      : `pm.test('answers 2xx', () => pm.expect(pm.response.code).to.be.within(200, 299));`,
  ];
  const saves = Object.entries(c.save ?? {});
  if (saves.length) {
    test.push(`let j = {}; try { j = pm.response.json(); } catch (e) {}`);
    for (const [k, path] of saves) {
      if (path.startsWith('@role:')) test.push(`{ const r = (Array.isArray(j) ? j : []).find(x => x.key === '${path.slice(6)}' || x.role_key === '${path.slice(6)}'); if (r) pm.environment.set('${k}', r.id); }`);
      else test.push(`{ const v = ${['j', ...path.split('.').map((x) => (/^\d+$/.test(x) ? `[${x}]` : `?.['${x}']`))].join('')}; if (v !== undefined && v !== null) pm.environment.set('${k}', String(v)); }`);
    }
  }
  if (c.path === '/api/platform/accounts') test.push(`if (!pm.environment.get('accountId') && Array.isArray(j) && j[0]) pm.environment.set('accountId', j[0].id);`);
  event.push({ listen: 'test', script: { type: 'text/javascript', exec: test } });
  const body = c.body === undefined ? undefined : { mode: 'raw', raw: JSON.stringify(c.body, null, 2), options: { raw: { language: 'json' } } };
  const request: any = { method: c.method, header, url, auth, description: describe(c) };
  if (body) request.body = body;
  const response = c.ran ? [{
    name: `${c.status} example`, originalRequest: { method: c.method, header, url, ...(body ? { body } : {}) },
    status: String(c.status), code: c.status, _postman_previewlanguage: 'json',
    header: [{ key: 'Content-Type', value: 'application/json' }], body: c.response == null ? '' : JSON.stringify(c.response, null, 2),
  }] : [];
  return { name: c.name, event, request, response };
}

const FOLDER_NOTES: Record<string, string> = {
  '0': 'No credential.',
  '1': 'Admin users (a client\'s staff) sign in here. The access token is audience volt:admin.',
  '2': 'Needs users and access features. No escalation: nobody can give more than they hold.',
  '3': 'The signed-in user\'s own email, mobile and two-step sign-in (ACCESS_CONTROL.md section 12).',
  '4': 'Apps get publishable keys for the public API. The secret key is for the client\'s servers.',
  '5': 'The public API: the audience. Every call names the app by its publishable key or carries a viewer session (audience volt:viewer, a different signing key).',
  '6': 'Optional for public users.',
  '7': 'The play gate.',
  '8': 'How the client\'s staff see their audience. Feature viewers.',
  '9': 'Radio stations are channels with kind radio and are gated by the radio feature.',
  '10': 'Content endpoints carried over from the first collection, recaptured. Each says the feature and level it needs.',
  '11': 'Volt staff only. A platform session exists only after the authenticator step.',
  '12': 'Encoders and the thumbnailer report with the ingest token, not a user session.',
  '13': 'Each API refuses the others\' credentials.',
};

function writePostman(all: Captured[]) {
  const folders = [...new Set(all.map((c) => c.folder))];
  const collection = {
    info: {
      _postman_id: 'volt-api-2026-10',
      name: 'Volt Streaming API (public, admin, platform)',
      description: [
        'Built from a live run by api/capture_api.sh (api/build.ts). Every request carries a saved example.',
        '',
        '**Three APIs, three kinds of credential:**',
        '- **Public** `/api/public/*`: apps and players. A publishable key (`appKey`) names the client account. Viewer sessions are Bearer tokens (audience volt:viewer).',
        '- **Admin** `/api/*`: a client\'s staff. Admin session (audience volt:admin) or the account secret key. Each route needs a feature and level from the user\'s roles.',
        '- **Platform** `/api/platform/*`: Volt staff, after the authenticator step.',
        '',
        '**Run it:** import this and Volt.postman_environment.json, set baseUrl, domain and password to match a seeded server (npm run seed:access; SEED_PLATFORM_STAFF=1 for the platform folder), and run the folders in order: each request saves what the next needs (tokens, ids, codes).',
        'On a test server started with SECURITY_CODE_ECHO=1 the emailed and texted codes come back as devCode and are picked up automatically. Elsewhere, read the code from the email or text and set {{code}}. Authenticator codes are worked out by the pre-request script from the saved secret.',
        '',
        'Full guide: docs/API_GUIDE.md. Every route: docs/API_ROUTES.md. Access model: ACCESS_CONTROL.md.',
      ].join('\n'),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'noauth' },
    item: folders.map((f) => ({
      name: f,
      description: FOLDER_NOTES[f.split(' ')[0]] ?? '',
      item: all.filter((c) => c.folder === f).map(postmanItem),
    })),
  };
  writeFileSync(join(__dirname, 'Volt.postman_collection.json'), JSON.stringify(collection, null, 2) + '\n');
  const keep = ['baseUrl', 'domain', 'password', 'adminEmail', 'radioEmail', 'sysViewerEmail', 'viewerEmail', 'staffEmail', 'ingestToken'];
  const blank = ['accountId', 'groupId', 'channelId', 'recordingId', 'appKey', 'adminToken', 'adminRefresh', 'opsToken', 'radioToken', 'sysViewerToken', 'staffAdminToken',
    'viewerToken', 'viewerRefresh', 'platformToken', 'secretKey', 'challenge', 'code', 'totpSecret', 'staffTotpSecret', 'totpCode', 'mfaToken'];
  const values = [
    ...keep.map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:8080' : key === 'domain' ? 'volt.test' : key === 'ingestToken' ? 'dev-ingest' : sub(`{{${key}}}`).replace(process.env.SEED_DOMAIN ?? 'volt.test', 'volt.test'), enabled: true })),
    ...blank.map((key) => ({ key, value: '', enabled: true })),
  ];
  writeFileSync(join(__dirname, 'Volt.postman_environment.json'), JSON.stringify({ name: 'Volt Local', values }, null, 2) + '\n');
}

/* ---- API.md and the playground ------------------------------------------------------------------ */
function writeMarkdown(all: Captured[]) {
  const folders = [...new Set(all.map((c) => c.folder))];
  let md = `# Volt Streaming: API reference (request by request)\n\n` +
    `Generated by \`api/capture_api.sh\` from a live run: every example below is a real response (long tokens shortened). Do not edit by hand.\n\n` +
    `- **How to use the API** (credentials, the public/admin/platform split, sign-in, errors): [API_GUIDE.md](API_GUIDE.md)\n` +
    `- **Every route** with its credential and the feature and level it needs: [API_ROUTES.md](API_ROUTES.md)\n` +
    `- **Postman:** \`api/Volt.postman_collection.json\` + \`api/Volt.postman_environment.json\` (the same requests, runnable in order)\n` +
    `- **Searchable page:** [api-playground.html](api-playground.html)\n\n## Contents\n\n` +
    folders.map((f) => `- [${f}](#${f.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ +/g, '-')})`).join('\n') + '\n';
  for (const f of folders) {
    md += `\n## ${f}\n\n${FOLDER_NOTES[f.split(' ')[0]] ?? ''}\n`;
    for (const c of all.filter((x) => x.folder === f)) {
      md += `\n### ${c.name}\n\n\`${c.method} ${c.path}\`\n\n${describe(c)}\n`;
      if (c.body !== undefined) md += `\n**Request body**\n\n\`\`\`json\n${JSON.stringify(c.body, null, 2)}\n\`\`\`\n`;
      if (c.ran) md += `\n**Response \`${c.status}\`**\n\n\`\`\`json\n${JSON.stringify(c.response, null, 2) ?? ''}\n\`\`\`\n`;
      else md += `\n_Not run by the capture: needs a service outside this API._\n`;
    }
  }
  writeFileSync(join(ROOT, 'docs', 'API.md'), md);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const METHOD_COLOR: Record<string, string> = { GET: '#2563eb', POST: '#16a34a', PUT: '#d97706', PATCH: '#9333ea', DELETE: '#dc2626' };
const API_COLOR: Record<string, string> = { public: '#0ea5e9', admin: '#818cf8', platform: '#f59e0b', 'sign-in': '#22c55e', machine: '#94a3b8', discovery: '#94a3b8' };
function writePlayground(all: Captured[]) {
  const tmpl = readFileSync(join(ROOT, 'docs', 'api-playground.html'), 'utf8');
  const head = tmpl.slice(0, tmpl.indexOf('</style>')) +
    ` .api{font-size:11px;font-weight:700;padding:1px 7px;border-radius:20px;border:1px solid currentColor}\n .chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}\n .chip{background:none;border:1px solid var(--line);color:var(--mut);border-radius:20px;padding:3px 10px;font-size:12px;cursor:pointer}\n .chip.on{color:var(--ink);border-color:var(--blue)}\n table{border-collapse:collapse;width:100%;font-size:12px;margin-top:6px} td,th{border:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top} th{color:var(--mut);font-weight:600}\n .meta{color:var(--mut);font-size:12px;margin-top:4px}\n</style></head><body>\n`;
  const apis = ['public', 'sign-in', 'admin', 'platform', 'machine', 'discovery'];
  let html = head + `<header>\n  <h1><svg class="vmark" viewBox="0 0 24 24" width="1em" height="1em" style="vertical-align:-0.12em" aria-hidden="true"><defs><linearGradient id="vmk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b8cff"/><stop offset="1" stop-color="#4f46e5"/></linearGradient></defs><path fill="url(#vmk)" d="M14 1 3.5 14H11zM10 23 20.5 10H13z"/></svg> Volt Streaming: API playground</h1>\n  <div class=sub>${all.length} requests · public, admin and platform APIs · captured live by api/capture_api.sh</div>\n` +
    `  <input id=q placeholder="Filter: method, path, name, feature…" oninput="flt()">\n  <div class=chips>${['all', ...apis].map((a) => `<button class="chip${a === 'all' ? ' on' : ''}" data-a="${a}" onclick="pick(this)">${a}</button>`).join('')}</div>\n  <div class=count id=cnt></div>\n</header>\n<div class=wrap id=list>\n`;
  for (const c of all) {
    const params = c.params?.length ? `<div class=lbl>Parameters</div><table><tr><th>Name</th><th>In</th><th>Type</th><th>Req.</th><th>Notes</th></tr>${c.params.map((p) => `<tr><td><code>${esc(p.name)}</code></td><td>${p.in}</td><td>${esc(p.type)}</td><td>${p.required ? 'yes' : ''}</td><td>${esc(p.desc)}</td></tr>`).join('')}</table>` : '';
    html += `    <div class="card" data-a="${esc(c.api)}" data-s="${esc(`${c.folder} ${c.name} ${c.method} ${c.path} ${c.access} ${c.api}`.toLowerCase())}">\n      <div class="head">\n        <span class="m" style="background:${METHOD_COLOR[c.method] ?? '#555'}">${c.method}</span>\n        <code class="path">${esc(c.path)}</code>\n        <span class="api" style="color:${API_COLOR[c.api] ?? '#94a3b8'}">${esc(c.api || 'external')}</span>\n        <span class="folder">${esc(c.folder)}</span>\n        <span class="code" style="color:${c.ok ? '#16a34a' : '#dc2626'}">${c.ran ? c.status : '—'}</span>\n      </div>\n      <div class="desc"><b>${esc(c.name)}.</b> ${esc(c.desc)}</div>\n      <div class="meta">Credential: ${esc(AUTH_LABEL[c.auth])}${c.access ? ` · Access: ${esc(c.access)}` : ''}</div>\n      ${params}\n` +
      (c.body !== undefined ? `      <div class=lbl>Request</div>\n      <pre class="req">${esc(JSON.stringify(c.body, null, 2))}</pre>\n` : '') +
      (c.ran ? `      <div class=lbl>Response</div>\n      <pre class="resp">${esc(JSON.stringify(c.response, null, 2) ?? '')}</pre>\n` : '') + `    </div>\n`;
  }
  html += `</div>\n<script>\n let api='all';\n const cards=[...document.querySelectorAll('.card')],cnt=document.getElementById('cnt');\n function pick(b){api=b.dataset.a;document.querySelectorAll('.chip').forEach(x=>x.classList.toggle('on',x===b));flt();}\n function flt(){const v=document.getElementById('q').value.toLowerCase().trim();let n=0;\n   cards.forEach(c=>{const m=(!v||c.dataset.s.includes(v))&&(api==='all'||c.dataset.a===api);c.style.display=m?'':'none';if(m)n++;});\n   cnt.textContent=n+' / '+cards.length+' shown';}\n flt();\n</script></body></html>\n`;
  writeFileSync(join(ROOT, 'docs', 'api-playground.html'), html);
}

run().then((all) => {
  // The raw capture is kept out of the repo (the four outputs carry it).
  writeFileSync(process.env.CAPTURE_OUT ?? join(require('node:os').tmpdir(), 'volt-api-captured.json'), JSON.stringify(all, null, 1) + '\n');
  writePostman(all);
  writeMarkdown(all);
  writePlayground(all);
  console.log('wrote api/Volt.postman_collection.json, api/Volt.postman_environment.json, docs/API.md, docs/api-playground.html');
});
