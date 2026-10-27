// ============================================================================
//  READING THE CDN'S REAL-TIME LOGS FROM KINESIS, AND KEEPING THEIR COST
//  BOUNDED (build queue 2.9, QOE_REPORTING.md section 9).
//
//  CloudFront writes sampled log lines to a Kinesis stream (deploy/terraform/
//  cdn_logs.tf). The scheduler's leader (one task, orchestrator/index.ts)
//  reads every shard, hands the lines to cdnLogs.ts (raw first, then the
//  live aggregates) and records in the analytics database how far it has read
//  each shard, so a restart carries on where it stopped. A batch is recorded
//  as read only after its raw copy is kept: at least once, never lost (a
//  restart may count a few seconds twice in the live aggregates; a replay of
//  the day gives the exact figures).
//
//  ADAPTIVE SAMPLING. A log line costs the same whoever watches, so at a
//  large audience 100 % logging would be the biggest line in the reporting
//  bill. Every few minutes the reader looks at how many lines a second
//  arrived, works out the full request rate from the sampling rate in
//  force, and moves CloudFront's sampling rate (1 to 100 %) so about
//  CDN_LOG_TARGET_LPS lines a second arrive (1,000 by default: delivery
//  statistics need no more). It lowers at once when over by a fifth, and
//  raises only when well under, so it does not flap. Each line is weighted
//  by the rate it was logged at (cdnLogs.ts). CloudFront takes a minute or
//  two to apply a change; lines in that gap are weighted at the new rate,
//  which over- or under-counts those minutes by the change's factor.
//
//  WHY NOT THE AWS SDK. Kinesis needs three calls (ListShards,
//  GetShardIterator, GetRecords) over a plain JSON protocol, and CloudFront
//  one (UpdateRealtimeLogConfig) over REST-XML; both are signed with the
//  Signature Version 4 signer the SQS reader already uses, with the S3
//  client's credentials (the task role on AWS). The calls are behind small
//  interfaces, so the reader is tested against an in-memory stream.
//
//  Settings (Terraform sets them, cdn_logs.tf):
//    CDN_LOG_STREAM          stream name; unset: the reader does not run
//    CDN_LOG_REGION          its region (default AWS_REGION)
//    CDN_LOG_ENDPOINT        a stand-in Kinesis (LocalStack) for local tests
//    CDN_LOG_SAMPLING_RATE   the rate Terraform created the log config with
//    CDN_LOG_ADAPTIVE        on (default) / off: leave the rate as Terraform set it
//    CDN_LOG_TARGET_LPS      lines a second to aim for (default 1000)
//    CDN_LOG_CONFIG_ARN, CDN_LOG_STREAM_ARN, CDN_LOG_ROLE_ARN
//                            what UpdateRealtimeLogConfig must restate
// ============================================================================
import { signV4, s3Credentials, type CredentialSource } from '../ingest/sqs';
import { aquery } from './analyticsDb';
import { CDN_LOG_FIELDS, dbAccountOf, flushCdn, handleCdnLines, cdnStats, type CdnDeps } from './cdnLogs';

// ----------------------------------------------------------------- Kinesis

export interface KinesisRecord { seq: string; data: Buffer; arrivedAt: number }
export interface KinesisApi {
  listShards(stream: string): Promise<string[]>;
  /** An iterator after `afterSeq`, or from the oldest record kept when there is none. */
  iterator(stream: string, shardId: string, afterSeq: string | null): Promise<string>;
  /** Records from an iterator; `next` is null once a shard is closed (resharded) and read to its end. */
  getRecords(iterator: string, limit: number): Promise<{ records: KinesisRecord[]; next: string | null; behindMs: number }>;
}

