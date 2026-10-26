// ============================================================================
//  THE VOLT PLAYER: engine + playlist + guide + casting + beacons + a skin.
//
//    const p = await VoltPlayer.create({ el: '#player', appKey: 'pk_…',
//                                        playlist: ['<asset id>', '<asset id>'],
//                                        theme: { primary: '#e11d48' } });
//
//  The player owns state; the skin draws it. Everything a skin can do goes
//  through Commands, so a client's custom skin gets the same powers as ours
//  and none of the dangerous ones.
// ============================================================================
import type {
  Commands, PlayerEventName, PlayerState, PlaylistItem, Programme, ResolvedTheme, Skin, SkinFactory,
  SkipOffer, StreamGraphic, Theme, VoltPlayerSdkOptions,
} from './types';
import { Engine, isApple, readableError } from './engine';
import { Beacons } from './beacons';
import { Caster, contentTypeFor, showAirPlayPicker, watchAirPlay } from './cast';
import { applyTheme, resolveTheme } from './theme';
import { canStartOver, cleanSchedule, hasSource, normalizePlaylist, programmeAfter, programmeAt, startOverTarget, upNextFor } from './schedule';
import { defaultApiBase, fetchEvent, fetchNowPlaying, fetchSchedule, fillUrl, GateError, mergeResolved, resolveAsset } from './resolver';
import { getSkin } from './skins';
import { STRINGS, format } from './strings';
import { injectBaseStyles } from './skins/kit';
import { GraphicsOverlay, snapshotAt, mergeSnapshots, cameOn, feedUrl, type OverlayDef, type OverlaySnapshot } from './overlay';
import { activeAt, adBreakAt, fromDashRegion, fromHlsRegions, fromNativeCues, mergeGraphics, upNextFromGraphic } from './triggers';
import type { TriggerReport } from './engine';
import { errorCode, errorStep } from './engine';
import { CmcdSender, PlayAttempt, deviceModel, identityKeys } from './cmcd';
import { VodAds } from './ads';
import { StatsPanel, bindDebugMenu, combineProbes, mediaProbe, SDK_VERSION, type StatsSample } from './stats';

const EPG_REFRESH_MS = 5 * 60_000;
const NOW_PLAYING_MS = 15_000;
const store = {
  get(k: string): string | null { try { return localStorage.getItem(`volt-player:${k}`); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(`volt-player:${k}`, v); } catch { /* private mode */ } },
};

export function initialState(): PlayerState {
  return {
    status: 'idle', playing: false, buffering: false, error: null, errorCode: null,
    currentTime: 0, duration: NaN, live: false, seekable: null, dvr: false, atLiveEdge: true, behindLive: 0, wallClock: null,
    programme: null, nextProgramme: null, schedule: [], canStartOver: false,
    volume: 1, muted: false, rate: 1,
    qualities: [], quality: 'auto', activeQuality: null, textTracks: [], textTrack: null, audioTracks: [], audioTrack: null,
    items: [], index: -1, item: null, upNext: null, skip: null, graphics: [], overlays: [], adBreak: null, ad: null,
    nowPlaying: null, history: [], nextTrack: null,
    cast: { available: false, state: 'none', device: null },
    airplay: { available: false, active: false },
    fullscreen: false, pip: { available: false, active: false },
    hasPicture: false, audioOnly: false,
    event: null, presentation: null, msToStart: null, access: { mode: null, message: null, products: [] }, replaying: false,
    stats: false,
  };
}

