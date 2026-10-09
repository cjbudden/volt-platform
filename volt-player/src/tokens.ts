// ============================================================================
//  SKIN TOKENS.
//
//  One closed set of custom properties, the same names in every layout, set
//  ONCE by the core on the container. A layout reads them and never invents
//  its own.
//
//  Two things follow from that, and both are the point:
//
//    A colour change in the console is a property update, not a rebuild of the
//    DOM, which is what lets the setup screen preview a skin live.
//
//    Two layouts look like the same product. A token set that each layout
//    re-derives for itself is a token set that drifts, and the drift shows up
//    as a bar player whose blue is not quite the card player's blue.
//
//  ------------------------------------------------------------------------
//  --vp-ink IS COMPUTED, AND DELIBERATELY NOT CONFIGURABLE.
//
//  It is derived from the surface colour's sRGB relative luminance. A station
//  that picks a pale brand colour gets dark text without anyone choosing it.
//  Exposing it as a setting means exposing the setting that makes the player
//  unreadable, and somebody eventually chooses it.
// ============================================================================
import type { PlayerConfig } from './types';

/** The system stack. Matching the host page is not the goal: being legible on
 *  every host page is, and a font that fails to load is worse than a familiar
 *  one that does not. */
export const DEFAULT_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** Spacing and control size, as two named steps rather than a free number.
 *  A slider from 4 to 32 produces a hundred broken players and one good one. */
const DENSITY = {
  comfortable: { pad: '14px', gap: '14px', hit: '44px', icon: '22px' },
  compact:     { pad: '10px', gap: '10px', hit: '36px', icon: '18px' },
} as const;

export type Density = keyof typeof DENSITY;

/**
 * The box a player occupies, whatever is currently in it.
 *
 * A video event that reserves 16:9 shows its countdown in a 16:9 box, its
 * "event has finished" in the same 16:9 box, and the video in the same 16:9
 * box. Nothing on the page moves when the stream starts, which matters because
 * the moment the stream starts is the moment everybody is looking at it, and a
 * page that jumps then reads as a page that broke.
 *
 * `auto` is right for audio, where the player is a strip and a reserved
 * rectangle would just be empty.
 */
const ASPECTS: Record<string, string> = {
  'auto': 'auto',
  '16:9': '16 / 9',
  '4:3': '4 / 3',
  '1:1': '1 / 1',
  '21:9': '21 / 9',
  '9:16': '9 / 16',
};

