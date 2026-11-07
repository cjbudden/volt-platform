// Browser walk for build queue H3-6 (f), the Mirror and Archive console, at
// 1440x900 against the docs seed (volt-app scripts/seed-docs.ts: the account
// has hybrid_sites and mirror_archive, a NAS folder and an S3-compatible store
// at its site, five copies and a copy rule on the account default), served as
// the screenshot script expects (API on :8080 with VOLT_DEPLOYMENT=saas, vite
// on :5173). Run it on a fresh seed: it adds a target and changes the rule.
//   Storage page: targets (the store in words, never its keys), copies with
//     states, the agent's reason and what to do, filters, Check now, add and
//     change a target (a target holding copies keeps its folder), disable one
//   Publishing rule editor: Archive copies on the account default, the window,
//     a disabled target greyed, saving a change
//   Without the add-on: no section, no field; Sites for either add-on only
//   System Admin: the Mirror and Archive switch saves with the account
//   PLAYWRIGHT=<playwright index.mjs> CHROMIUM=<chrome> OUT=<dir> node volt-web/test/mirror-archive-console.browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT);
const B = 'http://127.0.0.1:5173', OUT = process.env.OUT || '/tmp';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const errs = [];
let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log('PASS ' + m) } else { fail++; console.log('FAIL ' + m) } };

// A signed-in page. `licences` rewrites the account's add-ons in /api/auth/me
// only, which is what the console decides from; the API is left as it is.
async function signIn(email, licences) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage()
  page.on('pageerror', e => errs.push(String(e.message || e)))
  if (licences) {
    await page.route('**/api/auth/me', async (route) => {
      const r = await route.fetch(); const j = await r.json()
      if (j?.account) j.account.licences = licences
      await route.fulfill({ response: r, json: j })
    })
  }
  await page.goto(B + '/'); await page.fill('#signin-email', email); await page.fill('#signin-pw', 'volt1234')
  await page.click('button:has-text("Sign in")'); await page.waitForSelector('.topbar', { timeout: 20000 })
  return { ctx, page }
}
const go = async (page, u) => { await page.evaluate((u) => { history.pushState(null, '', u); dispatchEvent(new PopStateEvent('popstate')) }, u); await page.waitForTimeout(1500) }
const navHas = async (page, label) => (await page.locator(`nav >> text="${label}"`).count()) > 0 || (await page.locator(`.sidebar >> text="${label}"`).count()) > 0

const { ctx, page } = await signIn('admin@example.com')

