// ============================================================================
//  CMCD v2: WHAT THE PLAYER SAW, IN THE STANDARD'S OWN WORDS (QOE_REPORTING.md).
//
//  Two ways out, both CTA-5004 (CMCD v2):
//
//  REQUEST MODE. Every playlist and segment request carries a `CMCD=` query
//  argument (session, content, object type, buffer, throughput, startup,
//  starvation). Query, not headers: headers would make every segment from a
//  CDN on another origin a CORS preflight. The CDN's cache policies ignore
//  query strings (deploy/terraform s3_cloudfront.tf), so viewers with
//  different values still share one cached object; the CDN logs keep them.
//
//  EVENT MODE. The experience itself, as batched POSTs (`application/cmcd`,
//  one report per line) to the collector (`POST /api/cmcd`): play state
//  changes, errors, bitrate changes, the 30 s heartbeat, backgrounding,
//  playback rate, mute, and response received for a sample of requests
//  (plus every failed or slow one). Every report carries v, ts, e, sid, sn.
//
//  A PLAY ATTEMPT is opened before the play gate is asked, so a refused
//  entitlement, a manifest that never comes or a licence that fails is still a
//  view, with the step and the code. `sid` is this attempt's id: the play gate
//  is told it (and puts it in the playback token), the Analytics beacons use
//  it, and so the CDN log rows, our server logs and these reports join on it.
//
//  Encoding is the SVTA Common Media Library's (@svta/cml-cmcd), so key types,
//  inner lists and ordering follow the spec rather than our reading of it.
//  Reporting never breaks playback: every path here is wrapped.
// ============================================================================
import { appendCmcdQuery, encodeCmcd } from '@svta/cml-cmcd';

/** Our own keys. The spec allows custom keys with a hyphenated prefix. */
export const VOLT_KEY = 'com.volt-';
/** The heartbeat (e=t) interval, the spec's default. */
export const HEARTBEAT_MS = 30_000;
/** A response slower than this is always reported (e=rr), sampled or not. */
export const SLOW_RESPONSE_MS = 2_000;
/** One request in this many gets an e=rr report (QOE_REPORTING.md section 9). */
export const RR_SAMPLE_EVERY = 50;

type Dict = Record<string, unknown>;

/**
 * CTA-5004-B: a custom key's value is a String (or Token). Our spans and
 * flags are numbers and booleans, so they travel as their text ("120",
 * "true"); the collector reads them back.
 */
function customAsStrings(d: Dict): Dict {
  for (const k of Object.keys(d)) if (k.startsWith(VOLT_KEY) && typeof d[k] !== 'string') d[k] = String(d[k]);
  return d;
}

