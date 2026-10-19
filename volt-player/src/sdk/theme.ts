// ============================================================================
//  THEME TOKENS: the no-code half of a custom skin.
//
//  A theme is a handful of values saved in the console. resolveTheme() fills
//  in everything not given (with contrast-safe text colours), and applyTheme()
//  writes them as CSS custom properties on the player box, which is the only
//  way a built-in skin reads colours. So a client restyles every built-in skin
//  by changing tokens, and a custom skin that uses the same variables follows
//  the console's settings for free.
//
//    --vp-primary / --vp-primary-ink     buttons, progress, the live dot
//    --vp-secondary / --vp-secondary-ink chips, cards, the up-next panel
//    --vp-bg / --vp-text / --vp-muted    the chrome itself
//    --vp-radius / --vp-font
//
//  Pure functions apart from applyTheme(), so they are unit tested
//  (test/theme.check.ts) and mirrored exactly by the native SDKs.
// ============================================================================
import type { ControlToggles, ResolvedTheme, Theme } from './types';

export const DEFAULT_CONTROLS: ControlToggles = {
  title: true, seekButtons: true, volume: true, quality: true, subtitles: true,
  audioTracks: true, speed: false, pip: true, fullscreen: true, cast: true,
  airplay: true, startOver: true, schedule: true, upNext: true, history: true,
};

export const DEFAULT_THEME: Theme = {
  primary: '#3f7bff',
  secondary: '#0f1218',
  radius: 12,
  logoPosition: 'top-right',
  upNextSeconds: 15,
  autoAdvance: true,
};

const HEX = /^#([0-9a-f]{6})$/i;
export const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v.trim());

/** Relative luminance (WCAG). */
export function luminance(hex: string): number {
  const n = parseInt(hex.trim().slice(1), 16);
  const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** Black or white, whichever reads better on this colour. */
export function inkFor(hex: string): string {
  if (!isHex(hex)) return '#ffffff';
  // The crossover where black and white text have equal contrast is L ≈ 0.179.
  return luminance(hex) > 0.179 ? '#0b0e13' : '#ffffff';
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Mix a colour toward white (w>0) or black (w<0). */
export function shade(hex: string, w: number): string {
  if (!isHex(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  const to = w >= 0 ? 255 : 0; const k = Math.abs(w);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (to - v) * k));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** Fill every token, keeping text readable whatever colours were chosen. */
export function resolveTheme(...layers: Array<Partial<Theme> | null | undefined>): ResolvedTheme {
  const t: Theme = { ...DEFAULT_THEME };
  const controls: ControlToggles = { ...DEFAULT_CONTROLS };
  for (const l of layers) {
    if (!l) continue;
    for (const [k, v] of Object.entries(l)) {
      if (v === undefined || (v === null && k !== 'logoUrl')) continue;
      if (k === 'controls' && v && typeof v === 'object') Object.assign(controls, v);
      else (t as any)[k] = v;
    }
  }
  const primary = isHex(t.primary) ? t.primary : DEFAULT_THEME.primary;
  const secondary = isHex(t.secondary) ? t.secondary : DEFAULT_THEME.secondary;
  const background = isHex(t.background) ? t.background! : secondary;
  // A chosen text colour is kept only when it is readable on the background
  // (WCAG AA for large text, 3:1); otherwise black or white is used. A brand
  // colour pasted into the wrong field must not make the controls invisible.
  const text = isHex(t.text) && contrast(t.text!, background) >= 3 ? t.text! : inkFor(background);
  const radius = Number.isFinite(Number(t.radius)) ? Math.max(0, Math.min(28, Number(t.radius))) : 12;
  const upNextSeconds = Number.isFinite(Number(t.upNextSeconds)) ? Math.max(5, Math.min(120, Number(t.upNextSeconds))) : 15;
  return {
    primary, secondary, background, text,
    primaryInk: inkFor(primary),
    secondaryInk: inkFor(secondary),
    muted: text === '#ffffff' ? 'rgba(255,255,255,.66)' : 'rgba(11,14,19,.62)',
    radius,
    font: typeof t.font === 'string' && t.font.trim() ? `${t.font.trim()}, ${FONT}` : FONT,
    // http(s) or a path on this site only: the value lands in an <img src>.
    logoUrl: typeof t.logoUrl === 'string' && /^(https?:\/\/|\/(?!\/))/i.test(t.logoUrl.trim()) ? t.logoUrl.trim() : null,
    logoPosition: (['top-left', 'top-right', 'bottom-right', 'none'] as const).includes(t.logoPosition as any) ? t.logoPosition! : 'top-right',
    upNextSeconds,
    autoAdvance: t.autoAdvance !== false,
    controls,
  };
}

/** The CSS custom properties for a theme. */
export function themeVars(t: ResolvedTheme): Record<string, string> {
  return {
    '--vp-primary': t.primary,
    '--vp-primary-ink': t.primaryInk,
    '--vp-secondary': t.secondary,
    '--vp-secondary-ink': t.secondaryInk,
    '--vp-bg': t.background,
    '--vp-text': t.text,
    '--vp-muted': t.muted,
    '--vp-radius': `${t.radius}px`,
    '--vp-font': t.font,
  };
}

export function applyTheme(el: HTMLElement, t: ResolvedTheme): void {
  for (const [k, v] of Object.entries(themeVars(t))) el.style.setProperty(k, v);
}

/**
 * The theme a saved player config describes. player_configs keeps the two
 * original colours as columns and everything newer in options.theme, so a
 * config saved before the SDK existed still resolves.
 */
export function themeFromConfig(cfg: { primaryColor?: string; secondaryColor?: string; options?: Record<string, any> } | null | undefined): Partial<Theme> {
  if (!cfg) return {};
  const extra = (cfg.options && typeof cfg.options.theme === 'object' && cfg.options.theme) || {};
  return { primary: cfg.primaryColor, secondary: cfg.secondaryColor, ...extra };
}
