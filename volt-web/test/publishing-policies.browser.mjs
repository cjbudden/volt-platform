// PUBLISHING POLICIES in a real browser (build queue P3-2): the rule editor's
// five sections, padlocks, presets, conflicts, the impact preview and the
// repackage confirmation, on the Publishing Rules page.
//
// Needs the API on the docs seed plus volt-web/test/publishing-policies.seed.ts
// (a Documentary type with four titles, two published), and `npx vite` in
// volt-web. What the page shows is compared with what the API says.
//   BASE=http://127.0.0.1:5173 PLAYWRIGHT=<path to playwright/index.mjs> \
//   CHROMIUM=<chromium binary, optional> SHOTS=<dir, optional> node volt-web/test/publishing-policies.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')
const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const SHOTS = process.env.SHOTS || ''
const EMAIL = process.env.EMAIL || 'admin@example.com', PASSWORD = process.env.PASSWORD || 'volt1234'
let passes = 0, fails = 0
const ok = (c, m) => { if (c) { passes++; console.log('PASS ' + m) } else { fails++; console.log('FAIL ' + m) } }

// The API, for what the page should agree with and to set the ladder up.
const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json()
const api = async (path, opts = {}) => {
  const r = await fetch(BASE + '/api' + path, { ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${login.access}` } })
  return { status: r.status, body: r.status === 204 ? null : await r.json() }
}
const types = (await api('/metadata-schemas')).body
const doc = (Array.isArray(types) ? types : types.items ?? []).find((t) => t.name === 'Documentary')
if (!doc) { console.log('run publishing-policies.seed.ts first'); process.exit(2) }

const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
async function signIn(w) {
  const ctx = await b.newContext({ viewport: { width: w, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'dark' })
  const p = await ctx.newPage()
  const errs = []; p.on('pageerror', (e) => errs.push(String(e.message)))
  await p.goto(BASE + '/')
  await p.fill('#signin-email', EMAIL); await p.fill('#signin-pw', PASSWORD)
  await p.click('button:has-text("Sign in")'); await p.waitForSelector('.topbar', { timeout: 20000 })
  const go = (u) => p.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')) }, u)
  return { p, ctx, errs, go }
}
const hscroll = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
const settle = (p, ed) => p.waitForFunction((ed) => {
  const c = document.querySelector(`${ed} [data-policy-check]`); return !!c && !c.textContent.includes('checking')
}, ed, { timeout: 10000 }).then(() => p.waitForTimeout(150))
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }) }

// ---------------------------------------------------------------- 1440 px
{
  const { p, errs, go } = await signIn(1440)
  await go('/publishing')
  const A = '[data-rule-editor=account]'
  await p.waitForSelector(`${A} [data-policy-section]`, { timeout: 15000 })
  const secs = await p.$$eval(`${A} [data-policy-section]`, (s) => s.map((x) => x.getAttribute('data-policy-section')))
  ok(JSON.stringify(secs) === JSON.stringify(['lifecycle', 'access', 'protection', 'distribution', 'retention']), `1440: the account default in five sections (${secs.join(', ')})`)
  ok(await p.locator(`${A} [data-policy-field="protection.drm"]`).count() === 1 && await p.locator(`${A} [data-policy-field="retention.days"]`).count() === 1, '1440: the section fields have rows (DRM, retention days)')
  await settle(p, A)
  const impactText = await p.locator(`${A} [data-impact]`).innerText()
  const dry = (await api('/publishing-rules/account?dryRun=1', { method: 'PUT', body: JSON.stringify({ settings: (await api('/publishing-rules/account')).body.settings, lockedFields: [], presetKey: null }) })).body
  ok(impactText.includes(`Governs ${dry.impact.assets} title`) && impactText.includes(`${dry.impact.published} published`), `1440: the impact shows the API's numbers (${impactText.replace(/\s+/g, ' ')}; API ${dry.impact.assets}/${dry.impact.published})`)

  // Lock DRM on the account default and save.
  await p.click(`${A} [data-lock="protection.drm"]`)
  ok(await p.getAttribute(`${A} [data-lock="protection.drm"]`, 'aria-pressed') === 'true', '1440: the padlock locks DRM on the account default')
  await settle(p, A)
  await p.click(`${A} button:has-text("Save publishing rule")`)
  await p.waitForSelector(`${A} :text("Saved.")`, { timeout: 10000 })
  const acct = (await api('/publishing-rules/account')).body
  ok(JSON.stringify(acct.locked_fields) === '["protection.drm"]', `1440: saved with the lock (${JSON.stringify(acct.locked_fields)})`)

  // The type's rule: DRM shows the account's lock and cannot be set.
  await p.selectOption('select[aria-label="Content type to set a rule for"]', doc.id)
  await p.click('button:has-text("Set a rule for this type")')
  const T = '[data-rule-editor=schema]'
  await p.waitForSelector(`${T} [data-policy-section]`, { timeout: 15000 })
  ok(await p.getAttribute(`${T} [data-policy-field="protection.drm"]`, 'data-locked-by') === 'account', '1440: on the type, DRM is locked by the account default')
  ok(await p.locator(`${T} [data-policy-field="protection.drm"] :text("Locked by the account default")`).count() === 1, '1440: the type row says who locked it')
  ok(await p.isDisabled(`${T} [data-policy-field="protection.drm"] input[type=checkbox]`) && await p.isDisabled(`${T} [data-lock="protection.drm"]`), '1440: its switch and padlock cannot be used')

  // A preset that sets a locked field: the save is blocked, naming the lock.
  await p.selectOption(`${T} select[aria-label="Start from a preset"]`, 'premium')
  ok(await p.locator(`${T} [data-preset=premium]`).count() === 1, '1440: Premium applied and named')
  ok(await p.isChecked(`${T} [data-policy-field="distribution.mp4Download"] input[type=checkbox] >> nth=0`), '1440: the preset set MP4 download here')
  await settle(p, T)
  const block = await p.locator(`${T} [data-policy-conflict=block]`).allInnerTexts()
  ok(block.some((t) => /DRM is locked by the account default/.test(t)), `1440: the locked DRM blocks the save (${block.join(' | ')})`)
  ok(await p.isDisabled(`${T} button:has-text("Save publishing rule")`), '1440: Save is disabled while it is blocked')
  ok(await p.getAttribute(`${T} [data-policy-field="protection.drm"]`, 'data-flag') === 'block', '1440: the DRM row is marked')
  await shot(p, 'pp-1440-blocked')
  await p.click(`${T} [data-policy-field="protection.drm"] button:has-text("Clear it")`)
  await settle(p, T)
  ok(await p.locator(`${T} [data-policy-conflict=block]`).count() === 0 && !(await p.isDisabled(`${T} button:has-text("Save publishing rule")`)), '1440: cleared, nothing blocks and Save is back')

  // Geo to one country without a WAF profile: a warning, saved.
  await p.check(`${T} [data-policy-field="geo"] input[type=checkbox]`)
  await p.selectOption(`${T} [data-policy-field="geo"] select`, 'allow')
  await p.fill(`${T} [data-policy-field="geo"] input.inp`, 'AU')
  await p.click(`${T} [data-lock="distribution.mp4Download"]`)
  await settle(p, T)
  const warn = await p.locator(`${T} [data-policy-conflict=warn]`).allInnerTexts()
  ok(warn.some((t) => /without a WAF profile/.test(t)), `1440: the geo without WAF warning shows (${warn.length})`)
  ok(await p.getAttribute(`${T} [data-policy-field="protection.waf"]`, 'data-flag') === 'warn', '1440: the WAF row is marked as a warning')
  const tImpact = await p.locator(`${T} [data-impact]`).innerText()
  ok(/Governs 4 titles/.test(tImpact) && /2 published/.test(tImpact) && /Saving changes 4/.test(tImpact), `1440: the type's impact: ${tImpact.replace(/\s+/g, ' ')}`)
  await shot(p, 'pp-1440-warn')
  await p.click(`${T} button:has-text("Save publishing rule")`)
  await p.waitForSelector(`${T} :text("Saved, with 1 warning.")`, { timeout: 10000 })
  const tr = (await api(`/publishing-rules/schema/${doc.id}`)).body
  ok(tr.preset_key === 'premium' && tr.settings.access === 'paid' && tr.settings.geo?.countries?.[0] === 'AU' && tr.settings.protection?.drm === undefined
    && JSON.stringify(tr.locked_fields) === '["distribution.mp4Download"]', `1440: the type saved as shown (preset ${tr.preset_key}, locks ${JSON.stringify(tr.locked_fields)})`)
  await p.waitForSelector('[data-rule-row="Documentary"]', { timeout: 10000 })
  const rowText = await p.locator('[data-rule-row="Documentary"]').innerText()
  ok(/1 locked/.test(rowText) && /from Premium/.test(rowText) && /Geo access/.test(rowText), `1440: the type's row in the list: ${rowText.replace(/\s+/g, ' ')}`)

  // DRM on the account default, published titles: confirm before packaging again.
  await p.click(`${A} [data-policy-field="distribution.mp4Download"] input[type=checkbox]`)
  await p.click(`${A} [data-policy-field="protection.drm"] input[type=checkbox]`)
  await settle(p, A)
  const aImpact = await p.locator(`${A} [data-impact]`).innerText()
  const accNow = (await api('/publishing-rules/account')).body
  const dry2 = (await api('/publishing-rules/account?dryRun=1', { method: 'PUT', body: JSON.stringify({ settings: { ...accNow.settings, protection: { drm: true }, distribution: { mp4Download: false } }, lockedFields: ['protection.drm'], presetKey: null }) })).body
  ok(dry2.impact.repackage > 0 && aImpact.includes(`${dry2.impact.repackage} published title`), `1440: the impact names ${dry2.impact.repackage} titles to package again (${aImpact.replace(/\s+/g, ' ')})`)
  await p.click(`${A} button:has-text("Save publishing rule")`)
  await p.waitForSelector(`${A} [data-policy-confirm]`, { timeout: 10000 })
  const conf = await p.locator(`${A} [data-policy-confirm]`).innerText()
  ok(conf.includes(`${dry2.impact.repackage} published title`) && /packaged again/.test(conf), `1440: the confirmation says how many (${conf.split('\n')[0]})`)
  ok((await api('/publishing-rules/account')).body.settings.protection?.drm !== true, '1440: nothing saved before the confirmation')
  await shot(p, 'pp-1440-confirm')
  await p.click(`${A} button:has-text("Package again and save")`)
  await p.waitForSelector(`${A} :text("Saved.")`, { timeout: 10000 })
  ok((await api('/publishing-rules/account')).body.settings.protection?.drm === true, '1440: confirmed, DRM saved on the account default')
  ok(await hscroll(p) <= 0, `1440: no horizontal page scroll (${await hscroll(p)})`)
  ok(!errs.length, `1440: no page errors (${errs.join('; ')})`)
}

// ---------------------------------------------------------------- 390 px
{
  const { p, errs, go } = await signIn(390)
  await go('/publishing')
  const A = '[data-rule-editor=account]'
  await p.waitForSelector(`${A} [data-policy-section]`, { timeout: 15000 })
  ok(await hscroll(p) <= 0, `390: no horizontal page scroll on Publishing Rules (${await hscroll(p)})`)
  const lock = await p.locator(`${A} [data-lock="protection.drm"]`).boundingBox()
  ok(lock && lock.x + lock.width <= 390, `390: the padlocks are on screen (x ${Math.round(lock?.x ?? -1)})`)
  await p.click('[data-rule-row="Documentary"]')
  const T = '[data-rule-editor=schema]'
  await p.waitForSelector(`${T} [data-policy-section]`, { timeout: 15000 })
  await settle(p, T)
  ok(await hscroll(p) <= 0, `390: no horizontal page scroll with the type's rule open (${await hscroll(p)})`)
  const geo = await p.locator(`${T} [data-policy-field="geo"] .pol-val`).boundingBox()
  ok(geo && geo.x + geo.width <= 390, '390: a value drops under its name and fits')
  await shot(p, 'pp-390')
  ok(!errs.length, `390: no page errors (${errs.join('; ')})`)
}
await b.close()
console.log(`\n${passes}/${passes + fails} passed`)
process.exit(fails ? 1 : 0)
