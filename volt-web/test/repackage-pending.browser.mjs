// REPACKAGE PENDING in a real browser (build queue P4-5): the Media Library's
// filter beside Expires in 7 days. A Documentary rule asks for DRM and two of
// its published titles have clear files, so they are pending; turning the
// filter on puts rp=1 in the page URL and lists exactly the titles the API
// lists for repackage_pending=true; turning it off lists the library again.
// At 1440 and 390 px, with no sideways scroll.
//
// Needs the API on the docs seed plus volt-web/test/publishing-policies.seed.ts,
// the two Documentary titles given packaged files (SETUP_SQL below, run by
// whoever runs this; it does not touch the database itself), and `npx vite`.
//   BASE=http://127.0.0.1:5173 PLAYWRIGHT=<path to playwright/index.mjs> \
//   CHROMIUM=<chromium binary, optional> SHOTS=<dir, optional> node volt-web/test/repackage-pending.browser.mjs
//   SETUP_SQL: UPDATE vod_assets SET master_key = '/clips/vod/' || id || '/master.m3u8', encode_result = '{"drm":"clear"}'
//              WHERE title IN ('Harbour Market', 'A Quiet Valley');
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')
const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const SHOTS = process.env.SHOTS || ''
const EMAIL = process.env.EMAIL || 'admin@example.com', PASSWORD = process.env.PASSWORD || 'volt1234'
let passes = 0, fails = 0
const ok = (c, m) => { if (c) { passes++; console.log('PASS ' + m) } else { fails++; console.log('FAIL ' + m) } }

const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json()
const api = async (path, opts = {}) => {
  const r = await fetch(BASE + '/api' + path, { ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${login.access}` } })
  return { status: r.status, body: r.status === 204 ? null : await r.json() }
}
const types = (await api('/metadata-schemas')).body
const doc = (Array.isArray(types) ? types : types.items ?? []).find((t) => t.name === 'Documentary')
if (!doc) { console.log('run publishing-policies.seed.ts first'); process.exit(2) }
const put = await api(`/publishing-rules/schema/${doc.id}`, { method: 'PUT', body: JSON.stringify({ settings: { protection: { drm: true }, distribution: { mp4Download: false } }, lockedFields: [], presetKey: null, confirm: true }) })
ok(put.status === 200, `setup: the Documentary rule asks for DRM (${put.status})`)
const rows = (b) => (Array.isArray(b) ? b : b.items ?? [])
const pending = rows((await api('/vod?repackage_pending=true&limit=100')).body).map((x) => x.title).sort()
ok(JSON.stringify(pending) === JSON.stringify(['A Quiet Valley', 'Harbour Market']), `the API: two titles pending (${pending.join(', ')})`)

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
for (const [w, h] of [[1440, 900], [390, 844]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  await page.goto(BASE + '/')
  await page.fill('#signin-email', EMAIL); await page.fill('#signin-pw', PASSWORD)
  await page.click('button:has-text("Sign in")'); await page.waitForSelector('.topbar', { timeout: 20000 })
  await page.evaluate(() => { history.pushState({}, '', '/vod'); dispatchEvent(new PopStateEvent('popstate')) })
  await page.waitForTimeout(2000)
  // On a phone the filters sit behind a button.
  const toggle = page.getByRole('button', { name: 'Repackage pending' })
  if (!(await toggle.isVisible().catch(() => false))) {
    const open = page.getByRole('button', { name: /^Filters/ }).first()
    if (await open.isVisible().catch(() => false)) { await open.click(); await page.waitForTimeout(500) }
  }
  ok(await toggle.isVisible(), `${w}px: Repackage pending is offered with the filters`)
  ok((await toggle.getAttribute('aria-pressed')) === 'false', `${w}px: off to begin with`)
  await toggle.click()
  await page.waitForTimeout(2000)
  ok(new URL(page.url()).searchParams.get('rp') === '1', `${w}px: the page URL carries rp=1 (${page.url().replace(BASE, '')})`)
  ok((await toggle.getAttribute('aria-pressed')) === 'true', `${w}px: pressed once on`)
  const text = await page.locator('body').innerText()
  ok(text.includes('Harbour Market') && text.includes('A Quiet Valley'), `${w}px: both pending titles listed`)
  ok(!text.includes('Station promo') && !text.includes('The Night Bakery'), `${w}px: titles that are not pending are not listed`)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/repackage-pending-${w}.png`, fullPage: false })
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ok(sideways <= 0, `${w}px: no sideways scroll (${sideways})`)
  await toggle.click()
  await page.waitForTimeout(2000)
  const back = await page.locator('body').innerText()
  ok(!new URL(page.url()).searchParams.has('rp') && back.includes('Station promo'), `${w}px: off again, the library lists the rest`)
  await page.close()
}
await browser.close()
console.log(`\n${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
