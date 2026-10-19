// ============================================================================
//  THE PLAYER CORE.
//
//  Session, source selection, Shaka, state, polling, reporting. Everything
//  except what it looks like.
//
//  ------------------------------------------------------------------------
//  MP3 IS TRIED FIRST, AND THAT IS NOT LAZINESS.
//
//  Shaka needs Media Source Extensions. MP3 over HTTP needs an <audio> element
//  and nothing else, so it plays where MSE is unavailable or restricted, it
//  starts in one request rather than manifest-then-segment, and it is what a
//  radio embed actually wants: continuous audio with no adaptive ladder to
//  adapt to. HLS and DASH are the fallbacks, not the other way round.
//
//  All three URLs arrive in the session response, so a failure moves to the
//  next without another round trip to the control plane — which matters
//  because the usual cause is a corporate proxy that blocks one of them, and
//  in that situation extra requests are exactly what will not get through.
//
//  ------------------------------------------------------------------------
//  AUTOPLAY IS A REQUEST, NOT A SETTING.
//
//  Browsers refuse to start audio without a gesture, and the refusal arrives
//  as a rejected promise that looks identical to a real playback failure. It
//  is caught and reported separately so an embedder debugging "it will not
//  play" is not sent looking at their stream. The player shows its play button
//  and waits, which is the correct outcome rather than a fallback.
//
//  ------------------------------------------------------------------------
//  THE LAYOUT NEVER TOUCHES THE TRANSPORT. It gets state and commands. A skin
//  someone else wrote can render badly; it cannot break playback, reach the
//  session, or see the key.
// ============================================================================
import shaka from 'shaka-player/dist/shaka-player.compiled';
import type {
  VoltPlayerOptions, SessionResponse, NowPlaying, Layout, LayoutState, PlayerConfig,
  Presentation,
} from './types';
import { Reporter, newSessionId } from './report';
import { pickLayout } from './layouts';

type Kind = 'mp3' | 'hls' | 'dash';

/** Which sources to try, in order, given the preference and what exists. */
export function sourceOrder(
  sources: { mp3: string | null; hls: string; dash: string },
  preferred: VoltPlayerOptions['preferred'] = 'auto',
): Array<{ kind: Kind; url: string }> {
  const all: Array<{ kind: Kind; url: string | null }> = [
    { kind: 'mp3', url: sources.mp3 },
    { kind: 'hls', url: sources.hls },
    { kind: 'dash', url: sources.dash },
  ];
  const present = all.filter((s): s is { kind: Kind; url: string } => !!s.url);
  if (preferred === 'auto') return present;
  // An explicit preference goes first but does NOT remove the others: an
  // embedder who prefers DASH still wants sound when DASH is blocked, and a
  // player that refuses to fall back would be a worse player for the sake of
  // honouring a hint.
  const first = present.filter((s) => s.kind === preferred);
  return [...first, ...present.filter((s) => s.kind !== preferred)];
}

/** Turn a Shaka or media error into something a person can act on. */
export function readableError(e: any): string {
  const code = e?.code ?? e?.detail?.code;
  if (code === 1001 || code === 1002) return 'The stream could not be reached.';
  if (code === 4032 || code === 4001) return 'This browser cannot play this stream format.';
  if (code === 3016 || code === 3015) return 'The audio could not be decoded.';
  if (e?.name === 'NotAllowedError') return 'The browser blocked playback until you press play.';
  return e?.message ? String(e.message) : 'Playback failed.';
}

export class VoltPlayerCore {
  private root!: HTMLElement;
  private audio!: HTMLAudioElement;
  private shakaPlayer: any = null;
  private session: SessionResponse | null = null;
  private layout: Layout | null = null;
  private reporter!: Reporter;
  private sessionId = newSessionId();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  private state: LayoutState = {
    playing: false, loading: true, error: null, nowPlaying: null,
    // A STATION IS ALWAYS 'live'. The phase only varies for an event, so this
    // default is what lets every audio layout ignore the field completely.
    presentation: 'live', event: null, msToStart: null, hasPicture: false,
  };

  /**
   * The countdown ticker.
   *
   * ONE clock, in the core, rather than each layout running its own. Two
   * layouts on a page with independent timers drift apart visibly, and a
   * setInterval inside a layout outlives a layout swap unless every author
   * remembers to clear it. The core already owns a lifecycle; this belongs to
   * it.
   */
  private tick: ReturnType<typeof setInterval> | null = null;

