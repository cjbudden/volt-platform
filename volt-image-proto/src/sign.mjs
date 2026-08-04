// HMAC URL signing (Thumbor-style security key) so callers can't request arbitrary
// resize combinations (a DoS/cost vector). The signature covers the canonical path
// (everything after the signature segment). In dev, an "unsafe" prefix is allowed.
import { createHmac } from 'node:crypto';

export function sign(canonical, secret) {
  return createHmac('sha256', secret).update(canonical).digest('base64url');
}
export function verify(sig, canonical, secret, { allowUnsafe = false } = {}) {
  if (allowUnsafe && sig === 'unsafe') return true;
  if (!sig) return false;
  return sig === sign(canonical, secret);
}
