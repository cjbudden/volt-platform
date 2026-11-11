// ============================================================================
//  REMOVING MEDIA LIBRARY ASSETS, ONE OR IN BULK, AND MANAGEMENT CONFIRMATION
//  (services/vodRemove.ts, services/media/trash.ts, services/bulkActions.ts).
//
//  Against a real database and real files: a removed asset's packaged media
//  (HLS master and renditions, the DASH manifest, a FAST ladder variant with
//  both) and its uploaded source leave the clips folder for the bin; the row
//  leaves vod_assets for trash_items, held 2 days; restore puts every file
//  and the row back; the purge deletes them for good. Then the bulk rules:
//  the typed count, the account setting off (runs) and on (a request), who
//  may approve, approving runs it, undo, withdrawing.
//
//    DATABASE_URL=... npx tsx test/bulk-remove.check.ts
// ============================================================================
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'volt-bulk-'));
process.env.CLIPS_DIR = join(root, 'clips');
process.env.VOLT_TRASH_DIR = join(root, 'trash');
process.env.VOD_STORE = 'local';
delete process.env.VOLT_LIBRARY_TRASH_DAYS;

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++; } else { console.log(`FAIL ${m} -- expected ${w} got ${g}`); fail++; }
};
async function throwsWith(m: string, fn: () => Promise<unknown>, status: number) {
  try { await fn(); check(m, 'no error', `error ${status}`); } catch (e: any) { check(m, e?.status, status); }
}

/** Every file under a directory, relative, sorted. */
function tree(dir: string, pre = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? tree(join(dir, e.name), pre + e.name + '/') : [pre + e.name]).sort();
}

