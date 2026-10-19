/**
 * API KEY USAGE METERING, BATCHED.
 *
 * verifyKey() used to run `UPDATE api_keys SET request_count = request_count+1`
 * on every request. Every viewer of an app presents the same publishable key,
 * so every viewer queued on ONE row lock: about 1-2 ms each, a ceiling of
 * 500-1,000 viewer starts a second however large the database.
 *
 * Now each process counts in memory and writes every key's total in one
 * statement every KEY_USAGE_FLUSH_SEC (default 10 s). With 30 processes that
 * row is written ~3 times a second instead of 16,000.
 *
 * Trade: a process that dies hard loses at most one interval of counts. A
 * graceful stop flushes. Billing that must be exact belongs in the analytics
 * pipeline, not in this counter.
 */
import { query } from '../db';
import { scaleConfig } from './config';

const counts = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;

export function noteKeyUse(keyId: string): void {
  counts.set(keyId, (counts.get(keyId) ?? 0) + 1);
}

export function pendingKeyUse(): number {
  let n = 0;
  for (const v of counts.values()) n += v;
  return n;
}

export async function flushKeyUsage(): Promise<void> {
  if (flushing) return flushing;
  if (!counts.size) return;
  const batch = [...counts.entries()];
  counts.clear();
  flushing = (async () => {
    try {
      await query(
        `UPDATE api_keys k
            SET request_count = k.request_count + v.n,
                last_used_at  = now()
           FROM unnest($1::uuid[], $2::bigint[]) AS v(id, n)
          WHERE k.id = v.id`,
        [batch.map((b) => b[0]), batch.map((b) => b[1])]
      );
    } catch (e) {
      // Put the counts back so the next flush carries them.
      for (const [id, n] of batch) counts.set(id, (counts.get(id) ?? 0) + n);
      console.error('[key-usage] flush failed, will retry', (e as Error).message);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

export function startKeyUsage(): void {
  if (timer) return;
  timer = setInterval(() => { void flushKeyUsage(); }, scaleConfig.keyUsage.flushSec * 1000);
  timer.unref();
}

export async function stopKeyUsage(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await flushKeyUsage();
}
