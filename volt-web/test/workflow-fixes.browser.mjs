// THE 1.14-G5a CONSOLE FIXES in a real browser: the rights preview says the
// loop is built from the slate (not "Set a loop"); on a FAST channel,
// choosing Stitched ads with no ad server opens the ad server form instead
// of being refused, and adding one saves stitched with it; Public cannot be
// switched on until a run order is active. Plus the sign-in form under vite
// dev still has the demo login filled in (production is checked on the build).
// Needs the API on a fresh database seeded by workflow-fixes.seed.ts (the account
// must have no ad server yet: with one, Stitched offers it instead of the form)
// and `npx vite`.
//   BASE=http://127.0.0.1:5173 EVENT_ID=... FAST_ID=... PLAYWRIGHT=... CHROMIUM=... SHOTS=<dir> node volt-web/test/workflow-fixes.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')
const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const SHOTS = process.env.SHOTS || ''
const EV = process.env.EVENT_ID, FAST = process.env.FAST_ID
if (!EV || !FAST) { console.log('set EVENT_ID and FAST_ID (printed by workflow-fixes.seed.ts)'); process.exit(2) }
const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
let passes = 0, fails = 0
const check = (m, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { passes++; console.log('PASS ' + m) } else { fails++; console.log(`FAIL ${m} -- expected ${w} got ${g}`) } }
const go = (p, path) => p.evaluate((u) => { history.pushState(null, '', u); dispatchEvent(new PopStateEvent('popstate')) }, path)

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const p = await ctx.newPage()
await p.goto(BASE + '/')
await p.waitForSelector('#signin-email')
check('sign-in under vite dev: the demo login is still filled in', [await p.inputValue('#signin-email'), (await p.inputValue('#signin-pw')).length > 0], ['admin@rtm.example', true])
await p.click('button:has-text("Sign in")')
await p.waitForSelector('.topbar', { timeout: 20000 })

// ---- rights preview: built from the slate
await go(p, '/events/' + EV)
await p.waitForSelector('.rp-card', { timeout: 20000 })
await p.fill('.rp-card input[maxlength="2"]', 'AU')
await p.click('.rp-card button:has-text("Check")')
await p.waitForSelector('[data-loop-missing]', { timeout: 10000 })
const msg = await p.textContent('[data-loop-missing]')
check('rights preview: AU is replaced and the note says the loop is built from the slate', [/slate image/.test(msg), /not ready yet/.test(msg), /Set a loop/.test(msg)], [true, true, false])
if (SHOTS) await p.locator('.rp-card').screenshot({ path: `${SHOTS}/rights-preview-slate.png` })

// ---- FAST: On air before a run order is active
await go(p, '/fast/' + FAST)
await p.waitForSelector('[role="tab"]:has-text("On air")', { timeout: 20000 })
await p.click('[role="tab"]:has-text("On air")')
await p.waitForSelector('.big-toggle', { timeout: 15000 })
const sw = p.locator('.big-toggle [role="switch"]')
check('FAST On air: Public is disabled with no active run order, and says why',
  [await sw.getAttribute('aria-disabled'), await sw.getAttribute('aria-checked'), /Activate the run order first/.test(await p.textContent('.big-toggle'))], ['true', 'false', true])
await sw.click({ force: true })   // aria-disabled: Playwright would refuse a normal click
await p.waitForTimeout(800)
check('FAST On air: clicking it changes nothing and raises no error', [await sw.getAttribute('aria-checked'), await p.locator('text=Couldn\'t change it.').count()], ['false', 0])
if (SHOTS) await p.locator('.big-toggle').screenshot({ path: `${SHOTS}/fast-public-needs-run-order.png` })

// ---- FAST: stitched ads with no ad server
await p.click('[role="tab"]:has-text("Ads")')
await p.waitForSelector('input[name="admode"]', { timeout: 15000 })
await p.locator('label.toggle-row:has-text("Stitched ads from your ad server") input').check()
await p.waitForSelector('[data-ad-server-card]', { timeout: 5000 })
check('Ads: choosing Stitched with no ad server opens the ad server form, no refusal',
  [await p.locator('[data-ad-server-card] textarea').count(), await p.locator('text=Couldn\'t save.').count(), await p.locator('text=Stitched ads need an ad server').count()], [1, 0, 0])
if (SHOTS) await p.locator('[data-ad-server-card]').screenshot({ path: `${SHOTS}/fast-add-first-ad-server.png` })
await p.fill('[data-ad-server-card] input.inp >> nth=0', 'House VAST')
await p.selectOption('[data-ad-server-card] select', 'vast')
await p.fill('[data-ad-server-card] textarea', 'https://ads.example.com/vast?dur=[BREAK_DURATION]&cb=[CACHEBUSTING]')
await p.click('[data-ad-server-card] button:has-text("Add and use")')
await p.waitForSelector('[data-ad-server-card] select.inp option:has-text("House VAST")', { state: 'attached', timeout: 10000 })
await p.waitForTimeout(800)
check('Ads: after Add and use, Stitched is the saved mode with that server chosen',
  [await p.locator('label.toggle-row:has-text("Stitched ads from your ad server") input').isChecked(),
   await p.$eval('[data-ad-server-card] select.inp', (s) => s.options[s.selectedIndex]?.textContent), await p.locator('text=Saved.').count() > 0], [true, 'House VAST', true])
await ctx.close(); await b.close()
console.log(`\n${passes}/${passes + fails} passed`)
process.exit(fails ? 1 : 0)
