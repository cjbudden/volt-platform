// ADD-ONS ON THE BILLING PAGES in a real browser (build queue B2-2): the
// account turns an add-on on, moves between packs and turns it off, each
// drawer saying what it costs before the change, and the API agrees after;
// the System Admin adds an add-on and a pack and sets one not offered. At
// 1440 and 390 px, with no sideways scroll and no page errors.
//
// Needs the API on the docs seed (it puts Archive storage on with the Small
// pack and 128.5 GB used) started with VOLT_BILLING=contract, and `npx vite`
// in volt-web. The System Admin's routes need the authenticator step-up,
// which a test cannot pass, so PLATFORM_TOKEN (a platform session minted for
// saas@volt.example) is put on the page's /api/platform requests; the real
// API answers them.
//   BASE=http://127.0.0.1:5173 PLATFORM_TOKEN=... PLAYWRIGHT=<playwright/index.mjs> \
//   CHROMIUM=<chromium binary, optional> SHOTS=<dir, optional> node volt-web/test/billing-addons.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')
const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const SHOTS = process.env.SHOTS || ''
const EMAIL = process.env.EMAIL || 'admin@example.com', PASSWORD = process.env.PASSWORD || 'volt1234'
let passes = 0, fails = 0
const ok = (c, m) => { if (c) { passes++; console.log('PASS ' + m) } else { fails++; console.log('FAIL ' + m) } }

const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json()
const api = async (path) => (await fetch(BASE + '/api' + path, { headers: { authorization: `Bearer ${login.access}` } })).json()
const addon = async (key) => (await api('/billing/addons')).addons.find((a) => a.key === key)

const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
async function signIn(w, email = EMAIL) {
  const ctx = await b.newContext({ viewport: { width: w, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'dark' })
  const p = await ctx.newPage()
  const errs = []; p.on('pageerror', (e) => errs.push(String(e.message)))
  await p.goto(BASE + '/')
  await p.fill('#signin-email', email); await p.fill('#signin-pw', PASSWORD)
  await p.click('button:has-text("Sign in")'); await p.waitForSelector('.topbar', { timeout: 20000 })
  const go = (u) => p.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')) }, u)
  return { p, ctx, errs, go }
}
const hscroll = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }) }
const card = (p, name) => p.locator(`.addon-card:has-text("${name}")`)
const drawerEffect = (p) => p.locator('.drawer .addon-effect').innerText()
const confirm = async (p, label) => { await p.click(`.drawer-f button.primary:has-text("${label}")`); await p.waitForSelector('.drawer', { state: 'detached', timeout: 10000 }); await p.waitForTimeout(500) }

