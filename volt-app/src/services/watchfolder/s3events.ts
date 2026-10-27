// ============================================================================
//  S3 WATCH FOLDERS, EVENT-DRIVEN (build queue 2.6).
//
//  An S3 watch folder used to be found out by listing its prefix every
//  minute (s3walk.ts). That is a LIST call per folder per minute whether
//  anything arrived or not, and up to a minute's wait when something did.
//  Now the bucket says when an object arrives: an ObjectCreated notification
//  on an SQS queue (deploy/terraform/watchfolders.tf). The scheduler's leader
//  long-polls the queue, fetches exactly the objects named, and takes their
//  folders in (scan, then ingest) straight away. The walk stays as the
//  backstop, once an hour, for anything a notification missed.
//
//  A MESSAGE IS DELETED ONLY WHEN ITS OBJECTS ARE SAFE in the staging mirror
//  (or were nothing to fetch: another bucket, the review prefix, a deleted
//  object, a test event). A failed fetch leaves the message on the queue; SQS
//  delivers it again when its visibility timeout runs out, and after five
//  tries moves it to the dead-letter queue. The scan and ingest that follow
//  are not a reason to keep it: the file is in the mirror, and the ordinary
//  scan pass every minute takes in whatever this pass did not.
//
//  Three message shapes are read: S3's own notification (keys URL-encoded,
//  spaces as '+'), the same wrapped in an SNS envelope (a bucket that fans
//  out to several queues), and EventBridge's "Object Created" (keys plain).
// ============================================================================
import { relativeKeys, mirrorS3Object, type S3Folder, type MirrorOutcome } from './s3walk';
import type { S3Api } from '../ingest/s3';
import type { SqsApi, SqsMessage } from '../ingest/sqs';

export interface S3Drop { bucket: string; key: string; bytes: number | null; etag: string | null }
export interface ParsedMessage { drops: S3Drop[]; test: boolean; ignored: number; unreadable: boolean }

const s3Key = (k: string) => decodeURIComponent(String(k).replace(/\+/g, ' '));

/** What one queue message says arrived. */
export function parseS3Message(body: string): ParsedMessage {
  const out: ParsedMessage = { drops: [], test: false, ignored: 0, unreadable: false };
  let j: any;
  try { j = JSON.parse(body); } catch { out.unreadable = true; return out; }
  if (j?.Type === 'Notification' && typeof j.Message === 'string') return parseS3Message(j.Message);
  if (j?.Event === 's3:TestEvent') { out.test = true; return out; }
  if (j?.source === 'aws.s3' && j?.detail?.bucket?.name) {
    if (j['detail-type'] !== 'Object Created') { out.ignored++; return out; }
    out.drops.push({ bucket: String(j.detail.bucket.name), key: String(j.detail.object?.key ?? ''),
      bytes: j.detail.object?.size ?? null, etag: j.detail.object?.etag ?? null });
    return out;
  }
  if (!Array.isArray(j?.Records)) { out.unreadable = true; return out; }
  for (const r of j.Records) {
    if (r?.eventSource !== 'aws:s3' || !String(r?.eventName ?? '').startsWith('ObjectCreated')) { out.ignored++; continue; }
    const key = r.s3?.object?.key;
    if (!r.s3?.bucket?.name || !key) { out.ignored++; continue; }
    out.drops.push({ bucket: String(r.s3.bucket.name), key: s3Key(key), bytes: r.s3.object.size ?? null, etag: r.s3.object.eTag ?? null });
  }
  return out;
}

/** The folders a dropped object belongs to, with its path inside each. */
export function foldersFor(drop: S3Drop, folders: S3Folder[]): { folder: S3Folder; rel: string }[] {
  const obj = { key: drop.key, bytes: drop.bytes ?? 0, etag: drop.etag ?? '', lastModified: new Date(0) };
  return folders.filter((f) => f.bucket === drop.bucket)
    .flatMap((f) => relativeKeys([obj], f.prefix, f.quarantinePath).map(({ rel }) => ({ folder: f, rel })));
}

export interface EventDeps {
  /** Every enabled S3 watch folder. */
  folders(): Promise<S3Folder[]>;
  s3: S3Api;
  /** Already recorded by the scanner with this content. */
  known(folderId: string, rel: string, etag: string): Promise<boolean>;
  /** Scan and ingest one folder now. */
  takeIn(folderId: string): Promise<void>;
}

export interface EventsResult {
  messages: number;
  /** Receipts of the messages that are done with and can be deleted. */
  done: string[];
  kept: { id: string; error: string }[];
  outcomes: Record<MirrorOutcome | 'elsewhere', number>;
  foldersTakenIn: string[];
  takeInErrors: { folderId: string; error: string }[];
}

