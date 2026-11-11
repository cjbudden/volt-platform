// FIND DETAILS FROM A PASTED LINK in a real browser (build queue F2): on a
// Movie's Metadata tab, Find details takes a link as well as a search. The
// page is read and shown first among the results, marked as the page on its
// site; its fields are compared with the asset's, empty ones ticked; Apply
// writes only the ticked fields, recorded as from that page. A site that
// refuses programs is said plainly. At 1440 and 390 px.
//
// Needs the API on the docs seed (it has Nosferatu), started with
// GRAPHICS_ALLOW_PRIVATE_FEEDS=1 (the stand-in site below is on 127.0.0.1) and
// WIKIDATA_API_BASE=http://127.0.0.1:${STANDIN_PORT}/w/api.php, and `npx vite` in volt-web.
//   BASE=http://127.0.0.1:5173 PLAYWRIGHT=<path to playwright/index.mjs> \
//   CHROMIUM=<chromium binary, optional> SHOTS=<dir, optional> node volt-web/test/find-details-page.browser.mjs
import { createServer } from 'node:http'
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')
const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const SHOTS = process.env.SHOTS || ''
const PORT = Number(process.env.STANDIN_PORT || 18555)
const EMAIL = process.env.EMAIL || 'admin@example.com', PASSWORD = process.env.PASSWORD || 'volt1234'
let passes = 0, fails = 0
const ok = (c, m) => { if (c) { passes++; console.log('PASS ' + m) } else { fails++; console.log('FAIL ' + m) } }

// ---- a stand-in film site and Wikidata -------------------------------------------
const FILM_PAGE = `<!doctype html><html><head><title>Nosferatu (1922) | Silent Archive</title>
<meta property="og:site_name" content="Silent Archive"><meta property="og:image" content="http://127.0.0.1:${PORT}/img/card.svg">
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [
  { '@type': 'WebSite', name: 'Silent Archive' },
  { '@type': 'Movie', name: 'Nosferatu', description: 'Count Orlok takes a house in Wisborg.', datePublished: '1922-03-04',
    director: { '@type': 'Person', name: 'F. W. Murnau' }, actor: [{ '@type': 'Person', name: 'Max Schreck' }, { '@type': 'Person', name: 'Greta Schröder' }],
    genre: 'Drama', inLanguage: 'German', contentRating: 'PG' },
] })}</script></head><body></body></html>`
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#345"/></svg>'
const site = createServer((q, r) => {
  const u = new URL(q.url, 'http://x')
  if (u.pathname === '/films/nosferatu') { r.setHeader('content-type', 'text/html'); return r.end(FILM_PAGE) }
  if (u.pathname === '/img/card.svg') { r.setHeader('content-type', 'image/svg+xml'); return r.end(SVG) }
  if (u.pathname === '/blocked') { r.statusCode = 403; r.setHeader('content-type', 'text/html'); return r.end('<html><head><title>Just a moment...</title></head></html>') }
  if (u.pathname === '/w/api.php') {
    r.setHeader('content-type', 'application/json')
    if (u.searchParams.get('action') === 'wbsearchentities') return r.end(JSON.stringify({ search: [{ id: 'Q151895' }] }))
    if ((u.searchParams.get('props') || '').includes('claims')) return r.end(JSON.stringify({ entities: { Q151895: { id: 'Q151895', labels: { en: { value: 'Nosferatu' } }, descriptions: { en: { value: '1922 film by F. W. Murnau' } }, claims: {} } } }))
    return r.end(JSON.stringify({ entities: {} }))
  }
  r.statusCode = 404; r.end('no')
}).listen(PORT, '127.0.0.1')
const FILM_URL = `http://127.0.0.1:${PORT}/films/nosferatu`