export function aspectRatio(v: unknown): string {
  const k = typeof v === 'string' ? v.trim() : '';
  return ASPECTS[k] ?? 'auto';
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Write the token set onto an element. Every layout inherits from here.
 *
 * Called by the core on the container before the layout mounts, and again on
 * any config change, so a layout never has to re-read config to restyle.
 */
export function applyTokens(el: HTMLElement, cfg: PlayerConfig): void {
  const opts = (cfg.options ?? {}) as Record<string, unknown>;
  const surface = cfg.secondaryColor;
  const primary = cfg.primaryColor;

  const densityName = (str(opts.density) === 'compact' ? 'compact' : 'comfortable') as Density;
  const d = DENSITY[densityName];

  const radius = str(opts.radius) ?? (typeof opts.radius === 'number' ? `${opts.radius}px` : null) ?? '14px';
  const font = str(opts.font) ?? DEFAULT_FONT;

  const set = (k: string, v: string) => el.style.setProperty(k, v);

  set('--vp-primary', primary);
  set('--vp-surface', surface);
  // Kept as an alias because the first layout shipped with this name and
  // embedders have read it out of the DOM. Removing it costs more than it saves.
  set('--vp-secondary', surface);
  set('--vp-ink', idealInk(surface));
  set('--vp-ink-dim', idealInk(surface, 0.62));
  set('--vp-ink-faint', idealInk(surface, 0.14));
  // Readable text ON the brand colour, for a filled control. Computed for the
  // same reason as --vp-ink: a station whose brand is pale yellow gets dark
  // glyphs on its play button rather than white on white.
  set('--vp-accent-on', idealInk(primary));
  set('--vp-radius', radius);
  set('--vp-pad', d.pad);
  set('--vp-gap', d.gap);
  set('--vp-hit', d.hit);
  set('--vp-icon', d.icon);
  set('--vp-font', font);
  set('--vp-aspect', aspectRatio(opts.aspect));

  // ---- over video -------------------------------------------------------
  // See the note above `onVideoAccent`. Overlay ink is FIXED, legibility comes
  // from the scrim, and the brand appears as accent fills rather than as text
  // colour.
  set('--vp-on-video', '#ffffff');
  set('--vp-on-video-dim', 'rgba(255,255,255,.74)');
  // The brand goes onto video EXACTLY as given. Only the ring around it is
  // computed. See `videoEdge`.
  set('--vp-edge', videoEdge(primary));
  const sc = SCRIM[(str(opts.scrim) as Scrim) in SCRIM ? (str(opts.scrim) as Scrim) : 'medium'];
  set('--vp-scrim-top', String(sc.top));
  set('--vp-scrim-bottom', String(sc.bottom));
  // Behind the picture, where the picture does not fill the reserved box.
  // Black by default because a letterbox in a brand colour reads as a bug.
  set('--vp-letterbox', str(opts.letterbox) ?? '#000000');
  set('--vp-density', densityName);
}

/**
 * How heavy the gradient under the controls is.
 *
 * The one legibility control a customer legitimately needs over video: a
 * station whose content is mostly dark needs less of it, and a station showing
 * snow or a bright studio needs more. Everything else about overlay contrast is
 * ours to decide, because it has to hold against pictures nobody has seen yet.
 */
const SCRIM = {
  light:  { top: 0.28, bottom: 0.55 },
  medium: { top: 0.38, bottom: 0.70 },
  heavy:  { top: 0.50, bottom: 0.82 },
} as const;

export type Scrim = keyof typeof SCRIM;

/**
 * A CONTRAST GUARANTEE FOR THE BRAND ON VIDEO, WITHOUT CHANGING THE BRAND.
 *
 * The failure case is narrow and real: a very dark brand colour on a dark scrim
 * over dark footage. A navy play button on a night match is a navy circle
 * nobody can find, and the customer's conclusion is that the player is broken
 * rather than that their navy is navy.
 *
 * The obvious fix is to lighten their colour until it is visible. That was
 * tried and rejected: lifting #0b2545 far enough to clear a luminance floor
 * produces a grey-blue that is no longer their navy, and a player that silently
 * repaints a brand is worse than one that is briefly hard to see. Brand
 * colours are the one thing a customer will check pixel by pixel.
 *
 * So the FILL is never touched, and the EDGE is guaranteed instead: a hairline
 * ring of the overlay ink, at an alpha that rises only as the brand gets dark
 * enough to need it. A bright brand gets no ring at all. The shape is always
 * findable and the colour is always theirs.
 */
const EDGE_FLOOR = 0.22;

export function videoEdge(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return 'transparent';
  const L = luminance(rgb);
  if (L >= EDGE_FLOOR) return 'transparent';
  // Linear from nothing at the floor to nearly solid at black.
  const alpha = Math.round(((EDGE_FLOOR - L) / EDGE_FLOOR) * 0.85 * 100) / 100;
  return `rgba(255,255,255,${alpha})`;
}

type RGB = [number, number, number];

function parseHex(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: RGB): number {
  const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Black or white, whichever is readable on this background.
 *
 * The sRGB relative-luminance threshold, not a guess at "is it dark".
 */
export function idealInk(bg: string, alpha = 1): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(bg ?? '').trim());
  if (!m) return alpha === 1 ? '#ffffff' : `rgba(255,255,255,${alpha})`;
  const n = parseInt(m[1], 16);
  const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  const dark = L < 0.35;
  return dark
    ? (alpha === 1 ? '#ffffff' : `rgba(255,255,255,${alpha})`)
    : (alpha === 1 ? '#0b0e13' : `rgba(11,14,19,${alpha})`);
}
