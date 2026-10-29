// Browser walk for build queue 1.14-G5b-2 at 1440x900, against the docs seed
// (volt-app scripts/seed-docs.ts, admin@example.com) served as the screenshot
// script expects (API on :8080 with VOLT_DEPLOYMENT=saas, vite on :5173):
//   (f) the Channel Groups drawer's Save changes is not covered, and no ingest
//       queue button floats outside the top bar
//   (j) "Set type and metadata for all" is offered before any file is added
//   (l) Recordings finds Radio One by a song in its log and says so; the
//       station's log has a class picker that saves a correction
// The docs seed has no recordings, so (l) needs these added first:
//   INSERT INTO recordings(kind, channel_id, day_utc, status, start_epoch_ms, end_epoch_ms, duration_ms)
//     VALUES ('channel_day','cee14939-677b-4218-9f4c-62a1176d998f', now()::date, 'complete',
//             (extract(epoch from now() - interval '6 hours')*1000)::bigint, (extract(epoch from now() - interval '2 hours')*1000)::bigint, 14400000);
//   and four ICY log entries (programmes with metadata.source = 'icy') inside it:
//   "The Lanterns - Northern Lights" (song, twice), "Radio One - the best mix" (song), "News on the hour" (content).
//   PLAYWRIGHT=<playwright index.mjs> CHROMIUM=<chrome> OUT=<dir> node volt-web/test/g5b2-fixes.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT);
const B = 'http://127.0.0.1:5173', OUT = process.env.OUT;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })).newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e.message || e)));
let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log('PASS ' + m) } else { fail++; console.log('FAIL ' + m) } };
const go = async (u) => { await page.evaluate((u) => { history.pushState(null, '', u); dispatchEvent(new PopStateEvent('popstate')) }, u); await page.waitForTimeout(1500) };
await page.goto(B + '/'); await page.fill('#signin-email', 'admin@example.com'); await page.fill('#signin-pw', 'volt1234');
await page.click('button:has-text("Sign in")'); await page.waitForSelector('.topbar', { timeout: 20000 });

// (j)
await go('/vod'); await page.waitForSelector('.ig-type');
const metaBtn = page.locator('.ig-type-meta');
ok('(j) "Set type and metadata for all" is shown with no files added', await metaBtn.isVisible() && (await page.locator('.ig-row').count()) === 0);
await metaBtn.click(); await page.waitForTimeout(500);
ok('(j) it opens the sheet for every file before any is added', await page.locator('.ig-sheet:has-text("Every file added from now")').isVisible());
ok('(j) the sheet says to set it before adding files', await page.locator('.ig-sheet:has-text("Set this before you add files")').isVisible());
await page.screenshot({ path: OUT + '/j-meta-before-files.png' });

// (f)
await go('/groups'); await page.locator('button:has-text("Edit")').first().click(); await page.waitForTimeout(700);
const save = page.locator('button:has-text("Save changes")').first();
const box = await save.boundingBox();
const top = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? (e.closest('button')?.textContent ?? e.tagName) : null }, [box.x + box.width / 2, box.y + box.height / 2]);
ok('(f) Save changes in the Channel Groups drawer is the element under its own centre at 1440x900: ' + top, /Save changes/.test(String(top)));
const fixedFab = await page.evaluate(() => [...document.querySelectorAll('.iq-fab')].some(e => getComputedStyle(e).position === 'fixed' || !e.closest('.topbar')));
ok('(f) no ingest queue button floats outside the top bar', !fixedFab);
await page.screenshot({ path: OUT + '/f-drawer-footer.png' });
await page.keyboard.press('Escape');

// recordings search
await go('/recordings'); await page.fill('.rec-search', 'northern lights'); await page.waitForTimeout(1500);
const rows = await page.locator('tbody tr').allInnerTexts();
ok('(l) searching a song lists the station: ' + JSON.stringify(rows.map(r => r.split('\n')[0])), rows.length === 1 && /Radio One/.test(rows[0]));
ok('(l) and says what matched', /Played: “The Lanterns - Northern Lights”/.test(rows[0] ?? '') && /and 1 more/.test(rows[0] ?? ''));
await page.screenshot({ path: OUT + '/l-recordings-search.png' });

// radio class picker
await go('/radio/cee14939-677b-4218-9f4c-62a1176d998f'); await page.waitForTimeout(1500);
const sel = page.locator('select.log-class[aria-label="Class of Radio One - the best mix"]');
await sel.scrollIntoViewIfNeeded();
ok('(l) the log has a class picker for an operator', await sel.isVisible() && (await sel.inputValue()) === 'song');
const url0 = await page.evaluate(() => location.pathname);
await sel.selectOption('content'); await page.waitForTimeout(1500);
ok('(l) choosing Content saves it and stays on the page', (await page.evaluate(() => location.pathname)) === url0 && (await page.locator('select.log-class[aria-label="Class of Radio One - the best mix"]').inputValue()) === 'content');
ok('(l) its tooltip says who corrected it', /Corrected by .*classifier said song/.test(await page.locator('select.log-class[aria-label="Class of Radio One - the best mix"]').getAttribute('title')));
await page.locator('select.log-class[aria-label="Class of Radio One - the best mix"]').scrollIntoViewIfNeeded();
await page.screenshot({ path: OUT + '/l-radio-class.png' });
ok('no page errors: ' + errs.join(' | '), errs.length === 0);
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); process.exit(fail ? 1 : 0);
