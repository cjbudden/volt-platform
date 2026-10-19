/**
 * EPG PLACEMENT: the one place a copy, a repeat and the rolling top-up decide
 * what happens when an incoming programme meets what is already scheduled.
 *
 * Three rules, chosen by the operator, the same for every way in:
 *   replace  the incoming programme wins; whatever it overlaps is removed
 *            (the default: "make Tuesday look like Monday").
 *   skip     only fill empty time; an incoming programme that would overlap
 *            anything is left out.
 *   keep     add everything and let the overlaps show, as before.
 *
 * Whatever the rule, some programmes are never removed by a copy or repeat,
 * and the incoming one is skipped instead, with the reason:
 *   - anything that has started or aired (the as-run record),
 *   - anything with a VOD cut from it,
 *   - anything that came from an imported guide feed or the radio content log
 *     (the next import would only put it back, and fighting the feed is how
 *     guides get corrupted).
 * And an incoming programme that would start in the past is skipped.
 *
 * PREVIEW FIRST. dryRun returns exactly what applying would do, programme by
 * programme, without writing. The UI shows it before the button is pressed.
 *
 * UNDO. Applying records a batch: the ids it created, the full rows it
 * removed, the repeat it made. Undo deletes the one and restores the other.
 *
 * A removed repeat occurrence is written to its series' exdates, so the
 * rolling top-up never puts back something an operator replaced or deleted.
 */
import type { PoolClient } from 'pg';
import { pool, query, one, tx } from '../db';
import {
  RepeatRule, HORIZON_DAYS, addDays, datesFor, isExcluded, localDateOf, localTimeOf, localToUtc,
  ruleMatches, ruleToRrule, describeRule, localDayBounds,
} from './epgRepeat';

export type Policy = 'replace' | 'skip' | 'keep';
export type OwnerKind = 'channel' | 'event';
export interface Owner { kind: OwnerKind; id: string }
export const ownerCol = (k: OwnerKind) => (k === 'channel' ? 'channel_id' : 'event_id');

/** The fields a programme carries from a source onto a copy or repeat. */
export interface SlotFields {
  autoVod: boolean;
  geoMode: string;
  geoCountries: string[];
  replacementKind: string;
  replacementRef: string | null;
  metadata: Record<string, unknown>;
}

export interface Candidate extends SlotFields {
  title: string;
  startsAt: string;
  endsAt: string;
  /** Local calendar date it belongs to (for grouping the preview). */
  date: string;
  seriesId?: string;
  seriesKey?: string;
  sourceRef?: string;
  /** Pre-decided skip (e.g. "already on that day from its repeat"). */
  skipReason?: string;
}

export interface Outcome {
  date: string;
  title: string;
  startsAt: string;
  endsAt: string;
  result: 'add' | 'replace' | 'skip' | 'exists';
  replaces?: { id: string; title: string; startsAt: string; fromRepeat: boolean; same?: boolean }[];
  overlaps?: string[];
  reason?: string;
}

export interface Summary {
  added: number; replaced: number; takenOver: number; skipped: number; existing: number; overlapsKept: number;
  dates: number; firstDate: string | null; lastDate: string | null;
}

const ms = (v: string | Date) => new Date(v).getTime();

/** Why an existing programme may not be removed by a copy/repeat, or null. */
export function protectedReason(row: any, now = Date.now()): string | null {
  if (ms(row.starts_at) <= now) return 'has already started or aired';
  if (row.clip_asset_id || row.clip_status === 'firing' || row.clip_status === 'created') return 'has a VOD made from it';
  const ref: string | null = row.source_ref;
  if (ref && ref.startsWith('icy:')) return 'is part of the radio content log';
  if (ref && !ref.startsWith('series:')) return 'comes from an imported guide feed';
  return null;
}

export function fieldsOf(row: any): SlotFields {
  return {
    autoVod: !!row.auto_vod,
    geoMode: row.geo_mode ?? 'worldwide',
    geoCountries: row.geo_countries ?? [],
    replacementKind: row.replacement_kind ?? 'none',
    replacementRef: row.replacement_ref ?? null,
    metadata: row.metadata ?? {},
  };
}

/**
 * Decide each candidate against what is scheduled. Pure apart from reading the
 * existing rows, which the caller passes in (so tests can drive it directly).
 */