export async function realKinesis(o: { region: string; endpoint?: string; credentials?: CredentialSource }): Promise<KinesisApi> {
  const creds = o.credentials ?? await s3Credentials(o.region);
  const endpoint = (o.endpoint || `https://kinesis.${o.region}.amazonaws.com`).replace(/\/+$/, '') + '/';
  async function call(action: string, payload: Record<string, unknown>): Promise<any> {
    const body = JSON.stringify(payload);
    const headers = signV4({
      method: 'POST', url: endpoint, body, region: o.region, service: 'kinesis', credentials: await creds(),
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `Kinesis_20131202.${action}` },
    });
    delete headers.host;
    const r = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    const j = text ? JSON.parse(text) : {};
    if (!r.ok) throw new Error(`Kinesis ${action} ${r.status}: ${String(j.__type ?? '').split('#').pop() || 'error'}: ${j.message ?? j.Message ?? text.slice(0, 200)}`);
    return j;
  }
  return {
    async listShards(StreamName) {
      const out: string[] = [];
      let NextToken: string | undefined;
      do {
        const j = await call('ListShards', NextToken ? { NextToken } : { StreamName });
        for (const s of j.Shards ?? []) out.push(String(s.ShardId));
        NextToken = j.NextToken;
      } while (NextToken);
      return out;
    },
    async iterator(StreamName, ShardId, after) {
      const j = await call('GetShardIterator', after
        ? { StreamName, ShardId, ShardIteratorType: 'AFTER_SEQUENCE_NUMBER', StartingSequenceNumber: after }
        : { StreamName, ShardId, ShardIteratorType: 'TRIM_HORIZON' });
      return String(j.ShardIterator);
    },
    async getRecords(ShardIterator, Limit) {
      const j = await call('GetRecords', { ShardIterator, Limit: Math.max(1, Math.min(10_000, Limit)) });
      return {
        records: (j.Records ?? []).map((r: any) => ({ seq: String(r.SequenceNumber), data: Buffer.from(String(r.Data ?? ''), 'base64'), arrivedAt: Math.round(Number(r.ApproximateArrivalTimestamp ?? 0) * 1000) })),
        next: j.NextShardIterator ?? null,
        behindMs: Number(j.MillisBehindLatest ?? 0),
      };
    },
  };
}

/** An in-memory stream for tests: shards of records, iterators that are positions. */
export class MemoryKinesis implements KinesisApi {
  shards = new Map<string, { records: KinesisRecord[]; closed: boolean }>();
  calls: string[] = [];
  private n = 0;
  put(shard: string, text: string, at = Date.now()): string {
    const s = this.shards.get(shard) ?? this.shards.set(shard, { records: [], closed: false }).get(shard)!;
    const seq = String(++this.n).padStart(20, '0');
    s.records.push({ seq, data: Buffer.from(text), arrivedAt: at });
    return seq;
  }
  close(shard: string) { const s = this.shards.get(shard); if (s) s.closed = true; }
  async listShards() { this.calls.push('listShards'); return [...this.shards.keys()]; }
  async iterator(_s: string, shard: string, after: string | null) {
    this.calls.push('iterator');
    const recs = this.shards.get(shard)?.records ?? [];
    const pos = after ? recs.findIndex((r) => r.seq > after) : 0;
    return `${shard}@${pos < 0 ? recs.length : pos}`;
  }
  async getRecords(it: string, limit: number) {
    this.calls.push('getRecords');
    const [shard, p] = it.split('@'); const pos = Number(p);
    const s = this.shards.get(shard)!;
    const records = s.records.slice(pos, pos + limit);
    const end = pos + records.length;
    return { records, next: s.closed && end >= s.records.length ? null : `${shard}@${end}`, behindMs: 0 };
  }
}

// ------------------------------------------------------- the sampling rate

export interface SamplingInput { rate: number; linesPerSec: number; target: number; min?: number; max?: number }

/**
 * The sampling rate to ask for next. Pure, so the rule is tested on its own.
 * Over the target by a fifth: lower now to what the target needs. Under 40 %
 * of it: raise, but only to 80 % of what would meet the target and only when
 * that at least doubles the rate. Otherwise keep it.
 */
