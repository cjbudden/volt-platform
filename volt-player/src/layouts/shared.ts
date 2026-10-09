// ============================================================================
//  WHAT EVERY LAYOUT NEEDS, IN ONE PLACE.
//
//  Three layouts that each define their own play icon is three layouts whose
//  play icons drift apart. More importantly, three layouts that each write
//  their own status element is three chances to forget the aria-live, and the
//  one that forgets is silent for a screen reader with no visible symptom.
//
//  ------------------------------------------------------------------------
//  EVERY SELECTOR IS PREFIXED WITH THE INSTANCE CLASS.
//
//  This runs on somebody else's page. A stylesheet dropped into a host
//  document is a fight nobody wins: their reset changes our box model, their
//  `img { width: 100% }` stretches the artwork, our selectors leak into their
//  markup. `scopedStyle` exists so that prefixing is done by construction
//  rather than by remembering, which is how the old `.vp-status` rules ended
//  up global in the first place.
// ============================================================================
import type { LayoutContext } from '../types';

let seq = 0;

/** A class nothing else on the host page can be using. */
export function instanceClass(kind: string): string { return `vp-${kind}-${++seq}`; }

export function el(tag: string, className: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = className;
  return n;
}

/**
 * Attach a stylesheet whose every SELECTOR is scoped to one instance.
 *
 * Selectors are written with `&`, which becomes `.<cls>`. Everything else,
 * declarations, closing braces, `@media` and `@keyframes` lines, has no `&`
 * and passes through untouched. Writing a selector and forgetting the `&` is
 * therefore the one way to leak, and it is visible on the line itself.
 */
export function scopedStyle(root: HTMLElement, cls: string, rules: string): void {
  const style = document.createElement('style');
  style.textContent = rules
    .split('\n')
    .map((line) => (line.includes('&') ? line.replace(/&/g, `.${cls}`) : line))
    .join('\n');
  root.appendChild(style);
}

/** The one control every layout has, wired to toggle. */
export function playButton(ctx: LayoutContext, className = 'vp-play'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.setAttribute('aria-label', 'Play');
  b.innerHTML = ICON_PLAY;
  b.addEventListener('click', () => ctx.toggle());
  return b;
}

export function setPlayState(b: HTMLButtonElement, playing: boolean, loading: boolean): void {
  b.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  b.classList.toggle('vp-loading', loading && !playing);
}

export function volumeSlider(ctx: LayoutContext, className = 'vp-vol'): HTMLInputElement {
  const v = document.createElement('input');
  v.type = 'range';
  v.className = className;
  v.min = '0'; v.max = '1'; v.step = '0.01';
  v.value = String(ctx.getVolume());
  v.setAttribute('aria-label', 'Volume');
  v.addEventListener('input', () => ctx.setVolume(Number(v.value)));
  return v;
}

/**
 * The status line.
 *
 * Announced politely so a screen reader reports a track change or an error
 * without interrupting whatever the person is reading.
 */
export function statusLine(className = 'vp-status'): HTMLElement {
  const s = el('div', className);
  s.setAttribute('role', 'status');
  s.setAttribute('aria-live', 'polite');
  return s;
}

/** Artwork that fails quietly. A missing cover must not leave a broken-image
 *  icon on a customer's site, so the element hides itself and the wrapper's
 *  placeholder shows through. */
export function artworkImage(): HTMLImageElement {
  const img = document.createElement('img');
  img.alt = '';                  // decorative: the title is beside it
  img.loading = 'lazy';
  img.addEventListener('error', () => { img.style.opacity = '0'; });
  return img;
}

export function setArtwork(img: HTMLImageElement, url: string | null): void {
  if (url && img.getAttribute('src') !== url) { img.style.opacity = '1'; img.src = url; }
  if (!url) img.style.opacity = '0';
}

/** Album and year, only when they exist. An empty line reserved for metadata
 *  that is usually absent makes every player look broken. */
export function metaLine(album: string | null | undefined, year: number | null | undefined): string {
  return [album, year ? String(year) : null].filter(Boolean).join(' · ');
}

export const ICON_PLAY =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
export const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>';

/** Rules every layout wants: the box model, and never inheriting the host
 *  page's font or line-height.
 *
 *  The instance class sits on the SHELL, and everything else is a descendant
 *  of it. That is what makes the status line scopable: it is a sibling of the
 *  player body, not a child of it, and the version of this file that scoped by
 *  the body's class left those two rules global. */
export function baseRules(): string {
  return `
&, & * { box-sizing: border-box; }
& {
  font-family: var(--vp-font);
  font-size: 14px; line-height: 1.4;
  color: var(--vp-ink);
}
& .vp-status { font-size: 12px; margin-top: 6px; opacity: .8; min-height: 1em; }
& .vp-status.vp-err { color: #f87171; }
& .vp-play {
  border: 0; cursor: pointer; padding: 0; display: grid; place-items: center;
  background: var(--vp-primary); color: var(--vp-accent-on);
  width: var(--vp-hit); height: var(--vp-hit); border-radius: 50%;
}
& .vp-play svg { width: var(--vp-icon); height: var(--vp-icon); }
& .vp-play:focus-visible { outline: 3px solid var(--vp-primary); outline-offset: 3px; }
& .vp-play.vp-loading { opacity: .6; }
& .vp-vol { accent-color: var(--vp-primary); }
`;
}
