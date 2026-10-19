// ============================================================================
//  THUMBNAIL NAMES, PLACES AND CUES. Pure: no I/O, so every rule is tested.
//
//  Library layout (under the account's image library, library/{account}/):
//
//    thumbnails/{stream}/{YYYY-MM-DD}/{HH}/
//      {programme or stream}-{YYYYMMDD}-{HHMMSS}.jpg          one still per minute
//      storyboard/{stream}-{YYYYMMDD}-{HH}-m{MM}.jpg          one sprite sheet per 10 minutes
//      storyboard/{stream}-{YYYYMMDD}-{HH}.vtt                the hour's WebVTT
//
//  Dates and hours are the stream's local time (the channel's time zone), so
//  the folder an operator opens matches the clock on the wall. The UNIT of
//  work is one local hour; units are instants, so a day with a repeated hour
//  (end of daylight saving) gets two folders, "01" and "01b".
// ============================================================================

export interface LocalParts {
  date: string;   // 2026-10-16
  ymd: string;    // 20261016
  hh: string;     // 18
  mm: string;     // 07
  ss: string;     // 05
  hms: string;    // 180705
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** A valid IANA zone, or the fallback. */
export function safeTz(tz: string | null | undefined, fallback = 'UTC'): string {
  if (!tz) return fallback;
  try { fmt(tz).format(0); return tz; } catch { return fallback; }
}

export function localParts(ms: number, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  const hh = p.hour === '24' ? '00' : p.hour;
  return {
    date: `${p.year}-${p.month}-${p.day}`, ymd: `${p.year}${p.month}${p.day}`,
    hh, mm: p.minute, ss: p.second, hms: `${hh}${p.minute}${p.second}`,
  };
}

export interface HourUnit { start: number; end: number; date: string; ymd: string; label: string }

/** The local hour containing `ms`, as an instant range plus its folder label. */
export function hourUnit(ms: number, tz: string): HourUnit {
  const p = localParts(ms, tz);
  const start = Math.floor(ms / 1000) * 1000 - (Number(p.mm) * 60 + Number(p.ss)) * 1000;
  const end = start + 3600_000;
  // A repeated local hour (clocks going back) is the second one with this label.
  const before = localParts(start - 3600_000, tz);
  const label = before.date === p.date && before.hh === p.hh ? `${p.hh}b` : p.hh;
  return { start, end, date: p.date, ymd: p.ymd, label };
}

/** Every hour unit overlapping [from, to). */
export function unitsBetween(from: number, to: number, tz: string): HourUnit[] {
  const out: HourUnit[] = [];
  let t = from;
  for (let guard = 0; t < to && guard < 24 * 400; guard++) {
    const u = hourUnit(t, tz);
    out.push(u);
    t = u.end;
  }
  return out;
}

/** Safe, readable file-name part: "Evening News: Live!" -> "Evening-News-Live". */
export function slugify(s: string, max = 60): string {
  const out = s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  return out || 'untitled';
}

export interface Layout {
  tileW: number; tileH: number; cols: number; rows: number;
  /** One tile every this many ms. */
  intervalMs: number;
}
export const slotsPerSheet = (l: Layout) => l.cols * l.rows;
export const sheetMs = (l: Layout) => slotsPerSheet(l) * l.intervalMs;

export function unitFolder(streamSlug: string, u: HourUnit): string {
  return `thumbnails/${streamSlug}/${u.date}/${u.label}`;
}
export function frameName(nameSlug: string, ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${nameSlug}-${p.ymd}-${p.hms}.jpg`;
}
export function sheetName(streamSlug: string, u: HourUnit, sheetStart: number, tz: string): string {
  return `${streamSlug}-${u.ymd}-${u.label}-m${localParts(sheetStart, tz).mm}.jpg`;
}
export function vttName(streamSlug: string, u: HourUnit): string {
  return `${streamSlug}-${u.ymd}-${u.label}.vtt`;
}

// ---------------------------------------------------------------------------
//  Cues: where the picture for an instant is.
// ---------------------------------------------------------------------------
export interface SheetRecord {
  key: string;
  start_ms: number;
  slots: number;
  /** Slot indexes that hold a picture. */
  filled: number[];
  /** Slot indexes with no source material (a gap); never retried by the pass. */
  skipped?: number[];
}
export interface UnitRecord extends Layout {
  unitStart: number;
  unitEnd: number;
  sheets: SheetRecord[];
}

export interface Cue { startMs: number; endMs: number; key: string; x: number; y: number; w: number; h: number; /** sheet version (tile count) */ v: number }

/** Cues for every filled tile overlapping [from, to), in time order. */
export function cuesBetween(units: UnitRecord[], from: number, to: number): Cue[] {
  const out: Cue[] = [];
  for (const u of [...units].sort((a, b) => a.unitStart - b.unitStart)) {
    for (const s of [...u.sheets].sort((a, b) => a.start_ms - b.start_ms)) {
      const filled = new Set(s.filled);
      for (let i = 0; i < s.slots; i++) {
        if (!filled.has(i)) continue;
        const startMs = s.start_ms + i * u.intervalMs;
        const endMs = Math.min(startMs + u.intervalMs, u.unitEnd);
        if (endMs <= from || startMs >= to) continue;
        out.push({
          startMs, endMs, key: s.key, v: s.filled.length,
          x: (i % u.cols) * u.tileW, y: Math.floor(i / u.cols) * u.tileH, w: u.tileW, h: u.tileH,
        });
      }
    }
  }
  return out;
}

export function vttTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600_000), m = Math.floor((t % 3600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000), f = t % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
}

/**
 * WebVTT thumbnails for a span of a stream, timed from `origin`.
 *
 * `pieces` maps stream time onto output time: a plain recording or hour is one
 * piece [from, to) at offset 0; a composed clip is several pieces, each placed
 * at its offset in the clip. Cues are trimmed to their piece, so a clip that
 * starts 4 s into a tile shows that tile for its first 6 s.
 */
export function buildVtt(
  units: UnitRecord[],
  pieces: { from: number; to: number; offset: number }[],
  urlFor: (key: string, version: number) => string,
): string {
  const lines = ['WEBVTT', ''];
  for (const p of pieces) {
    for (const c of cuesBetween(units, p.from, p.to)) {
      const a = Math.max(c.startMs, p.from) - p.from + p.offset;
      const b = Math.min(c.endMs, p.to) - p.from + p.offset;
      if (b <= a) continue;
      lines.push(`${vttTime(a)} --> ${vttTime(b)}`, `${urlFor(c.key, c.v)}#xywh=${c.x},${c.y},${c.w},${c.h}`, '');
    }
  }
  return lines.join('\n');
}

/** Slot index inside a unit's sheets for an instant, or null. */
export function slotFor(u: UnitRecord, ms: number): { sheet: number; slot: number } | null {
  if (ms < u.unitStart || ms >= u.unitEnd) return null;
  const i = Math.floor((ms - u.unitStart) / u.intervalMs);
  const per = slotsPerSheet(u);
  return { sheet: Math.floor(i / per), slot: i % per };
}
