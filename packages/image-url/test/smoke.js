// Smoke test of the BUILT package: a known vector, so a consumer's copy can be
// checked against the server without a running service.
const assert = require('node:assert');
const { createHmac } = require('node:crypto');
const sdk = require('../dist');
const accountKey = createHmac('sha256', 'master').update('volt-img:v1:acct-1').digest('base64url');
const spec = sdk.imageSpec({ width: 640, height: 360, fit: 'cover', focus: { x: 30, y: 20 }, format: 'jpeg', quality: 70 });
assert.strictEqual(spec, '640x360,cover,focus=30-20,q=70,fmt=jpeg');
const key = 'library/acct-1/slates/a.png';
const want = createHmac('sha256', Buffer.from(accountKey, 'base64url')).update(`${spec}/${key}`).digest().subarray(0, 16).toString('base64url');
assert.strictEqual(sdk.signImagePath(accountKey, `${spec}/${key}`), want);
assert.strictEqual(sdk.imageUrl({ baseUrl: 'https://img.example.com', key, accountKey, width: 640, height: 360, focus: { x: 30, y: 20 }, format: 'jpeg', quality: 70 }),
  `https://img.example.com/img/${want}/${spec}/${key}`);
console.log('@volt/image-url smoke: ok');
