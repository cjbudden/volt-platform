// ============================================================================
//  HTML GRAPHICS IN THE PLAYER (REQ_graphics_overlays.md section 13).
//
//  Scorebugs, lower thirds, tickers and bugs set up in the console with
//  "Shown in: player" (or both) are drawn here, over the picture.
//
//  THE FEED (GET /api/player/graphics) gives the graphics and their state over
//  time as snapshots. The one applied is the snapshot in force at the
//  PLAYHEAD'S wall clock (PROGRAM-DATE-TIME), never at the viewer's own clock:
//  a viewer 40 s behind live sees the score change when the try is scored on
//  their screen, and one scrubbing the DVR sees what was on screen then.
//
//  THE LAYER. Each graphic is its own iframe, sandboxed without
//  allow-same-origin and served with a CSP sandbox whose connect-src is the
//  template's own package (the control plane's /gfx/ route), so a template
//  cannot touch the host page, its cookies or the network. It is driven by postMessage through the
//  bridge the server injects, calling the template's CasparCG functions:
//  update(json), play(), stop(). The same contract as the console preview and
//  the burn-in renderer. Laid out at the template canvas (1920x1080) and
//  scaled to the PICTURE's box inside the stage (letterboxing respected), so
//  positions are the broadcast's.
//
//  The pure parts (snapshot choice, merging, what newly came on) are exported
//  for tests; the DOM part is GraphicsOverlay.
// ============================================================================

export interface OverlayDef {
  id: string; name: string; kind: string; url: string; canvas: [number, number]
  placement: { anchor?: string; x?: number; y?: number; scale?: number; layer?: number }
}
export type OverlayState = Record<string, { on: boolean; v: Record<string, unknown> }>
export interface OverlaySnapshot { at: number; state: OverlayState }
export interface OverlayFeed { streamId: string; serverTime: number; graphics: OverlayDef[]; snapshots: OverlaySnapshot[] }

/** The snapshot in force at wall-clock ms t: the last at or before it. */
export function snapshotAt(snaps: OverlaySnapshot[], t: number): OverlaySnapshot | null {
  let best: OverlaySnapshot | null = null;
  for (const s of snaps) if (s.at <= t && (!best || s.at > best.at)) best = s;
  return best;
}

/** Merge newly fetched snapshots, keep them in order, and forget what is long behind `keepFrom`. */
export function mergeSnapshots(have: OverlaySnapshot[], got: OverlaySnapshot[], keepFrom: number): OverlaySnapshot[] {
  const by = new Map<number, OverlaySnapshot>();
  for (const s of have) by.set(s.at, s);
  for (const s of got) if (s && Number.isFinite(s.at) && s.state && typeof s.state === 'object') by.set(s.at, s);
  const all = [...by.values()].sort((a, b) => a.at - b.at);
  // Keep the one in force at keepFrom (the baseline) and everything after it.
  const base = snapshotAt(all, keepFrom);
  return all.filter((s) => s.at >= keepFrom || s === base);
}

/** Ids on screen in `next` that were not in `prev`: the graphics that just came on. */
export function cameOn(prev: Set<string>, next: Set<string>): string[] {
  return [...next].filter((id) => !prev.has(id));
}

/** A feed URL. `since` is the playhead's wall clock minus a margin, in ms. */
export function feedUrl(apiBase: string, appKey: string, streamId: string, since: number): string {
  return `${apiBase}/api/player/graphics?appKey=${encodeURIComponent(appKey)}&streamId=${encodeURIComponent(streamId)}&since=${Math.floor(since)}`;
}

const ORIGIN: Record<string, string> = {
  top_left: '0 0', top: '50% 0', top_right: '100% 0', left: '0 50%', center: '50% 50%', right: '100% 50%',
  bottom_left: '0 100%', bottom: '50% 100%', bottom_right: '100% 100%',
};

interface Layer { def: OverlayDef; box: HTMLDivElement; frame: HTMLIFrameElement; ready: boolean; sentValues: string; sentOn: boolean | null; on: boolean; values: Record<string, unknown> }

export class GraphicsOverlay {
  private root: HTMLDivElement;
  private layers = new Map<string, Layer>();
  private visible = true;
  private onMsg = (e: MessageEvent) => {
    for (const l of this.layers.values()) {
      if (e.source !== l.frame.contentWindow || !e.data || typeof e.data !== 'object') continue;
      if (e.data.type === 'volt-gfx-ready') { l.ready = true; l.sentValues = ''; l.sentOn = null; this.sync(l); }
    }
  };
  private ro: ResizeObserver | null = null;