// ---- Storage page ---------------------------------------------------------------------
await go(page, '/storage')
const sec = page.locator('[data-mirror-archive]')
await sec.waitFor({ timeout: 15000 }).catch(() => {})
ok('the Storage page has a Mirror and Archive section', await sec.isVisible())
await page.waitForSelector('[data-mirror-archive] [data-copy]', { timeout: 15000 }).catch(() => {})
const nas = sec.locator('tr[data-target="Machine room NAS"]'), store = sec.locator('tr[data-target="On-site object store"]')
ok('both seeded storage targets are listed', await nas.count() === 1 && await store.count() === 1)
const nasText = await nas.innerText().catch(() => '')
ok('the NAS shows its folder, speed cap, read-back cadence and status: ' + JSON.stringify(nasText), /\/mnt\/nas\/volt-archive/.test(nasText) && /200 Mbit\/s/.test(nasText) && /Every 30 days/.test(nasText) && /active/i.test(nasText))
const storeText = await store.innerText().catch(() => '')
ok('the store is described in words (bucket, folder, address): ' + JSON.stringify(storeText), /Bucket volt-archive, folder originals at https:\/\/objects\.example\.com:9000/.test(storeText) && !/s3:\/\//.test(storeText))
ok('the store names its key name on the site\'s server, and shows no keys', /keys "objects1" on the site's server/.test(storeText) && /Every 90 days/.test(storeText) && /No cap/.test(storeText))
const copyRows = sec.locator('tr[data-copy]')
ok('all five seeded copies are listed', await copyRows.count() === 5)
const states = await sec.locator('tr[data-copy] td:nth-child(3) .tag').allTextContents()
ok('copies show their states in words: ' + JSON.stringify(states), ['Verified', 'Failed', 'Missing', 'Queued'].every(s => states.includes(s)) && states.filter(s => s === 'Verified').length === 2)
const queued = sec.locator('tr[data-copy]:has(.tag:text-is("Queued"))')
const qText = await queued.innerText().catch(() => '')
ok('a copy waiting for keys shows the agent\'s reason: ' + JSON.stringify(qText), /No keys named objects1 on this server/.test(qText))
ok('and what to do about it', /What to do:.*Add keys under this key name on every server of the site/.test(qText))
const fText = await sec.locator('tr[data-copy]:has(.tag:text-is("Failed"))').innerText().catch(() => '')
ok('a failed copy shows its reason and what to do: ' + JSON.stringify(fText), /does not match what was downloaded/.test(fText) && /What to do:/.test(fText))
const mText = await sec.locator('tr[data-copy]:has(.tag:text-is("Missing"))').innerText().catch(() => '')
ok('a missing copy says what to do', /What to do: Find out what removed it at the site/.test(mText))
const checkBtns = await sec.locator('tr[data-copy] button:has-text("Check now")').count()
ok('Check now is offered on the verified and missing copies only (3): ' + checkBtns, checkBtns === 3 && await queued.locator('button:has-text("Check now")').count() === 0)
ok('the counts line adds up', /2 verified/.test(await sec.innerText()) && /1 queued/.test(await sec.innerText()))
await page.screenshot({ path: OUT + '/ma-storage.png', fullPage: true })

// filters
await sec.locator('select[aria-label="Show copies that are"]').selectOption('verified'); await page.waitForTimeout(1200)
ok('filtering by Verified shows the two verified copies', await copyRows.count() === 2)
await sec.locator('select[aria-label="Show copies that are"]').selectOption(''); await page.waitForTimeout(400)
const storeId = await sec.locator('select[aria-label="Show copies on"] option:text-is("On-site object store")').getAttribute('value')
await sec.locator('select[aria-label="Show copies on"]').selectOption(storeId); await page.waitForTimeout(1200)
ok('filtering by the store shows its two copies', await copyRows.count() === 2)
await sec.locator('select[aria-label="Show copies on"]').selectOption(''); await page.waitForTimeout(1200)
ok('clearing the filters shows all five again', await copyRows.count() === 5)

// Check now
const firstVerified = sec.locator('tr[data-copy]:has(.tag:text-is("Verified"))').first()
const vName = await firstVerified.getAttribute('data-copy')
const verifyResp = page.waitForResponse(r => /\/api\/archive\/copies\/[^/]+\/verify$/.test(r.url()), { timeout: 10000 }).catch(() => null)
await firstVerified.locator('button:has-text("Check now")').click()
const vr = await verifyResp
ok('Check now asks the API to read the copy back: ' + (vr && vr.status()), !!vr && vr.ok())
await page.waitForTimeout(1200)
const again = sec.locator(`tr[data-copy="${vName}"]`)
ok('the copy then says it is being read back, with no second Check now', /Being read back now/.test(await again.innerText()) && await again.locator('button:has-text("Check now")').count() === 0)

// add a target: a store first, to see the key name form, then a folder
await sec.locator('button:has-text("Add a storage target")').click(); await page.waitForTimeout(400)
const form = sec.locator('[data-target-form]')
ok('Add a storage target opens the form', await form.isVisible())
await form.locator('input[name="at-kind"]').nth(1).check()
ok('a store asks for address, bucket, folder, region and a key name', await form.locator('#at-endpoint').isVisible() && await form.locator('#at-bucket').isVisible() && await form.locator('#at-prefix').isVisible() && await form.locator('#at-key').isVisible())
ok('and never for the keys themselves', await form.locator('input[type="password"]').count() === 0 && /never come to Volt's cloud/.test(await form.innerText()))
await form.locator('input[name="at-kind"]').nth(0).check()
await form.locator('#at-name').fill('Edit suite disk'); await form.locator('#at-path').fill('/mnt/edit/archive'); await form.locator('#at-cap').fill('50')
await form.locator('button:has-text("Add target")').click(); await page.waitForTimeout(1500)
const added = sec.locator('tr[data-target="Edit suite disk"]')
ok('the new folder target is listed with its cap and the default read-back', await added.count() === 1 && /50 Mbit\/s/.test(await added.innerText()) && /Every 30 days/.test(await added.innerText()))
ok('and the form closed', await sec.locator('[data-target-form]').count() === 0)

// change the NAS: its folder is fixed once it holds copies
await nas.locator('button:has-text("Change")').click(); await page.waitForTimeout(400)
await form.locator('#at-path').fill('/mnt/nas/elsewhere')
await form.locator('button:has-text("Save target")').click(); await page.waitForTimeout(1200)
ok('a target holding copies refuses a new folder, and says why: ' + JSON.stringify((await form.innerText().catch(() => '')).slice(-160)), /already holds copies/.test(await form.innerText().catch(() => '')))
await form.locator('#at-path').fill('/mnt/nas/volt-archive'); await form.locator('#at-cap').fill('100')
await form.locator('button:has-text("Save target")').click(); await page.waitForTimeout(1500)
ok('changing its speed cap saves', /100 Mbit\/s/.test(await nas.innerText()) && await sec.locator('[data-target-form]').count() === 0)

// disable the new one
await added.locator('button:has-text("Change")').click(); await page.waitForTimeout(400)
await form.locator('#at-status').selectOption('disabled')
await form.locator('button:has-text("Save target")').click(); await page.waitForTimeout(1500)
ok('a disabled target shows Disabled', (await added.locator('.tag').textContent()) === 'Disabled')
await sec.screenshot({ path: OUT + '/ma-storage-after.png' })

// ---- Publishing rule editor ----------------------------------------------------------
await go(page, '/publishing')
await page.waitForSelector('[data-archive-control]', { timeout: 15000 }).catch(() => {})
const ctl = page.locator('[data-archive-control]').first()
ok('the account default has an Archive copies field', await ctl.isVisible() && await page.locator('text="Archive copies"').count() > 0)
const rowNas = ctl.locator('[data-archive-target="Machine room NAS"]'), rowStore = ctl.locator('[data-archive-target="On-site object store"]'), rowEdit = ctl.locator('[data-archive-target="Edit suite disk"]')
ok('the NAS is copied to when files land', await rowNas.locator('label:has-text("When it lands") input').isChecked() && !(await rowNas.locator('label:has-text("When it is published") input').isChecked()))
ok('the store when they are published', await rowStore.locator('label:has-text("When it is published") input').isChecked() && !(await rowStore.locator('label:has-text("When it lands") input').isChecked()))
ok('the off-peak window reads 22:00 to 06:00 in Sydney', await ctl.locator('label:has-text("Copy only between") input').isChecked()
  && await ctl.locator('input[aria-label="Copies start at"]').inputValue() === '22:00' && await ctl.locator('input[aria-label="Copies stop at"]').inputValue() === '06:00'
  && await ctl.locator('input[aria-label="Time zone of the window"]').inputValue() === 'Australia/Sydney')
ok('a disabled target is greyed and says so', Number(await rowEdit.evaluate(e => getComputedStyle(e).opacity)) < 1 && /disabled: no new copies/.test(await rowEdit.innerText()))
const tw = await ctl.locator('input[aria-label="Copies start at"]').evaluate(e => e.getBoundingClientRect().width)
ok('the time inputs are sized to a time, not the whole row: ' + Math.round(tw), tw > 60 && tw < 160)
await page.locator('[data-archive-control]').first().scrollIntoViewIfNeeded()
await page.screenshot({ path: OUT + '/ma-publishing.png' })
await rowStore.locator('label:has-text("When it lands") input').check()
const saveResp = page.waitForResponse(r => /\/api\/publishing-rules/.test(r.url()) && r.request().method() === 'PUT', { timeout: 10000 }).catch(() => null)
await page.locator('button:has-text("Save publishing rule")').first().click()
const sr = await saveResp
const sent = sr ? JSON.parse(sr.request().postData() || '{}') : {}
const sentStore = (sent.settings?.archive?.copies ?? sent.archive?.copies ?? []).find(c => c.targetId === storeId)
ok('saving sends the store with both moments, in order: ' + JSON.stringify(sentStore), !!sr && sr.ok() && JSON.stringify(sentStore?.on) === '["ingest","publish"]')
await go(page, '/storage'); await go(page, '/publishing'); await page.waitForSelector('[data-archive-control]', { timeout: 15000 }).catch(() => {})
ok('and it is still ticked when the page is opened again', await page.locator('[data-archive-control] [data-archive-target="On-site object store"] label:has-text("When it lands") input').isChecked())
ok('Sites is in the menu for this account', await navHas(page, 'Sites'))
await ctx.close()

// ---- Without the add-on ---------------------------------------------------------------
{
  const { ctx, page } = await signIn('admin@example.com', ['hybrid_sites'])
  await go(page, '/storage'); await page.waitForSelector('h1', { timeout: 15000 }); await page.waitForTimeout(800)
  ok('without Mirror and Archive the Storage page has no section', await page.locator('[data-mirror-archive]').count() === 0)
  await go(page, '/publishing'); await page.waitForSelector('text="Account default"', { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(800)
  ok('and the rule editor offers no Archive copies field', await page.locator('[data-archive-control]').count() === 0 && await page.locator('text="Archive copies"').count() === 0)
  ok('Sites stays in the menu with Hybrid Sites alone', await navHas(page, 'Sites'))
  await ctx.close()
}
{
  const { ctx, page } = await signIn('admin@example.com', ['mirror_archive'])
  await go(page, '/storage'); await page.waitForSelector('[data-mirror-archive]', { timeout: 15000 }).catch(() => {})
  ok('with Mirror and Archive alone the Storage page still has the section', await page.locator('[data-mirror-archive]').count() === 1)
  ok('Sites is in the menu with Mirror and Archive alone', await navHas(page, 'Sites'))
  await ctx.close()
}
{
  const { ctx, page } = await signIn('admin@example.com', [])
  await go(page, '/storage'); await page.waitForSelector('h1', { timeout: 15000 }); await page.waitForTimeout(500)
  ok('Sites is not in the menu with neither add-on', !(await navHas(page, 'Sites')))
  await ctx.close()
}

// ---- System Admin ---------------------------------------------------------------------
// /api/platform needs the authenticator step-up, which a test cannot pass, so
// the platform routes are answered here and the PATCH the switch sends is read.
// The licence itself is checked by the API's sites suite.
{
  const { ctx, page } = await signIn('saas@volt.example')
  const row = { id: '11111111-2222-4333-8444-555555555555', name: 'OtherCo', plan_tier: 'standard', max_channels: 5, max_concurrent_sources: 3, status: 'active', channels: 0, users: 1, licences: [] }
  const patches = []
  await page.route('**/api/platform/**', async (route) => {
    const r = route.request(), u = new URL(r.url())
    if (r.method() === 'PATCH' && u.pathname.endsWith('/platform/accounts/' + row.id)) {
      const b = JSON.parse(r.postData() || '{}'); patches.push(b); if (b.licences) row.licences = b.licences
      return route.fulfill({ json: row })
    }
    if (r.method() === 'GET' && u.pathname.endsWith('/platform/accounts')) return route.fulfill({ json: [row] })
    if (r.method() === 'GET') return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })
  await go(page, '/system'); await page.waitForSelector('tr:has-text("OtherCo")', { timeout: 15000 }).catch(() => {})
  await page.locator('tr:has-text("OtherCo")').first().click(); await page.waitForTimeout(800)
  const sw = page.locator('button[aria-label="Mirror and Archive add-on"]')
  ok('System Admin has a Mirror and Archive switch beside Hybrid Sites', await sw.isVisible() && await page.locator('button[aria-label="Hybrid Sites add-on"]').isVisible())
  ok('it is off for an account without the add-on', await sw.getAttribute('aria-checked') === 'false')
  ok('it says the add-on gives Sites without Hybrid Sites', /Gives them Sites too, without Hybrid Sites/.test(await page.locator('.toggle-row:has(button[aria-label="Mirror and Archive add-on"])').innerText()))
  await sw.click()
  ok('switching it shows it on', await sw.getAttribute('aria-checked') === 'true')
  await page.locator('button:has-text("Save changes")').click(); await page.waitForTimeout(1200)
  ok('Save changes sends the add-on with the account: ' + JSON.stringify(patches.map(p => p.licences)), patches.length === 1 && JSON.stringify(patches[0].licences) === '["mirror_archive"]')
  await page.locator('tr:has-text("OtherCo")').first().click(); await page.waitForTimeout(800)
  ok('reopened, the switch is on', await page.locator('button[aria-label="Mirror and Archive add-on"]').getAttribute('aria-checked') === 'true')
  await ctx.close()
}

ok('no page errors: ' + errs.join(' | '), errs.length === 0)
console.log(`\n${pass} passed, ${fail} failed`)
await browser.close(); process.exit(fail ? 1 : 0)
