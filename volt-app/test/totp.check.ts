/** TOTP (RFC 6238) correctness — official test vectors + round-trip. */
import { totpAt, verifyTotp, base32Encode, base32Decode, newSecret } from '../src/services/totp';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log('PASS ' + m)) : (fail++, console.log('FAIL ' + m)));

// RFC 6238 SHA1 seed = ASCII "12345678901234567890" → base32
const SEED = base32Encode(Buffer.from('12345678901234567890'));
// vectors: (unix time, 8-digit code)
ok(totpAt(SEED, 59, 30, 8) === '94287082', 'RFC6238 T=59 → 94287082');
ok(totpAt(SEED, 1111111109, 30, 8) === '07081804', 'RFC6238 T=1111111109 → 07081804');
ok(totpAt(SEED, 1234567890, 30, 8) === '89005924', 'RFC6238 T=1234567890 → 89005924');

// base32 round-trip
const r = Buffer.from('volt-mfa-secret!!');
ok(base32Decode(base32Encode(r)).equals(r), 'base32 encode/decode round-trips');

// verify window: a code valid at nowSec passes; a stale one fails
const s = newSecret('a@b').secret;
const now = 1700000000;
const code = totpAt(s, now);
ok(verifyTotp(s, code, { nowSec: now }), 'current code verifies');
ok(verifyTotp(s, totpAt(s, now - 30), { nowSec: now, window: 1 }), 'previous step verifies within window');
ok(!verifyTotp(s, totpAt(s, now - 300), { nowSec: now, window: 1 }), 'far-off code rejected');
ok(!verifyTotp(s, '000000', { nowSec: now }), 'wrong code rejected');
ok(newSecret('x@y').otpauthUri.startsWith('otpauth://totp/'), 'otpauth enrolment URI generated');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
