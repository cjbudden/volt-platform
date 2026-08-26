// ============================================================================
//  DAYPARTS — named anchor points on a channel's local clock.
//
//  Decided: they have NO role in segmentation. Nothing is cut at a daypart
//  boundary, no job is created, no byte is written. They exist to jump the
//  timeline, pre-fill a clip range in one click, and group counts in reports.
//
//  Stored as a start time only. Each anchor runs to the next, so a set cannot
//  have a gap or an overlap because neither is representable — which is a better
//  guarantee than validating for them.
//
//  DEFAULTS ARE UK, by decision. The research found no universal boundaries —
//  Nielsen reports by time of day precisely because the trade disagrees — so the
//  presets below are the conventions of specific markets rather than a claim
//  about broadcasting in general. Sources are in the design doc.
// ============================================================================
import { query, one } from '../db';
import {
  broadcastDayBounds, instantOfLocalTimeInDay, type BroadcastDay,
} from './broadcastDay';

export interface DaypartDef {
  name: string;
  /** Local wall clock, HH:MM. */
  startsLocal: string;
  /** Bit 0 = Monday … bit 6 = Sunday. 127 = every day. */
  daysMask?: number;
}

export interface DaypartPreset {
  id: string;
  label: string;
  market: 'uk' | 'us' | 'none';
  appliesTo: 'radio' | 'tv' | 'any';
  dayparts: DaypartDef[];
}

const EVERY_DAY = 127;

export const DAYPART_PRESETS: DaypartPreset[] = [
  {
    id: 'radio_uk',
    label: 'Radio — UK',
    market: 'uk',
    appliesTo: 'radio',
    // UK commercial radio. Breakfast and drive are the peak slots.
    dayparts: [
      { name: 'Breakfast', startsLocal: '06:00' },
      { name: 'Mid-morning', startsLocal: '10:00' },
      { name: 'Afternoon', startsLocal: '13:00' },
      { name: 'Drive', startsLocal: '16:00' },
      { name: 'Evening', startsLocal: '19:00' },
      { name: 'Late', startsLocal: '22:00' },
      { name: 'Overnight', startsLocal: '01:00' },
    ],
  },
  {
    id: 'tv_uk',
    label: 'Television — UK',
    market: 'uk',
    appliesTo: 'tv',
    // UK TV time-bands: breakfast 06:00-09:30, daytime to 17:29, peak 17:30-22:59.
    dayparts: [
      { name: 'Breakfast', startsLocal: '06:00' },
      { name: 'Daytime', startsLocal: '09:30' },
      { name: 'Peak', startsLocal: '17:30' },
      { name: 'Late', startsLocal: '23:00' },
      { name: 'Overnight', startsLocal: '01:00' },
    ],
  },
  {
    id: 'radio_us',
    label: 'Radio — US (Nielsen Audio)',
    market: 'us',
    appliesTo: 'radio',
    dayparts: [
      { name: 'Morning drive', startsLocal: '06:00' },
      { name: 'Midday', startsLocal: '10:00' },
      { name: 'Afternoon drive', startsLocal: '15:00' },
      { name: 'Evening', startsLocal: '19:00' },
      { name: 'Overnight', startsLocal: '00:00' },
    ],
  },
  {
    id: 'tv_us',
    label: 'Television — US',
    market: 'us',
    appliesTo: 'tv',
    dayparts: [
      { name: 'Early morning', startsLocal: '06:00' },
      { name: 'Daytime', startsLocal: '10:00' },
      { name: 'Early fringe', startsLocal: '16:00' },
      { name: 'Access', startsLocal: '18:00' },
      { name: 'Prime', startsLocal: '20:00' },
      { name: 'Late fringe', startsLocal: '23:00' },
      { name: 'Overnight', startsLocal: '02:00' },
    ],
  },
  { id: 'none', label: 'None — clock and EPG only', market: 'none', appliesTo: 'any', dayparts: [] },
];

/** UK is the default market, by decision. */
export function defaultPresetFor(isRadio: boolean): string {
  return isRadio ? 'radio_uk' : 'tv_uk';
}