  private stage: HTMLElement;
  private media: HTMLVideoElement | HTMLMediaElement;
  private apiBase: string;

  constructor(stage: HTMLElement, media: HTMLVideoElement | HTMLMediaElement, apiBase: string) {
    this.stage = stage; this.media = media; this.apiBase = apiBase;
    this.root = document.createElement('div');
    this.root.className = 'vp-gfx';
    this.root.setAttribute('aria-hidden', 'true');
    stage.appendChild(this.root);
    window.addEventListener('message', this.onMsg);
    if (typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(() => this.layout()); this.ro.observe(stage); }
    media.addEventListener('loadedmetadata', this.layoutBound);
  }
  private layoutBound = () => this.layout();

  /** The graphics this stream may show. Unknown ones are removed, new ones created (hidden). */
  setDefs(defs: OverlayDef[]): void {
    const want = new Set(defs.map((d) => d.id));
    for (const [id, l] of this.layers) if (!want.has(id) || l.def.url !== defs.find((d) => d.id === id)?.url) { l.box.remove(); this.layers.delete(id); }
    for (const d of defs) {
      if (this.layers.has(d.id)) { this.layers.get(d.id)!.def = d; continue; }
      const box = document.createElement('div');
      box.className = 'vp-gfx-layer';
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('tabindex', '-1');
      frame.setAttribute('title', d.name);
      frame.style.cssText = `width:${d.canvas[0]}px;height:${d.canvas[1]}px;border:0;background:transparent;display:block;color-scheme:normal;pointer-events:none`;
      frame.src = /^https?:/.test(d.url) ? d.url : this.apiBase + d.url;
      box.appendChild(frame);
      this.root.appendChild(box);
      this.layers.set(d.id, { def: d, box, frame, ready: false, sentValues: '', sentOn: null, on: false, values: {} });
    }
    this.layout();
  }

  /** Apply a state. Returns the ids on screen (for impressions). */
  apply(state: OverlayState | null, visible: boolean): Set<string> {
    this.visible = visible;
    this.root.style.visibility = visible ? 'visible' : 'hidden';
    const on = new Set<string>();
    for (const [id, l] of this.layers) {
      const st = state?.[id];
      l.on = !!st?.on;
      if (st?.on) { l.values = st.v ?? {}; if (visible) on.add(id); }
      this.sync(l);
    }
    return on;
  }

  private sync(l: Layer) {
    if (!l.ready) return;
    const post = (op: string, data?: unknown) => { try { l.frame.contentWindow?.postMessage({ type: 'volt-gfx', op, data }, '*'); } catch { /* gone */ } };
    const v = JSON.stringify(l.values);
    if (l.on && v !== l.sentValues) { post('update', l.values); l.sentValues = v; }
    const show = l.on && this.visible;
    if (show !== l.sentOn) { post(show ? 'play' : 'stop'); l.sentOn = show; }
  }

  /** Fit the canvas to the picture inside the stage (object-fit: contain). */
  private layout() {
    const sw = this.stage.clientWidth, sh = this.stage.clientHeight;
    if (!sw || !sh) return;
    const v = this.media as HTMLVideoElement;
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    const k = Math.min(sw / vw, sh / vh);
    const pw = vw * k, ph = vh * k;
    this.root.style.left = `${(sw - pw) / 2}px`; this.root.style.top = `${(sh - ph) / 2}px`;
    this.root.style.width = `${pw}px`; this.root.style.height = `${ph}px`;
    for (const l of this.layers.values()) {
      const [cw, ch] = l.def.canvas;
      const s = Math.min(pw / cw, ph / ch);
      const p = l.def.placement ?? {};
      l.box.style.cssText = `position:absolute;left:0;top:0;width:${cw}px;height:${ch}px;transform-origin:0 0;transform:scale(${s});z-index:${p.layer ?? 2}`;
      l.frame.style.transformOrigin = ORIGIN[p.anchor ?? 'top_left'] ?? '0 0';
      l.frame.style.transform = `translate(${p.x ?? 0}px, ${p.y ?? 0}px) scale(${p.scale ?? 1})`;
    }
  }

  get count(): number { return this.layers.size; }

  destroy(): void {
    window.removeEventListener('message', this.onMsg);
    this.media.removeEventListener('loadedmetadata', this.layoutBound);
    this.ro?.disconnect();
    this.root.remove();
    this.layers.clear();
  }
}
