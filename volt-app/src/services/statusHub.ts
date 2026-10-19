import { Response } from 'express';
import { onNotify, listenerConnected, notify } from '../scale/notify';

/**
 * In-process Server-Sent-Events hub for live stream status.
 *
 * Subscribers are grouped by tenant (account_id) so a client only ever receives
 * its own streams' updates. `publish` fans a payload out to every open response
 * for that account.
 *
 * Scope note: this hub is per-process. With a single always-on control-plane
 * task it is sufficient. To run 2+ control-plane instances, back the fan-out
 * with Postgres LISTEN/NOTIFY (ingest does `NOTIFY stream_status, <json>`; each
 * instance LISTENs and calls `publish`) — no extra infrastructure, and the
 * public API below does not change. That upgrade is isolated to this file.
 */
type Client = { res: Response };

const byAccount = new Map<string, Set<Client>>();

export function subscribe(accountId: string, res: Response): () => void {
  let set = byAccount.get(accountId);
  if (!set) {
    set = new Set();
    byAccount.set(accountId, set);
  }
  const client: Client = { res };
  set.add(client);
  return () => {
    set!.delete(client);
    if (set!.size === 0) byAccount.delete(accountId);
  };
}

/**
 * CROSS-PROCESS FAN-OUT (scale). With more than one admin API process, a
 * browser's SSE stream is held by one of them while the status update may be
 * produced by another (an encoder report, the scheduler). publish() therefore
 * sends the frame through Postgres NOTIFY on `volt_status` and every process
 * delivers it to its own subscribers, exactly as the note above planned. With
 * no listener connected (single process, or the listener is reconnecting) it
 * delivers locally as before. Frames too big for NOTIFY (~8 kB) go local only.
 */
let fanout = false;
// NOTIFYs go out one at a time so frames keep their order (two pool
// connections could otherwise deliver 'ended' before 'live').
let chain: Promise<void> = Promise.resolve();

export function wireStatusFanout(): void {
  if (fanout) return;
  fanout = true;
  onNotify('volt_status', (payload) => {
    try {
      const m = JSON.parse(payload);
      publishLocal(m.a, m.e, m.d);
    } catch { /* malformed frame: ignore */ }
  });
}

export function publish(accountId: string, event: string, data: unknown): void {
  const payload = fanout && listenerConnected() ? JSON.stringify({ a: accountId, e: event, d: data }) : null;
  if (!payload || Buffer.byteLength(payload) >= 7900) {
    publishLocal(accountId, event, data);
    return;
  }
  chain = chain.then(() => notify('volt_status', payload)).catch(() => publishLocal(accountId, event, data));
}

function publishLocal(accountId: string, event: string, data: unknown): void {
  const set = byAccount.get(accountId);
  if (!set || set.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of set) {
    try {
      c.res.write(frame);
    } catch {
      /* a dead socket is cleaned up by its own close handler */
    }
  }
}

/** Send an SSE comment to every client as a keep-alive (proxies drop idle conns). */
export function heartbeat(): void {
  for (const set of byAccount.values()) {
    for (const c of set) {
      try {
        c.res.write(`: ping\n\n`);
      } catch {
        /* ignore */
      }
    }
  }
}

export function subscriberCount(): number {
  let n = 0;
  for (const set of byAccount.values()) n += set.size;
  return n;
}
