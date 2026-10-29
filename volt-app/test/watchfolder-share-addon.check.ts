// ============================================================================
//  WATCHFOLDERS, SHARE LINK VIEWS AND SEND TO ADD-ON (build queue 1.14-G3a-3).
//
//  Fixes found writing the media guides, pinned over real HTTP:
//    - a Failed watchfolder item can be retried (back to Waiting, taken in by
//      the next pass) or dismissed; it used to be refused with
//      "this item is failed, not quarantined"
//    - an accepting rule must name a target kind Volt takes in (the form took
//      any text, and files matching "document" waited for ever); a refusing
//      rule takes nothing in and is not checked; the folder lists the kinds
//    - rename, switch off and delete through the folder's PATCH and DELETE,
//      for Files, uploads & storage: Manage only; delete leaves the files
//    - a share link counts one view per visit (the page's visit id), so a
//      reload, Check again or a token refresh is not another view and does
//      not use up a one-view link; no visit id counts every time, as before
//    - Send to add-on on a recording needs Recordings: Operate (or Account
//      settings: Operate as before), not Account settings only; a clip needs
//      Media library: Operate; the subject's runs list is View on its feature
//    DATABASE_URL=... npx tsx test/watchfolder-share-addon.check.ts
// ============================================================================
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { openShare, createShareLink } = await import('../src/services/shareLinks');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, max_channels) VALUES ($1, 50) RETURNING id`, [`wsa-${tag}`]))!.id;
  const users: Record<string, { id: string; tier: string }> = {};
  const person = async (key: string, tier: string, perms: any | null) => {
    const id = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x',$3,'active') RETURNING id`,
      [acct, `wsa-${key}-${tag}@volt.test`, tier]))!.id;
    if (perms) {
      const g = (await one<any>(`INSERT INTO user_groups(account_id, name, permissions) VALUES ($1,$2,$3::jsonb) RETURNING id`, [acct, `${key} ${tag}`, JSON.stringify(perms)]))!.id;
      await query(`INSERT INTO user_group_members(user_id, group_id) VALUES ($1,$2)`, [id, g]);
    }
    users[key] = { id, tier };
  };
  await person('mediaManage', 'operator', { media: 'manage' });
  await person('mediaOperate', 'operator', { media: 'operate' });
  await person('mediaView', 'operator', { media: 'view' });
  await person('recOperate', 'operator', { recordings: 'operate' });
  await person('recView', 'operator', { recordings: 'view' });
  await person('vodOperate', 'operator', { vod: 'operate', recordings: 'view' });
  await person('settingsOperate', 'operator', { settings: 'operate', recordings: 'view' });

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = (k: string) => signAccess({ sub: users[k].id, account_id: acct, role: users[k].tier });
  const call = async (method: string, path: string, k: string, body?: any) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok(k)}`, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const j = await res.json().catch(() => null) as any;
    return { s: res.status, j };
  };
  const msg = (r: { j: any }) => String(r.j?.error?.message ?? r.j?.error ?? r.j?.message ?? '');

  try {
    // ======================================================== watchfolders
    console.log('== watchfolders ==');
    const root = await mkdtemp(join(tmpdir(), 'wsa-'));
    const made = await call('POST', '/api/watchfolders', 'mediaManage', { name: 'Agency', config: { path: root, min_age_ms: 1000 } });
    check('Manage creates a watchfolder (201)', made.s, 201);
    const F = made.j.id;
    check('a default target kind nothing takes in is refused (400)',
      (await call('POST', '/api/watchfolders', 'mediaManage', { name: 'Bad', config: { path: root }, defaultTargetKind: 'document' })).s, 400);

    const detail = await call('GET', `/api/watchfolders/${F}`, 'mediaView');
    const kinds = (detail.j?.targetKinds ?? []) as { kind: string; goesTo: string }[];
    check('the folder lists the kinds it takes in, with where each goes',
      ['slate', 'vod', 'loop'].map((k) => kinds.find((x) => x.kind === k)?.goesTo), ['images', 'media', 'loops']);
    check('...and not a kind nothing takes in', kinds.some((k) => k.kind === 'document'), false);

    const badRule = await call('POST', `/api/watchfolders/${F}/rules`, 'mediaManage', { name: 'Docs', pattern: '*.pdf', targetKind: 'document' });
    check('an accepting rule with a kind nothing takes in is refused (400) and names the kinds',
      [badRule.s, /not a kind Volt takes in/.test(msg(badRule)), /slate/.test(msg(badRule))], [400, true, true]);
    check('a kind is matched without regard to capitals (201)',
      (await call('POST', `/api/watchfolders/${F}/rules`, 'mediaManage', { name: 'Logos', pattern: 'logo_*.png', targetKind: 'Logo' })).s, 201);
    check('a refusing rule is not checked for its kind (201)',
      (await call('POST', `/api/watchfolders/${F}/rules`, 'mediaManage', { name: 'No docs', pattern: '*.pdf', targetKind: 'anything', action: 'reject', rejectReason: 'not media' })).s, 201);
    const good = await call('POST', `/api/watchfolders/${F}/rules`, 'mediaManage', { name: 'Slates', pattern: 'slate_*.png', targetKind: 'slate' });
    check('a rule with a kind from the list (201)', good.s, 201);
    check('changing a rule to a kind nothing takes in is refused (400)',
      (await call('PATCH', `/api/watchfolders/${F}/rules/${good.j.id}`, 'mediaManage', { targetKind: 'pdf' })).s, 400);
    const reject = (await one<any>(`SELECT id FROM watchfolder_rules WHERE watchfolder_id=$1 AND action='reject'`, [F]))!.id;
    check('switching a refusing rule to accepting checks the kind it keeps (400)',
      (await call('PATCH', `/api/watchfolders/${F}/rules/${reject}`, 'mediaManage', { action: 'accept' })).s, 400);
    check('changing it to a good kind (200)',
      (await call('PATCH', `/api/watchfolders/${F}/rules/${good.j.id}`, 'mediaManage', { targetKind: 'poster' })).s, 200);
    check('Operate cannot add a rule (403)',
      (await call('POST', `/api/watchfolders/${F}/rules`, 'mediaOperate', { name: 'X', pattern: '*.jpg', targetKind: 'image' })).s, 403);
    check('Operate can try a file name (200)', (await call('POST', `/api/watchfolders/${F}/dry-run`, 'mediaOperate', { filename: 'slate_a.png' })).s, 200);
    const viewDry = await call('POST', `/api/watchfolders/${F}/dry-run`, 'mediaView', { filename: 'slate_a.png' });
    check('View cannot, with a reason the console can show (403, names Operate)', [viewDry.s, /operate/i.test(msg(viewDry))], [403, true]);

    // ---- a failed item: retry and dismiss
    const p = join(root, 'slate_broken.png');
    await mkdir(root, { recursive: true }); await writeFile(p, 'not really a png');
    const t = new Date(Date.now() - 60_000); await utimes(p, t, t);
    const failed = (await one<any>(
      `INSERT INTO watchfolder_items(watchfolder_id, account_id, object_key, checksum, size_bytes, status, target_kind, workflow, reason, resolved_at)
       VALUES ($1,$2,'slate_broken.png','c1',16,'failed','slate','register','not an image Volt can read', now()) RETURNING id`, [F, acct]))!.id;
    check('View cannot retry (403)', (await call('POST', `/api/watchfolders/${F}/items/${failed}/resolve`, 'mediaView', { resolution: 'reprocess' })).s, 403);
    const retry = await call('POST', `/api/watchfolders/${F}/items/${failed}/resolve`, 'mediaManage', { resolution: 'reprocess' });
    check('Retry on a Failed item is accepted (200), it was refused before', retry.s, 200);
    check('...and the item is Waiting again with the claim cleared', [retry.j?.status, retry.j?.resolved_at], ['seen', null]);
    check('...the old reason is kept in the new one', /retrying after: not an image/.test(retry.j?.reason ?? ''), true);
    check('...and the file was left where it was', existsSync(p), true);
    const { pendingItems } = await import('../src/services/watchfolder/store');
    check('the next ingest pass asks for it again', (await pendingItems(F)).some((i) => String(i.id) === String(failed)), true);
    check('a Waiting item has nothing to resolve (400)',
      (await call('POST', `/api/watchfolders/${F}/items/${failed}/resolve`, 'mediaManage', { resolution: 'remove' })).s, 400);
    await query(`UPDATE watchfolder_items SET status='failed' WHERE id=$1`, [failed]);
    const dismiss = await call('POST', `/api/watchfolders/${F}/items/${failed}/resolve`, 'mediaManage', { resolution: 'remove' });
    check('Dismiss on a Failed item (200, Dismissed)', [dismiss.s, dismiss.j?.status], [200, 'removed']);
    check('...and Dismiss deletes no file', existsSync(p), true);

    // ---- a review item: Reprocess and Dismiss answer 200 over HTTP (the audit
    //      write used to fail after the change and answer 400)
    const q1 = (await one<any>(
      `INSERT INTO watchfolder_items(watchfolder_id, account_id, object_key, checksum, size_bytes, status, reason, quarantine_key)
       VALUES ($1,$2,'notes.txt','c2',5,'quarantined','no rule matched','_review/notes.txt') RETURNING id`, [F, acct]))!.id;
    const dq = await call('POST', `/api/watchfolders/${F}/items/${q1}/resolve`, 'mediaManage', { resolution: 'remove' });
    check('Dismiss on a review item answers 200 (it answered 400 after closing the row)', [dq.s, dq.j?.status], [200, 'removed']);
    await mkdir(join(root, '_review'), { recursive: true }); await writeFile(join(root, '_review/back.txt'), 'hello');
    const q2 = (await one<any>(
      `INSERT INTO watchfolder_items(watchfolder_id, account_id, object_key, checksum, size_bytes, status, reason, quarantine_key)
       VALUES ($1,$2,'back.txt','c3',5,'quarantined','no rule matched','_review/back.txt') RETURNING id`, [F, acct]))!.id;
    const rq = await call('POST', `/api/watchfolders/${F}/items/${q2}/resolve`, 'mediaManage', { resolution: 'reprocess' });
    check('Reprocess on a review item answers 200 and moves the file back', [rq.s, rq.j?.status, existsSync(join(root, 'back.txt'))], [200, 'reprocessed', true]);
    check('...and each resolve is in the audit log under the folder',
      Number((await one<any>(`SELECT count(*) AS n FROM audit_log WHERE entity_type='watchfolder' AND entity_id=$1 AND action='update'`, [F]))!.n) >= 4, true);

    // ---- rename, switch off, delete
    const v = (await one<any>(`SELECT version FROM watchfolders WHERE id=$1`, [F]))!.version;
    check('Operate cannot rename (403)', (await call('PATCH', `/api/watchfolders/${F}`, 'mediaOperate', { name: 'Nope' })).s, 403);
    check('an empty name is refused (400)', (await call('PATCH', `/api/watchfolders/${F}`, 'mediaManage', { name: '  ' })).s, 400);
    const ren = await call('PATCH', `/api/watchfolders/${F}`, 'mediaManage', { name: 'Agency drops', version: v });
    check('Manage renames it (200)', [ren.s, ren.j?.name], [200, 'Agency drops']);
    const off = await call('PATCH', `/api/watchfolders/${F}`, 'mediaManage', { enabled: false });
    check('Manage switches it off (200)', [off.s, off.j?.enabled], [200, false]);
    check('a switched-off folder is not scanned (400 with a reason)',
      (await call('POST', `/api/watchfolders/${F}/scan`, 'mediaManage')).s, 400);
    check('...and switched on again (200)', (await call('PATCH', `/api/watchfolders/${F}`, 'mediaManage', { enabled: true })).j?.enabled, true);
    check('Operate cannot delete (403)', (await call('DELETE', `/api/watchfolders/${F}`, 'mediaOperate')).s, 403);
    check('Manage deletes it (204)', (await call('DELETE', `/api/watchfolders/${F}`, 'mediaManage')).s, 204);
    check('...its rules and queue went with it',
      Number((await one<any>(`SELECT (SELECT count(*) FROM watchfolder_rules WHERE watchfolder_id=$1) + (SELECT count(*) FROM watchfolder_items WHERE watchfolder_id=$1) AS n`, [F]))!.n), 0);
    check('...and the files in the folder are still there', existsSync(p), true);

    // ======================================================== share links
    console.log('\n== share link views ==');
    const g = (await one<any>(`INSERT INTO groups(account_id, name, max_channels) VALUES ($1,'Main',50) RETURNING id`, [acct]))!.id;
    const ch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Wsa News') RETURNING id`, [g]))!.id;
    const asset = (await one<any>(
      `INSERT INTO vod_assets(channel_id, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms)
       VALUES ($1,'clip','Wsa clip','',0,60000,60000) RETURNING id`, [ch]))!.id;
    const mk = async (maxViews: number | null) => createShareLink({
      accountId: acct, resourceKind: 'channel', resourceId: ch, label: `wsa ${maxViews}`, recipients: [],
      accessType: 'preview_only', ttlSec: 86400, maxViews, createdBy: users.mediaManage.id,
    } as any);
    const views = async (id: string) => Number((await one<any>(`SELECT view_count FROM share_links WHERE id=$1`, [id]))!.view_count);

    const one1 = await mk(1);
    const visitA = 'visitAAAA1111', visitB = 'visitBBBB2222';
    check('the first open of a visit is let in', (await openShare(one1.token, { visit: visitA })).ok, true);
    check('...and counts one view', await views(one1.id), 1);
    check('a reload in the same visit is let in under a one-view limit (it used the view)', (await openShare(one1.token, { visit: visitA })).ok, true);
    check('...Check again or a token refresh too', (await openShare(one1.token, { visit: visitA })).ok, true);
    check('...and none of them counted again', await views(one1.id), 1);
    const other = await openShare(one1.token, { visit: visitB });
    check('a second visit on a one-view link is refused (view_cap)', other.ok ? 'ok' : other.reason, 'view_cap');

    const open = await mk(null);
    await openShare(open.token, { visit: visitA }); await openShare(open.token, { visit: visitA }); await openShare(open.token, { visit: visitB });
    check('two visits with reloads count two views', await views(open.id), 2);
    await openShare(open.token, {}); await openShare(open.token, {});
    check('a client that sends no visit id is counted every time, as before', await views(open.id), 4);
    await openShare(open.token, { visit: 'bad id!' });
    check('a malformed visit id counts as no visit', await views(open.id), 5);
    await query(`UPDATE share_links SET revoked=true WHERE id=$1`, [one1.id]);
    const rev = await openShare(one1.token, { visit: visitA });
    check('a counted visit is still stopped by Revoke', rev.ok ? 'ok' : rev.reason, 'revoked');

    const page = await fetch(`${base}/api/share/${open.token}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visit: 'visitCCCC3333' }) });
    await fetch(`${base}/api/share/${open.token}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visit: 'visitCCCC3333' }) });
    check('over HTTP the resolve route takes the visit id (200, one more view for two loads)', [page.status, await views(open.id)], [200, 6]);
    const html = await (await fetch(`${base}/share/${open.token}`)).text();
    check('the share page sends a visit id kept in session storage', /CREDS\.visit=/.test(html) && /sessionStorage/.test(html), true);

    // ======================================================== send to add-on
    console.log('\n== send to add-on ==');
    const addon = (await one<any>(
      `INSERT INTO addon_services (account_id, name, category, kind, signing_secret, accepts, steps, enabled)
       VALUES ($1,'Transcribe','transcription','demo','s',ARRAY['recording','vod_asset'],'[]'::jsonb,true) RETURNING id`, [acct]))!.id;
    const now = Date.now();
    const rec = (await one<any>(
      `INSERT INTO recordings(kind, channel_id, day_utc, status, start_epoch_ms, end_epoch_ms, master_key)
       VALUES ('channel_day', $1, current_date, 'complete', $2, $3, $4) RETURNING id`,
      [ch, now - 120_000, now - 60_000, `channel/${ch}`]))!.id;
    const send = (k: string, subjectType: string, subjectId: string) => call('POST', '/api/workflows/runs', k, { addonId: addon, subjectType, subjectId });
    const r1 = await send('recOperate', 'recording', rec);
    check('Recordings: Operate sends a recording to an add-on (201), it needed Account settings before', r1.s, 201);
    const r2 = await send('recView', 'recording', rec);
    check('Recordings: View cannot (403, names Recordings)', [r2.s, /Recordings/.test(msg(r2))], [403, true]);
    check('Account settings: Operate still can (201)', (await send('settingsOperate', 'recording', rec)).s, 201);
    check('Recordings: Operate cannot send a clip (403)', (await send('recOperate', 'vod_asset', asset)).s, 403);
    check('Media library: Operate sends a clip (201)', (await send('vodOperate', 'vod_asset', asset)).s, 201);
    check('Recordings: Operate cannot start a run on a channel (403, still Account settings)',
      (await send('recOperate', 'channel', ch)).s, 403);
    const list = await call('GET', `/api/workflows/runs?subjectType=recording&subjectId=${rec}&limit=5`, 'recView');
    check('Recordings: View reads the runs of one recording (200, the two runs)', [list.s, list.j?.runs?.length], [200, 2]);
    check('...but not every run in the account (403)', (await call('GET', '/api/workflows/runs?limit=5', 'recView')).s, 403);
    check('...nor the runs of one clip (403)', (await call('GET', `/api/workflows/runs?subjectType=vod_asset&subjectId=${asset}`, 'recView')).s, 403);
    check('...nor cancel a run (403, still Account settings)', (await call('POST', `/api/workflows/runs/${r1.j.id}/cancel`, 'recOperate')).s, 403);
  } catch (e) {
    // A throw part way is a failure, not a short pass: without this the suite
    // would end green on the checks it reached.
    console.log('FAIL the suite threw -- ' + String((e as any)?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
