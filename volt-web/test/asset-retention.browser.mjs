// RETENTION ON THE ASSET DRAWER in a real browser (build queue P5-3 (b)): the
// Availability tab shows when the title's publishing policy deletes it, its
// legal hold with the reason, and an archived title's media storage. A legal
// hold needs a reason (Hold stays off until one is typed), is set and released
// through the drawer; restoring a title from Archive storage says the wait
// first and only Start restore begins it (then Restoring, expected by);
// Infrequent access restores at once. At 1440 and 390 px with no sideways scroll
// (the 390 pass sees what the 1440 pass changed). Seed fresh before each run.
//
// Needs the API on a database with three titles in the AdminCo account (ids
// 11111111-0000-4000-8000-00000000000{1,2,3}: archived in Archive storage on
// legal hold, due in 5 days, archived in Infrequent access), and `npx vite`.
//   BASE=http://127.0.0.1:5173 PLAYWRIGHT=<playwright> CHROMIUM=<binary> SHOTS=<dir> node volt-web/test/asset-retention.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')
const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const SHOTS = process.env.SHOTS || ''
const EMAIL = process.env.EMAIL || 'root@adminco.example', PASSWORD = process.env.PASSWORD || 'volt1234'
let passes = 0, fails = 0
const ok = (c, m) => { if (c) { passes++; console.log('PASS ' + m) } else { fails++; console.log('FAIL ' + m) } }
const GL = '11111111-0000-4000-8000-000000000001', DUE = '11111111-0000-4000-8000-000000000002', IA = '11111111-0000-4000-8000-000000000003'
const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json()
const api = async (path, opts = {}) => {
  const r = await fetch(BASE + '/api' + path, { ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${login.access}` } })
  return { status: r.status, body: r.status === 204 ? null : await r.json() }
}

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
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false }) }
async function open(p, go, id) {
  await go(`/vod?asset=${id}`)
  await p.waitForSelector('button:has-text("Availability")', { timeout: 20000 })
  await p.locator('button:has-text("Availability")').first().click()
  await p.waitForSelector('[data-retention]', { timeout: 10000 })
  await p.locator('[data-retention]').scrollIntoViewIfNeeded()
}

for (const w of [1440, 390]) {
  const { p, errs, go, ctx } = await signIn(w)
  // Archive storage, on legal hold.
  await open(p, go, GL)
  const ret = await p.locator('[data-retention]').innerText()
  ok(/Archive storage since/.test(ret), `${w}: an archived title says its media is in Archive storage (${ret.replace(/\s+/g, ' ').slice(0, 160)})`)
  if (w === 1440) {
    ok(/On hold since .*Case 2026-114, keep until settled/.test(ret), `${w}: the legal hold with its reason`)
    ok(/A restore from Archive storage takes about 5 hours/.test(ret), `${w}: the restore wait is said before anything is clicked`)
    ok(await p.locator('button:has-text("Release legal hold")').count() === 1, `${w}: Release legal hold is offered`)
  } else {
    // After the 1440 pass: its hold released and its restore started.
    ok(/Legal hold\s*None/.test(ret) && /Restoring from Archive storage, expected by/.test(ret), `${w}: the restore under way is shown, the hold is gone`)
    ok(await p.locator('button:has-text("Legal hold…")').count() === 1 && await p.locator('button:has-text("Restore as draft")').count() === 0, `${w}: Legal hold offered again, no Restore while restoring`)
  }
  await shot(p, `drawer-archive-storage-${w}`)
  ok(await hscroll(p) <= 0, `${w}: no sideways scroll (${await hscroll(p)})`)
  if (w === 1440) {
    // Restore from Archive storage: the wait first.
    await p.click('button:has-text("Restore as draft…")')
    const wait = await p.locator('[data-restore-wait]').innerText()
    ok(/takes about 5 hours, expected by/.test(wait) && /becomes a draft when the media is back/.test(wait), `1440: Restore says the wait and when, before it starts (${wait.replace(/\s+/g, ' ')})`)
    ok((await api(`/vod/${GL}`)).body.archive_tier_state === 'moved', '1440: nothing requested yet')
    await shot(p, 'drawer-restore-wait-1440')
    await p.click('button:has-text("Start restore")')
    await p.waitForSelector('text=Restoring from Archive storage, expected by', { timeout: 10000 })
    const g = (await api(`/vod/${GL}`)).body
    ok(g.archive_tier_state === 'restoring' && g.archive_restore_to === 'draft' && g.editorial_state === 'archived', `1440: Start restore asks for it and the title stays archived (${g.archive_tier_state}, ${g.editorial_state})`)
    ok(await p.locator('button:has-text("Restore as draft")').count() === 0, '1440: no Restore buttons while it is restoring')
    await shot(p, 'drawer-restoring-1440')
    // Release the hold through the drawer.
    await p.click('button:has-text("Release legal hold")')
    await p.waitForSelector('button:has-text("Legal hold…")', { timeout: 10000 })
    ok(!(await api(`/vod/${GL}`)).body.legal_hold_at, '1440: Release legal hold clears it')
  }
  // Due in 5 days, no hold: put one on with a reason.
  await open(p, go, DUE)
  const ret2 = await p.locator('[data-retention-due]').innerText()
  ok(!/Not set/.test(ret2) && ret2.length > 4, `${w}: the date its policy deletes it (${ret2})`)
  ok(await p.locator('[data-archive-storage]').count() === 0, `${w}: no media storage line for a title that is not archived`)
  if (w === 1440) {
    await p.click('button:has-text("Legal hold…")')
    ok(await p.isDisabled('button:has-text("Hold")'), '1440: Hold is off until a reason is typed')
    await p.fill('input[placeholder="Such as a case number"]', 'Audit 77')
    await p.click('button:text-is("Hold")')
    await p.waitForSelector('text=On hold since', { timeout: 10000 })
    const r = (await api(`/vod/${DUE}`)).body
    ok(!!r.legal_hold_at && r.legal_hold_reason === 'Audit 77', `1440: the hold is stored with its reason (${r.legal_hold_reason})`)
    await shot(p, 'drawer-legal-hold-1440')
  } else {
    await p.locator('[data-retention]').scrollIntoViewIfNeeded()
    await shot(p, 'drawer-legal-hold-390')
    ok(await hscroll(p) <= 0, `390: no sideways scroll on the held title (${await hscroll(p)})`)
  }
  // Infrequent access: restored at once.
  await open(p, go, IA)
  if (w === 1440) {
    ok(/Infrequent access since/.test(await p.locator('[data-retention]').innerText()), `${w}: Infrequent access is named`)
    await p.click('button:text-is("Restore as draft")')
    await p.waitForSelector('text=Restored as a draft.', { timeout: 10000 })
    const r = (await api(`/vod/${IA}`)).body
    ok(r.editorial_state === 'draft', `1440: Infrequent access restores at once, no wait asked (${r.editorial_state})`)
  } else {
    ok(await p.locator('[data-archive-storage]').count() === 0, `${w}: restored at 1440, so no media storage line now`)
  }
  ok(errs.length === 0, `${w}: no page errors (${errs.join(' | ')})`)
  await ctx.close()
}
await b.close()
console.log(`\n${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
