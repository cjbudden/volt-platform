// ============================================================================
//  THE CARD LAYOUT.
//
//  Artwork, track, station, one control. The default, and the one that shows
//  album art properly.
//
//  ------------------------------------------------------------------------
//  EVERYTHING IS SCOPED AND INLINE, BECAUSE THIS RUNS ON SOMEBODY ELSE'S PAGE.
//
//  A stylesheet dropped into a host document is a fight nobody wins: their
//  reset changes our box model, their `img { width: 100% }` stretches the
//  artwork, our selectors leak into their markup. So the styles live in a
//  single <style> element scoped by one generated class, every rule is
//  prefixed with it, and the container sets the properties a host page most
//  often imposes (box-sizing, line-height, font) rather than inheriting them.
//
//  The colours come through CSS custom properties on the container, which is
//  what lets the console preview a colour change without rebuilding the DOM.
//
//  ------------------------------------------------------------------------
//  THE CONTROL IS A REAL <button>. Keyboard and screen-reader support is not a
//  later pass: a div with a click handler is unreachable by keyboard, and an
//  embed is exactly the kind of component that gets audited.
// ============================================================================
import type { Layout, LayoutContext, LayoutState } from '../types';

let seq = 0;

export function cardLayout(): Layout {
  const cls = `vp-card-${++seq}`;
  let ctx: LayoutContext;
  let box: HTMLElement;
  let art: HTMLImageElement;
  let artWrap: HTMLElement;
  let primary: HTMLElement;
  let secondary: HTMLElement;
  let meta: HTMLElement;
  let btn: HTMLButtonElement;
  let status: HTMLElement;
  let vol: HTMLInputElement;

  return {
    mount(c: LayoutContext) {
      ctx = c;
      const style = document.createElement('style');
      style.textContent = css(cls);
      c.root.appendChild(style);

      box = el('div', `${cls} vp-box`);
      box.style.setProperty('--vp-primary', c.config.primaryColor);
      box.style.setProperty('--vp-secondary', c.config.secondaryColor);
      // Readable text on whatever background the customer chose. Computed
      // rather than assumed: a station picking a pale brand colour would
      // otherwise get white text on cream.
      box.style.setProperty('--vp-ink', idealInk(c.config.secondaryColor));
      box.style.setProperty('--vp-ink-dim', idealInk(c.config.secondaryColor, 0.62));

      artWrap = el('div', 'vp-art');
      art = document.createElement('img');
      art.alt = '';                    // decorative: the title is beside it
      art.loading = 'lazy';
      // A missing cover must not leave a broken-image icon on a customer's
      // site. The wrapper keeps its shape and the placeholder shows through.
      art.addEventListener('error', () => { art.style.opacity = '0'; });
      artWrap.appendChild(art);

      const text = el('div', 'vp-text');
      primary = el('div', 'vp-primary');
      secondary = el('div', 'vp-secondary');
      meta = el('div', 'vp-meta');
      text.append(primary, secondary, meta);

      const controls = el('div', 'vp-controls');
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vp-play';
      btn.setAttribute('aria-label', 'Play');
      btn.innerHTML = ICON_PLAY;
      btn.addEventListener('click', () => ctx.toggle());

      vol = document.createElement('input');
      vol.type = 'range';
      vol.className = 'vp-vol';
      vol.min = '0'; vol.max = '1'; vol.step = '0.01';
      vol.value = String(ctx.getVolume());
      vol.setAttribute('aria-label', 'Volume');
      vol.addEventListener('input', () => ctx.setVolume(Number(vol.value)));
      controls.append(btn, vol);

      status = el('div', 'vp-status');
      // Announced politely so a screen reader reports a track change or an
      // error without interrupting whatever the person is reading.
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');

      box.append(artWrap, text, controls);
      const shell = el('div', 'vp-shell');
      shell.append(box, status);
      c.root.appendChild(shell);

      primary.textContent = c.station.name;
      secondary.textContent = c.station.description ?? '';
      if (c.station.artworkUrl) art.src = c.station.artworkUrl;
    },

    update(s: LayoutState) {
      const np = s.nowPlaying;
      primary.textContent = np?.primary ?? ctx.station.name;
      secondary.textContent = np?.secondary ?? ctx.station.description ?? '';
      // Album and year only when they exist. An empty line reserved for
      // metadata that is usually absent makes every card look broken.
      const bits = [np?.album, np?.year ? String(np.year) : null].filter(Boolean);
      meta.textContent = bits.join(' · ');
      meta.style.display = bits.length ? '' : 'none';

      const url = np?.artworkUrl ?? ctx.station.artworkUrl ?? null;
      if (url && art.getAttribute('src') !== url) { art.style.opacity = '1'; art.src = url; }
      if (!url) art.style.opacity = '0';

      btn.innerHTML = s.playing ? ICON_PAUSE : ICON_PLAY;
      btn.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
      btn.classList.toggle('vp-loading', s.loading && !s.playing);

      status.textContent = s.error ?? (s.loading && !s.playing ? 'Connecting…' : '');
      status.classList.toggle('vp-err', !!s.error);
    },

    destroy() { try { ctx.root.innerHTML = ''; } catch { /* */ } },
  };
}

