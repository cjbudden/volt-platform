// MEDIA LIBRARY ASSET AT PHONE AND TABLET WIDTH in a real browser (build queue
// LIB-phone). In the list view, an asset opened from its row: at 390 and 768 px
// it opens in the asset panel, not in a row inside the list's sideways-scrolling
// table, and its tabs, the Metadata form and Find details are inside the screen
// with no sideways scroll; at 390 the panel is the whole screen with no width
// controls; at 1440 the asset still opens in its row under the title, as before.
// Also at 390: the grid opens the same panel, Close returns to the list, and a
// deep link (?asset=) opens it full width.
//
// Needs the API on the docs seed (it has Nosferatu) and `npx vite` in volt-web.
//   BASE=http://127.0.0.1:5173 PLAYWRIGHT=<playwright> CHROMIUM=<binary> SHOTS=<dir> node volt-web/test/library-phone.browser.mjs
const pw = await import(process.env.PLAYWRIGHT || 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const SHOTS = process.env.SHOTS || ''
const EMAIL = process.env.EMAIL || 'admin@example.com', PASSWORD = process.env.PASSWORD || 'volt1234'
const TITLE = 'Nosferatu', FILM = '6b1f0d2e-7a3c-4e5f-9a1b-2c3d4e5f6b01'
let passes = 0, fails = 0
const ok = (c, m) => { if (c) { passes++; console.log('PASS ' + m) } else { fails++; console.log('FAIL ' + m) } }

const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
const hscroll = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
// Visible things in the open asset that reach past either edge of the screen. A wide
// table that scrolls sideways in its own box (the Rights matrix) is meant to.
const outside = (p) => p.evaluate(() => [...document.querySelectorAll('.lib-drawer-asset .drawer-b *, .lib-drawer-asset .drawer-h *')]
  .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.right > window.innerWidth + 1 || r.left < -1) })
  .filter((e) => { for (let a = e.parentElement; a && !a.classList.contains('drawer-b'); a = a.parentElement) { const ox = getComputedStyle(a).overflowX; if ((ox === 'auto' || ox === 'scroll') && a.getBoundingClientRect().right <= window.innerWidth + 1) return false } return true })
  .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}`).slice(0, 6))
const inScreen = (p, sel) => p.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1 }, sel)
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${n}.png` }) }

