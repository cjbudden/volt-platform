/**
 * ONBOARDING MAIL CHECK (no database): the welcome and reset emails, and the
 * multipart/alternative message the SMTP client now builds for them.
 *
 *   npx tsx test/onboarding-mail.check.ts
 */
import { buildMessage } from '../src/services/mail/smtp';
import { welcomeEmail, resetEmail, alreadyRegisteredEmail, waitlistEmail } from '../src/services/mail/templates';
import { passwordProblem } from '../src/services/onboarding';

let passes = 0, failures = 0;
function ok(c: boolean, what: string, d = '') { console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${d ? `  (${d})` : ''}`); if (c) passes++; else failures++; }

const link = 'https://console.volt.test/welcome#t=abc_DEF-123';
const exp = new Date(Date.now() + 7 * 86400_000);
const w = welcomeEmail({ accountName: 'News <Desk> & Co', inviter: 'Ada "A" Admin', name: 'Nina New', link, expiresAt: exp });
ok(w.subject.includes('News <Desk> & Co'), 'subject names the account');
ok(w.text.includes(link) && w.html.includes(link), 'both parts carry the link');
ok(w.html.includes('News &lt;Desk&gt; &amp; Co') && !w.html.includes('<Desk>'), 'account name is escaped in HTML');
ok(w.html.includes('Ada &quot;A&quot; Admin'), 'inviter name is escaped in HTML');
ok(/expires in 7 days/.test(w.text), 'expiry in words', /expires in [^.]+/.exec(w.text)?.[0]);
ok(w.text.startsWith('Hi Nina,'), 'greets by first name');
ok(!/border-left|border-right/.test(w.html), 'no coloured edge bars');
const self = welcomeEmail({ accountName: 'Trial Co', inviter: null, name: null, link, expiresAt: exp, selfService: true });
ok(self.subject.startsWith('Welcome to Volt Streaming') && self.text.startsWith('Hello,'), 'self-service welcome wording');
const r = resetEmail({ name: null, link: 'https://c/reset-password#t=x', expiresAt: new Date(Date.now() + 3600_000) });
ok(/expires in 1 hour/.test(r.text) && r.text.includes('keeps working'), 'reset: expiry and reassurance');
ok(alreadyRegisteredEmail({ signInUrl: 'https://c/', resetUrl: 'https://c/forgot-password' }).text.includes('https://c/forgot-password'), 'already-registered email points to reset');
ok(waitlistEmail({ name: 'Lee' }).text.startsWith('Hi Lee,'), 'waitlist email');

const plain = buildMessage({ from: 'Volt <no-reply@volt.test>', to: 'a@b.test', subject: 'Plain', text: 'hello' });
ok(/Content-Type: text\/plain; charset=utf-8/.test(plain) && !/multipart/.test(plain), 'text-only messages are unchanged');
const multi = buildMessage({ from: 'Volt <no-reply@volt.test>', to: 'a@b.test', subject: w.subject, text: w.text, html: w.html });
const boundary = /boundary="([^"]+)"/.exec(multi)?.[1];
ok(!!boundary && /Content-Type: multipart\/alternative/.test(multi), 'HTML mail is multipart/alternative', boundary);
const parts = multi.split(`--${boundary}`).slice(1, -1);
ok(parts.length === 2 && /text\/plain/.test(parts[0]) && /text\/html/.test(parts[1]), 'text part first, HTML second');
const decode = (p: string) => Buffer.from(p.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
ok(decode(parts[0]).includes(link) && decode(parts[1]).includes('<!doctype html>'), 'both parts decode');
ok(multi.trimEnd().endsWith(`--${boundary}--`), 'closing boundary present');
ok(multi.split('\r\n').every((l) => l.length <= 998), 'no line longer than SMTP allows');

ok(passwordProblem('short') !== null, 'password: too short');
ok(passwordProblem('aaaaaaaaaaaa') !== null, 'password: one repeated character');
ok(passwordProblem('password123') !== null, 'password: common');
ok(passwordProblem('nina.new-2026x', 'nina.new@x.test') !== null, 'password: contains the email name');
ok(passwordProblem('Signal-Path-Ready-77', 'nina@x.test') === null, 'password: a good one passes');

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
