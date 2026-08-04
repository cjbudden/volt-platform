import { Response } from 'express';

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

export function publish(accountId: string, event: string, data: unknown): void {
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
