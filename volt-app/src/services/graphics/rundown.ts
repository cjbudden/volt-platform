// ============================================================================
//  EVENT GRAPHICS RUNDOWN: the ordered list of graphics an event needs.
//
//  Events are operated, not scheduled. Before the event, a producer lists the
//  graphics in order and groups them by segment (pre-match, first half ...),
//  each with its content and a cue. During it, the operator works down the
//  list with Take next, and the automatic cues fire on their own while still
//  showing in the list, so nothing arrives unannounced.
//
//    manual   taken by the operator, in order
//    time     at a clock time
//    offset   N seconds after the event's actual (else scheduled) start
//    feed     when a data source's value at a path changes, optionally to a
//             given value ("lastEvent.type" becomes "try")
//    repeat   every N seconds while the event is live (a sponsor bug for 15 s
//             every 10 min); needs stays_sec
//
//  PURE helpers here; the database side is runtime.ts.
// ============================================================================

export type CueKind = 'manual' | 'time' | 'offset' | 'feed' | 'repeat';
export interface Cue {
  kind: CueKind;
  at?: string;              // time: ISO instant
  fromStartSec?: number;    // offset
  sourceId?: string;        // feed
  path?: string;            // feed
  equals?: string;          // feed, optional
  everySec?: number;        // repeat
}
export interface Item {
  id: string; position: number; status: 'ready' | 'on_air' | 'done' | 'skipped';
  cue: Cue; stays_sec: number | null; taken_at: Date | null;
}

export function normCue(raw: any): Cue {
  const k = String(raw?.kind ?? 'manual') as CueKind;
  switch (k) {
    case 'time': {
      const d = new Date(String(raw?.at ?? ''));
      if (Number.isNaN(d.getTime())) throw new Error('cue.at must be a date and time');
      return { kind: 'time', at: d.toISOString() };
    }
    case 'offset': {
      const n = Number(raw?.fromStartSec);
      if (!Number.isFinite(n) || n < 0 || n > 7 * 86400) throw new Error('cue.fromStartSec must be seconds after the start');
      return { kind: 'offset', fromStartSec: Math.round(n) };
    }
    case 'feed': {
      if (!raw?.sourceId || !raw?.path) throw new Error('a feed cue needs a data source and a path');
      return { kind: 'feed', sourceId: String(raw.sourceId), path: String(raw.path).slice(0, 200),
        ...(raw.equals != null && raw.equals !== '' ? { equals: String(raw.equals).slice(0, 200) } : {}) };
    }
    case 'repeat': {
      const n = Number(raw?.everySec);
      if (!Number.isFinite(n) || n < 30 || n > 86400) throw new Error('cue.everySec must be between 30 seconds and a day');
      return { kind: 'repeat', everySec: Math.round(n) };
    }
    case 'manual': return { kind: 'manual' };
    default: throw new Error(`unknown cue kind ${k}`);
  }
}

/** The manual item Take next will put on air: the first ready one after the last taken. */
export function nextManual<T extends Item>(items: T[]): T | null {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  let lastTakenPos = -Infinity;
  for (const i of sorted) if (i.cue.kind === 'manual' && (i.status === 'on_air' || i.status === 'done') ) lastTakenPos = Math.max(lastTakenPos, i.position);
  return sorted.find((i) => i.cue.kind === 'manual' && i.status === 'ready' && i.position > lastTakenPos)
    ?? sorted.find((i) => i.cue.kind === 'manual' && i.status === 'ready') ?? null;
}

/**
 * Which automatic cues are due at `now`. `start` is the event's actual start
 * (else scheduled); `live` says the event is running. A time or offset cue
 * fires once, within a minute of its moment (a control plane that was down
 * at the moment does not replay a stale graphic an hour late).
 */
