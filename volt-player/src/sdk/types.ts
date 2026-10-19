// ============================================================================
//  THE VOLT PLAYER SDK CONTRACT.
//
//  One shape for every platform. The web SDK implements it here; the native
//  SDKs (iOS/iPadOS/tvOS, Android/Android TV/Fire TV, Roku, Tizen/webOS) expose
//  the same state fields, the same commands and the same theme tokens, so a
//  skin designed once in the console renders the same way everywhere and a
//  support answer is the same on every device. docs/PLAYER_SDK.md is the
//  readable version of this file.
//
//  THREE LAYERS, AND WHO OWNS EACH.
//
//    engine    plays the media (Shaka, or the browser's own HLS on Safari):
//              sources, tracks, live window, errors. Ours.
//    player    everything around playback that is not drawing: playlists,
//              EPG, up next, casting, beacons. Ours.
//    skin      what it looks like. Ours for the built-in skins, the client's
//              for a custom one. A skin gets STATE and COMMANDS, never the
//              engine: it can render badly, it cannot break playback.
// ============================================================================

/** Where to play from. Any one is enough; the engine picks the best it can play. */
export interface Source {
  hls?: string | null;
  dash?: string | null;
  /** Progressive audio (radio). Plays with no Media Source Extensions at all. */
  mp3?: string | null;
  /** Anything else: a progressive MP4, or a manifest whose kind is guessed from the URL. */
  url?: string | null;
}

/** One thing in a playlist: a URL, an asset id (resolved through the play gate), or both. */
export interface PlaylistItem {
  id: string;
  title?: string | null;
  subtitle?: string | null;
  description?: string | null;
  artworkUrl?: string | null;
  source?: Source | null;
  /** A Volt asset (channel, event, VOD). Resolved when the item comes up, so tokens are fresh. */
  assetId?: string | null;
  /** Known up front for an EPG-shaped playlist; otherwise learned from the media. */
  durationMs?: number | null;
  startsAt?: number | null;
  endsAt?: number | null;
  live?: boolean;
  /** The playback token for beacons when the caller already has one (share page). */
  playbackToken?: string | null;
  meta?: Record<string, unknown>;
}

/** A programme in a channel's guide. Instants are epoch ms, formatted at the last moment. */
export interface Programme {
  id: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  startsAt: number;
  endsAt: number;
}

/** A track on an audio service: what is playing, what played, what is next. */
export interface TrackInfo {
  title: string;
  artist?: string | null;
  album?: string | null;
  year?: number | null;
  artworkUrl?: string | null;
  startedAt?: number | null;
}

export interface Quality {
  id: string;
  height: number | null;
  width: number | null;
  /** Bits per second, as the manifest declares it. */
  bitrate: number;
  /** "1080p", "720p", or "128 kbps" for an audio-only ladder. */
  label: string;
}

export interface TextTrackInfo { id: string; lang: string; label: string; kind: string }
export interface AudioTrackInfo { id: string; lang: string; label: string; channels: number | null }

export type PlayerStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error' | 'offline' | 'locked';

/** Which part of its life an event is in. Decided by the control plane, never by the player's clock. */
export type Presentation = 'pre' | 'live' | 'ended' | 'replay' | 'offline' | 'postponed' | 'cancelled';

export interface PromoSide { name: string; imageUrl?: string | null; subtitle?: string | null }
export interface EventPromo {
  template: 'plain' | 'versus' | 'billing' | 'people' | 'field';
  headline?: string | null;
  subhead?: string | null;
  posterUrl?: string | null;
  posterFit?: 'cover' | 'contain';
  sides?: PromoSide[];
  separator?: string | null;
}

/** An event as the event skin shows it (GET /api/player/event). Instants are epoch ms. */
export interface EventInfo {
  id: string;
  title: string;
  description?: string | null;
  startsAt: number | null;
  endsAt: number | null;
  /** The start it was moved from, so a postponement can say "was 19:30". */
  previousStartsAt?: number | null;
  presentation: Presentation;
  preMessage?: string | null;
  endedMessage?: string | null;
  promo?: EventPromo | null;
  replayAssetId?: string | null;
}

/** Something a viewer can buy to watch (the play gate's paywall answer). */
export interface Product {
  productKey: string;
  name?: string | null;
  kind: 'period' | 'published_dates';
  count?: number;
  unit?: 'day' | 'week' | 'month' | 'year';
  priceCents: number;
  currency: string;
}

/** Why the viewer cannot watch yet, and what would let them. */
export interface AccessState {
  mode: 'paywall' | 'sign_in' | 'blocked' | null;
  message: string | null;
  products: Product[];
}

export interface UpNext {
  kind: 'item' | 'programme';
  title: string;
  subtitle?: string | null;
  artworkUrl?: string | null;
  /** Milliseconds until it starts (a programme) or until auto-advance (an item). */
  inMs: number;
  /** An item will play by itself when the countdown ends; a programme simply starts on the channel. */
  autoAdvance: boolean;
  /** The countdown length, so a skin can draw progress (inMs / totalMs). */
  totalMs: number;
}