export function decide(cands: Candidate[], existing: any[], policy: Policy, now = Date.now()) {
  const live = new Map<string, any>(existing.map((r) => [r.id, r]));
  const removed = new Map<string, any>();
  const refs = new Set(existing.filter((r) => r.source_ref).map((r) => r.source_ref as string));
  const accepted: { s: number; e: number; title: string }[] = [];
  const outcomes: Outcome[] = [];
  const adds: Candidate[] = [];

  for (const c of [...cands].sort((a, b) => ms(a.startsAt) - ms(b.startsAt))) {
    const base = { date: c.date, title: c.title, startsAt: c.startsAt, endsAt: c.endsAt };
    if (c.sourceRef && refs.has(c.sourceRef)) { outcomes.push({ ...base, result: 'exists' }); continue; }
    if (c.skipReason) { outcomes.push({ ...base, result: 'skip', reason: c.skipReason }); continue; }
    if (ms(c.startsAt) <= now) { outcomes.push({ ...base, result: 'skip', reason: 'would start in the past' }); continue; }
    const s = ms(c.startsAt), e = ms(c.endsAt);
    const hits = [...live.values()].filter((r) => ms(r.starts_at) < e && s < ms(r.ends_at));
    // Overlaps with programmes added earlier in this same batch (a source day
    // that itself had overlaps) are carried, never resolved by deleting.
    const selfHits = accepted.filter((a) => a.s < e && s < a.e).map((a) => a.title);

    if (!hits.length) {
      outcomes.push({ ...base, result: 'add', ...(selfHits.length ? { overlaps: selfHits } : {}) });
      adds.push(c); accepted.push({ s, e, title: c.title });
      continue;
    }
    if (policy === 'keep') {
      outcomes.push({ ...base, result: 'add', overlaps: [...hits.map((h) => h.title), ...selfHits] });
      adds.push(c); accepted.push({ s, e, title: c.title });
      continue;
    }
    if (policy === 'skip') {
      outcomes.push({ ...base, result: 'skip', reason: `that time already has ${hits.map((h) => `"${h.title}"`).join(', ')}` });
      continue;
    }
    const blocked = hits.map((h) => ({ h, why: protectedReason(h, now) })).filter((x) => x.why);
    if (blocked.length) {
      outcomes.push({ ...base, result: 'skip', reason: `"${blocked[0].h.title}" ${blocked[0].why}` });
      continue;
    }
    for (const h of hits) { live.delete(h.id); removed.set(h.id, h); }
    outcomes.push({
      ...base, result: 'replace',
      // An identical programme (same title, same times) is not really being
      // replaced: the incoming one takes it over. Flagged so the preview does
      // not alarm anyone with "Lunch replaces Lunch".
      replaces: hits.map((h) => ({
        id: h.id, title: h.title, startsAt: new Date(h.starts_at).toISOString(), fromRepeat: !!h.series_id,
        ...(h.title === c.title && ms(h.starts_at) === s && ms(h.ends_at) === e ? { same: true } : {}),
      })),
      ...(selfHits.length ? { overlaps: selfHits } : {}),
    });
    adds.push(c); accepted.push({ s, e, title: c.title });
  }
  return { outcomes, adds, removed: [...removed.values()] };
}

export function summarise(outcomes: Outcome[]): Summary {
  const dates = [...new Set(outcomes.map((o) => o.date))].sort();
  return {
    added: outcomes.filter((o) => o.result === 'add' || o.result === 'replace').length,
    replaced: outcomes.reduce((n, o) => n + (o.replaces?.filter((r) => !r.same).length ?? 0), 0),
    takenOver: outcomes.reduce((n, o) => n + (o.replaces?.filter((r) => r.same).length ?? 0), 0),
    skipped: outcomes.filter((o) => o.result === 'skip').length,
    existing: outcomes.filter((o) => o.result === 'exists').length,
    overlapsKept: outcomes.filter((o) => o.overlaps?.length).length,
    dates: dates.length, firstDate: dates[0] ?? null, lastDate: dates[dates.length - 1] ?? null,
  };
}

/** Programmes of an owner overlapping a window (the ones a placement can meet). */
async function existingIn(c: PoolClient | null, owner: Owner, from: string, to: string) {
  const sql = `SELECT * FROM programmes WHERE ${ownerCol(owner.kind)}=$1 AND span && tstzrange($2,$3,'[)') AND status <> 'cancelled'`;
  const r = c ? (await c.query(sql, [owner.id, from, to])).rows : await query(sql, [owner.id, from, to]);
  return r as any[];
}

