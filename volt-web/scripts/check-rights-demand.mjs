// Browser check for the Rights demand report (build queue P2-4), against the docs seed.
// Needs the API on a fresh docs seed and the console served by vite, as for the
// guides' screenshots (docs-site/scripts/screenshots.mjs):
//   (volt-app)  DATABASE_URL=... npx tsx scripts/seed-docs.ts && PORT=8080 npx tsx src/index.ts
//   (volt-web)  npx vite --port 5173
//   (volt-web)  node scripts/check-rights-demand.mjs
// Env: BASE (default http://127.0.0.1:5173), PLAYWRIGHT (path to playwright's
// index.mjs if it is not installed here), OUT (where the screenshots go).
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const OUT = process.env.OUT || join(tmpdir(), 'volt-rights-demand');
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
  const go = (u) => page.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')); }, u);
  await go('/analytics');
  await page.waitForSelector('button[role=tab]:has-text("Rights demand")', { timeout: 15000 });
  ok(true, `${width}: the Rights demand tab is in the Analytics view switch`);
  await page.click('button[role=tab]:has-text("Rights demand")');
  await page.waitForSelector('[data-testid=demand-countries] tbody tr', { timeout: 15000 });
  ok(new URL(page.url()).pathname === '/analytics/rights-demand', `${width}: the tab opens /analytics/rights-demand`);
  await page.waitForSelector('svg path[data-country]', { timeout: 15000 });
  const paths = await page.locator('svg path[data-country]').count();
  ok(paths > 150, `${width}: the map draws ${paths} countries`);
  const gb = await page.locator('path[data-country=GB]').getAttribute('fill');
  const cn = await page.locator('path[data-country=CN]').getAttribute('fill');
  ok(gb?.includes('color-mix') && cn === 'var(--panel-2)', `${width}: Britain shaded (${gb?.slice(0, 30)}), China none`);
  const first = (await page.locator('[data-testid=demand-countries] tbody tr').first().innerText()).split('\t')[0].trim();
  ok(first === 'United States', `${width}: most blocked viewers first in the table: ${first}`);
  const sg = await page.locator('[data-testid=demand-countries] tbody tr', { hasText: 'Singapore' }).count();
  ok(sg === 1, `${width}: Singapore, too small for the map, is in the table`);
  const legend = await page.getByText(/too small to draw/).count();
  ok(legend === 1, `${width}: the legend says some countries are too small to draw`);
  const blocked = await page.locator('text=Blocked viewers').first().isVisible();
  ok(blocked, `${width}: the totals show`);
  const hscroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(hscroll <= 0, `${width}: no horizontal page scroll (${hscroll})`);
  await page.screenshot({ path: `${OUT}/rd-${width}-all.png`, fullPage: true });

  // Hover a country: the tooltip has its numbers.
  const box = await page.locator('path[data-country=US]').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6);
  await page.waitForTimeout(200);
  ok(await page.getByText('United States').first().isVisible(), `${width}: hovering a country shows its name and figures`);

  // Click Britain on the map: the country filter is set and the report narrows.
  // At phone width Britain is a few pixels wide: click the shape itself.
  if (width > 800) { const gbb = await page.locator('path[data-country=GB]').boundingBox(); await page.mouse.click(gbb.x + gbb.width * 0.55, gbb.y + gbb.height * 0.7); }
  else await page.locator('path[data-country=GB]').dispatchEvent('click');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('country') === 'GB', null, { timeout: 5000 }).catch(() => {});
  ok(new URL(page.url()).searchParams.get('country') === 'GB', `${width}: clicking Britain filters the report to it`);
  await page.waitForTimeout(800);
  const rows = await page.locator('[data-testid=demand-countries] tbody tr').count();
  ok(rows === 1, `${width}: only Britain left in the countries table (${rows})`);
  await page.click('button[aria-label^="Remove the United Kingdom"]');
  await page.waitForTimeout(800);

  // Drill into the league title: licensed column, window card, marks on the trend.
  const titleRow = page.locator('[data-testid=demand-titles] tbody tr').first();
  const tname = (await titleRow.locator('td').first().innerText()).split('\n')[0];
  await titleRow.click();
  await page.waitForSelector('th:has-text("Licensed")', { timeout: 8000 });
  ok(true, `${width}: choosing ${tname} adds the Licensed column`);
  const au = await page.locator('[data-testid=demand-countries] tbody tr', { hasText: 'Australia' }).innerText();
  const gbRow = await page.locator('[data-testid=demand-countries] tbody tr', { hasText: 'United Kingdom' }).innerText();
  ok(/licensed/i.test(au) && !/not licensed/i.test(au) && /not licensed/i.test(gbRow), `${width}: Australia licensed, Britain not`);
  ok(await page.getByText(/Only in Australia, New Zealand/).count() === 1, `${width}: the title's territories in words`);
  await page.screenshot({ path: `${OUT}/rd-${width}-title.png`, fullPage: true });

  // Plays on the map.
  await page.click('button:has-text("Plays")');
  await page.waitForTimeout(400);
  const auFill = await page.locator('path[data-country=AU]').getAttribute('fill');
  ok(auFill?.includes('100%'), `${width}: the Plays map shows Australia brightest (${auFill?.slice(0, 34)})`);

  // CSV download.
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('button:has-text("Download CSV")')]);
  const csvName = dl.suggestedFilename();
  ok(/^rights-demand-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/.test(csvName), `${width}: CSV downloads as ${csvName}`);
  ok(errs.length === 0, `${width}: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}
mkdirSync(OUT, { recursive: true });
await run(1440, 900);
await run(390, 844);
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