const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json()
const api = async (path, opts = {}) => {
  const r = await fetch(BASE + '/api' + path, { ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${login.access}` } })
  return { status: r.status, body: r.status === 204 ? null : await r.json() }
}
const FILM = '6b1f0d2e-7a3c-4e5f-9a1b-2c3d4e5f6b01'
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
const shot = async (p, n, sel) => { if (SHOTS) await (sel ? p.locator(sel).screenshot({ path: `${SHOTS}/${n}.png` }) : p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false })) }
const hscroll = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

for (const w of [1440, 390]) {
  await reset()
  const { p, errs, go } = await signIn(w)
  await go('/vod'); await p.waitForSelector('h1')
  await p.locator('tr:has-text("Nosferatu") button:has-text("Open")').first().click()
  await p.locator('button:text-is("Metadata")').first().click()
  await p.click('.asset-find button:has-text("Find details")')
  const F = '.songf[aria-label="Find details"]'
  await p.waitForSelector(F)
  ok(await p.locator(`${F} .songf-link button:has-text("Read page")`).isDisabled(), `${w}: Read page waits for a link`)

  // A site that refuses programs: said, nothing to pick.
  await p.fill(`${F} .songf-link input`, `http://127.0.0.1:${PORT}/blocked`)
  await p.click(`${F} .songf-link button`)
  await p.waitForSelector(`${F} .asset-img-err`)
  ok(/does not let programs read its pages\. Open the page in your browser and copy the details/.test(await p.locator(`${F} .asset-img-err`).innerText()) && await p.locator(`${F} .songf-r`).count() === 0,
    `${w}: a site that refuses programs is said, with what to do instead`)

  // Search first, then paste: the page comes first, the search result after it.
  await p.click(`${F} .songf-q button:has-text("Search")`)
  await p.waitForSelector(`${F} .songf-r`)
  await p.fill(`${F} .songf-link input`, FILM_URL)
  await p.click(`${F} .songf-link button`)
  await p.waitForSelector(`${F} .songf-r:has-text("From the page on")`)
  const cards = await p.$$eval(`${F} .songf-r .songf-rb`, (xs) => xs.map((x) => x.textContent))
  ok(cards.length === 2 && /From the page on 127\.0\.0\.1 \(Movie\)/.test(cards[0]) && /Count Orlok/.test(cards[0]) && /1922 film by F\. W\. Murnau/.test(cards[1]) && await p.locator(`${F} .asset-img-err`).count() === 0,
    `${w}: the page first, marked as from its site, then the search result (${cards.map((c) => c.slice(0, 50)).join(' | ')})`)
  await p.locator(`${F} .songf-r`).first().click()
  await p.waitForSelector(`${F} .songf-review`)
  const rows = await p.$$eval(`${F} .songf-review tbody tr`, (rs) => rs.map((r) => ({ label: r.children[1]?.textContent, same: r.classList.contains('same'), ticked: !!r.querySelector('input[type=checkbox]:checked') })))
  const by = (l) => rows.find((r) => r.label === l)
  ok(by('Title')?.same && by('Content rating')?.same && by('Director')?.ticked && by('Cast')?.ticked && by('Year')?.ticked && by('Synopsis')?.ticked && by('Language')?.ticked && by('Poster')?.ticked,
    `${w}: the same values shown as =, empty fields ticked (${rows.map((r) => `${r.label}${r.same ? '=' : r.ticked ? '+' : ''}`).join(', ')})`)
  const head = await p.locator(`${F} .songf-rh`).innerText()
  ok(/The page on 127\.0\.0\.1/.test(head) && await p.locator(`${F} .songf-rh a`).getAttribute('href') === FILM_URL, `${w}: the review links to the page (${head})`)
  ok(/came from 127\.0\.0\.1/.test(await p.locator(`${F} .songf-act`).innerText()), `${w}: says the fields will remember the page's site`)
  if (w === 1440) await shot(p, 'media-library-find-details-link', F)
  // Untick the poster, apply.
  await p.locator(`${F} .songf-review input[aria-label="Use Poster"]`).uncheck()
  const applyText = await p.locator(`${F} .songf-act button`).innerText()
  await p.click(`${F} .songf-act button`)
  await p.waitForSelector(F, { state: 'detached', timeout: 10000 })
  const a = (await api(`/vod/${FILM}`)).body
  const m = a.metadata ?? {}
  const pv = a.metadata_provenance?.director ?? {}
  ok(m.director === 'F. W. Murnau' && m.year === 1922 && m.language === 'German' && Array.isArray(m.cast) && m.cast.length === 2 && m.image === undefined && m.rating === 'PG',
    `${w}: ${applyText}: the ticked fields saved, the poster and rating untouched (${JSON.stringify(m)})`)
  ok(pv.source === 'page' && pv.link === FILM_URL && pv.site === '127.0.0.1', `${w}: each applied field records the page (${JSON.stringify(pv)})`)
  ok(await hscroll(p) <= 0, `${w}: no sideways scroll`)
  ok(errs.length === 0, `${w}: no page errors (${errs.slice(0, 2).join(' | ')})`)
  if (w === 390) await shot(p, 'find-details-link-390')
  await p.context().close()
}
await reset()
await b.close(); site.close()
console.log(`\n${passes} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
