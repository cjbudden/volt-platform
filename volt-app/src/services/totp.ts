/**
 * TOTP (RFC 6238) for SaaS-admin two-step login. No external dependency — HMAC-
 * SHA1 over the time counter, base32 secret (authenticator-app compatible).
 * The secret itself lives in Secrets Manager in production (mfa_secret_ref);
 * here we generate/verify it. Verified against the RFC 6238 test vectors.
 */
import { createHmac, randomBytes } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/g, '').toUpperCase().replace(/\s/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP code for a counter. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(buf).digest();
  const offset = h[h.length - 1] & 0xf;
  const bin = ((h[offset] & 0x7f) << 24) | ((h[offset + 1] & 0xff) << 16) | ((h[offset + 2] & 0xff) << 8) | (h[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

/** TOTP code at a unix time (seconds). */
export function totpAt(secretBase32: string, timeSec: number, step = 30, digits = 6): string {
  return hotp(base32Decode(secretBase32), Math.floor(timeSec / step), digits);
}

/** Verify a code within ±window steps of nowSec. */
export function verifyTotp(secretBase32: string, code: string, opts: { nowSec: number; step?: number; digits?: number; window?: number }): boolean {
  const { nowSec, step = 30, digits = 6, window = 1 } = opts;
  const secret = base32Decode(secretBase32);
  const c = Math.floor(nowSec / step);
  for (let w = -window; w <= window; w++) {
    if (hotp(secret, c + w, digits) === code) return true;
  }
  return false;
}

/** New random base32 secret + an otpauth:// URI for authenticator enrolment. */
export function newSecret(label: string, issuer = 'Volt Streaming'): { secret: string; otpauthUri: string } {
  const secret = base32Encode(randomBytes(20));
  const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return { secret, otpauthUri: uri };
}
