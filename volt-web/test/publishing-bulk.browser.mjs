// PUBLISHING POLICY IN BULK in a real browser (build queue P3-2c): the Media
// Library's bulk bar, Publishing policy, on titles of a content type whose
// rule locks Access and titles with no type. Before you save shows the
// server's dry run (the titles that can take it, the ones a lock keeps as they
// are, named), the save gives the titles that can take it their own policy and
// leaves the rest; DRM on published titles asks for the box; clearing puts
// them back on the rules. At 1440 and 390 px, with no sideways scroll.
//
// Needs the API on the docs seed plus volt-web/test/publishing-policies.seed.ts
// (a Documentary type with four titles, two published), and `npx vite` in
// volt-web. What the page shows is compared with what the API says.
//   BASE=http://127.0.0.1:5173 PLAYWRIGHT=<path to playwright/index.mjs> \
//   CHROMIUM=<chromium binary, optional> SHOTS=<dir, optional> node volt-web/test/publishing-bulk.browser.mjs
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
const lib = (await api('/vod?limit=100')).body
const byTitle = (t) => (Array.isArray(lib) ? lib : lib.items).find((x) => x.title === t)
const DOCS = ['Harbour Market', 'A Quiet Valley'], OTHERS = ['Harbour Lights', 'Station promo']
const pick = [...DOCS, ...OTHERS].map(byTitle)
if (pick.some((x) => !x)) { console.log('the docs seed titles are missing'); process.exit(2) }
const override = async (id) => (await api(`/vod/${id}/availability`)).body.override ?? {}
// The Documentary rule sets and locks Access; nothing else is locked.
await api('/publishing-rules/account', { method: 'PUT', body: JSON.stringify({ settings: (await api('/publishing-rules/account')).body.settings, lockedFields: [], presetKey: null }) })
const put = await api(`/publishing-rules/schema/${doc.id}`, { method: 'PUT', body: JSON.stringify({ settings: { access: 'entitled' }, lockedFields: ['access'], presetKey: null, confirm: true }) })
ok(put.status === 200, `setup: the Documentary rule locks Access (${put.status})`)
for (const x of pick) await api(`/vod/${x.id}/availability`, { method: 'PATCH', body: JSON.stringify({ override: {}, confirm: true }) })

const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
async function signIn(w) {
  const ctx = await b.newContext({ viewport: { width: w, height: w < 600 ? 860 : 1000 }, deviceScaleFactor: 1, colorScheme: 'dark' })
  const p = await ctx.newPage()
  const errs = []; p.on('pageerror', (e) => errs.push(String(e.message)))
  await p.goto(BASE + '/')
  await p.fill('#signin-email', EMAIL); await p.fill('#signin-pw', PASSWORD)
  await p.click('button:has-text("Sign in")'); await p.waitForSelector('.topbar', { timeout: 20000 })
  const go = (u) => p.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')) }, u)
  return { p, ctx, errs, go }
}
const hscroll = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
const D = '[data-bulk-policy]'
const settle = (p) => p.waitForFunction((D) => {
  const c = document.querySelector(`${D} [data-policy-check]`); return !!c && !c.textContent.includes('checking') && !!c.querySelector('[data-impact]')
}, D, { timeout: 10000 }).then(() => p.waitForTimeout(150))
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false }) }
async function select(p, titles) {
  for (const t of titles) await p.getByLabel(`Select ${t}`, { exact: true }).first().check()
  await p.waitForSelector('.bulk-bar', { timeout: 5000 })
}

