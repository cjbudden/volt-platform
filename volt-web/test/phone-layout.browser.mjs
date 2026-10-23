// PHONE AND TABLET SHELL, in a real browser (build queue 1.14).
// Under 900 px the sidebar is a drawer opened from the menu button; no page
// may scroll sideways. Checks Dashboard, Channels, a channel, an event and the
// Media Library at 390 px and 768 px (and 1280 px: the desktop shell is
// unchanged), plus the drawer: closed at start, opens, a page pick navigates
// and closes it, Escape and a tap on the scrim close it.
//
// Needs the API on a seeded database (scripts/seed-demo.ts) and `npx vite` in
// volt-web. Sign-in is once per width (the session is in memory, so pages are
// reached with pushState, not page.goto).
//   BASE=http://127.0.0.1:5173 PLAYWRIGHT=<path to playwright/index.mjs> \
//   CHROMIUM=<chromium binary, optional> node volt-web/test/phone-layout.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')
const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const SHOTS = process.env.SHOTS || ''
// The demo seed's fixed ids (RTM News 24, Grand Final).
const CH = process.env.CHANNEL_ID || 'ae0e5ac4-9833-48b7-ab97-91df0d27467c'
const EV = process.env.EVENT_ID || '89ea095c-3108-4312-936b-788c563b059d'
const pages = [['dashboard','/dashboard'],['channels','/channels'],['channel','/channels/' + CH],['event','/events/' + EV],['library','/vod']]
const widths = (process.env.W || '390,768,1280').split(',').map(Number)
const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
let fails = 0, passes = 0
const report = []
for (const w of widths) {
  const ctx = await b.newContext({ viewport: { width: w, height: 844 }, deviceScaleFactor: 1 })
  const p = await ctx.newPage()
  await p.goto(BASE + '/')
  await p.fill('#signin-email', 'admin@rtm.example'); await p.fill('#signin-pw', 'volt1234')
  await p.click('button:has-text("Sign in")')
  await p.waitForSelector('.topbar', { timeout: 20000 })
  for (const [name, path] of pages) {
    await p.evaluate(u => { history.pushState(null, '', u); dispatchEvent(new PopStateEvent('popstate')) }, path)
    await p.waitForTimeout(2500)
    const r = await p.evaluate(() => {
      const vw = document.documentElement.clientWidth
      const sw = document.documentElement.scrollWidth
      const off = []
      for (const el of document.querySelectorAll('.app *')) {
        if (el.closest('.sidebar')) continue
        const rc = el.getBoundingClientRect()
        if (rc.width === 0 || rc.right <= vw + 1) continue
        // skip children inside a scroll container that holds the overflow
        let q = el.parentElement, clipped = false
        while (q && q !== document.body) { const o = getComputedStyle(q).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') { if (q.getBoundingClientRect().right <= vw + 1) { clipped = true; break } } q = q.parentElement }
        if (clipped) continue
        off.push((el.tagName.toLowerCase() + '.' + [...el.classList].join('.')).slice(0, 60) + ' r=' + Math.round(rc.right) + ' w=' + Math.round(rc.width))
      }
      return { vw, sw, off: off.slice(0, 12), h1: document.querySelector('h1')?.textContent?.slice(0,40) }
    })
    const ok = r.sw <= r.vw
    ok ? passes++ : fails++
    report.push(`${w}px ${name.padEnd(9)} ${ok ? 'PASS' : 'FAIL'} scrollWidth=${r.sw} viewport=${r.vw} h1=${r.h1}` + (ok ? '' : '\n    ' + r.off.join('\n    ')))
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/${w}-${name}.png` })
  }
  if (w < 900) {
    // drawer: opens from the menu button, a nav pick closes it and navigates
    const hidden0 = await p.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).visibility)
    if (!(await p.$('.nav-toggle'))) { fails += 5; report.push(`${w}px drawer: no menu button FAIL`); await ctx.close(); continue }
    await p.click('.nav-toggle'); await p.waitForTimeout(400)
    const open = await p.evaluate(() => { const r = document.querySelector('.sidebar').getBoundingClientRect(); return { left: r.left, vis: getComputedStyle(document.querySelector('.sidebar')).visibility, exp: document.querySelector('.nav-toggle').getAttribute('aria-expanded') } })
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/${w}-drawer.png` })
    await p.click('.sidebar a.nav-item:has-text("Events")'); await p.waitForTimeout(800)
    const after = await p.evaluate(() => ({ path: location.pathname, vis: getComputedStyle(document.querySelector('.sidebar')).visibility, scrim: !!document.querySelector('.nav-scrim') }))
    await p.click('.nav-toggle'); await p.waitForTimeout(300); await p.keyboard.press('Escape'); await p.waitForTimeout(400)
    const esc = await p.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).visibility)
    await p.click('.nav-toggle'); await p.waitForTimeout(300); await p.mouse.click(w - 10, 600); await p.waitForTimeout(400)
    const scrimClose = await p.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).visibility)
    const checks = [['closed at start', hidden0 === 'hidden'], ['opens at left 0', open.left === 0 && open.vis === 'visible' && open.exp === 'true'], ['nav pick navigates and closes', after.path === '/events' && after.vis === 'hidden' && !after.scrim], ['Escape closes', esc === 'hidden'], ['scrim tap closes', scrimClose === 'hidden']]
    for (const [n, ok] of checks) { ok ? passes++ : fails++; report.push(`${w}px drawer: ${n} ${ok ? 'PASS' : 'FAIL'}`) }
  } else {
    const r = await p.evaluate(() => ({ t: document.querySelector('.nav-toggle') ? getComputedStyle(document.querySelector('.nav-toggle')).display : 'none', s: getComputedStyle(document.querySelector('.sidebar')).position }))
    const ok = r.t === 'none' && r.s === 'sticky'; ok ? passes++ : fails++
    report.push(`${w}px desktop shell unchanged (no menu button, sidebar in place) ${ok ? 'PASS' : 'FAIL'}`)
  }
  await ctx.close()
}
await b.close()
console.log(report.join('\n')); console.log(`\n${passes}/${passes + fails} passed`)
process.exit(fails ? 1 : 0)
