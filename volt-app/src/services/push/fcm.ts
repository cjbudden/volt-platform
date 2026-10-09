// ============================================================================
//  DEVICE PUSH through Firebase Cloud Messaging (HTTP v1).
//
//  One provider covers both platforms the management app ships on: FCM
//  delivers to Android directly and to iOS through APNs, once the Firebase
//  project has the APNs key uploaded. The recipient of a push delivery is the
//  device's FCM registration token.
//
//  Configure with FCM_SERVICE_ACCOUNT: the service account JSON from the
//  Firebase console (the JSON itself, or a path to the file). The access token
//  is minted from it with a signed JWT (RS256, jsonwebtoken, already a
//  dependency) and cached until shortly before it expires.
//
//  FCM_BASE_URL and FCM_TOKEN_URL exist only so the test suite can point this
//  at a local fake; production leaves them unset.
// ============================================================================
import { readFileSync, existsSync } from 'node:fs';
import jwt from 'jsonwebtoken';

export class PushError extends Error {
  permanent: boolean;
  constructor(message: string, permanent: boolean) { super(message); this.permanent = permanent; }
}

interface ServiceAccount { project_id: string; client_email: string; private_key: string; token_uri?: string }

let cachedSa: { raw: string; sa: ServiceAccount } | null = null;
export function serviceAccount(): ServiceAccount | null {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  if (cachedSa?.raw === raw) return cachedSa.sa;
  const text = raw.trim().startsWith('{') ? raw : (existsSync(raw) ? readFileSync(raw, 'utf8') : '');
  if (!text) return null;
  const sa = JSON.parse(text) as ServiceAccount;
  if (!sa.project_id || !sa.client_email || !sa.private_key) return null;
  cachedSa = { raw, sa };
  return sa;
}

let token: { value: string; until: number; for: string } | null = null;

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (token && token.for === sa.client_email && token.until > Date.now() + 60_000) return token.value;
  const tokenUrl = process.env.FCM_TOKEN_URL || sa.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUrl, iat: now, exp: now + 3600 },
    sa.private_key, { algorithm: 'RS256' });
  const r = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new PushError(`FCM sign-in failed: ${r.status} ${j.error_description ?? j.error ?? ''}`.trim(), r.status === 400 || r.status === 401);
  token = { value: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000, for: sa.client_email };
  return token.value;
}

/** Send one notification to one device token. Throws PushError. */
export async function sendPush(deviceToken: string, title: string, body: string, data: Record<string, string> = {}): Promise<{ name: string }> {
  const sa = serviceAccount();
  if (!sa) throw new PushError('Push is not configured (set FCM_SERVICE_ACCOUNT).', true);
  const at = await accessToken(sa);
  const base = (process.env.FCM_BASE_URL || 'https://fcm.googleapis.com').replace(/\/$/, '');
  const r = await fetch(`${base}/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { token: deviceToken, notification: { title, body: body.slice(0, 1000) }, data } }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (r.ok) return { name: String(j.name ?? '') };
  const status = String(j.error?.status ?? '');
  // UNREGISTERED / INVALID_ARGUMENT: the token is dead or wrong, retrying cannot help.
  const permanent = r.status === 404 || status === 'UNREGISTERED' || status === 'INVALID_ARGUMENT' || r.status === 403;
  if (r.status === 401) token = null;
  throw new PushError(`FCM refused: ${r.status} ${status} ${j.error?.message ?? ''}`.trim().slice(0, 300), permanent);
}
