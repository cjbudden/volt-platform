// ============================================================================
//  ON-DEMAND ADS IN THE PLAYER (volt-app services/vodAds, SSAI.md 5.4).
//
//  The play gate hands an on-demand item with ads its delivery and, for a
//  STITCHED session, an ad timeline (/vod-ads/s/<session>/timeline.json):
//  where each break sits in the content and in the stitched stream, and the
//  ads in it. With it this controller:
//    - knows when an ad is on screen and shows "Ad 1 of 2 · 0:12", with
//      "Learn more" when the ad has a page (the click goes through Volt, which
//      sends the ad's click trackers, then opens the advertiser's page);
//    - keeps the two clocks apart: `contentTime` is what resume, bookmarks and
//      chapters want, whatever ads came before;
//    - SNAPBACK (the rule's setting, on by default): a seek forward past an
//      unwatched mid-roll plays that break first, then goes where the viewer
//      asked; a seek inside an ad is undone; a break already watched is never
//      played again on a seek back (it is jumped over);
//    - reports what only a player can know (pause, resume, mute, unmute,
//      fullscreen) to the session, which sends the ad's trackers. Impressions
//      and quartiles need nothing from here: the server sends them as the ad's
//      segments are fetched, for any player.
//
//  GUIDED (HLS Interstitials) needs none of the clock work: the player plays
//  the interstitials itself and enforces their restrictions (no skipping, no
//  seeking in an ad, a break watched once). Safari and AVPlayer do it
//  natively; everywhere else the engine's Shaka does (engine.ts guided) and
//  hands each ad to `guidedAd()`, so the same overlay shows "Ad 1 of 2 · 0:12"
//  and Learn more, and pause and mute still reach the ad's trackers. The ad's
//  address names its session, break and place (/vod-ads/s/<session>/ad/<b>/<p>/),
//  which is all the click and the events need.
// ============================================================================

export interface ItemAds {
  delivery: 'stitched' | 'guided';
  sessionId: string | null;
  timelineUrl: string | null;
}

export interface TimelineAd { podIndex: number; kind: 'ad' | 'house'; title: string | null; startSec: number; durationSec: number; clickUrl: string | null }
export interface TimelineBreak { index: number; position: 'pre' | 'mid' | 'post'; contentSec: number; stitchedStartSec: number | null; durationSec: number; ads: TimelineAd[] }
export interface AdTimeline { sessionId: string; delivery: 'stitched' | 'guided'; contentSec: number; snapback: boolean; prerollOnResume: boolean; breaks: TimelineBreak[]; eventsUrl: string }

/** An ad the engine is playing in a guided break (engine.ts onAd). */
export interface GuidedAd { number: number; of: number; remainingSec: number; mediaUrl: string | null }