/**
 * A graphic the stream asked for, from an in-stream trigger (EXT-X-DATERANGE or
 * a DASH EventStream; see sdk/triggers.ts). Times are media times, the clock of
 * `currentTime`.
 */
export interface StreamGraphic {
  id: string;
  /** 'up-next', 'programme', 'ad', or any graphic a later server sends. */
  graphic: string;
  start: number;
  /** Null when open-ended. */
  end: number | null;
  /** The trigger's data, keys lower case: title, subtitle, image, starts... */
  data: Record<string, string>;
}

export interface PlayerState {
  status: PlayerStatus;
  playing: boolean;
  buffering: boolean;
  /** Readable, already: shown to the viewer as it is. */
  error: string | null;
  errorCode: string | number | null;

  currentTime: number;
  /** Seconds; NaN for live. */
  duration: number;
  live: boolean;
  /** The seekable window in seconds. For live with DVR it is the timeshift buffer. */
  seekable: { start: number; end: number } | null;
  /** True when the window is long enough to be worth showing a scrubber on live. */
  dvr: boolean;
  atLiveEdge: boolean;
  /** Seconds behind the live edge. */
  behindLive: number;
  /** The wall-clock instant of the playhead (epoch ms), when the stream carries one. */
  wallClock: number | null;

  /** EPG: the programme at the playhead, and the one after. */
  programme: Programme | null;
  nextProgramme: Programme | null;
  schedule: Programme[];
  /** The current programme's start is inside the DVR window, so Start over works. */
  canStartOver: boolean;

  volume: number;
  muted: boolean;
  rate: number;

  qualities: Quality[];
  /** 'auto', or the id of a pinned quality. */
  quality: string;
  /** What is actually playing right now (auto picks this). */
  activeQuality: Quality | null;
  textTracks: TextTrackInfo[];
  /** null = subtitles off. */
  textTrack: string | null;
  audioTracks: AudioTrackInfo[];
  audioTrack: string | null;

  items: PlaylistItem[];
  index: number;
  item: PlaylistItem | null;
  upNext: UpNext | null;
  /** In-stream graphics on screen now. Empty unless graphics are on (theme.showGraphics / options.showGraphics). */
  graphics: StreamGraphic[];

  /** Audio services. */
  nowPlaying: TrackInfo | null;
  history: TrackInfo[];
  nextTrack: TrackInfo | null;

  cast: { available: boolean; state: 'none' | 'connecting' | 'connected'; device: string | null };
  airplay: { available: boolean; active: boolean };
  fullscreen: boolean;
  pip: { available: boolean; active: boolean };
  /** A decoded picture exists; audio-only streams never set it. */
  hasPicture: boolean;
  /** The stream has no video at all. */
  audioOnly: boolean;

  /** Events: the event, its phase, the countdown, and access (paywall / sign in). */
  event: EventInfo | null;
  presentation: Presentation | null;
  /** Milliseconds until the start, or null when there is nothing to count down to. */
  msToStart: number | null;
  access: AccessState;
  /** Playing the event's published replay rather than the live stream. */
  replaying: boolean;
}

/** Everything a skin may ask the player to do. */
export interface Commands {
  play(): void;
  pause(): void;
  toggle(): void;
  seek(seconds: number): void;
  seekBy(delta: number): void;
  goLive(): void;
  /** Back to the start of the current programme (EPG) when the DVR window reaches it. */
  startOver(): void;
  setQuality(id: string | 'auto'): void;
  setTextTrack(id: string | null): void;
  setAudioTrack(id: string): void;
  setVolume(v: number): void;
  toggleMute(): void;
  setRate(r: number): void;
  next(): void;
  previous(): void;
  playItem(index: number): void;
  /** Dismiss the up-next card for this item (and cancel its auto-advance). */
  cancelUpNext(): void;
  toggleFullscreen(): void;
  togglePip(): void;
  /** Open the Chromecast device picker, or stop casting when connected. */
  cast(): void;
  /** Open the AirPlay picker (Safari). */
  airplay(): void;
  /** Frequency data for a visualiser, 0..255 per bin. null until audio has played. */
  levels(): Uint8Array | null;
  /** Buy a product (the paywall): opens the purchase page, or hands it to the host page. */
  purchase(productKey: string): void;
  /** Sign in (members-only): opens the sign-in page, or hands it to the host page. */
  signIn(): void;
  /** Play the event's published replay. */
  playReplay(): void;
  /** Ask the play gate again (after a purchase or sign-in). */
  refreshAccess(): void;
}

/** Which controls a skin shows. A skin honours what applies to it and ignores the rest. */
export interface ControlToggles {
  title: boolean;
  seekButtons: boolean;
  volume: boolean;
  quality: boolean;
  subtitles: boolean;
  audioTracks: boolean;
  speed: boolean;
  pip: boolean;
  fullscreen: boolean;
  cast: boolean;
  airplay: boolean;
  startOver: boolean;
  schedule: boolean;
  upNext: boolean;
  history: boolean;
}

/**
 * THE THEME: the no-code half of a custom skin. Saved in the console (Player
 * setup), applied as CSS custom properties on the player box, read the same way
 * by every built-in skin and by the native SDKs.
 */
