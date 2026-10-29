// ============================================================================
//  RETENTION — the ladder, and the sweep that walks it.
//
//  What was here before was `DELETE FROM recordings WHERE expires_at < now()`
//  with a TODO where the storage cleanup should be. This replaces it with a
//  ladder of stages, each with an age and an action:
//
//      after 7 days   -> to_cold      cheaper storage, still readable
//      after 30 days  -> to_archive   needs a restore and a wait
//      after 365 days -> delete       gone, and the record says so
//
//  Three rules govern the whole thing, and each one exists because the obvious
//  implementation gets it wrong:
//
//  1. A LADDER IS ORDERED AND EACH RUNG FIRES ONCE. The sweep asks which stage
//     an object is DUE for given its age and its current state, not which stages
//     it has passed. A newly-registered object that is already a year old lands
//     on the last applicable rung directly instead of being cooled, then
//     archived, then deleted across three sweeps.
//
//  2. WHAT A DEPLOYMENT CANNOT DO, IT MAY NOT PROMISE. On local storage there is
//     one tier, so `to_cold` and `to_archive` are refused when the rule is
//     WRITTEN, with the reason. A rule that is accepted and silently never fires
//     is worse than one that is refused: it looks like a policy.
//
//  3. DELETION IS NOT FORGETTING. The bytes go; the media_objects row stays as a
//     tombstone with its logical key, its size and its history, so "what
//     happened to the 3rd of March" has an answer other than silence. The
//     provenance chain reaches through it to say what was cut from it, too.
// ============================================================================
import { one, query } from '../../db';
import { config } from '../../config';
import { capabilities, isImmediate, storageDriver, tierWords, actionWords, type StorageTier } from './storage';
import { locationsOf, transition, type MediaObject } from './objects';
import { reclaimRunSidecars } from './sidecars';

export type RetentionAction = 'keep' | 'to_cold' | 'to_archive' | 'delete';

export interface RetentionStage {
  id?: string;
  afterDays: number;
  action: RetentionAction;
  targetTier?: StorageTier | null;
}

export interface RetentionRule {
  id: string;
  account_id: string | null;
  channel_id: string | null;
  event_id: string | null;
  name: string;
  applies_to: 'recording' | 'asset' | 'both';
  enabled: boolean;
  stages: RetentionStage[];
}

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------
export type Validation = { ok: true } | { ok: false; code: string; message: string };

/**
 * Is this ladder writable on THIS deployment?
 *
 * Checked at write time on purpose. The alternative — accept anything, skip what
 * cannot be done at sweep time — produces a rule that reads like a policy, is
 * displayed like a policy, and does nothing, which is the failure mode that only
 * shows up on the day the storage bill or an audit asks about it.
 */