const INSERT_COLS = ['title', 'starts_at', 'ends_at', 'auto_vod', 'geo_mode', 'geo_countries', 'replacement_kind',
  'replacement_ref', 'metadata', 'source_ref', 'series_id', 'series_key', 'series_date'];

async function insertCandidate(c: PoolClient, owner: Owner, x: Candidate): Promise<string | null> {
  const col = ownerCol(owner.kind);
  const conflict = owner.kind === 'channel'
    ? `ON CONFLICT (channel_id, source_ref) WHERE source_ref IS NOT NULL DO NOTHING`
    : `ON CONFLICT (event_id, source_ref) WHERE source_ref IS NOT NULL AND event_id IS NOT NULL DO NOTHING`;
  const r = await c.query(
    `INSERT INTO programmes(${col}, ${INSERT_COLS.join(', ')})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14) ${conflict} RETURNING id`,
    [owner.id, x.title, x.startsAt, x.endsAt, x.autoVod, x.geoMode, x.geoCountries, x.replacementKind,
     x.replacementRef, JSON.stringify(x.metadata ?? {}), x.sourceRef ?? null, x.seriesId ?? null,
     x.seriesKey ?? null, x.seriesId ? x.date : null],
  );
  return r.rows[0]?.id ?? null;
}

/** Remove rows, writing repeat occurrences to their series' exdates. Returns the exdates added. */
export async function removeRows(c: PoolClient, rows: any[]) {
  const ex: { seriesId: string; value: string }[] = [];
  for (const r of rows) {
    await c.query('DELETE FROM programmes WHERE id=$1', [r.id]);
    if (r.series_id && r.series_key && r.series_date) {
      const value = `${dateOnly(r.series_date)}#${r.series_key}`;
      await c.query(`UPDATE programme_series SET exdates = array_append(exdates, $2), updated_at=now()
                      WHERE id=$1 AND NOT ($2 = ANY(exdates))`, [r.series_id, value]);
      ex.push({ seriesId: r.series_id, value });
    }
  }
  return ex;
}

export interface PlaceOpts {
  dryRun?: boolean;
  /** Present = record an undoable batch. */
  batch?: { accountId: string; action: string; label: string; userId?: string | null; seriesId?: string | null };
  client?: PoolClient;
  now?: number;
}

export interface PlaceResult {
  outcomes: Outcome[]; summary: Summary; createdIds: string[]; batchId: string | null;
}

/** Preview or apply a set of candidates on one owner. */
export async function place(owner: Owner, cands: Candidate[], policy: Policy, opts: PlaceOpts = {}): Promise<PlaceResult> {
  if (!cands.length) return { outcomes: [], summary: summarise([]), createdIds: [], batchId: null };
  const from = new Date(Math.min(...cands.map((c) => ms(c.startsAt)))).toISOString();
  const to = new Date(Math.max(...cands.map((c) => ms(c.endsAt)))).toISOString();

  const run = async (c: PoolClient | null) => {
    const existing = await existingIn(c, owner, from, to);
    const d = decide(cands, existing, policy, opts.now);
    if (opts.dryRun || !c) return { ...d, createdIds: [] as string[], batchId: null as string | null };
    const ex = await removeRows(c, d.removed);
    const createdIds: string[] = [];
    for (const a of d.adds) { const id = await insertCandidate(c, owner, a); if (id) createdIds.push(id); }
    let batchId: string | null = null;
    if (opts.batch && (createdIds.length || d.removed.length)) {
      const b = await c.query(
        `INSERT INTO epg_batches(account_id, owner_kind, owner_id, action, label, created_ids, removed, exdates_added, series_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10) RETURNING id`,
        [opts.batch.accountId, owner.kind, owner.id, opts.batch.action, opts.batch.label, createdIds,
         JSON.stringify(d.removed.map(rowForStore)), JSON.stringify(ex), opts.batch.seriesId ?? null, opts.batch.userId ?? null],
      );
      batchId = b.rows[0].id;
    }
    return { ...d, createdIds, batchId };
  };

  const r = opts.dryRun ? await run(null) : opts.client ? await run(opts.client) : await tx((c) => run(c));
  return { outcomes: r.outcomes, summary: summarise(r.outcomes), createdIds: r.createdIds, batchId: r.batchId };
}

// ===================================================================== series