  // Declared and assigned rather than a constructor parameter property: the
  // build runs with `erasableSyntaxOnly`, which rejects the shorthand because
  // it is TypeScript that EMITS code rather than TypeScript that is erased.
  private opts: VoltPlayerOptions;
  constructor(opts: VoltPlayerOptions) { this.opts = opts; }

  private apiBase(): string {
    if (this.opts.apiBase) return this.opts.apiBase.replace(/\/$/, '');
    // The origin the bundle itself was served from. Right for every ordinary
    // embed, and the reason an embedder needs one script tag and no config.
    try {
      const src = (document.currentScript as HTMLScriptElement | null)?.src;
      if (src) return new URL(src).origin;
    } catch { /* fall through */ }
    return window.location.origin;
  }

  async init(): Promise<void> {
    const el = typeof this.opts.el === 'string'
      ? document.querySelector<HTMLElement>(this.opts.el)
      : this.opts.el;
    if (!el) throw new Error(`volt-player: no element matched ${String(this.opts.el)}`);
    this.root = el;

    this.audio = document.createElement('audio');
    // No `controls`: the layout provides them. `preload=none` because a radio
    // embed that is never pressed must not pull a stream — a station page with
    // six players would otherwise open six connections on load and bill the
    // egress for all of them.
    this.audio.preload = 'none';
    this.audio.crossOrigin = 'anonymous';
    this.audio.style.display = 'none';
    this.root.appendChild(this.audio);

    let cfg: PlayerConfig;
    try {
      this.session = await this.openSession();
      cfg = { ...this.session.config, ...(this.opts.config ?? {}) } as PlayerConfig;
      if (this.opts.handoff?.(this.session, cfg)) {
        this.audio.remove();
        this.destroyed = true;
        return;
      }
    } catch (e: any) {
      // A failed handshake is the one error that must render, because it is
      // the one an embedder will hit while setting up: a wrong key, or a domain
      // that is not on the allow-list. Reported before the reporter exists, so
      // it goes to the console and the caller's hook only.
      this.state = { ...this.state, loading: false, error: humanSessionError(e) };
      this.mountLayout({ ...defaultConfig(), ...(this.opts.config ?? {}) } as PlayerConfig);
      this.render();
      try { this.opts.onEvent?.({ event: 'error', at: Date.now(), detail: { stage: 'session', message: String(e?.message ?? e) } }); } catch { /* */ }
      return;
    }

    this.reporter = new Reporter({
      url: this.session.report.url,
      appKey: this.opts.appKey,
      channelId: this.opts.channelId,
      sessionId: this.sessionId,
      layout: cfg.layout,
      onEvent: this.opts.onEvent,
    });
    this.reporter.emit('player.load', { preferred: this.opts.preferred ?? 'auto' });

    // THE EVENT, IF THERE IS ONE. Taken from the session before the layout
    // mounts, so a stage layout builds against the right phase first time
    // rather than flashing a live frame and correcting itself a tick later.
    this.state = {
      ...this.state,
      event: this.session.event ?? null,
      presentation: this.session.presentation ?? 'live',
      msToStart: msUntil(this.session.event?.startsAt),
    };

    this.mountLayout(cfg);
    this.wireMedia();
    if (this.state.event) this.startTicking();
    await this.attachSource();
    await this.refreshNowPlaying();
    this.startPolling();

    if (this.opts.autoplay) this.play();
  }