export function validateStages(stages: RetentionStage[]): Validation {
  const caps = capabilities();
  if (!stages.length) {
    return { ok: false, code: 'empty', message: 'A retention rule needs at least one stage.' };
  }
  const seen = new Set<number>();
  for (const s of stages) {
    if (!Number.isInteger(s.afterDays) || s.afterDays < 0) {
      return { ok: false, code: 'bad_age', message: `"${s.afterDays}" is not a number of days.` };
    }
    if (seen.has(s.afterDays)) {
      return { ok: false, code: 'duplicate_age',
        message: `Two stages both fire at ${s.afterDays} days. Each stage needs its own age.` };
    }
    seen.add(s.afterDays);

    if (!caps.actions.includes(s.action)) {
      return { ok: false, code: 'action_unavailable',
        message: `${actionWords(s.action)} is not available on this Volt service. ` +
                 (caps.archiveUnavailableReason ?? '') +
                 ` Available actions: ${caps.actions.map(actionWords).join(', ')}.` };
    }
    if (s.targetTier && !caps.tiers.includes(s.targetTier)) {
      return { ok: false, code: 'tier_unavailable',
        message: `The tier ${tierWords(s.targetTier)} is not available here. Available: ${caps.tiers.map(tierWords).join(', ')}.` };
    }
    if (s.action === 'to_cold' && s.targetTier && !isImmediate(s.targetTier)) {
      return { ok: false, code: 'not_a_cold_tier',
        message: `${tierWords(s.targetTier)} needs a restore before it can be read, so it is an archive tier, not cheaper storage. ` +
                 `Choose Archive, or pick a tier that reads immediately.` };
    }
    if (s.action === 'to_archive' && s.targetTier && isImmediate(s.targetTier)) {
      return { ok: false, code: 'not_an_archive_tier',
        message: `${tierWords(s.targetTier)} reads immediately, so it is cheaper storage, not an archive. Choose Move to cheaper storage.` };
    }
  }

  // A ladder must not go backwards: archiving something and then cooling it a
  // month later describes an intent the storage cannot carry out.
  const ordered = [...stages].sort((a, b) => a.afterDays - b.afterDays);
  const RANK: Record<RetentionAction, number> = { keep: 0, to_cold: 1, to_archive: 2, delete: 3 };
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1], cur = ordered[i];
    if (prev.action === 'keep') continue;
    if (RANK[cur.action] < RANK[prev.action]) {
      return { ok: false, code: 'backwards',
        message: `A ladder cannot go backwards: ${actionWords(prev.action)} at ${prev.afterDays} days is followed by ` +
                 `${actionWords(cur.action)} at ${cur.afterDays} days.` };
    }
    if (RANK[cur.action] === RANK[prev.action] && cur.action !== 'keep') {
      return { ok: false, code: 'repeated',
        message: `${actionWords(cur.action)} is already the stage at ${prev.afterDays} days; repeating it at ` +
                 `${cur.afterDays} days does nothing.` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
//  Reading rules
// ---------------------------------------------------------------------------
async function stagesOf(ruleId: string): Promise<RetentionStage[]> {
  const rows = await query<any>(
    `SELECT id, after_days, action, target_tier FROM retention_stages
      WHERE rule_id = $1 ORDER BY after_days`, [ruleId]
  );
  return rows.map((r) => ({
    id: r.id, afterDays: r.after_days, action: r.action, targetTier: r.target_tier,
  }));
}

async function withStages(rows: any[]): Promise<RetentionRule[]> {
  const out: RetentionRule[] = [];
  for (const r of rows) out.push({ ...r, stages: await stagesOf(r.id) });
  return out;
}

/**
 * The rule that governs a channel, most specific first.
 *
 * Channel beats account. There is no merging: a channel with its own rule uses
 * it entirely, because a half-inherited ladder is impossible to reason about
 * from a UI and impossible to explain when it deletes something.
 */
export async function ruleFor(
  opts: { channelId?: string | null; eventId?: string | null; accountId?: string | null; appliesTo?: 'recording' | 'asset' }
): Promise<RetentionRule | null> {
  const kind = opts.appliesTo ?? 'recording';
  const scopes: [string, string | null][] = [
    ['channel_id', opts.channelId ?? null],
    ['event_id', opts.eventId ?? null],
    ['account_id', opts.accountId ?? null],
  ];
  for (const [col, id] of scopes) {
    if (!id) continue;
    const row = await one<any>(
      `SELECT * FROM retention_rules
        WHERE ${col} = $1 AND enabled AND (applies_to = $2 OR applies_to = 'both')
        ORDER BY created_at LIMIT 1`,
      [id, kind]
    );
    if (row) return { ...row, stages: await stagesOf(row.id) };
  }
  return null;
}

export async function saveRule(opts: {
  ruleId?: string;
  /**
   * The account making the change. REQUIRED, and separate from `accountId`,
   * which says what the rule is scoped TO (null for a channel- or event-scoped
   * rule). The update used to be `WHERE id = $1` with nothing else: any
   * authenticated user who learned a rule id could rewrite another tenant's
   * ladder to "delete at 0 days" and the next sweep would destroy that
   * tenant's media, attributed to `retention:sweep`. A retention rule is the
   * most destructive object in the system and it was the least protected.
   */
  actingAccountId: string;
  accountId?: string | null;
  channelId?: string | null;
  eventId?: string | null;
  name: string;
  appliesTo?: 'recording' | 'asset' | 'both';
  enabled?: boolean;
  stages: RetentionStage[];
}): Promise<RetentionRule> {
  const v = validateStages(opts.stages);
  if (!v.ok) throw Object.assign(new Error(v.message), { code: v.code, status: 400 });

  const rule = opts.ruleId
    ? await one<any>(
        // Reachable two ways, matching listRules: the rule is account-scoped
        // to the caller, or it hangs off a channel/event the caller owns.
        `UPDATE retention_rules r
            SET name = $3, applies_to = $4, enabled = $5, updated_at = now()
           FROM (SELECT r2.id FROM retention_rules r2
                   LEFT JOIN channels c ON c.id = r2.channel_id
                   LEFT JOIN events   e ON e.id = r2.event_id
                   LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
                  WHERE r2.id = $1 AND (r2.account_id = $2 OR g.account_id = $2)) owned
          WHERE r.id = owned.id
        RETURNING r.*`,
        [opts.ruleId, opts.actingAccountId, opts.name,
         opts.appliesTo ?? 'recording', opts.enabled ?? true]
      )
    : await one<any>(
        `INSERT INTO retention_rules (account_id, channel_id, event_id, name, applies_to, enabled)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [opts.accountId ?? null, opts.channelId ?? null, opts.eventId ?? null,
         opts.name, opts.appliesTo ?? 'recording', opts.enabled ?? true]
      );
  // An update that matched nothing means the rule is not the caller's. Same
  // answer as a rule that does not exist: ownership is not disclosed.
  if (!rule && opts.ruleId) {
    throw Object.assign(new Error('Retention rule not found'), { status: 404 });
  }
  if (!rule) throw new Error('failed to save retention rule');

  await query(`DELETE FROM retention_stages WHERE rule_id = $1`, [rule.id]);
  for (const s of opts.stages) {
    await query(
      `INSERT INTO retention_stages (rule_id, after_days, action, target_tier)
       VALUES ($1,$2,$3::retention_action,$4::storage_tier)`,
      [rule.id, s.afterDays, s.action, s.targetTier ?? null]
    );
  }
  return { ...rule, stages: await stagesOf(rule.id) };
}

export async function listRules(accountId: string): Promise<RetentionRule[]> {
  const rows = await query<any>(
    `SELECT r.* FROM retention_rules r
       LEFT JOIN channels c ON c.id = r.channel_id
       LEFT JOIN events   e ON e.id = r.event_id
       LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE r.account_id = $1 OR g.account_id = $1
      ORDER BY r.created_at`,
    [accountId]
  );
  return withStages(rows);
}

// ---------------------------------------------------------------------------
//  Deciding what is due
// ---------------------------------------------------------------------------
export interface Due {
  stage: RetentionStage;
  /** Where the bytes should end up, resolved against this deployment's tiers. */
  tier: StorageTier | null;
  ageDays: number;
}

/** The state a completed action leaves an object in, used to skip done rungs. */
const SATISFIED_BY: Record<RetentionAction, (obj: MediaObject, tiers: StorageTier[]) => boolean> = {
  keep: () => true,
  to_cold: (_o, tiers) => tiers.some((t) => t !== 'local' && t !== 's3_standard'),
  to_archive: (o) => o.state === 'archived' || o.state === 'archiving'
    || o.state === 'restoring' || o.state === 'restored',
  delete: (o) => o.state === 'deleted' || o.state === 'deleting',
};

/**
 * Which rung, if any, this object is due for.
 *
 * Walks the ladder from the OLDEST applicable stage downward and returns the
 * first one whose age has passed and whose effect is not already in place. That
 * ordering is what makes a year-old object land on `delete` directly instead of
 * being cooled today, archived next sweep and deleted the sweep after — three
 * transitions, two of them pointless, each one a billed storage operation.
 */
export function dueStage(
  obj: MediaObject, rule: RetentionRule, tiers: StorageTier[],
  /** When the media stopped being written. The retention clock starts HERE, not
   *  at the row's creation: a recording that ran for eighteen hours is one day
   *  old when it closes, not when it opened. */
  closedAtMs: number,
  nowMs = Date.now()
): Due | null {
  if (obj.hold) return null;
  if (obj.state === 'deleted' || obj.state === 'deleting') return null;
  // Media still being written has no age yet: its clock starts when it closes.
  if (obj.state === 'pending' || obj.state === 'writing') return null;
  if (!Number.isFinite(closedAtMs) || closedAtMs <= 0) return null;

  const ageDays = (nowMs - closedAtMs) / 86_400_000;
  if (ageDays < 0) return null;

  const caps = capabilities();
  const ordered = [...rule.stages].sort((a, b) => b.afterDays - a.afterDays);  // oldest first
  for (const stage of ordered) {
    if (ageDays < stage.afterDays) continue;
    if (stage.action === 'keep') return null;          // an explicit stop
    if (SATISFIED_BY[stage.action](obj, tiers)) return null;  // already done, and nothing older is due
    const tier = stage.targetTier
      ?? (stage.action === 'to_cold' ? caps.defaultColdTier
        : stage.action === 'to_archive' ? caps.defaultArchiveTier
        : null);
    if (stage.action !== 'delete' && !tier) return null;   // nothing to move it to here
    return { stage, tier, ageDays };
  }
  return null;
}

/**
 * When the retention clock started for a row from the sweep's query.
 *
 * A recording's own end time when it has one. Otherwise the object's last
 * update, which for a closed object is when it last transitioned — never its
 * creation, because a run registered at the moment it opened would start ageing
 * while it was still being written to.
 */
export function closedAtMsOf(row: { closed_at?: string | null; updated_at?: string | null; created_at?: string | null }): number {
  const t = row.closed_at ? new Date(row.closed_at).getTime() : 0;
  if (t > 0) return t;
  // FALL BACK TO created_at, NOT updated_at.
  //
  // The age of media is about WHEN IT STOPPED BEING WRITTEN, and updated_at is
  // not that: reconcileStream re-registers every run it finds on disk on every
  // orchestrator tick, and registerObject touched updated_at whenever a byte
  // count came with it. So any object without a usable closed_at — one whose
  // recording row is missing, or is still open — had its retention clock reset
  // to `now` every tick. It aged at zero. No rung ever fired, no cool, no
  // archive, no delete, and the counters showed it being considered on every
  // pass and skipped every time, which looks exactly like healthy operation.
  //
  // created_at never moves, so the clock actually runs. Objects that ARE still
  // being written are excluded from the sweep by state (`writing`, `pending`),
  // so anchoring on creation cannot age out a live run.
  return row.created_at ? new Date(row.created_at).getTime() : 0;
}

// ---------------------------------------------------------------------------
//  The sweep
// ---------------------------------------------------------------------------
export interface SweepResult {
  considered: number;
  cooled: number;
  archived: number;
  deleted: number;
  skippedOnHold: number;
  failed: number;
  /** Actions a rule asked for that this deployment cannot perform. Reported
   *  rather than swallowed, because silence here reads as "nothing was due". */
  unavailable: number;
  /** Objects reclaimed because every owner they had has been deleted. */
  orphaned: number;
  /** Bytes reclaimed from per-run derived files (thumbnails, peak caches) that
   *  no media object owns and nothing else would ever remove. */
  sidecarBytes: number;
  /** Objects found stranded mid-transition by an earlier failed sweep and put
   *  back to a state something knows how to leave. Reported because a number
   *  that is persistently non-zero means storage is failing, not that recovery
   *  is working. */
  recovered: number;
}

/**
 * How long an object may sit with no owner before the sweep reclaims it.
 *
 * Not zero, because there is a legitimate window where an object has no owner
 * yet: the encoder registers media for a run before the recording row exists,
 * and adoption attaches it afterwards (migration 0008). Reclaiming instantly
 * would delete media that was about to be adopted. A day is far longer than
 * that window and far shorter than "forever".
 */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Walk the ladder for every object with a rule.
 *
 * Bounded per pass on purpose: a first sweep over a long-neglected archive could
 * otherwise queue tens of thousands of storage operations in one tick.
 */
export async function sweep(opts: {
  limit?: number; actor?: string; dryRun?: boolean;
  /**
   * Confine the pass to ONE account. The background sweep leaves this unset
   * and walks the platform, which is right for a scheduler. It is not right
   * for the tenant-facing preview endpoint, which was reporting counts drawn
   * from every other customer's media.
   */
  accountId?: string;
} = {}): Promise<SweepResult> {
  const limit = opts.limit ?? 500;
  const actor = opts.actor ?? 'retention';
  const res: SweepResult = {
    considered: 0, cooled: 0, archived: 0, deleted: 0,
    skippedOnHold: 0, failed: 0, unavailable: 0, orphaned: 0, recovered: 0, sidecarBytes: 0 };
  const caps = capabilities();
  const driver = storageDriver();

  const objects = await query<any>(
    `SELECT o.*, o.updated_at, r.end_epoch_ms, r.channel_id AS rec_channel, r.event_id AS rec_event, r.delete_after,
            v.channel_id AS asset_channel, v.event_id AS asset_event,
            COALESCE(gc.account_id, ge.account_id) AS account_id,
            to_timestamp(COALESCE(r.end_epoch_ms, 0)/1000.0) AS closed_at
       FROM media_objects o
       LEFT JOIN recordings r ON r.id = o.recording_id
       LEFT JOIN vod_assets v ON v.id = o.vod_asset_id
       LEFT JOIN channels c ON c.id = COALESCE(o.channel_id, r.channel_id, v.channel_id)
       LEFT JOIN events   e ON e.id = COALESCE(o.event_id, r.event_id, v.event_id)
       LEFT JOIN groups  gc ON gc.id = c.group_id
       LEFT JOIN groups  ge ON ge.id = e.group_id
      -- 'deleting' is BACK IN. It used to be excluded, which meant an object
      -- whose delete failed halfway sat in 'deleting' where this query could
      -- never see it again: it could not be retried, could not be rolled back,
      -- and reconcile ignores it too. A transitional state is exactly what a
      -- sweep should pick up, because it means a previous sweep did not finish.
      WHERE o.state NOT IN ('deleted', 'pending', 'writing')
        AND ($2::uuid IS NULL
             OR gc.account_id = $2 OR ge.account_id = $2
             -- An ownerless object belongs to nobody, so a tenant-scoped pass
             -- must not see it. The platform-wide pass still reclaims it.
            )
      -- FAIRNESS. Ordering by updated_at only rotates the window if looking at
      -- an object changes it, and the skip paths do not touch it, so skipped
      -- rows sorted to the front of every future sweep and nothing behind them
      -- was ever reached. last_swept_at records that we LOOKED; never swept
      -- sorts first because it is the most overdue thing there is.
      ORDER BY o.last_swept_at NULLS FIRST, o.updated_at
      LIMIT $1`,
    [limit, opts.accountId ?? null]
  );

  // STAMPED UP FRONT, for every candidate, whatever happens to it next. Doing
  // it per-outcome would mean every `continue` in this loop is a chance to
  // forget one, and forgetting one puts that object back at the head of the
  // next window permanently. Deliberately not touching updated_at: that is the
  // object's own modification time and the retention clock's fallback anchor.
  if (!opts.dryRun && objects.length) {
    await query(
      `UPDATE media_objects SET last_swept_at = now() WHERE id = ANY($1)`,
      [objects.map((o: any) => o.id)]
    );
  }

  for (const obj of objects) {
    res.considered++;
    if (obj.hold) { res.skippedOnHold++; continue; }
    // Another object of the same run may have taken this one with it (pruneRun handles a
    // whole run at once), so look again rather than trust the snapshot above.
    if (!opts.dryRun && obj.recording_id) {
      const now = await one<any>(`SELECT state, hold FROM media_objects WHERE id = $1`, [obj.id]);
      if (!now || now.state === 'deleted') continue;
      if (now.hold) { res.skippedOnHold++; continue; }
    }

    // ---- an object a previous sweep left mid-transition --------------------
    // `deleting` or `archiving` means something crashed or errored between the
    // state change and the storage call. Put it back to a state that can be
    // left, so the next sweep can try the rung again from a clean footing.
    if (obj.state === 'deleting' || obj.state === 'archiving') {
      if (opts.dryRun) { res.considered--; continue; }
      const locs = await locationsOf(obj.id);
      const back = locs.some((l) => l.present && l.tier !== 'local') && obj.state === 'archiving'
        ? 'archived' : (locs.some((l) => l.present) ? 'available' : 'deleted');
      await transition(obj.id, back as any, {
        action: 'rollback', actor,
        detail: `recovered from a stranded ${obj.state}`,
      }).catch((e) => console.error(`[retention] could not recover ${obj.id} from ${obj.state}`, e));
      res.recovered++;
      continue;
    }

    // ---- media whose every owner has been deleted --------------------------
    // The owner FKs are ON DELETE SET NULL so media outlives its recording,
    // which is right while SOMETHING still points at it. When nothing does,
    // the object becomes unreachable: every read path in the service scopes
    // media through a channel or an event to a group to an account, so a row
    // with all four owner columns null cannot be listed, cannot be restored,
    // and — because ruleFor has no keys to match on — was skipped by this
    // sweep forever. The bytes stayed on disk, and in the bill, permanently.
    //
    // Nothing references it, so nothing can want it. Reclaim it.
    const ownerless = !obj.channel_id && !obj.event_id && !obj.recording_id && !obj.vod_asset_id;
    if (ownerless) {
      const idleMs = Date.now() - new Date(obj.updated_at).getTime();
      if (idleMs < ORPHAN_GRACE_MS) continue;   // may still be adopted
      if (opts.dryRun) { res.orphaned++; continue; }
      try {
        await transition(obj.id, 'deleting', { action: 'delete', actor, detail: 'no owner' });
        for (const l of await locationsOf(obj.id)) {
          await driver.remove(l.uri);
          // The run's derived files are nobody's media object, so nothing else
          // would ever remove them. See services/media/sidecars.ts.
          res.sidecarBytes += reclaimRunSidecars(l.uri);
          await query(`UPDATE media_locations SET present = false, removed_at = now() WHERE id = $1`, [l.id]);
        }
        await transition(obj.id, 'deleted', {
          action: 'delete', actor,
          detail: 'every owner was deleted; the object was unreachable from any account',
        });
        res.orphaned++;
      } catch (e) {
        res.failed++;
        console.error('[retention] orphan reclaim failed for', obj.id, e);
      }
      continue;
    }

    const rule = await ruleFor({
      channelId: obj.channel_id ?? obj.rec_channel ?? obj.asset_channel,
      eventId: obj.event_id ?? obj.rec_event ?? obj.asset_event,
      accountId: obj.account_id,
      appliesTo: obj.vod_asset_id ? 'asset' : 'recording',
    });
    // AN EXPIRY SET BY HAND (recordings.delete_after) wins over the rule's delete rung,
    // earlier or later, and applies to a recording no rule governs too.
    const manual = obj.recording_id && obj.delete_after ? new Date(obj.delete_after).getTime() : null;
    if (manual != null && manual <= Date.now() && obj.state !== 'deleting') {
      if (opts.dryRun) { res.deleted++; continue; }
      try {
        if (await removeRecordingMedia(obj, `expiry set by hand for ${new Date(manual).toISOString().slice(0, 10)}`, actor)) { res.deleted++; continue; }
      } catch (e) { res.failed++; console.error('[retention] manual expiry failed for', obj.id, e); continue; }
    }
    if (!rule) continue;

    const locs = await locationsOf(obj.id);
    const due = dueStage(obj, rule, locs.map((l) => l.tier), closedAtMsOf(obj));
    if (!due) continue;
    if (due.stage.action === 'delete' && manual != null && manual > Date.now()) continue;   // kept longer by hand

    if (due.stage.action !== 'delete' && !caps.archiveEnabled) {
      // The rule asked for something this deployment cannot do. Rules are
      // validated at write time, so reaching here means the deployment changed
      // under an existing rule — worth counting and worth logging, never worth
      // silently skipping.
      res.unavailable++;
      await query(
        `INSERT INTO media_events (object_id, from_state, to_state, action, actor, detail)
         VALUES ($1, $2::media_state, $2::media_state, 'unavailable', $3, $4)`,
        [obj.id, obj.state, actor,
         `rule "${rule.name}" asks for ${due.stage.action} at ${due.stage.afterDays} days, ` +
         `which this deployment cannot do: ${caps.archiveUnavailableReason ?? 'no archive'}`]
      );
      continue;
    }

    if (opts.dryRun) {
      if (due.stage.action === 'delete') res.deleted++;
      else if (due.stage.action === 'to_archive') res.archived++;
      else res.cooled++;
      continue;
    }

    try {
      if (due.stage.action === 'delete') {
        // A recording's run on local disk goes through the clip-aware prune: what clips
        // were cut from stays (held), the rest goes to the restore bin.
        if (await removeRecordingMedia(obj, `retention rule "${rule.name}", ${due.stage.afterDays} days`, actor)) { res.deleted++; continue; }
        await transition(obj.id, 'deleting', { action: 'delete', actor, detail: `rule "${rule.name}"` });
        for (const l of locs) {
          await driver.remove(l.uri);
          // The run's derived files are nobody's media object, so nothing else
          // would ever remove them. See services/media/sidecars.ts.
          res.sidecarBytes += reclaimRunSidecars(l.uri);
          await query(
            `UPDATE media_locations SET present = false, removed_at = now() WHERE id = $1`, [l.id]
          );
        }
        await transition(obj.id, 'deleted', {
          action: 'delete', actor,
          detail: `rule "${rule.name}", stage ${due.stage.afterDays}d, age ${due.ageDays.toFixed(1)}d`,
        });
        res.deleted++;
        continue;
      }

      const target = due.tier!;
      // The copy to move is the one in object storage. A clip on an S3
      // deployment has a local copy too (built there, then uploaded), and
      // picking that one sent every cold or archive rung to the local driver,
      // which refuses, so the object failed the rung on every sweep. The
      // local copy stays until a delete rung removes every location.
      const source = locs.find((l) => l.present && l.tier !== 'local') ?? locs.find((l) => l.present) ?? locs[0];
      if (!source) continue;

      if (due.stage.action === 'to_archive') {
        await transition(obj.id, 'archiving', { action: 'to_archive', actor, tier: target });
      }
      const placed = await driver.transition(source.uri, target);
      await query(
        `INSERT INTO media_locations (object_id, tier, uri, bytes, present, verified_at)
         VALUES ($1, $2::storage_tier, $3, $4, true, now())
         ON CONFLICT (object_id, tier) DO UPDATE
           SET uri = EXCLUDED.uri, bytes = EXCLUDED.bytes, present = true,
               removed_at = NULL, verified_at = now()`,
        [obj.id, target, placed.uri, placed.bytes]
      );
      if (source.tier !== target) {
        await query(
          `UPDATE media_locations SET present = false, removed_at = now()
            WHERE object_id = $1 AND tier = $2::storage_tier`,
          [obj.id, source.tier]
        );
      }

      if (due.stage.action === 'to_archive') {
        await transition(obj.id, 'archived', {
          action: 'to_archive', actor, tier: target,
          detail: `rule "${rule.name}", stage ${due.stage.afterDays}d`,
        });
        res.archived++;
      } else {
        // Cooling does not change readability, so the object stays `available`.
        // The tier moved; what the API may promise did not.
        await query(
          `INSERT INTO media_events (object_id, from_state, to_state, action, tier, actor, detail)
           VALUES ($1, $2::media_state, $2::media_state, 'to_cold', $3::storage_tier, $4, $5)`,
          [obj.id, obj.state, target, actor, `rule "${rule.name}", stage ${due.stage.afterDays}d`]
        );
        res.cooled++;
      }
    } catch (e: any) {
      res.failed++;
      const msg = String(e?.message ?? e).slice(0, 500);
      await query(`UPDATE media_objects SET last_error = $2, updated_at = now() WHERE id = $1`, [obj.id, msg]);
      // ROLL BACK TO WHATEVER IT WAS, not just to `available`.
      //
      // This used to be `if (obj.state === 'available')`, which covered
      // available -> archiving and available -> deleting and nothing else. An
      // ARCHIVED object whose delete failed was left sitting in `deleting`,
      // a state the candidate query then excluded, so it could never be
      // retried and never be seen: the bytes stayed, the row was unreachable,
      // and no counter moved. Rolling back to the state we found it in is
      // correct for every rung, and the transition table already refuses an
      // illegal one, so a genuinely impossible rollback is loud rather than
      // silent.
      const nowState = await one<any>(`SELECT state FROM media_objects WHERE id = $1`, [obj.id]);
      if (nowState && nowState.state !== obj.state) {
        await transition(obj.id, obj.state, { action: 'rollback', actor, error: msg })
          .catch((rollbackErr) => {
            console.error(
              `[retention] ${obj.id} FAILED AND COULD NOT ROLL BACK from ${nowState.state} to ${obj.state}`,
              rollbackErr
            );
          });
      }
      console.error(`[retention] ${obj.id} (${obj.logical_key}) failed:`, msg);
    }
  }
  return res;
}

/**
 * Remove a recording object's run through pruneRun (clips kept, the rest to the bin).
 * False when it is not a local run of a recording, so the caller removes it as before.
 */
async function removeRecordingMedia(obj: any, reason: string, actor: string): Promise<boolean> {
  const m = /^run\/([^/]+)\//.exec(obj.logical_key ?? '');
  const stream = obj.channel_id ?? obj.event_id ?? obj.rec_channel ?? obj.rec_event;
  if (!m || !stream || !obj.recording_id) return false;
  const locs = await locationsOf(obj.id);
  if (!locs.some((l) => l.tier === 'local')) return false;
  const { pruneRun } = await import('./prune');
  await pruneRun({ streamId: stream, runId: m[1], accountId: obj.account_id ?? null, recordingId: obj.recording_id, reason, actor });
  const left = await one<any>(`SELECT count(*)::int AS n FROM media_objects WHERE recording_id = $1 AND state <> 'deleted'`, [obj.recording_id]);
  if (!left?.n) await query(`UPDATE recordings SET storage_state = 'deleted' WHERE id = $1`, [obj.recording_id]);
  await refreshNextAction(obj.recording_id).catch(() => {});
  return true;
}

/** A default ladder for a new account, in the deployment's own terms. */
export function defaultLadder(): RetentionStage[] {
  const caps = capabilities();
  if (!caps.archiveEnabled) {
    // Nothing to cool onto, so the only honest ladder is keep-then-delete.
    return [{ afterDays: 90, action: 'delete' }];
  }
  return [
    { afterDays: 7, action: 'to_cold', targetTier: caps.defaultColdTier },
    { afterDays: 30, action: 'to_archive', targetTier: caps.defaultArchiveTier },
    { afterDays: 365, action: 'delete' },
  ];
}

/** Cache the next rung onto the recording, for the list view. */
export async function refreshNextAction(recordingId: string): Promise<void> {
  const obj = await one<any>(
    `SELECT o.*, to_timestamp(COALESCE(r.end_epoch_ms,0)/1000.0) AS closed_at,
            r.channel_id, r.event_id, r.delete_after
       FROM media_objects o JOIN recordings r ON r.id = o.recording_id
      WHERE o.recording_id = $1 ORDER BY o.created_at LIMIT 1`,
    [recordingId]
  );
  if (!obj) return;
  if (obj.delete_after) {   // an expiry set by hand is the next action, whatever the rule says
    await query(`UPDATE recordings SET next_action = 'delete', next_action_at = $2, storage_state = $3::media_state WHERE id = $1`,
      [recordingId, obj.delete_after, obj.state]);
    return;
  }
  const rule = await ruleFor({ channelId: obj.channel_id, eventId: obj.event_id, appliesTo: 'recording' });
  if (!rule) {
    await query(`UPDATE recordings SET next_action = NULL, next_action_at = NULL, storage_state = $2::media_state WHERE id = $1`,
      [recordingId, obj.state]);
    return;
  }
  const locs = await locationsOf(obj.id);
  const closed = closedAtMsOf(obj);
  // The next rung is the earliest stage still in the future. A stage whose time
  // has already passed is not "next": it is due now, and the sweep will take it.
  const ahead = [...rule.stages].sort((a, b) => a.afterDays - b.afterDays)
    .find((s) => s.action !== 'keep' && closed + s.afterDays * 86_400_000 > Date.now());
  await query(
    `UPDATE recordings SET next_action = $2::retention_action, next_action_at = $3, storage_state = $4::media_state
      WHERE id = $1`,
    [recordingId, ahead?.action ?? null,
     ahead ? new Date(closed + ahead.afterDays * 86_400_000) : null, obj.state]
  );
}