export interface SeriesItem extends SlotFields {
  key: string;
  title: string;
  /** Local wall-clock start, HH:MM[:SS]. */
  at: string;
  durationMs: number;
}

export interface SeriesRow {
  id: string; channel_id: string | null; event_id: string | null; kind: 'programme' | 'day';
  title: string; items: SeriesItem[]; rule: RepeatRule; tz: string;
  start_date: string; until_date: string | null; exdates: string[]; policy: Policy;
  source_date: string | null; materialized_until: string | null;
}

/**
 * A DATE column as 'YYYY-MM-DD'. node-pg turns a DATE into a Date at LOCAL
 * midnight, so toISOString() moves it to the day before anywhere east of UTC
 * (Brisbane, Sydney, Kuala Lumpur...). Read the local parts instead.
 */
export function dateOnly(v: any): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const dstr = dateOnly;

/** A programme row as stored in an undo batch: its DATE kept as a date. */
export function rowForStore(r: any) {
  return r.series_date == null ? r : { ...r, series_date: dateOnly(r.series_date) };
}

export function normSeries(r: any): SeriesRow {
  return {
    ...r,
    start_date: dstr(r.start_date)!, until_date: dstr(r.until_date), source_date: dstr(r.source_date),
    materialized_until: dstr(r.materialized_until), exdates: r.exdates ?? [], items: r.items ?? [],
  };
}

export function ownerOfSeries(s: SeriesRow): Owner {
  return s.channel_id ? { kind: 'channel', id: s.channel_id } : { kind: 'event', id: s.event_id! };
}

export const seriesRef = (id: string, date: string, key: string) => `series:${id}:${date}:${key}`;

/** Candidates a series produces for dates in [from, to]. */
export function seriesCandidates(s: SeriesRow, from: string, to: string): Candidate[] {
  const out: Candidate[] = [];
  for (const date of datesFor(s.rule, s.start_date, from, to, s.until_date)) {
    for (const it of s.items) {
      if (isExcluded(s.exdates, date, it.key)) continue;
      const startsAt = localToUtc(date, it.at, s.tz);
      out.push({
        title: it.title, startsAt, endsAt: new Date(ms(startsAt) + it.durationMs).toISOString(), date,
        autoVod: it.autoVod, geoMode: it.geoMode, geoCountries: it.geoCountries, replacementKind: it.replacementKind,
        replacementRef: it.replacementRef, metadata: it.metadata, seriesId: s.id, seriesKey: it.key,
        sourceRef: seriesRef(s.id, date, it.key),
      });
    }
  }
  return out;
}

/** Does a series place this item on this date? (Used to skip copying a repeat onto itself.) */
export function seriesOccursOn(s: SeriesRow, date: string, key?: string): boolean {
  if (!s.rule || !s.start_date) return false;
  if (s.until_date && date > s.until_date) return false;
  return ruleMatches(s.rule, s.start_date, date) && !isExcluded(s.exdates, date, key);
}

/** The window an apply materializes now: start .. min(until, today + horizon). */
export function horizonEnd(s: { until_date: string | null }, tz: string, now = Date.now()): string {
  const h = addDays(localDateOf(new Date(now), tz), HORIZON_DAYS);
  return s.until_date && s.until_date < h ? s.until_date : h;
}

export interface NewSeries {
  owner: Owner; kind: 'programme' | 'day'; items: SeriesItem[]; rule: RepeatRule; tz: string;
  startDate: string; untilDate: string | null; policy: Policy; sourceDate: string | null;
}

/** A not-yet-saved series, for previews: same shape, placeholder id. */
export function draftSeries(n: NewSeries, id = '00000000-0000-0000-0000-000000000000'): SeriesRow {
  return {
    id, channel_id: n.owner.kind === 'channel' ? n.owner.id : null, event_id: n.owner.kind === 'event' ? n.owner.id : null,
    kind: n.kind, title: n.items[0]?.title ?? 'Repeat', items: n.items, rule: n.rule, tz: n.tz,
    start_date: n.startDate, until_date: n.untilDate, exdates: [], policy: n.policy, source_date: n.sourceDate,
    materialized_until: null,
  };
}

