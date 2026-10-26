// ============================================================================
//  JOURNEY TO PLAY: HOW THE VIEWER GOT TO THE PLAY BUTTON (QOE_REPORTING.md 13).
//
//  Not a general analytics SDK. A fixed set of about ten app events, so Volt
//  can join the way to a play (home, a row, a detail page, search, a deep
//  link) to what happened after it, which only Volt sees: the play gate,
//  payment, startup, QoE and watch time. Google Analytics and the like keep
//  doing page analytics; `forward` passes the same events to them.
//
//    const journey = new VoltJourney({ appKey: 'pk_...', apiBase: 'https://api...',
//      app: 'My TV', appVersion: '4.2.0', consent: false,
//      routes: { '/': 'home', '/watch/:id': 'detail', '/search': 'search' } });
//    journey.setConsent(true);                 // once the viewer agrees
//    journey.select('a1b2', { entry: 'row:Trending', position: 3 });
//    VoltPlayer.create({ ..., journey });       // the play carries the journey
//
//  SCREENS are captured from the browser's history (pushState, replaceState,
//  popstate, hashchange), named by the route map or the path; routers that do
//  not change the URL call journey.screen(name, { type, contentId }).
//
//  IDS. An app session id (a new one after 30 minutes in the background) and
//  a journey id that starts at select() or a deep link and is carried into the
//  play attempt (the attempt's first CMCD report and play_intent), so every
//  view row knows its entry point and how many screens came before it.
//
//  CONSENT. With `consent: false` nothing is sent, nothing is queued and
//  nothing is forwarded until setConsent(true); setConsent(false) stops and
//  forgets what is queued. No personal data: no user ids, no advertising
//  ids, the search query only as a SHA-256 hash and only if `searchQuery:
//  'hash'` (left out by default).
// ============================================================================
import { CmcdSender, newSid } from './cmcd';

export const JOURNEY_SESSION_GAP_MS = 30 * 60_000;
/** Distinct custom event names per app session; the collector caps props too. */
export const TRACK_MAX_NAMES = 20;
const VOLT_KEY = 'com.volt-';

export type EntryKind = 'row' | 'search' | 'deeplink' | 'push' | 'epg' | 'continue' | 'related' | 'other';
export type ScreenType = 'home' | 'browse' | 'detail' | 'search' | 'player' | 'account' | 'other';
export type JourneyEventName = 'app_open' | 'app_close' | 'screen' | 'content_select' | 'search' | 'paywall_show' | 'purchase'
  | 'play_intent' | 'background' | 'foreground' | 'track';
export type JourneyEvent = { v: 1; e: JourneyEventName; ts: number; asid: string; sn: number; jid?: string } & Record<string, unknown>;

/** Where the same events go as well (GA4, Firebase, Segment): called after Volt has them. */
export type JourneyForward = (ev: JourneyEvent) => void;

export interface RouteInfo { name: string; type?: ScreenType; contentId?: string | null }
export type RouteMap = Record<string, string | { name: string; type?: ScreenType }>;

export interface JourneyOptions {
  appKey: string;
  /** The Volt API's address, as the player's apiBase (default: this page's origin). */
  apiBase?: string;
  /** The collector (default `${api}/api/journey`). */
  url?: string;
  app?: string; appVersion?: string;
  /** false: send nothing until setConsent(true). Default true (no consent needed). */
  consent?: boolean;
  /** Capture screens from the browser's history. Default true. */
  autoScreens?: boolean;
  /** Path patterns (`/watch/:id`, `:id` is the content id) to screen names, and their type. */
  routes?: RouteMap;
  /** Search: 'omit' (default) sends only the results count; 'hash' adds a SHA-256 of the query. */
  searchQuery?: 'omit' | 'hash';
  forward?: JourneyForward | JourneyForward[];
  /** How the app was opened: the SDK reads ?utm_medium=push and a referrer by itself; set it when the app knows better. */
  launch?: 'icon' | 'deeplink' | 'push' | 'other';
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** For tests: where events are sent instead of the collector. */
  sink?: { push(line: string, urgent?: boolean): void; flush(last?: boolean): unknown };
  /** Start listening to the page (history, visibility, unload). Default true in a browser. */
  listen?: boolean;
}

