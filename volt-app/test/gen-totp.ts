import { totpAt } from '../src/services/totp';
// print the current TOTP code for a base32 secret (test helper)
console.log(totpAt(process.argv[2], Math.floor(Date.now() / 1000)));
