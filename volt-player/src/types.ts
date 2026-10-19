// ============================================================================
//  The contract between the embed, the control plane and a layout.
//
//  Kept in its own file because a layout author is expected to read this and
//  nothing else: a skin needs to know what it will be handed and what it may
//  call, and should not have to read the Shaka wiring to find out.
// ============================================================================

export interface VoltPlayerOptions {
  /** Where to render. A CSS selector or the element itself. */
  el: string | HTMLElement;
  /** The publishable key (pk_…) of the app this player belongs to. */
  appKey: string;
  /** The station. */
  channelId: string;
  /**
   * The control plane's origin. Defaults to the origin the script itself was
   * served from, which is right for every ordinary embed and wrong only when
   * somebody self-hosts the bundle on their own CDN — hence the override.
   */
  apiBase?: string;
  /** Override the saved configuration, for previewing a skin before saving. */
  config?: Partial<PlayerConfig>;
  /**
   * Delivery preference. `auto` picks MP3 first, which is deliberate: it needs
   * no Media Source Extensions, starts faster, and is what a radio embed
   * actually wants. HLS and DASH are there for a browser or network where MP3
   * streaming is blocked.
   */
  preferred?: 'auto' | 'mp3' | 'hls' | 'dash';
  /** Start playing without a click. Usually blocked by the browser; see core. */
  autoplay?: boolean;
  /** Called for every reportable event, before it is batched and sent. */
  onEvent?: (e: PlayerEvent) => void;
  /**
   * INTERNAL: offered the session before a layout mounts. Returns true when
   * the SDK player takes over (a config saved with an SDK skin), so the old
   * embed hands a station to the new player without a second handshake.
   */
  handoff?: (session: SessionResponse, config: PlayerConfig) => boolean;
}

export interface PlayerConfig {
  layout: LayoutName;
  primaryColor: string;
  secondaryColor: string;
  options: Record<string, unknown>;
  fallbackTitle: string | null;
  fallbackText: string | null;
  fallbackArtworkUrl: string | null;
}

/**
 * THE LAYOUT NAMES, AND WHY THEY LIVE HERE.
 *
 * This list has to agree with three other places: the CHECK constraint on
 * player_configs.layout, the console's layout picker, and the registry in
 * layouts/index.ts. When they disagree, a config saved by the console selects a
 * layout the bundle cannot build, and the embed silently renders the wrong skin
 * on a customer's website with nothing logged anywhere.
 *
 * That is not hypothetical: a registry that listed only `card` while the
 * database happily stored `stage` is exactly how three finished layouts ended
 * up unreachable. layouts.check.ts now asserts the two agree.
 */
export type LayoutName = 'card' | 'bar' | 'hero' | 'stage';

// ---------------------------------------------------------------------------
//  EVENTS.
//
//  A station is a continuous thing: it is on, or it is off. An EVENT has a
//  life, and most of that life is not "playing". It is announced, it counts
//  down, it airs, it ends, it may be postponed, and afterwards it may exist as
//  a replay. A player that only knows playing/not-playing has one frame for all
//  seven of those and shows a dead box for six of them.
//
//  So the phase is named, and the layout renders the phase rather than
//  inferring it from whether audio happens to be flowing. These mirror
//  volt-app/src/services/eventPromo.ts, which is the server-side authority;
//  they are duplicated rather than imported because the embed bundle must not
//  depend on the control plane's source tree.
// ---------------------------------------------------------------------------
export type Presentation =
  | 'pre' | 'live' | 'ended' | 'replay' | 'offline' | 'postponed' | 'cancelled';

export type PromoTemplate = 'plain' | 'versus' | 'billing' | 'people' | 'field';

/** One party on a promo: a team, an artist, a speaker, a competitor. */
export interface PromoSide {
  name: string;
  imageUrl?: string | null;
  /** The qualifier under the name: a role, a record, a squad number. */
  subtitle?: string | null;
}

export interface EventPromo {
  template: PromoTemplate;
  headline?: string | null;
  subhead?: string | null;
  posterUrl?: string | null;
  posterFit?: 'cover' | 'contain';
  posterFocus?: string | null;
  overlay?: 'left' | 'centre' | 'bottom';
  sides?: PromoSide[];
  separator?: string | null;
}

