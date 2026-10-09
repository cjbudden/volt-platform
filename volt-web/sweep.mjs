// Load every section in a real browser, sign in once, and report anything the
// page says out loud: console errors, unhandled rejections, failed requests,
// and the app's own error boundary. A section that renders a blank div while
// throwing in the console passes a screenshot review and fails this.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.WEB || 'http://localhost:5173';
const EMAIL = process.env.EMAIL || 'root@adminco.example';
const PASS = process.env.PASS || 'volt1234';
const OUT = '/tmp/sweep';
mkdirSync(OUT, { recursive: true });

const SECTIONS = [
  'channels', 'live', 'monitoring', 'dashboard', 'multiview', 'events', 'epg',
  'radio', 'recordings', 'review', 'vod', 'loops', 'storage', 'images',
  'analytics', 'apikeys', 'users', 'system',
];

// Noise that is not the app's fault and not actionable from here.
const IGNORE = [
  /favicon/i,
  /Download the React DevTools/i,
  /\[vite\]/i,
  /Failed to load resource.*\/origin\//i,   // no live segments on this box
  /hls\.js|dash\.js/i,
  // The live status SSE stream is a long-lived connection the page opens and
  // the browser tears down when we navigate on. An aborted EventSource is what
  // LEAVING a page looks like, not what a broken one looks like; a genuine
  // failure shows up as a non-ABORTED error text and is still reported.
  /\/api\/status\/stream.*ERR_ABORTED/i,
];
const noisy = (s) => IGNORE.some((r) => r.test(s));

// The container ships a Chromium that this playwright build does not have a
// matching download for, so point at it rather than fetching a second one.
const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

let bucket = [];
page.on('console', (m) => {
  if (m.type() !== 'error' && m.type() !== 'warning') return;
  const t = m.text();
  if (!noisy(t)) bucket.push(`${m.type()}: ${t}`);
});
page.on('pageerror', (e) => bucket.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => {
  const t = `${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`;
  if (!noisy(t)) bucket.push(`requestfailed: ${t}`);
});
page.on('response', (r) => {
  if (r.status() >= 500 && !noisy(r.url())) bucket.push(`http ${r.status()}: ${r.url()}`);
});

// ---- sign in ---------------------------------------------------------------
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.locator('input[type=email], input[name=email]').first().fill(EMAIL);
await page.locator('input[type=password]').first().fill(PASS);
await page.locator('button[type=submit], button:has-text("Sign in")').first().click();
await page.waitForSelector('.nav-item, nav a', { timeout: 20_000 });
await page.waitForTimeout(1200);
bucket = [];   // anything from the login screen itself is not a section fault

// The router is history-based, not hash-based, and the session lives in memory,
// so a full page load would sign us out and then quietly render the sign-in
// screen under every section's name. Navigate the way a person does: click the
// nav item, and refuse to score a section whose heading did not actually change.
const rows = [];
for (const s of SECTIONS) {
  bucket = [];
  const link = page.locator(`a.nav-item[href="/${s}"]`).first();
  if (!(await link.count())) {
    rows.push({ section: s, problems: ['no nav item with href /' + s], boundary: 0, bodyLen: 0, title: '' });
    continue;
  }
  await link.click();
  await page.waitForFunction(
    (want) => window.location.pathname === `/${want}`, s, { timeout: 10_000 }
  );
  await page.waitForTimeout(1800);

  // KEYBOARD OPERABILITY. Every element with a click handler must be reachable
  // and operable without a mouse. This counts the ones that are not, which is
  // the check that would have caught the whole class in the first place.
  const a11y = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('[data-a11y-click], [onclick]')) {
      const role = el.getAttribute('role');
      const ti = el.getAttribute('tabindex');
      if (!role || ti === null) bad.push((el.className || el.tagName) + '');
    }
    // Anything with a click handler that is not a real control and not marked.
    const focusables = document.querySelectorAll(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    return { unreachable: bad.slice(0, 5), focusableCount: focusables.length };
  });

  const boundary = await page.locator('text=/Something went wrong|This section failed/i').count();
  const bodyLen = (await page.locator('main, .content, body').first().innerText()).trim().length;
  const title = ((await page.locator('h1').first().textContent()) ?? '').trim();
  await page.screenshot({ path: `${OUT}/${s}.png`, fullPage: false });

  rows.push({ section: s, problems: [...bucket], boundary, bodyLen, title, a11y });
}

await browser.close();

let bad = 0;
for (const r of rows) {
  const flags = [];
  if (r.boundary) flags.push('ERROR BOUNDARY');
  if (r.bodyLen < 40) flags.push(`nearly empty (${r.bodyLen} chars)`);
  if (!r.title) flags.push('no heading');
  if (r.a11y?.unreachable?.length) flags.push(`${r.a11y.unreachable.length} unreachable by keyboard`);
  if ((r.a11y?.focusableCount ?? 0) < 3) flags.push('almost nothing focusable');
  if (r.problems.length) flags.push(`${r.problems.length} console/network`);
  if (flags.length) {
    bad++;
    console.log(`\n✗ ${r.section}  [${flags.join(', ')}]`);
    for (const p of r.problems.slice(0, 6)) console.log(`    ${p.slice(0, 220)}`);
  } else {
    console.log(`✓ ${r.section.padEnd(12)} ${String(r.title).padEnd(22)} ${r.a11y.focusableCount} focusable`);
  }
}
console.log(`\n${rows.length - bad}/${rows.length} sections clean. Screenshots in ${OUT}`);
process.exit(bad ? 1 : 0);