export function nextSamplingRate(i: SamplingInput): number {
  const min = i.min ?? 1, max = i.max ?? 100;
  const rate = Math.max(min, Math.min(max, Math.round(i.rate)));
  if (!(i.linesPerSec >= 0) || !(i.target > 0)) return rate;
  const full = (i.linesPerSec * 100) / rate;            // every request a second, sampled or not
  if (full <= 0) return max;                            // nothing at all: log everything, it costs nothing
  const ideal = (i.target * 100) / full;                // the rate that gives exactly the target
  if (i.linesPerSec > i.target * 1.2) return Math.max(min, Math.min(rate, Math.floor(ideal)));
  if (i.linesPerSec < i.target * 0.4 && rate < max) {
    const up = Math.min(max, Math.floor(ideal * 0.8));
    return up >= rate * 2 || up === max && ideal >= max ? Math.max(rate, up) : rate;
  }
  return rate;
}

export interface LogConfigApi { setSamplingRate(rate: number): Promise<void> }

/** CloudFront's UpdateRealtimeLogConfig: every part restated, only the rate changed. */
export function realLogConfig(o: { configArn: string; streamArn: string; roleArn: string; credentials?: CredentialSource; endpoint?: string }): LogConfigApi {
  const url = (o.endpoint || 'https://cloudfront.amazonaws.com').replace(/\/+$/, '') + '/2020-05-31/realtime-log-config/';
  const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    async setSamplingRate(rate) {
      const body = '<?xml version="1.0" encoding="UTF-8"?>'
        + '<UpdateRealtimeLogConfigRequest xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">'
        + `<ARN>${x(o.configArn)}</ARN>`
        + `<EndPoints><member><StreamType>Kinesis</StreamType><KinesisStreamConfig><RoleARN>${x(o.roleArn)}</RoleARN><StreamARN>${x(o.streamArn)}</StreamARN></KinesisStreamConfig></member></EndPoints>`
        + `<Fields>${CDN_LOG_FIELDS.map((f) => `<Field>${f}</Field>`).join('')}</Fields>`
        + `<SamplingRate>${Math.round(rate)}</SamplingRate>`
        + '</UpdateRealtimeLogConfigRequest>';
      const creds = o.credentials ?? await s3Credentials('us-east-1');
      const headers = signV4({ method: 'PUT', url, body, region: 'us-east-1', service: 'cloudfront', credentials: await creds(), headers: { 'content-type': 'text/xml' } });
      delete headers.host;
      const r = await fetch(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`CloudFront UpdateRealtimeLogConfig ${r.status}: ${(await r.text()).slice(0, 300)}`);
    },
  };
}

// ----------------------------------------------------------------- reading

export interface ReaderOptions {
  kinesis: KinesisApi;
  stream: string;
  deps?: CdnDeps;
  /** The rate the log config was created with. The last rate this reader set is kept in qoe_meta and wins. */
  initialRate: number;
  logConfig?: LogConfigApi | null;
  targetLps?: number;
  /** How often the sampling rate is reconsidered. */
  adjustEveryMs?: number;
  /** Pause between polls of a shard with nothing new. */
  idleMs?: number;
  errorPauseMs?: number;
  now?: () => number;
}

const MIN_PASS_MS = 250;
export const readerState = { running: false, shards: 0, records: 0, lines: 0, behindMs: 0, rate: 100, rateChanges: 0, lastRateError: null as string | null, lastError: null as string | null };

