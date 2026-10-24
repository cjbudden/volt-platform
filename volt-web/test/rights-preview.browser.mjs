// RIGHTS PREVIEW in a real browser (build queue 1.14c): on a channel and an
// event page, ask what a viewer in AU, MY and FJ gets, at now and at a guide
// time, play the answer and look at the picture. The output and its loop are
// test media in two colours (blue live, red loop), so the picture itself says
// which version is playing.
//
// Needs the API on a seeded database with the rights windows and the test
// output written (volt-web/test/rights-preview.seed.ts: AU replaced now, FJ
// blacked out now, NZ later, a later AU window with premium exempt), and
// `npx vite` in volt-web. Chromium must play VP9 (the test media is VP9
// because the container's Chromium has no H.264).
//   BASE=http://127.0.0.1:5173 CHANNEL_ID=... EVENT_ID=... PLAYWRIGHT=<path to playwright/index.mjs> \
//   CHROMIUM=<chromium binary, optional> SHOTS=<dir, optional> node volt-web/test/rights-preview.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')
const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const SHOTS = process.env.SHOTS || ''
const CH = process.env.CHANNEL_ID
const EV = process.env.EVENT_ID
if (!CH || !EV) { console.log('set CHANNEL_ID and EVENT_ID (printed by rights-preview.seed.ts)'); process.exit(2) }
const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
let passes = 0, fails = 0
const check = (m, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { passes++; console.log('PASS ' + m) } else { fails++; console.log(`FAIL ${m} -- expected ${w} got ${g}`) } }