export async function insertSeries(c: PoolClient, n: NewSeries): Promise<SeriesRow> {
  const first = n.items[0];
  const title = n.kind === 'day' ? `Day repeat (${n.items.length} programmes)` : first.title;
  const r = await c.query(
    `INSERT INTO programme_series(channel_id, event_id, kind, title, rrule, duration_ms, dtstart, template, items, rule, tz,
                                  start_date, until_date, policy, source_date, materialized_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,NULL) RETURNING *`,
    [n.owner.kind === 'channel' ? n.owner.id : null, n.owner.kind === 'event' ? n.owner.id : null, n.kind, title,
     ruleToRrule(n.rule, n.untilDate), first.durationMs, localToUtc(n.startDate, first.at, n.tz),
     JSON.stringify(n.items), JSON.stringify(n.rule), n.tz, n.startDate, n.untilDate, n.policy, n.sourceDate],
  );
  return normSeries(r.rows[0]);
}

/** Materialize [from, to] of a series with its own policy; moves materialized_until on. */
export async function materialize(c: PoolClient, s: SeriesRow, from: string, to: string, opts: PlaceOpts = {}) {
  const cands = seriesCandidates(s, from, to);
  const res = await place(ownerOfSeries(s), cands, s.policy, { ...opts, client: c });
  await c.query(`UPDATE programme_series SET materialized_until = GREATEST(COALESCE(materialized_until, $2::date::timestamptz), $2::date::timestamptz), updated_at=now() WHERE id=$1`, [s.id, to]);
  return res;
}

/**
 * ROLLING TOP-UP, on the scheduler tick. An open-ended repeat keeps the guide
 * filled HORIZON_DAYS ahead; one with an end date fills to its end. Runs only
 * for series more than a week short of their horizon, a few per tick, and is
 * idempotent (source_ref), so a double run adds nothing.
 */
export async function topUpSeries(limit = 25, now = Date.now()): Promise<{ series: number; added: number }> {
  const rows = await query<any>(
    `SELECT * FROM programme_series
      WHERE rule IS NOT NULL AND jsonb_array_length(items) > 0
        AND (until_date IS NULL OR materialized_until IS NULL OR materialized_until::date < until_date)
        AND (materialized_until IS NULL OR materialized_until < now() + make_interval(days => $1))
      ORDER BY materialized_until NULLS FIRST LIMIT $2`,
    [HORIZON_DAYS - 7, limit],
  );
  let added = 0;
  for (const raw of rows) {
    const s = normSeries(raw);
    const from = s.materialized_until ? addDays(s.materialized_until, 1) : s.start_date;
    const to = horizonEnd(s, s.tz, now);
    if (from > to) continue;
    try {
      const r = await tx((c) => materialize(c, s, from, to, { now }));
      added += r.createdIds.length;
    } catch (e) {
      console.error('[epg] repeat top-up failed', s.id, e);
    }
  }
  return { series: rows.length, added };
}

/** Item a programme row represents, for building a repeat from it. */
export function itemFromRow(row: any, key: string, tz: string): SeriesItem {
  return {
    key, title: row.title, at: localTimeOf(row.starts_at, tz),
    durationMs: ms(row.ends_at) - ms(row.starts_at), ...fieldsOf(row),
  };
}

// --------------------------------------------------- editing a repeat

/** Change one item of a series and its future, not-individually-edited occurrences from a date. */
export async function applyItemChange(c: PoolClient, seriesId: string, key: string, patch: Partial<SeriesItem>, fromDate: string, now = Date.now()) {
  const s = normSeries((await c.query('SELECT * FROM programme_series WHERE id=$1 FOR UPDATE', [seriesId])).rows[0]);
  const items = s.items.map((it) => (it.key === key ? { ...it, ...patch, key } : it));
  const it = items.find((x) => x.key === key);
  if (!it) return { updated: 0, keptEdited: 0 };
  await c.query('UPDATE programme_series SET items=$2::jsonb, title=CASE WHEN kind=$3 THEN $4 ELSE title END, updated_at=now() WHERE id=$1',
    [seriesId, JSON.stringify(items), 'programme', it.title]);
  const occ = (await c.query(
    `SELECT id, series_date, series_detached FROM programmes WHERE series_id=$1 AND series_key=$2 AND series_date >= $3 AND starts_at > to_timestamp($4/1000.0)`,
    [seriesId, key, fromDate, now])).rows;
  let updated = 0, keptEdited = 0;
  for (const o of occ) {
    if (o.series_detached) { keptEdited++; continue; }
    const date = dstr(o.series_date)!;
    const startsAt = localToUtc(date, it.at, s.tz);
    await c.query(
      `UPDATE programmes SET title=$2, starts_at=$3, ends_at=$4, auto_vod=$5, geo_mode=$6, geo_countries=$7,
              replacement_kind=$8, replacement_ref=$9, metadata=$10::jsonb, updated_at=now() WHERE id=$1`,
      [o.id, it.title, startsAt, new Date(ms(startsAt) + it.durationMs).toISOString(), it.autoVod, it.geoMode,
       it.geoCountries, it.replacementKind, it.replacementRef, JSON.stringify(it.metadata ?? {})]);
    updated++;
  }
  return { updated, keptEdited };
}

