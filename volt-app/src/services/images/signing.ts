// ============================================================================
//  IMAGE URL SIGNING (server side).
//
//  Every render URL carries a signature. Without one, anyone could ask for
//  unlimited size and filter combinations, and each unique URL is a render:
//  a cost and denial-of-service lever. There is no `unsafe` bypass, in any
//  environment.
//
//  KEYS ARE PER ACCOUNT. The account key is HMAC(master, "volt-img:v1:{acct}").
//  The account id comes from the image path itself (library/{acct}/...), so a
//  key handed to account A (its console, its SDK) can sign only A's images.
//  The master secret (IMAGE_SIGNING_SECRET) never leaves the server.
//
//  ROTATION. Set IMAGE_SIGNING_SECRET to the new value and
//  IMAGE_SIGNING_SECRET_PREVIOUS to the old one. Both verify; new URLs are
//  signed with the new one. Remove the previous value once cached pages and
//  embeds have refreshed (they will re-render once, under the new URLs).
//
//  The signing maths is the SDK's (sdk.ts); this file uses Node's crypto for
//  speed and a constant-time compare. The images check proves the two agree.
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';
import { IMAGE_SIG_LENGTH } from './sdk';

const KEY_LABEL = 'volt-img:v1:';

/** The account's signing key (base64url). Safe to give to that account. */
export function accountSigningKey(masterSecret: string, accountId: string): string {
  return createHmac('sha256', masterSecret).update(KEY_LABEL + accountId).digest('base64url');
}

/** Signature over the decoded text after the signature segment. */
export function signWithAccountKey(accountKey: string, text: string): string {
  return createHmac('sha256', Buffer.from(accountKey, 'base64url')).update(text, 'utf8').digest().subarray(0, 16).toString('base64url');
}

export const SIG_RX = new RegExp(`^[A-Za-z0-9_-]{${IMAGE_SIG_LENGTH}}$`);

/** Constant-time check of `sig` against every accepted master secret. */
export function verifyImageSignature(
  sig: string, text: string, accountId: string, secrets: string[],
): boolean {
  if (!SIG_RX.test(sig)) return false;
  const given = Buffer.from(sig, 'base64url');
  let ok = false;
  for (const s of secrets) {
    if (!s) continue;
    const want = Buffer.from(signWithAccountKey(accountSigningKey(s, accountId), text), 'base64url');
    if (want.length === given.length && timingSafeEqual(want, given)) ok = true;
  }
  return ok;
}

/** Throws at boot when production would run with no, or a development, secret. */
export function assertSigningConfigured(secret: string, production: boolean): void {
  if (!production) return;
  if (!secret || secret.length < 32 || /^dev[-_]/i.test(secret)) {
    throw new Error('IMAGE_SIGNING_SECRET must be set to a random value of 32+ characters in production');
  }
}