const TYPE_GUESS: Array<[RegExp, ScreenType]> = [
  [/^\/?$/, 'home'], [/search/i, 'search'], [/account|profile|settings|login|sign/i, 'account'],
  [/watch|play|player/i, 'player'], [/detail|title|movie|show|episode|video|asset|item/i, 'detail'], [/browse|category|genre|collection|section/i, 'browse'],
];

function matchRoute(path: string, routes: RouteMap | undefined): RouteInfo {
  const clean = path.split(/[?#]/)[0] || '/';
  if (routes) {
    for (const [pat, to] of Object.entries(routes)) {
      const names: string[] = [];
      const re = new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/:(\w+)/g, (_m, n) => { names.push(n); return '([^/]+)'; }) + '/?$');
      const m = clean.match(re);
      if (!m) continue;
      const i = names.indexOf('id');
      const info = typeof to === 'string' ? { name: to } : to;
      return { name: info.name, type: info.type ?? guessType(info.name), contentId: i >= 0 ? decodeURIComponent(m[i + 1]) : null };
    }
  }
  return { name: clean.slice(0, 64), type: guessType(clean), contentId: null };
}
function guessType(s: string): ScreenType {
  for (const [re, t] of TYPE_GUESS) if (re.test(s)) return t;
  return 'other';
}

async function sha256(text: string): Promise<string | null> {
  try {
    const d = await (globalThis as any).crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.trim().toLowerCase()));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

/** Parse 'row:Trending' into a kind and a detail. */
export function parseEntry(entry: string | undefined | null): { kind: EntryKind; detail: string | null } {
  const KINDS: EntryKind[] = ['row', 'search', 'deeplink', 'push', 'epg', 'continue', 'related', 'other'];
  if (!entry) return { kind: 'other', detail: null };
  const [k, ...rest] = String(entry).split(':');
  const kind = (KINDS as string[]).includes(k) ? (k as EntryKind) : 'other';
  const detail = rest.join(':').trim() || (kind === 'other' && k ? k : null);
  return { kind, detail: detail ? detail.slice(0, 64) : null };
}

export class VoltJourney {
  private o: JourneyOptions;
  private sender: { push(line: string, urgent?: boolean): void; flush(last?: boolean): unknown } | null = null;
  private consent: boolean;
  private sn = 0;
  private asidV: string;
  private jidV: string | null = null;
  private entryV: { kind: EntryKind; detail: string | null } | null = null;
  private screens = 0;
  private bgAt: number | null = null;
  private names = new Set<string>();
  private lastPath: string | null = null;
  private offs: Array<() => void> = [];
  private opened = false;
  /** Every event made, in order (tests; the stats panel). */
  readonly log: JourneyEvent[] = [];

  constructor(o: JourneyOptions) {
    this.o = o;
    this.consent = o.consent !== false;
    this.asidV = newSid();
    this.sender = this.makeSender();
    const browser = typeof window !== 'undefined' && typeof document !== 'undefined';
    if (o.listen ?? browser) this.listen();
    this.open();
  }

  /** The collector transport (cmcd.ts CmcdSender: batches, back-off, 410 stops, keepalive on the way out). */
  private makeSender() {
    if (this.o.sink) return this.o.sink;
    const api = (this.o.apiBase ?? (typeof location !== 'undefined' ? location.origin : '')).replace(/\/+$/, '');
    const url = `${this.o.url ?? `${api}/api/journey`}?appKey=${encodeURIComponent(this.o.appKey)}`;
    return new CmcdSender({ url, contentType: 'application/x-ndjson', fetchImpl: this.o.fetchImpl, batchSize: 20 });
  }

  private now(): number { return this.o.now ? this.o.now() : Date.now(); }
  get appSessionId(): string { return this.asidV; }
  get journeyId(): string | null { return this.jidV; }
  get depth(): number { return this.screens; }
  get hasConsent(): boolean { return this.consent; }

  /** The viewer's consent changed. false stops sending and drops what is waiting. */
  setConsent(on: boolean): void {
    if (on === this.consent) return;
    this.consent = on;
    if (!on) {
      // Drop what is waiting; a fresh transport for when consent comes back.
      if (this.sender instanceof CmcdSender) { this.sender.stop(); this.sender.destroy(); }
      this.sender = this.makeSender();
      return;
    }
    // Consent given now: the app session starts here as far as Volt knows.
    this.opened = false; this.screens = 0; this.names.clear();
    this.open();
    if (this.o.autoScreens !== false && typeof location !== 'undefined') { this.lastPath = null; this.fromLocation(); }
  }

