// ============================================================================
//  THE RAW CMCD REPORTS, KEPT FIRST (QOE_REPORTING.md section 9a).
//
//  Every report line the collector accepts is written here, as received,
//  before anything is made of it: the raw events are the source of truth and
//  every summary is rebuildable from them (services/qoe/replay.ts).
//
//  ON THE MAC (default): a local folder (QOE_RAW_DIR, default
//  volt-app/qoe-raw), one NDJSON file per account, day (UTC) and hour, per
//  process. appendRaw resolves once the lines are on disk.
//
//  IN THE CLOUD (QOE_RAW_BUCKET set): the same partitions as objects,
//  s3://<bucket>/<QOE_RAW_PREFIX>/<account>/<day>/<hour>-<host>-<seq>.ndjson.gz,
//  each a batch of whole lines gzipped. Lines are buffered and written every
//  10 s or at 64 MB, so a collector task makes a few PUTs a minute however
//  large the audience (the S3 bucket's lifecycle and Object Lock are in
//  deploy/terraform/qoe_raw.tf). appendRaw resolves once the lines are in
//  that buffer, which is the "buffered for that write" the design asks for: a
//  task that dies loses at most its unflushed seconds. Gzipped NDJSON, not
//  Parquet yet: Athena and ClickHouse's s3() read it as it is, and it is
//  about twice the size of Parquet (see VOLT_BUILD_STATUS, 1.14e).
//
//  A row: { rt: received at (ms), app, sid, e, line, ctx? } where `line` is
//  the CMCD text exactly as the player sent it and `ctx` (first row of each
//  session in a POST) what the request said about the viewer: user agent and
//  platform hints, and country, region and network (ASN) from the CDN's own
//  headers. No IP address is kept.
// ============================================================================
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { RawCtx } from './views';

export interface RawRow { rt: number; app: string | null; sid: string; e: string; line: string; ctx?: RawCtx }

/**
 * Two streams share the store and its rules: the players' CMCD reports and
 * the apps' journey events (journeys.ts, build queue 1.14g). Journey events
 * sit in their own subtree, `journey/<account>/<day>/...`, locally and on
 * S3, so a replay of either never reads the other and the account listing
 * of the CMCD stream skips them (`journey` is not an account id).
 */
export type RawStream = 'cmcd' | 'journey';
const sub = (stream: RawStream) => (stream === 'journey' ? 'journey/' : '');
const localRoot = (stream: RawStream) => (stream === 'journey' ? join(rawDir(), 'journey') : rawDir());

export function rawDir(): string {
  return process.env.QOE_RAW_DIR || join(process.cwd(), 'qoe-raw');
}

const SAFE = /^[0-9a-f-]{36}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const dayHour = (at: number) => { const d = new Date(at); return { day: d.toISOString().slice(0, 10), hour: String(d.getUTCHours()).padStart(2, '0') }; };

// ------------------------------------------------------------------ S3 path

export interface RawS3 { send(command: any): Promise<any> }
let s3: RawS3 | null = null;
/** For tests (a stand-in client) and for wiring a shared one. */
export function setRawS3Client(c: RawS3 | null): void { s3 = c; }
async function s3Client(): Promise<RawS3> {
  if (!s3) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    s3 = new S3Client({ region: process.env.QOE_RAW_REGION || process.env.AWS_REGION || 'eu-west-1' }) as any;
  }
  return s3!;
}
const bucket = () => process.env.QOE_RAW_BUCKET || '';
const prefix = () => (process.env.QOE_RAW_PREFIX ?? 'qoe-raw').replace(/\/+$/, '');
export const S3_FLUSH_MS = 10_000;
export const S3_FLUSH_BYTES = 64 * 1024 * 1024;

const buffers = new Map<string, { lines: string[]; bytes: number }>();
let bufferedBytes = 0;
let seq = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** Write every buffered partition as one object each. */
export async function flushRawS3(): Promise<number> {
  if (!buffers.size) return 0;
  const b = bucket();
  const parts = [...buffers.entries()];
  buffers.clear(); bufferedBytes = 0;
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const c = await s3Client();
  let n = 0;
  for (const [part, buf] of parts) {
    const key = `${prefix()}/${part}-${hostname().replace(/[^A-Za-z0-9.-]/g, '')}-${process.pid}-${Date.now()}-${++seq}.ndjson.gz`;
    try {
      await c.send(new PutObjectCommand({ Bucket: b, Key: key, Body: gzipSync(buf.lines.join('\n') + '\n'), ContentType: 'application/x-ndjson', ContentEncoding: 'gzip' }));
      n++;
    } catch (e) {
      // Kept for the next flush rather than dropped: S3 refusing for a minute is not a reason to lose the record.
      const again = buffers.get(part) ?? { lines: [], bytes: 0 };
      again.lines.unshift(...buf.lines); again.bytes += buf.bytes; bufferedBytes += buf.bytes;
      buffers.set(part, again);
      console.error('[qoe] raw batch not written to S3, kept for the next flush', (e as Error).message);
    }
  }
  return n;
}

