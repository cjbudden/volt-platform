// ============================================================================
//  PARALLEL RANGE FETCH into a local file.
//
//  A provider's per-connection rate is the ceiling of a cloud to cloud copy.
//  Eight to sixteen ranges in flight multiply it. Each range is written at
//  its offset with pwrite, so order does not matter and a failed range is
//  retried alone. When the server does not honour Range the whole file
//  streams once, which is still cloud to cloud, just not multiplied.
// ============================================================================
import { open } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { RemoteError } from './types';

export interface FetchPlan {
  bytes: number | null;
  ranges: boolean;
  /** Return a Response whose body is bytes [start, end] inclusive, or the whole body when start/end are null. */
  open: (start: number | null, end: number | null) => Promise<Response>;
}

export interface FetchOptions {
  rangeBytes?: number;      // default 64 MB
  parallel?: number;        // default 8
  retries?: number;         // per range, default 4
  onProgress?: (done: number, total: number | null) => void;
  signal?: AbortSignal;
}

export interface FetchResult { bytes: number; sha256: string }

async function readAll(res: Response): Promise<Buffer> {
  if (!res.ok && res.status !== 206) throw new RemoteError(`HTTP ${res.status}`, res.status, res.status >= 500 || res.status === 429 || res.status === 408);
  return Buffer.from(await res.arrayBuffer());
}

/** Fetch to `path`. Returns size and sha256 (computed in a second sequential pass for the parallel case). */
export async function fetchToFile(plan: FetchPlan, path: string, o: FetchOptions = {}): Promise<FetchResult> {
  mkdirSync(dirname(path), { recursive: true });
  const rangeBytes = o.rangeBytes ?? 64 * 1024 * 1024;
  const retries = o.retries ?? 4;
  const fh = await open(path, 'w');
  try {
    if (!plan.ranges || plan.bytes == null || plan.bytes <= rangeBytes) {
      // Single stream.
      const res = await plan.open(null, null);
      if (!res.ok) throw new RemoteError(`HTTP ${res.status}`, res.status, res.status >= 500);
      const h = createHash('sha256'); let n = 0;
      const reader = (res.body as any)?.getReader ? (res.body as ReadableStream<Uint8Array>).getReader() : null;
      if (reader) {
        for (;;) { const { done, value } = await reader.read(); if (done) break; await fh.write(value, 0, value.length, n); h.update(value); n += value.length; o.onProgress?.(n, plan.bytes); if (o.signal?.aborted) throw new RemoteError('cancelled', 499, false); }
      } else { const buf = await readAll(res); await fh.write(buf, 0, buf.length, 0); h.update(buf); n = buf.length; }
      if (plan.bytes != null && n !== plan.bytes) throw new RemoteError(`received ${n} bytes, expected ${plan.bytes}`, 502, true);
      return { bytes: n, sha256: h.digest('hex') };
    }
    // Parallel ranges.
    const total = plan.bytes;
    const count = Math.ceil(total / rangeBytes);
    let next = 0, done = 0, failed: any = null;
    const worker = async () => {
      for (;;) {
        const i = next++; if (i >= count || failed) return;
        const start = i * rangeBytes, end = Math.min(total, start + rangeBytes) - 1;
        let attempt = 0;
        for (;;) {
          try {
            if (o.signal?.aborted) throw new RemoteError('cancelled', 499, false);
            const res = await plan.open(start, end);
            const buf = await readAll(res);
            if (buf.length !== end - start + 1) throw new RemoteError(`range ${start}-${end} returned ${buf.length} bytes`, 502, true);
            await fh.write(buf, 0, buf.length, start);
            done += buf.length; o.onProgress?.(done, total);
            break;
          } catch (e: any) {
            if (!(e instanceof RemoteError) || !e.retryable || ++attempt > retries) { failed = e; return; }
            await new Promise((r) => setTimeout(r, Math.min(10000, 250 * 2 ** attempt)));
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(o.parallel ?? 8, count) }, worker));
    if (failed) throw failed;
  } finally { await fh.close(); }
  // Hash pass: sequential read, the price of parallel writes.
  const h = createHash('sha256');
  const rf = await open(path, 'r');
  try { const buf = Buffer.alloc(4 * 1024 * 1024); let pos = 0; for (;;) { const { bytesRead } = await rf.read(buf, 0, buf.length, pos); if (!bytesRead) break; h.update(buf.subarray(0, bytesRead)); pos += bytesRead; } return { bytes: pos, sha256: h.digest('hex') }; }
  finally { await rf.close(); }
}