export function newSid(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // RFC 4122 v4 from Math.random, for very old browsers only.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Strip a CMCD query argument a URL already carries (a retried request, a reused URL). */
export function withoutCmcd(url: string): string {
  return url.replace(/([?&])CMCD=[^&#]*(&?)/, (_m, a, b) => (b ? a : '')).replace(/[?&]$/, '');
}

/** The request-mode URL: `url` with this request's CMCD as a query argument. */
export function cmcdRequestUrl(url: string, data: Dict): string {
  try { return appendCmcdQuery(withoutCmcd(url), data as any, { version: 2, reportingMode: 'request' } as any); }
  catch { return url; }
}

/** One event-mode report line. */
export function cmcdEventLine(data: Dict): string {
  return encodeCmcd(data as any, { version: 2, reportingMode: 'event' } as any);
}

// ----------------------------------------------------------------- transport

export interface SenderOptions {
  /** The collector, with the publishable key: `${api}/api/cmcd?appKey=...`. */
  url: string;
  /** Reports per POST (QOE_REPORTING.md section 9 models 10). */
  batchSize?: number;
  /** Longest a report waits before it is sent. */
  flushMs?: number;
  /** Most reports kept while the collector cannot be reached; older ones are dropped (the sn gap shows it). */
  maxQueue?: number;
  fetchImpl?: typeof fetch;
}

/**
 * EVENT MODE TRANSPORT, by the spec's collector rules: 2xx is delivered;
 * 429 slows down (bigger batches, a pause, Retry-After when given); 410 stops
 * reporting for this session; 5xx and network failures are retried with
 * back-off; while offline, reports wait and go when the connection returns.
 */
export class CmcdSender {
  private q: string[] = [];
  private batch: number;
  private flushMs: number;
  private maxQueue: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private notBefore = 0;
  private backoff = 0;
  stopped = false;
  /** For tests and the stats panel. */
  sent = 0;
  dropped = 0;
  private o: SenderOptions;
  private offOnline: (() => void) | null = null;

  constructor(o: SenderOptions) {
    this.o = o;
    this.batch = o.batchSize ?? 10;
    this.flushMs = o.flushMs ?? 5_000;
    this.maxQueue = o.maxQueue ?? 1_000;
    try {
      const on = () => { this.notBefore = 0; void this.flush(); };
      addEventListener('online', on);
      this.offOnline = () => removeEventListener('online', on);
    } catch { /* not a browser */ }
  }

  get pending(): number { return this.q.length; }
  get batchSize(): number { return this.batch; }

  push(line: string, urgent = false): void {
    if (this.stopped) return;
    this.q.push(line);
    if (this.q.length > this.maxQueue) { const n = this.q.length - this.maxQueue; this.q.splice(0, n); this.dropped += n; }
    if (urgent || this.q.length >= this.batch) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.flushMs);
  }

  /** Send what is queued. `last`: the page is going away (fetch keepalive, no retry after). */
  async flush(last = false): Promise<void> {
    if (this.stopped || this.inFlight || !this.q.length) return;
    if (!last && Date.now() < this.notBefore) { this.later(this.notBefore - Date.now()); return; }
    try { if (!last && typeof navigator !== 'undefined' && navigator.onLine === false) return; } catch { /* */ }
    // keepalive bodies are capped at 64 KB by browsers: send what fits.
    let take = last ? this.q.length : Math.min(this.q.length, this.batch);
    if (last) { let size = 0; take = 0; for (const l of this.q) { size += l.length + 1; if (size > 60_000) break; take++; } }
    const lines = this.q.slice(0, take);
    this.inFlight = true;
    let status = 0;
    try {
      const f = this.o.fetchImpl ?? fetch;
      const r = await f(this.o.url, { method: 'POST', headers: { 'content-type': 'application/cmcd' }, body: lines.join('\n'), keepalive: last, credentials: 'omit' } as RequestInit);
      status = r.status;
      if (status === 429) {
        const ra = Number((r.headers as any)?.get?.('retry-after'));
        this.batch = Math.min(this.batch * 2, 100);
        this.notBefore = Date.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 10_000);
      }
    } catch { status = 0; }
    this.inFlight = false;
    if (status >= 200 && status < 300) {
      this.q.splice(0, lines.length); this.sent += lines.length; this.backoff = 0;
      if (this.q.length >= this.batch) void this.flush(last);
      else if (this.q.length && !this.timer) this.later(this.flushMs);
      return;
    }
    if (status === 410) { this.stop(); return; }
    if (status === 429) { this.later(this.notBefore - Date.now()); return; }
    if (status >= 400 && status < 500) { this.q.splice(0, lines.length); this.dropped += lines.length; return; } // not ours to fix by retrying
    // 5xx or the network: keep them, try again later.
    this.backoff = Math.min(this.backoff ? this.backoff * 2 : 2_000, 60_000);
    this.notBefore = Date.now() + this.backoff;
    if (!last) this.later(this.backoff);
  }

  private later(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, Math.max(0, ms));
  }

  stop(): void {
    this.stopped = true;
    this.q = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.offOnline?.();
  }
}

// --------------------------------------------------------------- the attempt

