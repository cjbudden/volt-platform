// ============================================================================
//  CASTING: Chromecast (Google Cast web sender) and AirPlay (Safari).
//
//  CHROMECAST. The Cast framework is Google's script, loaded only on a browser
//  that can cast (Chrome and Edge on desktop and Android) and only when the
//  player allows casting, so nobody else downloads it. The TV is sent the
//  stream's URL and plays it itself; the page becomes a remote control. That
//  is why casting needs a URL the TV can reach, and the CDN must allow the
//  receiver's origin (CORS), which Volt's delivery does.
//
//  The receiver is Google's Default Media Receiver unless the account has its
//  own (a branded receiver is registered in the Google Cast console and its app
//  id set in Player setup).
//
//  AIRPLAY. Safari's own picker. AirPlay hands the TV a URL too, so the engine
//  plays HLS natively on Apple devices (an MSE player has no URL to give).
// ============================================================================

const SENDER = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
const DEFAULT_RECEIVER = 'CC1AD845';

export interface CastMedia {
  url: string;
  contentType: string;
  title?: string | null;
  subtitle?: string | null;
  artworkUrl?: string | null;
  live: boolean;
  currentTime: number;
}

export interface CastState { available: boolean; state: 'none' | 'connecting' | 'connected'; device: string | null }

let loading: Promise<boolean> | null = null;

function canCast(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  // The sender works in Chromium browsers only (not iOS, where Chrome is WebKit).
  return !!(window as any).chrome && /Chrome|Edg/.test(ua) && !/CriOS|iPhone|iPad/.test(ua);
}

function loadFramework(): Promise<boolean> {
  if (loading) return loading;
  loading = new Promise<boolean>((ok) => {
    const w = window as any;
    if (w.cast?.framework) { ok(true); return; }
    const prev = w.__onGCastApiAvailable;
    w.__onGCastApiAvailable = (avail: boolean) => { try { prev?.(avail); } catch { /* */ } ok(!!avail); };
    const s = document.createElement('script');
    s.src = SENDER; s.async = true;
    s.onerror = () => ok(false);
    document.head.appendChild(s);
    setTimeout(() => ok(!!w.cast?.framework), 15000);
  });
  return loading;
}

export class Caster {
  state: CastState = { available: false, state: 'none', device: null };
  onChange: (s: CastState) => void = () => {};
  /** The TV's position when casting stops, so local playback can carry on from there. */
  onEnd: (remoteTime: number | null) => void = () => {};
  /** The TV's play state and position, while connected. */
  remote: { playing: boolean; currentTime: number; duration: number } = { playing: false, currentTime: 0, duration: NaN };
  onRemote: () => void = () => {};
  private ctx: any = null;
  private rp: any = null;
  private rpc: any = null;
  private receiverAppId: string;
  private lastMedia: CastMedia | null = null;

  constructor(receiverAppId?: string) { this.receiverAppId = receiverAppId || DEFAULT_RECEIVER; }

  async init(): Promise<void> {
    if (!canCast()) return;
    const ok = await loadFramework();
    const w = window as any;
    if (!ok || !w.cast?.framework || !w.chrome?.cast) return;
    const f = w.cast.framework;
    this.ctx = f.CastContext.getInstance();
    this.ctx.setOptions({ receiverApplicationId: this.receiverAppId, autoJoinPolicy: w.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED });
    this.rp = new f.RemotePlayer();
    this.rpc = new f.RemotePlayerController(this.rp);
    const push = () => this.onChange(this.state);
    const castState = () => {
      const cs = this.ctx.getCastState();
      this.state = {
        available: cs !== f.CastState.NO_DEVICES_AVAILABLE,
        state: cs === f.CastState.CONNECTED ? 'connected' : cs === f.CastState.CONNECTING ? 'connecting' : 'none',
        device: this.ctx.getCurrentSession()?.getCastDevice()?.friendlyName ?? null,
      };
      push();
    };
    this.ctx.addEventListener(f.CastContextEventType.CAST_STATE_CHANGED, castState);
    this.ctx.addEventListener(f.CastContextEventType.SESSION_STATE_CHANGED, (e: any) => {
      if (e.sessionState === f.SessionState.SESSION_ENDED || e.sessionState === f.SessionState.SESSION_ENDING) {
        this.onEnd(Number.isFinite(this.remote.currentTime) ? this.remote.currentTime : null);
      }
      castState();
    });
    this.rpc.addEventListener(f.RemotePlayerEventType.ANY_CHANGE, () => {
      this.remote = { playing: !this.rp.isPaused && this.rp.isMediaLoaded, currentTime: this.rp.currentTime, duration: this.rp.duration };
      this.onRemote();
    });
    castState();
  }