  private async openSession(): Promise<SessionResponse> {
    const res = await fetch(`${this.apiBase()}/api/player/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({ appKey: this.opts.appKey, channelId: this.opts.channelId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(text || `session ${res.status}`), { status: res.status });
    }
    return res.json();
  }

  private mountLayout(cfg: PlayerConfig): void {
    this.layout = pickLayout(cfg.layout);
    this.layout.mount({
      root: this.root,
      config: cfg,
      station: this.session?.station ?? {
        id: this.opts.channelId, name: cfg.fallbackTitle ?? 'Radio',
        description: cfg.fallbackText, artworkUrl: cfg.fallbackArtworkUrl, onAir: false,
      },
      play: () => this.play(),
      pause: () => this.pause(),
      toggle: () => (this.state.playing ? this.pause() : this.play()),
      setVolume: (v) => { this.audio.volume = Math.min(1, Math.max(0, v)); },
      getVolume: () => this.audio.volume,
      openReplay: () => this.openReplay(),
      media: this.audio,
    });
  }

  private wireMedia(): void {
    const set = (patch: Partial<LayoutState>) => { this.state = { ...this.state, ...patch }; this.render(); };
    this.audio.addEventListener('playing', () => { set({ playing: true, loading: false, error: null }); this.reporter.emit('play'); });
    this.audio.addEventListener('pause', () => { set({ playing: false }); this.reporter.emit('pause'); });
    this.audio.addEventListener('waiting', () => { set({ loading: true }); this.reporter.emit('stall'); });
    this.audio.addEventListener('canplay', () => set({ loading: false }));
    // IS THERE A PICTURE? Asked of the element rather than assumed from the
    // event type, because "this is a video event" and "video is decoding right
    // now" are different claims and the poster must be lifted only by the
    // second. videoWidth is 0 until the first frame is decoded, which is
    // exactly the moment the poster should go.
    const picture = () => {
      const v = this.audio as unknown as HTMLVideoElement;
      const has = typeof v.videoWidth === 'number' && v.videoWidth > 0;
      if (has !== this.state.hasPicture) set({ hasPicture: has });
    };
    this.audio.addEventListener('loadeddata', picture);
    this.audio.addEventListener('resize', picture);
    this.audio.addEventListener('playing', picture);
    this.audio.addEventListener('error', () => {
      const err = this.audio.error;
      set({ loading: false, error: 'The stream stopped unexpectedly.' });
      this.reporter.emit('error', { stage: 'media', code: err?.code ?? null });
    });
  }

  /**
   * Attach the first source that works.
   *
   * Tried in order, each failure reported with the kind that failed, so a
   * support question can be answered from the telemetry alone: "MP3 fails and
   * HLS succeeds on that origin" is a proxy, and "all three fail" is the
   * station being off air.
   */
  private async attachSource(): Promise<void> {
    if (!this.session) return;
    const order = sourceOrder(this.session.sources, this.opts.preferred);
    for (const src of order) {
      try {
        if (src.kind === 'mp3') {
          await this.teardownShaka();
          this.audio.src = src.url;
        } else {
          if (!shaka.Player.isBrowserSupported()) throw new Error('Media Source Extensions unavailable');
          await this.teardownShaka();
          this.shakaPlayer = new shaka.Player();
          await this.shakaPlayer.attach(this.audio);
          this.shakaPlayer.addEventListener('error', (ev: any) => {
            this.state = { ...this.state, error: readableError(ev?.detail) };
            this.render();
            this.reporter.emit('error', { stage: 'shaka', code: ev?.detail?.code ?? null, kind: src.kind });
          });
          await this.shakaPlayer.load(src.url);
        }
        this.reporter.emit('manifest.ok', { kind: src.kind });
        this.reporter.emit('player.ready', { kind: src.kind });
        this.state = { ...this.state, loading: false, error: null };
        this.render();
        return;
      } catch (e: any) {
        this.reporter.emit('manifest.error', { kind: src.kind, message: String(e?.message ?? e) });
      }
    }
    this.state = { ...this.state, loading: false, error: 'This station is not available right now.' };
    this.render();
    this.reporter.emit('error', { stage: 'sources', message: 'every source failed' });
  }

  private async teardownShaka(): Promise<void> {
    if (!this.shakaPlayer) return;
    try { await this.shakaPlayer.destroy(); } catch { /* already gone */ }
    this.shakaPlayer = null;
  }

  play(): void {
    const p = this.audio.play();
    // play() returns a promise in every browser that matters, and its rejection
    // is how autoplay refusal arrives. Untangling that from a genuine failure
    // is the difference between "press play" and a support ticket.
    if (p && typeof p.catch === 'function') {
      p.catch((e: any) => {
        const blocked = e?.name === 'NotAllowedError';
        this.state = { ...this.state, playing: false, loading: false, error: blocked ? null : readableError(e) };
        this.render();
        this.reporter?.emit('error', { stage: blocked ? 'autoplay-blocked' : 'play', message: String(e?.name ?? e) });
      });
    }
  }

  pause(): void { try { this.audio.pause(); } catch { /* */ } }

  /**
   * Send the viewer to the replay, and report that they went.
   *
   * A COMMAND rather than a link the layout owns, so the click is measurable.
   * "How many people who arrived after it ended went on to watch the replay" is
   * the question a promoter actually asks, and it cannot be answered from an
   * anchor tag inside a third-party skin.
   *
   * `noopener` is not decoration. The replay may sit on a domain the embedder
   * does not control, and without it that page gets a handle on the opener.
   */
  private openReplay(): void {
    const url = this.state.event?.replayUrl;
    if (!url) return;
    this.reporter?.emit('play', { via: 'replay' });
    try { window.open(url, '_blank', 'noopener,noreferrer'); }
    catch { window.location.href = url; }
  }

  /**
   * Recompute the countdown once a second, and cross the start line.
   *
   * THE PHASE IS NOT RECOMPUTED FROM THE CLOCK, with one narrow exception.
   * Whether an event is live, postponed or cancelled is a decision the control
   * plane makes and the client must not second-guess: a scheduled start passing
   * does not mean anything actually started, and a player that promoted itself
   * to `live` on its own clock would show a live badge over a black screen for
   * every event that begins ten minutes late.
   *
   * The exception is the countdown reaching zero, which stops the layout
   * displaying a negative timer. It does not claim the event started; the next
   * session poll supplies the truth.
   */
  private startTicking(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = setInterval(() => {
      if (this.destroyed) return;
      const ms = msUntil(this.state.event?.startsAt);
      if (ms === this.state.msToStart) return;
      this.state = { ...this.state, msToStart: ms };
      this.render();
    }, 1000);
  }

  /** Adopt a phase the control plane reported. */
  setPresentation(p: Presentation): void {
    if (p === this.state.presentation) return;
    this.state = { ...this.state, presentation: p };
    this.render();
  }

  /** Poll now-playing. Slow, because a track lasts minutes, not seconds. */
  private startPolling(): void {
    const ms = Number((this.session?.config.options as any)?.pollSeconds ?? 20) * 1000;
    this.pollTimer = setInterval(() => { void this.refreshNowPlaying(); }, Math.max(10000, ms));
  }

  private async refreshNowPlaying(): Promise<void> {
    if (this.destroyed) return;
    try {
      const res = await fetch(`${this.apiBase()}/api/player/now-playing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({ appKey: this.opts.appKey, channelId: this.opts.channelId }),
      });
      if (!res.ok) return;
      const np: NowPlaying = await res.json();
      this.state = { ...this.state, nowPlaying: np };
      this.render();
    } catch {
      // A failed poll leaves whatever was last on screen. Blanking the card
      // because one request timed out would make a working player flicker.
    }
  }

  private render(): void { try { this.layout?.update(this.state); } catch (e) { console.warn('[volt-player] layout threw', e); } }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tick) clearInterval(this.tick);
    this.reporter?.emit('stop');
    this.reporter?.close();
    await this.teardownShaka();
    try { this.layout?.destroy?.(); } catch { /* */ }
    try { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); } catch { /* */ }
  }
}