/** The startup spans (QOE_REPORTING.md section 4), each a [start, end] in ms since the attempt began. */
export type SpanName = 'entitlement' | 'manifest' | 'drm' | 'segment';
const SPAN_KEY: Record<SpanName, string> = { entitlement: 'tent', manifest: 'tman', drm: 'tdrm', segment: 'tseg' };

export type RequestKind = 'manifest' | 'segment' | 'init' | 'licence' | 'key' | 'other';

export interface RequestInfo {
  kind: RequestKind;
  url: string;
  /** Media of a segment: video, audio or text. */
  media?: 'video' | 'audio' | 'text' | null;
  /** The encoded bitrate of what is requested, in kbps. */
  bitrateKbps?: number | null;
  /** The segment's duration in ms. */
  durationMs?: number | null;
}

export interface ResponseInfo extends RequestInfo {
  status: number;
  ttfbMs?: number | null;
  ttlbMs?: number | null;
  /** The CDN's own request id (CloudFront x-amz-cf-id), when the CDN exposes it to the page. */
  edgeId?: string | null;
  cmsds?: string | null;
  cmsdd?: string | null;
  failed?: boolean;
}

/** What the engine can tell the attempt about playback right now. */
export interface PlaybackProbe {
  /** Buffer ahead of the playhead, ms. */
  bufferMs(): number | null;
  /** The player's throughput estimate, kbps. */
  throughputKbps(): number | null;
  /** The bitrate of what is playing, kbps. */
  playingKbps(): number | null;
  /** The highest bitrate in the ladder, kbps. */
  topKbps(): number | null;
  /** The highest bitrate this screen can use, kbps. */
  topPlayableKbps?(): number | null;
  droppedFrames(): number | null;
  /** Live: ms behind the live edge. */
  latencyMs(): number | null;
  /** The DRM system in use (com.widevine.alpha, ...), when there is one. */
  keySystem?(): string | null;
}

export interface AttemptOptions {
  sid?: string;
  /** Content id: the asset id, else the item id. */
  cid: string | null;
  live: boolean | null;
  /** Event mode: where reports go. null: request mode only. */
  sender: CmcdSender | null;
  requestMode: boolean;
  /** Sent once, on the first reports: app, app version, SDK version, device model. */
  identity?: Dict;
  /** Opened by an autoplay (starting) or waiting for the viewer to press play (preloading). */
  autoplay: boolean;
  probe?: PlaybackProbe | null;
  heartbeatMs?: number;
  rrSampleEvery?: number;
  now?: () => number;
}

type Sta = 's' | 'p' | 'k' | 'r' | 'a' | 'w' | 'e' | 'f' | 'q' | 'd';

/**
 * ONE PLAY ATTEMPT (a view): opened before entitlement, closed at the end, on
 * a fatal error, or when the viewer leaves. Produces the request-mode data for
 * each request and the event-mode reports.
 */
export class PlayAttempt {
  readonly sid: string;
  cid: string | null;
  private o: AttemptOptions;
  private sn = 0;
  private sta: Sta | null = null;
  private t0: number;
  private spans = new Map<SpanName, [number, number | null]>();
  private firstFrameAt: number | null = null;
  private stalledSinceLastRequest = false;
  private seeking = false;
  private requests = 0;
  private hb: ReturnType<typeof setInterval> | null = null;
  private lastBr: number | null = null;
  private identitySent = false;
  sf: 'h' | 'd' | 'o' | null = null;
  closed = false;
  /** Every report made, in order (the debug panel; tests). */
  readonly log: Dict[] = [];

  constructor(o: AttemptOptions) {
    this.o = o;
    this.sid = o.sid ?? newSid();
    this.cid = o.cid;
    this.t0 = this.now();
    this.state(o.autoplay ? 's' : 'd');
  }

