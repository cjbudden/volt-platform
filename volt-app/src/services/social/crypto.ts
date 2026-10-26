// ============================================================================
//  TOKEN ENCRYPTION for linked social accounts. AES-256-GCM, a random IV per
//  value, the auth tag stored with it: "v1.<iv>.<tag>.<ciphertext>" in base64url.
//
//  The key is SOCIAL_TOKEN_KEY (32 bytes, base64 or hex). Without it the key is
//  derived from JWT_ACCESS_SECRET with HKDF, which works but ties the tokens to
//  that secret: rotating it would orphan every linked account. Set
//  SOCIAL_TOKEN_KEY in production; the platform page says when it is missing.
// ============================================================================
import { createCipheriv, createDecipheriv, createHmac, randomBytes, hkdfSync, timingSafeEqual } from 'node:crypto';

let cached: { src: string; key: Buffer } | null = null;

export function tokenKeyConfigured(): boolean { return !!process.env.SOCIAL_TOKEN_KEY; }

function key(): Buffer {
  const raw = process.env.SOCIAL_TOKEN_KEY ?? '';
  const src = raw || `jwt:${process.env.JWT_ACCESS_SECRET ?? ''}`;
  if (cached?.src === src) return cached.key;
  let k: Buffer;
  if (raw) {
    k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (k.length !== 32) throw new Error('SOCIAL_TOKEN_KEY must be 32 bytes (64 hex characters or base64)');
  } else {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) throw new Error('Set SOCIAL_TOKEN_KEY to store social account tokens');
    k = Buffer.from(hkdfSync('sha256', secret, 'volt-social-tokens', 'aes-256-gcm', 32));
  }
  cached = { src, key: k };
  return k;
}

export function seal(plain: string | null | undefined): string | null {
  if (plain == null || plain === '') return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function open(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const [v, iv, tag, body] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || body == null) throw new Error('unreadable sealed token');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
}

// MEDIA ADDRESSES (build queue 1.14j). Threads fetches a post's video itself,
// so the publish job hands it a link that works for a few hours and for that
// one publication only. The signing key is derived from the token key, under
// its own label, so a media link can never be turned into a token.
function mediaKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', key(), 'volt-social-media', 'url-signing', 32));
}
export function signMedia(msg: string): string {
  return createHmac('sha256', mediaKey()).update(msg).digest('base64url');
}
export function mediaSignatureOk(msg: string, sig: string): boolean {
  const want = Buffer.from(signMedia(msg));
  const got = Buffer.from(String(sig));
  return got.length === want.length && timingSafeEqual(got, want);
}
