/* ============================================================================
 *  ENCODER LOG LINES WITH THE TIME THEY HAPPENED.
 *
 *  encoder.log and radio.log are the raw output of the encoder and its ffmpeg
 *  children. Nothing in them had a time, so the Connection Log showed the word
 *  "encoder" where every other row shows when, and five identical "Error while
 *  decoding" rows could be one burst an hour ago or a fault happening now.
 *
 *  The encoder now stamps every line (volt-encoder/bin/logstamp.py):
 *    2026-10-27T09:31:02.123Z [relay:primary] Error while decoding stream ...
 *  This reads the stamp as `at`, and folds a message that repeats into one row
 *  with how many times, the first and the last time, so "is it still
 *  happening?" is answered by the row itself. Lines written before the stamp
 *  existed have no `at` and say so.
 * ========================================================================= */

export interface EncoderLogRow {
  /** Display time kept for older clients: HH:MM, or 'encoder' when unknown. */
  ts: string;
  /** When it last happened (ISO, UTC), or null for an unstamped line. */
  at: string | null;
  /** When it first happened in this window, when it repeated. */
  firstAt?: string | null;
  /** How many times it was written in this window (1 when once). */
  count: number;
  level: string;
  title: string;
  detail: string;
}

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s+/;

/** Split a log line into its time (if stamped) and its text. */
export function splitStamp(line: string): { at: string | null; text: string } {
  const m = STAMP.exec(line);
  if (!m) return { at: null, text: line };
  const t = Date.parse(m[1]);
  return { at: Number.isFinite(t) ? new Date(t).toISOString() : null, text: line.slice(m[0].length) };
}

/**
 * Fold repeats. Rows are oldest to newest; the result is too, ordered by each
 * message's LAST occurrence, so a fault still repeating sits at the newest end.
 * Repeats are matched on level + detail, so the same message from two
 * children (different [name] tags) stays two rows.
 */
export function foldRepeats(rows: EncoderLogRow[]): EncoderLogRow[] {
  const by = new Map<string, EncoderLogRow>();
  const order: string[] = [];
  for (const r of rows) {
    const k = r.level + '\u0000' + r.detail;
    const g = by.get(k);
    if (!g) { by.set(k, { ...r, firstAt: r.at, count: 1 }); order.push(k); continue; }
    g.count += 1;
    if (r.at) { g.at = r.at; g.ts = r.ts; if (!g.firstAt) g.firstAt = r.at; }
    order.splice(order.indexOf(k), 1); order.push(k);   // moves to the newest end
  }
  return order.map((k) => by.get(k)!);
}

/** Newest first by `at`; rows with no time keep their place at the top, as before. */
export function newestFirst<T extends { at?: string | null }>(rows: T[]): T[] {
  const timed = rows.filter((r) => r.at).sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!));
  return [...rows.filter((r) => !r.at), ...timed];
}
