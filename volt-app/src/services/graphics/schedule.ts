// ============================================================================
//  WHEN A CHANNEL GRAPHIC IS ON (docs/REQ_graphics_overlays.md, section 12).
//
//  Channels run graphics on their own, from the guide. Each assignment has one
//  run mode:
//    always    on whenever the channel is on air (a corner logo, a sponsor)
//    rule      on while the current programme matches: a genre, a word in the
//              title, days of the week, a time of day
//    trigger   on for a set time at a point in each programme: N seconds after
//              it starts, or N seconds before it ends
//    manual    on only when an operator (or the API) takes it on
//  and, for all of them, "clear for ad breaks": off during ad items in the guide.
//
//  An operator can still take any graphic on by hand from live control; that
//  is the state's on_air flag and it wins over the mode, so a rule-driven
//  ticker can be forced up during a breaking story. Switching the assignment
//  off (enabled = false) wins over everything.
//
//  Events are different: they run from a rundown (rundown.ts), cued by an
//  operator, a time or a feed event.
//
//  PURE. The same function answers "is it on now" for live control and the
//  player, and "when will it be on today" for the channel's day strip, so the
//  two can never disagree.
// ============================================================================

export type RunMode = 'always' | 'rule' | 'trigger' | 'manual';
export interface Rule {
  genre?: string | string[];
  titleContains?: string;
  days?: number[];          // 1 = Monday ... 7 = Sunday
  from?: string;            // "HH:MM" local
  to?: string;              // "HH:MM" local; to < from wraps past midnight
  tz?: string;              // IANA, default UTC
  at?: 'programme_start' | 'programme_end';
  offsetSec?: number;       // start: delay after the start; end: lead before the end
  durationSec?: number;
}
export interface AssignmentRun { run_mode: RunMode; rule: Rule; clear_in_ads: boolean; enabled: boolean }
export interface Programme { id?: string; title: string; startsAt: Date; endsAt: Date; kind?: string | null; genres?: string[] }
export interface Window { start: Date; end: Date; reason: string }

const lower = (s: unknown) => String(s ?? '').trim().toLowerCase();
const isAd = (p: Programme) => lower(p.kind) === 'ad';
const isContent = (p: Programme) => !['ad', 'filler', 'slate'].includes(lower(p.kind || 'content'));

/** Genres from a programme's metadata, whichever key the guide used. */
export function genresOf(metadata: any): string[] {
  const m = metadata ?? {};
  const list = (v: unknown) => Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
  return [...list(m.genre), ...list(m.genres), ...list(m.category), ...list(m.categories)].map((x) => String(x)).filter(Boolean);
}