/** The event a player is pointed at, when it is pointed at one. */
export interface PlayerEvent_ {
  id: string;
  title: string;
  /**
   * EPOCH MILLISECONDS, not an ISO string, and the reason is the countdown.
   * The client subtracts this from its own clock every second; a string would
   * mean parsing a date sixty times a minute and, worse, would invite a
   * timezone-less value that renders differently for a viewer in Perth than for
   * the promoter who typed it. An instant has no timezone to get wrong, and the
   * layout formats it in the viewer's own locale at the last moment.
   */
  startsAt?: number | null;
  endsAt?: number | null;
  /** Where it was going to start, kept so a postponement can say "was 19:30". */
  previousStartsAt?: number | null;
  /** Shown before it starts and after it ends, in the promoter's own words. */
  preMessage?: string | null;
  endedMessage?: string | null;
  /** Present once a recording is published; the replay button is gated on it. */
  replayUrl?: string | null;
  promo?: EventPromo | null;
}

export interface SessionResponse {
  station: { id: string; name: string; description: string | null; artworkUrl: string | null; onAir: boolean };
  sources: { mp3: string | null; hls: string; dash: string };
  config: PlayerConfig;
  report: { url: string; ttlSec: number };
  /**
   * OPTIONAL, and that is the compatibility hinge. A radio station session has
   * no event and every audio layout behaves exactly as before; an event session
   * carries one and the stage and phase layouts light up.
   */
  event?: PlayerEvent_ | null;
  presentation?: Presentation | null;
}

/** What the layout renders. Already resolved server-side, fallback applied. */
export interface NowPlaying {
  primary: string;
  secondary: string | null;
  artworkUrl: string | null;
  source: 'track' | 'station';
  album: string | null;
  year: number | null;
  onAir: boolean;
  raw: string | null;
  since: number | null;
}

export type PlayerEventName =
  | 'player.load' | 'player.ready'
  | 'manifest.ok' | 'manifest.error'
  | 'play' | 'pause' | 'stop'
  | 'stall' | 'recover'
  | 'error';

export interface PlayerEvent {
  event: PlayerEventName;
  at: number;
  layout?: string;
  detail?: Record<string, unknown>;
}

/**
 * What a layout is given.
 *
 * A layout receives DATA and COMMANDS and nothing else — no Shaka instance, no
 * media element, no fetch. That is what makes a third-party skin safe to
 * accept: it cannot reach past its own box into the transport, so a bad skin
 * renders badly instead of breaking playback or leaking the session.
 */
export interface LayoutContext {
  root: HTMLElement;
  config: PlayerConfig;
  station: SessionResponse['station'];
  /** Commands. */
  play(): void;
  pause(): void;
  toggle(): void;
  setVolume(v: number): void;
  getVolume(): number;
  /**
   * Send the viewer to the published replay. A COMMAND rather than a URL,
   * deliberately: the layout should not be deciding whether to open a tab, and
   * routing it through the core is what lets the click be reported.
   */
  openReplay(): void;
  /**
   * THE ONE EXCEPTION to "a layout never touches the transport", and it is
   * narrow on purpose. A video stage has to put the picture somewhere, and the
   * picture lives in the media element. The element is exposed so the stage can
   * PLACE and SIZE it; everything else about it, source, load, error handling,
   * still belongs to the core. Audio layouts never read this.
   */
  media: HTMLMediaElement;
}

export interface LayoutState {
  playing: boolean;
  loading: boolean;
  /** Present only when something has gone wrong, already made readable. */
  error: string | null;
  nowPlaying: NowPlaying | null;
  /**
   * WHICH PHASE OF ITS LIFE THIS IS. Always 'live' for a station, which is why
   * the audio layouts can ignore it entirely and did not have to change when
   * events arrived.
   */
  presentation: Presentation;
  /** The event, when there is one. Null for a radio station. */
  event: PlayerEvent_ | null;
  /**
   * Milliseconds until it starts, or null when that is not a meaningful
   * question (already started, no start time, cancelled). Recomputed by the
   * core on a ticker so a layout never runs its own clock.
   */
  msToStart: number | null;
  /**
   * Is there actually a picture in the media element? Video-shaped layouts use
   * this to know when to lift the poster, and a lie in either direction is
   * visible: a poster over live video, or a black box before the first frame.
   */
  hasPicture: boolean;
}

export interface Layout {
  /** Build the DOM once. */
  mount(ctx: LayoutContext): void;
  /** Called on every state change. Must be cheap and idempotent. */
  update(state: LayoutState): void;
  destroy?(): void;
}
