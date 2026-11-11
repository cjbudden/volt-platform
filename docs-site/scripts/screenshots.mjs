// Retake the guides' screenshots from the running app (build queue 1.14-G0).
//
// What to capture is in ../screenshots.json; this signs in once, visits each
// path, waits for the page to settle, and saves static/img/screens/<name>.png.
// Rerun it whenever the UI changes and commit the pictures that changed.
//
// Before saving, the page's visible text, input values and placeholders are
// checked against scrub.json's banned terms. A picture is the one place the
// docs build cannot read, so a seed or page that shows an internal or
// customer name fails here instead of being published.
//
// Needs the API on a fresh docs seed and the console served by vite:
//   (volt-app)  DATABASE_URL=... npx tsx scripts/seed-docs.ts
//   (volt-app)  PORT=8080 npx tsx src/index.ts
//   (volt-web)  npx vite --port 5173
//   (docs-site) node scripts/screenshots.mjs [name ...]
// A shot may also press `keys` after its clicks and wait for `waitAfter`.
// A `click` entry may be `{ "fill": <selector>, "value": <text> }` to type into a
// field between clicks (a link pasted into Find details, build queue F2).
// `fresh: true` visits / first, so a shot on the same path as the one before
// starts from a newly drawn page rather than what that shot left open.
// A shot may also `hide` elements (kept in place, left blank) or `remove` them
// (taken out of the layout).
//
// `customerView: true` marks a page that words itself differently for whoever
// runs the Volt deployment (the server's setting and machine names, build
// queue 1.14-G4a). The docs login is the account owner, and on a single-client
// deployment (the default) the owner runs the server, so those shots need the
// API started with VOLT_DEPLOYMENT=saas, where the owner is a customer. The
// script reads `seesServerSetup` from /api/auth/me at sign-in and skips such a
// shot, saying so, rather than save a picture of the operator's view. Run the
// rest as usual, then the skipped ones with the API in saas mode:
//   (volt-app)  VOLT_DEPLOYMENT=saas PORT=8080 npx tsx src/index.ts
//   (docs-site) node scripts/screenshots.mjs social-accounts notifications fleet-and-usage
// `billingOn: true` marks a page that shows a bill only when the API bills
// (build queue B1-3): start the API with VOLT_BILLING=contract for those shots.
// The script reads `mode` from /api/billing as the page loads and skips the
// shot, saying so, when billing is off.
// Env: BASE (default http://127.0.0.1:5173), EMAIL, PASSWORD (the docs seed's
// login by default), PLAYWRIGHT (path to playwright's index.mjs if it is not
// installed here), CHROMIUM (a browser binary), OUT (default static/img/screens),
// MANIFEST (another shot list, for trying a shot out).
import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..');
const manifest = JSON.parse(readFileSync(process.env.MANIFEST || join(site, 'screenshots.json'), 'utf8'));
const scrub = JSON.parse(readFileSync(join(site, 'scrub.json'), 'utf8'));
const banned = scrub.banned.map((b) => ({ re: new RegExp(b.pattern, 'i'), why: b.why, pattern: b.pattern }));

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const EMAIL = process.env.EMAIL || 'admin@example.com';
const PASSWORD = process.env.PASSWORD || 'volt1234';
const OUT = process.env.OUT || join(site, 'static/img/screens');
const only = process.argv.slice(2);
const shots = manifest.shots.filter((s) => !only.length || only.includes(s.name));
if (!shots.length) { console.error(`no shots match ${only.join(', ')}`); process.exit(1); }

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
// A fixed time zone, so forms that default to the browser's zone (FAST) show
// the same believable zone on every machine instead of the first in the list.
const ctx = await browser.newContext({ viewport: manifest.viewport, deviceScaleFactor: 1, colorScheme: 'dark', timezoneId: manifest.timezoneId || 'Australia/Sydney' });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e.message || e)));

await page.goto(BASE + '/');
await page.fill('#signin-email', EMAIL);
await page.fill('#signin-pw', PASSWORD);
const meResponse = page.waitForResponse((r) => r.url().includes('/api/auth/me') && r.request().method() === 'GET', { timeout: 20000 });
await page.click('button:has-text("Sign in")');
await page.waitForSelector('.topbar', { timeout: 20000 });
const me = await meResponse.then((r) => r.json()).catch(() => null);
const seesServerSetup = !!me?.seesServerSetup;

