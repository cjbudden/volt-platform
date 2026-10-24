// ============================================================================
//  THE RAW CMCD REPORTS, KEPT FIRST (QOE_REPORTING.md section 9a).
//
//  Every report line the collector accepts is written here, as received,
//  before anything is made of it: the raw events are the source of truth and
//  every summary is rebuildable from them. On the Mac this is a local folder
//  (QOE_RAW_DIR, default volt-app/qoe-raw), one NDJSON file per account, day
//  (UTC) and hour, per process. In the cloud the same partitions go to S3 as
//  Parquet (build queue 1.14e); this module is the one place that changes.
//
//  A row: { rt: received at (ms), app, sid, e, line } where `line` is the CMCD
//  text exactly as the player sent it. No IP address is kept.
// ============================================================================
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface RawRow { rt: number; app: string | null; sid: string; e: string; line: string }

export function rawDir(): string {
  return process.env.QOE_RAW_DIR || join(process.cwd(), 'qoe-raw');
}

const SAFE = /^[0-9a-f-]{36}$/i;

function partition(acct: string, at: number): { dir: string; file: string } {
  const d = new Date(at);
  const day = d.toISOString().slice(0, 10);
  const hour = String(d.getUTCHours()).padStart(2, '0');
  const dir = join(rawDir(), acct, day);
  return { dir, file: join(dir, `${hour}-${process.pid}.ndjson`) };
}

// Writes to one file are chained, so concurrent batches never interleave a line.
const chains = new Map<string, Promise<void>>();

/** Append accepted reports for one account. Resolves when they are on disk. */
export async function appendRaw(acct: string, rows: RawRow[]): Promise<void> {
  if (!rows.length) return;
  if (!SAFE.test(acct)) throw new Error('bad account id');
  const { dir, file } = partition(acct, rows[0].rt);
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const prev = chains.get(file) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => { await mkdir(dir, { recursive: true }); await appendFile(file, body); });
  chains.set(file, next);
  try { await next; } finally { if (chains.get(file) === next) chains.delete(file); }
}

/**
 * Every raw report of one session, oldest first, from the account's last
 * `days` day partitions. For the session timeline (report 11) and tests.
 */
export async function readSession(acct: string, sid: string, days = 2, now = Date.now()): Promise<RawRow[]> {
  if (!SAFE.test(acct)) return [];
  const out: RawRow[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    const dir = join(rawDir(), acct, day);
    let files: string[] = [];
    try { files = (await readdir(dir)).filter((f) => f.endsWith('.ndjson')).sort(); } catch { continue; }
    for (const f of files) {
      const text = await readFile(join(dir, f), 'utf8').catch(() => '');
      for (const l of text.split('\n')) {
        if (!l || !l.includes(sid)) continue;
        try { const r = JSON.parse(l) as RawRow; if (r.sid === sid) out.push(r); } catch { /* a torn last line */ }
      }
    }
  }
  return out.sort((a, b) => a.rt - b.rt);
}