/**
 * Split a series at a date: the original ends the day before, a copy carries on
 * from the date with the occurrences from then on. "This and following" edits
 * and deletes act on the copy, so the past stays exactly as it was.
 */
export async function splitSeries(c: PoolClient, seriesId: string, date: string): Promise<string> {
  const s = normSeries((await c.query('SELECT * FROM programme_series WHERE id=$1 FOR UPDATE', [seriesId])).rows[0]);
  if (date <= s.start_date) return s.id;
  const r = await c.query(
    `INSERT INTO programme_series(channel_id, event_id, kind, title, rrule, duration_ms, dtstart, template, items, rule, tz,
                                  start_date, until_date, exdates, policy, source_date, materialized_until)
     SELECT channel_id, event_id, kind, title, rrule, duration_ms, dtstart, template, items, rule, tz,
            $2::date, until_date, ARRAY(SELECT x FROM unnest(exdates) x WHERE left(x,10) >= $3), policy, source_date, materialized_until
       FROM programme_series WHERE id=$1 RETURNING id`, [seriesId, date, date]);
  const nid = r.rows[0].id as string;
  await c.query(`UPDATE programme_series SET until_date=$2::date - 1, rrule=$3, updated_at=now() WHERE id=$1`,
    [seriesId, date, ruleToRrule(s.rule, addDays(date, -1))]);
  await c.query(
    `UPDATE programmes SET series_id=$2::uuid, source_ref = CASE WHEN source_ref LIKE 'series:%' THEN 'series:' || $2::text || ':' || series_date::text || ':' || series_key ELSE source_ref END
      WHERE series_id=$1 AND series_date >= $3::date`, [seriesId, nid, date]);
  return nid;
}

/** Remove one item from a series and its future occurrences (from a date). Deletes an emptied series. */
export async function removeItem(c: PoolClient, seriesId: string, key: string, fromDate: string | null, now = Date.now()) {
  const s = normSeries((await c.query('SELECT * FROM programme_series WHERE id=$1 FOR UPDATE', [seriesId])).rows[0]);
  const del = await c.query(
    `DELETE FROM programmes WHERE series_id=$1 AND series_key=$2 AND starts_at > to_timestamp($3/1000.0)
        AND ($4::date IS NULL OR series_date >= $4::date) AND clip_asset_id IS NULL RETURNING id`,
    [seriesId, key, now, fromDate]);
  const items = s.items.filter((i) => i.key !== key);
  if (!items.length) await c.query('DELETE FROM programme_series WHERE id=$1', [seriesId]);
  else await c.query('UPDATE programme_series SET items=$2::jsonb, updated_at=now() WHERE id=$1', [seriesId, JSON.stringify(items)]);
  return { deleted: del.rowCount ?? 0, seriesDeleted: !items.length };
}

/** Human summary of a series for the drawer. */
export async function seriesInfo(id: string) {
  const raw = await one<any>('SELECT * FROM programme_series WHERE id=$1', [id]);
  if (!raw) return null;
  const s = normSeries(raw);
  const ahead = await one<any>(
    `SELECT count(*)::int AS n, max(starts_at) AS last FROM programmes WHERE series_id=$1 AND starts_at > now()`, [id]);
  return {
    id: s.id, kind: s.kind, title: s.title, rule: s.rule, tz: s.tz, startDate: s.start_date, untilDate: s.until_date,
    policy: s.policy, sourceDate: s.source_date, items: s.items.length, exdates: s.exdates.length,
    description: s.rule ? describeRule(s.rule, s.until_date) : 'Repeat',
    openEnded: !s.until_date, upcoming: ahead?.n ?? 0, lastScheduled: ahead?.last ?? null,
    channelId: s.channel_id, eventId: s.event_id,
  };
}

export { localDayBounds, localDateOf, localTimeOf, pool };
