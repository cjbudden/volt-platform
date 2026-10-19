/**
 * SEALED SECRETS for values the API must read back (authenticator-app seeds).
 * AES-256-GCM with a key from MFA_ENCRYPTION_KEY (32 bytes, base64 or hex), or
 * derived from JWT_ACCESS_SECRET with HKDF when that is unset (dev, staging).
 *
 * Format: enc:v1:<iv b64>:<tag b64>:<ciphertext b64>. A value without the
 * prefix is returned as is, so seeds stored before this file (platform staff,
 * demo data) keep working and are re-sealed the next time they are set.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config';

let cached: Buffer | null = null;
function key(): Buffer {
  if (cached) return cached;
  const raw = process.env.MFA_ENCRYPTION_KEY;
  if (raw) {
    const b = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (b.length !== 32) throw new Error('MFA_ENCRYPTION_KEY must be 32 bytes (base64 or hex)');
    cached = b;
  } else {
    cached = Buffer.from(hkdfSync('sha256', config.jwt.accessSecret, 'volt', 'mfa-secret-box-v1', 32));
  }
  return cached;
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function open(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith('enc:v1:')) return stored;
  const [, , iv, tag, ct] = stored.split(':');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