export interface Theme {
  primary: string;
  secondary: string;
  /** Player chrome background; defaults from secondary. */
  background?: string | null;
  /** Text on the chrome; defaults to black or white for contrast. */
  text?: string | null;
  /** Corner radius in px. */
  radius?: number;
  font?: string | null;
  logoUrl?: string | null;
  logoPosition?: 'top-left' | 'top-right' | 'bottom-right' | 'none';
  /** Seconds before the end that the up-next card appears. */
  upNextSeconds?: number;
  /**
   * Draw graphics the STREAM asks for (in-stream triggers: Up next and whatever
   * follows). The triggers are always in the manifest; this decides whether this
   * player acts on them. Default on.
   */
  showGraphics?: boolean;
  autoAdvance?: boolean;
  controls?: Partial<ControlToggles>;
}

export interface ResolvedTheme extends Required<Omit<Theme, 'controls' | 'logoUrl' | 'background' | 'text' | 'font'>> {
  background: string;
  text: string;
  font: string;
  logoUrl: string | null;
  primaryInk: string;
  secondaryInk: string;
  muted: string;
  controls: ControlToggles;
}

/** What a skin is handed when it mounts. */
export interface SkinContext {
  /** The skin's box. Fill it. */
  root: HTMLElement;
  /** Where the picture is. The skin places this element; it never touches what is inside it. */
  stage: HTMLElement;
  theme: ResolvedTheme;
  commands: Commands;
  /** Small strings, so a client can translate a built-in skin without forking it. */
  t(key: string, vars?: Record<string, string | number>): string;
}

export interface Skin {
  mount(ctx: SkinContext): void;
  /** Every state change. Must be cheap: diff, do not rebuild. */
  update(state: PlayerState): void;
  /** The theme changed (the console's live preview). Optional: CSS variables already updated. */
  themeChanged?(theme: ResolvedTheme): void;
  destroy?(): void;
}

export type SkinFactory = () => Skin;

export type PlayerEventName =
  | 'state' | 'ready' | 'play' | 'pause' | 'ended' | 'error'
  | 'itemchange' | 'programmechange' | 'upnext' | 'qualitychange' | 'castchange'
  | 'presentationchange' | 'purchase' | 'signin' | 'locked' | 'graphic';

export interface VoltPlayerSdkOptions {
  el: string | HTMLElement;
  /** A built-in skin name or a registered one, or a factory. Default 'video'. */
  skin?: string | SkinFactory;
  theme?: Partial<Theme>;
  /** Control plane origin; defaults to where the bundle was served from. */
  apiBase?: string;
  /** Publishable key: needed for asset ids, EPG and now-playing. */
  appKey?: string;

  /** One thing to play. */
  source?: Source;
  item?: PlaylistItem;
  /** A playlist: items, or asset ids, or plain URLs. */
  playlist?: Array<PlaylistItem | string>;
  /** Start at this index of the playlist. */
  startIndex?: number;
  /** Shortcut: play this asset id (channel, event or VOD) through the play gate. */
  assetId?: string;
  /** The guide for a live channel: fetched with the key, or given directly. */
  epg?: { channelId: string } | Programme[];
  /** Radio: poll now-playing and the last five tracks for this station. */
  stationId?: string;

  autoplay?: boolean;
  muted?: boolean;
  poster?: string | null;
  /** Diagonal text over the picture (share links). */
  watermark?: string | null;
  /** Start position in seconds for VOD. */
  startAt?: number;
  /** Extra request headers for manifests and segments (the console's own /api playlists). */
  requestHeaders?: (url: string) => Record<string, string> | null;

  /** Viewer beacons for Analytics. On when the item has a playback token. */
  beacons?: boolean | { url?: string; prefix?: string };
  cast?: false | { receiverAppId?: string };
  airplay?: boolean;
  /** Use a media element the caller owns (the console's recording page). */
  media?: HTMLVideoElement;
  /** Strings, for translation. */
  strings?: Record<string, string>;
  /** Override the saved player setup: act on in-stream graphic triggers or not. */
  showGraphics?: boolean;
  /**
   * DEMO: render this state and play nothing. For a skin preview (the
   * console's Player setup) and for a skin author's test page: every built-in
   * and custom skin can be drawn in any state without a stream.
   */
  demo?: Partial<PlayerState>;

  /** An event: its countdown, phases, promo and replay (the `event` skin). Also plays it unless a playlist is given. */
  eventId?: string;
  /**
   * The signed-in viewer (a Volt viewer session token from /api/public/auth),
   * sent to the play gate so purchases and memberships unlock. Change it later
   * with player.setViewerToken().
   */
  viewerToken?: string | null;
  /**
   * Where Buy goes. {productKey}, {assetId}, {price} and {currency} are filled
   * in. Without it the player emits a `purchase` event for the host page to
   * run its own checkout, then calls player.refreshAccess().
   */
  purchaseUrl?: string | null;
  /** Where Sign in goes ({assetId} filled in). Without it a `signin` event is emitted. */
  signInUrl?: string | null;
  onEvent?: (name: PlayerEventName, detail?: unknown) => void;
}
