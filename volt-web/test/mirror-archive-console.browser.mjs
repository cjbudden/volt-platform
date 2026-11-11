// Browser walk for build queue H3-6 (f), the Mirror and Archive console, at
// 1440x900 against the docs seed (volt-app scripts/seed-docs.ts: the account
// has hybrid_sites and mirror_archive, a NAS folder and an S3-compatible store
// at its site, five copies of originals, a recording and its sidecar (H3-7), and a
// copy rule on the account default), served as
// the screenshot script expects (API on :8080 with VOLT_DEPLOYMENT=saas, vite
// on :5173). Run it on a fresh seed: it adds a target and changes the rule.
//   Storage page: targets (the store in words, never its keys), copies with
//     states, the agent's reason and what to do, filters, Check now, add and
//     change a target (a target holding copies keeps its folder), disable one
//   Publishing rule editor: Archive copies on the account default, the window,
//     a disabled target greyed, saving a change
//   Without the add-on: no section, no field; Sites for either add-on only
//   System Admin: the Mirror and Archive switch saves with the account
//   H3-8: Nightly on each target, Original and Sidecars on a target copied to
//   H3-9: Clips beside them, saved in order, alone allowed, the last kept
//   H3-11: the HLS/DASH package on a folder target with its size beside the
//     box, saved and kept
//   H3-12: offered on a store target too (no longer greyed), its note says
//     each file is its own object, saved and kept
//   H3-10: mirror mode: the target's waiting period (0 to 90, saved), a
//     pending and a removed copy (DATABASE_URL of the docs database, to write
//     them), Keep: Archive / Mirror in the rule editor, saved and kept
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
ok('all seven seeded copies are listed (five originals, a recording and its sidecar)', await copyRows.count() === 7)
const states = await sec.locator('tr[data-copy] td:nth-child(3) .tag').allTextContents()
ok('copies show their states in words: ' + JSON.stringify(states), ['Verified', 'Failed', 'Missing', 'Queued'].every(s => states.includes(s)) && states.filter(s => s === 'Verified').length === 4)
const queued = sec.locator('tr[data-copy]:has(.tag:text-is("Queued"))')
const qText = await queued.innerText().catch(() => '')
ok('a copy waiting for keys shows the agent\'s reason: ' + JSON.stringify(qText), /No keys named objects1 on this server/.test(qText))
ok('and what to do about it', /What to do:.*Add keys under this key name on every server of the site/.test(qText))
const fText = await sec.locator('tr[data-copy]:has(.tag:text-is("Failed"))').innerText().catch(() => '')
ok('a failed copy shows its reason and what to do: ' + JSON.stringify(fText), /does not match what was downloaded/.test(fText) && /What to do:/.test(fText))
const mText = await sec.locator('tr[data-copy]:has(.tag:text-is("Missing"))').innerText().catch(() => '')
ok('a missing copy says what to do', /What to do: Find out what removed it at the site/.test(mText))
const checkBtns = await sec.locator('tr[data-copy] button:has-text("Check now")').count()
ok('Check now is offered on the verified and missing copies only (5): ' + checkBtns, checkBtns === 5 && await queued.locator('button:has-text("Check now")').count() === 0)
ok('the counts line adds up', /4 verified/.test(await sec.innerText()) && /1 queued/.test(await sec.innerText()))
// A recording copy (H3-7) says which channel and stretch it is, and links to the recording.
const recRow = sec.locator('tr[data-copy$=".mp4"]:has([data-copy-recording])')
const recText = await recRow.innerText().catch(() => '')
ok('a recording copy says it is the recording of a channel, from when, and links to it: ' + JSON.stringify(recText), await recRow.count() === 1 && /^EveningNews-/.test(await recRow.getAttribute('data-copy')) && /Recording of .+, .+ to /.test(recText) && await recRow.locator('a:has-text("Open the recording")').count() === 1)
ok('its sidecar says it is the metadata of that recording', /Metadata of the recording of/.test(await sec.locator('tr[data-copy$=".json"]').innerText().catch(() => '')))
ok('neither offers to open an asset', await sec.locator('tr:has([data-copy-recording]) a:has-text("Open the asset")').count() === 0)
await page.screenshot({ path: OUT + '/ma-storage.png', fullPage: true })

