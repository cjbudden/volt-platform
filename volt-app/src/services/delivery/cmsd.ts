// ============================================================================
//  SERVER-GUIDED QUALITY: CMSD ON PLAYLISTS (build queue 2.10, QOE_REPORTING.md
//  section 2, "CMSD").
//
//  CMSD (CTA-5006) is the server telling the player about a response.
//  `CMSD-Static` describes the object itself; `CMSD-Dynamic` is what this
//  server says about delivering it right now. The key that matters here is
//  `mb`, the maximum suggested bitrate in kb/s: Shaka (the Volt SDK's engine)
//  and dash.js apply it as a ceiling on their own ABR choice, so a player
//  steps down BEFORE the link it shares with everyone else saturates, rather
//  than after its buffer has run dry.
//
//  WHY ONLY PLAYLISTS. One header on a media playlist covers every segment it
//  lists, and the player reloads it every segment or two, so guidance
//  reaches it within a couple of seconds. Adding CMSD to segment responses
//  behind CloudFront would need Lambda@Edge on every segment (about $0.002
//  per viewer hour, 2 to 10 % of delivery): not worth it for the same
//  signal a few seconds earlier.
//
//  WHY THE HEADER IS ALWAYS SENT. A player keeps the last CMSD-Dynamic it
//  saw (Shaka's CmsdManager does) until another one replaces it. So the
//  guidance is lifted by sending a CMSD-Dynamic with no `mb`, not by
//  leaving the header out: an absent header would hold every player at the
//  old ceiling forever.
//
//  WHEN IS THE ORIGIN UNDER DURESS. On the Mac the server's own uplink is
//  the shared resource: every viewer's bytes leave through it. The meter
//  below counts what the origin actually sends per stream (and per viewer,
//  by the CMCD session id, or the address when a player sends none) over a
//  short window. Above `hi` of the configured allowance the origin is under
//  duress; it stays so until the load has been under `lo` for `holdSec`, so
//  the guidance does not flap with every burst. Under duress every viewer
//  gets a fair share of `target` of the allowance (max-min: a viewer whose
//  stream tops out below the share keeps its top rung, the rest is shared
//  by the others), floored to a rung of their stream's ladder (a ceiling
//  between rungs is the rung below it, and never below the lowest rung: a
//  ceiling no rung fits would leave the player with nothing to play).
//
//  Off unless DELIVERY_ALLOWANCE_MBPS is set: the origin then still sends
//  CMSD-Static and an empty CMSD-Dynamic, which is harmless to every player.
// ============================================================================
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { liveDirFor } from '../liveOrigin';

/** The server id this origin puts first in its CMSD-Dynamic entry. */
export const CMSD_SERVER_ID = 'volt-origin';

const envNum = (n: string, d: number) => { const v = Number(process.env[n]); return Number.isFinite(v) && process.env[n] !== '' && process.env[n] != null ? v : d; };

export interface GuidanceConfig {
  /** Outbound capacity the origin may use for viewers, in bits per second; 0 is off. */
  allowanceBps: number;
  /** Duress starts above this share of the allowance... */
  hi: number;
  /** ...and ends once the load has stayed under this share for holdSec. */
  lo: number;
  holdSec: number;
  /** Under duress, ceilings are set so the total lands on this share. */
  target: number;
  /** The meter's window. */
  windowSec: number;
}

export function guidanceConfig(): GuidanceConfig {
  return {
    allowanceBps: Math.max(0, envNum('DELIVERY_ALLOWANCE_MBPS', 0)) * 1e6,
    hi: envNum('DELIVERY_DURESS_HI', 0.9),
    lo: envNum('DELIVERY_DURESS_LO', 0.7),
    holdSec: envNum('DELIVERY_DURESS_HOLD_SEC', 20),
    target: envNum('DELIVERY_DURESS_TARGET', 0.8),
    windowSec: envNum('DELIVERY_METER_WINDOW_SEC', 6),
  };
}