  private send(e: JourneyEventName, data: Record<string, unknown> = {}, urgent = false): void {
    if (!this.consent) return;
    try {
      const ev: JourneyEvent = { v: 1, e, ts: this.now(), asid: this.asidV, sn: ++this.sn, ...(this.jidV ? { jid: this.jidV } : {}) };
      if (this.sn === 1 || e === 'app_open') { if (this.o.app) ev.app = this.o.app.slice(0, 64); if (this.o.appVersion) ev.appv = this.o.appVersion.slice(0, 32); }
      for (const [k, v] of Object.entries(data)) if (v != null) ev[k] = v;
      this.log.push(ev);
      this.sender?.push(JSON.stringify(ev), urgent);
      const fw = this.o.forward ? (Array.isArray(this.o.forward) ? this.o.forward : [this.o.forward]) : [];
      for (const f of fw) { try { f(ev); } catch { /* the app's tool never breaks ours */ } }
    } catch { /* reporting never breaks the app */ }
  }

  private open() {
    if (this.opened || !this.consent) return;
    this.opened = true;
    let launch = this.o.launch;
    try {
      if (!launch && typeof location !== 'undefined') {
        const q = new URLSearchParams(location.search);
        if (q.get('utm_medium') === 'push' || q.has('push')) launch = 'push';
        else if (typeof document !== 'undefined' && document.referrer && !document.referrer.startsWith(location.origin) && location.pathname !== '/') launch = 'deeplink';
      }
    } catch { /* */ }
    launch = launch ?? 'icon';
    // A deep link or push starts a journey of its own.
    if (launch !== 'icon') { this.jidV = newSid(); this.entryV = { kind: launch === 'push' ? 'push' : 'deeplink', detail: null }; }
    this.send('app_open', { launch, cold: this.sn === 0 });
  }

  /** A new app session (after 30 min in the background). */
  private restart() {
    this.asidV = newSid(); this.sn = 0; this.jidV = null; this.entryV = null; this.screens = 0; this.names.clear(); this.opened = false;
    this.open();
  }

  /** A screen the viewer is on. Routers that change the URL get this for free. */
  screen(name: string, opts: { type?: ScreenType; contentId?: string | null } = {}): void {
    if (!this.consent) return;
    this.screens++;
    this.send('screen', { name: String(name).slice(0, 64), type: opts.type ?? guessType(name), cid: opts.contentId ?? undefined });
  }

  /** The viewer picked a title: a journey starts. `entry`: 'row:Trending', 'search', 'continue', 'epg', 'related', 'deeplink', 'push'. */
  select(contentId: string, opts: { entry?: string; position?: number } = {}): string {
    this.jidV = newSid();
    this.entryV = parseEntry(opts.entry);
    this.send('content_select', { cid: String(contentId).slice(0, 128), entry: this.entryV.kind, ed: this.entryV.detail ?? undefined, pos: opts.position });
    return this.jidV;
  }

  search(resultsCount: number, query?: string): void {
    if (this.o.searchQuery === 'hash' && query) void sha256(query).then((qh) => this.send('search', { n: resultsCount, qh: qh ?? undefined }));
    else this.send('search', { n: resultsCount });
  }

  paywall(product?: string): void { this.send('paywall_show', { product }); }
  purchase(outcome: 'success' | 'failed' | 'cancelled', product?: string): void { this.send('purchase', { outcome, product }, true); }

  /** The play attempt's sid: the link between the journey and the view (the player calls this). */
  playIntent(sid: string, contentId?: string | null): void { this.send('play_intent', { sid, cid: contentId ?? undefined }, true); }

  /** A custom event: a name like 'trailer_play' and up to ten short props. At most 20 names per app session. */
  track(name: string, props?: Record<string, string | number | boolean>): void {
    if (!this.consent || !/^[a-z][a-z0-9_]{0,39}$/.test(name)) return;
    if (!this.names.has(name) && this.names.size >= TRACK_MAX_NAMES) return;
    this.names.add(name);
    this.send('track', { name, props });
  }