/** Session, break and place of a guided ad, from its address. */
export function guidedRef(mediaUrl: string | null): { sid: string; b: number; p: number } | null {
  const m = mediaUrl?.match(/\/vod-ads\/s\/([A-Za-z0-9_-]{20,42})\/ad\/(\d+)\/(\d+)\//);
  return m ? { sid: m[1], b: Number(m[2]), p: Number(m[3]) } : null;
}

/** What the player state carries while an ad plays. */
export interface AdState {
  breakIndex: number;
  /** 1-based position of this ad in the break, and how many the break has. */
  number: number;
  of: number;
  title: string | null;
  remainingSec: number;
  canClick: boolean;
}

// ---- the two clocks (the same arithmetic as volt-app services/vodAds/plan.ts)

interface Clock { index: number; atSec: number; durationSec: number; startSec: number }

function clocks(t: AdTimeline): Clock[] {
  return t.breaks.filter((b) => b.stitchedStartSec != null).map((b) => ({ index: b.index, atSec: b.contentSec, durationSec: b.durationSec, startSec: b.stitchedStartSec! }));
}
/** Stitched time to content time (inside a break: the content moment it sits at). */
export function toContent(stitched: number, cs: Clock[]): number {
  let shift = 0;
  for (const c of cs) {
    if (stitched < c.startSec) break;
    if (stitched < c.startSec + c.durationSec) return c.atSec;
    shift += c.durationSec;
  }
  return Math.max(0, stitched - shift);
}
/** Content time to stitched time, after any break sitting exactly there. */
export function toStitched(content: number, cs: Clock[]): number {
  let shift = 0;
  for (const c of cs) { if (c.atSec <= content) shift += c.durationSec; else break; }
  return content + shift;
}
const breakAt = (stitched: number, cs: Clock[]) => cs.find((c) => stitched >= c.startSec && stitched < c.startSec + c.durationSec) ?? null;

const PLAYER_EVENTS: Record<string, string> = { pause: 'pause', play: 'resume' };

export class VodAds {
  private t: AdTimeline | null = null;
  private cs: Clock[] = [];
  private watched = new Set<number>();
  private off: (() => void)[] = [];
  private last = 0;
  /** A seek waiting for its snapback break to finish: where to go after it (content time). */
  private pendingTo: number | null = null;
  private guard = false;
  private el: HTMLElement | null = null;
  private current: AdState | null = null;
  private sent = new Set<string>();

  private media: HTMLMediaElement;
  private apiBase: string;
  private ads: ItemAds;
  private onChange: (ad: AdState | null) => void;
  private root?: HTMLElement;

  constructor(media: HTMLMediaElement, apiBase: string, ads: ItemAds, onChange: (ad: AdState | null) => void, root?: HTMLElement) {
    this.media = media; this.apiBase = apiBase; this.ads = ads; this.onChange = onChange; this.root = root;
    if (ads.delivery === 'guided') { this.wireGuided(); return; }
    if (ads.delivery !== 'stitched' || !ads.timelineUrl) return;
    void this.load();
  }

  // ---- guided: the engine plays the ads, this shows them and reports for them

  /** The guided session's timeline, read once per session: which ads have a page to open. */
  private guidedTl = new Map<string, Promise<AdTimeline | null>>();
  private guidedRef: { sid: string; b: number; p: number } | null = null;

  private wireGuided() {
    const on = (ev: string, fn: () => void) => { this.media.addEventListener(ev, fn); this.off.push(() => this.media.removeEventListener(ev, fn)); };
    on('pause', () => this.report('pause'));
    on('play', () => this.report('play'));
    on('volumechange', () => this.report(this.media.muted || this.media.volume === 0 ? 'mute' : 'unmute'));
    if (this.root) this.mountOverlay();
  }

  /** The engine's ad (or null when the content resumes) in a guided break. */
  guidedAd(ad: GuidedAd | null) {
    const ref = ad ? guidedRef(ad.mediaUrl) : null;
    this.guidedRef = ref;
    if (!ad) { this.setCurrent(null); return; }
    const state = (canClick: boolean): AdState => ({ breakIndex: ref?.b ?? 0, number: ad.number, of: ad.of, title: null, remainingSec: ad.remainingSec, canClick });
    if (!ref) { this.setCurrent(state(false)); return; }
    let tl = this.guidedTl.get(ref.sid);
    if (!tl) {
      tl = fetch(this.abs(`/vod-ads/s/${ref.sid}/timeline.json`), { credentials: 'omit' }).then((r) => r.ok ? r.json() as Promise<AdTimeline> : null).catch(() => null);
      this.guidedTl.set(ref.sid, tl);
    }
    // Shown at once; Learn more appears when the timeline says the ad has a page.
    if (!this.current || this.current.breakIndex !== ref.b || this.current.number !== ad.number) this.setCurrent(state(false));
    else this.setCurrent({ ...this.current, remainingSec: ad.remainingSec });
    void tl.then((t) => {
      if (!t || this.guidedRef?.sid !== ref.sid || this.guidedRef.b !== ref.b || this.guidedRef.p !== ref.p || !this.current) return;
      if (!this.t) this.t = t;
      const x = t.breaks.find((b) => b.index === ref.b)?.ads[ref.p];
      this.setCurrent({ ...this.current, title: x?.title ?? null, canClick: !!x?.clickUrl });
    });
  }

  private abs(u: string) { return /^https?:/i.test(u) ? u : `${this.apiBase}${u}`; }

  private async load() {
    try {
      const r = await fetch(this.abs(this.ads.timelineUrl!), { credentials: 'omit' });
      if (!r.ok) return;
      this.t = await r.json() as AdTimeline;
      this.cs = clocks(this.t);
    } catch { return; }
    const on = (ev: string, fn: () => void) => { this.media.addEventListener(ev, fn); this.off.push(() => this.media.removeEventListener(ev, fn)); };
    on('timeupdate', () => this.onTime());
    on('seeking', () => this.onSeek());
    on('pause', () => this.report('pause'));
    on('play', () => this.report('play'));
    on('volumechange', () => this.report(this.media.muted || this.media.volume === 0 ? 'mute' : 'unmute'));
    if (this.root) this.mountOverlay();
    this.onTime();
  }

  /** Where the viewer is in the content, whatever ads came before. */
  get contentTime(): number { return this.cs.length ? toContent(this.media.currentTime, this.cs) : this.media.currentTime; }
  /** Breaks for a scrubber: stitched start and length, and whether watched. */
  get markers() { return this.cs.map((c) => ({ startSec: c.startSec, durationSec: c.durationSec, watched: this.watched.has(c.index) })); }
  /** Seek in content time (a bookmark, resume): lands after the breaks before it. */
  seekContent(sec: number) { this.media.currentTime = toStitched(sec, this.cs); }

  private onTime() {
    const now = this.media.currentTime;
    if (!this.guard) this.last = now;
    const c = breakAt(now, this.cs);
    // a break is watched once playback has passed its end
    for (const x of this.cs) if (now >= x.startSec + x.durationSec - 0.25 && this.last >= x.startSec) this.watched.add(x.index);
    if (this.pendingTo != null && (!c || this.watched.has(c.index))) {
      const to = this.pendingTo; this.pendingTo = null;
      this.jump(toStitched(to, this.cs));
    }
    this.setCurrent(c ? this.adState(c, now) : null);
  }

  private adState(c: Clock, now: number): AdState | null {
    const b = this.t!.breaks.find((x) => x.index === c.index)!;
    const into = now - c.startSec;
    const i = b.ads.findIndex((a) => into >= a.startSec && into < a.startSec + a.durationSec);
    const ad = b.ads[Math.max(0, i)];
    return { breakIndex: c.index, number: Math.max(0, i) + 1, of: b.ads.length, title: ad?.title ?? null,
      remainingSec: Math.max(0, Math.ceil(c.durationSec - into)), canClick: !!ad?.clickUrl };
  }

  private jump(to: number) {
    this.guard = true;
    this.media.currentTime = to;
    setTimeout(() => { this.guard = false; this.last = this.media.currentTime; }, 250);
  }

  private onSeek() {
    if (this.guard || !this.t) return;
    const from = this.last, to = this.media.currentTime;
    const inBreak = breakAt(from, this.cs);
    // No seeking inside an ad, or out of an unwatched one.
    if (inBreak && !this.watched.has(inBreak.index)) { this.jump(from); return; }
    const target = breakAt(to, this.cs);
    // Landing inside a watched break: skip to its end.
    if (target && this.watched.has(target.index)) { this.jump(target.startSec + target.durationSec); return; }
    if (!this.t.snapback || to <= from) return;
    const fromC = toContent(from, this.cs), toC = toContent(to, this.cs);
    const skipped = this.cs.filter((c) => c.atSec > fromC && c.atSec <= toC && !this.watched.has(c.index)
      && this.t!.breaks.find((b) => b.index === c.index)?.position === 'mid');
    if (!skipped.length) return;
    const snap = skipped[skipped.length - 1];
    this.pendingTo = toC;
    this.jump(snap.startSec);
  }

  private setCurrent(a: AdState | null) {
    const same = JSON.stringify(a) === JSON.stringify(this.current);
    this.current = a;
    if (same) return;
    this.onChange(a);
    this.renderOverlay();
  }

  /** The viewer clicked the ad: Volt sends its click trackers and opens the advertiser's page. */
  click() {
    const a = this.current;
    if (!a || !this.t) return;
    const b = this.t.breaks.find((x) => x.index === a.breakIndex);
    const ad = b?.ads[this.guidedRef ? this.guidedRef.p : a.number - 1];
    if (!ad?.clickUrl) return;
    this.media.pause();
    window.open(this.abs(ad.clickUrl), '_blank', 'noopener');
  }

  private report(ev: string) {
    const a = this.current;
    if (!a || (!this.t && !this.guidedRef)) return;
    const event = PLAYER_EVENTS[ev] ?? ev;
    const g = this.guidedRef;
    const p = g ? g.p : a.number - 1;
    const key = `${g?.sid ?? ''}/${a.breakIndex}/${p}/${event}`;
    if (this.sent.has(key)) return;
    this.sent.add(key);
    const url = g ? `/vod-ads/s/${g.sid}/events` : this.t!.eventsUrl;
    void fetch(this.abs(url), { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ b: a.breakIndex, p, event }] }), keepalive: true }).catch(() => null);
  }

  // ---- a small overlay of its own, so any skin shows the ad

  private mountOverlay() {
    const el = document.createElement('div');
    el.className = 'vp-ad';
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:absolute;top:12px;left:12px;z-index:5;display:flex;gap:8px;align-items:center;font:600 13px/1.2 var(--vp-font,system-ui);color:#fff;pointer-events:auto';
    el.hidden = true;
    this.root!.appendChild(el);
    this.el = el;
    this.off.push(() => el.remove());
  }

  private renderOverlay() {
    const el = this.el;
    if (!el) return;
    const a = this.current;
    el.hidden = !a;
    el.replaceChildren();
    if (!a) return;
    const pill = document.createElement('span');
    pill.style.cssText = 'background:rgba(0,0,0,.65);border-radius:999px;padding:5px 10px';
    pill.textContent = `Ad${a.of > 1 ? ` ${a.number} of ${a.of}` : ''} · ${Math.floor(a.remainingSec / 60)}:${String(a.remainingSec % 60).padStart(2, '0')}`;
    el.appendChild(pill);
    if (a.canClick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Learn more';
      btn.style.cssText = 'background:#fff;color:#111;border:0;border-radius:999px;padding:5px 12px;font:inherit;cursor:pointer';
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.click(); });
      el.appendChild(btn);
    }
  }

  dispose() { for (const f of this.off) f(); this.off = []; this.el = null; }
}
