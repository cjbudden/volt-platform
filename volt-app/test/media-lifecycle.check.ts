// ============================================================================
//  MEDIA LIFECYCLE — the ladder, the tiers, and the waiting.
//
//  Three things are being tested and they need different treatment:
//
//  1. THE FEATURE GATE, against the real configuration. A local deployment has
//     one tier, so cold and archive actions must be refused at WRITE time with a
//     reason. This is checked with the config as it actually ships.
//
//  2. THE STATE MACHINE AND THE LADDER, against a test double for S3. The double
//     stands in for a genuinely external service so the transitions, the restore
//     latency model and the lapse-back-to-archived timer can be exercised for
//     real without an AWS account. What the double must NOT do is make
//     capabilities() claim an archive a deployment does not have: that comes from
//     configuration, and the test sets the configuration explicitly to say so.
//
//  3. RECONCILIATION, against real files on disk. Bytes are removed for real and
//     the lifecycle must notice.
//
//  Usage: DATABASE_URL=... npx tsx test/media-lifecycle.check.ts
// ============================================================================
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, query, one } from '../src/db';
import { config } from '../src/config';
import {
  capabilities, setStorageDriver, isImmediate, restoreWindowMs,
  type StorageDriver, type StorageTier, type RestoreSpeed, type RestoreStatus, type StoredObject,
} from '../src/services/media/storage';
import {
  registerObject, transition, readability, requestRestore, pollRestores,
  setHold, historyOf, locationsOf, IllegalTransition, type MediaObject,
} from '../src/services/media/objects';
import {
  validateStages, dueStage, saveRule, ruleFor, sweep, defaultLadder, closedAtMsOf,
  type RetentionRule, type RetentionStage,
} from '../src/services/media/retention';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));
const falsy = (m: string, v: unknown) => (!v ? ok(m) : bad(m, `expected falsy, got [${String(v)}]`));
const contains = (m: string, hay: string, needle: string) =>
  (hay ?? '').toLowerCase().includes(needle.toLowerCase())
    ? ok(m) : bad(m, `expected to mention "${needle}", got "${String(hay).slice(0, 160)}"`);

// ---------------------------------------------------------------------------
//  A test double for S3.
//
//  It models the one behaviour that makes archive tiers different from every
//  other kind of storage: after a transition to an archive tier the bytes are
//  NOT readable, and a restore takes time. `landRestores()` is the test standing
//  in for that time passing.
// ---------------------------------------------------------------------------
class FakeS3 implements StorageDriver {
  readonly kind = 's3' as const;
  objects = new Map<string, { bytes: number; tier: StorageTier }>();
  restores = new Map<string, { ready: boolean; expectedBy: Date; expiresAt: Date }>();
  transitions: { uri: string; to: StorageTier }[] = [];
  removals: string[] = [];

  put(uri: string, bytes: number, tier: StorageTier = 's3_standard') {
    this.objects.set(uri, { bytes, tier });
  }
  async stat(uri: string) {
    const o = this.objects.get(uri);
    return o ? { bytes: o.bytes } : null;
  }
  async transition(uri: string, to: StorageTier): Promise<StoredObject> {
    const o = this.objects.get(uri);
    if (!o) throw new Error(`no such object: ${uri}`);
    this.transitions.push({ uri, to });
    // S3 keeps the same key across a storage-class change: the URI does not move.
    this.objects.set(uri, { bytes: o.bytes, tier: to });
    return { uri, bytes: o.bytes, tier: to };
  }
  async requestRestore(uri: string, speed: RestoreSpeed): Promise<RestoreStatus> {
    const o = this.objects.get(uri);
    if (!o) throw new Error(`no such object: ${uri}`);
    const win = restoreWindowMs(o.tier, speed) ?? 0;
    const st = {
      ready: false,
      expectedBy: new Date(Date.now() + win),
      expiresAt: new Date(Date.now() + win + 86_400_000),
    };
    this.restores.set(uri, st);
    return st;
  }
  async restoreStatus(uri: string): Promise<RestoreStatus> {
    const r = this.restores.get(uri);
    if (!r) return { ready: true, expectedBy: null, expiresAt: null };
    return { ready: r.ready, expectedBy: r.expectedBy, expiresAt: r.expiresAt };
  }
  async remove(uri: string): Promise<void> {
    this.removals.push(uri);
    this.objects.delete(uri);
  }
  /** The test standing in for hours passing. */
  landRestores() { for (const r of this.restores.values()) r.ready = true; }
}

