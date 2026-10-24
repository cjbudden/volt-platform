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
const ctx = await browser.newContext({ viewport: manifest.viewport, deviceScaleFactor: 1, colorScheme: 'dark' });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e.message || e)));

await page.goto(BASE + '/');
await page.fill('#signin-email', EMAIL);
await page.fill('#signin-pw', PASSWORD);
await page.click('button:has-text("Sign in")');
await page.waitForSelector('.topbar', { timeout: 20000 });

let failed = 0;
for (const s of shots) {
  // The session lives in memory, so move inside the app instead of reloading.
  await page.evaluate((u) => { history.pushState(null, '', u); dispatchEvent(new PopStateEvent('popstate')); }, s.path);
  try {
    if (s.waitFor) await page.waitForSelector(s.waitFor, { timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(s.settleMs ?? 1200);
    for (const c of s.click || []) { await page.click(c); await page.waitForTimeout(600); }
    if (s.hide?.length) {
      await page.addStyleTag({ content: s.hide.map((h) => `${h}{visibility:hidden!important}`).join('\n') });
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
  }
}
await browser.close();
if (consoleErrors.length) console.log(`page errors seen:\n  ${consoleErrors.slice(0, 10).join('\n  ')}`);
console.log(`\n${shots.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