// ------------------------------------------------------------------- append

// Writes to one file are chained, so concurrent batches never interleave a line.
const chains = new Map<string, Promise<void>>();

/** Append accepted reports for one account. Resolves when they are on disk (or, on S3, in the write buffer). */
export async function appendRaw(acct: string, rows: RawRow[], stream: RawStream = 'cmcd'): Promise<void> {
  if (!rows.length) return;
  if (!SAFE.test(acct)) throw new Error('bad account id');
  const { day, hour } = dayHour(rows[0].rt);
  const body = rows.map((r) => JSON.stringify(r));
  if (bucket()) {
    const part = `${sub(stream)}${acct}/${day}/${hour}`;
    const buf = buffers.get(part) ?? { lines: [], bytes: 0 };
    let bytes = 0; for (const l of body) bytes += l.length + 1;
    buf.lines.push(...body); buf.bytes += bytes; bufferedBytes += bytes;
    buffers.set(part, buf);
    if (!timer) { timer = setInterval(() => { void flushRawS3(); }, S3_FLUSH_MS); timer.unref?.(); }
    if (bufferedBytes >= S3_FLUSH_BYTES) void flushRawS3();
    return;
  }
  const dir = join(localRoot(stream), acct, day);
  const file = join(dir, `${hour}-${process.pid}.ndjson`);
  const prev = chains.get(file) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => { await mkdir(dir, { recursive: true }); await appendFile(file, body.join('\n') + '\n'); });
  chains.set(file, next);
  try { await next; } finally { if (chains.get(file) === next) chains.delete(file); }
}

// --------------------------------------------------------------------- read

function parseLines(text: string, out: RawRow[], want?: (r: RawRow) => boolean) {
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { const r = JSON.parse(l) as RawRow; if (!want || want(r)) out.push(r); } catch { /* a torn last line */ }
  }
}

/** The accounts with raw reports on a day. */
export async function accountsOnDay(day: string, stream: RawStream = 'cmcd'): Promise<string[]> {
  if (!DAY.test(day)) return [];
  if (bucket()) {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const c = await s3Client();
    const out = new Set<string>();
    let token: string | undefined;
    do {
      const base = `${prefix()}/${sub(stream)}`;
      const r = await c.send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: base, Delimiter: '/', ContinuationToken: token }));
      for (const p of r.CommonPrefixes ?? []) { const a = String(p.Prefix).slice(base.length).replace(/\/$/, ''); if (SAFE.test(a)) out.add(a); }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return [...out];
  }
  let accts: string[] = [];
  try { accts = (await readdir(localRoot(stream))).filter((a) => SAFE.test(a)); } catch { return []; }
  const out: string[] = [];
  for (const a of accts) { try { await readdir(join(localRoot(stream), a, day)); out.push(a); } catch { /* none that day */ } }
  return out;
}

/** Every raw report of one account on one UTC day partition (by receive time). */
export async function readDay(acct: string, day: string, want?: (r: RawRow) => boolean, stream: RawStream = 'cmcd'): Promise<RawRow[]> {
  if (!SAFE.test(acct) || !DAY.test(day)) return [];
  const out: RawRow[] = [];
  if (bucket()) {
    const { ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const c = await s3Client();
    let token: string | undefined;
    do {
      const r = await c.send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: `${prefix()}/${sub(stream)}${acct}/${day}/`, ContinuationToken: token }));
      for (const o of r.Contents ?? []) {
        const g = await c.send(new GetObjectCommand({ Bucket: bucket(), Key: o.Key }));
        const bytes = Buffer.from(await g.Body.transformToByteArray());
        parseLines(gunzipSync(bytes).toString('utf8'), out, want);
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  const dir = join(localRoot(stream), acct, day);
  let files: string[] = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.ndjson')).sort(); } catch { return out; }
  for (const f of files) parseLines(await readFile(join(dir, f), 'utf8').catch(() => ''), out, want);
  return out;
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
    out.push(...await readDay(acct, day, (r) => r.sid === sid));
  }
  return out.sort((a, b) => a.rt - b.rt);
}
