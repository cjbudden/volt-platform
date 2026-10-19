/**
 * Docs access (src/modules/docsSession.ts): a signed-in user gets three
 * CloudFront signed cookies for the docs site, on the shared parent domain,
 * signed with the docs key. Needs DATABASE_URL (migrated + seed-access seeded).
 *   DATABASE_URL=... npx tsx test/docs-session.check.ts
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
process.env.DOCS_URL = 'https://docs.volt.example';
process.env.DOCS_CF_KEY_PAIR_ID = 'KTESTKEY123';
process.env.DOCS_CF_PRIVATE_KEY = privateKey.replace(/\n/g, '\\n'); // as an .env file would carry it
process.env.DOCS_COOKIE_DOMAIN = '.volt.example';
process.env.DOCS_SESSION_TTL = '3600';
(async () => {
  const { createServer } = await import('../src/server');
  const app: any = createServer();
  const srv = app.listen(0); const port = (srv.address() as any).port;
  const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.DOCS_TEST_EMAIL ?? 'admin@volt.test', password: process.env.DOCS_TEST_PASSWORD ?? 'VoltTest!2026' }) });
  const lj: any = await login.json();
  const tok = lj.access;
  console.log(`login ${login.status} ${tok ? 'session issued' : JSON.stringify(lj).slice(0, 200)}`);
  const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };

  let r = await fetch(`http://127.0.0.1:${port}/api/docs/session`);
  ok(r.status === 401, `no session -> 401 (got ${r.status})`);

  r = await fetch(`http://127.0.0.1:${port}/api/docs/session`, { headers: { authorization: `Bearer ${tok}` } });
  const body: any = await r.json();
  ok(r.status === 200 && body.signed === true && body.url === 'https://docs.volt.example', `signed-in -> 200 signed (${r.status} ${JSON.stringify(body)})`);
  const set = r.headers.getSetCookie();
  ok(set.length === 3, `three cookies (${set.length})`);
  const jar = Object.fromEntries(set.map((c) => { const [kv] = c.split(';'); const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  ok(set.every((c) => /Domain=\.volt\.example/i.test(c) && /Secure/.test(c) && /HttpOnly/.test(c) && /SameSite=Lax/i.test(c)), 'cookies: parent domain, Secure, HttpOnly, SameSite=Lax');
  ok(jar['CloudFront-Key-Pair-Id'] === 'KTESTKEY123', 'key pair id');
  const unb64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');
  const policy = unb64(jar['CloudFront-Policy']).toString();
  const p = JSON.parse(policy);
  ok(p.Statement[0].Resource === 'https://docs.volt.example/*', `policy resource ${p.Statement[0].Resource}`);
  const exp = p.Statement[0].Condition.DateLessThan['AWS:EpochTime'];
  ok(Math.abs(exp - (Date.now() / 1000 + 3600)) < 10, 'expiry = now + TTL');
  const v = createVerify('RSA-SHA1'); v.update(policy);
  ok(v.verify(publicKey, unb64(jar['CloudFront-Signature'])), 'signature verifies with the public key');
  ok(!/[+=/]/.test(jar['CloudFront-Signature'] + jar['CloudFront-Policy']), 'URL-safe encoding (no + = /)');
  srv.close(); process.exit(process.exitCode ?? 0);
})().catch((e) => { console.error(e); process.exit(1); });
