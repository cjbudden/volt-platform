// ============================================================================
//  REPLAY: REBUILD A DAY OF QOE DATA FROM THE RAW REPORTS (QOE_REPORTING.md 9a).
//
//  For a changed definition (bump DEFINITIONS_VERSION in views.ts), a fixed
//  bug, a new report, or derived rows lost with the analytics database. One
//  account and one UTC day at a time: the raw partitions of the day before,
//  the day and the day after are read (a session that crosses midnight, a
//  report that arrived late), every session is derived with the same code the
//  collector runs live, and the day's views (by the day they started) and
//  minutes are replaced in one transaction (store.ts replaceDay).
//
//  Idempotent: view ids are the sid and attempt number, so a second replay
//  writes exactly the rows the first did. Command line:
//
//    npx tsx src/tools/qoe-replay.ts --day 2026-10-24 [--to 2026-10-31] [--account <id>]
// ============================================================================
import { accountsOnDay, readDay } from './rawStore';
import { replaceDay } from './store';
import { deriveAll, DEFINITIONS_VERSION } from './views';
import { deriveJourneys, replaceJourneyDay } from './journeys';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const shift = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

export interface ReplayResult { account: string; day: string; definitions: number; rawReports: number; views: number; minuteRows: number;
  /** Journey to play (journeys.ts): raw app events read, and the app sessions and journeys rebuilt for the day. */
  journeyEvents: number; appSessions: number; journeys: number }

export async function replayDay(acct: string, day: string): Promise<ReplayResult> {
  if (!DAY.test(day)) throw new Error('day must be YYYY-MM-DD');
  const rows: Array<{ acct: string; sid: string; rt: number; app: string | null; line: string; ctx?: any }> = [];
  for (const d of [shift(day, -1), day, shift(day, 1)]) for (const r of await readDay(acct, d)) rows.push({ acct, ...r });
  const { views, minutes } = deriveAll(rows);
  const start = Date.parse(day + 'T00:00:00Z'), end = start + 86_400_000;
  const keepViews = views.filter((v) => v.day === day);
  const keepMinutes = minutes.filter((m) => m.minute >= start && m.minute < end);
  await replaceDay(acct, day, keepViews, keepMinutes);
  // The app's journey events, from their own raw stream, the same way.
  const jrows: Array<{ acct: string; rt: number; app: string | null; line: string; ctx?: any }> = [];
  for (const d of [shift(day, -1), day, shift(day, 1)]) for (const r of await readDay(acct, d, undefined, 'journey')) jrows.push({ acct, ...r });
  const j = deriveJourneys(jrows);
  const keepS = j.sessions.filter((s) => s.day === day), keepJ = j.journeys.filter((x) => x.day === day);
  if (jrows.length || keepS.length) await replaceJourneyDay(acct, day, keepS, keepJ);
  return { account: acct, day, definitions: DEFINITIONS_VERSION, rawReports: rows.length, views: keepViews.length, minuteRows: keepMinutes.length,
    journeyEvents: jrows.length, appSessions: keepS.length, journeys: keepJ.length };
}

/** Every account with raw reports on each day of the range (inclusive). */
export async function replayRange(from: string, to = from, account?: string): Promise<ReplayResult[]> {
  if (!DAY.test(from) || !DAY.test(to) || to < from) throw new Error('from and to must be YYYY-MM-DD, to not before from');
  const out: ReplayResult[] = [];
  for (let d = from; d <= to; d = shift(d, 1)) {
    const accts = account ? [account] : [...new Set([...await accountsOnDay(d), ...await accountsOnDay(d, 'journey')])];
    for (const a of accts) out.push(await replayDay(a, d));
  }
  return out;
}
