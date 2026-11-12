// ============================================================================
//  RETENTION FOR VOD TITLES (build queue P5, services/media/vodRetention.ts).
//
//  Through the real API on a real database:
//    - the plan (pure): keep forever, days from ingest, from Available from,
//      from Available until (and none without one), a copy rule makes the
//      copy rung apply; what keeps a due title, in order;
//    - the sweep: a due draft moves to the restore bin (row gone, bin item,
//      log, audit) and comes back with Restore; a title due in 5 days is
//      warned once (not again on the next pass) and listed; one due in 29
//      days is neither; a legal hold keeps a due title (held) until released,
//      then the next pass removes it; a published title in its window waits
//      (still_available); a title in an active FAST lineup waits;
//    - the copy-before-delete rung shared with H3-5: under a copy rule, a due
//      title whose archive copy is not finished waits (copy_pending), one
//      with a verified copy is removed;
//    - legal hold: needs a reason, refused (409 legal_hold_not_allowed) where
//      the policy does not allow it, another account's title is 404;
//    - a date moved later clears the warning; keep forever touches nothing;
//      the dry run counts and changes nothing; the list is per account.
//
//  Usage: DATABASE_URL=... npx tsx test/vod-retention.check.ts
// ============================================================================
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const DAY = 86_400_000;