/** CMSD is on unless switched off (DELIVERY_CMSD=off), for a lab comparison or a misbehaving player. */
export function cmsdOn(): boolean { return !/^(0|off|false|no)$/i.test(process.env.DELIVERY_CMSD ?? ''); }

// ---- the header values --------------------------------------------------------------------------

/** CMSD-Static for a playlist: object type manifest, streaming format, live or on demand. */
export function cmsdStatic(o: { format: 'hls' | 'dash'; live: boolean }): string {
  return `ot=m,sf=${o.format === 'dash' ? 'd' : 'h'},st=${o.live ? 'l' : 'v'}`;
}

/**
 * CMSD-Dynamic: this server's entry. `mb` in kb/s, `du` (duress) as a bare
 * key. With neither it is just the server id, which lifts earlier guidance.
 */
export function cmsdDynamic(g: { mb?: number | null; du?: boolean }, server = CMSD_SERVER_ID): string {
  let s = `"${server}"`;
  if (g.mb != null && Number.isFinite(g.mb) && g.mb > 0) s += `;mb=${Math.floor(g.mb)}`;
  if (g.du) s += ';du';
  return s;
}

/** Reads one CMSD-Dynamic entry back (the last server on the path, as players act on). */
export function parseCmsdDynamic(h: string | null | undefined): { server: string | null; mb: number | null; du: boolean } {
  if (!h) return { server: null, mb: null, du: false };
  const last = h.split(',').pop()!.trim();
  const parts = last.split(';');
  const out = { server: parts[0].replace(/"/g, '') || null, mb: null as number | null, du: false };
  for (const p of parts.slice(1)) {
    const [k, v] = p.split('=');
    if (k === 'mb' && v && /^\d+$/.test(v)) out.mb = Number(v);
    if (k === 'du' && v !== '?0') out.du = true;
  }
  return out;
}

/** The largest rung at or under the ceiling, never below the lowest rung. Rungs and result in kb/s. */
export function rungFloor(kbps: number, rungs: number[]): number {
  const r = [...new Set(rungs.filter((x) => x > 0))].sort((a, b) => a - b);
  if (!r.length) return Math.max(100, Math.floor(kbps / 100) * 100);
  let pick = r[0];
  for (const x of r) if (x <= kbps) pick = x;
  return pick;
}

// ---- the meter ----------------------------------------------------------------------------------

interface Sample { at: number; bytes: number; viewer: string }

/** What the origin sent, per stream, over a sliding window. */
export class DeliveryMeter {
  private s = new Map<string, Sample[]>();
  constructor(private windowMs: number) {}
  add(stream: string, bytes: number, viewer: string, now = Date.now()): void {
    if (!(bytes > 0)) return;
    let a = this.s.get(stream);
    if (!a) { a = []; this.s.set(stream, a); }
    a.push({ at: now, bytes, viewer });
    if (a.length > 4096) this.trim(stream, now);
  }
  private trim(stream: string, now: number): Sample[] {
    const a = (this.s.get(stream) ?? []).filter((x) => now - x.at < this.windowMs);
    if (a.length) this.s.set(stream, a); else this.s.delete(stream);
    return a;
  }
  /** Bits per second and distinct viewers of one stream over the window. */
  rate(stream: string, now = Date.now()): { bps: number; viewers: number } {
    const a = this.trim(stream, now);
    const bytes = a.reduce((n, x) => n + x.bytes, 0);
    return { bps: (bytes * 8) / (this.windowMs / 1000), viewers: new Set(a.map((x) => x.viewer)).size };
  }
  streams(now = Date.now()): string[] { for (const k of [...this.s.keys()]) this.trim(k, now); return [...this.s.keys()]; }
  total(now = Date.now()): number { return this.streams(now).reduce((n, k) => n + this.rate(k, now).bps, 0); }
  reset(): void { this.s.clear(); }
}

// ---- the guidance -------------------------------------------------------------------------------

export interface StreamGuidance { mb: number | null; du: boolean }

/** Duress with hysteresis, and each stream's ceiling while it lasts. */
export class Guidance {
  duress = false;
  private calmSince: number | null = null;
  constructor(public cfg: GuidanceConfig, public meter: DeliveryMeter, private rungsOf: (stream: string) => number[]) {}

  /** Re-reads the load; call before answering. */
  evaluate(now = Date.now()): void {
    const a = this.cfg.allowanceBps;
    if (!(a > 0)) { this.duress = false; this.calmSince = null; return; }
    const load = this.meter.total(now);
    if (load > this.cfg.hi * a) { this.duress = true; this.calmSince = null; return; }
    if (!this.duress) return;
    // LIFTED ON DEMAND, NOT ON LOAD. While guided, the load is low because
    // of the guidance: lifting on it would send every viewer back to the top
    // rung and refill the link (the lab saw exactly that, a cycle every hold
    // period). So the guidance lifts once what the viewers would take
    // unguided (their streams' top rungs) fits under `lo`, which is when
    // viewers have left or the allowance has grown.
    if (Math.max(load, this.demandTotal(now)) < this.cfg.lo * a) {
      if (this.calmSince == null) this.calmSince = now;
      if (now - this.calmSince >= this.cfg.holdSec * 1000) { this.duress = false; this.calmSince = null; }
    } else this.calmSince = null;
  }

  forStream(stream: string, now = Date.now()): StreamGuidance {
    this.evaluate(now);
    if (!this.duress) return { mb: null, du: false };
    const rungs = this.rungsOf(stream);
    const level = this.shareKbps(now);
    const own = this.meter.rate(stream, now);
    // a stream nobody is watching yet: its lowest rung, until it has viewers of its own
    if (!own.viewers || level == null) return { mb: rungs.length ? Math.min(...rungs) : null, du: true };
    return { mb: rungFloor(Math.min(this.demandKbps(stream, own), level), rungs), du: true };
  }

  /** What every viewer metered now would take unguided, in bits per second. */
  demandTotal(now = Date.now()): number {
    let t = 0;
    for (const s of this.meter.streams(now)) { const r = this.meter.rate(s, now); t += this.demandKbps(s, r) * r.viewers * 1000; }
    return t;
  }

  /** What a viewer of a stream would take unguided: its top rung, or its measured rate when the ladder is unknown. */
  private demandKbps(stream: string, r: { bps: number; viewers: number }): number {
    const rungs = this.rungsOf(stream);
    return rungs.length ? Math.max(...rungs) : r.bps / Math.max(1, r.viewers) / 1000;
  }

  /**
   * THE FAIR SHARE (max-min). The per-viewer level L at which every viewer
   * takes min(their demand, L) and the total lands on `target` of the
   * allowance. Demand is the top rung, not what the viewer is pulling now:
   * a ceiling computed from guided rates would ratchet every stream down to
   * its lowest rung, one playlist at a time.
   */
  shareKbps(now = Date.now()): number | null {
    const viewers: number[] = [];
    for (const s of this.meter.streams(now)) {
      const r = this.meter.rate(s, now);
      const d = this.demandKbps(s, r);
      for (let i = 0; i < r.viewers; i++) viewers.push(d);
    }
    if (!viewers.length) return null;
    viewers.sort((a, b) => a - b);
    let budget = (this.cfg.target * this.cfg.allowanceBps) / 1000;
    for (let i = 0; i < viewers.length; i++) {
      const left = viewers.length - i;
      if (viewers[i] * left <= budget) budget -= viewers[i];
      else return budget / left;
    }
    return viewers[viewers.length - 1]; // every demand fits: the guidance is only "du"
  }
}

// ---- the stream's ladder, from its delivered master ---------------------------------------------

/** BANDWIDTH of every variant in an HLS master, in kb/s. */
export function hlsRungs(master: string): number[] {
  const out: number[] = [];
  for (const l of master.split(/\r?\n/)) {
    const m = /^#EXT-X-STREAM-INF:(?:.*,)?BANDWIDTH=(\d+)/.exec(l);
    if (m) out.push(Math.round(Number(m[1]) / 1000));
  }
  return out;
}

const rungCache = new Map<string, { at: number; mtime: number; rungs: number[] }>();
/** The ladder of a stream on this origin (cached; re-read when the master changes). */
export function originRungs(dir: string): number[] {
  for (const f of ['master_cc.m3u8', 'master.m3u8']) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    try {
      const mtime = statSync(p).mtimeMs;
      const c = rungCache.get(p);
      if (c && c.mtime === mtime && Date.now() - c.at < 30_000) return c.rungs;
      const rungs = hlsRungs(readFileSync(p, 'utf8'));
      rungCache.set(p, { at: Date.now(), mtime, rungs });
      return rungs;
    } catch { /* unreadable: no ladder */ }
  }
  return [];
}

// ---- the origin's one instance ------------------------------------------------------------------

let shared: Guidance | null = null;
/** The origin's guidance (one per process: the meter is this server's own uplink). */
export function originGuidance(): Guidance {
  if (!shared) {
    const cfg = guidanceConfig();
    shared = new Guidance(cfg, new DeliveryMeter(cfg.windowSec * 1000), (stream) => {
      try { return originRungs(liveDirFor(stream)); } catch { return []; }
    });
  }
  return shared;
}
/** Tests: start again with the current environment. */
export function resetOriginGuidance(): void { shared = null; }

/** Who is asking, for the viewer count: the CMCD session id, or the address. */
export function viewerKey(req: { query?: any; ip?: string; get?: (h: string) => string | undefined }): string {
  const q = req.query?.CMCD;
  const c = Array.isArray(q) ? q[0] : q;
  const sid = typeof c === 'string' ? /(?:^|,)sid="([^"]{1,64})"/.exec(c)?.[1] : undefined;
  if (sid) return 's:' + sid;
  const h = req.get?.('cmcd-session');
  const hs = h ? /(?:^|,)sid="([^"]{1,64})"/.exec(h)?.[1] : undefined;
  return hs ? 's:' + hs : 'a:' + (req.ip ?? '');
}