for (const w of [1440, 768, 390]) {
  const ctx = await b.newContext({ viewport: { width: w, height: w < 600 ? 844 : 1000 }, deviceScaleFactor: 1, colorScheme: 'dark' })
  const p = await ctx.newPage()
  const errs = []; p.on('pageerror', (e) => errs.push(String(e.message)))
  await p.goto(BASE + '/')
  await p.fill('#signin-email', EMAIL); await p.fill('#signin-pw', PASSWORD)
  await p.click('button:has-text("Sign in")'); await p.waitForSelector('.topbar', { timeout: 20000 })
  const go = (u) => p.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')) }, u)
  await go('/vod')
  await p.waitForSelector('.lib-table', { timeout: 20000 })
  await p.locator(`tr:has-text("${TITLE}") button:has-text("Open")`).first().click()
  await p.locator('button:text-is("Metadata")').first().click()
  await p.waitForSelector('.asset-find button:has-text("Find details")')
  const inRow = await p.locator('.lib-table td[colspan] .asset-find').count()
  const panel = await p.locator('.lib-drawer-asset').count()
  if (w === 1440) {
    ok(inRow === 1 && panel === 0, `1440: the asset opens in its row under the title, as before (row ${inRow}, panel ${panel})`)
    ok(await p.locator('tr.lib-row-open').count() === 1, '1440: its row is marked open')
  } else {
    ok(inRow === 0 && panel === 1, `${w}: the asset opens in the panel, not inside the table (row ${inRow}, panel ${panel})`)
    ok(await hscroll(p) <= 0, `${w}: no sideways page scroll (${await hscroll(p)})`)
    const db = await p.evaluate(() => { const e = document.querySelector('.lib-drawer-asset .drawer-b'); return e.scrollWidth - e.clientWidth })
    ok(db <= 0, `${w}: the panel has no sideways scroll (${db})`)
    const o = await outside(p)
    ok(o.length === 0, `${w}: nothing in the panel is past the screen's edges (${o.join(', ')})`)
    const tabs = await p.evaluate(() => [...document.querySelectorAll('.lib-drawer-asset button')].filter((e) => ['Metadata', 'Encode', 'Availability'].includes(e.textContent.trim())).map((e) => { const r = e.getBoundingClientRect(); return r.right <= window.innerWidth + 1 && r.left >= -1 }))
    ok(tabs.length >= 2 && tabs.every(Boolean), `${w}: the tabs are inside the screen (${tabs.length} found)`)
    ok(await inScreen(p, '.asset-find button'), `${w}: Find details is inside the screen`)
    // The Metadata form arrives after the asset's content type: wait for its fields.
    await p.waitForFunction(() => [...document.querySelectorAll('.lib-drawer-asset .drawer-b input, .lib-drawer-asset .drawer-b select, .lib-drawer-asset .drawer-b textarea')].filter((e) => e.getBoundingClientRect().width > 0).length >= 2, null, { timeout: 10000 }).catch(() => {})
    const form = await p.evaluate(() => [...document.querySelectorAll('.lib-drawer-asset .drawer-b input, .lib-drawer-asset .drawer-b select, .lib-drawer-asset .drawer-b textarea')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return r.right <= window.innerWidth + 1 && r.left >= -1 }))
    ok(form.length >= 2 && form.every(Boolean), `${w}: every Metadata field is inside the screen (${form.length} fields)`)
    // Every other tab fits too (the Preview tab's facts stack under the player on a phone).
    for (const t of ['Preview', 'Skip markers', 'Companion files', 'Encode', 'Formats', 'Rights', 'Availability', 'History']) {
      await p.locator(`.lib-drawer-asset button:text-is("${t}")`).first().click()
      await p.waitForTimeout(800)
      const o = await outside(p), h = await hscroll(p)
      ok(o.length === 0 && h <= 0, `${w}: the ${t} tab fits the screen (${o.join(', ')}${h > 0 ? ` page scroll ${h}` : ''})`)
      if (t === 'Preview') await shot(p, `lib-phone-preview-${w}`)
    }
    const ctl = await p.evaluate(() => ({ handle: !!document.querySelector('.lib-drawer-asset .drawer-resize'), width: !!document.querySelector('.lib-drawer-asset [aria-label^="Panel width is"]'), w: Math.round(document.querySelector('.lib-drawer-asset').getBoundingClientRect().width) }))
    if (w === 390) ok(!ctl.handle && !ctl.width && ctl.w === 390, `390: the panel is the whole screen with no width controls (${JSON.stringify(ctl)})`)
    else ok(ctl.handle && ctl.width && ctl.w <= 768, `768: the panel keeps its width controls and fits the screen (${JSON.stringify(ctl)})`)
  }
  await shot(p, `lib-phone-metadata-${w}`)
  if (w !== 1440) {
    await p.click('.lib-drawer-asset button[aria-label="Close"]')
    await p.waitForSelector('.lib-drawer-asset', { state: 'detached', timeout: 5000 })
    ok(await p.locator('.lib-table').count() === 1, `${w}: Close returns to the list`)
  }
  if (w === 390) {
    // The grid and a deep link open the same full-screen panel.
    await p.locator('button:has-text("Grid"), [role="radio"]:has-text("Grid")').first().click()
    await p.waitForSelector('.lib-grid', { timeout: 10000 })
    await p.locator(`.lib-card-open[aria-label="Open ${TITLE}"]`).first().click()
    await p.waitForSelector('.lib-drawer-asset .lib-tabs, .lib-drawer-asset button:text-is("Metadata")')
    await p.waitForTimeout(500) // the panel slides in
    const g = { w: await p.evaluate(() => Math.round(document.querySelector('.lib-drawer-asset').getBoundingClientRect().width)), out: await outside(p) }
    ok(g.w === 390 && g.out.length === 0, `390: from the grid, the same full-screen panel (${JSON.stringify(g)})`)
    await p.click('.lib-drawer-asset button[aria-label="Close"]')
    await go(`/vod?asset=${FILM}`)
    await p.waitForSelector('.lib-drawer-asset')
    ok(await p.evaluate(() => Math.round(document.querySelector('.lib-drawer-asset').getBoundingClientRect().width)) === 390 && await hscroll(p) <= 0, '390: a deep link opens it full screen')
    await shot(p, 'lib-phone-deeplink-390')
  }
  ok(errs.length === 0, `${w}: no page errors (${errs.join(' | ')})`)
  await ctx.close()
}
await b.close()
console.log(`\n${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