// ---------------------------------------------------------------- the account, 1440 px
{
  const { p, errs, go, ctx } = await signIn(1440)
  await go('/billing')
  await p.waitForSelector('.addon-card', { timeout: 15000 })
  ok(await p.locator('.addon-card').count() === 2, '1440: two add-ons offered')
  const arch = card(p, 'Archive storage')
  const archText = (await arch.innerText()).replace(/\s+/g, ' ')
  ok(/\bon\b/i.test(archText) && /Small pack/.test(archText), `1440: Archive storage is on with the Small pack (${archText.slice(0, 80)})`)
  ok(archText.includes('128.5 of 200 GB used this month, 71.5 left') && /Starts again on 1 /.test(archText), '1440: its meter says used, included, left and when it starts again')
  ok(await arch.locator('.meter').count() === 1, '1440: with a meter')
  ok(await card(p, 'Extra transcode hours').locator('button:has-text("Turn on")').count() === 1, '1440: Extra transcode hours is off and offers Turn on')
  await shot(p, 'addons-1440')

  // Up to the Large pack: its full month is charged now.
  await arch.locator('button:has-text("Change pack")').click()
  await p.waitForSelector('.drawer .addon-opt')
  ok(await p.locator('.drawer .addon-opt').count() === 3, '1440: the pack drawer offers no pack, Small (current) and Large')
  ok(await p.isDisabled('.drawer-f button.primary'), '1440: Change pack waits until another pack is chosen')
  await p.click('.drawer .addon-opt:has-text("Large pack")')
  const upText = await drawerEffect(p)
  ok(upText.includes('$60.00 is charged now') && upText.includes('bigger allowance starts at once'), `1440: the drawer says the Large pack's full month is charged (${upText})`)
  await confirm(p, 'Change pack')
  let a = await addon('archive_storage')
  ok(a.pack === 'large' && a.allowance.included === 600, `1440: the API has the Large pack and 600 GB (${a.pack}, ${a.allowance.included})`)
  const month = (await api('/billing')).currentMonth
  ok(month.lines.some((l) => /Large pack/.test(l.description) && l.amountUsd === 60), '1440: the month so far carries the Large pack line')
  ok((await card(p, 'Archive storage').innerText()).includes('of 600 GB used'), '1440: the page shows the new allowance')

  // Down to Small: at once, no refund.
  await card(p, 'Archive storage').locator('button:has-text("Change pack")').click()
  await p.click('.drawer .addon-opt:has-text("Small pack")')
  const downText = await drawerEffect(p)
  ok(downText.includes('Nothing is refunded') && downText.includes('smaller allowance starts at once'), `1440: a smaller pack says no refund (${downText})`)
  await confirm(p, 'Change pack')
  a = await addon('archive_storage')
  ok(a.pack === 'small' && a.allowance.included === 200, '1440: the API has the Small pack again')
  const lines = (await api('/billing')).currentMonth.lines.filter((l) => l.source === 'addon_pack')
  ok(lines.length === 2 && !lines.some((l) => l.amountUsd < 0), `1440: no refund line (${lines.map((l) => l.amountUsd).join(', ')})`)

  // Back to Large in the same month: already paid.
  await card(p, 'Archive storage').locator('button:has-text("Change pack")').click()
  await p.click('.drawer .addon-opt:has-text("Large pack")')
  const againText = await drawerEffect(p)
  ok(againText.includes('already paid') && againText.includes('nothing more is charged'), `1440: a pack paid this month says nothing more is charged (${againText})`)
  await p.keyboard.press('Escape'); await p.waitForTimeout(300)
  ok(await p.locator('.drawer').count() === 0, '1440: Escape closes the drawer without changing anything')

  // Turn on, then off, Extra transcode hours.
  await card(p, 'Extra transcode hours').locator('button:has-text("Turn on")').click()
  const onText = await drawerEffect(p)
  ok(onText.includes('$30.00 is charged now') && onText.includes('From the 1st it is $30.00 a month'), `1440: turning on says the charge now and from the 1st (${onText})`)
  await p.click('.drawer .addon-opt:has-text("Plus pack")')
  ok((await drawerEffect(p)).includes('$75.00 is charged now'), '1440: with the Plus pack the charge now is the add-on and the pack')
  await p.click('.drawer .addon-opt:has-text("on its own")')
  await confirm(p, 'Turn on')
  ok((await addon('extra_transcode')).on === true, '1440: the API has it on')
  await card(p, 'Extra transcode hours').locator('button:has-text("Turn off")').click()
  const offText = (await p.locator('.drawer-b').innerText()).replace(/\s+/g, ' ')
  ok(/stops at once/.test(offText) && /Nothing is refunded/.test(offText), `1440: turning off says at once and no refund (${offText.slice(0, 90)})`)
  ok(await p.locator('.drawer-f button.primary.danger').count() === 1, '1440: Turn off is the danger button')
  await confirm(p, 'Turn off')
  ok((await addon('extra_transcode')).on === false, '1440: the API has it off')
  ok((await api('/billing')).currentMonth.lines.filter((l) => /Extra transcode/.test(l.description)).length === 1, '1440: its month stays charged once')
  ok(await hscroll(p) <= 0, '1440: no sideways scroll')
  ok(errs.length === 0, `1440: no page errors ${errs.join(' | ')}`)
  await ctx.close()
}

