// SMALL CONSOLE FIXES FROM THE LIVE GUIDES, in a real browser (build queue 1.14-G1a).
//  (a) New event: with no transcode group the form starts on Packaging, the
//      Transcode card says so, and a type with no group says so under the cards
//      (it used to say so only after Create event failed).
//  (b) FAST: a browser in UTC sees UTC in the time zone list (it saw
//      Africa/Abidjan), and an empty run order is not described as a
//      one-minute pass (10 080 passes a week, "divides a day exactly").
//  (c) No real names in the New channel form or the Radio empty state: the
//      docs site's banned terms (scrub.json) are checked against their text,
//      input values and placeholders, as the screenshot script does.
// Group and station lists are narrowed in the browser (page.route), so the
// seeded database is not changed except for one FAST channel created in (b),
// which runs last: it takes the docs seed's last free channel on the plan.
//
// Needs the API on the docs seed (volt-app/scripts/seed-docs.ts) and
// `npx vite` in volt-web:
//   BASE=http://127.0.0.1:5173 PLAYWRIGHT=<path to playwright/index.mjs> \
//   CHROMIUM=<chromium binary, optional> SHOTS=<folder, optional> \
//   node volt-web/test/console-fixes.browser.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')
const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const SHOTS = process.env.SHOTS || ''
const here = dirname(fileURLToPath(import.meta.url))
const scrub = JSON.parse(readFileSync(join(here, '../../docs-site/scrub.json'), 'utf8'))
const banned = scrub.banned.map(b => ({ re: new RegExp(b.pattern, 'i'), why: b.why }))

let pass = 0, fail = 0
const ok = (c, m) => (c ? (pass++, console.log('PASS ' + m)) : (fail++, console.log('FAIL ' + m)))

const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})

async function session(timezoneId) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, timezoneId })
  const p = await ctx.newPage()
  await p.goto(BASE + '/')
  await p.fill('#signin-email', process.env.EMAIL || 'admin@example.com')
  await p.fill('#signin-pw', process.env.PASSWORD || 'volt1234')
  await p.click('button:has-text("Sign in")')
  await p.waitForSelector('.topbar', { timeout: 20000 })
  return { ctx, p }
}
const go = (p, u) => p.evaluate(u => { history.pushState(null, '', u); dispatchEvent(new PopStateEvent('popstate')) }, u)
// Only the account's group list, not /api/groups/<id>/...
const GROUPS = /\/api\/groups(\?.*)?$/
async function shapeGroups(p, shape) {
  await p.unroute(GROUPS).catch(() => {})
  await p.route(GROUPS, async route => {
    const res = await route.fetch()
    await route.fulfill({ response: res, json: shape(await res.json()) })
  })
}
const onlyGroups = (p, keep) => shapeGroups(p, all => all.filter(keep))
async function bannedIn(p, scope) {
  const text = await p.evaluate(sel => {
    const root = document.querySelector(sel) || document.body
    const bits = [root.innerText]
    for (const el of root.querySelectorAll('input, textarea')) bits.push(el.value || '', el.placeholder || '')
    root.querySelectorAll('[title],[aria-label],[data-tip]').forEach(el => bits.push(el.getAttribute('title') || '', el.getAttribute('aria-label') || '', el.getAttribute('data-tip') || ''))
    return bits.join('\n')
  }, scope)
  return banned.filter(x => x.re.test(text)).map(x => `${x.why} (${text.match(x.re)[0]})`)
}

// ---- (a) New event with no transcode group --------------------------------
{
  const { ctx, p } = await session('Australia/Sydney')
  await onlyGroups(p, g => g.workflow_type !== 'transcode')
  await go(p, '/events'); await p.waitForSelector('h1')
  await p.waitForTimeout(1500)
  await p.click('button:has-text("New event")')
  await p.waitForSelector('text=Workflow')
  const sel = await p.evaluate(() => [...document.querySelectorAll('.preset')].map(x => ({ sel: x.classList.contains('sel'), t: x.innerText })))
  const pk = sel.find(x => x.t.startsWith('Packaging')), tc = sel.find(x => x.t.startsWith('Transcode'))
  ok(!!pk?.sel && !tc?.sel, 'only a packaging group: the New event form starts on Packaging')
  ok(/no transcode group yet/.test(tc?.t || ''), 'the Transcode card says there is no transcode group')
  ok(!(await p.$('.group-missing')), 'no missing-group note while the chosen workflow has a group')
  await p.click('.preset:has-text("Transcode")')
  const note = await p.textContent('.group-missing').catch(() => '')
  ok(/no transcode group/i.test(note) && /create a packaging event now/i.test(note), `choosing Transcode says so under the cards, before Create event ("${(note || '').slice(0, 60)}...")`)
  if (SHOTS) await p.locator('.drawer').first().screenshot({ path: `${SHOTS}/event-new-no-transcode.png` }).catch(() => p.screenshot({ path: `${SHOTS}/event-new-no-transcode.png` }))
  await p.keyboard.press('Escape')
  // no groups at all: Transcode stays the start, with the note
  await onlyGroups(p, () => false)
  await go(p, '/dashboard'); await p.waitForTimeout(500)
  await go(p, '/events'); await p.waitForSelector('h1'); await p.waitForTimeout(1500)
  await p.click('button:has-text("New event")'); await p.waitForSelector('text=Workflow')
  const none = await p.textContent('.group-missing').catch(() => '')
  ok(/no transcode group/i.test(none) && !/create a packaging event now/i.test(none), 'no groups at all: the note says so and offers no other workflow')
  // both workflows have a group (the docs seed has packaging only, so a
  // transcode one is added to the list; nothing is submitted): unchanged,
  // Transcode first and no note
  await shapeGroups(p, all => {
    const pk = all.find(g => g.workflow_type === 'package_only') ?? all[0]
    return [...all.filter(g => g.workflow_type === 'package_only'), { ...pk, id: '00000000-0000-4000-8000-0000000000t1', name: 'Transcode group', workflow_type: 'transcode' }]
  })
  await go(p, '/dashboard'); await p.waitForTimeout(500)
  await go(p, '/events'); await p.waitForSelector('h1'); await p.waitForTimeout(1500)
  await p.click('button:has-text("New event")'); await p.waitForSelector('text=Workflow')
  const both = await p.evaluate(() => ({ tc: document.querySelector('.preset.sel')?.textContent || '', note: !!document.querySelector('.group-missing') }))
  ok(both.tc.startsWith('Transcode') && !both.note, 'both groups present: starts on Transcode, no note (as before)')
  await ctx.close()
}