let failed = 0;
const skipped = [];
for (const s of shots) {
  if (s.customerView && seesServerSetup) {
    skipped.push(s.name);
    console.log(`SKIP  ${s.name.padEnd(22)} needs the customer's view; this login sees the server's setup (start the API with VOLT_DEPLOYMENT=saas)`);
    continue;
  }
  // Styles a shot injects (hide, remove) are taken out again after it: the
  // page is never reloaded, so they used to carry into every later shot.
  const injected = [];
  // The session lives in memory, so move inside the app instead of reloading.
  if (s.fresh) { await page.evaluate(() => { history.pushState(null, '', '/'); dispatchEvent(new PopStateEvent('popstate')); }); await page.waitForTimeout(400); }
  const billingAnswer = s.billingOn ? page.waitForResponse((r) => /\/api\/billing$/.test(new URL(r.url()).pathname), { timeout: 15000 }).then((r) => r.json()).catch(() => null) : null;
  await page.evaluate((u) => { history.pushState(null, '', u); dispatchEvent(new PopStateEvent('popstate')); }, s.path);
  if (billingAnswer && (await billingAnswer)?.mode !== 'contract' && (await billingAnswer)?.mode !== 'automated') {
    skipped.push(s.name);
    console.log(`SKIP  ${s.name.padEnd(22)} billing is off on this API (start it with VOLT_BILLING=contract)`);
    continue;
  }
  try {
    if (s.waitFor) await page.waitForSelector(s.waitFor, { timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(s.settleMs ?? 1200);
    for (const c of s.click || []) {
      if (c && typeof c === 'object') await page.fill(c.fill, c.value);
      else await page.click(c);
      await page.waitForTimeout(600);
    }
    // `keys` are pressed after the clicks (frame stepping, build queue 3.2-3),
    // then `waitAfter` is waited for: a key's result can arrive from the server.
    for (const k of s.keys || []) { await page.keyboard.press(k); await page.waitForTimeout(250); }
    if (s.waitAfter) { await page.waitForSelector(s.waitAfter, { timeout: 15000 }); await page.waitForTimeout(800); }
    if (s.hide?.length) {
      injected.push(await page.addStyleTag({ content: s.hide.map((h) => `${h}{visibility:hidden!important}`).join('\n') }));
    }
    // `remove` takes the element out of the layout as well, for a note that
    // would otherwise leave a blank band across the top of the picture.
    if (s.remove?.length) {
      injected.push(await page.addStyleTag({ content: s.remove.map((h) => `${h}{display:none!important}`).join('\n') }));
    }
    const text = await page.evaluate(() => {
      const bits = [document.body.innerText];
      for (const el of document.querySelectorAll('input, textarea')) bits.push(el.value || '', el.placeholder || '');
      document.querySelectorAll('[title],[aria-label],[data-tip]').forEach((el) => bits.push(el.getAttribute('title') || '', el.getAttribute('aria-label') || '', el.getAttribute('data-tip') || ''));
      return bits.join('\n');
    });
    const hits = banned.filter((b) => b.re.test(text)).map((b) => `${b.why} (${text.match(b.re)[0]})`);
    if (hits.length) {
      failed++;
      console.log(`FAIL  ${s.name.padEnd(22)} page shows banned terms: ${hits.join('; ')}`);
      continue;
    }
    const file = join(OUT, `${s.name}.png`);
    const target = s.clip ? page.locator(s.clip).first() : page;
    await target.screenshot({ path: file, animations: 'disabled' });
    console.log(`ok    ${s.name.padEnd(22)} ${s.path.padEnd(22)} ${Math.round(statSync(file).size / 1024)} KB`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${s.name.padEnd(22)} ${String(e.message || e).split('\n')[0]}`);
  } finally {
    for (const h of injected) await h.evaluate((el) => el.remove()).catch(() => {});
  }
}
await browser.close();
if (consoleErrors.length) console.log(`page errors seen:\n  ${consoleErrors.slice(0, 10).join('\n  ')}`);
console.log(`\n${shots.length - failed - skipped.length} passed, ${failed} failed${skipped.length ? `, ${skipped.length} skipped (${skipped.join(' ')})` : ''}`);
process.exit(failed ? 1 : 0);
