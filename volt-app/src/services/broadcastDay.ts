// ============================================================================
//  THE BROADCAST DAY
//
//  A broadcast day is not a calendar day. It runs from an anchor hour in the
//  channel's LOCAL time to the same hour the next day — 06:00 by decision, which
//  is the convention the trade uses (Comscore: "6:00 AM to 6:00 AM"). Anything
//  airing after midnight but before the anchor belongs to the PREVIOUS broadcast
//  day, which is why a late-night show that runs to 02:00 is filed under the day
//  it started, not the date on the clock.
//
//  WHY THIS MATTERS HERE. Containers used to be keyed on `day_utc`, a calendar
//  date, so the boundary fell at 00:00 UTC — 01:00 local for a UK channel in
//  British Summer Time, in the middle of the overnight show. 06:00 local is the
//  quietest point in the schedule and therefore where a cut does least damage.
//
//  DST IS THE WHOLE DIFFICULTY. A broadcast day containing a clock change is 23
//  or 25 hours long, not 24. Any implementation that adds 86_400_000 to a start
//  time is wrong twice a year, and wrong in the direction that silently drops or
//  duplicates an hour of recording. Everything below is computed from real local
//  time via Intl, never by adding a fixed day.
//
//  No dependency: Node's Intl has the tz database, and using it directly is more
//  honest than pulling in a library to hide two functions.
// ============================================================================

export const DEFAULT_TZ = 'Europe/London';
/** 06:00 local. The trade anchor, and the quietest point in a schedule. */
export const DEFAULT_ANCHOR_HOUR = 6;

export interface LocalParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
}

export interface BroadcastDay {
  /** YYYY-MM-DD in local time — the DAY THE CONTENT BELONGS TO. */
  day: string;
  startMs: number;
  endMs: number;
  tz: string;
  anchorHour: number;
  /** 23, 24 or 25 hours. Anything but 24 means a clock change fell inside. */
  hours: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant, in a timezone. */
export function localPartsAt(ms: number, tz: string): LocalParts {
  const p = formatterFor(tz).formatToParts(new Date(ms));
  const get = (t: string) => Number(p.find((x) => x.type === t)!.value);
  // Intl renders midnight as hour 24 in some locales; normalise it.
  const hour = get('hour') % 24;
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour, minute: get('minute'), second: get('second'),
  };
}

/** The zone's UTC offset in minutes at a given instant (positive = ahead). */
export function offsetMinutesAt(ms: number, tz: string): number {
  const p = localPartsAt(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/**
 * The instant at which a given LOCAL wall time occurs.
 *
 * Solved by iteration rather than a lookup: guess that local time is UTC, ask
 * the zone what its offset is at that guess, correct, and confirm. Two passes
 * settle every case including a DST boundary, because the offset only changes
 * once within the correction window.
 *
 * Ambiguity is resolved deliberately. During a fall-back the same wall time
 * happens twice and we take the FIRST (still on summer time); during a spring
 * forward it does not happen at all and we take the instant the clock reaches
 * next. Neither case can arise at 06:00 in any zone we support, but a channel
 * configured with a 01:00 anchor would hit both, and silently returning NaN
 * would be worse than a defined answer.
 */
export function utcForLocal(
  year: number, month: number, day: number, hour = 0, minute = 0, tz = DEFAULT_TZ
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = naive - offsetMinutesAt(naive, tz) * 60000;
  // Second pass: the first correction may have moved us across a transition.
  guess = naive - offsetMinutesAt(guess, tz) * 60000;
  return guess;
}

/** YYYY-MM-DD from local parts. */
function isoDay(p: { year: number; month: number; day: number }): string {
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Add days to a YYYY-MM-DD in the calendar, not the clock. */
function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + delta);
  return isoDay({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() });
}

/**
 * Which broadcast day does this instant belong to?
 *
 * The rule that makes late-night work: if the local clock reads earlier than the
 * anchor, the content belongs to YESTERDAY's broadcast day.
 */
export function broadcastDayOf(
  ms: number, tz = DEFAULT_TZ, anchorHour = DEFAULT_ANCHOR_HOUR
): BroadcastDay {
  const p = localPartsAt(ms, tz);
  const day = p.hour < anchorHour ? shiftDay(isoDay(p), -1) : isoDay(p);
  return broadcastDayBounds(day, tz, anchorHour);
}

/** Start and end instants of a named broadcast day. */
export function broadcastDayBounds(
  day: string, tz = DEFAULT_TZ, anchorHour = DEFAULT_ANCHOR_HOUR
): BroadcastDay {
  const [y, m, d] = day.split('-').map(Number);
  const startMs = utcForLocal(y, m, d, anchorHour, 0, tz);
  const next = shiftDay(day, 1).split('-').map(Number);
  // The end is the NEXT day's anchor in local time — never start + 24h, which
  // would be wrong by an hour on both clock-change weekends.
  const endMs = utcForLocal(next[0], next[1], next[2], anchorHour, 0, tz);
  return {
    day, startMs, endMs, tz, anchorHour,
    hours: Math.round((endMs - startMs) / 3_600_000),
  };
}

/** Every broadcast day touched by [fromMs..toMs], in order. */
export function broadcastDaysBetween(
  fromMs: number, toMs: number, tz = DEFAULT_TZ, anchorHour = DEFAULT_ANCHOR_HOUR
): BroadcastDay[] {
  const out: BroadcastDay[] = [];
  let cur = broadcastDayOf(Math.min(fromMs, toMs), tz, anchorHour);
  const end = Math.max(fromMs, toMs);
  // Guard: a bad tz or anchor must not spin forever.
  for (let i = 0; i < 4000 && cur.startMs < end; i++) {
    out.push(cur);
    cur = broadcastDayBounds(shiftDay(cur.day, 1), tz, anchorHour);
  }
  return out;
}

/** Local wall-clock label for an instant, e.g. "06:00" — for timeline rulers. */
export function localClock(ms: number, tz = DEFAULT_TZ): string {
  const p = localPartsAt(ms, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * The instant of a local time-of-day within a broadcast day.
 *
 * A daypart anchor is a wall-clock time, and one BEFORE the day's anchor hour
 * belongs to the following calendar date — 01:00 Overnight on the 23rd's
 * broadcast day is 01:00 on the 24th. Getting this backwards would place every
 * overnight strip a day early.
 */
export function instantOfLocalTimeInDay(
  bday: BroadcastDay, hhmm: string
): number {
  const [h, mi] = hhmm.split(':').map(Number);
  const dayForTime = h < bday.anchorHour ? shiftDay(bday.day, 1) : bday.day;
  const [y, m, d] = dayForTime.split('-').map(Number);
  return utcForLocal(y, m, d, h, mi, bday.tz);
}