// filters
await sec.locator('select[aria-label="Show copies that are"]').selectOption('verified'); await page.waitForTimeout(1200)
ok('filtering by Verified shows the four verified copies', await copyRows.count() === 4)
await sec.locator('select[aria-label="Show copies that are"]').selectOption(''); await page.waitForTimeout(400)
const storeId = await sec.locator('select[aria-label="Show copies on"] option:text-is("On-site object store")').getAttribute('value')
await sec.locator('select[aria-label="Show copies on"]').selectOption(storeId); await page.waitForTimeout(1200)
ok('filtering by the store shows its two copies', await copyRows.count() === 2)
await sec.locator('select[aria-label="Show copies on"]').selectOption(''); await page.waitForTimeout(1200)
ok('clearing the filters shows all seven again', await copyRows.count() === 7)

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
ok('the account default offers Recordings on every target, ticked for the NAS only', await rowNas.locator('label:has-text("Recordings") input').isChecked() && await rowStore.locator('label:has-text("Recordings") input').count() === 1 && !(await rowStore.locator('label:has-text("Recordings") input').isChecked()))
ok('and says what recordings means', /Recordings are copied as each programme ends \(each hour without a guide\)/.test(await ctl.innerText()))
ok('the off-peak window reads 22:00 to 06:00 in Sydney', await ctl.locator('label:has-text("Copy only between") input').isChecked()
  && await ctl.locator('input[aria-label="Copies start at"]').inputValue() === '22:00' && await ctl.locator('input[aria-label="Copies stop at"]').inputValue() === '06:00'
  && await ctl.locator('input[aria-label="Time zone of the window"]').inputValue() === 'Australia/Sydney')
ok('a disabled target is greyed and says so', Number(await rowEdit.evaluate(e => getComputedStyle(e).opacity)) < 1 && /disabled: no new copies/.test(await rowEdit.innerText()))
const tw = await ctl.locator('input[aria-label="Copies start at"]').evaluate(e => e.getBoundingClientRect().width)
ok('the time inputs are sized to a time, not the whole row: ' + Math.round(tw), tw > 60 && tw < 160)
await page.locator('[data-archive-control]').first().scrollIntoViewIfNeeded()
await page.screenshot({ path: OUT + '/ma-publishing.png' })
await rowStore.locator('label:has-text("When it lands") input').check()
await rowStore.locator('label:has-text("Recordings") input').check()
const saveResp = page.waitForResponse(r => /\/api\/publishing-rules/.test(r.url()) && r.request().method() === 'PUT', { timeout: 10000 }).catch(() => null)
await page.locator('button:has-text("Save publishing rule")').first().click()
const sr = await saveResp
const sent = sr ? JSON.parse(sr.request().postData() || '{}') : {}
const sentStore = (sent.settings?.archive?.copies ?? sent.archive?.copies ?? []).find(c => c.targetId === storeId)
ok('saving sends the store with all three moments, in order: ' + JSON.stringify(sentStore), !!sr && sr.ok() && JSON.stringify(sentStore?.on) === '["ingest","publish","recording"]')
await go(page, '/storage'); await go(page, '/publishing'); await page.waitForSelector('[data-archive-control]', { timeout: 15000 }).catch(() => {})
ok('and it is still ticked when the page is opened again', await page.locator('[data-archive-control] [data-archive-target="On-site object store"] label:has-text("When it lands") input').isChecked()
  && await page.locator('[data-archive-control] [data-archive-target="On-site object store"] label:has-text("Recordings") input').isChecked())