export class VoltPlayer {
  readonly root: HTMLElement;
  readonly media: HTMLVideoElement;
  private o: VoltPlayerSdkOptions;
  private api: string;
  private engine: Engine;
  private skin: Skin | null = null;
  private skinRoot: HTMLElement;
  private stage: HTMLElement;
  private theme: ResolvedTheme;
  private themeLayers: Array<Partial<Theme> | undefined>;
  private s: PlayerState = initialState();
  private listeners = new Map<string, Set<(d?: unknown) => void>>();
  private raf = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private beacons: Beacons | null = null;
  /** On-demand ads of the item playing (sdk/ads.ts): the ad on screen, snapback, clicks. */
  private vodAds: VodAds | null = null;
  /** CMCD v2 (sdk/cmcd.ts): the play attempt of the item now loading or playing. */
  private attempt: PlayAttempt | null = null;
  private caster: Caster | null = null;
  private loadSeq = 0;
  private dismissedFor: string | null = null;
  /** In-stream graphic triggers seen so far for this item, by id (sdk/triggers.ts). */
  private streamGraphics = new Map<string, StreamGraphic>();
  private activeGraphicIds = '';
  /** HTML graphics from the console (sdk/overlay.ts): the layer, its graphics, their state over time. */
  private overlay: GraphicsOverlay | null = null;
  private gfxDefs: OverlayDef[] = [];
  private gfxSnaps: OverlaySnapshot[] = [];
  private gfxStream: string | null = null;
  private gfxTimer: ReturnType<typeof setTimeout> | null = null;
  private gfxOn = new Set<string>();
  private gfxSession = `gfx-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  private lastProgrammeId: string | null = null;
  private analyser: AnalyserNode | null = null;
  private freq: Uint8Array | null = null;
  private offs: Array<() => void> = [];
  private kind = '';
  private url = '';
  private ownsMedia: boolean;
  private destroyed = false;
  /** Playback stats (sdk/stats.ts): the panel is built the first time it opens. */
  private statsPanel: StatsPanel | null = null;
  private mprobe: ReturnType<typeof mediaProbe>;

  static async create(o: VoltPlayerSdkOptions): Promise<VoltPlayer> {
    const p = new VoltPlayer(o);
    await p.start();
    return p;
  }

  constructor(o: VoltPlayerSdkOptions) {
    this.o = o;
    const host = typeof o.el === 'string' ? document.querySelector<HTMLElement>(o.el) : o.el;
    if (!host) throw new Error(`volt-player: no element matched ${String(o.el)}`);
    injectBaseStyles();
    this.api = defaultApiBase(o.apiBase);
    this.root = document.createElement('div');
    this.root.className = 'vp';
    this.root.tabIndex = 0;
    host.appendChild(this.root);
    this.ownsMedia = !o.media;
    this.media = o.media ?? document.createElement('video');
    this.media.playsInline = true;
    this.media.setAttribute('playsinline', '');
    this.media.crossOrigin = 'anonymous';
    this.media.controls = false;
    this.media.classList.add('vp-media');
    if (o.poster) this.media.poster = o.poster;
    this.stage = document.createElement('div');
    this.stage.className = 'vp-stage';
    this.stage.appendChild(this.media);
    if (o.watermark) {
      const wm = document.createElement('div');
      wm.className = 'vp-watermark';
      wm.textContent = o.watermark;
      this.stage.appendChild(wm);
    }
    this.skinRoot = document.createElement('div');
    this.skinRoot.className = 'vp-skin';
    this.root.appendChild(this.skinRoot);
    this.themeLayers = [o.theme];
    this.theme = resolveTheme(...this.themeLayers);
    applyTheme(this.root, this.theme);
    this.engine = new Engine(this.media, { requestHeaders: o.requestHeaders, nativeHlsOnApple: o.airplay !== false, textContainer: this.stage, drm: o.drm ?? null });
    this.engine.onChange = () => this.pullEngine();
    this.engine.onError = (msg, code) => this.fail(msg, code);
    this.engine.onTrigger = (r) => this.onTrigger(r);
    this.mprobe = mediaProbe(this.media, this.root);
  }

  // ---------------------------------------------------------------- lifecycle
  private async start(): Promise<void> {
    const vol = Number(store.get('volume'));
    this.media.volume = Number.isFinite(vol) && vol >= 0 && vol <= 1 && store.get('volume') != null ? vol : 1;
    this.media.muted = !!this.o.muted || store.get('muted') === '1';
    this.mountSkin(this.o.skin);
    this.wireMedia();
    this.wireRoot();
    this.setupCasting();
    if (this.o.debug !== false) this.offs.push(bindDebugMenu(this.root, () => [
      { label: this.t('playbackStats'), checked: this.s.stats, run: () => this.showStats() },
      { label: this.t('copyDebug'), run: () => void this.copyDebugInfo() },
    ], `Volt Player ${SDK_VERSION}`));
    if (typeof this.o.debug === 'object' && this.o.debug.open) this.showStats(true);

    const items = normalizePlaylist([
      ...(this.o.item ? [this.o.item] : []),
      ...(this.o.source ? [{ id: 'source', source: this.o.source } as PlaylistItem] : []),
      ...(this.o.assetId ? [this.o.assetId] : []),
      ...(this.o.playlist ?? []),
      // An event with nothing else to play plays itself.
      ...(this.o.eventId && !this.o.item && !this.o.source && !this.o.assetId && !this.o.playlist?.length ? [this.o.eventId] : []),
    ]);
    this.set({ items, pip: { available: !!(document as any).pictureInPictureEnabled && this.ownsMedia, active: false } });
    if (this.o.demo) { this.setDemo(this.o.demo); this.emit('ready'); return; }

    if (this.o.epg) void this.loadSchedule();
    if (this.o.eventId && this.o.appKey) await this.pollEvent();
    if (this.o.stationId && this.o.appKey) void this.pollNowPlaying();
    this.tick = setInterval(() => this.derive(), 500);
    if (items.length) await this.load(Math.min(Math.max(0, this.o.startIndex ?? 0), items.length - 1), !!this.o.autoplay);
    this.emit('ready');
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.attempt?.close();
    this.attempt = null;
    this.engine.attempt = null;
    this.beacons?.destroy();
    this.vodAds?.dispose();
    if (this.gfxTimer) clearTimeout(this.gfxTimer);
    this.overlay?.destroy();
    if (this.tick) clearInterval(this.tick);
    if (this.eventTimer) clearTimeout(this.eventTimer);
    for (const t of this.timers) clearInterval(t);
    for (const f of this.offs) { try { f(); } catch { /* */ } }
    cancelAnimationFrame(this.raf);
    this.statsPanel?.destroy();
    this.mprobe.destroy();
    try { this.skin?.destroy?.(); } catch { /* */ }
    await this.engine.destroy();
    this.root.remove();
  }

  // --------------------------------------------------------------- public API
  getState(): PlayerState { return this.s; }
  /**
   * Every in-stream graphic the manifests have announced and the player still
   * holds (past, on screen and upcoming), in media time, oldest first. Whatever
   * showGraphics says: this is for checking a stream (the share page's "In-stream
   * graphics" panel), not for drawing.
   */
  getStreamGraphics(): StreamGraphic[] { return [...this.streamGraphics.values()].sort((a, b) => a.start - b.start); }
  on(name: PlayerEventName, fn: (d?: unknown) => void): () => void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
    return () => this.listeners.get(name)?.delete(fn);
  }
  get commands(): Commands { return this.cmd; }
  play(): void { this.cmd.play(); }
  pause(): void { this.cmd.pause(); }
  seek(t: number): void { this.cmd.seek(t); }
  next(): void { this.cmd.next(); }
  previous(): void { this.cmd.previous(); }

  /**
   * PLAYBACK STATS (sdk/stats.ts). Open, close or (no argument) toggle the
   * panel; works whatever `debug` says, so a skin's own Stats button does too.
   */
  showStats(on?: boolean): void {
    const open = on ?? !this.s.stats;
    if (open && !this.statsPanel) {
      this.statsPanel = new StatsPanel({
        host: this.root, probe: this.statsProbe(), version: SDK_VERSION, title: this.t('playbackStats'),
        onClose: () => { this.set({ stats: false }); this.emit('statschange', false); },
      });
    }
    this.statsPanel?.setOpen(open);
    if (open !== this.s.stats) { this.set({ stats: open }); this.emit('statschange', open); }
  }

  /** A stats sample now, open or not: for a host page's own support form. */
  getStats(): StatsSample { return combineProbes(this.statsProbe())() as StatsSample; }

  /** Copy the stats as text (for a support ticket) and return the text. */
  async copyDebugInfo(): Promise<string> {
    if (!this.statsPanel) this.statsPanel = new StatsPanel({ host: this.root, probe: this.statsProbe(), version: SDK_VERSION, title: this.t('playbackStats'),
      onClose: () => { this.set({ stats: false }); this.emit('statschange', false); } });
    await this.statsPanel.copy();
    return this.statsPanel.text();
  }

  /** The player's own knowledge first, then the engine's, then the media element's. */
  private statsProbe() {
    return combineProbes(
      () => {
        const it = this.s.item;
        return {
          assetId: it?.assetId ?? null, title: it?.title ?? null, sessionId: this.attempt?.sid ?? this.beacons?.sessionId ?? null,
          status: this.s.status === 'error' && this.s.error ? `error: ${this.s.error}${this.s.errorCode != null ? ` (${this.s.errorCode})` : ''}` : this.s.status,
          programme: this.s.programme?.title ?? null,
          wallClock: this.s.live ? this.s.wallClock : null,
        };
      },
      () => this.engine.debugSample(),
      // Distance from the live edge when the engine has no clock-based latency.
      () => (this.s.live ? { latency: this.s.behindLive } : {}),
      this.mprobe,
    );
  }

  /** Change the theme live (the console's preview). */
  setTheme(t: Partial<Theme>): void {
    this.themeLayers = [this.o.theme, t];
    this.theme = resolveTheme(...this.themeLayers);
    applyTheme(this.root, this.theme);
    try { this.skin?.themeChanged?.(this.theme); } catch { /* */ }
    this.render();
  }

  /** Demo mode: show this state (merged over the current one). */
  setDemo(p: Partial<PlayerState>): void {
    const item = p.item ?? (p.items && p.items[p.index ?? 0]) ?? this.s.item;
    this.set({ ...p, item });
  }

  /** Swap the skin without stopping playback. */
  setSkin(skin: string | SkinFactory): void { this.mountSkin(skin); this.render(); }

  /** Replace the playlist and play from `index`. */
  async setPlaylist(entries: Array<PlaylistItem | string>, index = 0, autoplay = true): Promise<void> {
    const items = normalizePlaylist(entries);
    this.set({ items });
    if (items.length) await this.load(Math.min(index, items.length - 1), autoplay);
  }

  async setSource(source: PlaylistItem['source'], meta: Partial<PlaylistItem> = {}, autoplay = true): Promise<void> {
    await this.setPlaylist([{ id: meta.id ?? 'source', ...meta, source }], 0, autoplay);
  }

  // -------------------------------------------------------------------- skin
  private mountSkin(skin: string | SkinFactory | undefined) {
    try { this.skin?.destroy?.(); } catch { /* */ }
    this.skinRoot.innerHTML = '';
    const make = typeof skin === 'function' ? skin : getSkin(skin ?? 'video');
    this.skin = make();
    // The skin's styles key off data-skin, so the default must be named too: an
    // embedder who leaves `skin` out gets the video skin (as documented), and
    // marking it 'custom' left it without its 16:9 box, a stage 0 px high.
    this.root.dataset.skin = typeof skin === 'function' ? 'custom' : (skin ?? 'video');
    try {
      this.skin.mount({ root: this.skinRoot, stage: this.stage, theme: this.theme, commands: this.cmd, t: (k, v) => format(this.o.strings?.[k] ?? STRINGS[k] ?? k, v) });
    } catch (e) { console.error('[volt-player] skin failed to mount', e); }
    // A skin that never placed the stage still shows the picture.
    if (!this.stage.isConnected) this.skinRoot.prepend(this.stage);
  }

  // -------------------------------------------------------------------- state
  private set(p: Partial<PlayerState>) {
    this.s = { ...this.s, ...p };
    this.render();
  }

  private render() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.destroyed) return;
      try { this.skin?.update(this.s); } catch (e) { console.warn('[volt-player] skin threw', e); }
      this.emit('state', this.s);
    });
  }

  private emit(name: PlayerEventName, d?: unknown) {
    for (const f of this.listeners.get(name) ?? []) { try { f(d); } catch { /* a listener never breaks playback */ } }
    try { this.o.onEvent?.(name, d); } catch { /* */ }
  }

  private fail(msg: string, code: string | number | null) {
    this.set({ status: 'error', error: msg, errorCode: code, playing: false, buffering: false });
    this.emit('error', { message: msg, code });
  }

  private pullEngine() {
    const e = this.engine.snapshot();
    if (e.activeQuality?.bitrate) this.attempt?.bitrate(e.activeQuality.bitrate / 1000);
    const prevQ = this.s.activeQuality?.id;
    this.set({
      live: e.live, duration: e.duration, seekable: e.seekable,
      dvr: e.live && !!e.seekable && e.seekable.end - e.seekable.start > 90,
      qualities: e.qualities, activeQuality: e.activeQuality, quality: e.quality,
      textTracks: e.textTracks, textTrack: e.textTrack, audioTracks: e.audioTracks, audioTrack: e.audioTrack,
      audioOnly: e.audioOnly || this.s.audioOnly && !this.s.hasPicture,
    });
    if (e.activeQuality?.id !== prevQ) this.emit('qualitychange', e.activeQuality);
  }

  /** In-stream triggers from the engine, as parsed (sdk/triggers.ts). */
  private onTrigger(r: TriggerReport) {
    const list = r.kind === 'hls' ? fromHlsRegions(r.regions)
      : r.kind === 'dash' ? [fromDashRegion(r.region)].filter((g): g is StreamGraphic => !!g)
      : fromNativeCues(r.cues);
    if (list.length) mergeGraphics(this.streamGraphics, list, this.media.currentTime - 3600);
  }

  /** Twice a second: the clock-driven parts (live position, programme, up next). */
  private derive() {
    if (this.destroyed) return;
    const m = this.media;
    const casting = this.caster?.connected;
    const e = this.engine.snapshot();
    const currentTime = casting ? this.caster!.remote.currentTime : m.currentTime;
    const behindLive = e.live && e.seekable ? Math.max(0, e.seekable.end - currentTime) : 0;
    const wallClock = e.presentationStart != null ? e.presentationStart + currentTime * 1000 : (e.live ? Date.now() - behindLive * 1000 : null);
    const sched = this.s.schedule;
    // IN-STREAM GRAPHICS (sdk/triggers.ts): what the manifest says is on screen at
    // this media time. Only when graphics are on; the triggers are always parsed.
    const graphicsOn = this.o.showGraphics ?? this.theme.showGraphics;
    // AD BREAK: while the stream says a break is on, nothing of ours is drawn
    // over it (no Up next, no programme cards, no bugs), only the break itself.
    const adBreak = adBreakAt(this.streamGraphics.values(), currentTime);
    const graphics = !graphicsOn ? [] : adBreak ? [adBreak] : activeAt(this.streamGraphics.values(), currentTime);
    // No guide loaded: the stream's own programme marker names what is on.
    const inband = !sched.length && e.presentationStart != null ? graphics.find((g) => g.graphic === 'programme') : undefined;
    const programme = sched.length ? programmeAt(sched, wallClock ?? Date.now())
      : inband ? { id: inband.data.id || inband.id, title: inband.data.title || '', subtitle: inband.data.subtitle ?? null, description: null,
          imageUrl: inband.data.image ?? null, startsAt: e.presentationStart! + inband.start * 1000,
          endsAt: inband.end != null ? e.presentationStart! + inband.end * 1000 : Number.POSITIVE_INFINITY } : null;
    const guideNext = sched.length ? programmeAfter(sched, programme ? programme.endsAt - 1 : (wallClock ?? Date.now())) : null;
    // No guide: the stream announces the next programme's marker shortly before it
    // starts (90 s look-ahead), which is enough for a skin's "Next" line. Display
    // only: Up next itself still comes from the stream's own up-next trigger, so a
    // channel that turned Up next off is not given one by this.
    let nextProgramme = guideNext;
    if (!sched.length && inband && e.presentationStart != null) {
      let nx: StreamGraphic | undefined;
      for (const g of this.streamGraphics.values()) if (g.graphic === 'programme' && g.start > inband.start && (!nx || g.start < nx.start)) nx = g;
      if (nx) nextProgramme = { id: nx.data.id || nx.id, title: nx.data.title || '', subtitle: nx.data.subtitle ?? null, description: null,
        imageUrl: nx.data.image ?? null, startsAt: e.presentationStart + nx.start * 1000,
        endsAt: nx.end != null ? e.presentationStart + nx.end * 1000 : Number.POSITIVE_INFINITY };
    }
    const item = this.s.item;
    const dismissKey = programme ? `p:${programme.id}` : `i:${this.s.index}`;
    // The stream's own Up next wins over one worked out from a fetched guide: it is
    // what the broadcaster's schedule said at airing time, and it needs no app key.
    const upG = graphics.find((g) => g.graphic === 'up-next');
    const hideForBreak = !!adBreak;
    const upNext = hideForBreak ? null : this.theme.controls.upNext && upG && this.dismissedFor !== `g:${upG.id}` ? upNextFromGraphic(upG, currentTime, wallClock)
      : this.theme.controls.upNext ? upNextFor({
      hasNextItem: this.s.index + 1 < this.s.items.length, nextItem: this.s.items[this.s.index + 1] ?? null,
      currentTime, duration: e.duration, live: e.live, programme, nextProgramme: guideNext, playheadClock: wallClock,
      seconds: this.theme.upNextSeconds, autoAdvance: this.theme.autoAdvance, dismissed: this.dismissedFor === dismissKey,
    }) : null;
    // SKIP (intro, recap, credits): on-demand only, from the asset's skip markers,
    // whatever showGraphics says (it is a control, not a graphic). Gone in the
    // last half second so a button never offers to skip what has just ended.
    let skip: SkipOffer | null = null;
    if (!e.live && this.theme.controls.skip !== false) {
      for (const g of this.streamGraphics.values()) {
        if (!g.graphic.startsWith('skip-') || g.end == null) continue;
        if (currentTime >= g.start && currentTime < g.end - 0.5) { skip = { kind: g.data.kind || g.graphic.slice(5), from: g.start, to: g.end, id: g.id }; break; }
      }
    }
    if (programme?.id !== this.lastProgrammeId) { this.lastProgrammeId = programme?.id ?? null; if (programme) this.emit('programmechange', programme); }
    if (upNext && !this.s.upNext) this.emit('upnext', upNext);
    // HTML GRAPHICS (sdk/overlay.ts): the state in force at the playhead's wall
    // clock, hidden when graphics are off, during a break, or with no picture.
    let overlays = this.s.overlays;
    if (this.overlay) {
      const at = wallClock ?? (e.live ? Date.now() : null);
      const snap = at != null ? snapshotAt(this.gfxSnaps, at) : null;
      const on = this.overlay.apply(snap?.state ?? null, graphicsOn && !adBreak && m.videoWidth > 0);
      const fresh = cameOn(this.gfxOn, on);
      this.gfxOn = on;
      overlays = this.gfxDefs.filter((d) => on.has(d.id)).map((d) => ({ id: d.id, name: d.name, kind: d.kind }));
      if (fresh.length) {
        for (const id of fresh) { const d = this.gfxDefs.find((x) => x.id === id); this.emit('graphic', { id, graphic: 'html', start: currentTime, end: null, data: { name: d?.name ?? '', kind: d?.kind ?? '' } }); }
        this.reportImpressions(fresh);
      }
    }
    const ids = graphics.map((g) => g.id).join('|');
    if (ids !== this.activeGraphicIds) {
      const before = new Set(this.activeGraphicIds.split('|'));
      this.activeGraphicIds = ids;
      for (const g of graphics) if (!before.has(g.id)) this.emit('graphic', g);
    }
    // The playback reports count a break's time as the ad's (sdk/cmcd.ts adBreak; only a change is reported).
    if (!casting) this.attempt?.adBreak(adBreak ? (adBreak.data.break || adBreak.id) : null);
    this.set({
      currentTime, behindLive, atLiveEdge: !e.live || behindLive < 8, wallClock: e.live ? wallClock : null,
      programme, nextProgramme, upNext, skip, graphics, overlays,
      adBreak: adBreak ? { id: adBreak.data.break || adBreak.id, endsAt: adBreak.end != null && e.presentationStart != null ? e.presentationStart + adBreak.end * 1000 : null } : null,
      canStartOver: this.theme.controls.startOver && canStartOver(programme, e.presentationStart, e.seekable, e.live),
      seekable: e.seekable,
      hasPicture: m.videoWidth > 0,
      item: item,
      msToStart: this.countdown(),
    });
  }

  /** Milliseconds to the event's start, while there is a start to count down to. */
  private countdown(): number | null {
    const ev = this.s.event;
    if (!ev || ev.startsAt == null || !['pre', 'postponed', 'offline'].includes(this.s.presentation ?? '')) return null;
    const ms = ev.startsAt - Date.now();
    return ms > 0 ? ms : null;
  }

  /**
   * The event's phase, from the control plane. Polled: every 30 s, every 5 s
   * in the last two minutes before the start and while a delayed start is
   * pending, so the stream begins within seconds of going live. When the phase
   * becomes live the stream is loaded (the gate gives no URLs before then).
   */
  private async pollEvent() {
    const run = async () => {
      if (this.destroyed) return;
      const ev = await fetchEvent(this.api, this.o.appKey!, this.o.eventId!).catch(() => null);
      if (ev && !this.destroyed) {
        const was = this.s.presentation;
        this.set({ event: ev, presentation: ev.presentation });
        if (ev.presentation !== was) {
          this.emit('presentationchange', ev.presentation);
          const idle = ['offline', 'error', 'idle'].includes(this.s.status);
          if (ev.presentation === 'live' && was && idle && !this.s.replaying && this.s.items.length) void this.load(Math.max(0, this.s.index), !!this.o.autoplay);
        }
      }
      const soon = ev?.startsAt != null && ev.startsAt - Date.now() < 120_000 && ['pre', 'offline'].includes(ev.presentation);
      this.eventTimer = setTimeout(run, soon ? 5000 : 30000);
    };
    await run();
  }
  private eventTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The console's HTML graphics for this stream (GET /api/player/graphics).
   * Polled every 2 s while the stream has graphics for the player, every 30 s
   * while it has none, and not at all for what is not a channel or event (404).
   * Asks from a little before the playhead's wall clock, so the snapshot in
   * force there is always in hand.
   */
  private startGraphicsFeed(streamId: string | null) {
    if (this.gfxTimer) { clearTimeout(this.gfxTimer); this.gfxTimer = null; }
    this.gfxStream = streamId; this.gfxDefs = []; this.gfxSnaps = []; this.gfxOn = new Set();
    this.overlay?.setDefs([]);
    if (!streamId || !this.o.appKey || this.o.showGraphics === false) return;
    const run = async () => {
      if (this.destroyed || this.gfxStream !== streamId) return;
      let next = 2000;
      try {
        const since = (this.s.wallClock ?? Date.now()) - 15_000;
        const r = await fetch(feedUrl(this.api, this.o.appKey!, streamId, since), { credentials: 'omit' });
        if (r.status === 404 || r.status === 401 || r.status === 403) return;   // not a stream with graphics, or not allowed here
        if (r.ok) {
          const f: any = await r.json();
          if (this.destroyed || this.gfxStream !== streamId) return;
          const defs: OverlayDef[] = Array.isArray(f.graphics) ? f.graphics : [];
          this.gfxDefs = defs;
          if (defs.length && !this.overlay) this.overlay = new GraphicsOverlay(this.stage, this.media, this.api);
          this.overlay?.setDefs(defs);
          this.gfxSnaps = mergeSnapshots(this.gfxSnaps, Array.isArray(f.snapshots) ? f.snapshots : [], since - 60_000);
          if (!defs.length) next = 30_000;
        }
      } catch { next = 5000; /* a feed problem never touches playback */ }
      this.gfxTimer = setTimeout(run, next);
    };
    void run();
  }

  /** A graphic came on screen for this viewer (REQ FR-17). Fire and forget. */
  private reportImpressions(ids: string[]) {
    if (!this.gfxStream || !this.o.appKey || this.o.beacons === false) return;
    try {
      const body = JSON.stringify({ appKey: this.o.appKey, streamId: this.gfxStream, sessionId: this.beacons?.sessionId ?? this.gfxSession, items: ids.map((id) => ({ id, at: Date.now() })) });
      void fetch(`${this.api}/api/player/graphics/impressions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true, credentials: 'omit' }).catch(() => {});
    } catch { /* */ }
  }

  /** A signed-in viewer (after a purchase or sign-in): ask the gate again with them. */
  setViewerToken(token: string | null): void {
    this.o = { ...this.o, viewerToken: token };
    this.cmd.refreshAccess();
  }

  // ------------------------------------------------------------------ loading
  private async load(index: number, autoplay: boolean): Promise<void> {
    const seq = ++this.loadSeq;
    this.beacons?.destroy();
    this.beacons = null;
    this.vodAds?.dispose();
    this.vodAds = null;
    this.attempt?.close();
    this.attempt = null;
    this.engine.attempt = null;
    this.dismissedFor = null;
    this.streamGraphics.clear();
    this.activeGraphicIds = '';
    let item = this.s.items[index];
    if (!item) return;
    // The play attempt opens HERE, before the play gate is asked: a refusal, a
    // manifest that never comes or a failed licence is still a view, with its
    // step and code (QOE_REPORTING.md principle 2).
    const attempt = this.openAttempt(item, autoplay);
    this.startGraphicsFeed(item.assetId ?? null);
    this.set({ index, item, status: 'loading', error: null, errorCode: null, upNext: null, skip: null, graphics: [], overlays: [], adBreak: null, hasPicture: false, audioOnly: false, qualities: [], textTracks: [], audioTracks: [],
      access: { mode: null, message: null, products: [] } });
    this.emit('itemchange', { index, item });
    try {
      if (item.assetId && !hasSource(item.source)) {
        if (!this.o.appKey) throw new GateError(401, 'This player needs an app key to play asset ids.', null);
        attempt?.spanStart('entitlement');
        // On-demand ads: guided (HLS Interstitials) where this player plays HLS natively on Apple, stitched otherwise.
        const caps = isApple() && this.o.airplay !== false && !!this.media.canPlayType?.('application/vnd.apple.mpegurl') ? ['hls-interstitials'] : [];
        const r = await resolveAsset(this.api, this.o.appKey, item.assetId, this.o.viewerToken, attempt?.sid, { delivery: 'auto', caps });
        attempt?.spanEnd('entitlement');
        if (seq !== this.loadSeq) return;
        item = mergeResolved(item, r);
        if (attempt && item.live != null) attempt.live = item.live;
        const items = this.s.items.slice(); items[index] = item;
        this.set({ items, item });
      }
      if (!hasSource(item.source)) {
        // An event before its start is not "off air": the skin shows the countdown.
        this.set({ status: 'offline', error: this.s.presentation && this.s.presentation !== 'live' ? null : this.t('offline'), live: item.live ?? true });
        // Nothing to play: an event before its start is not a failed attempt; a stream off air is.
        if (this.s.presentation && this.s.presentation !== 'live') attempt?.close();
        else attempt?.error('not-on-air', 'entitlement', true);
        return;
      }
      if (item.artworkUrl && !this.o.poster && this.ownsMedia) this.media.poster = item.artworkUrl;
      const startAt = index === (this.o.startIndex ?? 0) ? this.o.startAt : undefined;
      const used = await this.engine.load(item.source!, startAt);
      if (seq !== this.loadSeq) return;
      this.kind = used.kind; this.url = used.url;
      if (attempt) { attempt.sf = used.kind === 'hls' ? 'h' : used.kind === 'dash' ? 'd' : 'o'; attempt.live = this.engine.snapshot().live; }
      this.set({ status: 'ready' });
      this.pullEngine();
      // Subtitles in the language the viewer chose last time, when this item has it.
      const lang = store.get('textLang');
      if (lang) { const id = this.engine.textByLang(lang); if (id) this.engine.setTextTrack(id); }
      this.startBeacons(item);
      if (item.ads) this.vodAds = new VodAds(this.media, this.api, item.ads, (ad) => this.set({ ad }), this.stage);
      if (this.caster?.connected) await this.castCurrent();
      else if (autoplay) this.cmd.play();
    } catch (e: any) {
      if (seq !== this.loadSeq) return;
      // The attempt ends here either way: a refusal at the gate (its status)
      // or a failure on the way to a first frame (the step it failed at).
      if (e instanceof GateError) attempt?.error(`gate-${e.status}`, 'entitlement', true);
      else attempt?.error(errorCode(e), e?.category != null ? errorStep(e) : 'playback', true);
      // PAYWALL / SIGN IN / REGION: not a failure. The viewer is shown what it
      // is (title, artwork from the gate) and what would let them watch.
      if (e instanceof GateError && (e.status === 402 || e.mode === 'paywall' || e.mode === 'sign_in' || e.status === 451)) {
        const m = e.meta ?? {};
        const it = { ...item, title: item.title ?? m.title ?? null, artworkUrl: item.artworkUrl ?? m.artworkUrl ?? null, description: item.description ?? m.description ?? null };
        const items = this.s.items.slice(); items[index] = it;
        const mode = e.mode === 'paywall' || e.status === 402 ? 'paywall' : e.mode === 'sign_in' ? 'sign_in' : 'blocked';
        this.set({ items, item: it, status: 'locked', error: null, errorCode: e.status, live: it.live ?? true,
          access: { mode, message: e.message, products: e.products } });
        this.emit('locked', { mode, products: e.products, assetId: item.assetId });
        return;
      }
      this.fail(e instanceof GateError ? e.message : (e?.message || readableError(e)), e?.status ?? e?.code ?? null);
    }
  }

  private startBeacons(item: PlaylistItem) {
    const b = this.o.beacons;
    if (b === false || !item.playbackToken) return;
    const cfg = typeof b === 'object' ? b : {};
    this.beacons = new Beacons(this.media, {
      // One session id everywhere: the beacons' session is the CMCD sid.
      id: this.attempt?.sid,
      url: cfg.url ?? `${this.api}/api/analytics/beacon`,
      token: item.playbackToken,
      prefix: cfg.prefix ?? 'web',
      kbps: () => { const q = this.s.activeQuality; return q ? Math.round(q.bitrate / 1000) : undefined; },
    });
  }

  /**
   * A new play attempt for an item (sdk/cmcd.ts), or null with CMCD off.
   * Request mode is on for players with an app key (viewers); event mode needs
   * the key too, which is how the collector knows whose viewer it is.
   */
  private openAttempt(item: PlaylistItem, autoplay: boolean): PlayAttempt | null {
    const c = this.o.cmcd;
    if (c === false || this.o.demo) return null;
    const cfg = typeof c === 'object' ? c : {};
    const key = this.o.appKey;
    const requestMode = cfg.requestMode ?? !!key;
    const eventMode = (cfg.eventMode ?? true) && !!key;
    if (!requestMode && !eventMode) return null;
    const sender = eventMode ? new CmcdSender({ url: `${cfg.url ?? `${this.api}/api/cmcd`}?appKey=${encodeURIComponent(key!)}` }) : null;
    const a = new PlayAttempt({
      cid: item.assetId ?? item.id ?? null, live: item.live ?? null, sender, requestMode, autoplay,
      // The app's journey (sdk/journey.ts): which entry point and how many screens led here, and play_intent with this sid.
      identity: { ...identityKeys({ app: cfg.app ?? null, appVersion: cfg.appVersion ?? null, sdkVersion: SDK_VERSION, deviceModel: cfg.deviceModel ?? deviceModel() }), ...(this.o.journey?.attemptKeys() ?? {}) },
      probe: this.engine.playbackProbe(), heartbeatMs: cfg.heartbeatMs, rrSampleEvery: cfg.rrSampleEvery,
      onPlay: this.o.journey ? (sid) => this.o.journey!.playIntent(sid, item.assetId ?? item.id ?? null) : undefined,
    });
    this.attempt = a;
    this.engine.attempt = a;
    return a;
  }

  /**
   * 'playing' is not yet a picture: the browser fires it when it MEANS to
   * play (an encrypted stream waiting for its key does too). The first frame
   * is the one the compositor presents (requestVideoFrameCallback); audio, and
   * browsers without the callback, count 'playing'.
   */
  private attemptPlaying() {
    const a = this.attempt;
    if (!a) return;
    const m: any = this.media;
    if (a.started || !(m.videoWidth > 0) || typeof m.requestVideoFrameCallback !== 'function') { a.playing(); return; }
    m.requestVideoFrameCallback(() => { if (this.attempt === a) a.playing(); });
  }

  /** The current play attempt's CMCD session id (sid), for a host page's own logs. */
  get sessionId(): string | null { return this.attempt?.sid ?? null; }

  private async loadSchedule() {
    const run = async () => {
      const g = this.o.epg;
      let list: Programme[] = [];
      if (Array.isArray(g)) list = cleanSchedule(g);
      else if (g && this.o.appKey) list = await fetchSchedule(this.api, this.o.appKey, g.channelId).catch(() => []);
      if (!this.destroyed) this.set({ schedule: list });
    };
    await run();
    if (!Array.isArray(this.o.epg)) this.timers.push(setInterval(run, EPG_REFRESH_MS));
  }

  private async pollNowPlaying() {
    const run = async () => {
      const r = await fetchNowPlaying(this.api, this.o.appKey!, this.o.stationId!).catch(() => null);
      if (r && !this.destroyed) this.set({ nowPlaying: r.nowPlaying, history: r.history, nextTrack: r.next });
    };
    await run();
    this.timers.push(setInterval(run, NOW_PLAYING_MS));
  }

  // -------------------------------------------------------------- media wiring
  private wireMedia() {
    const m = this.media;
    const on = (ev: string, fn: () => void) => { m.addEventListener(ev, fn); this.offs.push(() => m.removeEventListener(ev, fn)); };
    on('playing', () => { this.attemptPlaying(); this.set({ status: 'playing', playing: true, buffering: false, error: null }); this.emit('play'); });
    on('play', () => this.set({ playing: true }));
    on('pause', () => { if (this.caster?.connected) return; if (!m.ended) this.attempt?.paused(); this.set({ status: m.ended ? 'ended' : 'paused', playing: false }); this.emit('pause'); });
    on('waiting', () => { this.attempt?.waiting(); this.set({ status: 'buffering', buffering: true }); });
    on('seeking', () => this.attempt?.seekingStarted());
    // CMCD: backgrounded (e=b), and a quit when the page goes away.
    const vis = () => this.attempt?.backgrounded(document.visibilityState === 'hidden');
    const gone = () => this.attempt?.close(true);
    document.addEventListener('visibilitychange', vis);
    addEventListener('pagehide', gone);
    this.offs.push(() => document.removeEventListener('visibilitychange', vis), () => removeEventListener('pagehide', gone));
    on('canplay', () => this.set({ buffering: false, status: this.s.playing ? 'playing' : this.s.status === 'loading' ? 'ready' : this.s.status }));
    on('volumechange', () => {
      if (m.muted !== this.s.muted) this.attempt?.muted(m.muted);
      store.set('volume', String(m.volume)); store.set('muted', m.muted ? '1' : '0');
      this.set({ volume: m.volume, muted: m.muted });
    });
    on('ratechange', () => { this.attempt?.rate(m.playbackRate); this.set({ rate: m.playbackRate }); });
    on('loadedmetadata', () => this.pullEngine());
    on('durationchange', () => this.pullEngine());
    on('resize', () => this.set({ hasPicture: m.videoWidth > 0 }));
    on('ended', () => this.onEnded());
    on('error', () => { if (this.engine.mode && this.engine.mode !== 'shaka' && this.s.status !== 'loading') this.fail(this.t('stopped'), m.error?.code ?? null); });
    on('enterpictureinpicture', () => this.set({ pip: { ...this.s.pip, active: true } }));
    on('leavepictureinpicture', () => this.set({ pip: { ...this.s.pip, active: false } }));
    const fs = () => this.set({ fullscreen: document.fullscreenElement === this.root || (document as any).webkitFullscreenElement === this.root });
    document.addEventListener('fullscreenchange', fs);
    document.addEventListener('webkitfullscreenchange', fs);
    this.offs.push(() => document.removeEventListener('fullscreenchange', fs), () => document.removeEventListener('webkitfullscreenchange', fs));
    if (this.o.airplay !== false) this.offs.push(watchAirPlay(m, (a) => this.set({ airplay: a })));
    this.set({ volume: m.volume, muted: m.muted });
  }

  private onEnded() {
    this.attempt?.ended();
    this.beacons?.end();
    this.set({ status: 'ended', playing: false });
    this.emit('ended', { index: this.s.index });
    const nextIdx = this.s.index + 1;
    if (nextIdx < this.s.items.length && this.theme.autoAdvance && this.dismissedFor !== `i:${this.s.index}`) void this.load(nextIdx, true);
  }

  /** Keyboard: space/k play, ←/→ 10 s, ↑/↓ volume, m mute, f fullscreen, c subtitles, Shift+D stats. */
  private wireRoot() {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input,select,textarea')) return;
      const c = this.cmd;
      switch (e.key) {
        case ' ': case 'k': c.toggle(); break;
        case 'ArrowLeft': c.seekBy(-10); break;
        case 'ArrowRight': c.seekBy(10); break;
        case 'ArrowUp': c.setVolume(this.media.volume + 0.1); break;
        case 'ArrowDown': c.setVolume(this.media.volume - 0.1); break;
        case 'm': c.toggleMute(); break;
        case 'f': c.toggleFullscreen(); break;
        case 'c': if (this.s.textTracks.length) c.setTextTrack(this.s.textTrack ? null : this.s.textTracks[0].id); break;
        case 'D': if (!e.shiftKey || e.metaKey || e.ctrlKey || this.o.debug === false) return; this.showStats(); break;
        default: return;
      }
      e.preventDefault();
    };
    this.root.addEventListener('keydown', key);
    this.offs.push(() => this.root.removeEventListener('keydown', key));
  }

  // ----------------------------------------------------------------- casting
  private setupCasting() {
    if (this.o.cast === false) return;
    const c = new Caster(typeof this.o.cast === 'object' ? this.o.cast.receiverAppId : undefined);
    this.caster = c;
    c.onChange = (st) => { this.set({ cast: { ...st } }); this.emit('castchange', st); };
    c.onRemote = () => this.set({ playing: c.remote.playing, status: c.remote.playing ? 'playing' : 'paused' });
    c.onEnd = (t) => {
      // Back on this device, from where the TV was (VOD), or at the live edge.
      if (!this.s.live && t != null) { try { this.media.currentTime = t; } catch { /* */ } }
      this.cmd.play();
    };
    void c.init();
  }

  private async castCurrent() {
    const c = this.caster;
    const it = this.s.item;
    if (!c || !it || !this.url) return;
    this.media.pause();
    await c.load({
      url: this.url, contentType: contentTypeFor(this.kind), title: it.title ?? null, subtitle: it.subtitle ?? this.s.programme?.title ?? null,
      artworkUrl: it.artworkUrl ?? null, live: this.s.live, currentTime: this.media.currentTime,
    });
  }

  // ---------------------------------------------------------------- commands
  private t(k: string, v?: Record<string, string | number>) { return format(this.o.strings?.[k] ?? STRINGS[k] ?? k, v); }

  private cmd: Commands = {
    play: () => {
      if (this.o.demo) { this.set({ playing: true, status: 'playing' }); return; }
      if (this.caster?.connected) { if (!this.caster.remote.playing) this.caster.playPause(); return; }
      if (this.s.status === 'offline' || (this.s.status === 'error' && this.s.item)) { void this.load(Math.max(0, this.s.index), true); return; }
      if (this.s.live && this.s.status === 'paused' && this.s.seekable && this.media.currentTime < this.s.seekable.start) this.engine.goLive();
      this.attempt?.playRequested();
      const p = this.media.play();
      p?.catch?.((e: any) => {
        if (e?.name === 'NotAllowedError') {
          // Autoplay with sound refused: try muted, which browsers allow, and show the unmute control.
          if (!this.media.muted && this.o.autoplay) { this.media.muted = true; this.media.play().catch(() => { this.attempt?.waitForViewer(); this.set({ playing: false, status: 'ready' }); }); return; }
          this.attempt?.waitForViewer();
          this.set({ playing: false, status: 'ready' });
        } else if (e?.name !== 'AbortError') this.fail(readableError(e), e?.name ?? null);
      });
    },
    pause: () => { if (this.o.demo) { this.set({ playing: false, status: 'paused' }); return; } if (this.caster?.connected) { if (this.caster.remote.playing) this.caster.playPause(); return; } this.media.pause(); },
    toggle: () => (this.s.playing ? this.cmd.pause() : this.cmd.play()),
    seek: (t) => {
      const r = this.s.seekable;
      const lo = r ? r.start : 0, hi = r ? r.end : (Number.isFinite(this.media.duration) ? this.media.duration : t);
      const v = Math.min(Math.max(t, lo), hi);
      if (this.caster?.connected) this.caster.seek(v); else this.media.currentTime = v;
      this.derive();
    },
    seekBy: (d) => this.cmd.seek((this.caster?.connected ? this.caster.remote.currentTime : this.media.currentTime) + d),
    goLive: () => { this.engine.goLive(); if (this.media.paused) this.cmd.play(); this.derive(); },
    startOver: () => {
      const p = this.s.programme;
      const e = this.engine.snapshot();
      if (!p) return;
      const r = startOverTarget(p.startsAt, e.presentationStart, e.seekable);
      if (!r) return;
      this.media.currentTime = r.seconds;
      if (this.media.paused) this.cmd.play();
      this.derive();
    },
    setQuality: (id) => this.engine.setQuality(id),
    setTextTrack: (id) => {
      this.engine.setTextTrack(id);
      const lang = id ? this.engine.snapshot().textTracks.find((t) => t.id === id)?.lang : null;
      store.set('textLang', lang ?? '');
    },
    setAudioTrack: (id) => this.engine.setAudioTrack(id),
    setVolume: (v) => {
      const x = Math.min(1, Math.max(0, v));
      if (this.caster?.connected) this.caster.setVolume(x);
      this.media.volume = x;
      if (x > 0 && this.media.muted) this.media.muted = false;
    },
    toggleMute: () => { this.media.muted = !this.media.muted; },
    setRate: (r) => { this.media.playbackRate = r; },
    next: () => { if (this.s.index + 1 < this.s.items.length) void this.load(this.s.index + 1, true); },
    previous: () => {
      if (this.media.currentTime > 5 && !this.s.live) { this.cmd.seek(0); return; }
      if (this.s.index > 0) void this.load(this.s.index - 1, true);
    },
    playItem: (i) => { if (i >= 0 && i < this.s.items.length) void this.load(i, true); },
    skip: () => {
      const sk = this.s.skip;
      if (!sk) return;
      // Credits at the end of a playlist item: the next item is what "skip" means.
      if (sk.kind === 'credits' && this.s.index + 1 < this.s.items.length && (!Number.isFinite(this.s.duration) || sk.to >= this.s.duration - 2)) { this.cmd.next(); return; }
      this.cmd.seek(sk.to + 0.05);
      this.set({ skip: null });
    },
    adClick: () => { this.vodAds?.click(); },
    cancelUpNext: () => {
      const g = this.s.graphics.find((x) => x.graphic === 'up-next');
      this.dismissedFor = g ? `g:${g.id}` : this.s.programme ? `p:${this.s.programme.id}` : `i:${this.s.index}`;
      this.set({ upNext: null });
    },
    toggleFullscreen: () => {
      const d = document as any;
      const el = this.root as any;
      if (d.fullscreenElement || d.webkitFullscreenElement) { (d.exitFullscreen ?? d.webkitExitFullscreen)?.call(d); return; }
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      // iPhone: only the video element can go full screen.
      else (this.media as any).webkitEnterFullscreen?.();
    },
    togglePip: () => {
      const d = document as any;
      if (d.pictureInPictureElement) { d.exitPictureInPicture?.().catch?.(() => {}); return; }
      (this.media as any).requestPictureInPicture?.().catch?.(() => {});
    },
    cast: () => {
      const c = this.caster;
      const it = this.s.item;
      if (!c || !it || !this.url) return;
      void c.toggle({ url: this.url, contentType: contentTypeFor(this.kind), title: it.title ?? null,
        subtitle: it.subtitle ?? this.s.programme?.title ?? null, artworkUrl: it.artworkUrl ?? null,
        live: this.s.live, currentTime: this.media.currentTime }).then(() => { if (c.connected) this.media.pause(); });
    },
    airplay: () => showAirPlayPicker(this.media),
    levels: () => this.levels(),
    purchase: (productKey) => {
      const p = this.s.access.products.find((x) => x.productKey === productKey) ?? null;
      const assetId = this.s.item?.assetId ?? this.o.eventId ?? null;
      this.emit('purchase', { productKey, product: p, assetId });
      if (this.o.purchaseUrl) {
        const url = fillUrl(this.o.purchaseUrl, { productKey, assetId, price: p ? (p.priceCents / 100).toFixed(2) : '', currency: p?.currency ?? '' });
        try { window.open(url, '_blank', 'noopener'); } catch { location.href = url; }
      }
    },
    signIn: () => {
      const assetId = this.s.item?.assetId ?? this.o.eventId ?? null;
      this.emit('signin', { assetId });
      if (this.o.signInUrl) {
        const url = fillUrl(this.o.signInUrl, { assetId });
        try { window.open(url, '_blank', 'noopener'); } catch { location.href = url; }
      }
    },
    playReplay: () => {
      const id = this.s.event?.replayAssetId;
      if (!id) return;
      this.set({ replaying: true });
      void this.setPlaylist([{ id, assetId: id, title: this.s.event?.title ?? null }], 0, true);
    },
    refreshAccess: () => { if (this.s.items.length) void this.load(Math.max(0, this.s.index), true); },
    toggleStats: (on) => this.showStats(on),
  };

  /**
   * Frequency data for a visualiser. Built the first time a skin asks, after
   * playback has started (an AudioContext needs a gesture). Media played
   * through Shaka is same-origin to the page, so the analyser can read it; a
   * cross-origin MP3 without CORS cannot be read and the skin falls back to
   * its idle animation (null).
   */
  private levels(): Uint8Array | null {
    if (this.analyser && this.freq) { this.analyser.getByteFrequencyData(this.freq as any); return this.freq; }
    if (!this.s.playing || !this.ownsMedia) return null;
    if (this.engine.mode === 'progressive' && isApple()) return null; // Safari silences a tapped cross-origin element
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new Ctx();
      const src = ctx.createMediaElementSource(this.media);
      const an = ctx.createAnalyser();
      an.fftSize = 128;
      an.smoothingTimeConstant = 0.78;
      src.connect(an); an.connect(ctx.destination);
      this.analyser = an;
      this.freq = new Uint8Array(an.frequencyBinCount);
      return this.freq;
    } catch { this.analyser = null; return null; }
  }
}
