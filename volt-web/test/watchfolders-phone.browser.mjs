// WATCHFOLDERS AT PHONE WIDTH in a real browser (build queue WF-phone). The
// list, a local watchfolder and an on-prem (site) watchfolder, each with its
// rules, the add-rule row and queue rows with long file names and paths, at
// 390, 768 and 1440 px: no sideways page scroll at any width, every rule's
// buttons and every queue row's buttons inside the screen, and at 1440 the
// desktop columns unchanged (six rule columns, five queue columns).
//
// Needs the API on the docs seed plus an on-prem folder and queue items (see
// VOLT_BUILD_STATUS.md, WF-phone), and `npx vite` in volt-web.
//   BASE=http://127.0.0.1:5173 PLAYWRIGHT=<playwright> CHROMIUM=<binary> SHOTS=<dir> node volt-web/test/watchfolders-phone.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')
const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const SHOTS = process.env.SHOTS || ''
const EMAIL = process.env.EMAIL || 'admin@example.com', PASSWORD = process.env.PASSWORD || 'volt1234'
let passes = 0, fails = 0
const ok = (c, m) => { if (c) { passes++; console.log('PASS ' + m) } else { fails++; console.log('FAIL ' + m) } }
const LOCAL = 'Agency drop', SITE = 'Newsroom ingest at the broadcast centre'

const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
const hscroll = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
// Anything that sticks out of the screen on the right, inside a scrolling card or not.
const outside = (p, sel) => p.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).length, sel)
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }) }

for (const w of [1440, 768, 390]) {
  const ctx = await b.newContext({ viewport: { width: w, height: w < 600 ? 860 : 1000 }, deviceScaleFactor: 1, colorScheme: 'dark' })
  const p = await ctx.newPage()
  const errs = []; p.on('pageerror', (e) => errs.push(String(e.message)))
  await p.goto(BASE + '/')
  await p.fill('#signin-email', EMAIL); await p.fill('#signin-pw', PASSWORD)
  await p.click('button:has-text("Sign in")'); await p.waitForSelector('.topbar', { timeout: 20000 })
  const go = (u) => p.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')) }, u)
  await go('/watchfolders')
  await p.waitForSelector('.wf-card', { timeout: 20000 })
  ok(await p.locator('.wf-card').count() >= 2, `${w}: the list shows the local and the on-prem folder`)
  ok(await hscroll(p) <= 0, `${w}: the list has no sideways scroll (${await hscroll(p)})`)
  ok(await outside(p, '.wf-card, .wf-card *') === 0, `${w}: nothing in the list cards is past the right edge`)
  await shot(p, `wf-list-${w}`)
  for (const [name, tag] of [[LOCAL, 'local'], [SITE, 'site']]) {
    await p.locator('.wf-card', { hasText: name }).first().click()
    await p.waitForSelector('.wf-rule', { timeout: 10000 })
    await p.waitForSelector('.wf-item', { timeout: 10000 })
    ok(await hscroll(p) <= 0, `${w}: the ${tag} folder has no sideways scroll (${await hscroll(p)})`)
    ok(await outside(p, '.wf-rule button, .wf-add > *, .wf-item button, .wf-item') === 0, `${w}: the ${tag} folder's rule buttons, add-rule fields and queue rows are inside the screen`)
    if (w === 1440) {
      const cols = await p.evaluate(() => ({
        rule: getComputedStyle(document.querySelector('.wf-rule')).gridTemplateColumns.split(' ').length,
        item: getComputedStyle(document.querySelector('.wf-item')).gridTemplateColumns.split(' ').length,
        add: getComputedStyle(document.querySelector('.wf-add')).gridTemplateColumns.split(' ').length,
      }))
      ok(cols.rule === 6 && cols.item === 5 && cols.add === 5, `1440: the ${tag} folder keeps its desktop columns (${JSON.stringify(cols)})`)
    }
    if (w === 390) {
      // Stacked: the queue row's name above its status, the rule's name beside its number.
      const lay = await p.evaluate(() => {
        const it = document.querySelector('.wf-item'), r = document.querySelector('.wf-rule')
        const a = it.children[0].getBoundingClientRect(), s = it.children[1].getBoundingClientRect()
        return { itemStacked: s.top >= a.bottom - 1, ruleCols: getComputedStyle(r).gridTemplateColumns.split(' ').length }
      })
      ok(lay.itemStacked && lay.ruleCols === 2, `390: the ${tag} folder stacks (${JSON.stringify(lay)})`)
    }
    await shot(p, `wf-${tag}-${w}`)
    await p.click('button:has-text("← Watchfolders")')
    await p.waitForSelector('.wf-card', { timeout: 10000 })
  }
  ok(errs.length === 0, `${w}: no page errors (${errs.join(' | ')})`)
  await ctx.close()
}
await b.close()
console.log(`\n${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
