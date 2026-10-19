/**
 * CROSS-PROCESS SIGNALS OVER POSTGRES LISTEN/NOTIFY.
 *
 * One dedicated connection per process listens on a handful of channels:
 *
 *   volt_cache   'tag'          a row changed; drop cached entries carrying the tag
 *   volt_status  '<json>'       a live-status frame for the SSE hub (statusHub.ts)
 *
 * Why Postgres and not Valkey pub/sub: the triggers that announce a change run
 * in the same transaction as the change, so the signal cannot be lost between
 * "committed" and "published", and it works on a box with no Valkey at all.
 *
 * If the connection drops, notifications sent meanwhile are lost. Every
 * subscriber is therefore also told when the connection comes back
 * (onReconnect), and the cache answers that by dropping everything.
 */
import { Client } from 'pg';
import { scaleConfig } from './config';
import { pool } from '../db';

type Handler = (payload: string) => void;

const handlers = new Map<string, Set<Handler>>();
const reconnectHooks = new Set<() => void>();
let client: Client | null = null;
let connected = false;
let stopping = false;
let retryMs = 1000;
let timer: NodeJS.Timeout | null = null;

export function onNotify(channel: string, fn: Handler): () => void {
  let set = handlers.get(channel);
  if (!set) {
    set = new Set();
    handlers.set(channel, set);
    if (client && connected) client.query(`LISTEN ${channel}`).catch(() => {});
  }
  set.add(fn);
  return () => set!.delete(fn);
}

export function onReconnect(fn: () => void): void {
  reconnectHooks.add(fn);
}

export function listenerConnected(): boolean {
  return connected;
}

/** Send a notification. Payloads over ~7.9 kB are refused by Postgres. */
export async function notify(channel: string, payload: string): Promise<void> {
  await pool.query('SELECT pg_notify($1, $2)', [channel, payload]);
}

async function connect(): Promise<void> {
  if (stopping) return;
  const c = new Client({ connectionString: scaleConfig.listenUrl, application_name: 'volt-listen' });
  c.on('notification', (m) => {
    const set = handlers.get(m.channel);
    if (!set) return;
    for (const fn of set) {
      try { fn(m.payload ?? ''); } catch (e) { console.error('[notify] handler failed', m.channel, e); }
    }
  });
  const lost = (why: string) => {
    if (client !== c) return;
    connected = false;
    client = null;
    if (stopping) return;
    console.error(`[notify] listener connection lost (${why}); retrying in ${retryMs} ms`);
    c.end().catch(() => {});
    timer = setTimeout(() => { connect().catch(() => {}); }, retryMs);
    retryMs = Math.min(retryMs * 2, 30_000);
  };
  c.on('error', (e) => lost(e.message));
  c.on('end', () => lost('ended'));
  client = c;
  try {
    await c.connect();
    for (const ch of handlers.keys()) await c.query(`LISTEN ${ch}`);
    const wasRetry = retryMs > 1000;
    connected = true;
    retryMs = 1000;
    // Anything announced while we were away is gone: tell subscribers.
    for (const fn of reconnectHooks) { try { fn(); } catch { /* ignore */ } }
    if (wasRetry) console.log('[notify] listener reconnected');
  } catch (e: any) {
    lost(e?.message ?? 'connect failed');
  }
}

export async function startListener(): Promise<void> {
  stopping = false;
  if (!client) await connect();
}

export async function stopListener(): Promise<void> {
  stopping = true;
  if (timer) clearTimeout(timer);
  const c = client;
  client = null;
  connected = false;
  if (c) await c.end().catch(() => {});
}
