// ============================================================================
//  COPY-BEFORE-DELETE FOR ORIGINALS (build queue H3-5, decided by Christian on
//  11 Nov 2026; services/archive/originals.ts).
//
//  Through the real API on a real database, with originals as real files in
//  the originals folder:
//    - the verdict (pure): no copy, a copy being made, verified, verified with
//      another copy still being made, a job using it, a copy whose checksum
//      could not be compared, corrupt, missing, failed (with its reason), a
//      copy of an earlier original;
//    - the rule: refused without Mirror and Archive, saved with it; a new
//      account rule includes uploads, a save that does not mention a field
//      keeps it (and no longer turns an asset rule into a recording rule);
//    - the pass: a due original with no copy waits and says why (the file
//      stays); one not yet due is untouched and reported as scheduled; a
//      verified copy lets it go (file gone, the address kept for the restore,
//      the copy named, an audit entry); a corrupt copy, a job using it and a
//      second copy still being made keep it; a file outside the originals
//      folder is put back and the reason given;
//    - reach: an old account rule (no uploads) does not touch an upload until
//      an administrator turns uploads on; an asset on a channel is reached
//      through the channel's account; a channel rule beats the account's;
//    - the dry run counts and changes nothing; the console's list and status.
//
//  Usage: DATABASE_URL=... npx tsx test/retention-originals.check.ts
// ============================================================================
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