/**
 * Milliseconds until an instant, or null when the question does not apply.
 *
 * NULL RATHER THAN A NEGATIVE NUMBER once the moment has passed, because those
 * are different facts and a layout that has to remember to test the sign of a
 * countdown will eventually forget. Null means "do not show a countdown", and
 * it is also the answer for an event with no start time at all.
 */
export function msUntil(at: number | null | undefined): number | null {
  if (at == null || !Number.isFinite(at)) return null;
  const ms = at - Date.now();
  return ms > 0 ? ms : null;
}

function defaultConfig(): PlayerConfig {
  return {
    layout: 'card', primaryColor: '#3f7bff', secondaryColor: '#0f1218',
    options: {}, fallbackTitle: null, fallbackText: null, fallbackArtworkUrl: null,
  };
}

/**
 * Session errors, in the words of the person who will read them.
 *
 * These land in front of a developer pasting an embed onto a page, so they say
 * what to change. "403" would send them to their key when the problem is their
 * domain.
 */
export function humanSessionError(e: any): string {
  const status = e?.status;
  const msg = String(e?.message ?? '');
  if (status === 401) return 'This player key is not valid. Check the publishable key (pk_…) in the embed.';
  if (status === 403) {
    return /allow-list|origin/i.test(msg)
      ? 'This site is not on the app\'s allowed origins. Add its domain in API Keys & Apps.'
      : 'This player is not allowed on this site.';
  }
  if (status === 404) return 'That station was not found for this key.';
  return 'The player could not start.';
}
