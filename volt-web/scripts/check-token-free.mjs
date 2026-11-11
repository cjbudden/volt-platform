// Browser check for token-free playback in the rule editor (build queue P2-2c),
// against the docs seed. Needs the API on a fresh docs seed and the console
// served by vite, as for the guides' screenshots (docs-site/scripts/screenshots.mjs):
//   (volt-app)  DATABASE_URL=... npx tsx scripts/seed-docs.ts && PORT=8080 npx tsx src/index.ts
//   (volt-web)  npx vite --port 5173
//   (volt-web)  node scripts/check-token-free.mjs
// Env: BASE (default http://127.0.0.1:5173), PLAYWRIGHT (path to playwright's
// index.mjs if it is not installed here), CHROMIUM, OUT (where the screenshots go).
// Nothing is saved: the checks read Before you save, the dry run.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const OUT = process.env.OUT || join(tmpdir(), 'volt-token-free');
mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('ok  ', m); } else { fail++; console.log('FAIL', m); } };
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
async function run(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message)));
  await page.goto(BASE + '/');
  await page.fill('#signin-email', 'admin@example.com'); await page.fill('#signin-pw', 'volt1234');
  await page.click('button:has-text("Sign in")'); await page.waitForSelector('.topbar', { timeout: 20000 });
  await page.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')); }, '/publishing');
  const ed = '[data-rule-editor=account]';
  const field = `${ed} [data-policy-field="protection.tokenFree"]`;
  await page.waitForSelector(field, { timeout: 20000 });
  const row = await page.locator(field).innerText();
  ok(/Token-free playback/.test(row) && /Play by plain address/.test(row), `${width}: Protection has Token-free playback with its control`);
  ok(/not with geo, rights, DRM, a paywall, sign-in/.test(row), `${width}: the row says where it cannot be used`);
  ok(await page.locator(`${field} button`).count() >= 1, `${width}: it has a padlock like the other fields`);
  await page.waitForSelector(`${ed} [data-policy-check] [data-impact]`, { timeout: 20000 });
  // The docs seed's titles have rights profiles that limit territories or
  // apps (Example Films, the Sports League, the News archive): ticking it on
  // the account default is refused for those titles, by name.
  await page.click(`${field} input[type=checkbox]`);
  await page.waitForSelector(`${ed} [data-policy-conflict=block]:has-text("Token-free playback is on")`, { timeout: 10000 });
  const blocks1 = await page.locator(`${ed} [data-policy-conflict=block]`).allInnerTexts();
  ok(blocks1.some((t) => /titles?: Token-free playback is on, but .*: a plain address would let anyone play it/.test(t)), `${width}: ticked on the account default: blocked for the seed's titles whose rights limit territories or apps, with their names`);
  await page.click(`${ed} [data-policy-field="protection.drm"] input[type=checkbox]`);
  await page.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((e) => /Token-free playback is on, but DRM is on/.test(e.textContent || '')), `${ed} [data-policy-conflict=block]`, { timeout: 10000 }).catch(() => {});
  const blocks2 = await page.locator(`${ed} [data-policy-conflict=block]`).allInnerTexts();
  ok(blocks2.some((t) => /^\s*Token-free playback is on, but DRM is on/.test(t) || /\bToken-free playback is on, but DRM is on/.test(t)), `${width}: with DRM ticked too, the policy itself is blocked and says why`);
  const save = page.locator(`${ed} button:has-text("Save")`).first();
  ok(await save.isDisabled().catch(() => false), `${width}: Save is off while it is blocked`);
  await page.locator(`${ed} [data-policy-check]`).screenshot({ path: join(OUT, `token-free-check-${width}.png`) });
  await page.locator(`${ed} [data-policy-section=protection]`).screenshot({ path: join(OUT, `token-free-protection-${width}.png`) });
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok(!sideways, `${width}: no sideways scroll`);
  ok(errs.length === 0, `${width}: no page errors${errs.length ? ': ' + errs.join(' | ') : ''}`);
  await ctx.close();
}
await run(1440, 900);
await run(390, 844);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
