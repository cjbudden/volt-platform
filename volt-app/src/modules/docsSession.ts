/**
 * DOCS ACCESS: hand a signed-in user a short-lived pass to the customer docs.
 *
 * The docs are a separate static site (private S3 + CloudFront, its own deploy;
 * see deploy/terraform-docs and docs-site/MAINTAINING.md). CloudFront refuses
 * every request without a valid signed cookie. This is the ONLY thing the
 * control plane does for the docs: when a signed-in admin user opens Docs, sign
 * a CloudFront custom policy for the whole docs site and set it as three cookies
 * on the shared parent domain (app.volt.example and docs.volt.example share
 * .volt.example). Docs traffic itself never reaches the control plane.
 *
 * GET /api/docs/session -> { url, signed, expiresAt }
 *
 * Not configured (DOCS_URL unset): 404 docs_not_configured.
 * DOCS_URL set but no signing key: { signed: false } and no cookies. That is
 * the local setup, where the docs dev server is open on localhost.
 *
 * Account secret keys are refused: documentation access is for people.
 */
import { Router } from 'express';
import { createSign } from 'node:crypto';
import { requireAuth } from '../auth/middleware';
import { asyncHandler } from '../util/http';

const DOCS_URL = (process.env.DOCS_URL ?? '').replace(/\/+$/, '');
const KEY_PAIR_ID = process.env.DOCS_CF_KEY_PAIR_ID ?? '';
// PEM; from Secrets Manager in AWS. Literal "\n" sequences are accepted for .env files.
const PRIVATE_KEY = (process.env.DOCS_CF_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
const COOKIE_DOMAIN = process.env.DOCS_COOKIE_DOMAIN ?? '';
const TTL_SECONDS = Number(process.env.DOCS_SESSION_TTL ?? 12 * 3600);

/** CloudFront's URL-safe base64: + -> -, = -> _, / -> ~ */
const cfB64 = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');

export function signDocsCookies(resource: string, expiresAtSec: number, privateKey: string, keyPairId: string) {
  const policy = JSON.stringify({ Statement: [{ Resource: resource, Condition: { DateLessThan: { 'AWS:EpochTime': expiresAtSec } } }] });
  const signer = createSign('RSA-SHA1');
  signer.update(policy);
  return {
    'CloudFront-Policy': cfB64(Buffer.from(policy)),
    'CloudFront-Signature': cfB64(signer.sign(privateKey)),
    'CloudFront-Key-Pair-Id': keyPairId,
  };
}

export const docsSessionRouter = Router();
docsSessionRouter.use(requireAuth);

docsSessionRouter.get('/session', asyncHandler(async (req, res) => {
  if (!DOCS_URL) { res.status(404).json({ error: 'docs_not_configured', message: 'Documentation is not set up on this Volt server.' }); return; }
  if (String(req.auth?.sub ?? '').startsWith('apikey:')) {
    res.status(403).json({ error: 'docs_needs_a_person', message: 'Open the docs from a signed-in user session, not with an account secret key.' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  if (!PRIVATE_KEY || !KEY_PAIR_ID) { res.json({ url: DOCS_URL, signed: false, expiresAt: null }); return; }

  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const cookies = signDocsCookies(`${DOCS_URL}/*`, expiresAt, PRIVATE_KEY, KEY_PAIR_ID);
  for (const [name, value] of Object.entries(cookies)) {
    res.cookie(name, value, {
      domain: COOKIE_DOMAIN || undefined,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: TTL_SECONDS * 1000,
      encode: String, // already URL-safe; express must not re-encode
    });
  }
  res.json({ url: DOCS_URL, signed: true, expiresAt: new Date(expiresAt * 1000).toISOString() });
}));
