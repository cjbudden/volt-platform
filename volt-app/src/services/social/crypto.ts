// ============================================================================
//  TOKEN ENCRYPTION for linked social accounts. AES-256-GCM, a random IV per
//  value, the auth tag stored with it: "v1.<iv>.<tag>.<ciphertext>" in base64url.
//
//  The key is SOCIAL_TOKEN_KEY (32 bytes, base64 or hex). Without it the key is
//  derived from JWT_ACCESS_SECRET with HKDF, which works but ties the tokens to
//  that secret: rotating it would orphan every linked account. Set
//  SOCIAL_TOKEN_KEY in production; the platform page says when it is missing.
// ============================================================================
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';

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