// H3-8: Nightly and what a copy takes (Original, Sidecars).
{
  const row = page.locator('[data-archive-control] [data-archive-target="On-site object store"]')
  ok('each target offers Nightly', await row.locator('label:has-text("Nightly") input').count() === 1 && !(await row.locator('label:has-text("Nightly") input').isChecked()))
  ok('a target copied to offers Original (ticked) and Sidecars', await row.locator('[data-archive-what] label:has-text("Original") input').isChecked() && !(await row.locator('[data-archive-what] label:has-text("Sidecars") input').isChecked()))
  ok('a target not copied to offers no choice of what', await page.locator('[data-archive-control] [data-archive-target="Edit suite disk"] [data-archive-what]').count() === 0)
  // click, not uncheck: uncheck throws when the box (rightly) stays ticked
  await row.locator('[data-archive-what] label:has-text("Original") input').click()
  ok('the last thing copied cannot be unticked', await row.locator('[data-archive-what] label:has-text("Original") input').isChecked())
  await row.locator('label:has-text("Nightly") input').check()
  await row.locator('[data-archive-what] label:has-text("Sidecars") input').check()
  ok('the field says what sidecars and nightly mean', /Sidecars are a metadata file, the caption files/.test(await page.locator('[data-archive-control]').first().innerText()) && /Nightly copies anything the target does not hold yet/.test(await page.locator('[data-archive-control]').first().innerText()))
  await row.scrollIntoViewIfNeeded(); await page.screenshot({ path: OUT + '/ma-publishing-sidecars.png' })
  const resp2 = page.waitForResponse(r => /\/api\/publishing-rules/.test(r.url()) && r.request().method() === 'PUT', { timeout: 10000 }).catch(() => null)
  await page.locator('button:has-text("Save publishing rule")').first().click()
  const sr2 = await resp2
  const sent2 = sr2 ? JSON.parse(sr2.request().postData() || '{}') : {}
  const st2 = (sent2.settings?.archive?.copies ?? sent2.archive?.copies ?? []).find(c => c.targetId === storeId)
  ok('saving sends Nightly last and the original with its sidecars: ' + JSON.stringify(st2), !!sr2 && sr2.ok() && JSON.stringify(st2?.on) === '["ingest","publish","recording","schedule"]' && JSON.stringify(st2?.what) === '["source","sidecars"]')
  await go(page, '/storage'); await go(page, '/publishing'); await page.waitForSelector('[data-archive-control]', { timeout: 15000 }).catch(() => {})
  const row2 = page.locator('[data-archive-control] [data-archive-target="On-site object store"]')
  ok('and both are still ticked when the page is opened again', await row2.locator('label:has-text("Nightly") input').isChecked() && await row2.locator('[data-archive-what] label:has-text("Sidecars") input').isChecked())
}
// H3-9: Clips as a third thing a copy takes.
{
  const row = page.locator('[data-archive-control] [data-archive-target="On-site object store"]')
  ok('a target copied to offers Clips, unticked', await row.locator('[data-archive-what] label:has-text("Clips") input').count() === 1 && !(await row.locator('[data-archive-what] label:has-text("Clips") input').isChecked()))
  await row.locator('[data-archive-what] label:has-text("Clips") input').check()
  ok('the field says what clips means', /Clips are clips cut from a recording: the clip's file as made, named Title-Channel-date-time/.test(await page.locator('[data-archive-control]').first().innerText()))
  await row.scrollIntoViewIfNeeded(); await page.screenshot({ path: OUT + '/ma-publishing-clips.png' })
  const resp3 = page.waitForResponse(r => /\/api\/publishing-rules/.test(r.url()) && r.request().method() === 'PUT', { timeout: 10000 }).catch(() => null)
  await page.locator('button:has-text("Save publishing rule")').first().click()
  const sr3 = await resp3
  const sent3 = sr3 ? JSON.parse(sr3.request().postData() || '{}') : {}
  const st3 = (sent3.settings?.archive?.copies ?? sent3.archive?.copies ?? []).find(c => c.targetId === storeId)
  ok('saving sends the original, sidecars and clips in that order: ' + JSON.stringify(st3?.what), !!sr3 && sr3.ok() && JSON.stringify(st3?.what) === '["source","sidecars","clips"]')
  await go(page, '/storage'); await go(page, '/publishing'); await page.waitForSelector('[data-archive-control]', { timeout: 15000 }).catch(() => {})
  const row3 = page.locator('[data-archive-control] [data-archive-target="On-site object store"]')
  ok('and Clips is still ticked when the page is opened again', await row3.locator('[data-archive-what] label:has-text("Clips") input').isChecked())
  await row3.locator('[data-archive-what] label:has-text("Original") input').click()
  await row3.locator('[data-archive-what] label:has-text("Sidecars") input').click()
  ok('clips alone can be left ticked', await row3.locator('[data-archive-what] label:has-text("Clips") input').isChecked() && !(await row3.locator('[data-archive-what] label:has-text("Original") input').isChecked()))
  await row3.locator('[data-archive-what] label:has-text("Clips") input').click()
  ok('but not unticked when it is the last', await row3.locator('[data-archive-what] label:has-text("Clips") input').isChecked())
}
// H3-11: the HLS/DASH package, with the size it means beside the box. H3-12: stores too.
{
  await go(page, '/storage'); await go(page, '/publishing'); await page.waitForSelector('[data-archive-control]', { timeout: 15000 }).catch(() => {})
  const storeRow = page.locator('[data-archive-control] [data-archive-target="On-site object store"]')
  const storePkg = storeRow.locator('[data-archive-what] label:has-text("HLS/DASH package") input')
  ok('a store target offers the package box, no longer greyed, saying it goes under one folder in the store', await storePkg.count() === 1 && !(await storePkg.isDisabled()) && /under one folder in the store/.test(await storeRow.locator('[data-archive-what] label:has-text("HLS/DASH package")').getAttribute('title') || ''))
  if (!(await storePkg.isChecked())) await storePkg.check()
  const storeNote = await storeRow.locator('[data-archive-package-size]').innerText().catch(() => '')
  ok('ticked on the store, the note says the size and that each file is its own object: ' + JSON.stringify(storeNote), /about 1\.7 times the original \(0\.1 to 6 times\), a few hundred files, each its own object in the store/.test(storeNote) && !/folder targets only/.test(storeNote))
  await storeRow.scrollIntoViewIfNeeded(); await page.screenshot({ path: OUT + '/ma-publishing-packages-store.png' })
  const nasRow = page.locator('[data-archive-control] [data-archive-target="Machine room NAS"]')
  if (!(await nasRow.locator('label:has-text("When it is published") input').isChecked())) await nasRow.locator('label:has-text("When it is published") input').check()
  const pkg = nasRow.locator('[data-archive-what] label:has-text("HLS/DASH package") input')
  ok('a folder target offers the package box, unticked, with no size note yet', await pkg.count() === 1 && !(await pkg.isChecked()) && await nasRow.locator('[data-archive-package-size]').count() === 0)
  await pkg.check()
  const note = await nasRow.locator('[data-archive-package-size]').innerText().catch(() => '')
  ok('ticked, it says the size beside the box: ' + JSON.stringify(note), /about 1\.7 times the original \(0\.1 to 6 times\), a few hundred files/.test(note))
  ok('the field says what a package is and what it costs in room', /The HLS\/DASH package is every rendition and segment as a folder that plays as it is: on our test library about 1\.7 times the size of the original/.test(await page.locator('[data-archive-control]').first().innerText()))
  await nasRow.scrollIntoViewIfNeeded(); await page.screenshot({ path: OUT + '/ma-publishing-packages.png' })
  const resp4 = page.waitForResponse(r => /\/api\/publishing-rules/.test(r.url()) && r.request().method() === 'PUT', { timeout: 10000 }).catch(() => null)
  await page.locator('button:has-text("Save publishing rule")').first().click()
  const sr4 = await resp4
  const sent4 = sr4 ? JSON.parse(sr4.request().postData() || '{}') : {}
  const nasId = (await (await page.request.get(B + '/api/archive/targets').catch(() => null))?.json().catch(() => null) ?? []).find?.(t => t.name === 'Machine room NAS')?.id
  const all4 = sent4.settings?.archive?.copies ?? sent4.archive?.copies ?? []
  // H3-12: the store has the package ticked too now, so the fallback skips it.
  const st4 = all4.find(c => c.targetId === nasId) ?? all4.find(c => c.targetId !== storeId && (c.what ?? []).includes('packages'))
  ok('saving sends the original and the package for the NAS: ' + JSON.stringify(st4?.what), !!sr4 && sr4.ok() && JSON.stringify(st4?.what) === '["source","packages"]')
  const stS = all4.find(c => c.targetId === storeId)
  ok('and the package for the store: ' + JSON.stringify(stS?.what), !!stS && (stS.what ?? []).includes('packages'))
  await go(page, '/storage'); await go(page, '/publishing'); await page.waitForSelector('[data-archive-control]', { timeout: 15000 }).catch(() => {})
  ok('and the package is still ticked when the page is opened again', await page.locator('[data-archive-control] [data-archive-target="Machine room NAS"] [data-archive-what] label:has-text("HLS/DASH package") input').isChecked())
  ok('on the store too', await page.locator('[data-archive-control] [data-archive-target="On-site object store"] [data-archive-what] label:has-text("HLS/DASH package") input').isChecked())
}
// H3-10: mirror mode. The waiting period on the target, a pending and a done
// delete on the copies (written straight into the docs database when
// DATABASE_URL is given, as only time and the agent make them), and the
// Keep: Archive / Mirror choice in the rule editor.
{
  await go(page, '/storage'); await page.waitForSelector('[data-mirror-archive] tr[data-target="Machine room NAS"]', { timeout: 15000 }).catch(() => {})
  const sec = page.locator('[data-mirror-archive]'), nas = sec.locator('tr[data-target="Machine room NAS"]')
  ok('each target says how long mirror deletes wait, and that nothing is waiting: ' + JSON.stringify(await nas.locator('[data-target-mirror]').innerText().catch(() => '')),
    /After 7 days/.test(await nas.locator('[data-target-mirror]').innerText().catch(() => '')) && /Nothing waiting/.test(await nas.locator('[data-target-mirror]').innerText().catch(() => '')))
  await nas.locator('button:has-text("Change")').click(); await page.waitForTimeout(400)
  const form = sec.locator('[data-target-form]')
  ok('the target form has the mirror waiting period, 7 by default', await form.locator('#at-grace').inputValue() === '7' && /Counted from when the asset leaves Volt for good/.test(await form.innerText()))
  await form.locator('#at-grace').fill('120')
  await form.locator('button:has-text("Save target")').click(); await page.waitForTimeout(1200)
  ok('more than 90 days is refused, and says the range', /0 to 90/.test(await form.innerText().catch(() => '')))
  await form.locator('#at-grace').fill('14')
  const pr = page.waitForResponse(r => /\/api\/archive\/targets\//.test(r.url()) && r.request().method() === 'PATCH', { timeout: 10000 }).catch(() => null)
  await form.locator('button:has-text("Save target")').click()
  const prr = await pr; await page.waitForTimeout(1200)
  ok('14 days saves: ' + (prr && prr.request().postData()), !!prr && prr.ok() && JSON.parse(prr.request().postData() || '{}').mirrorGraceDays === 14 && /After 14 days/.test(await nas.innerText()))
  if (process.env.DATABASE_URL) {
    const { execFileSync } = await import('node:child_process')
    const sql = (q) => execFileSync('psql', [process.env.DATABASE_URL, '-Atc', q], { encoding: 'utf8' }).trim()
    sql(`UPDATE archive_copies SET mode = 'mirror', delete_after = now() + interval '3 days' WHERE id = (SELECT c.id FROM archive_copies c JOIN archive_targets t ON t.id = c.target_id WHERE t.name = 'Machine room NAS' AND c.state = 'verified' AND c.stream_id IS NULL ORDER BY c.file_name LIMIT 1)`)
    sql(`UPDATE archive_copies SET mode = 'mirror', state = 'removed', removed_at = now() - interval '1 hour', vod_asset_id = NULL WHERE id = (SELECT c.id FROM archive_copies c JOIN archive_targets t ON t.id = c.target_id WHERE t.name = 'Machine room NAS' AND c.state = 'missing' AND c.stream_id IS NULL ORDER BY c.file_name LIMIT 1)`)
    await go(page, '/sites'); await go(page, '/storage'); await page.waitForSelector('[data-mirror-archive] [data-copy]', { timeout: 15000 }).catch(() => {})
    const mt = await nas.locator('[data-target-mirror]').innerText().catch(() => '')
    ok('the target shows the delete waiting and when: ' + JSON.stringify(mt), /1 waiting, next /.test(mt))
    const pend = sec.locator('tr[data-copy]:has([data-copy-pending])')
    ok('the copy says the asset has left Volt and the day it goes: ' + JSON.stringify(await pend.innerText().catch(() => '')), await pend.count() === 1 && /The asset has left Volt: deleted here on /.test(await pend.innerText()))
    const rem = sec.locator('tr[data-copy]:has(.tag:text-is("Removed"))')
    ok('a removed copy shows Removed and when it was deleted at the target', await rem.count() === 1 && /Deleted at the target/.test(await rem.innerText()) && await rem.locator('button:has-text("Check now")').count() === 0)
    await sec.locator('select[aria-label="Show copies that are"]').selectOption('removed'); await page.waitForTimeout(1200)
    ok('the state filter offers Removed', await sec.locator('tr[data-copy]').count() === 1)
    await sec.locator('select[aria-label="Show copies that are"]').selectOption(''); await page.waitForTimeout(1000)
    await pend.scrollIntoViewIfNeeded(); await page.screenshot({ path: OUT + '/ma-storage-mirror.png' })
  } else console.log('SKIP the pending and removed copies (no DATABASE_URL for the docs database)')

  await go(page, '/publishing'); await page.waitForSelector('[data-archive-control]', { timeout: 15000 }).catch(() => {})
  const row = page.locator('[data-archive-control] [data-archive-target="Machine room NAS"]')
  const sel = row.locator('[data-archive-mode] select')
  ok('a target copied to offers Keep: Archive or Mirror, Archive by default', await sel.count() === 1 && await sel.inputValue() === 'archive')
  ok('a target not copied to offers no choice', await page.locator('[data-archive-control] [data-archive-target="Edit suite disk"] [data-archive-mode]').count() === 0)
  await sel.selectOption('mirror'); await page.waitForTimeout(300)
  ok('Mirror says what it does, with the target\'s own waiting period: ' + JSON.stringify(await row.locator('[data-archive-mirror-note]').innerText().catch(() => '')),
    /deletes files at the site 14 days after an asset leaves Volt/.test(await row.locator('[data-archive-mirror-note]').innerText().catch(() => '')))
  ok('the help says Archive keeps everything and Mirror never deletes a changed file', /Archive keeps every copy; Mirror deletes a copy at the target/.test(await page.locator('[data-archive-control]').first().innerText()) && /never a file someone changed at the site/.test(await page.locator('[data-archive-control]').first().innerText()))
  await row.scrollIntoViewIfNeeded(); await page.screenshot({ path: OUT + '/ma-publishing-mirror.png' })
  const resp = page.waitForResponse(r => /\/api\/publishing-rules/.test(r.url()) && r.request().method() === 'PUT', { timeout: 10000 }).catch(() => null)
  await page.locator('button:has-text("Save publishing rule")').first().click()
  const sr = await resp
  const sent = sr ? JSON.parse(sr.request().postData() || '{}') : {}
  const nasId = (await (await page.request.get(B + '/api/archive/targets').catch(() => null))?.json().catch(() => null) ?? []).find?.(t => t.name === 'Machine room NAS')?.id
  const all = sent.settings?.archive?.copies ?? sent.archive?.copies ?? []
  const nasCopy = all.find(c => c.targetId === nasId) ?? all.find(c => c.mode === 'mirror')
  ok('saving sends the NAS as mirror, the rest unsaid: ' + JSON.stringify(all.map(c => c.mode ?? null)), !!sr && sr.ok() && nasCopy?.mode === 'mirror' && all.filter(c => c.mode === 'mirror').length === 1)
  await go(page, '/storage'); await go(page, '/publishing'); await page.waitForSelector('[data-archive-control]', { timeout: 15000 }).catch(() => {})
  ok('and it is still Mirror when the page is opened again', await page.locator('[data-archive-control] [data-archive-target="Machine room NAS"] [data-archive-mode] select').inputValue() === 'mirror')
}
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
