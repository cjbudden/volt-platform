// FIND DETAILS in a real browser (build queue F1): on the Metadata tab, a
// Movie opens the general finder (Wikidata), a Song and a Music video the
// song finder. The search starts from the title; the film comes first; empty
// fields are ticked and filled ones not; Apply writes only the ticked fields
// and the form shows them; a Music video is not offered the Song type and its
// cover is not ticked. At 1440 and 390 px.
//
// Needs the API on the docs seed (it has Nosferatu, a Song and a Music video),
// started with WIKIDATA_API_BASE and MUSICBRAINZ_BASE at stand-ins (or the real
// services), and `npx vite` in volt-web.
//   BASE=http://127.0.0.1:5173 PLAYWRIGHT=<path to playwright/index.mjs> \
//   CHROMIUM=<chromium binary, optional> SHOTS=<dir, optional> node volt-web/test/find-details.browser.mjs
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
const FILM = '6b1f0d2e-7a3c-4e5f-9a1b-2c3d4e5f6b01', SONG = '6b1f0d2e-7a3c-4e5f-9a1b-2c3d4e5f6b02', MV = '6b1f0d2e-7a3c-4e5f-9a1b-2c3d4e5f6b03'
const reset = async () => {
  const r = await api(`/vod/${FILM}`, { method: 'PUT', body: JSON.stringify({ metadata: { title: 'Nosferatu', rating: 'PG' } }) })
  if (r.status !== 200) throw new Error(`reset: ${r.status} ${JSON.stringify(r.body)}`)
}

const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
async function signIn(w) {
  const ctx = await b.newContext({ viewport: { width: w, height: w < 600 ? 844 : 1000 }, deviceScaleFactor: 1, colorScheme: 'dark' })
  const p = await ctx.newPage()
  const errs = []; p.on('pageerror', (e) => errs.push(String(e.message)))
  await p.goto(BASE + '/')
  await p.fill('#signin-email', EMAIL); await p.fill('#signin-pw', PASSWORD)
  await p.click('button:has-text("Sign in")'); await p.waitForSelector('.topbar', { timeout: 20000 })
  const go = (u) => p.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')) }, u)
  return { p, ctx, errs, go }
}
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false }) }
const openAsset = async (p, go, title) => {
  await go('/vod'); await p.waitForSelector('h1')
  await p.locator(`tr:has-text("${title}") button:has-text("Open")`).first().click()
  await p.locator('button:text-is("Metadata")').first().click()
  await p.waitForSelector('.asset-find button:has-text("Find details")')
}
const hscroll = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

for (const w of [1440, 390]) {
  await reset()
  const { p, errs, go } = await signIn(w)
  // ---- a Movie: the general finder
  await openAsset(p, go, 'Nosferatu')
  await p.click('.asset-find button:has-text("Find details")')
  await p.waitForSelector('.songf[aria-label="Find details"]')
  ok(await p.inputValue('.songf[aria-label="Find details"] .songf-q input') === 'Nosferatu', `${w}: Movie: the general finder, the search starts with the title`)
  await p.click('.songf-q button:has-text("Search")')
  await p.waitForSelector('.songf-r')
  const cards = await p.$$eval('.songf-r .songf-rb', (xs) => xs.map((x) => x.textContent))
  ok(cards.length === 3 && /1922 film by F\. W\. Murnau/.test(cards[0]) && /fictional vampire/.test(cards[2]), `${w}: the films first, the character last (${cards.map((c) => c.slice(0, 40)).join(' | ')})`)
  await p.locator('.songf-r').first().click()
  await p.waitForSelector('.songf-review')
  const rows = await p.$$eval('.songf-review tbody tr', (rs) => rs.map((r) => ({ label: r.children[1]?.textContent, same: r.classList.contains('same'), ticked: !!r.querySelector('input[type=checkbox]:checked') })))
  const by = (l) => rows.find((r) => r.label === l)
  ok(by('Title')?.same && by('Director')?.ticked && by('Cast')?.ticked && by('Year')?.ticked && by('Language')?.ticked, `${w}: the same title shown as =, empty fields ticked (${rows.map((r) => `${r.label}${r.same ? '=' : r.ticked ? '+' : ''}`).join(', ')})`)
  ok((await p.locator('.songf-review').innerText()).includes('Not filled from Wikidata: Content rating'), `${w}: the fields Wikidata cannot fill are named`)
  if (w === 1440) await shot(p, 'find-details-review-1440')
  // Untick Cast, correct the director, apply.
  await p.locator('.songf-review input[aria-label="Use Cast"]').uncheck()
  await p.fill('.songf-review input[aria-label="Director found"]', 'F.W. Murnau')
  const applyText = await p.locator('.songf-act button').innerText()
  await p.click('.songf-act button')
  await p.waitForSelector('.songf[aria-label="Find details"]', { state: 'detached', timeout: 10000 })
  const a = (await api(`/vod/${FILM}`)).body
  const m = a.metadata ?? {}
  ok(m.director === 'F.W. Murnau' && m.year === 1922 && m.language === 'German' && m.cast === undefined && m.rating === 'PG' && a.metadata_provenance?.director?.source === 'wikidata',
    `${w}: ${applyText}: the ticked fields saved with provenance, the corrected director kept, Cast and the rating untouched (${JSON.stringify(m)})`)
  await p.waitForTimeout(800)
  ok((await p.locator('input[value="F.W. Murnau"]').count()) >= 1 || (await p.locator('.drawer').innerText()).includes('F.W. Murnau'), `${w}: the form shows the applied value`)
  ok(await hscroll(p) <= 0, `${w}: no sideways scroll`)
  if (w === 390) await shot(p, 'find-details-390')

  // ---- a Song: the song finder
  await openAsset(p, go, 'Neon Coast - Night Drive')
  await p.click('.asset-find button:has-text("Find details")')
  await p.waitForSelector('.songf[aria-label="Find song details"]')
  ok(await p.inputValue('.songf[aria-label="Find song details"] input >> nth=0') === 'Neon Coast', `${w}: Song: the song finder, with the artist`)

  // ---- a Music video: the song finder, its type kept, the cover not ticked
  await openAsset(p, go, 'Night Drive (official video)')
  await p.click('.asset-find button:has-text("Find details")')
  await p.waitForSelector('.songf[aria-label="Find song details"]')
  await p.click('.songf-q button:has-text("Search")')
  await p.waitForSelector('.songf-r:not(.off)', { timeout: 20000 })
  await p.locator('.songf-r:not(.off)').first().click()
  await p.waitForSelector('.songf-review')
  const mvText = await p.locator('.songf-review').innerText()
  const coverTicked = await p.locator('.songf-review input[aria-label="Use this cover"]:checked').count()
  ok(!/Make it a Song/.test(await p.locator('.songf-review').innerHTML()) && coverTicked === 0 && /Album/.test(mvText) && /ISRC/.test(mvText), `${w}: Music video: no Song type offered, the cover not ticked, album and ISRC to fill`)
  ok(errs.length === 0, `${w}: no page errors (${errs.slice(0, 2).join(' | ')})`)
  await p.context().close()
}
await reset()
await b.close()
console.log(`\n${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