async function loadCursor(stream: string): Promise<Map<string, { seq: string; closed: boolean }>> {
  const rows = await aquery<any>(`SELECT shard_id, seq, closed FROM qoe_cdn_cursor WHERE stream = $1`, [stream]);
  return new Map(rows.map((r) => [r.shard_id, { seq: r.seq, closed: r.closed }]));
}
async function saveCursor(stream: string, shard: string, seq: string, closed: boolean) {
  await aquery(`INSERT INTO qoe_cdn_cursor(stream, shard_id, seq, closed) VALUES ($1,$2,$3,$4)
     ON CONFLICT (stream, shard_id) DO UPDATE SET seq = EXCLUDED.seq, closed = EXCLUDED.closed, updated_at = now()`, [stream, shard, seq, closed]);
}
async function loadRate(fallback: number): Promise<number> {
  const [r] = await aquery<any>(`SELECT v FROM qoe_meta WHERE k = 'cdn_sampling_rate'`);
  const n = r ? Number(r.v) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : fallback;
}
async function saveRate(rate: number) {
  await aquery(`INSERT INTO qoe_meta(k, v) VALUES ('cdn_sampling_rate', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [String(rate)]);
}

// Between passes the reader keeps each shard's iterator (GetShardIterator is
// limited to 5 calls a second per shard) and lists the shards once a minute
// (an on-demand stream splits and merges shards as traffic changes).
const iters = new Map<string, string>();
let shardList: { at: number; shards: string[] } | null = null;
/** For tests. */
export function resetReader(): void { iters.clear(); shardList = null; Object.assign(readerState, { shards: 0, records: 0, lines: 0, behindMs: 0, rateChanges: 0, lastRateError: null, lastError: null }); }

/**
 * One pass over every shard: one GetRecords each (the loop keeps passes at
 * least MIN_PASS_MS apart, inside Kinesis's 5 reads a second per shard),
 * the lines kept, the position recorded. Returns the lines handled. The
 * loop below calls this; tests call it directly.
 */
export async function readOnce(o: ReaderOptions, limit = 10_000): Promise<number> {
  const deps = o.deps ?? { accountOf: dbAccountOf() };
  const now = o.now ?? Date.now;
  if (!shardList || now() - shardList.at > 60_000) shardList = { at: now(), shards: await o.kinesis.listShards(o.stream) };
  const cursor = await loadCursor(o.stream);
  readerState.shards = shardList.shards.length;
  let lines = 0;
  for (const shard of shardList.shards) {
    const c = cursor.get(shard);
    if (c?.closed) continue;
    let it = iters.get(shard);
    if (!it) { it = await o.kinesis.iterator(o.stream, shard, c?.seq || null); iters.set(shard, it); }
    let got: { records: KinesisRecord[]; next: string | null; behindMs: number };
    try { got = await o.kinesis.getRecords(it, limit); }
    catch (e) {
      // An iterator lives five minutes; an expired one is made again from the cursor next pass.
      iters.delete(shard);
      if (/ExpiredIterator/i.test((e as Error).message)) continue;
      throw e;
    }
    readerState.behindMs = got.behindMs;
    let last = c?.seq ?? '';
    if (got.records.length) {
      const text: string[] = [];
      for (const r of got.records) for (const l of r.data.toString('utf8').split('\n')) if (l.trim()) text.push(l);
      // Kept raw before the position moves: a crash here reads the batch again, never skips it.
      await handleCdnLines(text, readerState.rate, deps, now());
      last = got.records[got.records.length - 1].seq;
      readerState.records += got.records.length; readerState.lines += text.length; lines += text.length;
    }
    if (!got.next) { iters.delete(shard); await saveCursor(o.stream, shard, last, true); continue; }
    iters.set(shard, got.next);
    if (got.records.length) await saveCursor(o.stream, shard, last, false);
  }
  return lines;
}

/** Reconsider the sampling rate from the lines that arrived over `seconds`. */
export async function adjustRate(o: ReaderOptions, linesPerSec: number): Promise<number> {
  const next = nextSamplingRate({ rate: readerState.rate, linesPerSec, target: o.targetLps ?? 1000 });
  if (next === readerState.rate || !o.logConfig) return readerState.rate;
  try {
    await o.logConfig.setSamplingRate(next);
    console.log(`[cdn logs] sampling rate ${readerState.rate}% -> ${next}% (${linesPerSec.toFixed(1)} lines/s, target ${o.targetLps ?? 1000})`);
    readerState.rate = next; readerState.rateChanges++; readerState.lastRateError = null;
    await saveRate(next);
  } catch (e) {
    readerState.lastRateError = (e as Error).message;
    console.error('[cdn logs] could not change the sampling rate:', readerState.lastRateError);
  }
  return readerState.rate;
}

/** Read until stopped: a pass, a flush of the aggregates, a pause when idle; the rate every adjustEveryMs. */
export function startCdnReader(o: ReaderOptions): () => Promise<void> {
  let stopped = false;
  const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); (t as any).unref?.(); });
  const run = (async () => {
    readerState.rate = await loadRate(o.initialRate).catch(() => o.initialRate);
    readerState.running = true;
    let windowStart = Date.now(), windowLines = 0;
    let lastDay = new Date().toISOString().slice(0, 10);
    while (!stopped) {
      try {
        const passStart = Date.now();
        const n = await readOnce(o);
        windowLines += n;
        await flushCdn();
        const t = Date.now();
        if (t - windowStart >= (o.adjustEveryMs ?? 300_000)) {
          await adjustRate(o, windowLines / ((t - windowStart) / 1000));
          windowStart = t; windowLines = 0;
        }
        // Once a day, shortly after midnight UTC, the day before is replayed:
        // the exact figures, and the join with the players' response reports.
        const today = new Date(t).toISOString().slice(0, 10);
        if (today !== lastDay && new Date(t).getUTCMinutes() >= 30) {
          const day = lastDay; lastDay = today;
          void replayYesterday(day);
        }
        if (n === 0) await sleep(o.idleMs ?? 1000);
        else { const spent = Date.now() - passStart; if (spent < MIN_PASS_MS) await sleep(MIN_PASS_MS - spent); }
        readerState.lastError = null;
      } catch (e) {
        if (stopped) break;
        readerState.lastError = (e as Error).message;
        console.error('[cdn logs] read failed:', readerState.lastError);
        await sleep(o.errorPauseMs ?? 30_000);
      }
    }
    readerState.running = false;
  })();
  return async () => { stopped = true; await run.catch(() => undefined); await flushCdn().catch(() => undefined); };
}

async function replayYesterday(day: string) {
  try {
    const { accountsOnDay } = await import('./rawStore');
    const { replayCdnDay } = await import('./cdnLogs');
    for (const a of await accountsOnDay(day, 'cdn')) await replayCdnDay(a, day);
  } catch (e) { console.error('[cdn logs] nightly replay of', day, 'failed:', (e as Error).message); }
}

/** Start from the settings, or not at all when no stream is set (the Mac). */
export async function startFromConfig(): Promise<(() => Promise<void>) | null> {
  const stream = process.env.CDN_LOG_STREAM;
  if (!stream) return null;
  const region = process.env.CDN_LOG_REGION || process.env.AWS_REGION || 'us-east-1';
  const kinesis = await realKinesis({ region, endpoint: process.env.CDN_LOG_ENDPOINT || undefined });
  const adaptive = (process.env.CDN_LOG_ADAPTIVE ?? 'on') !== 'off';
  const cfg = process.env.CDN_LOG_CONFIG_ARN, sArn = process.env.CDN_LOG_STREAM_ARN, role = process.env.CDN_LOG_ROLE_ARN;
  const logConfig = adaptive && cfg && sArn && role ? realLogConfig({ configArn: cfg, streamArn: sArn, roleArn: role }) : null;
  const initialRate = Math.max(1, Math.min(100, Number(process.env.CDN_LOG_SAMPLING_RATE ?? 100) || 100));
  console.log(`[cdn logs] reading ${stream} (${region}), sampling ${adaptive ? `adaptive toward ${process.env.CDN_LOG_TARGET_LPS ?? 1000} lines/s` : 'fixed'}`);
  return startCdnReader({ kinesis, stream, initialRate, logConfig, targetLps: Number(process.env.CDN_LOG_TARGET_LPS ?? 1000) || 1000 });
}

/** What the reader is doing (the collector route, tests). */
export function cdnReaderState() { return { ...readerState, ...cdnStats }; }