(async () => {
  process.env.CLIPS_DIR ||= mkdtempSync(join(tmpdir(), 'vr-clips-'));
  process.env.VOLT_TRASH_DIR ||= mkdtempSync(join(tmpdir(), 'vr-trash-'));
  const V = await import('../src/services/media/vodRetention');
  const { BASELINE } = await import('../src/services/publishingRules');

  console.log('== the plan (pure) ==');
  const pol = (retention: any, extra: any = {}) => ({ ...BASELINE, ...extra, retention: { ...BASELINE.retention, ...retention } });
  const ingest = new Date('2026-01-01T00:00:00Z');
  ok(V.planFor(pol({}), null, { created_at: ingest }).dueAt === null, 'keep forever: no date');
  let p = V.planFor(pol({ keep: 'days', days: 30, anchor: 'ingest' }), { 'retention.days': 'account' }, { created_at: ingest });
  ok(p.dueAt?.toISOString() === '2026-01-31T00:00:00.000Z' && p.rule === 'account', '30 days from ingest, and the rung it came from', p);
  p = V.planFor(pol({ keep: 'days', days: 10, anchor: 'available_from' }), null, { created_at: ingest, available_from: '2026-02-01T00:00:00Z' });
  ok(p.dueAt?.toISOString() === '2026-02-11T00:00:00.000Z', '10 days from Available from', p);
  p = V.planFor(pol({ keep: 'days', days: 90, anchor: 'available_until' }), null, { created_at: ingest, available_until: '2026-03-01T00:00:00Z' });
  ok(p.dueAt?.toISOString() === '2026-05-30T00:00:00.000Z', '90 days from Available until', p);
  ok(V.planFor(pol({ keep: 'days', days: 90, anchor: 'available_until' }), null, { created_at: ingest }).dueAt === null, 'from Available until with no end date: no date (it is not deleted)');
  p = V.planFor(pol({ keep: 'days', days: 90, anchor: 'available_until' }, { expire: { mode: 'days', days: 30 } }), null, { created_at: ingest, available_from: '2026-02-01T00:00:00Z' });
  ok(p.dueAt?.toISOString() === '2026-06-01T00:00:00.000Z', 'the policy\'s expiry (30 days) gives Available until when the title has none', p);
  ok(V.planFor(pol({ keep: 'days', days: 1 }, { archive: { copies: [{ targetId: 't', on: ['ingest'] }] } }), null, {}).copyFirst, 'a copy rule of the original makes the copy rung apply');
  ok(!V.planFor(pol({ keep: 'days', days: 1 }, { archive: { copies: [{ targetId: 't', on: ['ingest'], what: ['sidecars'] }] } }), null, {}).copyFirst, 'a copy rule of sidecars only does not');
  ok(V.planFor(pol({ legalHoldAllowed: false }), null, {}).legalHoldAllowed === false, 'legal hold allowed is read from the policy');
  const now = new Date();
  const k = (t: any, o: any = {}) => V.keeper(t, pol({ keep: 'days', days: 1 }), now, o)?.code ?? null;
  ok(k({ legal_hold_at: now, archived_at: null }, { fast: ['X'] }) === 'legal_hold', 'a legal hold is named first');
  ok(k({ availability_state: 'available', available_from: new Date(now.getTime() - DAY) }) === 'still_available', 'published with no end date: still available');
  ok(k({ availability_state: 'available', available_until: new Date(now.getTime() - DAY) }) === null, 'published and expired: nothing keeps it');
  ok(k({ availability_state: 'available', archived_at: now }) === null, 'archived: nothing keeps it');
  ok(k({}, { fast: ['Food & Travel'] }) === 'in_fast_lineup', 'in an active FAST lineup');
  ok(k({}, { copy: { ok: false, code: 'copy_pending', message: 'x' } }) === 'copy_pending', 'an unfinished archive copy');
  ok(k({}, { copy: { ok: true } }) === null, 'a verified copy: nothing keeps it');

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const mkAcct = async (n: string, lic: string[] = []) => (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, $2) RETURNING id`, [`${n}-${tag}`, lic]))!.id as string;
  const acct = await mkAcct('vr'), arch = await mkAcct('vr-arch', ['mirror_archive']), noHold = await mkAcct('vr-nohold'), keepAll = await mkAcct('vr-forever');
  const tokFor = async (a: string, n: string) => {
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${n}-${tag}@example.com`]))!.id;
    return signAccess({ sub: u, account_id: a, role: 'owner' } as any);
  };
  const tok = await tokFor(acct, 'own'), tokArch = await tokFor(arch, 'arch'), tokNo = await tokFor(noHold, 'no');
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const rule = (a: string, retention: any, extra: any = {}) =>
    query(`INSERT INTO publishing_rules(account_id, scope_kind, scope_id, settings) VALUES ($1,'account',NULL,$2::jsonb)`, [a, JSON.stringify({ ...extra, retention })]);
  await rule(acct, { keep: 'days', days: 30, anchor: 'ingest' });
  await rule(keepAll, { keep: 'forever' });
  await rule(noHold, { keep: 'days', days: 30, anchor: 'ingest', legalHoldAllowed: false });
  const site = (await one<any>(`INSERT INTO sites (account_id, name) VALUES ($1, 'Site') RETURNING id`, [arch]))!.id;
  const target = (await one<any>(`INSERT INTO archive_targets (account_id, site_id, name, path) VALUES ($1,$2,'Archive NAS','/mnt/nas') RETURNING id`, [arch, site]))!.id;
  await rule(arch, { keep: 'days', days: 30, anchor: 'ingest' }, { archive: { copies: [{ targetId: target, on: ['ingest'] }] } });

  const mk = async (a: string, title: string, ageDays: number, o: any = {}) => (await one<any>(
    `INSERT INTO vod_assets (account_id, channel_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, source_key, sha256, created_at, availability_state, available_from, available_until)
     VALUES ($1,$2,'upload',$3,'/x',0,0,1,$4,$5, now() - make_interval(days => $6), $7, $8, $9) RETURNING id`,
    [a, o.channel ?? null, title, `/nowhere/${title}-${tag}.mp4`, 'a'.repeat(64), ageDays, o.state ?? 'draft', o.from ?? null, o.until ?? null]))!.id as string;
  const row = (id: string) => one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [id]);
  const logOf = (id: string) => query<any>(`SELECT * FROM vod_retention_log WHERE vod_asset_id = $1 ORDER BY created_at`, [id]);

  const oldDraft = await mk(acct, 'Old draft', 40);
  const held = await mk(acct, 'Held', 40);
  const live = await mk(acct, 'Live', 40, { state: 'available', from: new Date(Date.now() - 40 * DAY) });
  const expired = await mk(acct, 'Expired', 40, { state: 'expired', from: new Date(Date.now() - 40 * DAY), until: new Date(Date.now() - 2 * DAY) });
  const soon = await mk(acct, 'Soon', 25);
  const far = await mk(acct, 'Far', 1);
  const g = (await one<any>(`INSERT INTO groups(account_id, name, max_channels) VALUES ($1,'G',50) RETURNING id`, [acct]))!.id;
  const fastCh = (await one<any>(`INSERT INTO channels(group_id, name, origin) VALUES ($1,'Food & Travel','playlist') RETURNING id`, [g]))!.id;
  const onAir = await mk(acct, 'On air', 40);
  await query(`INSERT INTO fast_lineups (channel_id, name, epoch, zone, status, slots) VALUES ($1,'Main',now(),'UTC','active',$2::jsonb)`, [fastCh, JSON.stringify([{ assetId: onAir }])]);
  const forever = await mk(keepAll, 'Forever', 400);
  const unconfirmed = await mk(arch, 'Unconfirmed copy', 40);
  const confirmed = await mk(arch, 'Confirmed copy', 40);
  const copy = (id: string, state: string) => query(
    `INSERT INTO archive_copies (account_id, target_id, vod_asset_id, what, source_uri, file_name, expected_sha256, sha256, state, stored_path, verified_at)
     VALUES ($1,$2,$3,'source',$4,'f.mp4',$5,$6,$7,'Originals/f.mp4', now())`,
    [arch, target, id, `/nowhere/${state === 'queued' ? 'Unconfirmed copy' : 'Confirmed copy'}-${tag}.mp4`, 'a'.repeat(64), state === 'queued' ? null : 'a'.repeat(64), state]);
  await copy(unconfirmed, 'queued');
  await copy(confirmed, 'verified');

  console.log('== legal hold ==');
  let r = await api('POST', `/api/storage/vod/${held}/hold`, { hold: true });
  ok(r.status === 400, 'a legal hold with no reason is refused', r);
  r = await api('POST', `/api/storage/vod/${held}/hold`, { hold: true, reason: 'Litigation 2026-114' });
  ok(r.status === 200 && r.body.legalHold === true, 'a legal hold with a reason is set', r);
  ok(!!(await row(held))!.legal_hold_at && (await row(held))!.legal_hold_reason === 'Litigation 2026-114', 'stored on the title with its reason');
  r = await api('POST', `/api/storage/vod/${held}/hold`, { hold: true, reason: 'x' }, tokNo);
  ok(r.status === 404, 'another account\'s title answers 404', r.status);
  const nh = await mk(noHold, 'No holds', 40);
  r = await api('POST', `/api/storage/vod/${nh}/hold`, { hold: true, reason: 'x' }, tokNo);
  ok(r.status === 409 && r.body?.code === 'legal_hold_not_allowed', 'refused where the policy does not allow legal holds (409 legal_hold_not_allowed)', r);
  ok(!(await row(nh))!.legal_hold_at, 'and nothing is stored');

  console.log('== the dry run ==');
  let s = await V.sweepVodRetention({ accountId: acct, dryRun: true });
  ok(s.removed === 2 && s.held === 1 && s.waiting === 2 && s.warned === 1, 'the dry run counts: 2 to remove, 1 held, 2 waiting, 1 to warn', s);
  ok(!!(await row(oldDraft)) && !(await row(soon))!.retention_warned_at && (await logOf(oldDraft)).length === 0, 'and changes nothing');

  console.log('== the sweep ==');
  s = await V.sweepVodRetention({ accountId: acct });
  ok(s.removed === 2 && s.held === 1 && s.waiting === 2 && s.warned === 1 && s.failed === 0, 'one pass: the old draft and the expired title removed, 1 held, 2 waiting, 1 warned', s);
  ok(!(await row(oldDraft)), 'the due draft is gone from the library');
  const bin = await one<any>(`SELECT * FROM trash_items WHERE kind = 'vod_asset' AND subject_id = $1`, [oldDraft]);
  ok(bin?.state === 'held' && /retention/.test(bin.reason ?? ''), 'it is in the restore bin, with retention as the reason', bin);
  const lg = await logOf(oldDraft);
  ok(lg.length === 1 && lg[0].event === 'removed' && lg[0].bin_item_id === bin?.id && lg[0].rule === 'account', 'logged as removed, with the bin item and the rung', lg);
  ok(!!(await one<any>(`SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'delete'`, [oldDraft]).catch(() => null)), 'and in the audit log');
  ok(!(await row(expired)), 'a published title past its Available until is removed too');
  let h = await row(held);
  ok(h.retention_wait_code === 'legal_hold' && /Litigation 2026-114/.test(h.retention_wait), 'the held title stays, and says the hold keeps it', h.retention_wait);
  ok((await row(live))!.retention_wait_code === 'still_available', 'a published title with no end date waits (still_available)');
  ok((await row(onAir))!.retention_wait_code === 'in_fast_lineup' && /Food & Travel/.test((await row(onAir))!.retention_wait), 'a title in an active FAST lineup waits and names the channel');
  const so = await row(soon);
  ok(!!so.retention_warned_at && Math.abs(new Date(so.retention_due_at).getTime() - (Date.now() + 5 * DAY)) < 60_000, 'the title due in 5 days is warned, with its date');
  ok((await logOf(soon)).filter((x) => x.event === 'warned').length === 1, 'one warning logged');
  const fr = await row(far);
  ok(!fr.retention_warned_at && !!fr.retention_due_at, 'the title due in 29 days has its date but no warning yet');
  ok(!(await row(forever))!.retention_due_at, 'an account that keeps forever is not touched');

  console.log('== the list ==');
  r = await api('GET', '/api/storage/vod-retention');
  const ids = (r.body?.items ?? []).map((x: any) => x.id);
  ok(r.status === 200 && r.body.within === 7, 'the warning list answers, 7 days by default', r.status);
  ok(ids.includes(soon) && ids.includes(held) && ids.includes(live) && ids.includes(onAir) && !ids.includes(far), 'it lists the warned title and the due ones that are kept, not the one due in 29 days', ids.length);
  const it = r.body.items.find((x: any) => x.id === held);
  ok(it?.due === true && it.legalHold?.reason === 'Litigation 2026-114' && it.waiting?.code === 'legal_hold', 'each says when, and what keeps it', it);
  r = await api('GET', '/api/storage/vod-retention?within=30');
  ok(r.body.items.some((x: any) => x.id === far), 'within=30 reaches the title due in 29 days');
  r = await api('GET', '/api/storage/vod-retention', undefined, tokArch);
  ok(!r.body.items.some((x: any) => x.id === soon), 'another account does not see them');
  r = await api('GET', `/api/storage/vod-retention/log?assetId=${held}`);
  ok(r.status === 200 && r.body.items.some((x: any) => x.event === 'held'), 'the log for one title', r.body);

  console.log('== a second pass ==');
  s = await V.sweepVodRetention({ accountId: acct });
  ok(s.removed === 0 && s.warned === 0, 'a second pass removes nothing more and does not warn again', s);
  ok((await logOf(held)).filter((x) => x.event === 'held' && x.code === 'legal_hold').length === 2, 'a kept title is logged when its reason changes, not every pass (hold set, then kept once)');

  console.log('== release, then removal ==');
  r = await api('POST', `/api/storage/vod/${held}/hold`, { hold: false });
  ok(r.status === 200 && r.body.legalHold === false, 'the hold is released', r);
  h = await row(held);
  ok(!h.legal_hold_at && !h.retention_wait_code, 'the title no longer says it is held');
  s = await V.sweepVodRetention({ accountId: acct });
  ok(s.removed === 1 && !(await row(held)), 'the next pass removes it');
  ok((await logOf(held)).some((x) => x.event === 'released'), 'the release is logged');

  console.log('== restore from the bin ==');
  r = await api('POST', `/api/vod/${oldDraft}/restore`);
  ok(r.status === 200 && !!(await row(oldDraft)), 'Restore brings a title retention removed back', r);

  console.log('== a later date ==');
  await query(`UPDATE vod_assets SET created_at = now() - interval '1 day' WHERE id = $1`, [soon]);
  await V.sweepVodRetention({ accountId: acct });
  const so2 = await row(soon);
  ok(!so2.retention_warned_at && new Date(so2.retention_due_at).getTime() > Date.now() + 28 * DAY, 'a date moved later clears the warning, so it is warned again when it comes near');

  console.log('== copy before delete (shared with H3-5) ==');
  s = await V.sweepVodRetention({ accountId: arch });
  ok(s.removed === 1 && s.waiting === 1, 'under a copy rule: one removed, one waiting', s);
  ok(!(await row(confirmed)), 'the title with a verified archive copy is removed');
  const un = await row(unconfirmed);
  ok(un?.retention_wait_code === 'copy_pending' && /archive copy/.test(un.retention_wait), 'the title whose copy is not finished waits and says why', un?.retention_wait);
  await query(`UPDATE archive_copies SET state = 'verified', sha256 = expected_sha256 WHERE vod_asset_id = $1`, [unconfirmed]);
  s = await V.sweepVodRetention({ accountId: arch });
  ok(s.removed === 1 && !(await row(unconfirmed)), 'once the copy is verified it goes');
  await query(`UPDATE accounts SET licences = '{}' WHERE id = $1`, [arch]);
  const noLic = await mk(arch, 'No licence', 40);
  s = await V.sweepVodRetention({ accountId: arch });
  ok(s.removed === 0 && (await row(noLic))!.retention_wait_code === 'no_licence', 'with the add-on off a copy rule cannot be met: it waits (no_licence)');

  console.log('== every rung counts (P5-2) ==');
  // An account whose rules keep forever, with one title that keeps itself 1
  // day (the asset rung) and one a metadata rule keeps 1 day.
  const own = await mkAcct('vr-own');
  const selfKept = await mk(own, 'Kept by its own setting', 10);
  await query(`UPDATE vod_assets SET availability_override = '{"retention":{"keep":"days","days":1,"anchor":"ingest"}}'::jsonb WHERE id = $1`, [selfKept]);
  const plain = await mk(own, 'Plain', 10);
  s = await V.sweepVodRetention({ accountId: own });
  ok(s.removed === 1 && !(await row(selfKept)) && !!(await row(plain)), 'a title whose own setting keeps it 1 day is removed, the rest of the account is not', s);
  const meta = await mkAcct('vr-meta');
  const tagged = await mk(meta, 'Tagged', 10);
  await query(`UPDATE vod_assets SET tags = ARRAY['short-life'] WHERE id = $1`, [tagged]).catch(() => {});
  await query(`INSERT INTO publishing_metadata_rules(account_id, position, name, conditions, settings) VALUES ($1,0,'Short life',$2::jsonb,$3::jsonb)`,
    [meta, JSON.stringify({ match: 'all', conditions: [{ field: 'tags', op: 'has_any', value: ['short-life'] }] }), JSON.stringify({ retention: { keep: 'days', days: 1, anchor: 'ingest' } })]);
  s = await V.sweepVodRetention({ accountId: meta, dryRun: true });
  ok(s.considered === 1, 'an account whose only retention is a metadata rule is read', s);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close(); await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