(async () => {
  process.env.CLIPS_DIR ||= mkdtempSync(join(tmpdir(), 'rto-clips-'));
  const O = await import('../src/services/archive/originals');

  console.log('== the verdict (pure) ==');
  const KEY = '/x/vod-src/a.mp4', S = 'a'.repeat(64);
  const asset = { source_key: KEY, sha256: S };
  const cp = (o: any) => ({ id: 'c' + Math.random(), what: 'source', source_uri: KEY, target_id: 't', target_name: 'Archive NAS', expected_sha256: S, sha256: S, state: 'verified', verified_at: new Date().toISOString(), ...o });
  ok(O.judgeOriginal(asset, []).code === 'no_copy', 'no copy: it waits (no_copy)');
  ok(O.judgeOriginal(asset, [cp({ state: 'queued', sha256: null })]).code === 'copy_pending', 'a copy being made: it waits (copy_pending)');
  const good = O.judgeOriginal(asset, [cp({})]);
  ok(good.ok && good.copy?.targetName === 'Archive NAS', 'a verified copy of this original with a matching checksum: it may go', good);
  ok(O.judgeOriginal(asset, [cp({}), cp({ state: 'queued', target_name: 'Second NAS' })]).code === 'copy_pending', 'verified, but a second copy is still being made from it: it waits');
  ok(O.judgeOriginal(asset, [cp({})], 1).code === 'in_use', 'verified, but a job is using it: it waits (in_use)');
  ok(O.judgeOriginal(asset, [cp({ expected_sha256: null })]).code === 'copy_unchecked', 'verified with no checksum to compare against: it waits (copy_unchecked)');
  ok(O.judgeOriginal(asset, [cp({ sha256: 'b'.repeat(64), expected_sha256: 'b'.repeat(64) })]).code === 'copy_unchecked', 'verified against a checksum that is not the asset\'s: it waits');
  ok(O.judgeOriginal(asset, [cp({ state: 'corrupt' })]).code === 'copy_corrupt', 'a corrupt copy: it waits (copy_corrupt)');
  ok(O.judgeOriginal(asset, [cp({ state: 'missing' })]).code === 'copy_missing', 'a missing copy: it waits (copy_missing)');
  const f = O.judgeOriginal(asset, [cp({ state: 'failed', error: 'disk full at the site' })]);
  ok(f.code === 'copy_failed' && /disk full at the site/.test(f.message!), 'a failed copy: it waits and gives the copy\'s reason', f);
  ok(O.judgeOriginal(asset, [cp({ source_uri: '/x/vod-src/old.mp4' })]).code === 'copy_stale', 'a copy of an earlier original (replaced file): it waits (copy_stale)');
  ok(O.judgeOriginal(asset, [cp({ what: 'sidecars' })]).code === 'no_copy', 'a copy of something else (sidecars) does not count');

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const R = await import('../src/services/media/retention');

  const tag = Date.now().toString(36);
  const mkAcct = async (n: string, lic: string[]) => (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, $2) RETURNING id`, [`${n}-${tag}`, lic]))!.id;
  const acct = await mkAcct('rto', ['mirror_archive']);
  const old = await mkAcct('rto-old', ['mirror_archive']);
  const none = await mkAcct('rto-none', []);
  const tokFor = async (a: string, n: string) => {
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${n}-${tag}@example.com`]))!.id;
    return signAccess({ sub: u, account_id: a, role: 'owner' } as any);
  };
  const tok = await tokFor(acct, 'own'), tokOld = await tokFor(old, 'old'), tokN = await tokFor(none, 'none');
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };

  console.log('== the rule ==');
  const ladder = [{ afterDays: 3650, action: 'delete' }];
  let r = await api('PUT', '/api/storage/retention', { name: 'N', stages: ladder, originalAfterDays: 30 }, tokN);
  ok(r.status === 403 && r.body?.code === 'licence_required', 'without Mirror and Archive the originals rung is refused', r);
  r = await api('PUT', '/api/storage/retention', { name: 'N', stages: ladder, originalAfterDays: null }, tokN);
  ok(r.status === 200, 'but a rule that keeps originals is always allowed', r.status);
  r = await api('PUT', '/api/storage/retention', { name: 'Default', stages: ladder, appliesTo: 'both', originalAfterDays: 30 });
  ok(r.status === 200 && r.body.original_after_days === 30 && r.body.include_uploads === true, 'saved: originals leave after 30 days, and a new account rule includes uploads', r.body);
  const ruleId = r.body.id;
  r = await api('PUT', '/api/storage/retention', { ruleId, name: 'Default renamed', stages: ladder });
  ok(r.status === 200 && r.body.original_after_days === 30 && r.body.include_uploads === true && r.body.applies_to === 'both',
    'a save that does not mention them keeps the originals rung, the uploads option and applies-to (both)', r.body);
  r = await api('PUT', '/api/storage/retention', { ruleId, name: 'Default', stages: ladder, originalAfterDays: -1 });
  ok(r.status === 400 || r.status === 422, 'a negative number of days is refused', r.status);

  // An account rule made before H3-5: it keeps its old reach.
  await query(`INSERT INTO retention_rules (account_id, name, applies_to, enabled, original_after_days) VALUES ($1,'Old rule','asset',true,30)`, [old]);
  ok((await one<any>(`SELECT include_uploads FROM retention_rules WHERE account_id = $1`, [old]))!.include_uploads === false, 'a rule from before the option has it off (the column default)');
  ok(!!(await R.ruleFor({ accountId: acct, appliesTo: 'asset', viaOwnAccount: true })), 'the asset ladder reaches an upload through a rule that includes uploads');
  ok(!(await R.ruleFor({ accountId: old, appliesTo: 'asset', viaOwnAccount: true })), 'and not through an old rule without it');
  ok(!!(await R.ruleFor({ accountId: old, appliesTo: 'asset' })), 'the old rule still reaches what it reached before (through a channel or event)');

  console.log('== the pass ==');
  const srcDir = join(process.env.CLIPS_DIR!, 'vod-src');
  mkdirSync(srcDir, { recursive: true });
  const mkAsset = async (a: string, name: string, ageDays: number, o: { channel?: string; dir?: string } = {}) => {
    const body = randomBytes(50_000);
    const key = join(o.dir ?? srcDir, `${name}-${tag}.mp4`); writeFileSync(key, body);
    const id = (await one<any>(`INSERT INTO vod_assets (account_id, channel_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, source_key, sha256, created_at)
      VALUES ($1,$2,'upload',$3,'/x',0,0,1,$4,$5, now() - make_interval(days => $6)) RETURNING id`, [a, o.channel ?? null, name, key, sha(body), ageDays]))!.id as string;
    return { id, key, sha: sha(body) };
  };
  const mkTarget = async (a: string, name: string) => {
    const s = await one<any>(`INSERT INTO sites (account_id, name) VALUES ($1, $2) RETURNING id`, [a, `${name} site`]);
    return (await one<any>(`INSERT INTO archive_targets (account_id, site_id, name, path) VALUES ($1,$2,$3,'/mnt/nas') RETURNING id`, [a, s!.id, name]))!.id as string;
  };
  const copy = async (a: string, t: string, x: { id: string; key: string; sha: string }, state = 'verified', o: any = {}) =>
    (await one<any>(`INSERT INTO archive_copies (account_id, target_id, vod_asset_id, what, source_uri, file_name, expected_sha256, sha256, state, stored_path, verified_at)
      VALUES ($1,$2,$3,'source',$4,'f.mp4',$5,$6,$7,$8, now()) RETURNING id`,
      [a, t, x.id, x.key, x.sha, state === 'queued' ? null : (o.sha ?? x.sha), state, `Originals/${x.id}.mp4`]))!.id as string;
  const nas = await mkTarget(acct, 'Archive NAS');
  const nas2 = await mkTarget(acct, 'Second NAS');
  const row = (id: string) => one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [id]);

  const noCopy = await mkAsset(acct, 'No copy', 40);
  const young = await mkAsset(acct, 'Young', 10);
  const safe = await mkAsset(acct, 'Safe', 40);
  await copy(acct, nas, safe);
  const bad = await mkAsset(acct, 'Corrupt', 40);
  await copy(acct, nas, bad, 'corrupt');
  const busy = await mkAsset(acct, 'Busy', 40);
  await copy(acct, nas, busy);
  await query(`INSERT INTO jobs (type, payload) VALUES ('vod.encode', $1)`, [JSON.stringify({ vodAssetId: busy.id })]);
  const second = await mkAsset(acct, 'Second copy', 40);
  await copy(acct, nas, second); await copy(acct, nas2, second, 'queued');
  const outside = await mkAsset(acct, 'Outside', 40, { dir: mkdtempSync(join(tmpdir(), 'rto-elsewhere-')) });
  await copy(acct, nas, outside);

  // Dry run first: counts, changes nothing.
  r = await api('POST', '/api/storage/retention/preview');
  ok(r.status === 200 && r.body.originals?.removed === 2 && r.body.originals?.waiting === 4,
    'the dry run counts 2 originals to remove and 4 waiting', r.body.originals);
  ok(existsSync(safe.key) && (await row(safe.id)).source_key === safe.key && !(await row(noCopy.id)).original_wait_code, 'and changes nothing');

  const res = await O.sweepOriginals({ accountId: acct, actor: 'test' });
  ok(res.removed === 1 && res.waiting === 4 && res.failed === 1, 'the pass: 1 removed, 4 waiting, 1 not removable', res);

  let a = await row(safe.id);
  ok(!existsSync(safe.key), 'a verified copy lets the original go: the file is gone from the cloud');
  ok(a.source_key === null && a.original_removed_key === safe.key && a.original_removed_at && a.original_copy_id,
    'the asset keeps the address it had (for the restore) and names the copy that made it safe', a);
  const audit = await one<any>(`SELECT * FROM audit_log WHERE entity_type = 'vod_original' AND entity_id = $1`, [safe.id]);
  ok(audit && /Archive NAS/.test(JSON.stringify(audit)), 'an audit entry records it, with the target', audit);

  a = await row(noCopy.id);
  ok(existsSync(noCopy.key) && a.source_key === noCopy.key && a.original_wait_code === 'no_copy' && /No archive copy/.test(a.original_wait),
    'no copy: the original stays and the asset says why', a);
  a = await row(bad.id);
  ok(existsSync(bad.key) && a.original_wait_code === 'copy_corrupt', 'a corrupt copy: the original stays (copy_corrupt)', a.original_wait_code);
  a = await row(busy.id);
  ok(existsSync(busy.key) && a.original_wait_code === 'in_use', 'a job using it: the original stays (in_use)', a.original_wait_code);
  a = await row(second.id);
  ok(existsSync(second.key) && a.original_wait_code === 'copy_pending' && /Second NAS/.test(a.original_wait), 'a second copy still being made: the original stays (copy_pending)', a.original_wait);
  a = await row(outside.id);
  ok(existsSync(outside.key) && a.source_key === outside.key && !a.original_removed_at && a.original_wait_code === 'not_removable',
    'a file outside the originals folder: the row is put back and the reason given', a);
  a = await row(young.id);
  ok(existsSync(young.key) && !a.original_wait_code, 'not yet due (10 of 30 days): untouched');

  console.log('== the console ==');
  r = await api('GET', '/api/archive/originals');
  const byId = new Map<string, any>((r.body?.items ?? []).map((i: any) => [i.vodAssetId, i]));
  ok(r.status === 200 && byId.get(safe.id)?.state === 'removed' && byId.get(safe.id)?.copy?.targetName === 'Archive NAS', 'the list shows the removed original and where its copy is', byId.get(safe.id));
  ok(byId.get(noCopy.id)?.state === 'waiting' && byId.get(noCopy.id)?.waitCode === 'no_copy' && !byId.has(young.id), 'and the waiting ones with why; one not yet due is not listed');
  r = await api('GET', '/api/archive/originals?state=removed');
  ok(r.status === 200 && r.body.items.length === 1 && r.body.items[0].vodAssetId === safe.id, 'filtered to removed', r.body);
  r = await api('GET', `/api/archive/originals/${young.id}`);
  ok(r.status === 200 && r.body.state === 'scheduled' && r.body.rule?.afterDays === 30 && r.body.dueAt, 'one asset: not yet due shows when it goes and by which rule', r.body);
  r = await api('GET', `/api/archive/originals/${bad.id}`);
  ok(r.body.state === 'waiting' && r.body.code === 'copy_corrupt' && /no longer matches/.test(r.body.message), 'waiting shows the reason', r.body);
  r = await api('GET', `/api/archive/originals/${safe.id}`);
  ok(r.body.state === 'removed' && r.body.copy?.targetName === 'Archive NAS' && /renditions still play/.test(r.body.message), 'removed says where the copy is and that it still plays', r.body);
  r = await api('GET', `/api/archive/originals/${safe.id}`, undefined, tokOld);
  ok(r.status === 404, "another account's asset is not found", r.status);

  console.log('== fixing the reason lets it go ==');
  await query(`UPDATE archive_copies SET state = 'verified' WHERE vod_asset_id = $1`, [bad.id]);
  await query(`UPDATE jobs SET state = 'succeeded' WHERE payload->>'vodAssetId' = $1`, [busy.id]);
  const res2 = await O.sweepOriginals({ accountId: acct, actor: 'test' });
  ok(!existsSync(bad.key) && !existsSync(busy.key) && (await row(bad.id)).original_removed_at && !(await row(bad.id)).original_wait_code,
    'once the copy is verified again and the job is done, both go on the next pass', res2);

  console.log('== reach ==');
  const oldUpload = await mkAsset(old, 'Old upload', 40);
  const oldNas = await mkTarget(old, 'Old NAS');
  await copy(old, oldNas, oldUpload);
  await O.sweepOriginals({ accountId: old, actor: 'test' });
  ok(existsSync(oldUpload.key) && !(await row(oldUpload.id)).original_wait_code, 'an old account rule (no uploads) does not touch an upload');
  const oldRule = (await one<any>(`SELECT id FROM retention_rules WHERE account_id = $1`, [old]))!.id;
  r = await api('PUT', '/api/storage/retention', { ruleId: oldRule, name: 'Old rule', stages: ladder, includeUploads: true }, tokOld);
  ok(r.status === 200 && r.body.include_uploads === true && r.body.applies_to === 'asset', 'an administrator turns uploads on (applies-to kept)', r.body);
  await O.sweepOriginals({ accountId: old, actor: 'test' });
  ok(!existsSync(oldUpload.key) && (await row(oldUpload.id)).original_removed_at, 'and then the upload\'s original goes');

  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch1 = (await one<any>(`INSERT INTO channels(group_id, name, status, tz) VALUES ($1,'Channel 1','live','UTC') RETURNING id`, [grp]))!.id;
  const ch2 = (await one<any>(`INSERT INTO channels(group_id, name, status, tz) VALUES ($1,'Channel 2','live','UTC') RETURNING id`, [grp]))!.id;
  await query(`INSERT INTO retention_rules (channel_id, name, applies_to, enabled, original_after_days) VALUES ($1,'Keep longer','recording',true,1000)`, [ch2]);
  const onCh1 = await mkAsset(acct, 'On channel 1', 40, { channel: ch1 });
  const onCh2 = await mkAsset(acct, 'On channel 2', 40, { channel: ch2 });
  await copy(acct, nas, onCh1); await copy(acct, nas, onCh2);
  await O.sweepOriginals({ accountId: acct, actor: 'test' });
  ok(!existsSync(onCh1.key), "an asset on a channel is reached through the channel's account rule");
  ok(existsSync(onCh2.key), 'a channel rule (1000 days) beats the account rule (30 days)');
  r = await api('GET', `/api/archive/originals/${onCh2.id}`);
  ok(r.body.state === 'scheduled' && r.body.rule?.scope === 'channel' && r.body.rule?.afterDays === 1000, 'and the status names the channel rule', r.body.rule);

  console.log('== switching it off ==');
  r = await api('PUT', '/api/storage/retention', { ruleId, name: 'Default', stages: ladder, originalAfterDays: null });
  ok(r.status === 200 && r.body.original_after_days === null, 'null switches the originals rung off', r.body);
  const after = await mkAsset(acct, 'After', 40);
  await copy(acct, nas, after);
  await O.sweepOriginals({ accountId: acct, actor: 'test' });
  ok(existsSync(after.key), 'and nothing more is removed');

  console.log('== wiring ==');
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  ok(/sweepOriginals\(\{ actor: 'retention:sweep' \}\)/.test(src('src/services/orchestrator/service.ts')), 'the scheduled retention pass runs the originals pass');
  ok(/viaOwnAccount: !!obj\.via_own_account/.test(src('src/services/media/retention.ts')), 'the media sweep reaches uploads through rules that include them');

  srv.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
