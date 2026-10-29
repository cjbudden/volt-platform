// ============================================================================
//  A CORNER BUG SETUP'S IMAGE FIELD IN A REAL BROWSER (the built console, Playwright):
//  pick an alpha video, save, reopen (also after signing in again) and it is still
//  named, shown and playing in the preview; swap it for a still; clear it and save.
//  Screenshots go to SHOT_DIR (default: a temp folder).
//
//  Usage: build volt-web into the served console dir first, then
//    DATABASE_URL=... npx tsx test/setup-images-ui.check.ts   (a migrated, disposable database)
// ============================================================================
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const SHOT = process.env.SHOT_DIR || join(require('node:os').tmpdir(), `volt-ui-${Date.now().toString(36)}`);
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
(async () => {
  mkdirSync(SHOT, { recursive: true });
  const mov = join(SHOT, 'bug.mov');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x120:r=25', '-t', '3',
    '-vf', "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,160),255,0)'", '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', mov]);
  const png = join(SHOT, 'logo.png');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=orange:s=240x90', '-frames:v', '1', png]);
  const { createServer } = await import('../src/server');
  const { pool, one } = await import('../src/db');
  const { hashPassword } = await import('../src/auth/password');
  const { ensureDefaultTemplates } = await import('../src/services/graphics/defaults');
  await ensureDefaultTemplates();
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ui-${tag}`]))!.id;
  const email = `ui-${tag}@volt.test`, pw = 'Correct-Horse-9!';
  await one(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,$3,'owner','active') RETURNING id`, [acct, email, await hashPassword(pw)]);
  const app: any = createServer(); const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const login = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pw }) })).json() as any;
  const tok = login.access ?? login.accessToken ?? login.token;
  ok(!!tok, 'API login', JSON.stringify(login).slice(0, 200));
  const H = { authorization: `Bearer ${tok}` };
  let r: any = await (await fetch(`${base}/api/files`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Golden Cluck.png', folder: 'bugs', kind: 'bug', dataBase64: readFileSync(png).toString('base64') }) })).json();
  ok(!!r.id, 'still uploaded', JSON.stringify(r).slice(0, 200));
  r = await (await fetch(`${base}/api/files/motion?folder=bugs&name=sting.mov`, { method: 'POST', headers: { ...H, 'content-type': 'application/octet-stream' }, body: new Uint8Array(readFileSync(mov)) })).json();
  ok(!!r.id, 'alpha video uploaded');
  const cbv = await one<any>(`SELECT v.id FROM gfx_template_versions v WHERE v.manifest->>'voltKey' = 'corner-bug' AND v.status = 'published' ORDER BY v.version DESC LIMIT 1`);

  const { createRequire } = await import('node:module');
  const rq = createRequire(__filename);
  const { chromium } = rq('playwright');
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs: string[] = []; p.on('pageerror', (e: any) => errs.push(e.message));
  await p.goto(base + '/login');
  await p.fill('input[type=email], input[name=email]', email);
  await p.fill('input[type=password]', pw);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1500);
  await p.evaluate((u: string) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')) }, `/graphics/setups/new?version=${cbv.id}`);
  await p.waitForSelector('text=Where each field gets its content', { timeout: 15000 });
  const row = p.locator('.gfx-frow').filter({ hasText: 'Bug: a logo' });
  const pickFrom = async (name: string) => {
    await row.getByRole('button', { name: /^(Choose from Image Library|Change)$/ }).click();
    await p.getByText(name, { exact: true }).first().click();
    await p.waitForTimeout(800);
  };
  await pickFrom('sting.webm');
  ok(((await row.innerText()) as string).includes('sting.webm') && ((await row.innerText()) as string).includes('video'), 'picked: the row names the video');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: join(SHOT, '1-picked.png') });
  const playing = async () => {
    for (const f of p.frames()) { const v = await f.evaluate(() => { const v = document.getElementById('vid') as HTMLVideoElement | null; return v ? { src: v.currentSrc, t: v.currentTime, shown: getComputedStyle(v).display } : null }).catch(() => null); if (v) return v }
    return null;
  };
  let v = await playing();
  ok(!!v && /sting\.webm/.test(v.src) && v.t > 0.2 && v.shown === 'block', 'preview plays the video before saving', JSON.stringify(v));
  await p.getByRole('button', { name: 'Save', exact: true }).click();
  await p.waitForURL(/\/graphics\/setups\/[0-9a-f-]{36}$/, { timeout: 10000 });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: join(SHOT, '2-saved.png') });
  ok(((await row.innerText()) as string).includes('sting.webm') && ((await row.innerText()) as string).includes('video'), 'after saving: the row still names the video', await row.innerText());
  ok(await row.locator('img').count() > 0, 'after saving: the row shows its still');
  v = await playing();
  ok(!!v && /sting\.webm/.test(v.src) && v.t > 0.2, 'after saving: the preview plays it', JSON.stringify(v));
  await p.reload(); 
  // memory-only session: sign in again, then reopen
  await p.goto(base + '/login'); await p.fill('input[type=email], input[name=email]', email); await p.fill('input[type=password]', pw); await p.keyboard.press('Enter'); await p.waitForTimeout(1500);
  const sid = (await one<any>(`SELECT id FROM gfx_setups WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`, [acct])).id;
  await p.evaluate((u: string) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')) }, `/graphics/setups/${sid}`);
  await p.waitForSelector('text=Where each field gets its content'); await p.waitForTimeout(2500);
  ok(((await row.innerText()) as string).includes('sting.webm') && ((await row.innerText()) as string).includes('video'), 'reopened later: still there');
  // swap to the still, save, then clear, save
  await pickFrom('Golden Cluck.png');
  await p.getByRole('button', { name: 'Save', exact: true }).click(); await p.waitForTimeout(2000);
  ok(await row.getByText('Golden Cluck.png').count() > 0, 'a still replaces it and survives saving');
  let st = null as any;
  for (const f of p.frames()) { const x = await f.evaluate(() => { const i = document.getElementById('logo') as HTMLImageElement | null; return i ? { src: i.getAttribute('src'), shown: getComputedStyle(i).display, w: i.naturalWidth } : null }).catch(() => null); if (x) st = x }
  ok(!!st && st.shown === 'block' && st.w > 0, 'the preview shows the still', JSON.stringify(st));
  await p.screenshot({ path: join(SHOT, '3-still.png') });
  await row.getByRole('button', { name: /Clear/ }).click();
  await p.getByRole('button', { name: 'Save', exact: true }).click(); await p.waitForTimeout(2000);
  const saved = await one<any>(`SELECT fields FROM gfx_setups WHERE id = $1`, [sid]);
  ok(await row.getByText('Nothing chosen').count() > 0 && !saved.fields.logo?.imageId, 'cleared and saved: nothing chosen', JSON.stringify(saved.fields.logo));
  await p.screenshot({ path: join(SHOT, '4-cleared.png') });
  ok(errs.length === 0, 'no page errors', errs.join('; '));
  await b.close(); srv.close(); await pool.end().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL threw', e); process.exit(1); });
