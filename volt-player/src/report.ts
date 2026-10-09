// ============================================================================
//  PLAYER REPORTING.
//
//  Two destinations from one call site, because an operator and a marketer ask
//  different questions of the same events and neither should have to wire the
//  other's tool.
//
//    VOLT       every event, batched, to the control plane. Answers "is this
//               embed working" — did the bundle load, did the manifest
//               resolve, is it erroring on one site and not another.
//    ANALYTICS  the same events forwarded to Google Analytics if, and only if,
//               the host page already has it. Answers "are people listening".
//
//  ------------------------------------------------------------------------
//  BATCHED, AND FLUSHED ON THE WAY OUT.
//
//  A request per play and pause from every embed on the internet is a lot of
//  requests to learn very little. Events are queued and flushed on a timer, on
//  a full batch, and — the one that matters — on `pagehide`, using
//  sendBeacon so the browser delivers it after the page is gone. Without that
//  last part every session ends with its final events lost, which is exactly
//  the moment you most want to know what happened.
//
//  `visibilitychange` is used rather than `unload`, because `unload` is
//  unreliable on mobile Safari and prevents the back/forward cache.
//
//  ------------------------------------------------------------------------
//  REPORTING NEVER BREAKS PLAYBACK. Every path here is wrapped: a blocked
//  endpoint, a CSP that forbids the beacon, an ad blocker eating the request,
//  a host page with a broken gtag shim — none of them may stop the audio. The
//  worst outcome allowed is that we learn nothing.
// ============================================================================
import type { PlayerEvent, PlayerEventName } from './types';

interface ReporterOptions {
  url: string;
  appKey: string;
  channelId: string;
  sessionId: string;
  layout: string;
  onEvent?: (e: PlayerEvent) => void;
  /** Flush after this many ms, or when the batch is full. */
  flushMs?: number;
  maxBatch?: number;
}

/** The server caps a batch at fifty; stay under it rather than being rejected. */
const MAX_BATCH = 25;

export class Reporter {
  private queue: PlayerEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  // See the note in core.ts: `erasableSyntaxOnly` forbids parameter properties.
  private o: ReporterOptions;
  constructor(o: ReporterOptions) {
    this.o = o;
    const flush = () => { try { this.flush(true); } catch { /* never throw at unload */ } };
    try {
      // pagehide fires on mobile Safari where unload does not, and does not
      // disqualify the page from the back/forward cache.
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
      });
    } catch { /* no window: a test or a worker. Reporting is simply inert. */ }
  }

  /**
   * Record an event.
   *
   * The caller's own hook runs FIRST and outside the try that follows, so an
   * embedder's onEvent throwing is visible to them in the console rather than
   * silently swallowed by our error handling — but still cannot stop the
   * event being reported.
   */
  emit(event: PlayerEventName, detail?: Record<string, unknown>): void {
    const e: PlayerEvent = { event, at: Date.now(), layout: this.o.layout, detail };
    try { this.o.onEvent?.(e); } catch (err) { console.warn('[volt-player] onEvent threw', err); }
    try { this.toAnalytics(e); } catch { /* analytics must never break playback */ }
    if (this.closed) return;
    this.queue.push(e);
    if (this.queue.length >= (this.o.maxBatch ?? MAX_BATCH)) { this.flush(false); return; }
    if (this.timer == null) {
      this.timer = setTimeout(() => this.flush(false), this.o.flushMs ?? 5000);
    }
  }

  /**
   * Forward to Google Analytics IF THE PAGE ALREADY HAS IT.
   *
   * Deliberately never loads gtag.js. Injecting an analytics script into
   * somebody else's website because they embedded an audio player is not ours
   * to do: it changes their privacy posture, may breach their own consent
   * banner, and would be invisible to them. If they have already made that
   * choice, `gtag` or `dataLayer` is on the page and we use it; if not, we
   * stay quiet.
   */
  private toAnalytics(e: PlayerEvent): void {
    const w = window as any;
    const params = {
      event_category: 'volt_player',
      station_id: this.o.channelId,
      player_session: this.o.sessionId,
      layout: this.o.layout,
      ...(e.detail ?? {}),
    };
    if (typeof w.gtag === 'function') {
      // GA4 event names may not contain a dot.
      w.gtag('event', e.event.replace(/\./g, '_'), params);
      return;
    }
    if (Array.isArray(w.dataLayer)) {
      w.dataLayer.push({ event: `volt_${e.event.replace(/\./g, '_')}`, ...params });
    }
  }

  /**
   * Send what is queued.
   *
   * `final` picks the transport rather than the payload: sendBeacon is the only
   * thing that survives the page going away, but it cannot set headers and is
   * fire-and-forget, so it is used only when there will be no other chance.
   */
  flush(final: boolean): void {
    if (this.timer != null) { clearTimeout(this.timer); this.timer = null; }
    if (!this.queue.length) return;
    const events = this.queue.splice(0, this.queue.length);
    const body = JSON.stringify({
      appKey: this.o.appKey,
      channelId: this.o.channelId,
      sessionId: this.o.sessionId,
      events,
    });

    try {
      if (final && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        // text/plain rather than application/json: a JSON content type makes
        // the beacon a non-simple request, which triggers a CORS preflight that
        // sendBeacon cannot perform. The server reads the body regardless.
        navigator.sendBeacon(this.o.url, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
        return;
      }
      void fetch(this.o.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
        // No credentials: the publishable key IS the credential, and asking for
        // cookies would make every embed a cross-site request the browser has
        // to be persuaded to allow.
        credentials: 'omit',
      }).catch(() => { /* an ad blocker ate it. Not our problem to solve. */ });
    } catch { /* nothing here may reach the caller */ }
  }

  close(): void {
    this.flush(true);
    this.closed = true;
  }
}

/** A session id for one player instance. Not a person, and not persisted. */
export function newSessionId(): string {
  try {
    const a = new Uint8Array(9);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // No crypto (an old browser, an odd sandbox). Still needs to be unique
    // enough to group one instance's events; it identifies nobody either way.
    return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
}
