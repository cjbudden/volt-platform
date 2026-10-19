/**
 * EPG REPEATS: the pure part. Dates a rule produces, and wall-clock time in a
 * zone. No database here, so every rule and every DST edge is unit-tested.
 *
 * WHY WALL-CLOCK. A programme that repeats "every Tuesday at 18:00" is at
 * 18:00 local on every Tuesday, including the Tuesday after a daylight-saving
 * change. Shifting the first instance by multiples of 24 hours (what Copy day
 * did) lands it at 17:00 or 19:00 for half the year in any zone with DST.
 * So a repeat stores a local time ("18:00") and a zone, and every occurrence
 * is placed from those.
 *
 * WHY OUR OWN DATE EXPANSION and not rrule.js: the rules an operator sets here
 * are three (every N days, weekdays, weekly on chosen days, until a date or
 * open-ended) and expanding them by calendar DATE, never by instant, is what
 * keeps them out of the DST trap above. The standard RRULE text is still
 * produced (ruleToRrule) and stored, so the series reads as iCal outward.
 */

export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';
export const WEEKDAYS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

export interface RepeatRule {
  freq: 'daily' | 'weekdays' | 'weekly';
  /** Every N days (daily) or N weeks (weekly). Default 1. */
  interval?: number;
  /** Weekly: which days. */
  byDay?: Weekday[];
}

/** Rolling horizon: how far ahead an open-ended repeat keeps the guide filled. */
export const HORIZON_DAYS = 60;

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RX.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
}

/** MO..SU for a calendar date. */
export function weekdayOf(date: string): Weekday {
  const js = new Date(date + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(js + 6) % 7];
}

/** Monday of the week a date falls in. */
function mondayOf(date: string): string {
  return addDays(date, -WEEKDAYS.indexOf(weekdayOf(date)));
}

export function validateRule(r: RepeatRule): string | null {
  if (!r || !['daily', 'weekdays', 'weekly'].includes(r.freq)) return 'Choose how it repeats';
  const iv = r.interval ?? 1;
  if (!Number.isInteger(iv) || iv < 1 || iv > 52) return 'Repeat interval must be 1 to 52';
  if (r.freq === 'weekly') {
    if (!r.byDay || !r.byDay.length) return 'Choose at least one day of the week';
    if (r.byDay.some((d) => !WEEKDAYS.includes(d))) return 'Unknown day of the week';
  }
  return null;
}

/** Does the rule (anchored at startDate) include this date? Ignores until/exdates. */
export function ruleMatches(rule: RepeatRule, startDate: string, date: string): boolean {
  if (date < startDate) return false;
  const iv = rule.interval ?? 1;
  if (rule.freq === 'daily') return diffDays(startDate, date) % iv === 0;
  const wd = weekdayOf(date);
  if (rule.freq === 'weekdays') return wd !== 'SA' && wd !== 'SU';
  if (!(rule.byDay ?? []).includes(wd)) return false;
  const weeks = Math.round(diffDays(mondayOf(startDate), mondayOf(date)) / 7);
  return weeks % iv === 0;
}

/**
 * The dates in [from, to] (inclusive) the rule produces, from startDate, up to
 * `until` (inclusive) when set. Capped, so a bad request cannot run away.
 */
export function datesFor(rule: RepeatRule, startDate: string, from: string, to: string, until?: string | null, cap = 800): string[] {
  const out: string[] = [];
  let d = from < startDate ? startDate : from;
  const end = until && until < to ? until : to;
  while (d <= end && out.length < cap) {
    if (ruleMatches(rule, startDate, d)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

/** Is one occurrence (date, item key) removed on purpose? */
export function isExcluded(exdates: string[] | null | undefined, date: string, key?: string): boolean {
  if (!exdates || !exdates.length) return false;
  return exdates.includes(date) || (!!key && exdates.includes(`${date}#${key}`));
}

/** The iCal text of a rule, stored beside it so the series reads as a standard RRULE. */
export function ruleToRrule(rule: RepeatRule, until?: string | null): string {
  const iv = rule.interval && rule.interval > 1 ? `;INTERVAL=${rule.interval}` : '';
  const u = until ? `;UNTIL=${until.replace(/-/g, '')}T235959Z` : '';
  if (rule.freq === 'daily') return `FREQ=DAILY${iv}${u}`;
  if (rule.freq === 'weekdays') return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR${u}`;
  const days = WEEKDAYS.filter((d) => rule.byDay!.includes(d)).join(',');
  return `FREQ=WEEKLY${iv};BYDAY=${days}${u}`;
}

const DAY_NAME: Record<Weekday, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };

/** "Every Tuesday and Thursday until 15 Dec 2026", for messages and the drawer. */
export function describeRule(rule: RepeatRule, until?: string | null): string {
  const iv = rule.interval ?? 1;
  let s: string;
  if (rule.freq === 'daily') s = iv === 1 ? 'Every day' : `Every ${iv} days`;
  else if (rule.freq === 'weekdays') s = 'Every weekday';
  else {
    const days = WEEKDAYS.filter((d) => rule.byDay!.includes(d)).map((d) => DAY_NAME[d]);
    const list = days.length > 1 ? `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}` : days[0];
    s = iv === 1 ? `Every ${list}` : `Every ${iv} weeks on ${list}`;
  }
  if (until) {
    const d = new Date(until + 'T00:00:00Z');
    s += ` until ${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}`;
  }
  return s;
}

// ------------------------------------------------------------- time zones

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try { fmt(tz); return true; } catch { return false; }
}

function parts(ms: number, tz: string) {
  const o: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Offset of a zone at an instant, in ms (local minus UTC). */
function offsetAt(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant of a local wall-clock time on a date in a zone.
 * A time that does not exist (inside a spring-forward gap) moves forward by the
 * gap, which is what every broadcast scheduler does with a 02:30 slot that day.
 */
export function localToUtc(date: string, time: string, tz: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss || 0);
  const o1 = offsetAt(guess, tz);
  let t = guess - o1;
  const o2 = offsetAt(t, tz);
  if (o2 !== o1) t = guess - o2;
  return new Date(t).toISOString();
}

/** Local calendar date of an instant. */
export function localDateOf(iso: string | Date, tz: string): string {
  const p = parts(new Date(iso).getTime(), tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Local wall-clock time of an instant, HH:MM or HH:MM:SS when seconds are set. */
export function localTimeOf(iso: string | Date, tz: string): string {
  const p = parts(new Date(iso).getTime(), tz);
  const base = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  return p.second ? `${base}:${String(p.second).padStart(2, '0')}` : base;
}

/** [start, end) instants of a local calendar day. 23 or 25 hours long on DST days. */
export function localDayBounds(date: string, tz: string): { start: string; end: string } {
  return { start: localToUtc(date, '00:00', tz), end: localToUtc(addDays(date, 1), '00:00', tz) };
}