async function signIn(w) {
  const ctx = await b.newContext({ viewport: { width: w, height: 1000 }, deviceScaleFactor: 1 })
  const p = await ctx.newPage()
  const media = []
  p.on('request', (r) => { const u = r.url(); if (/\.m4s(\?|$)/.test(u) || /\/v\/v[0-9a-f]{8}\//.test(u)) media.push(u) })
  await p.goto(BASE + '/')
  await p.fill('#signin-email', process.env.EMAIL || 'admin@rtm.example'); await p.fill('#signin-pw', process.env.PASSWORD || 'volt1234')
  await p.click('button:has-text("Sign in")')
  await p.waitForSelector('.topbar', { timeout: 20000 })
  return { ctx, p, media }
}
const go = (p, path) => p.evaluate((u) => { history.pushState(null, '', u); dispatchEvent(new PopStateEvent('popstate')) }, path)
async function ask(p, cc, rc = '') {
  await p.fill('.rp-card input[maxlength="2"]', cc)
  await p.fill('.rp-card input[maxlength="16"]', rc)
  await p.click('.rp-card button:has-text("Check")')
  await p.waitForFunction((c) => document.querySelector('.rp-result .rp-who')?.textContent?.startsWith(c === 'XX' ? 'Unknown' : c), cc, { timeout: 10000 })
  await p.waitForTimeout(300)
  return p.evaluate(() => ({
    tag: document.querySelector('.rp-result .tag')?.textContent,
    variant: document.querySelector('.rp-key code')?.textContent ?? null,
    why: document.querySelector('.rp-why')?.textContent ?? '',
    canPlay: !!document.querySelector('.rp-play button'),
    rows: [...document.querySelectorAll('.rp-row:not(.rp-ruler)')].map((r) => ({ aud: r.querySelector('.rp-aud')?.textContent, segs: [...r.querySelectorAll('.rp-seg')].map((s) => s.className.replace('rp-seg ', '')) })),
  }))
}
/** Play the answer and read the middle pixel of the picture: [r, g, b] once it has played a second. */
async function playColour(p) {
  await p.click('.rp-play button:has-text("Play as this viewer")')
  await p.waitForFunction(() => { const v = document.querySelector('.rp-video'); return v && v.currentTime > 1 && v.readyState >= 2 }, null, { timeout: 30000 })
  const px = await p.evaluate(() => {
    const v = document.querySelector('.rp-video'), c = document.createElement('canvas')
    c.width = v.videoWidth; c.height = v.videoHeight
    const g = c.getContext('2d'); g.drawImage(v, 0, 0)
    return [...g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data.slice(0, 3)]
  })
  return px
}
const red = (c) => c[0] > 150 && c[2] < 100, blue = (c) => c[2] > 150 && c[0] < 100

// ---- the channel page at desktop width
{
  const { ctx, p, media } = await signIn(1280)
  await go(p, '/channels/' + CH)
  await p.waitForSelector('.rp-card', { timeout: 20000 })
  await p.locator('.rp-card').scrollIntoViewIfNeeded()
  await p.waitForSelector('.rp-quick .chip', { timeout: 10000 })
  check('channel page: the Rights preview panel, with the countries its rules name', await p.$$eval('.rp-quick .chip', (e) => e.map((x) => x.textContent).filter((t) => /^[A-Z]{2}$/.test(t))), ['AU', 'FJ', 'NZ'])
  let r = await ask(p, 'AU')
  check('AU now: Replaced, a variant, the rule named', [r.tag, /^v[0-9a-f]{8}$/.test(r.variant ?? ''), r.why.includes('"Derby AU rights" is replaced for AU'), r.canPlay], ['Replaced', true, true, true])
  const auRow = r.rows.find((x) => x.aud === 'AU')
  check('...the strip: AU replaced now and again later; NZ later; FJ blocked', [auRow?.segs, r.rows.find((x) => x.aud === 'NZ')?.segs, r.rows.find((x) => x.aud === 'FJ')?.segs], [['replace', 'replace'], ['replace'], ['block']])
  if (SHOTS) await p.locator('.rp-card').screenshot({ path: `${SHOTS}/channel-au.png` })
  media.length = 0
  let c = await playColour(p)
  check('...playing it shows the loop (red), fetched through the admin-only variant path', [red(c), media.some((u) => u.includes(`/origin/${CH}/v/${r.variant}/`)), media.some((u) => u.includes('/filler/720p/seg_'))], [true, true, true])
  if (SHOTS) await p.locator('.rp-card').screenshot({ path: `${SHOTS}/channel-au-playing.png` })
  r = await ask(p, 'MY')
  check('MY now: Normal, no variant, no rule', [r.tag, r.variant, r.why], ['Normal', null, 'No rule stops MY at this time.'])
  media.length = 0
  c = await playColour(p)
  check('...playing it shows the programme (blue), not the loop', [blue(c), media.some((u) => u.includes('/filler/'))], [true, false])
  r = await ask(p, 'FJ')
  check('FJ now: Blocked by its blackout, nothing to play', [r.tag, r.why.includes('"Derby FJ blackout" is blacked out for FJ'), r.canPlay], ['Blocked', true, false])
  // a guide time: the late AU window, where premium is exempt
  await ask(p, 'AU', 'premium')
  await p.click('.rp-quick .chip:has-text("Late AU match")')
  await p.waitForFunction(() => !document.querySelector('.rp-result .rp-who')?.textContent?.includes('now'), null, { timeout: 10000 })
  await p.waitForTimeout(400)
  r = await p.evaluate(() => ({ tag: document.querySelector('.rp-result .tag')?.textContent, at: document.querySelector('.rp-card input[type="datetime-local"]')?.value }))
  check('a guide time (Late AU match) for AU premium: Normal, the class is exempt', [r.tag, !!r.at], ['Normal', true])
  r = await ask(p, 'AU')
  check('...the same time for AU without the class: Replaced, the exemption named', [r.tag, r.why.includes('premium is exempt')], ['Replaced', true])
  if (SHOTS) await p.locator('.rp-card').screenshot({ path: `${SHOTS}/channel-late-au.png` })
  // a strip piece sets the question
  await p.click('.rp-card button:has-text("Now")')
  await p.waitForTimeout(800)
  await p.click('.rp-row:has(.rp-aud:text-is("NZ")) .rp-seg')
  await p.waitForFunction(() => document.querySelector('.rp-result .rp-who')?.textContent?.startsWith('NZ'), null, { timeout: 10000 })
  await p.waitForTimeout(300)
  check('clicking NZ\'s window in the strip asks for NZ at that time: Replaced', await p.$eval('.rp-result .tag', (e) => e.textContent), 'Replaced')
  await ctx.close()
}
// ---- the event page, and a phone width
{
  const { ctx, p } = await signIn(390)
  await go(p, '/events/' + EV)
  await p.waitForSelector('.rp-card', { timeout: 20000 })
  await p.locator('.rp-card').scrollIntoViewIfNeeded()
  const r = await ask(p, 'AU')
  check('event page at 390 px: AU Replaced by the event\'s programme', [r.tag, r.why.includes('"Final AU rights"')], ['Replaced', true])
  const c = await playColour(p)
  check('...and it plays the loop', red(c), true)
  const sw = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
  check('...no sideways scroll with the answer and strip shown', sw[0] <= sw[1], true)
  if (SHOTS) await p.locator('.rp-card').screenshot({ path: `${SHOTS}/event-390.png` })
  await ctx.close()
}
await b.close()
console.log(`\n${passes}/${passes + fails} passed`)
process.exit(fails ? 1 : 0)