  get connected(): boolean { return this.state.state === 'connected'; }

  /** Open the device picker, then send the media. Disconnect when already casting. */
  async toggle(media: CastMedia): Promise<void> {
    if (!this.ctx) return;
    if (this.connected) { this.ctx.endCurrentSession(true); return; }
    try { await this.ctx.requestSession(); } catch { return; /* picker closed */ }
    await this.load(media);
  }

  /** Send (or re-send, on an item change) the media to the TV. */
  async load(media: CastMedia): Promise<void> {
    const w = window as any;
    const s = this.ctx?.getCurrentSession();
    if (!s) return;
    this.lastMedia = media;
    const c = w.chrome.cast.media;
    const info = new c.MediaInfo(media.url, media.contentType);
    info.streamType = media.live ? c.StreamType.LIVE : c.StreamType.BUFFERED;
    const md = new c.GenericMediaMetadata();
    md.title = media.title ?? '';
    md.subtitle = media.subtitle ?? '';
    if (media.artworkUrl) md.images = [new w.chrome.cast.Image(media.artworkUrl)];
    info.metadata = md;
    const req = new c.LoadRequest(info);
    req.autoplay = true;
    if (!media.live) req.currentTime = media.currentTime;
    try { await s.loadMedia(req); } catch (e) { console.warn('[volt-player] cast load failed', e); }
  }

  playPause(): void { this.rpc?.playOrPause(); }
  seek(t: number): void { if (this.rp) { this.rp.currentTime = t; this.rpc.seek(); } }
  setVolume(v: number): void { if (this.rp) { this.rp.volumeLevel = v; this.rpc.setVolumeLevel(); } }
  get media(): CastMedia | null { return this.lastMedia; }
}

/** AirPlay availability and state, for Safari. */
export function watchAirPlay(media: HTMLVideoElement, onChange: (s: { available: boolean; active: boolean }) => void): () => void {
  const m = media as any;
  if (typeof window === 'undefined' || !(window as any).WebKitPlaybackTargetAvailabilityEvent) return () => {};
  media.setAttribute('x-webkit-airplay', 'allow');
  let available = false;
  const avail = (e: any) => { available = e.availability === 'available'; onChange({ available, active: !!m.webkitCurrentPlaybackTargetIsWireless }); };
  const wireless = () => onChange({ available, active: !!m.webkitCurrentPlaybackTargetIsWireless });
  media.addEventListener('webkitplaybacktargetavailabilitychanged', avail);
  media.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', wireless);
  return () => {
    media.removeEventListener('webkitplaybacktargetavailabilitychanged', avail);
    media.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', wireless);
  };
}

export function showAirPlayPicker(media: HTMLVideoElement): void {
  try { (media as any).webkitShowPlaybackTargetPicker?.(); } catch { /* */ }
}

export function contentTypeFor(kind: string): string {
  return kind === 'hls' ? 'application/x-mpegurl' : kind === 'dash' ? 'application/dash+xml' : kind === 'mp3' ? 'audio/mpeg' : 'video/mp4';
}