for (const w of [1440, 390]) {
  const { p, errs, go, ctx } = await signIn(w)
  await go('/vod')
  await p.waitForSelector(`[aria-label="Select ${DOCS[0]}"]`, { timeout: 20000 })
  await select(p, [...DOCS, ...OTHERS])
  const bar = await p.locator('.bulk-bar').innerText()
  ok(/4\s*assets selected/.test(bar) && bar.includes('Publishing policy'), `${w}: the bulk bar offers Publishing policy for the four (${bar.replace(/\s+/g, ' ').slice(0, 120)})`)
  await p.click('.bulk-bar button:has-text("Publishing policy")')
  await p.waitForSelector(D)
  ok(await p.isDisabled(`${D} [data-bulk-policy-save]`), `${w}: nothing chosen yet, nothing to save`)

  // Members on all four: the two Documentary titles are kept by their type's lock.
  await p.selectOption(`${D} [data-bulk-policy-preset]`, 'members')
  await settle(p)
  const dry = (await api('/vod/bulk/availability?dryRun=1', { method: 'POST', body: JSON.stringify({ ids: pick.map((x) => x.id), action: 'apply', presetKey: 'members' }) })).body
  const impact = await p.locator(`${D} [data-impact]`).innerText()
  ok(impact.includes(`${dry.ok} of 4 can take this`) && impact.includes(`${dry.impact.published} published`) && impact.includes(`Saving changes ${dry.impact.changed}`),
    `${w}: Before you save shows the API's numbers (${impact.replace(/\s+/g, ' ')}; API ok ${dry.ok}, published ${dry.impact.published}, changed ${dry.impact.changed})`)
  const refused = await p.locator(`${D} [data-refused-title]`).allInnerTexts()
  ok(refused.length === 2 && DOCS.every((t) => refused.some((r) => r.startsWith(t) && /Access is locked by the content type rule/.test(r))),
    `${w}: the two Documentary titles are named, kept by the type's lock (${refused.join(' | ')})`)
  const saveLabel = await p.locator(`${D} [data-bulk-policy-save]`).innerText()
  ok(saveLabel === `Apply to ${dry.ok} titles` && !(await p.isDisabled(`${D} [data-bulk-policy-save]`)), `${w}: Save names the titles that take it (${saveLabel})`)
  ok(await hscroll(p) <= 0, `${w}: no sideways scroll with the dialog open`)
  await shot(p, `bulk-policy-${w}-preview`)
  await p.click(`${D} [data-bulk-policy-save]`)
  await p.waitForSelector(D, { state: 'detached', timeout: 10000 })
  const ov = await Promise.all(pick.map((x) => override(x.id)))
  ok(ov.slice(0, 2).every((o) => !Object.keys(o).length) && ov.slice(2).every((o) => o.access === dry.override.access),
    `${w}: saved on the two without a type, the Documentary ones left as they were (${JSON.stringify(ov.map((o) => o.access ?? null))})`)
  const note = await p.locator('.notice, [role=status], [role=alert]').allInnerTexts()
  ok(note.some((t) => /2 titles given the policy/.test(t) && /left as they were/.test(t)), `${w}: the page says what was done and what was left (${note.join(' | ').replace(/\s+/g, ' ').slice(0, 200)})`)

  // DRM on a published title: the box must be ticked.
  await select(p, OTHERS)
  await p.click('.bulk-bar button:has-text("Publishing policy")')
  await p.waitForSelector(D)
  await p.selectOption(`${D} [data-bulk-policy-preset]`, 'premium')
  await settle(p)
  const prem = (await api('/vod/bulk/availability?dryRun=1', { method: 'POST', body: JSON.stringify({ ids: OTHERS.map((t) => byTitle(t).id), action: 'apply', presetKey: 'premium' }) })).body
  if (prem.impact.repackage > 0) {
    ok(await p.locator(`${D} [data-policy-confirm]`).count() === 1 && await p.isDisabled(`${D} [data-bulk-policy-save]`), `${w}: DRM on ${prem.impact.repackage} published title: the box is shown and Save waits for it`)
    await p.check(`${D} [data-policy-confirm] input[type=checkbox]`)
    ok(!(await p.isDisabled(`${D} [data-bulk-policy-save]`)), `${w}: ticked, Save is back`)
    await p.waitForTimeout(400)   // the button's colour transition, for the picture
    await shot(p, `bulk-policy-${w}-confirm`)
  } else ok(false, `${w}: expected Premium to change DRM on a published title (${JSON.stringify(prem.impact)})`)
  await p.click(`${D} button:has-text("Cancel")`)

  // Clear: back to the rules (DRM was never applied, so nothing to package again).
  await p.click('.bulk-bar button:has-text("Publishing policy")')
  await p.waitForSelector(D)
  await p.check(`${D} [data-bulk-policy-action=clear]`)
  await settle(p)
  const clearLabel = await p.locator(`${D} [data-bulk-policy-save]`).innerText()
  ok(clearLabel === 'Clear 2 titles', `${w}: Clear names the two (${clearLabel})`)
  await p.click(`${D} [data-bulk-policy-save]`)
  await p.waitForSelector(D, { state: 'detached', timeout: 10000 })
  const after = await Promise.all(OTHERS.map((t) => override(byTitle(t).id)))
  ok(after.every((o) => !Object.keys(o).length), `${w}: cleared, both back on the rules (${JSON.stringify(after)})`)
  ok(!errs.length, `${w}: no page errors (${errs.join(' | ')})`)
  await ctx.close()
}
await b.close()
console.log(`\n${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
