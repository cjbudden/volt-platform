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
// ============================================================================

export interface BeaconOptions {
  url: string;
  /** The session id to use: the play attempt's CMCD sid (sdk/cmcd.ts). Else a new one. */
  id?: string;
  token: string;
  prefix: string;
  /** Current bitrate in kbps, if known. */
  kbps: () => number | undefined;
}

const HEARTBEAT_MS = 30_000;
const newId = (p: string) => `${p}-${(globalThis.crypto as any)?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2)}`;

export class Beacons {
  private o: BeaconOptions;
  private id: string;
  private started = false;
  private ended = false;
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
    if (!this.started || this.ended) return;
    this.ended = true;
    this.send('end', { seconds: Math.round(this.watched) }, last);
    this.watched = 0;
  }

  destroy(): void {
    this.end(true);
    clearInterval(this.timer);
    for (const f of this.off) { try { f(); } catch { /* */ } }
    this.off = [];
  }

  private send(event: string, extra: Record<string, unknown>, last = false) {
    try {
      const body = JSON.stringify({ playbackToken: this.o.token, sessionId: this.id, event, ...extra });
      if (last && navigator.sendBeacon) { navigator.sendBeacon(this.o.url, new Blob([body], { type: 'application/json' })); return; }
      void fetch(this.o.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: last, credentials: 'omit' }).catch(() => {});
    } catch { /* reporting never breaks playback */ }
  }
}