function localParts(d: Date, tz = 'UTC'): { dow: number; minutes: number } {
  try {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
    const dow = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[parts.weekday] ?? 1;
    return { dow, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
  } catch {
    return localParts(d, 'UTC');
  }
}
const hm = (s?: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** Does the rule's clock part (days, from/to) hold at this instant? */
export function clockMatches(rule: Rule, at: Date): boolean {
  const { dow, minutes } = localParts(at, rule.tz);
  if (Array.isArray(rule.days) && rule.days.length && !rule.days.includes(dow)) return false;
  const a = hm(rule.from), b = hm(rule.to);
  if (a == null || b == null) return true;
  return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

/** Does the rule's programme part (genre, title) hold for this programme? */
export function programmeMatches(rule: Rule, p: Programme | null): boolean {
  const wantGenres = (Array.isArray(rule.genre) ? rule.genre : rule.genre ? [rule.genre] : []).map(lower).filter(Boolean);
  const wantTitle = lower(rule.titleContains);
  if (!wantGenres.length && !wantTitle) return true;
  if (!p || !isContent(p)) return false;
  if (wantGenres.length && !(p.genres ?? []).map(lower).some((g) => wantGenres.includes(g))) return false;
  if (wantTitle && !lower(p.title).includes(wantTitle)) return false;
  return true;
}

export function triggerWindow(rule: Rule, p: Programme): Window | null {
  if (!isContent(p)) return null;
  const dur = Math.max(1, Math.min(3600, Number(rule.durationSec ?? 8))) * 1000;
  const off = Math.max(0, Math.min(6 * 3600, Number(rule.offsetSec ?? 0))) * 1000;
  if ((rule.at ?? 'programme_start') === 'programme_end') {
    const start = p.endsAt.getTime() - off;
    if (start < p.startsAt.getTime()) return null;          // programme shorter than the lead
    return { start: new Date(start), end: new Date(Math.min(start + dur, p.endsAt.getTime())), reason: `before the end of ${p.title}` };
  }
  const start = p.startsAt.getTime() + off;
  if (start >= p.endsAt.getTime()) return null;
  return { start: new Date(start), end: new Date(Math.min(start + dur, p.endsAt.getTime())), reason: `start of ${p.title}` };
}

const current = (progs: Programme[], at: Date) =>
  progs.find((p) => p.startsAt.getTime() <= at.getTime() && at.getTime() < p.endsAt.getTime()) ?? null;

export interface OnNow { on: boolean; reason: string }

/** Is this assignment's graphic on at `at`? `forcedOn` is an operator's take. */
export function isOn(a: AssignmentRun, progs: Programme[], at: Date, forcedOn: boolean): OnNow {
  if (!a.enabled) return { on: false, reason: 'switched off' };
  const now = current(progs, at);
  if (a.clear_in_ads && now && isAd(now)) return { on: false, reason: 'ad break' };
  if (forcedOn) return { on: true, reason: 'taken on by hand' };
  switch (a.run_mode) {
    case 'always': return { on: true, reason: 'always on' };
    case 'manual': return { on: false, reason: 'waiting for an operator' };
    case 'rule': {
      const ok = clockMatches(a.rule, at) && programmeMatches(a.rule, now);
      return { on: ok, reason: ok ? (now ? `rule matches ${now.title}` : 'rule matches') : 'rule does not match now' };
    }
    case 'trigger': {
      for (const p of progs) {
        const w = triggerWindow(a.rule, p);
        if (w && w.start.getTime() <= at.getTime() && at.getTime() < w.end.getTime()) return { on: true, reason: w.reason };
      }
      return { on: false, reason: 'waiting for the next trigger' };
    }
  }
  return { on: false, reason: 'unknown mode' };
}

/** Subtract ad items from a window list (for clear_in_ads). */
function minusAds(ws: Window[], progs: Programme[]): Window[] {
  const ads = progs.filter(isAd);
  let out = ws;
  for (const ad of ads) {
    const next: Window[] = [];
    for (const w of out) {
      if (ad.endsAt <= w.start || ad.startsAt >= w.end) { next.push(w); continue; }
      if (ad.startsAt > w.start) next.push({ ...w, end: ad.startsAt });
      if (ad.endsAt < w.end) next.push({ ...w, start: ad.endsAt });
    }
    out = next;
  }
  return out;
}

/**
 * When the graphic will be on between `from` and `to`, from the guide. Rules
 * are evaluated per programme and then clipped by their clock part at a
 * minute's resolution, which is what a day strip can draw.
 */
export function plan(a: AssignmentRun, progs: Programme[], from: Date, to: Date): Window[] {
  if (!a.enabled) return [];
  const clip = (w: Window): Window | null => {
    const s = Math.max(w.start.getTime(), from.getTime()), e = Math.min(w.end.getTime(), to.getTime());
    return e > s ? { ...w, start: new Date(s), end: new Date(e) } : null;
  };
  let ws: Window[] = [];
  if (a.run_mode === 'always') ws = [{ start: from, end: to, reason: 'always on' }];
  else if (a.run_mode === 'trigger') ws = progs.map((p) => triggerWindow(a.rule, p)).filter((w): w is Window => !!w);
  else if (a.run_mode === 'rule') {
    const hasClock = !!(a.rule.from && a.rule.to) || !!(a.rule.days && a.rule.days.length);
    const hasProg = !!(a.rule.genre && (!Array.isArray(a.rule.genre) || a.rule.genre.length)) || !!a.rule.titleContains;
    const base: Window[] = hasProg
      ? progs.filter((p) => programmeMatches(a.rule, p)).map((p) => ({ start: p.startsAt, end: p.endsAt, reason: p.title }))
      : [{ start: from, end: to, reason: 'rule' }];
    if (!hasClock) ws = base;
    else {
      const STEP = 60_000;
      for (const b of base) {
        let open: number | null = null;
        const s0 = Math.max(b.start.getTime(), from.getTime()), e0 = Math.min(b.end.getTime(), to.getTime());
        for (let t = s0; t < e0; t += STEP) {
          const m = clockMatches(a.rule, new Date(t));
          if (m && open == null) open = t;
          if (!m && open != null) { ws.push({ start: new Date(open), end: new Date(t), reason: b.reason }); open = null; }
        }
        if (open != null) ws.push({ start: new Date(open), end: new Date(e0), reason: b.reason });
      }
    }
  }
  if (a.clear_in_ads) ws = minusAds(ws, progs);
  return ws.map(clip).filter((w): w is Window => !!w).sort((x, y) => x.start.getTime() - y.start.getTime());
}

/** A human summary of how an assignment runs, for lists. */
export function describe(a: { run_mode: RunMode; rule: Rule; clear_in_ads: boolean }): string {
  const r = a.rule ?? {};
  let s = '';
  if (a.run_mode === 'always') s = 'Whenever the channel is on air';
  else if (a.run_mode === 'manual') s = 'Taken from live control';
  else if (a.run_mode === 'trigger') {
    s = (r.at ?? 'programme_start') === 'programme_end'
      ? `${fmtSec(r.offsetSec ?? 0)} before each programme ends, for ${fmtSec(r.durationSec ?? 8)}`
      : `${r.offsetSec ? fmtSec(r.offsetSec) + ' after' : 'When'} each programme starts, for ${fmtSec(r.durationSec ?? 8)}`;
  } else {
    const parts: string[] = [];
    const g = Array.isArray(r.genre) ? r.genre : r.genre ? [r.genre] : [];
    if (g.length) parts.push(`programmes with genre ${g.join(' or ')}`);
    if (r.titleContains) parts.push(`titles containing "${r.titleContains}"`);
    if (r.days?.length) parts.push(r.days.map((d) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d]).join(', '));
    if (r.from && r.to) parts.push(`${r.from} to ${r.to}`);
    s = parts.length ? 'During ' + parts.join(', ') : 'Whenever the channel is on air';
  }
  return s + (a.clear_in_ads ? '' : ', including ad breaks');
}
const fmtSec = (n: number) => n >= 60 && n % 60 === 0 ? `${n / 60} min` : `${n} s`;