// ---- (c) banned terms: New channel form and Radio empty state --------------
{
  const { ctx, p } = await session('Australia/Sydney')
  await go(p, '/channels'); await p.waitForSelector('h1'); await p.waitForTimeout(1200)
  await p.click("button:has-text('New channel')")
  await p.waitForSelector('.drawer')
  const ph = await p.getAttribute('.drawer .field:has(label:has-text("Channel name")) input', 'placeholder')
  const hits = await bannedIn(p, '.drawer')
  // The docs seed has a packaging group only. The form used to open on
  // Transcode when the page had not loaded its groups yet.
  const chStart = await p.evaluate(() => document.querySelector('.drawer .preset.sel')?.textContent || '')
  ok(chStart.startsWith('Packaging'), `New channel with only a packaging group starts on Packaging (${chStart.slice(0, 12)})`)
  ok(!!ph && !/RTM/.test(ph), `New channel name placeholder is a made-up name ("${ph}")`)
  ok(hits.length === 0, `New channel form: no banned terms${hits.length ? ' (' + hits.join('; ') + ')' : ''}`)
  if (SHOTS) await p.locator('.drawer').first().screenshot({ path: `${SHOTS}/channel-new.png` })
  await p.keyboard.press('Escape')
  await p.route(/\/api\/radio(\?.*)?$/, route => route.fulfill({ json: [] }))
  await go(p, '/dashboard'); await p.waitForTimeout(400)
  await go(p, '/radio'); await p.waitForSelector('text=No stations yet', { timeout: 15000 })
  const hits2 = await bannedIn(p, '.empty')
  const emptyText = await p.textContent('.empty')
  ok(hits2.length === 0, `Radio empty state: no banned terms${hits2.length ? ' (' + hits2.join('; ') + ')' : ''}`)
  ok(!/soma/i.test(emptyText), 'Radio empty state names no sample stations')
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/radio-empty.png` })
  await p.click('button:has-text("Create your first station")')
  await p.waitForSelector('.drawer')
  const hits3 = await bannedIn(p, '.drawer')
  ok(hits3.length === 0 && !/groove salad/i.test(await p.evaluate(() => [...document.querySelectorAll('input')].map(i => i.placeholder).join(' '))), `New station form: no banned terms or sample station names${hits3.length ? ' (' + hits3.join('; ') + ')' : ''}`)
  await ctx.close()
}

// ---- (a2) New channel opened before the page has its groups --------------
{
  const { ctx, p } = await session('Australia/Sydney')
  // Slow the group list down so the form is open before it arrives.
  await p.route(GROUPS, async route => { await new Promise(r => setTimeout(r, 1500)); await route.continue() })
  await go(p, '/channels'); await p.waitForSelector('h1')
  await p.click("button:has-text('New channel')"); await p.waitForSelector('.drawer')
  await p.waitForTimeout(3000)
  const st = await p.evaluate(() => document.querySelector('.drawer .preset.sel')?.textContent || '(no form)')
  ok(st.startsWith('Packaging'), `New channel opened before the groups load still lands on Packaging once they do (${st.slice(0, 12)})`)
  await ctx.close()
}

// ---- (b) FAST in a UTC browser, and an empty run order ---------------------
{
  const { ctx, p } = await session('UTC')
  await go(p, '/fast'); await p.waitForSelector('h1'); await p.waitForTimeout(1000)
  await p.click("button:has-text('New FAST channel')")
  await p.waitForSelector('#fz')
  const z = await p.evaluate(() => { const s = document.querySelector('#fz'); return { value: s.value, shown: s.options[s.selectedIndex]?.text, first: s.options[0]?.text } })
  ok(z.value === 'UTC' && z.shown === 'UTC', `a UTC browser sees UTC selected (value ${z.value}, shown ${z.shown})`)
  ok(z.first === 'UTC', 'UTC is first in the list')
  await p.fill('#fn', 'Clock Check ' + Date.now().toString(36))
  await p.click("[role=dialog] button.primary")
  await p.waitForSelector('#fz2', { timeout: 20000 })
  await p.waitForSelector('[data-empty-run-order]', { timeout: 10000 }).catch(() => {})
  const page = await p.evaluate(() => ({ empty: !!document.querySelector('[data-empty-run-order]'), text: document.body.innerText, z2: document.querySelector('#fz2').value }))
  ok(page.z2 === 'UTC', `the saved zone shows on the Channel clock (${page.z2})`)
  ok(page.empty, 'an empty run order asks for titles instead of describing a pass')
  ok(!/10[\s,. ]?080/.test(page.text) && !/divides a day/i.test(page.text), 'no 10 080 passes and no "divides a day exactly"')
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/fast-empty-utc.png`, fullPage: true })
  await ctx.close()
}

await b.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