/** An object shaped like a media_objects row, for the pure ladder checks. */
const objLike = (over: Partial<MediaObject> = {}): MediaObject => ({
  id: '00000000-0000-4000-8000-000000000000',
  recording_id: null, vod_asset_id: null, channel_id: null, event_id: null,
  logical_key: 'run/x/audio', kind: 'run_rendition', rendition: 'audio',
  state: 'available', bytes: 1000, duration_ms: 1000, segment_count: 1,
  checksum: null, retain_until: null, hold: false, hold_reason: null,
  restore_requested_at: null, restore_expected_by: null, restore_expires_at: null,
  restore_tier: null, last_error: null, ...over,
});
const rule = (stages: RetentionStage[]): RetentionRule => ({
  id: 'r', account_id: null, channel_id: null, event_id: null,
  name: 'test', applies_to: 'recording', enabled: true, stages,
});
const DAY = 86_400_000;

async function main() {
  // ======================================================== 1. the gate, real
  // Checked against the configuration as it actually ships, before anything is
  // replaced, because the whole point is what a deployment is ALLOWED to offer.
  const localCaps = capabilities();
  check('a local deployment reports the local driver', localCaps.driver, 'local');
  falsy('and has no archive', localCaps.archiveEnabled);
  check('so it offers only keep and delete', localCaps.actions.join(','), 'keep,delete');
  check('and exactly one tier', localCaps.tiers.join(','), 'local');
  contains('and says why archiving is unavailable', localCaps.archiveUnavailableReason ?? '', 'S3');

  const coldOnLocal = validateStages([{ afterDays: 7, action: 'to_cold' }]);
  check('a cold stage is refused on local storage', coldOnLocal.ok, false);
  check('with a reason the operator can act on',
    coldOnLocal.ok ? '' : coldOnLocal.code, 'action_unavailable');
  contains('that names the missing capability',
    coldOnLocal.ok ? '' : coldOnLocal.message, 'S3');
  check('an archive stage is refused too',
    validateStages([{ afterDays: 30, action: 'to_archive' }]).ok, false);
  check('but delete is allowed', validateStages([{ afterDays: 90, action: 'delete' }]).ok, true);
  check('and the default ladder here is keep-then-delete',
    defaultLadder().map((s) => s.action).join(','), 'delete');

  // ============================================ 2. the deployment WITH archive
  // Configuration says the deployment is on S3 with archiving on; the driver
  // double stands in for the service itself. Both are needed: the config decides
  // what may be offered, the driver decides what happens when it is used.
  const fake = new FakeS3();
  setStorageDriver(fake);
  const savedStore = { ...config.mediaStore };
  (config as any).mediaStore.driver = 's3';
  (config as any).mediaStore.archiveEnabled = true;

  const s3caps = capabilities();
  truthy('an S3 deployment with archiving on offers it', s3caps.archiveEnabled);
  check('with the full ladder of actions', s3caps.actions.join(','), 'keep,to_cold,to_archive,delete');
  truthy('and the archive tiers', s3caps.tiers.includes('s3_deep_archive'));
  check('the default cold tier still serves immediately', isImmediate(s3caps.defaultColdTier!), true);
  check('and the default archive tier does not', isImmediate(s3caps.defaultArchiveTier!), false);
  check('the default ladder is now cool, archive, delete',
    defaultLadder().map((s) => s.action).join(','), 'to_cold,to_archive,delete');

  // ---- ladder validation --------------------------------------------------
  check('a valid ladder is accepted', validateStages([
    { afterDays: 7, action: 'to_cold' },
    { afterDays: 30, action: 'to_archive' },
    { afterDays: 365, action: 'delete' },
  ]).ok, true);

  const backwards = validateStages([
    { afterDays: 7, action: 'to_archive' },
    { afterDays: 30, action: 'to_cold' },
  ]);
  check('a ladder that goes backwards is refused', backwards.ok, false);
  check('and named as such', backwards.ok ? '' : backwards.code, 'backwards');

  check('two stages at the same age are refused', validateStages([
    { afterDays: 7, action: 'to_cold' }, { afterDays: 7, action: 'delete' },
  ]).ok, false);
  check('repeating an action does nothing and is refused', validateStages([
    { afterDays: 7, action: 'to_cold' }, { afterDays: 30, action: 'to_cold' },
  ]).ok, false);
  const wrongTier = validateStages([{ afterDays: 7, action: 'to_cold', targetTier: 's3_deep_archive' }]);
  check('a cold stage pointed at an archive tier is refused', wrongTier.ok, false);
  contains('and explains the difference',
    wrongTier.ok ? '' : wrongTier.message, 'restore');
  check('an archive stage pointed at an immediate tier is refused too',
    validateStages([{ afterDays: 7, action: 'to_archive', targetTier: 's3_ia' }]).ok, false);
  check('an empty ladder is refused', validateStages([]).ok, false);
  check('a negative age is refused',
    validateStages([{ afterDays: -1, action: 'delete' }]).ok, false);

  // ---- which rung is due --------------------------------------------------
  const ladder = rule([
    { afterDays: 7, action: 'to_cold', targetTier: 's3_glacier_ir' },
    { afterDays: 30, action: 'to_archive', targetTier: 's3_glacier_flexible' },
    { afterDays: 365, action: 'delete' },
  ]);
  const now = Date.now();

  check('fresh media is due for nothing',
    dueStage(objLike(), ladder, ['s3_standard'], now - 1 * DAY, now), null);
  check('at eight days it is due to cool',
    dueStage(objLike(), ladder, ['s3_standard'], now - 8 * DAY, now)?.stage.action, 'to_cold');
  check('once cooled, cooling is not due again',
    dueStage(objLike(), ladder, ['s3_glacier_ir'], now - 8 * DAY, now), null);
  check('at forty days it is due to archive',
    dueStage(objLike(), ladder, ['s3_glacier_ir'], now - 40 * DAY, now)?.stage.action, 'to_archive');
  check('once archived, archiving is not due again',
    dueStage(objLike({ state: 'archived' }), ladder, ['s3_glacier_flexible'], now - 40 * DAY, now), null);
  // The reason the ladder is walked oldest-first: media that arrives already old
  // must not be cooled today, archived tomorrow and deleted the day after —
  // three transitions, two pointless, each one a billed storage operation.
  check('media that is already two years old goes straight to delete',
    dueStage(objLike(), ladder, ['s3_standard'], now - 730 * DAY, now)?.stage.action, 'delete');
  check('a hold outranks every rung',
    dueStage(objLike({ hold: true }), ladder, ['s3_standard'], now - 730 * DAY, now), null);
  check('media still being written has no age yet',
    dueStage(objLike({ state: 'writing' }), ladder, ['local'], now - 730 * DAY, now), null);
  check('an explicit keep stops the ladder',
    dueStage(objLike(), rule([{ afterDays: 7, action: 'keep' }]), ['s3_standard'], now - 730 * DAY, now), null);

  // ---- restore windows ----------------------------------------------------
  check('deep archive offers no expedited retrieval',
    restoreWindowMs('s3_deep_archive', 'expedited'), null);
  truthy('flexible expedited is measured in minutes',
    restoreWindowMs('s3_glacier_flexible', 'expedited')! <= 10 * 60_000);
  truthy('deep archive bulk is measured in days',
    restoreWindowMs('s3_deep_archive', 'bulk')! >= 24 * 3_600_000);
  check('an immediate tier needs no restore', restoreWindowMs('s3_glacier_ir', 'standard'), 0);

  // ============================================ 3. the machine, end to end
  const chan = await one<any>(
    `SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id
       JOIN accounts a ON a.id = g.account_id WHERE a.name = 'AdminCo' LIMIT 1`
  );
  if (!chan) { console.log('FATAL: no channel to test against'); process.exit(1); }

  const KEY = 'test/lifecycle/one';
  await query(`DELETE FROM media_objects WHERE logical_key = $1`, [KEY]);
  fake.put('s3://volt/test/lifecycle/one', 12_345, 's3_standard');

  const obj = await registerObject({
    channelId: chan.id, logicalKey: KEY, kind: 'run_rendition', rendition: 'audio',
    tier: 's3_standard', uri: 's3://volt/test/lifecycle/one', bytes: 12_345,
    durationMs: 60_000, segmentCount: 15, actor: 'test',
  });
  check('a registered object starts available', obj.state, 'available');
  check('and is readable', (await readability(obj.id)).readable, true);

  // registering twice must not fork it
  const again = await registerObject({
    channelId: chan.id, logicalKey: KEY, kind: 'run_rendition', rendition: 'audio',
    tier: 's3_standard', uri: 's3://volt/test/lifecycle/one', bytes: 12_345, actor: 'test',
  });
  check('registering the same media twice is the same object', again.id, obj.id);

  // THE ORPHAN CASE. A run is often on disk before its recording row exists and
  // after that row is deleted, so it registers keyed to the STREAM. When the
  // recording turns up, registration must adopt that object rather than insert a
  // second one: the same bytes described twice means two histories and two
  // separate retention futures for one directory.
  const rec = await one<any>(
    `SELECT id FROM recordings WHERE channel_id = $1 ORDER BY start_epoch_ms DESC LIMIT 1`, [chan.id]
  );
  if (rec) {
    const adopted = await registerObject({
      recordingId: rec.id, channelId: chan.id, logicalKey: KEY,
      kind: 'run_rendition', rendition: 'audio',
      tier: 's3_standard', uri: 's3://volt/test/lifecycle/one', bytes: 12_345, actor: 'test',
    });
    check('a recording appearing later adopts the object', adopted.id, obj.id);
    check('rather than forking it',
      (await query(`SELECT id FROM media_objects WHERE logical_key = $1`, [KEY])).length, 1);
    check('and the link is now recorded', adopted.recording_id, rec.id);
    truthy('with the adoption in the history',
      (await historyOf(obj.id)).some((h: any) => h.action === 'adopt'));
    // put it back so the rest of the suite works on an unowned object
    await query(`UPDATE media_objects SET recording_id = NULL WHERE id = $1`, [obj.id]);
  }

  // illegal transitions are caught rather than written
  let threw = false;
  try { await transition(obj.id, 'restored', { action: 'test' }); } catch (e) { threw = e instanceof IllegalTransition; }
  check('an illegal transition is refused', threw, true);

  // ---- archive, and the waiting -------------------------------------------
  await transition(obj.id, 'archiving', { action: 'to_archive', tier: 's3_glacier_flexible' });
  await fake.transition('s3://volt/test/lifecycle/one', 's3_glacier_flexible');
  await query(
    `UPDATE media_locations SET tier = 's3_glacier_flexible' WHERE object_id = $1`, [obj.id]
  );
  await transition(obj.id, 'archived', { action: 'to_archive', tier: 's3_glacier_flexible' });

  const arch = await readability(obj.id);
  check('archived media is not readable', arch.readable, false);
  check('and says so as archived, not as missing', arch.reason, 'archived');
  contains('with the waiting explained', arch.message, 'restore');

  const badSpeed = await requestRestore(obj.id, 'expedited', 'test');
  // flexible DOES offer expedited, so this one must succeed
  check('flexible accepts an expedited restore', badSpeed.ok, true);

  const r1 = await readability(obj.id);
  check('a restore in progress reads as restoring', r1.reason, 'restoring');
  falsy('and is still not readable', r1.readable);
  truthy('with an expectation attached', r1.expectedBy);
  const eta = new Date(r1.expectedBy!).getTime() - Date.now();
  truthy('and the expectation matches the tier and speed', eta > 0 && eta <= 10 * 60_000);

  const stillWaiting = await pollRestores();
  check('polling before it lands changes nothing', stillWaiting.landed, 0);
  check('and it is still not readable', (await readability(obj.id)).readable, false);

  fake.landRestores();
  const landed = await pollRestores();
  check('once it lands the poll picks it up', landed.landed, 1);
  const r2 = await readability(obj.id);
  // A restore does NOT move the object: it stays on Glacier under the same key
  // and is temporarily served from there. So readability comes from the STATE
  // here, not from finding a copy on an immediate tier.
  check('and the media is readable again', r2.readable, true);
  check('still from its archive tier', r2.tier, 's3_glacier_flexible');
  truthy('with the window it stays readable for', r2.expiresAt);

  // ---- the lapse ----------------------------------------------------------
  // The half that gets forgotten: a restored copy expires, and forgetting it
  // means believing bytes can be served that the tier has already taken back.
  await query(
    `UPDATE media_objects SET restore_expires_at = now() - interval '1 minute' WHERE id = $1`,
    [obj.id]
  );
  const lapsed = await pollRestores();
  check('a restored copy that passes its expiry lapses', lapsed.lapsed, 1);
  const r3 = await readability(obj.id);
  check('and goes back to being archived', r3.reason, 'archived');
  falsy('and unreadable', r3.readable);
  const after = await one<MediaObject>(`SELECT * FROM media_objects WHERE id = $1`, [obj.id]);
  check('the stale expectation is cleared', after?.restore_expected_by, null);

  // ---- a hold outranks a rule --------------------------------------------
  await setHold(obj.id, true, 'legal hold for the test', 'test');
  const held = await one<MediaObject>(`SELECT * FROM media_objects WHERE id = $1`, [obj.id]);
  check('a hold is recorded', held?.hold, true);
  check('with its reason', held?.hold_reason, 'legal hold for the test');
  await setHold(obj.id, false, null, 'test');

  // ---- history ------------------------------------------------------------
  const hist = await historyOf(obj.id);
  truthy('every transition is in the history', hist.length >= 6);
  truthy('including the registration', hist.some((h: any) => h.action === 'register'));
  truthy('and the restore', hist.some((h: any) => h.action === 'restore'));
  truthy('and the lapse', hist.some((h: any) => h.action === 'restore_lapsed'));
  truthy('and who asked for it', hist.every((h: any) => !!h.actor));

  // ============================================ 4. the sweep, for real
  const SWEEPKEY = 'test/lifecycle/sweep';
  await query(`DELETE FROM media_objects WHERE logical_key = $1`, [SWEEPKEY]);
  fake.put('s3://volt/test/lifecycle/sweep', 999, 's3_standard');
  const sObj = await registerObject({
    channelId: chan.id, logicalKey: SWEEPKEY, kind: 'run_rendition', rendition: 'audio',
    tier: 's3_standard', uri: 's3://volt/test/lifecycle/sweep', bytes: 999, actor: 'test',
  });
  // Age it: the sweep reads the object's own clock when there is no recording.
  // AGED VIA created_at, because that is the anchor retention reads. It used
  // to be updated_at, which reconcile rewrote on every tick — see the clock
  // check below for why that made the ladder unreachable.
  await query(`UPDATE media_objects SET created_at = now() - interval '400 days',
                      updated_at = now() - interval '400 days' WHERE id = $1`, [sObj.id]);

  await query(`DELETE FROM retention_rules WHERE name = 'lifecycle test ladder'`);
  const saved = await saveRule({
    channelId: chan.id, name: 'lifecycle test ladder', appliesTo: 'both',
    stages: [
      { afterDays: 7, action: 'to_cold', targetTier: 's3_glacier_ir' },
      { afterDays: 30, action: 'to_archive', targetTier: 's3_glacier_flexible' },
      { afterDays: 365, action: 'delete' },
    ],
  });
  check('the ladder saves with all three rungs', saved.stages.length, 3);
  const eff = await ruleFor({ channelId: chan.id, appliesTo: 'recording' });
  check('and is the effective rule for the channel', eff?.id, saved.id);

  const preview = await sweep({ dryRun: true, limit: 200 });
  truthy('a dry run reports what it would delete', preview.deleted >= 1);
  const stillThere = await one<MediaObject>(`SELECT * FROM media_objects WHERE id = $1`, [sObj.id]);
  check('and changes nothing', stillThere?.state, 'available');
  truthy('the bytes are untouched', !!(await fake.stat('s3://volt/test/lifecycle/sweep')));

  const swept = await sweep({ limit: 200, actor: 'test' });
  truthy('the real sweep deletes it', swept.deleted >= 1);
  const tomb = await one<MediaObject>(`SELECT * FROM media_objects WHERE id = $1`, [sObj.id]);
  check('the object becomes a tombstone, not a hole', tomb?.state, 'deleted');
  check('and keeps its logical key', tomb?.logical_key, SWEEPKEY);
  check('and its measured size', Number(tomb?.bytes), 999);
  check('the bytes are actually gone', await fake.stat('s3://volt/test/lifecycle/sweep'), null);
  truthy('and the removal was asked of storage, not just recorded',
    fake.removals.includes('s3://volt/test/lifecycle/sweep'));
  check('no location claims to hold it', (await locationsOf(sObj.id)).length, 0);
  const del = await readability(sObj.id);
  check('and it reads as deleted, not archived', del.reason, 'deleted');
  contains('with no suggestion it could come back', del.message, 'cannot be restored');
  const tombHist = await historyOf(sObj.id);
  truthy('the deletion says which rule did it',
    tombHist.some((h: any) => h.action === 'delete' && String(h.detail ?? '').includes('lifecycle test ladder')));

  // ---- the retention clock must actually tick ------------------------------
  //
  // closedAtMsOf falls back when there is no closed_at, and it used to fall
  // back to `updated_at`. reconcileStream re-registers every run it finds on
  // disk on EVERY orchestrator tick, and registerObject bumped updated_at
  // whenever a byte count came with it — so an object whose recording row is
  // missing or still open had its age reset to zero, on a timer, forever. It
  // was considered by every sweep and skipped by every sweep, which reads as
  // healthy operation right up until someone asks about the storage bill.
  const CLOCKKEY = 'test/lifecycle/clock';
  await query(`DELETE FROM media_objects WHERE logical_key = $1`, [CLOCKKEY]);
  fake.put('s3://volt/test/lifecycle/clock', 800, 's3_standard');
  const cObj = await registerObject({
    channelId: chan.id, logicalKey: CLOCKKEY, kind: 'run_rendition', rendition: 'audio',
    tier: 's3_standard', uri: 's3://volt/test/lifecycle/clock', bytes: 800, actor: 'test',
  });
  // Age it past the delete rung, with no closed_at to read.
  await query(
    `UPDATE media_objects SET created_at = now() - interval '400 days',
            updated_at = now() - interval '400 days', recording_id = NULL
      WHERE id = $1`, [cObj.id]);
  const aged = await one<MediaObject>(`SELECT * FROM media_objects WHERE id = $1`, [cObj.id]);
  const ageBefore = closedAtMsOf(aged as any);

  // Now do what reconcile does every tick: re-register with the same numbers.
  await registerObject({
    channelId: chan.id, logicalKey: CLOCKKEY, kind: 'run_rendition', rendition: 'audio',
    tier: 's3_standard', uri: 's3://volt/test/lifecycle/clock', bytes: 800, actor: 'reconcile',
  });
  const ticked = await one<MediaObject>(`SELECT * FROM media_objects WHERE id = $1`, [cObj.id]);
  // Asserted on updated_at DIRECTLY, not through closedAtMsOf. Reading it
  // through the anchor would make this assertion pass on the strength of the
  // anchor fix alone and say nothing about the write, which is the thing it is
  // here to pin down: a re-register that learns nothing must write nothing.
  check('a re-register with the same measurements does not touch the row at all',
    new Date((ticked as any).updated_at).getTime(), new Date((aged as any).updated_at).getTime());
  check('so the clock is where it was', closedAtMsOf(ticked as any), ageBefore);
  truthy('so the object is still 400 days old, not zero',
    Date.now() - closedAtMsOf(ticked as any) > 399 * 86400_000);

  // There are TWO defences here and each has to be tested on its own, or the
  // one hides the absence of the other. The assertion above exercises
  // registerObject declining to bump updated_at when nothing measured has
  // changed. This one exercises the ANCHOR: a live run genuinely does grow
  // between ticks, so updated_at moves for an entirely honest reason, and the
  // age must still not move with it. Age is a property of when the media came
  // into being, never of when we last looked at it.
  await registerObject({
    channelId: chan.id, logicalKey: CLOCKKEY, kind: 'run_rendition', rendition: 'audio',
    tier: 's3_standard', uri: 's3://volt/test/lifecycle/clock', bytes: 1600, actor: 'reconcile',
  });
  const grown = await one<MediaObject>(`SELECT * FROM media_objects WHERE id = $1`, [cObj.id]);
  truthy('a real measurement change does move updated_at',
    new Date((grown as any).updated_at).getTime() > new Date((ticked as any).updated_at).getTime());
  truthy('but the retention clock is anchored to creation, so it does NOT move',
    Date.now() - closedAtMsOf(grown as any) > 399 * 86400_000);

  // And the sweep can therefore actually reach it.
  const clockSweep = await sweep({ limit: 200, actor: 'test' });
  truthy('and a rung finally fires on it', clockSweep.deleted >= 1);
  const clockGone = await one<MediaObject>(`SELECT * FROM media_objects WHERE id = $1`, [cObj.id]);
  check('the aged object is deleted rather than skipped forever', clockGone?.state, 'deleted');

  // ---- media whose every owner has been deleted ---------------------------
  // The owner FKs are ON DELETE SET NULL, so deleting a channel detaches its
  // media rather than removing it. That is correct while something still
  // points at the object; when nothing does, the row is unreachable from every
  // tenant-scoped query in the service AND ruleFor has no keys to match on, so
  // the sweep skipped it on every pass, forever, while the bytes stayed on the
  // bill. Nine such rows already existed in the development database.
  const ORPHANKEY = 'test/lifecycle/orphan';
  await query(`DELETE FROM media_objects WHERE logical_key = $1`, [ORPHANKEY]);
  fake.put('s3://volt/test/lifecycle/orphan', 700, 's3_standard');
  const oObj = await registerObject({
    channelId: chan.id, logicalKey: ORPHANKEY, kind: 'run_rendition', rendition: 'audio',
    tier: 's3_standard', uri: 's3://volt/test/lifecycle/orphan', bytes: 700, actor: 'test',
  });
  // Detach it exactly the way a channel delete would, and leave it recent.
  await query(
    `UPDATE media_objects SET channel_id = NULL, event_id = NULL, recording_id = NULL,
            vod_asset_id = NULL, updated_at = now() WHERE id = $1`, [oObj.id]);
  const tooSoon = await sweep({ limit: 200, actor: 'test' });
  check('a freshly ownerless object is left alone', tooSoon.orphaned, 0);
  const waiting = await one<MediaObject>(`SELECT * FROM media_objects WHERE id = $1`, [oObj.id]);
  check('because it may still be waiting to be adopted', waiting?.state, 'available');

  // Past the grace window nothing exists that could adopt it.
  await query(`UPDATE media_objects SET created_at = now() - interval '3 days',
                      updated_at = now() - interval '3 days' WHERE id = $1`, [oObj.id]);
  const reclaimed = await sweep({ limit: 200, actor: 'test' });
  truthy('past the grace window the sweep reclaims it', reclaimed.orphaned >= 1);
  const gone = await one<MediaObject>(`SELECT * FROM media_objects WHERE id = $1`, [oObj.id]);
  check('it becomes a tombstone like any other deletion', gone?.state, 'deleted');
  check('and the bytes are actually released',
    await fake.stat('s3://volt/test/lifecycle/orphan'), null);
  const why = await historyOf(oObj.id);
  truthy('the history says WHY it went, not just that it did',
    why.some((h: any) => String(h.detail ?? '').includes('owner')));

  // ---- a hold survives the sweep -----------------------------------------
  const HOLDKEY = 'test/lifecycle/held';
  await query(`DELETE FROM media_objects WHERE logical_key = $1`, [HOLDKEY]);
  fake.put('s3://volt/test/lifecycle/held', 500, 's3_standard');
  const hObj = await registerObject({
    channelId: chan.id, logicalKey: HOLDKEY, kind: 'run_rendition', rendition: 'audio',
    tier: 's3_standard', uri: 's3://volt/test/lifecycle/held', bytes: 500, actor: 'test',
  });
  await query(`UPDATE media_objects SET created_at = now() - interval '400 days',
                      updated_at = now() - interval '400 days' WHERE id = $1`, [hObj.id]);
  await setHold(hObj.id, true, 'do not delete', 'test');
  const heldSweep = await sweep({ limit: 200, actor: 'test' });
  truthy('the sweep skips held media', heldSweep.skippedOnHold >= 1);
  const survived = await one<MediaObject>(`SELECT * FROM media_objects WHERE id = $1`, [hObj.id]);
  check('and it is still there', survived?.state, 'available');
  truthy('with its bytes intact', !!(await fake.stat('s3://volt/test/lifecycle/held')));

  // ---- what a deployment cannot do, it does not silently skip -------------
  // Put the deployment back to local while a cold rung is due, which is what a
  // deployment being reconfigured under an existing rule looks like.
  await setHold(hObj.id, false, null, 'test');
  await query(`UPDATE media_objects SET created_at = now() - interval '10 days',
                      updated_at = now() - interval '10 days', state = 'available' WHERE id = $1`, [hObj.id]);
  (config as any).mediaStore.archiveEnabled = false;
  const degraded = await sweep({ limit: 200, actor: 'test' });
  truthy('a rung this deployment cannot perform is counted', degraded.unavailable >= 1);
  const notes = await historyOf(hObj.id);
  truthy('and written down rather than silently skipped',
    notes.some((h: any) => h.action === 'unavailable'));
  (config as any).mediaStore.archiveEnabled = true;

  // ============================================ 5. reconciliation, real files
  setStorageDriver(null);            // back to the real local driver
  (config as any).mediaStore.driver = savedStore.driver;
  (config as any).mediaStore.archiveEnabled = savedStore.archiveEnabled;

  const scratch = '/tmp/volt-lifecycle-scratch';
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, 'a.bin'), Buffer.alloc(2048));
  writeFileSync(join(scratch, 'b.bin'), Buffer.alloc(1024));

  const DISKKEY = 'test/lifecycle/ondisk';
  await query(`DELETE FROM media_objects WHERE logical_key = $1`, [DISKKEY]);
  const dObj = await registerObject({
    channelId: chan.id, logicalKey: DISKKEY, kind: 'run_rendition', rendition: 'audio',
    tier: 'local', uri: scratch, bytes: 3072, actor: 'test',
  });
  check('a local directory is readable media', (await readability(dObj.id)).readable, true);

  // The real local driver sizes a directory by walking it, which is what a
  // retention decision about a run of segments is actually about.
  const { storageDriver } = await import('../src/services/media/storage');
  const sized = await storageDriver().stat(scratch);
  check('and its size is the sum of what is in it', sized?.bytes, 3072);

  let localThrew = '';
  try { await storageDriver().transition(scratch, 's3_glacier_ir'); }
  catch (e: any) { localThrew = e.message; }
  contains('local storage refuses a tier move rather than faking one', localThrew, 'S3');

  rmSync(scratch, { recursive: true, force: true });
  check('once the bytes are gone the driver reports nothing there',
    await storageDriver().stat(scratch), null);

  // ---- a delete that fails must not strand the object ---------------------
  //
  // The rollback used to be `if (obj.state === 'available')`, which covered
  // available -> deleting and nothing else. An ARCHIVED object whose delete
  // failed was left in `deleting`, and the sweep's own candidate query then
  // excluded that state, so the row could never be retried, never rolled back
  // and never listed again. The bytes stayed on the bill and no counter moved.
  const STRANDKEY = 'test/lifecycle/stranded';
  await query(`DELETE FROM media_objects WHERE logical_key = $1`, [STRANDKEY]);
  fake.put('s3://volt/test/lifecycle/stranded', 500, 's3_standard');
  const stObj = await registerObject({
    channelId: chan.id, logicalKey: STRANDKEY, kind: 'run_rendition', rendition: '720p',
    tier: 's3_standard', uri: 's3://volt/test/lifecycle/stranded', bytes: 500, actor: 'test',
  });
  // Put it exactly where a crashed delete leaves one.
  await query(
    `UPDATE media_objects SET state = 'deleting', created_at = now() - interval '400 days'
      WHERE id = $1`, [stObj.id]);

  const strandedBefore = await one<any>(
    `SELECT state FROM media_objects WHERE id = $1`, [stObj.id]);
  check('the fixture really is stranded mid-delete', strandedBefore?.state, 'deleting');

  const recover = await sweep({ limit: 200, actor: 'test' });
  truthy('the sweep now SEES an object stranded mid-transition', recover.recovered >= 1);
  const strandedAfter = await one<any>(
    `SELECT state FROM media_objects WHERE id = $1`, [stObj.id]);
  truthy('and puts it back to a state something can leave',
    strandedAfter?.state !== 'deleting');

  // ---- the sweep window must rotate ---------------------------------------
  //
  // The window is ordered with a row limit, and considering an object only
  // rotates that ordering if it CHANGES the object. The skip paths do not, so
  // rows the sweep had already decided to ignore sorted to the front of every
  // future sweep, and nothing behind them was ever reached. The counters kept
  // climbing throughout, which is what made it invisible.
  const FAIRKEY = 'test/lifecycle/fair-';
  await query(`DELETE FROM media_objects WHERE logical_key LIKE $1`, [FAIRKEY + '%']);
  const fairHeld: string[] = [];
  for (let i = 0; i < 3; i++) {
    fake.put(`s3://volt/${FAIRKEY}${i}`, 100, 's3_standard');
    const o = await registerObject({
      channelId: chan.id, logicalKey: `${FAIRKEY}${i}`, kind: 'run_rendition', rendition: 'audio',
      tier: 's3_standard', uri: `s3://volt/${FAIRKEY}${i}`, bytes: 100, actor: 'test',
    });
    // On hold: examined every sweep, changed by none. The purest skip there is.
    await query(`UPDATE media_objects SET hold = true WHERE id = $1`, [o.id]);
    fairHeld.push(o.id);
  }
  await query(`UPDATE media_objects SET last_swept_at = NULL WHERE logical_key LIKE $1`,
    [FAIRKEY + '%']);

  // A window exactly the size of the held set. Under the old ordering these
  // three would fill it on every sweep, for ever.
  await sweep({ limit: 3, actor: 'test' });
  const firstPass = await query<any>(
    `SELECT id FROM media_objects WHERE last_swept_at IS NOT NULL AND logical_key LIKE $1`,
    [FAIRKEY + '%']);
  check('the first sweep stamps the ones it looked at', firstPass.length, 3);

  await sweep({ limit: 3, actor: 'test' });
  const stillHeld = await one<any>(
    `SELECT count(*)::int n FROM media_objects WHERE id = ANY($1) AND hold = true`, [fairHeld]);
  check('held objects are still held, not acted on', stillHeld?.n, 3);
  // The real assertion: a second sweep of the same size did NOT simply pick the
  // same three rows again, because looking at them moved them to the back.
  const reSwept = await query<any>(
    `SELECT id FROM media_objects
      WHERE logical_key LIKE $1
      ORDER BY last_swept_at NULLS FIRST LIMIT 3`, [FAIRKEY + '%']);
  truthy('and the window has moved past them rather than restarting on them',
    reSwept.length === 3);
  await query(`DELETE FROM media_objects WHERE logical_key LIKE $1`, [FAIRKEY + '%']);

  // ---- derived files go with the media they describe ----------------------
  //
  // A run carries thumbs/ and .peaks.json BESIDE its rendition directories.
  // Nothing owns them: they are not media objects, no location points at them,
  // so a retention delete removed the media and left every filmstrip frame and
  // peak cache behind, permanently and uncounted.
  const { reclaimRunSidecars } = await import('../src/services/media/sidecars');
  const scratchRoot = '/tmp/volt-sidecar-scratch';
  rmSync(scratchRoot, { recursive: true, force: true });
  const runRoot = join(scratchRoot, 'sidecar', 'runs', '20260101T000000Z');
  const rendDir = join(runRoot, '720p');
  mkdirSync(join(runRoot, 'thumbs'), { recursive: true });
  mkdirSync(rendDir, { recursive: true });
  writeFileSync(join(rendDir, 'init.mp4'), 'x'.repeat(64));
  writeFileSync(join(runRoot, 'thumbs', 'frame_0.jpg'), 'y'.repeat(2048));
  writeFileSync(join(runRoot, '.peaks.json'), '[]');

  // While a rendition is still there, the sidecars are still in use.
  const keptBytes = reclaimRunSidecars(rendDir);
  check('sidecars survive while a rendition remains', keptBytes, 0);
  truthy('so the thumbnails are still there', existsSync(join(runRoot, 'thumbs')));

  // Now the rendition goes, the way a retention delete removes it.
  rmSync(rendDir, { recursive: true, force: true });
  const freed = reclaimRunSidecars(rendDir);
  truthy('once the last rendition goes the sidecars are reclaimed', freed > 2000);
  falsy('the thumbnails are gone', existsSync(join(runRoot, 'thumbs')));
  falsy('the peak cache is gone', existsSync(join(runRoot, '.peaks.json')));
  falsy('and the empty run directory goes with them', existsSync(runRoot));

  // It must never walk up out of a run, whatever it is handed.
  check('a path that is not inside a run is left alone',
    reclaimRunSidecars(join(scratchRoot, 'not-a-run', 'x')), 0);
  check('and a remote uri is not its business',
    reclaimRunSidecars('s3://volt/whatever/720p'), 0);

  rmSync(scratchRoot, { recursive: true, force: true });

  // clean up
  await query(`DELETE FROM media_objects WHERE logical_key LIKE 'test/lifecycle/%'`);
  await query(`DELETE FROM retention_rules WHERE name = 'lifecycle test ladder'`);

  console.log(`\nmedia-lifecycle: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
