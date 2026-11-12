// ============================================================================
//  VIEWER BEACONS: what Analytics counts (docs/REPORTING_TESTING.md).
//
//  A session per item: `start` when the first frame plays (with the time it
//  took), a `heartbeat` every 30 s with the seconds actually watched and the
//  bitrate, and `end` when the item changes, the player is destroyed, or the
//  page is hidden or closed (sendBeacon, so it survives the page going away).
//  Coming back to a tab that is still playing starts a new session.
//
//  Seconds watched are counted from the playhead moving while not paused, so
//  a paused tab, a seek, or a stalled stream does not inflate watch time.
//  Reporting never breaks playback: every send is wrapped.
//
//  CONCURRENT STREAMS (build queue P3-4d-2). The heartbeats are what keep a
//  counted play open, and their answer is how a play stopped by the limit
//  learns it: `stop: { code, message }`. Then `onStop` is called once, the
//  beacons halt (no `end`: the server already closed the play) and the player
//  stops and shows the message.
// ============================================================================

export interface BeaconOptions {
  url: string;
  /** The session id to use: the play attempt's CMCD sid (sdk/cmcd.ts). Else a new one. */
  id?: string;
  token: string;
  prefix: string;
  /** Current bitrate in kbps, if known. */
  kbps: () => number | undefined;
  /** The server stopped this play (the concurrent streams limit): what it said. */
  onStop?: (stop: { code: string; message: string }) => void;
}

const HEARTBEAT_MS = 30_000;
const newId = (p: string) => `${p}-${(globalThis.crypto as any)?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2)}`;

export class Beacons {
  private o: BeaconOptions;
  private id: string;
  private started = false;
  private ended = false;
  private halted = false;
  private watched = 0;
  private lastT: number | null = null;
  private t0 = performance.now();
  private timer: ReturnType<typeof setInterval>;
  private off: Array<() => void> = [];

  constructor(media: HTMLMediaElement, o: BeaconOptions) {
    this.o = o;
    this.id = o.id ?? newId(o.prefix);
    const on = <K extends keyof HTMLMediaElementEventMap>(el: HTMLMediaElement, ev: K, fn: () => void) => { el.addEventListener(ev, fn); this.off.push(() => el.removeEventListener(ev, fn)); };
    on(media, 'playing', () => {
      if (this.started) return;
      this.started = true;
      this.send('start', { ttffMs: Math.round(performance.now() - this.t0), bitrateKbps: this.o.kbps() });
    });
    on(media, 'timeupdate', () => {
      const t = media.currentTime;
      if (this.lastT != null && !media.paused) { const d = t - this.lastT; if (d > 0 && d < 5) this.watched += d; }
      this.lastT = t;
    });
    on(media, 'seeking', () => { this.lastT = null; });
    this.timer = setInterval(() => {
      if (!this.started || this.ended) return;
      const s = Math.round(this.watched);
      this.watched -= s;
      this.send('heartbeat', { seconds: s, bitrateKbps: this.o.kbps() });
    }, HEARTBEAT_MS);
    const hide = () => this.end(true);
    const vis = () => {
      if (document.visibilityState === 'hidden') this.end(true);
      else if (this.ended && !media.paused) {
        this.id = newId(this.o.prefix); this.ended = false; this.watched = 0; this.started = true;
        this.send('start', { bitrateKbps: this.o.kbps() });
      }
    };
    addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', vis);
    this.off.push(() => removeEventListener('pagehide', hide), () => document.removeEventListener('visibilitychange', vis));
  }

  get sessionId(): string { return this.id; }

  /** Close the session (item change, page hidden, destroy). */
  end(last = false): void {
    if (!this.started || this.ended || this.halted) return;
    this.ended = true;
    this.send('end', { seconds: Math.round(this.watched) }, last);
    this.watched = 0;
  }

  destroy(): void {
    this.end(true);
    this.halt();
  }

  /** Stop reporting without an `end` (the server stopped this play). */
  private halt(): void {
    this.halted = true;
    clearInterval(this.timer);
    for (const f of this.off) { try { f(); } catch { /* */ } }
    this.off = [];
  }

  private heard(j: any): void {
    const st = j?.stop;
    if (this.halted || !st || typeof st !== 'object') return;
    this.halt();
    const message = typeof st.message === 'string' && st.message.trim() ? st.message.trim().slice(0, 300) : 'Playback stopped.';
    try { this.o.onStop?.({ code: typeof st.code === 'string' ? st.code : 'stopped', message }); } catch { /* a listener never breaks playback */ }
  }

  private send(event: string, extra: Record<string, unknown>, last = false) {
    if (this.halted) return;
    try {
      const body = JSON.stringify({ playbackToken: this.o.token, sessionId: this.id, event, ...extra });
      if (last && navigator.sendBeacon) { navigator.sendBeacon(this.o.url, new Blob([body], { type: 'application/json' })); return; }
      void fetch(this.o.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: last, credentials: 'omit' })
        .then((r) => (last || !r.ok ? null : r.json().catch(() => null)))
        .then((j) => { if (j) this.heard(j); })
        .catch(() => {});
    } catch { /* reporting never breaks playback */ }
  }
}