// ---------------------------------------------------------------- the account, 390 px
{
  const { p, errs, go, ctx } = await signIn(390)
  await go('/billing')
  await p.waitForSelector('.addon-card', { timeout: 15000 })
  ok(await hscroll(p) <= 0, `390: no sideways scroll on Billing (${await hscroll(p)})`)
  const btn = card(p, 'Archive storage').locator('button:has-text("Change pack")')
  const bw = (await btn.boundingBox())?.width ?? 0
  ok(bw > 120, `390: the add-on buttons share the width (${Math.round(bw)} px)`)
  await shot(p, 'addons-390')
  await btn.click(); await p.waitForSelector('.drawer .addon-effect')
  ok(await hscroll(p) <= 0, '390: no sideways scroll with the drawer open')
  await p.keyboard.press('Escape')
  ok(errs.length === 0, `390: no page errors ${errs.join(' | ')}`)
  await ctx.close()
}

// ---------------------------------------------------------------- the System Admin
const PT = process.env.PLATFORM_TOKEN
if (!PT) { console.log('FAIL PLATFORM_TOKEN not set: System Admin part not run'); fails++ }
else for (const w of [1440, 390]) {
  const { p, errs, go, ctx } = await signIn(w, 'saas@volt.example')
  await p.route('**/api/platform/**', (route) => route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${PT}` } }))
  await go('/system'); await p.waitForSelector('button[role=tab]:has-text("Billing")', { timeout: 15000 })
  await p.click('button[role=tab]:has-text("Billing")')
  await p.waitForSelector('tr:has-text("Archive storage")', { timeout: 15000 })
  if (w === 1440) {
    const row = (await p.locator('tr:has-text("Archive storage")').innerText()).replace(/\s+/g, ' ')
    ok(row.includes('$50.00') && row.includes('100 GB') && row.includes('Small pack: +100, $20.00') && row.includes('opens Mirror and Archive'), `SA: the catalogue row (${row})`)
    await p.click('button:has-text("Add an add-on")')
    await p.fill('#ad-k', 'live_captions'); await p.fill('#ad-n', 'Live captions'); await p.fill('#ad-p', '25'); await p.fill('#ad-q', '10'); await p.fill('#ad-u', 'hours')
    await confirm(p, 'Add add-on')
    await p.waitForSelector('tr:has-text("Live captions")', { timeout: 10000 })
    await p.locator('tr:has-text("Live captions") button:has-text("Pack")').click()
    await p.fill('#pk-k', 'more'); await p.fill('#pk-n', 'More hours'); await p.fill('#pk-x', '20'); await p.fill('#pk-p', '40')
    await confirm(p, 'Add pack')
    ok((await p.locator('tr:has-text("Live captions")').innerText()).includes('More hours: +20, $40.00'), 'SA: an add-on and its pack added from the page')
    await p.locator('tr:has-text("Extra transcode hours") button:has-text("Edit")').click()
    await p.locator('.drawer label.toggle-row:has-text("Offered to accounts") input').uncheck()
    await confirm(p, 'Save')
    ok((await p.locator('tr:has-text("Extra transcode hours")').innerText()).toLowerCase().includes('not offered'), 'SA: an add-on set not offered says so')
    const acc = (await api('/billing/addons')).addons.map((x) => x.key).sort().join(',')
    ok(acc === 'archive_storage,live_captions', `SA: the account now sees the new add-on and not the withdrawn one (${acc})`)
    const me = await api('/auth/me')
    await p.locator('tr', { hasText: me.account.name }).filter({ has: p.locator('button:has-text("Edit")') }).first().locator('button:has-text("Edit")').click()
    await p.waitForSelector('.drawer :text("Add-ons on")', { timeout: 10000 })
    ok(/Archive storage, Small pack: [\d.]+ of 200 GB used this month/.test(await p.locator('.drawer-b').innerText()), 'SA: an account\'s drawer lists its add-ons and their use')
    await p.keyboard.press('Escape')
    await shot(p, 'addons-sa-1440')
  }
  ok(await hscroll(p) <= 0, `SA ${w}: no sideways scroll`)
  ok(errs.length === 0, `SA ${w}: no page errors ${errs.join(' | ')}`)
  if (w === 390) await shot(p, 'addons-sa-390')
  await ctx.close()
}

await b.close()
console.log(`\n${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
