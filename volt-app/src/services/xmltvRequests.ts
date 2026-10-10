// ============================================================================
//  XMLTV IMPORT FROM A HOSTED GUIDE API: which requests a run makes.
//
//  A guide API is a URL with the dates in it. The source keeps a TEMPLATE and
//  every run works out the real URLs from today's date in the source's time
//  zone (its fallback zone, else UTC):
//
//    {date}      the day being fetched            per_day mode only
//    {from}      today                            ("the window starts")
//    {to}        today + days ahead               ("the window ends")
//    {days}      days ahead, as a number
//    {from_unix} {to_unix}  local midnight of {from} / the day after {to}, in seconds
//
//  {date}, {from} and {to} are written in the source's date format. Values are
//  URL-encoded, so DD/MM/YYYY is safe in a query string.
//
//  'single'  one request covering today .. today + days ahead
//  'per_day' one request per day, today .. today + days ahead (days + 1 calls),
//            for APIs that serve a day at a time. A day that fails is a warning,
//            not a failed run, and its part of the guide is left as it was.
//
//  Pure: no database, no network. Tested in test/xmltv-import-api-pure.check.ts.
// ============================================================================
import { zoneOffsetMinutes } from './xmltv';

export type RequestMode = 'single' | 'per_day';
export type DateFormat = 'YYYY-MM-DD' | 'YYYYMMDD' | 'DD/MM/YYYY' | 'unix';
export const DATE_FORMATS: DateFormat[] = ['YYYY-MM-DD', 'YYYYMMDD', 'DD/MM/YYYY', 'unix'];
export const TOKENS = ['date', 'from', 'to', 'days', 'from_unix', 'to_unix'] as const;

const DAY = 86_400_000;

export interface Ymd { y: number; m: number; d: number }
export interface PlannedRequest {
  url: string;
  /** per_day: the local day this request is for (YYYY-MM-DD). */
  day: string | null;
  /** The span of the guide this request is responsible for. */
  from: Date;
  to: Date;
}

/** The calendar date it is right now in `zone`. */
export function todayIn(now: Date, zone: string | null): Ymd {
  const local = new Date(now.getTime() + zoneOffsetMinutes(now, zone || 'UTC') * 60_000);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
}

export function addDays(v: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(v.y, v.m - 1, v.d) + n * DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Local midnight of that day in `zone`, as an instant (DST-safe: re-checks the offset at the answer). */
export function localMidnight(v: Ymd, zone: string | null): Date {
  const z = zone || 'UTC';
  const naive = Date.UTC(v.y, v.m - 1, v.d);
  let t = naive - zoneOffsetMinutes(new Date(naive), z) * 60_000;
  t = naive - zoneOffsetMinutes(new Date(t), z) * 60_000;
  return new Date(t);
}

const p2 = (n: number) => String(n).padStart(2, '0');
export const isoDay = (v: Ymd) => `${v.y}-${p2(v.m)}-${p2(v.d)}`;

export function formatDay(v: Ymd, fmt: DateFormat, zone: string | null): string {
  switch (fmt) {
    case 'YYYYMMDD': return `${v.y}${p2(v.m)}${p2(v.d)}`;
    case 'DD/MM/YYYY': return `${p2(v.d)}/${p2(v.m)}/${v.y}`;
    case 'unix': return String(Math.floor(localMidnight(v, zone).getTime() / 1000));
    default: return isoDay(v);
  }
}

/** Why a template cannot be used in this mode, or null when it can. */
export function templateProblem(template: string, mode: RequestMode): string | null {
  const used = [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  const unknown = used.filter((t) => !(TOKENS as readonly string[]).includes(t));
  if (unknown.length) return `Unknown placeholder ${unknown.map((t) => `{${t}}`).join(', ')}. Use ${TOKENS.map((t) => `{${t}}`).join(', ')}.`;
  if (mode === 'per_day' && !used.includes('date')) return 'One request per day needs {date} in the URL, where the day goes.';
  if (mode === 'single' && used.includes('date')) return '{date} is for one request per day. For one request covering the window, use {from} and {to}.';
  let probe: URL;
  try { probe = new URL(fill(template, { date: '2026-01-01', from: '2026-01-01', to: '2026-01-08', days: '7', from_unix: '0', to_unix: '0' })); }
  catch { return 'The guide URL is not a valid URL.'; }
  if (probe.protocol !== 'http:' && probe.protocol !== 'https:') return 'The guide URL must be http or https.';
  return null;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (all, k) => (k in values ? encodeURIComponent(values[k]) : all));
}

/**
 * The requests one run makes, and where the window ends. Programmes that
 * start at or after `windowEnd` are not imported: the source keeps the guide
 * `daysAhead` days ahead, not as far as the provider happens to publish.
 */
export function planRequests(opts: {
  template: string; mode: RequestMode; daysAhead: number; dateFormat: DateFormat; zone: string | null; now: Date;
}): { requests: PlannedRequest[]; windowStart: Date; windowEnd: Date } {
  const { template, mode, daysAhead, dateFormat, zone, now } = opts;
  const today = todayIn(now, zone);
  const last = addDays(today, daysAhead);
  const windowStart = localMidnight(today, zone);
  const windowEnd = localMidnight(addDays(last, 1), zone);
  const base = {
    from: formatDay(today, dateFormat, zone), to: formatDay(last, dateFormat, zone), days: String(daysAhead),
    from_unix: String(Math.floor(windowStart.getTime() / 1000)), to_unix: String(Math.floor(windowEnd.getTime() / 1000)),
  };
  if (mode === 'single') return { requests: [{ url: fill(template, base), day: null, from: windowStart, to: windowEnd }], windowStart, windowEnd };
  const requests: PlannedRequest[] = [];
  for (let i = 0; i <= daysAhead; i++) {
    const day = addDays(today, i);
    requests.push({ url: fill(template, { ...base, date: formatDay(day, dateFormat, zone) }), day: isoDay(day),
      from: localMidnight(day, zone), to: localMidnight(addDays(day, 1), zone) });
  }
  return { requests, windowStart, windowEnd };
}

/** Header names an API key can travel in; the ones fetch owns are refused. */
export function headerProblem(name: string): string | null {
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name)) return `"${name}" is not a valid header name.`;
  if (/^(host|content-length|connection|transfer-encoding|te|upgrade|cookie2?|keep-alive|proxy-.*|if-none-match|if-modified-since|accept-encoding)$/i.test(name))
    return `The ${name} header is set by Volt and cannot be overridden.`;
  return null;
}

/** Failed scheduled runs retry sooner: 15 min, 30, 60, 120 ... never later than the normal refresh. */
export function retryDelayMinutes(consecutiveFailures: number, refreshHours: number): number {
  const n = Math.max(1, consecutiveFailures);
  return Math.min(refreshHours * 60, 15 * 2 ** Math.min(n - 1, 10));
}

/** "6.4 days" style wording for how far ahead a guide reaches. */
export function daysAheadOf(until: Date | null, now: Date): number | null {
  if (!until) return null;
  return Math.round(((until.getTime() - now.getTime()) / DAY) * 10) / 10;
}