/** Handle one batch of queue messages. Never throws for one bad message. */
export async function handleS3Messages(msgs: SqsMessage[], deps: EventDeps, now = Date.now()): Promise<EventsResult> {
  const res: EventsResult = {
    messages: msgs.length, done: [], kept: [], foldersTakenIn: [], takeInErrors: [],
    outcomes: { downloaded: 0, known: 0, junk: 0, gone: 0, review: 0, elsewhere: 0 },
  };
  if (!msgs.length) return res;
  const folders = await deps.folders();
  const touched = new Set<string>();
  for (const m of msgs) {
    const p = parseS3Message(m.body);
    // An unreadable message will never become readable: deleting it is the
    // only way to stop it coming back. It is logged so it is not silent.
    if (p.unreadable) console.warn(`[s3 watch] message ${m.id} is not an S3 notification; dropped`);
    try {
      for (const d of p.drops) {
        const homes = foldersFor(d, folders);
        if (!homes.length) { res.outcomes.elsewhere++; continue; }
        for (const { folder, rel } of homes) {
          const o = await mirrorS3Object(folder, deps.s3, rel, (r, e) => deps.known(folder.id, r, e), now);
          res.outcomes[o]++;
          if (o === 'downloaded') touched.add(folder.id);
        }
      }
      res.done.push(m.receipt);
    } catch (e: any) {
      res.kept.push({ id: m.id, error: String(e?.message ?? e).slice(0, 300) });
    }
  }
  for (const id of touched) {
    try { await deps.takeIn(id); res.foldersTakenIn.push(id); }
    catch (e: any) { res.takeInErrors.push({ folderId: id, error: String(e?.message ?? e).slice(0, 300) }); }
  }
  return res;
}

export interface LoopOptions {
  sqs: SqsApi;
  queueUrl: string;
  deps: () => Promise<EventDeps>;
  /** Long-poll wait per receive; SQS's maximum is 20 seconds. */
  waitSec?: number;
  /** Pause after an error before polling again. */
  errorPauseMs?: number;
  onResult?: (r: EventsResult) => void;
}

/**
 * Poll the queue until stopped. One receive at a time: the batch is handled
 * and its messages deleted before the next receive, so a slow fetch never
 * has two passes racing over one folder.
 */
export function startS3EventLoop(o: LoopOptions): () => Promise<void> {
  let stopped = false;
  const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); (t as any).unref?.(); });
  const run = (async () => {
    while (!stopped) {
      try {
        const t0 = Date.now();
        const msgs = await o.sqs.receive(o.queueUrl, 10, o.waitSec ?? 20);
        if (!msgs.length) {
          // A long poll that comes back empty at once (a stand-in that does
          // not wait, a queue with long polling off) must not become a busy
          // loop hammering the endpoint.
          if (Date.now() - t0 < 1000) await sleep(1000);
          continue;
        }
        const r = await handleS3Messages(msgs, await o.deps());
        for (const receipt of r.done) await o.sqs.delete(o.queueUrl, receipt);
        o.onResult?.(r);
      } catch (e: any) {
        if (stopped) break;
        console.error('[s3 watch] queue poll failed:', String(e?.message ?? e));
        await sleep(o.errorPauseMs ?? 30_000);
      }
    }
  })();
  return async () => { stopped = true; await run.catch(() => undefined); };
}

/** Start the loop from the control plane's settings, or not at all when no queue is set. */
export async function startFromConfig(): Promise<(() => Promise<void>) | null> {
  const { config } = await import('../../config');
  const url = config.ingest.s3EventsQueueUrl;
  if (!url) return null;
  const { realSqs } = await import('../ingest/sqs');
  const store = await import('./store');
  const sqs = await realSqs({ region: config.aws.region, endpoint: config.ingest.s3EventsEndpoint });
  console.log(`[s3 watch] listening for drops on ${url} (walk every ${config.ingest.s3BackstopMinutes} min as the backstop)`);
  return startS3EventLoop({
    sqs, queueUrl: url, deps: store.s3EventDeps,
    onResult: (r) => {
      if (r.outcomes.downloaded || r.kept.length || r.takeInErrors.length) {
        console.log(`[s3 watch] ${r.messages} message(s): ${r.outcomes.downloaded} fetched, ${r.outcomes.known} already known, `
          + `${r.foldersTakenIn.length} folder(s) taken in${r.kept.length ? `, ${r.kept.length} kept for retry` : ''}`
          + `${r.takeInErrors.length ? `, ${r.takeInErrors.length} take-in error(s)` : ''}`);
      }
    },
  });
}