function el(tag: string, className: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = className;
  return n;
}

/**
 * Black or white, whichever is readable on this background.
 *
 * The sRGB relative-luminance threshold, not a guess at "is it dark". A
 * customer who picks a pale brand colour gets dark text, which is the whole
 * reason this is computed rather than hardcoded to white.
 */
export function idealInk(bg: string, alpha = 1): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg.trim());
  if (!m) return alpha === 1 ? '#ffffff' : `rgba(255,255,255,${alpha})`;
  const n = parseInt(m[1], 16);
  const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  const dark = L < 0.35;
  return dark
    ? (alpha === 1 ? '#ffffff' : `rgba(255,255,255,${alpha})`)
    : (alpha === 1 ? '#0b0e13' : `rgba(11,14,19,${alpha})`);
}

const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>';

function css(cls: string): string {
  return `
.${cls}.vp-box, .${cls} * { box-sizing: border-box; }
.${cls}.vp-box {
  display: flex; align-items: center; gap: 14px;
  padding: 14px; border-radius: 14px;
  background: var(--vp-secondary); color: var(--vp-ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px; line-height: 1.4;
  max-width: 480px;
}
.${cls} .vp-art {
  width: 72px; height: 72px; flex: none; border-radius: 10px; overflow: hidden;
  background: rgba(127,127,127,.22); position: relative;
}
.${cls} .vp-art img {
  width: 100%; height: 100%; object-fit: cover; display: block;
  transition: opacity .2s ease;
}
.${cls} .vp-text { min-width: 0; flex: 1; }
.${cls} .vp-primary {
  font-weight: 650; font-size: 15px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.${cls} .vp-secondary {
  color: var(--vp-ink-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.${cls} .vp-meta { color: var(--vp-ink-dim); font-size: 12px; margin-top: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.${cls} .vp-controls { display: flex; align-items: center; gap: 10px; flex: none; }
.${cls} .vp-play {
  width: 44px; height: 44px; border-radius: 50%; border: 0; cursor: pointer;
  background: var(--vp-primary); color: #fff; padding: 0;
  display: grid; place-items: center;
}
.${cls} .vp-play svg { width: 22px; height: 22px; }
.${cls} .vp-play:focus-visible { outline: 3px solid var(--vp-primary); outline-offset: 3px; }
.${cls} .vp-play.vp-loading { opacity: .6; }
.${cls} .vp-vol { width: 84px; accent-color: var(--vp-primary); }
@media (max-width: 380px) { .${cls} .vp-vol { display: none; } }
.vp-status { font-size: 12px; margin-top: 6px; opacity: .8; min-height: 1em; }
.vp-status.vp-err { color: #f87171; }
@media (prefers-reduced-motion: reduce) {
  .${cls} .vp-art img { transition: none; }
}
`;
}