/** The headers a playlist response carries, for one stream. */
export function playlistHeaders(stream: string, file: string, g: Guidance = originGuidance()): Record<string, string> {
  if (!cmsdOn()) return {};
  const format = file.endsWith('.mpd') ? 'dash' : 'hls';
  return {
    'CMSD-Static': cmsdStatic({ format, live: true }),
    'CMSD-Dynamic': cmsdDynamic(g.forStream(stream)),
  };
}

/** Headers the page must be allowed to read across origins (the Volt SDK reports them). */
export const EXPOSE = 'cmsd-static, cmsd-dynamic';

/**
 * The /origin hook (server.ts): CMSD on playlists, and every response's
 * bytes counted against its stream when it finishes. `req.url` is already
 * rewritten to `/<id>/runs/<run>/<file>` or `/<id>/<file>`.
 */
export function applyOriginDelivery(req: any, res: any): void {
  const m = /^\/([A-Za-z0-9-]{8,64})\//.exec(String(req.path ?? req.url ?? ''));
  if (!m) return;
  const stream = m[1];
  const path = String(req.path ?? '');
  res.setHeader('Access-Control-Expose-Headers', EXPOSE);
  if (/\.(m3u8|mpd)$/.test(path)) for (const [k, v] of Object.entries(playlistHeaders(stream, path))) res.setHeader(k, v);
  const viewer = viewerKey(req);
  res.on('finish', () => {
    const n = Number(res.getHeader('content-length'));
    if (res.statusCode < 400 && n > 0) originGuidance().meter.add(stream, n, viewer);
  });
}
