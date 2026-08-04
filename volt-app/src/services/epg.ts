/**
 * EPG / scheduling core logic.
 *
 * - expandRrule(): materialize an iCal RRULE series into concrete programme
 *   instances within a horizon (the "map at ingest, store, serve" model).
 * - resolveEffectiveEnds(): the "end = next entry's start" authoring model —
 *   fill any missing end with the following programme's start so every stored
 *   programme has a concrete span.
 *
 * Conflict detection and now/next are GiST/btree queries in modules/epg.ts.
 */
import { RRule, rrulestr } from 'rrule';

export interface Instance {
  startsAt: string; // ISO
  endsAt: string; // ISO
}

/**
 * Expand an RRULE into instances whose START falls in [from, to]. dtstart and
 * the horizon are Dates; durationMs sets each instance length. Guards the count.
 */
export function expandRrule(rruleStr: string, dtstart: Date, durationMs: number, from: Date, to: Date, cap = 10000): Instance[] {
  // Accept either a bare "FREQ=..." or a full "RRULE:..." string.
  const opts = RRule.parseString(rruleStr.replace(/^RRULE:/i, ''));
  opts.dtstart = dtstart;
  const rule = new RRule(opts);
  const starts = rule.between(from, to, true).slice(0, cap);
  return starts.map((s) => ({
    startsAt: s.toISOString(),
    endsAt: new Date(s.getTime() + durationMs).toISOString(),
  }));
}

export interface Authored {
  startsAt: string;
  endsAt?: string | null;
}

/**
 * Given channel programmes ordered by start, fill any missing end with the next
 * programme's start (the traditional guide model). The last item, if open, gets
 * `defaultMs`. Returns a parallel array of resolved [startsAt, endsAt].
 */
export function resolveEffectiveEnds(ordered: Authored[], defaultMs = 3_600_000): { startsAt: string; endsAt: string }[] {
  const sorted = [...ordered].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return sorted.map((p, i) => {
    if (p.endsAt) return { startsAt: p.startsAt, endsAt: p.endsAt };
    const next = sorted[i + 1];
    const end = next ? next.startsAt : new Date(Date.parse(p.startsAt) + defaultMs).toISOString();
    return { startsAt: p.startsAt, endsAt: end };
  });
}

/** Validate an RRULE string (throws on garbage). Returns the normalized text. */
export function validateRrule(rruleStr: string, dtstart: Date): string {
  const opts = RRule.parseString(rruleStr.replace(/^RRULE:/i, ''));
  opts.dtstart = dtstart;
  return new RRule(opts).toString();
}

export { rrulestr };