export function presetById(id: string): DaypartPreset | undefined {
  return DAYPART_PRESETS.find((p) => p.id === id);
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Validate a set before it is stored.
 *
 * Deliberately narrow: because there is no end time, the only things that CAN be
 * wrong are a malformed clock value, a duplicate anchor (two strips claiming the
 * same instant), or an empty name. Gaps and overlaps are unrepresentable.
 */
export function validateDayparts(defs: DaypartDef[]): { ok: true } | { ok: false; message: string } {
  const seen = new Set<string>();
  for (const d of defs) {
    if (!d.name?.trim()) return { ok: false, message: 'Every daypart needs a name.' };
    if (!HHMM.test(d.startsLocal)) {
      return { ok: false, message: `"${d.startsLocal}" is not a 24-hour time like 06:00.` };
    }
    const key = `${d.startsLocal}|${d.daysMask ?? EVERY_DAY}`;
    if (seen.has(key)) {
      return { ok: false, message: `Two dayparts both start at ${d.startsLocal} on the same days.` };
    }
    seen.add(key);
  }
  return { ok: true };
}

export async function getDayparts(channelId: string): Promise<DaypartDef[]> {
  const rows = await query<any>(
    `SELECT name, to_char(starts_local, 'HH24:MI') AS starts_local, days_mask
       FROM dayparts WHERE channel_id = $1 ORDER BY ordinal`, [channelId]
  );
  return rows.map((r) => ({ name: r.name, startsLocal: r.starts_local, daysMask: r.days_mask }));
}

/** Replace a channel's set. Ordering is derived from the anchor times. */
export async function setDayparts(
  channelId: string, defs: DaypartDef[], presetId?: string
): Promise<DaypartDef[]> {
  const v = validateDayparts(defs);
  if (!v.ok) throw new Error(v.message);
  // Sorted by clock so `ordinal` always reflects the running order, whatever
  // order the caller sent them in.
  const sorted = [...defs].sort((a, b) => a.startsLocal.localeCompare(b.startsLocal));
  await query(`DELETE FROM dayparts WHERE channel_id = $1`, [channelId]);
  for (const [i, d] of sorted.entries()) {
    await query(
      `INSERT INTO dayparts (channel_id, ordinal, name, starts_local, days_mask)
       VALUES ($1,$2,$3,$4::time,$5)`,
      [channelId, i, d.name.trim(), d.startsLocal, d.daysMask ?? EVERY_DAY]
    );
  }
  await query(`UPDATE channels SET daypart_preset = $2 WHERE id = $1`,
    [channelId, presetId ?? null]);
  return sorted;
}

/** Apply a preset to a channel. Used at creation and from the settings form. */
export async function applyPreset(channelId: string, presetId: string): Promise<DaypartDef[]> {
  const preset = presetById(presetId);
  if (!preset) throw new Error(`Unknown daypart preset: ${presetId}`);
  return setDayparts(channelId, preset.dayparts, presetId);
}

export interface DaypartStrip {
  name: string;
  startMs: number;
  endMs: number;
}

/**
 * Resolve a channel's dayparts to concrete instants across a broadcast day.
 *
 * The last strip of a day runs to the day's end, so the set tiles the day
 * exactly whatever the anchors are — including the overnight strip, whose local
 * time is BEFORE the anchor hour and therefore falls on the next calendar date.
 */
export function stripsForDay(day: BroadcastDay, defs: DaypartDef[]): DaypartStrip[] {
  if (!defs.length) return [];
  const dow = new Date(day.startMs).getUTCDay();          // 0=Sun..6=Sat
  const bit = dow === 0 ? 6 : dow - 1;                     // our mask is Mon-first
  const active = defs.filter((d) => ((d.daysMask ?? EVERY_DAY) >> bit) & 1);
  if (!active.length) return [];

  const points = active
    .map((d) => ({ name: d.name, at: instantOfLocalTimeInDay(day, d.startsLocal) }))
    .filter((p) => p.at >= day.startMs && p.at < day.endMs)
    .sort((a, b) => a.at - b.at);
  if (!points.length) return [];

  return points.map((p, i) => ({
    name: p.name,
    startMs: p.at,
    endMs: i + 1 < points.length ? points[i + 1].at : day.endMs,
  }));
}

/** Every strip touching [from..to], across as many broadcast days as it spans. */
export function stripsInRange(
  days: BroadcastDay[], defs: DaypartDef[], fromMs: number, toMs: number
): DaypartStrip[] {
  const out: DaypartStrip[] = [];
  for (const day of days) {
    for (const s of stripsForDay(day, defs)) {
      if (s.endMs > fromMs && s.startMs < toMs) out.push(s);
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Which strip contains an instant — for "jump to the drive show". */
export function stripAt(
  day: BroadcastDay, defs: DaypartDef[], ms: number
): DaypartStrip | null {
  return stripsForDay(day, defs).find((s) => ms >= s.startMs && ms < s.endMs) ?? null;
}

/** The channel's tz and anchor, with the platform defaults when unset. */
export async function channelDayConfig(
  channelId: string
): Promise<{ tz: string; anchorHour: number; presetId: string | null }> {
  const row = await one<any>(
    `SELECT tz, broadcast_anchor_hour, daypart_preset FROM channels WHERE id = $1`, [channelId]
  );
  return {
    tz: row?.tz ?? 'Europe/London',
    anchorHour: row?.broadcast_anchor_hour ?? 6,
    presetId: row?.daypart_preset ?? null,
  };
}

export { broadcastDayBounds };