  private now(): number { return this.o.now ? this.o.now() : (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
  private sinceStart(): number { return Math.max(0, Math.round(this.now() - this.t0)); }
  get started(): boolean { return this.firstFrameAt != null; }
  /** The CMCD play state now (sta). */
  get playState(): string | null { return this.sta; }
  set live(v: boolean | null) { this.o.live = v; }
  set probe(p: PlaybackProbe | null) { this.o.probe = p; }

  private common(): Dict {
    const d: Dict = { v: 2, sid: this.sid };
    if (this.cid) d.cid = this.cid.slice(0, 128);
    if (this.sf) d.sf = this.sf;
    if (this.o.live != null) d.st = this.o.live ? 'l' : 'v';
    return d;
  }

  private emit(e: string, data: Dict = {}, urgent = false): void {
    if (this.closed && e !== 'ps') return;
    try {
      const d: Dict = { ...this.common(), e, ts: Date.now(), sn: ++this.sn, ...data };
      if (!this.identitySent && this.o.identity) { Object.assign(d, this.o.identity); this.identitySent = true; }
      for (const k of Object.keys(d)) if (d[k] == null || (Array.isArray(d[k]) && (d[k] as unknown[]).some((x) => x == null))) delete d[k];
      customAsStrings(d);
      this.log.push(d);
      this.o.sender?.push(cmcdEventLine(d), urgent);
    } catch { /* reporting never breaks playback */ }
  }

  private state(s: Sta, extra: Dict = {}, urgent = false) {
    if (this.sta === s && !Object.keys(extra).length) return;
    // Fatal and quit end the view. After ended only playing again (a replay or
    // a seek back) moves it on; a pause or a stall after the end is not news.
    if (this.sta === 'f' || this.sta === 'q') return;
    if (this.sta === 'e' && s !== 'p' && s !== 'k') return;
    this.sta = s;
    this.emit('ps', { sta: s, ...extra }, urgent || s === 'f' || s === 'q' || s === 'e');
  }

  // --- startup ---

  /** The viewer pressed play (or autoplay began): startup is timed from here. */
  playRequested(): void {
    if (this.started || this.closed) return;
    if (this.sta === 'd') { this.t0 = this.now(); this.spans.clear(); this.state('s'); }
  }

  /** Autoplay was refused: the attempt waits for the viewer to press play (startup is timed from then). */
  waitForViewer(): void { if (!this.started && !this.closed && this.sta === 's') this.state('d'); }

  spanStart(n: SpanName): void { if (!this.spans.has(n) && !this.started) this.spans.set(n, [this.sinceStart(), null]); }
  spanEnd(n: SpanName): void { const s = this.spans.get(n); if (s && s[1] == null) s[1] = this.sinceStart(); }
  span(n: SpanName): number | null { const s = this.spans.get(n); return s && s[1] != null ? s[1] - s[0] : null; }

  /** The first frame is on screen: the play attempt became a started view. */
  firstFrame(): void {
    if (this.started || this.closed) return;
    this.firstFrameAt = this.sinceStart();
    const extra: Dict = { msd: this.firstFrameAt };
    let sum = 0;
    for (const n of Object.keys(SPAN_KEY) as SpanName[]) {
      const v = this.span(n);
      if (v != null) { extra[VOLT_KEY + SPAN_KEY[n]] = v; sum += v; }
    }
    const seg = this.spans.get('segment');
    if (seg && seg[1] != null) { const dec = this.firstFrameAt - seg[1]; extra[VOLT_KEY + 'tdec'] = Math.max(0, dec); sum += Math.max(0, dec); }
    // Gaps (player set-up, waiting on the main thread) as "other", so the spans always add up.
    extra[VOLT_KEY + 'toth'] = Math.max(0, this.firstFrameAt - sum);
    const ks = this.o.probe?.keySystem?.();
    if (ks) extra[VOLT_KEY + 'drm'] = ks;
    const br = this.o.probe?.playingKbps();
    if (br) { extra.br = [Math.round(br)]; this.lastBr = Math.round(br); }
    this.state('p', extra, true);
    this.startHeartbeat();
  }

  // --- the media element ---

  playing(): void {
    if (!this.started) { this.firstFrame(); return; }
    this.seeking = false;
    this.state('p');
  }
  waiting(): void {
    if (!this.started || this.closed) return;
    if (this.seeking) { this.state('k'); return; }
    this.stalledSinceLastRequest = true;
    this.state('r');
  }
  seekingStarted(): void { if (!this.started) return; this.seeking = true; this.state('k'); }
  paused(): void { if (this.started && this.sta !== 'e') this.state('a'); }
  ended(): void { if (this.started) { this.state('e'); this.stopHeartbeat(); } }
  rate(r: number): void { if (this.started && Number.isFinite(r)) this.emit('pr', { pr: Math.round(r * 100) / 100 }); }
  muted(m: boolean): void { if (this.started) this.emit(m ? 'm' : 'um'); }
  backgrounded(bg: boolean): void { this.emit('b', bg ? { bg: true } : {}); }

  /** The rendition playing changed (ABR or a viewer's pick). */
  bitrate(kbps: number | null): void {
    if (!kbps || !this.started) return;
    const k = Math.round(kbps);
    if (k === this.lastBr) return;
    this.lastBr = k;
    this.emit('bc', { br: [k] });
  }

  /**
   * An error. `fatal`: playback stopped (sta=f follows). `step` says where it
   * happened (entitlement, manifest, drm, segment, decode, playback), so a
   * licence failure is not counted as a stream fault.
   */
  error(code: string | number, step: string, fatal: boolean): void {
    if (this.closed) return;
    const ec = String(code).slice(0, 64);
    this.emit('e', { ec: [ec], [VOLT_KEY + 'step']: step, ...(this.started ? {} : { su: true }) }, fatal);
    if (fatal) { this.state('f', {}, true); this.stopHeartbeat(); this.closed = true; this.o.sender?.flush(); }
  }

  // --- requests ---

  /** The request-mode data for one request, or null (licences and keys get none). */
  requestData(r: RequestInfo): Dict | null {
    if (!this.o.requestMode || this.closed) return null;
    if (r.kind === 'licence' || r.kind === 'key' || r.kind === 'other') return null;
    const p = this.o.probe;
    const d: Dict = this.common();
    d.ot = r.kind === 'manifest' ? 'm' : r.kind === 'init' ? 'i' : r.media === 'audio' ? 'a' : r.media === 'text' ? 'c' : 'v';
    if (r.kind === 'segment' || r.kind === 'init') {
      if (r.bitrateKbps) d.br = [Math.round(r.bitrateKbps)];
      if (r.durationMs && r.kind === 'segment') d.d = Math.round(r.durationMs);
      const bl = p?.bufferMs();
      if (bl != null && r.kind === 'segment') d.bl = [Math.max(0, Math.round(bl / 100) * 100)];
      const tb = p?.topKbps();
      if (tb) d.tb = [Math.round(tb)];
    }
    const mtp = p?.throughputKbps();
    if (mtp) d.mtp = [Math.round(mtp / 100) * 100];
    if (!this.started) d.su = true;
    if (this.stalledSinceLastRequest) { d.bs = true; this.stalledSinceLastRequest = false; }
    return d;
  }

  /** `url` with this request's CMCD, or `url` unchanged. */
  requestUrl(r: RequestInfo): string {
    const d = this.requestData(r);
    return d ? cmcdRequestUrl(r.url, customAsStrings(d)) : r.url;
  }

  /**
   * A response arrived (or failed). Reported as e=rr for one request in
   * RR_SAMPLE_EVERY, for every failed or slow one, and for the requests of the
   * startup (first manifest, licence and segment).
   */
  response(r: ResponseInfo): void {
    if (this.closed) return;
    this.requests++;
    const every = this.o.rrSampleEvery ?? RR_SAMPLE_EVERY;
    const slow = (r.ttlbMs ?? 0) >= SLOW_RESPONSE_MS;
    const startup = !this.started;
    if (!(r.failed || r.status >= 400 || slow || startup || this.requests % every === 0)) return;
    const d: Dict = { url: withoutCmcd(r.url).slice(0, 512), rc: r.status || 0 };
    if (r.kind !== 'licence' && r.kind !== 'key' && r.kind !== 'other')
      d.ot = r.kind === 'manifest' ? 'm' : r.kind === 'init' ? 'i' : r.media === 'audio' ? 'a' : r.media === 'text' ? 'c' : 'v';
    else d[VOLT_KEY + 'req'] = r.kind;
    if (r.ttfbMs != null && r.ttfbMs >= 0) d.ttfb = Math.round(r.ttfbMs);
    if (r.ttlbMs != null && r.ttlbMs >= 0) d.ttlb = Math.round(r.ttlbMs);
    if (r.edgeId) d[VOLT_KEY + 'cfid'] = r.edgeId.slice(0, 128);
    if (r.cmsds) d.cmsds = r.cmsds.slice(0, 256);
    if (r.cmsdd) d.cmsdd = r.cmsdd.slice(0, 256);
    if (startup) d.su = true;
    this.emit('rr', d, !!r.failed || r.status >= 400);
  }

  // --- heartbeat and close ---

  private startHeartbeat() {
    if (this.hb || !this.o.sender) return;
    this.hb = setInterval(() => this.heartbeat(), this.o.heartbeatMs ?? HEARTBEAT_MS);
  }
  private stopHeartbeat() { if (this.hb) clearInterval(this.hb); this.hb = null; }

  heartbeat(): void {
    if (this.closed || !this.started) return;
    const p = this.o.probe;
    const d: Dict = {};
    const bl = p?.bufferMs(); if (bl != null) d.bl = [Math.max(0, Math.round(bl / 100) * 100)];
    const mtp = p?.throughputKbps(); if (mtp) d.mtp = [Math.round(mtp / 100) * 100];
    const pb = p?.playingKbps(); if (pb) d.pb = [Math.round(pb)];
    const tpb = p?.topPlayableKbps?.(); if (tpb) d.tpb = [Math.round(tpb)];
    const df = p?.droppedFrames(); if (df != null) d.dfa = Math.round(df);
    const ltc = p?.latencyMs(); if (ltc != null && this.o.live) d.ltc = Math.round(ltc);
    this.emit('t', d);
  }

  /** The viewer left (next item, player destroyed, page closed). `last`: the page is going away. */
  close(last = false): void {
    if (this.closed) { if (last) void this.o.sender?.flush(true); return; }
    this.stopHeartbeat();
    if (this.sta !== 'e') this.state('q', {}, true);
    this.closed = true;
    void this.o.sender?.flush(last);
  }
}

/** The custom identity keys sent on an attempt's first report. */
export function identityKeys(i: { app?: string | null; appVersion?: string | null; sdkVersion?: string | null; deviceModel?: string | null; hardwareDecode?: boolean | null }): Dict {
  const d: Dict = {};
  if (i.app) d[VOLT_KEY + 'app'] = String(i.app).slice(0, 64);
  if (i.appVersion) d[VOLT_KEY + 'appv'] = String(i.appVersion).slice(0, 32);
  if (i.sdkVersion) d[VOLT_KEY + 'sdkv'] = String(i.sdkVersion).slice(0, 32);
  if (i.deviceModel) d[VOLT_KEY + 'dm'] = String(i.deviceModel).slice(0, 64);
  if (i.hardwareDecode != null) d[VOLT_KEY + 'hwdec'] = !!i.hardwareDecode;
  return d;
}

/** The device model, where the browser says (Client Hints on Chromium, else the platform). */
export function deviceModel(): string | null {
  try {
    const n: any = typeof navigator !== 'undefined' ? navigator : null;
    if (!n) return null;
    const ua = n.userAgentData;
    const plat = ua?.platform || n.platform || null;
    if (ua?.mobile && plat) return `${plat} mobile`;
    return plat;
  } catch { return null; }
}