export function dueAutomatic<T extends Item>(items: T[], now: Date, start: Date | null, live: boolean): T[] {
  if (!live) return [];
  const t = now.getTime();
  const GRACE = 60_000;
  return items.filter((i) => {
    if (i.status === 'on_air' || i.status === 'skipped') return false;
    switch (i.cue.kind) {
      case 'time': {
        const at = new Date(i.cue.at!).getTime();
        return i.status === 'ready' && t >= at && t - at < GRACE;
      }
      case 'offset': {
        if (!start) return false;
        const at = start.getTime() + (i.cue.fromStartSec ?? 0) * 1000;
        return i.status === 'ready' && t >= at && t - at < GRACE;
      }
      case 'repeat': {
        if (!i.stays_sec) return false;
        const last = i.taken_at ? i.taken_at.getTime() : null;
        return last == null || t - last >= (i.cue.everySec ?? 600) * 1000;
      }
      default: return false;
    }
  });
}

/** Feed cues fired by a payload change. */
export function feedFired(cue: Cue, before: unknown, after: unknown, pick: (o: unknown, p: string) => unknown): boolean {
  if (cue.kind !== 'feed' || !cue.path) return false;
  const a = pick(before, cue.path), b = pick(after, cue.path);
  if (JSON.stringify(a) === JSON.stringify(b) || b === undefined) return false;
  return cue.equals == null || String(b) === cue.equals;
}

/** Parse a CSV rundown: segment,title,setup,cue,stays[,field=value;field=value]. */
export function parseCsv(text: string): { segment: string; title: string; setup: string; cue: string; stays: string; values: Record<string, string> }[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; if (row.some((x) => x.trim())) rows.push(row); row = [];
    } else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim())) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const hasHead = head.includes('title') && head.includes('setup');
  const idx = (n: string, d: number) => hasHead ? head.indexOf(n) : d;
  const I = { segment: idx('segment', 0), title: idx('title', 1), setup: idx('setup', 2), cue: idx('cue', 3), stays: idx('stays', 4), values: idx('values', 5) };
  return (hasHead ? rows.slice(1) : rows).map((r) => {
    const get = (k: keyof typeof I) => (I[k] >= 0 ? (r[I[k]] ?? '') : '').trim();
    const values: Record<string, string> = {};
    for (const kv of get('values').split(';')) {
      const j = kv.indexOf('=');
      if (j > 0) values[kv.slice(0, j).trim()] = kv.slice(j + 1).trim();
    }
    return { segment: get('segment'), title: get('title'), setup: get('setup'), cue: get('cue'), stays: get('stays'), values };
  });
}

/** "manual", "19:20", "+300", "every 600", "feed" (needs the UI to finish it) to a cue. */
export function cueFromText(s: string, eventStart: Date, tz = 'UTC'): Cue {
  const t = s.trim().toLowerCase();
  if (!t || t === 'manual') return { kind: 'manual' };
  let m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m) return { kind: 'time', at: zonedOn(eventStart, Number(m[1]), Number(m[2]), tz).toISOString() };
  m = /^\+(\d+)$/.exec(t); if (m) return { kind: 'offset', fromStartSec: Number(m[1]) };
  m = /^every\s+(\d+)$/.exec(t); if (m) return normCue({ kind: 'repeat', everySec: Number(m[1]) });
  throw new Error(`cue "${s}" is not manual, HH:MM, +seconds or "every N"`);
}

/** Offset of `tz` from UTC at instant `d`, in ms. */
function tzOffset(d: Date, tz: string): number {
  try {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(d.getTime() / 1000) * 1000;
  } catch { return 0; }
}

/**
 * HH:MM local time in `tz`, on the event's local day. A time earlier than the
 * start by more than 12 hours is taken to be the next day (an event starting
 * 23:30 with a cue at 00:15).
 */
export function zonedOn(eventStart: Date, hh: number, mm: number, tz: string): Date {
  const local = new Date(eventStart.getTime() + tzOffset(eventStart, tz));
  const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hh, mm);
  let at = guess - tzOffset(new Date(guess), tz);
  if (at < eventStart.getTime() - 12 * 3600_000) at += 86400_000;
  return new Date(at);
}
