// THE 1.14-G2a EPG FIXES in a real browser: a programme's Replacement for this
// period picks a slate or loop from Loops & Fillers (the loop seeded there can
// be chosen, and is saved as that asset); an older slot that names an Image
// Library address shows it as such; Cancel while an overlap warning is held
// still reloads the guide, so the new programme is listed; Escape closes the
// Copy or repeat day dialog and the Loops & Fillers picker (and only the
// picker, not the drawer under it).
// Needs the API on a database seeded by seed-demo.ts and epg-fixes.seed.ts,
// `npx vite`, and the browser in UTC.
//   BASE=http://127.0.0.1:5173 CHANNEL_ID=... LOOP_ID=... PLAYWRIGHT=... CHROMIUM=... SHOTS=<dir> node volt-web/test/epg-fixes.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')
const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const SHOTS = process.env.SHOTS || ''
const CH = process.env.CHANNEL_ID, LOOP = process.env.LOOP_ID
if (!CH || !LOOP) { console.log('set CHANNEL_ID and LOOP_ID (printed by epg-fixes.seed.ts)'); process.exit(2) }
const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
let passes = 0, fails = 0
const check = (m, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { passes++; console.log('PASS ' + m) } else { fails++; console.log(`FAIL ${m} -- expected ${w} got ${g}`) } }
const go = (p, path) => p.evaluate((u) => { history.pushState(null, '', u); dispatchEvent(new PopStateEvent('popstate')) }, path)

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'UTC' })
const p = await ctx.newPage()
const errors = []
p.on('pageerror', (e) => errors.push(String(e)))
await p.goto(BASE + '/')
await p.waitForSelector('#signin-email')
await p.click('button:has-text("Sign in")')
await p.waitForSelector('.topbar', { timeout: 20000 })
await go(p, '/epg/channel/' + CH)
await p.waitForSelector('tr[data-prog]', { timeout: 20000 })
const rows = () => p.locator('tr[data-prog]').count()
check('guide opens with the two seeded programmes', await rows(), 2)

// ---- Escape closes Copy or repeat day
await p.click('button:has-text("Copy or repeat day")')
await p.waitForSelector('.rp-modal', { timeout: 5000 })
await p.keyboard.press('Escape')
await p.waitForTimeout(300)
check('Escape closes Copy or repeat day', await p.locator('.rp-modal').count(), 0)

// ---- an older slot keeps its Image Library address, shown as such
await p.click('tr[data-prog]:has-text("Old slate slot")')
await p.waitForSelector('.drawer .ff-legacy', { timeout: 5000 })
check('older slot: its Image Library slate is shown as not in Loops & Fillers, with the copy offered',
  [/Image Library image/.test(await p.textContent('.drawer .ff-legacy')), await p.locator('.drawer .ff-legacy button:has-text("Copy into Loops & Fillers")').count()], [true, 1])
if (SHOTS) await p.locator('.drawer .ff-legacy').screenshot({ path: `${SHOTS}/epg-replacement-legacy.png` })
await p.click('.drawer button:has-text("Cancel")')
await p.waitForTimeout(300)

// ---- a new programme with a loop from Loops & Fillers, overlapping, then Cancel during the warning
await p.click('button:has-text("Add programme")')
await p.waitForSelector('.drawer', { timeout: 5000 })
await p.fill('.drawer input[placeholder="e.g. Berita Utama"]', 'Late morning extra')
const times = p.locator('.drawer input[placeholder="HH:MM"]')
await times.nth(0).fill('10:30')
await times.nth(1).fill('11:30')
await p.locator('.drawer select').filter({ has: p.locator('option[value="loop"]') }).selectOption('loop')
await p.waitForSelector('.drawer button:has-text("Choose from Loops & Fillers")', { timeout: 5000 })
check('Loop video replacement offers the Loops & Fillers picker, no free-text address', await p.locator('.drawer input[placeholder="Pick from library or paste a URL"]').count(), 0)
await p.click('.drawer button:has-text("Choose from Loops & Fillers")')
await p.waitForSelector('.ff-picker', { timeout: 5000 })
await p.waitForSelector('.ff-picker .ff-card', { timeout: 5000 })
check('the picker lists the loop uploaded in Loops & Fillers', /Ocean loop/.test(await p.textContent('.ff-picker')), true)
await p.keyboard.press('Escape')
await p.waitForTimeout(300)
check('Escape closes the picker and leaves the programme drawer open', [await p.locator('.ff-picker').count(), await p.locator('.drawer').count()], [0, 1])
await p.click('.drawer button:has-text("Choose from Loops & Fillers")')
await p.waitForSelector('.ff-picker .ff-card', { timeout: 5000 })
await p.click('.ff-picker .ff-card:has-text("Ocean loop")')
await p.waitForSelector('.drawer .ff-name:has-text("Ocean loop")', { timeout: 5000 })
check('the chosen loop shows in the field', /Loop in Loops & Fillers/.test(await p.textContent('.drawer .ff-row')), true)
if (SHOTS) await p.locator('.drawer .ff-row').first().screenshot({ path: `${SHOTS}/epg-replacement-loop.png` })
await p.click('.drawer button:has-text("Add programme")')
// the form status may sit in a portal, so look at the whole page
await p.waitForFunction(() => /It overlaps "Morning show"/.test(document.body.textContent ?? ''), null, { timeout: 8000 })
if (SHOTS) await p.screenshot({ path: `${SHOTS}/epg-overlap-warning.png` })
await p.click('.drawer button:has-text("Cancel")')
await p.waitForTimeout(1200)   // well inside the 3.3 s hold
check('Cancel during the overlap warning: drawer closed and the new programme listed without a reload',
  [await p.locator('.drawer').count(), await rows(), await p.locator('tr[data-prog]:has(b:text-is("Late morning extra"))').count()], [0, 3, 1])
if (SHOTS) await p.screenshot({ path: `${SHOTS}/epg-guide-after-cancel.png` })

// ---- what was stored: reopened, the slot names the same Loops & Fillers loop
// (the field resolves an asset id; an address would show as "not in Loops & Fillers")
await p.click('tr[data-prog]:has(b:text-is("Late morning extra"))')
await p.waitForSelector('.drawer .ff-row', { timeout: 5000 })
check('reopened: the slot still names Ocean loop from Loops & Fillers',
  [await p.locator('.drawer .ff-name:has-text("Ocean loop")').count(), await p.locator('.drawer .ff-legacy').count()], [1, 0])
await p.click('.drawer button:has-text("Cancel")')

check('no page errors', errors, [])
await b.close()
console.log(`\n${passes}/${passes + fails} passed`)
process.exit(fails ? 1 : 0)
