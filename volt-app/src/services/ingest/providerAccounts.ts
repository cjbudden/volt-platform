// ============================================================================
//  LINKED PROVIDER ACCOUNTS — OAuth for Dropbox, OneDrive and Google Drive,
//  credentials for Aspera, MASV and Signiant. Tokens are refreshed here and
//  nowhere else. App credentials come from the environment per provider.
// ============================================================================
import { query, one } from '../../db';
import type { Fetch } from './sources/types';

export interface ProviderAccount {
  id: string; account_id: string; provider: string; label: string;
  access_token: string | null; refresh_token: string | null; expires_at: string | null;
  config: Record<string, any>; enabled: boolean;
}

export const OAUTH = {
  dropbox: {
    authorize: 'https://www.dropbox.com/oauth2/authorize', token: 'https://api.dropboxapi.com/oauth2/token',
    scope: 'files.metadata.read files.content.read', extra: { token_access_type: 'offline' },
    clientId: () => process.env.DROPBOX_CLIENT_ID ?? '', clientSecret: () => process.env.DROPBOX_CLIENT_SECRET ?? '',
  },
  onedrive: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access Files.Read Files.Read.All', extra: { response_mode: 'query' },
    clientId: () => process.env.MS_CLIENT_ID ?? '', clientSecret: () => process.env.MS_CLIENT_SECRET ?? '',
  },
  gdrive: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    // drive.file only: what the user picked. Search scopes are restricted; the picker is the door.
    scope: 'https://www.googleapis.com/auth/drive.file', extra: { access_type: 'offline', prompt: 'consent' },
    clientId: () => process.env.GOOGLE_CLIENT_ID ?? '', clientSecret: () => process.env.GOOGLE_CLIENT_SECRET ?? '',
  },
} as const;
export type OAuthProvider = keyof typeof OAUTH;

export function authorizeUrl(provider: OAuthProvider, redirectUri: string, state: string): string {
  const p = OAUTH[provider];
  if (!p.clientId()) throw Object.assign(new Error(`${provider} is not configured on this server (client id missing)`), { status: 501 });
  const u = new URL(p.authorize);
  u.searchParams.set('client_id', p.clientId()); u.searchParams.set('redirect_uri', redirectUri); u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', p.scope); u.searchParams.set('state', state);
  for (const [k, v] of Object.entries(p.extra)) u.searchParams.set(k, v);
  return u.toString();
}

async function tokenCall(provider: OAuthProvider, form: Record<string, string>, fetchImpl: Fetch) {
  const p = OAUTH[provider];
  const body = new URLSearchParams({ ...form, client_id: p.clientId(), client_secret: p.clientSecret() });
  const res = await fetchImpl(p.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${provider} token exchange failed: ${j.error_description ?? j.error ?? res.status}`), { status: 502 });
  return { accessToken: String(j.access_token), refreshToken: j.refresh_token ? String(j.refresh_token) : null, expiresAt: j.expires_in ? new Date(Date.now() + Number(j.expires_in) * 1000).toISOString() : null };
}

/** Exchange the code from the callback and store the linked account. */
export async function linkOAuth(accountId: string, provider: OAuthProvider, code: string, redirectUri: string, label: string, userId: string | null, fetchImpl: Fetch = fetch): Promise<ProviderAccount> {
  const t = await tokenCall(provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, fetchImpl);
  const row = await one<ProviderAccount>(
    `INSERT INTO ingest_provider_accounts (account_id, provider, label, access_token, refresh_token, expires_at, linked_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [accountId, provider, label, t.accessToken, t.refreshToken, t.expiresAt, userId]);
  return row!;
}

/** A usable access token for a linked account, refreshed when within a minute of expiry. */
export async function accessTokenFor(pa: ProviderAccount, fetchImpl: Fetch = fetch): Promise<string> {
  const soon = pa.expires_at && new Date(pa.expires_at).getTime() - Date.now() < 60_000;
  if (!soon || !pa.refresh_token || !(pa.provider in OAUTH)) return pa.access_token ?? '';
  const t = await tokenCall(pa.provider as OAuthProvider, { grant_type: 'refresh_token', refresh_token: pa.refresh_token }, fetchImpl);
  await query(`UPDATE ingest_provider_accounts SET access_token = $2, refresh_token = COALESCE($3, refresh_token), expires_at = $4, updated_at = now() WHERE id = $1`, [pa.id, t.accessToken, t.refreshToken, t.expiresAt]);
  return t.accessToken;
}

export async function providerAccounts(accountId: string, provider?: string): Promise<ProviderAccount[]> {
  return query<ProviderAccount>(`SELECT * FROM ingest_provider_accounts WHERE account_id = $1 AND enabled AND ($2::text IS NULL OR provider = $2) ORDER BY created_at`, [accountId, provider ?? null]);
}