(async () => {
  const { one, query } = await import('../src/db');
  const { removeVodAsset } = await import('../src/services/vodRemove');
  const { restoreItem, purgeExpired, LIBRARY_TRASH_DAYS } = await import('../src/services/media/trash');
  const B = await import('../src/services/bulkActions');

  const acct = (await one<any>(`INSERT INTO accounts (name) VALUES ('Bulk test') RETURNING id`))!.id as string;
  const user = async (email: string, role: string) => (await one<any>(
    `INSERT INTO users (account_id, email, password_hash, role, status) VALUES ($1, $2, 'x', $3, 'active') RETURNING id`, [acct, email, role]))!.id as string;
  const editorId = await user(`ed-${Date.now()}@t.test`, 'operator');
  const adminId = await user(`ad-${Date.now()}@t.test`, 'admin');
  const admin2Id = await user(`ad2-${Date.now()}@t.test`, 'admin');
  const editor = { userId: editorId, label: 'Ed', rank: 2 };
  const admin = { userId: adminId, label: 'Ada', rank: 3 };
  const admin2 = { userId: admin2Id, label: 'Ali', rank: 3 };

  /** An uploaded asset with packaged media on disk the way the encoder writes it. */
  const PACKAGED = ['ladders/fast/2s/manifest.mpd', 'ladders/fast/2s/master.m3u8', 'ladders/fast/2s/v0/seg-1.m4s',
    'manifest.mpd', 'master.m3u8', 'v0/init.mp4', 'v0/playlist.m3u8', 'v0/seg-1.m4s', 'v0/seg-2.m4s', 'v1/playlist.m3u8', 'v1/seg-1.m4s'].sort();
  async function asset(title: string) {
    const id = (await one<any>(`SELECT gen_random_uuid() AS id`))!.id as string;
    const out = join(process.env.CLIPS_DIR!, 'vod', id);
    for (const f of PACKAGED) { mkdirSync(join(out, f, '..'), { recursive: true }); writeFileSync(join(out, f), `${title} ${f}`); }
    const src = join(process.env.CLIPS_DIR!, 'vod-src', `${id}.mov`);
    mkdirSync(join(src, '..'), { recursive: true }); writeFileSync(src, 'source');
    await query(`INSERT INTO vod_assets (id, account_id, title, source_kind, kind, source_key, master_key, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1, $2, $3, 'upload', 'clip', $4, $5, 0, 0, 60000)`,
      [id, acct, title, src, `/clips/vod/${id}/master.m3u8`]);
    await query(`INSERT INTO vod_markers (vod_asset_id, kind, start_ms, end_ms) VALUES ($1, 'intro', 0, 1000)`, [id]).catch(() => {});
    return { id, out, src };
  }
  const rowOf = (id: string) => one<any>(`SELECT id FROM vod_assets WHERE id = $1`, [id]);
  const binOf = (id: string) => one<any>(`SELECT * FROM trash_items WHERE subject_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]);

  console.log('== one asset: everything goes to the bin ==');
  const a = await asset('Elephants Dream');
  check('packaged media on disk before', tree(a.out), PACKAGED);
  const bin = await removeVodAsset(a.id, { by: 'test' });
  check('the row has left vod_assets', await rowOf(a.id), null);
  check('HLS, DASH and the FAST ladder copy have left the clips folder', existsSync(a.out), false);
  check('the uploaded source has left vod-src', existsSync(a.src), false);
  const item = await binOf(a.id);
  check('a bin item holds it', [item?.id === bin, item?.state, item?.kind], [true, 'held', 'vod_asset']);
  check('every packaged file is in the bin folder', tree(join(process.env.VOLT_TRASH_DIR!, bin!)).filter((f) => f.startsWith('output/')).map((f) => f.replace(/^output\/\d+\/[^/]+\//, '')), PACKAGED);
  check('the source is in the bin folder', tree(join(process.env.VOLT_TRASH_DIR!, bin!)).some((f) => f.startsWith('source/')), true);
  check('the row is kept in the bin', (item.rows as any[]).some((r) => r.table === 'vod_assets' && r.row.id === a.id), true);
  const days = Math.round((Date.parse(item.purge_after) - Date.parse(item.created_at)) / 86400_000);
  check(`a library delete is held ${LIBRARY_TRASH_DAYS} days (2 by default)`, [LIBRARY_TRASH_DAYS, days], [2, 2]);

  console.log('== restore puts it all back ==');
  await restoreItem(bin!, { accountId: acct, by: 'test' });
  check('the row is back', !!(await rowOf(a.id)), true);
  check('every packaged file is back where it was', tree(a.out), PACKAGED);
  check('the source is back', existsSync(a.src), true);
  check('the bin folder is gone', existsSync(join(process.env.VOLT_TRASH_DIR!, bin!)), false);
  check('the item says restored', (await binOf(a.id)).state, 'restored');

  console.log('== the purge (the hourly retention sweep) deletes it for good ==');
  const bin2 = await removeVodAsset(a.id, { by: 'test' });
  const notYet = await purgeExpired();
  check('not purged before its time', [(await binOf(a.id)).state, existsSync(join(process.env.VOLT_TRASH_DIR!, bin2!))], ['held', true]);
  await query(`UPDATE trash_items SET purge_after = now() - interval '1 minute' WHERE id = $1`, [bin2]);
  await purgeExpired();
  const gone = await binOf(a.id);
  check('purged: files deleted, rows dropped', [gone.state, existsSync(join(process.env.VOLT_TRASH_DIR!, bin2!)), (gone.rows as any[]).length], ['purged', false, 0]);
  check('nothing left in the clips folder', [existsSync(a.out), existsSync(a.src)], [false, false]);
  void notYet;
  await throwsWith('a purged item cannot be restored', () => restoreItem(bin2!, { accountId: acct }), 409);

  console.log('== bulk remove, setting off (the default) ==');
  check('the setting is off by default', (await one<any>(`SELECT bulk_needs_approval FROM accounts WHERE id = $1`, [acct]))!.bulk_needs_approval, false);
  const x = await asset('One'), y = await asset('Two');
  await throwsWith('the typed count must match', () => B.runOrRequest(acct, 'vod.remove', [x.id, y.id], 1, editor), 400);
  check('...and nothing went', [!!(await rowOf(x.id)), existsSync(x.out)], [true, true]);
  const ran: any = await B.runOrRequest(acct, 'vod.remove', [x.id, y.id, '00000000-0000-0000-0000-000000000000'], 3, editor);
  check('an editor runs it at once', ran.ran, true);
  check('two removed, the unknown one refused with a reason', [ran.outcome.done.map((d: any) => d.name).sort(), ran.outcome.refused.length], [['One', 'Two'], 1]);
  check('their media left the clips folder', [existsSync(x.out), existsSync(y.out)], [false, false]);
  const undo = await B.restoreMany(acct, [x.id, y.id], editor);
  check('undo brings both back with their media', [undo.restored.length, existsSync(x.out), existsSync(y.out), tree(x.out)], [2, true, true, PACKAGED]);

  console.log('== management confirmation on ==');
  await query(`UPDATE accounts SET bulk_needs_approval = true WHERE id = $1`, [acct]);
  const req: any = await B.runOrRequest(acct, 'vod.remove', [x.id, y.id], 2, editor, 'old trailers');
  check('an editor files a request instead', [req.ran, req.request.state, req.request.count, req.request.note], [false, 'pending', 2, 'old trailers']);
  check('...and nothing is removed yet', [!!(await rowOf(x.id)), existsSync(x.out)], [true, true]);
  check('the request lists what the editor saw', req.request.items.map((i: any) => i.name).sort(), ['One', 'Two']);
  await throwsWith('an editor cannot approve', () => B.decide(acct, req.request.id, true, { ...editor, userId: adminId === editorId ? 'x' : editor.userId }), 403);
  await throwsWith('nobody approves their own (an admin who asked)', async () => {
    const own: any = await B.runOrRequest(acct, 'vod.remove', [x.id], 1, { ...admin, rank: 2 });
    await B.decide(acct, own.request.id, true, admin);
  }, 403);
  const ok: any = await B.decide(acct, req.request.id, true, admin, 'fine');
  check('an administrator approves: it runs', [ok.request.state, ok.outcome.done.length, ok.request.decidedBy], ['approved', 2, 'Ada']);
  check('...and the media is gone', [!!(await rowOf(x.id)), existsSync(x.out), existsSync(y.out)], [false, false, false]);
  await throwsWith('approving twice is refused', () => B.decide(acct, req.request.id, true, admin2), 409);
  check('approving it again later finds nothing to do (already decided)', (await B.listRequests(acct, { pendingOnly: true })).some((r: any) => r.id === req.request.id), false);
  await B.restoreMany(acct, [x.id, y.id], admin);

  const adm: any = await B.runOrRequest(acct, 'vod.remove', [y.id], 1, admin);
  check('an administrator\'s own bulk action runs at once', [adm.ran, existsSync(y.out)], [true, false]);
  await B.restoreMany(acct, [y.id], admin);

  const rej: any = await B.runOrRequest(acct, 'vod.remove', [y.id], 1, editor);
  const r2: any = await B.decide(acct, rej.request.id, false, admin2, 'keep it');
  check('rejected: nothing removed', [r2.request.state, r2.outcome, existsSync(y.out)], ['rejected', null, true]);
  const wd: any = await B.runOrRequest(acct, 'vod.remove', [y.id], 1, editor);
  check('the editor withdraws their own request', (await B.cancel(acct, wd.request.id, editor)).state, 'cancelled');
  const exp: any = await B.runOrRequest(acct, 'vod.remove', [y.id], 1, editor);
  await query(`UPDATE bulk_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [exp.request.id]);
  await B.listRequests(acct);
  check('a request nobody decides expires', (await one<any>(`SELECT state FROM bulk_requests WHERE id = $1`, [exp.request.id]))!.state, 'expired');
  await throwsWith('an expired request cannot be approved', () => B.decide(acct, exp.request.id, true, admin), 409);

  await query(`DELETE FROM accounts WHERE id = $1`, [acct]);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