  /**
   * The keys a play attempt carries on its first CMCD report (cmcd.ts
   * identity): journey, app session, entry point and depth. Empty without
   * consent.
   */
  attemptKeys(): Record<string, string | number> {
    if (!this.consent) return {};
    const d: Record<string, string | number> = { [VOLT_KEY + 'asid']: this.asidV, [VOLT_KEY + 'depth']: this.screens };
    if (this.jidV) { d[VOLT_KEY + 'jid'] = this.jidV; d[VOLT_KEY + 'entry'] = this.entryV?.kind ?? 'other'; }
    return d;
  }

  background(): void {
    if (this.bgAt != null) return;
    this.bgAt = this.now();
    this.send('background', {}, true);
  }
  foreground(): void {
    if (this.bgAt == null) return;
    const away = this.now() - this.bgAt;
    this.bgAt = null;
    if (away >= JOURNEY_SESSION_GAP_MS) { this.restart(); return; }
    this.send('foreground');
  }
  close(): void { this.send('app_close', {}, true); void this.sender?.flush(true); }

  private fromLocation() {
    try {
      const path = location.pathname + (location.hash.startsWith('#/') ? location.hash.slice(1) : '');
      if (path === this.lastPath) return;
      this.lastPath = path;
      const r = matchRoute(path, this.o.routes);
      this.screen(r.name, { type: r.type, contentId: r.contentId });
    } catch { /* */ }
  }

  private listen() {
    try {
      if (this.o.autoScreens !== false) {
        const h: any = history;
        const wrap = (k: 'pushState' | 'replaceState') => {
          const orig = h[k];
          h[k] = function (this: History, ...a: any[]) { const r = orig.apply(this, a); dispatchEvent(new Event('volt:locationchange')); return r; };
          this.offs.push(() => { h[k] = orig; });
        };
        wrap('pushState'); wrap('replaceState');
        const on = () => this.fromLocation();
        for (const ev of ['popstate', 'hashchange', 'volt:locationchange']) { addEventListener(ev, on); this.offs.push(() => removeEventListener(ev, on)); }
        queueMicrotask(on);
      }
      const vis = () => (document.visibilityState === 'hidden' ? this.background() : this.foreground());
      document.addEventListener('visibilitychange', vis); this.offs.push(() => document.removeEventListener('visibilitychange', vis));
      const gone = () => this.close();
      addEventListener('pagehide', gone); this.offs.push(() => removeEventListener('pagehide', gone));
    } catch { /* not a browser */ }
  }

  destroy(): void { for (const f of this.offs.splice(0)) f(); (this.sender as any)?.destroy?.(); }
}

/**
 * GA4 PASS-THROUGH: the same events as gtag events (snake case names GA4
 * accepts, its own screen_view for screens). Pass the page's gtag, or leave
 * it out to use window.gtag when it is there.
 */
export function ga4Forward(gtag?: (...a: unknown[]) => void): JourneyForward {
  return (ev) => {
    const g = gtag ?? (globalThis as any).gtag;
    if (typeof g !== 'function') return;
    const p: Record<string, unknown> = { volt_app_session: ev.asid };
    if (ev.jid) p.volt_journey = ev.jid;
    switch (ev.e) {
      case 'screen': g('event', 'screen_view', { ...p, screen_name: ev.name, screen_class: ev.type, content_id: ev.cid }); break;
      case 'content_select': g('event', 'select_content', { ...p, content_type: 'video', content_id: ev.cid, item_list_name: ev.ed ?? ev.entry, volt_entry: ev.entry, index: ev.pos }); break;
      case 'search': g('event', 'search', { ...p, results: ev.n }); break;
      case 'paywall_show': g('event', 'volt_paywall', { ...p, item_id: ev.product }); break;
      case 'purchase': g('event', ev.outcome === 'success' ? 'volt_purchase' : 'volt_purchase_failed', { ...p, item_id: ev.product, outcome: ev.outcome }); break;
      case 'play_intent': g('event', 'volt_play', { ...p, content_id: ev.cid, volt_sid: ev.sid }); break;
      case 'track': g('event', String(ev.name), { ...p, ...(ev.props as object ?? {}) }); break;
      default: g('event', 'volt_' + ev.e, p);
    }
  };
}
