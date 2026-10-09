// ============================================================================
//  Shared live-status client (SSE) — the production live layer.
//
//  ONE EventSource for the whole admin app, connected to the control plane's SSE
//  hub (GET /api/status/stream). Every stream's status/event for the tenant arrives
//  on this single socket, so it scales to hundreds of channels WITHOUT one socket
//  per channel. Consumers subscribe by key and refetch what they need on a change.
//
//  Robustness (production):
//   - lazy connect on first subscriber; disconnect when the last one leaves.
//   - on (re)connect, every subscriber gets a 'resync' so it re-reads current state
//     and nothing is missed across a gap.
//   - on error we close and reconnect with a FRESH ticket (the access token can
//     rotate), with a short backoff. No per-channel sockets, no leaks.
//
//  Keys: 'channel:<id>' | 'event:<id>' for one stream, or '*' for all (list/monitor).
// ============================================================================
import { getToken } from './api'

export interface LiveMsg {
  kind: string
  id: string
  type: 'status' | 'event' | 'resync' | 'record'
  /** 'record' only: which columns another admin changed. The VALUES are never
   *  sent — the page re-reads through its own credential, so a frame cannot
   *  hand a viewer a field they are not allowed to see. */
  changed?: string[]
  /** 'record' only: the entity's version AFTER that edit. A page holding an
   *  older version knows its copy is stale, which is what turns a silent
   *  overwrite into a warning the operator can act on. */
  version?: number
  /** 'record' only: the user id behind the edit, or null for a system write. */
  by?: string | null
}
type Listener = (msg: LiveMsg) => void

const listeners = new Map<string, Set<Listener>>();
let es: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let refCount = 0;
/**
 * Consecutive failed connect attempts, for the backoff.
 *
 * The header above promised "a short backoff" and the code was a flat 3000ms
 * with no ceiling and no attempt counter. EventSource cannot see a status
 * code, so a token the server rejects looks exactly like a dropped socket:
 * an expired session opened a new stream every three seconds, forever,
 * invisibly, for as long as the tab stayed open. Real backoff, and a cap on
 * how long we keep trying with a credential the server keeps refusing.
 */
let attempts = 0;
/** Give up after this many consecutive failures (~2 minutes of trying). */
const MAX_ATTEMPTS = 12;

/** Called when the stream gives up. App/pages fall back to their own polling. */
let onGaveUp: (() => void) | null = null;
export function setLiveGaveUpHandler(fn: (() => void) | null) { onGaveUp = fn; }

/** Reset the backoff — call after a fresh sign-in, so the stream tries again. */
export function resetLiveBackoff() {
  attempts = 0;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (refCount > 0) connect();
}

function notify(key: string, msg: LiveMsg) {
  const set = listeners.get(key);
  if (set) for (const cb of set) { try { cb(msg); } catch { /* ignore */ } }
}
function dispatch(msg: LiveMsg) { notify(`${msg.kind}:${msg.id}`, msg); notify('*', msg); }
/** Tell every subscriber to resync (used on connect/reconnect to catch any gap). */
function resyncAll() { for (const set of listeners.values()) for (const cb of set) { try { cb({ kind: '*', id: '*', type: 'resync' }); } catch { /* ignore */ } } }

function scheduleReconnect() {
  if (reconnectTimer || refCount === 0) return;
  if (attempts >= MAX_ATTEMPTS) {
    // Stop. Something is refusing us and retrying will not change that. Pages
    // poll on their own timers, so the console keeps working; it just stops
    // pretending it has a live feed.
    console.warn('[live] giving up on the status stream after', attempts, 'attempts');
    onGaveUp?.();
    return;
  }
  // 1s, 2s, 4s … capped at 30s, with jitter so a fleet of tabs recovering from
  // one restart does not arrive back in lockstep.
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5));
  const wait = base * (0.7 + Math.random() * 0.6);
  attempts++;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
}

function connect() {
  if (es || refCount === 0) return;
  const t = getToken();
  if (!t) { scheduleReconnect(); return; }   // not logged in yet; retry shortly
  let source: EventSource;
  try { source = new EventSource(`/api/status/stream?ticket=${encodeURIComponent(t)}`); }
  catch { scheduleReconnect(); return; }
  es = source;
  const onData = (type: 'status' | 'event') => (e: MessageEvent) => {
    try { const d = JSON.parse(e.data); if (d && d.id && d.kind) dispatch({ kind: d.kind, id: d.id, type }); }
    catch { /* ignore malformed frame */ }
  };
  // ANOTHER ADMIN EDITED A RECORD YOU MAY BE LOOKING AT. Carries the shape of
  // the change rather than its content: which fields moved, the new version,
  // and who. Subscribers decide whether that concerns them.
  const onRecord = (e: MessageEvent) => {
    try {
      const d = JSON.parse(e.data);
      if (!d || !d.id || !d.kind) return;
      dispatch({
        kind: String(d.kind), id: String(d.id), type: 'record',
        changed: Array.isArray(d.changed) ? d.changed.map(String) : [],
        version: Number.isFinite(d.version) ? Number(d.version) : undefined,
        by: d.by ?? null,
      });
    } catch { /* ignore malformed frame */ }
  };
  // A connection that actually opened clears the backoff.
  source.addEventListener('open', () => { attempts = 0; resyncAll(); });
  source.addEventListener('status', onData('status') as EventListener);
  source.addEventListener('event', onData('event') as EventListener);
  source.addEventListener('record', onRecord as EventListener);
  source.onerror = () => { try { source.close(); } catch { /* ignore */ } if (es === source) es = null; scheduleReconnect(); };
}

/** Subscribe to live changes for a key. Returns an unsubscribe fn. */
export function subscribeLive(key: string, cb: Listener): () => void {
  let set = listeners.get(key);
  if (!set) { set = new Set(); listeners.set(key, set); }
  set.add(cb);
  refCount++;
  connect();
  return () => {
    const s = listeners.get(key);
    if (s) { s.delete(cb); if (s.size === 0) listeners.delete(key); }
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { es?.close(); } catch { /* ignore */ }
      es = null;
    }
  };
}
