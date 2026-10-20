// ============================================================================
//  THE SKIN KIT: what every skin is built from, and what a client's custom
//  skin can use too (window.VoltPlayer.kit).
//
//  el()        create an element with classes, attributes and children
//  button()    an icon button with a tooltip and an accessible label
//  icon()      the icon set, as inline SVG
//  menu()      a popover list (quality, subtitles, audio, speed)
//  slider()    a scrubber / volume slider that works with mouse, touch and keys
//  fmtTime, fmtClock, fmtIn   time formatting
//  skipButton() the Skip intro / recap / credits button (on-demand only)
//  upNextCard() THE UP NEXT / COMING UP TEMPLATE every built-in skin uses, and a
//               custom skin can too: one place that decides what the card says
//               and how its progress runs, whatever drives it (the stream's own
//               trigger, a fetched guide, or the end of a playlist item)
//
//  The stylesheet is injected once per page and scoped under .vp, so a host
//  page's CSS and the player's do not fight. Colours come only from the
//  theme's CSS variables.
// ============================================================================
export { fmtTime, fmtClock, fmtIn } from '../schedule';
import { fmtClock as clockOf, fmtIn as inOf } from '../schedule';
import type { PlayerState, SkinContext, UpNext } from '../types';

const P: Record<string, string> = {
  play: 'M8 5.14v13.72a1 1 0 0 0 1.52.85l10.8-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  replay: 'M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z',
  back10: 'M11.5 6V3L7 7l4.5 4V8a5 5 0 1 1-5 5H4.5a7 7 0 1 0 7-7zM9.6 16.5h-1v-3.3l-.9.3v-.8l1.8-.6h.1zm4.5-1.6c0 1.1-.6 1.7-1.5 1.7s-1.5-.6-1.5-1.7v-.7c0-1.1.6-1.7 1.5-1.7s1.5.6 1.5 1.7zm-1-.8c0-.6-.2-.9-.5-.9s-.5.3-.5.9v.9c0 .6.2.9.5.9s.5-.3.5-.9z',
  fwd10: 'M12.5 6V3L17 7l-4.5 4V8a5 5 0 1 0 5 5h2a7 7 0 1 1-7-7zM9.6 16.5h-1v-3.3l-.9.3v-.8l1.8-.6h.1zm4.5-1.6c0 1.1-.6 1.7-1.5 1.7s-1.5-.6-1.5-1.7v-.7c0-1.1.6-1.7 1.5-1.7s1.5.6 1.5 1.7zm-1-.8c0-.6-.2-.9-.5-.9s-.5.3-.5.9v.9c0 .6.2.9.5.9s.5-.3.5-.9z',
  volume: 'M4 9v6h4l5 4V5L8 9zm11.5 3A4.5 4.5 0 0 0 13 8v8a4.5 4.5 0 0 0 2.5-4zM13 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z',
  mute: 'M4 9v6h4l5 4V5L8 9zm12.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z',
  cc: 'M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1z',
  gear: 'M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
  list: 'M4 6h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zm-4 5h2v2H4zm4 0h12v2H8z',
  pip: 'M19 7h-8v6h8zm2-4H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H3V5h18z',
  fullscreen: 'M5 5h5V3H3v7h2zm5 14H5v-5H3v7h7zm9-14h-5V3h7v7h-2zm-5 14h5v-5h2v7h-7z',
  exitFullscreen: 'M8 3v5H3v2h7V3zm8 0v7h7V8h-5V3zM3 16h5v5h2v-7H3zm13 5h2v-5h5v-2h-7z',
  cast: 'M1 18v3h3a3 3 0 0 0-3-3zm0-4v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7zm0-4v2a9 9 0 0 1 9 9h2A11 11 0 0 0 1 10zm20-7H3a2 2 0 0 0-2 2v3h2V5h18v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z',
  castOn: 'M1 18v3h3a3 3 0 0 0-3-3zm0-4v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7zm18-7H5v1.6A12.9 12.9 0 0 1 13.4 17H19zM1 10v2a9 9 0 0 1 9 9h2A11 11 0 0 0 1 10zm20-7H3a2 2 0 0 0-2 2v3h2V5h18v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z',
  airplay: 'M6 22h12l-6-6zM21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4v-2H3V5h18v12h-4v2h4a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z',
  startOver: 'M6 6h2v12H6zm3.5 6 8.5 6V6z',
  next: 'M6 18l8.5-6L6 6zm9-12h2v12h-2z',
  prev: 'M6 6h2v12H6zm3.5 6 8.5 6V6z',
  close: 'M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z',
  music: 'M12 3v10.6A4 4 0 1 0 14 17V7h4V3z',
  stats: 'M4 20h4V10H4zm6 0h4V4h-4zm6 0h4v-7h-4z',
};

export function icon(name: string, size = 22): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', P[name] ?? P.play);
  p.setAttribute('fill', 'currentColor');
  s.appendChild(p);
  return s;
}

export function setIcon(btn: HTMLElement, name: string): void {
  if (btn.dataset.icon === name) return;
  btn.dataset.icon = name;
  const old = btn.querySelector('svg');
  const n = icon(name, Number(btn.dataset.size) || 22);
  if (old) old.replaceWith(n); else btn.prepend(n);
}

type Child = Node | string | null | undefined | false;
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, attrs?: Record<string, string>, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
}

/** Set text only when it changed (update() runs often). */
export function text(e: HTMLElement, v: string | null | undefined): void {
  const s = v ?? '';
  if (e.textContent !== s) e.textContent = s;
}

export function show(e: HTMLElement, on: boolean): void {
  if (e.hidden === !on) return;
  e.hidden = !on;
}

/** An icon button with a tooltip (data-tip) and an accessible name. */
export function button(name: string, label: string, onClick: (ev: MouseEvent) => void, cls = 'vp-btn', size = 22): HTMLButtonElement {
  const b = el('button', cls, { type: 'button', 'aria-label': label, 'data-tip': label });
  b.dataset.size = String(size);
  setIcon(b, name);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
  return b;
}

export function label(b: HTMLElement, s: string): void {
  if (b.getAttribute('aria-label') !== s) { b.setAttribute('aria-label', s); b.setAttribute('data-tip', s); }
}

export interface MenuItem { id: string; label: string; detail?: string; selected?: boolean }

/** A popover list anchored to a button, closed by a click elsewhere or Escape. */
export function menu(host: HTMLElement, title: string, items: MenuItem[], pick: (id: string) => void, anchor: HTMLElement): () => void {
  host.querySelectorAll('.vp-menu').forEach((m) => m.remove());
  const m = el('div', 'vp-menu', { role: 'menu' }, el('div', 'vp-menu-h', undefined, title));
  for (const it of items) {
    const row = el('button', 'vp-menu-i' + (it.selected ? ' on' : ''), { type: 'button', role: 'menuitemradio', 'aria-checked': String(!!it.selected) },
      el('span', 'vp-menu-l', undefined, it.label), it.detail ? el('span', 'vp-menu-d', undefined, it.detail) : null);
    row.addEventListener('click', (e) => { e.stopPropagation(); pick(it.id); close(); });
    m.appendChild(row);
  }
  host.appendChild(m);
  const hr = host.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
  m.style.right = `${Math.max(8, hr.right - ar.right)}px`;
  m.style.bottom = `${Math.max(8, hr.bottom - ar.top + 6)}px`;
  (m.querySelector('.on') as HTMLElement ?? m.querySelector('.vp-menu-i') as HTMLElement)?.focus();
  const away = (e: Event) => { if (!m.contains(e.target as Node)) close(); };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); } };
  setTimeout(() => document.addEventListener('pointerdown', away, true));
  m.addEventListener('keydown', esc);
  function close() { m.remove(); document.removeEventListener('pointerdown', away, true); }
  return close;
}

/**
 * A slider: scrubber or volume. `value` 0..1. Drag, click, touch and the
 * arrow keys. `preview(frac)` lets a scrubber show the time under the pointer.
 */
export interface Slider { root: HTMLElement; set(v: number, extra?: number): void; dragging(): boolean }
export function slider(cls: string, aria: string, onInput: (v: number, final: boolean) => void, preview?: (v: number | null) => void): Slider {
  const fill = el('div', 'vp-sl-fill');
  const extra = el('div', 'vp-sl-extra');
  const thumb = el('div', 'vp-sl-thumb');
  const root = el('div', `vp-sl ${cls}`, { role: 'slider', tabindex: '0', 'aria-label': aria, 'aria-valuemin': '0', 'aria-valuemax': '100' },
    el('div', 'vp-sl-track', undefined, extra, fill), thumb);
  let drag = false, v = 0;
  const at = (x: number) => { const r = root.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / Math.max(1, r.width))); };
  root.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    drag = true; root.setPointerCapture(e.pointerId); root.classList.add('drag');
    const f = at(e.clientX); paint(f); onInput(f, false);
  });
  root.addEventListener('pointermove', (e) => {
    const f = at(e.clientX);
    preview?.(f);
    if (drag) { paint(f); onInput(f, false); }
  });
  root.addEventListener('pointerleave', () => { if (!drag) preview?.(null); });
  const end = (e: PointerEvent) => { if (!drag) return; drag = false; root.classList.remove('drag'); onInput(at(e.clientX), true); preview?.(null); };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('click', (e) => e.stopPropagation());
  root.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { onInput(Math.max(0, v - step), true); e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { onInput(Math.min(1, v + step), true); e.preventDefault(); e.stopPropagation(); }
  });
  function paint(f: number, x?: number) {
    fill.style.width = `${f * 100}%`;
    thumb.style.left = `${f * 100}%`;
    if (x != null) extra.style.width = `${Math.max(0, Math.min(1, x)) * 100}%`;
    root.setAttribute('aria-valuenow', String(Math.round(f * 100)));
  }
  return { root, set: (f, x) => { if (drag) return; v = Number.isFinite(f) ? f : 0; paint(v, x); }, dragging: () => drag };
}

/** Hide controls after a few idle seconds while playing; any movement shows them. */
export function autoHide(root: HTMLElement, isPlaying: () => boolean, ms = 3000): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  const wake = () => {
    root.classList.remove('vp-idle');
    if (t) clearTimeout(t);
    t = setTimeout(() => { if (isPlaying() && !root.querySelector('.vp-menu,.vp-panel:not([hidden])') && !root.matches(':focus-within .vp-bar *')) root.classList.add('vp-idle'); }, ms);
  };
  const evs = ['pointermove', 'pointerdown', 'keydown', 'focusin'];
  evs.forEach((e) => root.addEventListener(e, wake));
  wake();
  return () => { evs.forEach((e) => root.removeEventListener(e, wake)); if (t) clearTimeout(t); };
}

// ---------------------------------------------------------------- up next
/**
 * The Up next / Coming up card.
 *
 *   overlay  floats over a picture (the video and event skins): bottom right,
 *            artwork, "Starts in 2 min", the title, Play now / Cancel.
 *   banner   sits inside an audio layout: slides in under the station's own
 *            panel, "Coming up in 2 min · 18:30", the title, a dismiss button.
 *
 * Both show the same facts the same way:
 *   - a programme says when it starts ("Starts in 2 min", and the clock time when
 *     known), an item says when it plays ("Next in 8 s") or just "Up next";
 *   - the bar runs over the card's own life when the stream times the card
 *     (shownMs / totalMs), else over the countdown (1 - inMs / totalMs).
 *
 * Diffed, so update() is cheap on every state change.
 */
export interface UpNextCard { el: HTMLElement; update(st: PlayerState): void }

export function upNextProgress(u: UpNext): number {
  const f = u.shownMs != null ? u.shownMs / Math.max(1, u.totalMs) : 1 - u.inMs / Math.max(1, u.totalMs);
  return Math.max(0, Math.min(1, f));
}

export function upNextKicker(u: UpNext, t: SkinContext['t'], variant: 'overlay' | 'banner' = 'overlay'): string {
  if (u.kind === 'item') return u.autoAdvance ? t('nextIn', { time: inOf(u.inMs) }) : t('upNext');
  if (variant === 'banner') return u.inMs > 0 ? t('comingUpIn', { time: inOf(u.inMs) }) : t('comingUp');
  return u.inMs > 0 ? t('startsIn', { time: inOf(u.inMs) }) : t('upNext');
}

export function upNextCard(c: SkinContext, variant: 'overlay' | 'banner' = 'overlay'): UpNextCard {
  const k = c.commands;
  const img = el('img', undefined, { alt: '' });
  const kick = el('small'); const title = el('b'); const sub = el('span'); const at = el('time');
  const fill = el('i');
  const stop = (e: Event) => e.stopPropagation();
  let root: HTMLElement;
  let go: HTMLButtonElement | null = null;
  if (variant === 'overlay') {
    go = el('button', 'go', { type: 'button' }, c.t('playNow'));
    go.addEventListener('click', (e) => { stop(e); k.next(); });
    const cancel = el('button', undefined, { type: 'button' }, c.t('cancel'));
    cancel.addEventListener('click', (e) => { stop(e); k.cancelUpNext(); });
    root = el('div', 'vpv-up', { role: 'status', 'aria-live': 'polite' },
      el('div', 'vpv-up-b', undefined, img, el('div', undefined, undefined, kick, title, sub, at)),
      el('div', 'vpv-up-a', undefined, go, cancel),
      el('div', 'vpv-up-p', undefined, fill));
  } else {
    const x = button('close', c.t('dismiss'), (e) => { stop(e); k.cancelUpNext(); }, 'vp-btn vpx-up-x', 18);
    root = el('div', 'vpx-up', { role: 'status', 'aria-live': 'polite' },
      img, el('div', 'vpx-up-t', undefined, kick, title, sub), at, x,
      el('div', 'vpx-up-p', undefined, fill));
  }
  root.addEventListener('click', stop);
  root.hidden = true;
  let lastKey = '';
  return {
    el: root,
    update(st) {
      const u = st.upNext;
      show(root, !!u);
      root.classList.toggle('in', !!u);
      if (!u) { lastKey = ''; return; }
      text(kick, upNextKicker(u, c.t, variant));
      fill.style.width = `${(upNextProgress(u) * 100).toFixed(1)}%`;
      const key = `${u.title}|${u.subtitle ?? ''}|${u.artworkUrl ?? ''}|${u.startsAt ?? ''}|${u.kind}`;
      if (key === lastKey) return;
      lastKey = key;
      text(title, u.title);
      text(sub, u.subtitle ?? ''); show(sub, !!u.subtitle);
      text(at, u.startsAt ? clockOf(u.startsAt) : ''); show(at, !!u.startsAt);
      if (u.startsAt) at.setAttribute('datetime', new Date(u.startsAt).toISOString());
      const im = img as HTMLImageElement;
      if (u.artworkUrl) { if (im.getAttribute('src') !== u.artworkUrl) im.src = u.artworkUrl; im.hidden = false; } else im.hidden = true;
      if (go) show(go, u.kind === 'item');
    },
  };
}

// ---------------------------------------------------------------- skip
/**
 * "Skip intro" / "Skip recap" / "Skip credits": shown while the playhead is in
 * a stretch the asset's markers call skippable (state.skip, on-demand only),
 * one press jumps past it. Hidden while an Up next card is up, which already
 * offers the way on.
 */
export function skipButton(c: SkinContext): { el: HTMLButtonElement; update(st: PlayerState): void } {
  const b = el('button', 'vp-skip', { type: 'button' });
  const lab = el('span');
  b.append(lab, icon('next', 16));
  b.addEventListener('click', (e) => { e.stopPropagation(); c.commands.skip(); });
  b.hidden = true;
  let shown = '';
  return {
    el: b,
    update(st) {
      const sk = st.skip;
      const on = !!sk && !st.upNext && !st.live;
      show(b, on);
      if (!on || !sk) { shown = ''; return; }
      if (shown !== sk.id) {
        shown = sk.id;
        const key = sk.kind === 'intro' ? 'skipIntro' : sk.kind === 'recap' ? 'skipRecap' : sk.kind === 'credits' ? 'skipCredits' : 'skip';
        text(lab, c.t(key));
        b.setAttribute('aria-label', c.t(key));
      }
    },
  };
}

let styled = false;
export function injectBaseStyles(): void {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const s = document.createElement('style');
  s.id = 'volt-player-styles';
  s.textContent = CSS;
  document.head.appendChild(s);
}

const CSS = `
.vp{position:relative;font-family:var(--vp-font);color:var(--vp-text);-webkit-font-smoothing:antialiased;outline:none;line-height:1.35;font-size:14px;box-sizing:border-box}
.vp *,.vp *::before,.vp *::after{box-sizing:border-box}
.vp [hidden]{display:none!important}
:where(.vp) button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0;margin:0}
.vp .vp-stage{position:relative;background:#000;overflow:hidden}
.vp .vp-media{display:block;width:100%;height:100%;object-fit:contain;background:#000}
.vp .shaka-text-container{position:absolute;left:0;right:0;top:0;bottom:6%;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;font-size:clamp(14px,3.6cqw,30px);line-height:1.35;color:#fff;z-index:3;transition:bottom .25s}
.vp .shaka-text-container>div,.vp .shaka-text-container span{font-family:var(--vp-font)}
.vp .shaka-text-container span.shaka-text-wrapper{background:rgba(8,10,14,.78);padding:.08em .4em;border-radius:4px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.vp:is([data-skin=video],[data-skin=event]):not(.vp-idle) .shaka-text-container{bottom:max(6%,92px)}
.vp .vp-stage{container-type:inline-size}
.vp .vp-gfx{position:absolute;overflow:hidden;pointer-events:none;z-index:1}
.vp .vp-watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;color:rgba(255,255,255,.16);font-size:clamp(14px,3.2vw,28px);font-weight:800;transform:rotate(-18deg);white-space:nowrap;z-index:2}
.vp .vp-btn{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:999px;position:relative;flex:none;transition:background .15s}
.vp .vp-btn:hover,.vp .vp-btn:focus-visible{background:rgba(255,255,255,.14)}
.vp .vp-btn:focus-visible,.vp .vp-sl:focus-visible,.vp .vp-menu-i:focus-visible{outline:2px solid var(--vp-primary);outline-offset:2px}
.vp:has(.vp-menu) [data-tip]:hover::after{display:none}
.vp [data-tip]:not(.vp-menu-i):hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);background:rgba(10,12,16,.92);color:#fff;font-size:12px;font-weight:600;padding:5px 8px;border-radius:6px;white-space:nowrap;pointer-events:none;z-index:20}
.vp .vp-btn.on{color:var(--vp-primary)}
.vp .vp-sl{position:relative;height:18px;display:flex;align-items:center;cursor:pointer;touch-action:none}
.vp .vp-sl-track{position:relative;width:100%;height:4px;border-radius:4px;background:rgba(255,255,255,.28);overflow:hidden;transition:height .12s}
.vp .vp-sl:hover .vp-sl-track,.vp .vp-sl.drag .vp-sl-track{height:6px}
.vp .vp-sl-extra{position:absolute;left:0;top:0;bottom:0;background:rgba(255,255,255,.35)}
.vp .vp-sl-fill{position:absolute;left:0;top:0;bottom:0;background:var(--vp-primary)}
.vp .vp-sl-thumb{position:absolute;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:var(--vp-primary);box-shadow:0 0 0 3px rgba(0,0,0,.25);transform:scale(0);transition:transform .12s}
.vp .vp-sl:hover .vp-sl-thumb,.vp .vp-sl.drag .vp-sl-thumb,.vp .vp-sl:focus-visible .vp-sl-thumb{transform:scale(1)}
.vp .vp-menu{position:absolute;z-index:30;min-width:180px;max-height:70%;overflow:auto;background:rgba(14,16,22,.96);color:#fff;border-radius:12px;padding:6px;box-shadow:0 12px 40px rgba(0,0,0,.45)}
.vp .vp-menu-h{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.55);padding:8px 10px 6px}
.vp .vp-menu-i{display:flex;width:100%;justify-content:space-between;gap:16px;padding:9px 10px 9px 30px;border-radius:8px;text-align:left;position:relative}
.vp .vp-menu-i:hover,.vp .vp-menu-i:focus{background:rgba(255,255,255,.1);outline:none}
.vp .vp-menu-i.on::before{content:"";position:absolute;left:11px;top:50%;width:8px;height:8px;margin-top:-4px;border-radius:50%;background:var(--vp-primary)}
.vp .vp-menu-d{color:rgba(255,255,255,.55);font-size:12px}
.vp .vp-spin{width:46px;height:46px;border-radius:50%;border:3px solid rgba(255,255,255,.25);border-top-color:var(--vp-primary);animation:vp-spin 0.9s linear infinite}
@keyframes vp-spin{to{transform:rotate(360deg)}}
.vp .vp-live{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:800;letter-spacing:.06em;padding:4px 9px;border-radius:999px;background:rgba(255,255,255,.14);color:#fff;white-space:nowrap}
.vp .vp-live::before{content:"";width:8px;height:8px;border-radius:50%;background:#9aa3b2}
.vp .vp-live.edge::before{background:#ef4444;box-shadow:0 0 0 0 rgba(239,68,68,.6);animation:vp-pulse 1.8s infinite}
.vp button.vp-live:hover{background:rgba(255,255,255,.24)}
@keyframes vp-pulse{70%{box-shadow:0 0 0 7px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}

/* ---- video skin (front end) ---- */
.vp:is([data-skin=video],[data-skin=event]){aspect-ratio:16/9;background:#000;border-radius:var(--vp-radius);overflow:hidden;color:#fff}
.vp:is([data-skin=video],[data-skin=event]):fullscreen,.vp:is([data-skin=video],[data-skin=event]):-webkit-full-screen{border-radius:0;aspect-ratio:auto;width:100%;height:100%}
.vpv{position:absolute;inset:0;user-select:none}
.vpv .vp-stage{position:absolute;inset:0}
.vpv-shade{position:absolute;inset:0;pointer-events:none;background:linear-gradient(to bottom,rgba(0,0,0,.55),transparent 22%,transparent 62%,rgba(0,0,0,.7));transition:opacity .25s;z-index:3}
.vpv-top{position:absolute;left:0;right:0;top:0;display:flex;align-items:flex-start;gap:12px;padding:14px 16px;z-index:5;transition:opacity .25s}
.vpv-title{flex:1;min-width:0}
.vpv-title b{display:block;font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.vpv-title span{display:block;font-size:13px;color:rgba(255,255,255,.75);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vpv-logo{max-height:34px;max-width:140px;object-fit:contain;flex:none}
.vpv-logo.br{position:absolute;right:16px;bottom:78px;opacity:.85;z-index:4;pointer-events:none}
.vpv-center{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:4;pointer-events:none}
.vpv-center>*{pointer-events:auto}
.vpv-big{width:72px;height:72px;border-radius:50%;background:var(--vp-primary);color:var(--vp-primary-ink);display:flex;align-items:center;justify-content:center;box-shadow:0 8px 30px rgba(0,0,0,.4);transition:transform .15s}
.vpv-big:hover{transform:scale(1.06)}
.vpv-msg{max-width:min(440px,86%);text-align:center;background:rgba(10,12,16,.82);border-radius:14px;padding:18px 22px}
.vpv-msg p{margin:0 0 12px;font-size:15px}
.vpv-msg .vp-pill{background:var(--vp-primary);color:var(--vp-primary-ink);border-radius:999px;padding:8px 16px;font-weight:700}
.vpv-bar{position:absolute;left:0;right:0;bottom:0;padding:0 12px 8px;z-index:6;transition:opacity .25s,transform .25s}
.vpv-row{display:flex;align-items:center;gap:2px}
.vpv-time{font-size:13px;font-variant-numeric:tabular-nums;padding:0 8px;white-space:nowrap;color:rgba(255,255,255,.9)}
.vpv-spacer{flex:1}
.vpv-vol{display:flex;align-items:center}
.vpv-vol .vp-sl{width:0;opacity:0;transition:width .2s,opacity .2s;margin-right:4px}
.vpv-vol:hover .vp-sl,.vpv-vol:focus-within .vp-sl{width:76px;opacity:1}
.vpv-prog{position:relative;margin:0 6px 2px}
.vpv-tip{position:absolute;bottom:22px;transform:translateX(-50%);background:rgba(10,12,16,.92);font-size:12px;font-weight:600;padding:4px 7px;border-radius:6px;pointer-events:none;white-space:nowrap}
.vpv-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.14);margin-left:4px;white-space:nowrap}
.vpv-chip:hover{background:rgba(255,255,255,.24)}
.vp-idle .vpv-bar,.vp-idle .vpv-top,.vp-idle .vpv-shade{opacity:0;pointer-events:none}
.vp-idle .vpv-bar{transform:translateY(8px)}
.vp-idle{cursor:none}
.vpv-up{position:absolute;right:16px;bottom:84px;z-index:7;width:min(320px,70%);background:rgba(14,16,22,.94);border-radius:calc(var(--vp-radius) - 2px);overflow:hidden;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.45)}
.vpv-up-b{display:flex;gap:12px;padding:12px}
.vpv-up img{width:96px;height:54px;object-fit:cover;border-radius:6px;flex:none;background:#222}
.vpv-up small{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--vp-primary)}
.vpv-up b{display:block;font-size:14px;line-height:1.3;max-height:2.6em;overflow:hidden}
.vpv-up span{font-size:12px;color:rgba(255,255,255,.65)}
.vp .vp-skip{position:absolute;right:16px;bottom:84px;z-index:7;display:inline-flex;align-items:center;gap:6px;padding:10px 14px 10px 18px;border-radius:999px;background:rgba(14,16,22,.82);border:1px solid rgba(255,255,255,.28);color:#fff;font-weight:700;font-size:14px;letter-spacing:.01em;backdrop-filter:blur(6px);box-shadow:0 8px 28px rgba(0,0,0,.35);animation:vp-skip-in .25s ease-out}
.vp .vp-skip:hover,.vp .vp-skip:focus-visible{background:#fff;color:#0b0d12;border-color:#fff}
.vp .vp-skip svg{width:16px;height:16px}
@keyframes vp-skip-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.vp .vp-skip{animation:none}}
.vpa .vp-skip{bottom:14px;right:14px;padding:7px 12px 7px 14px;font-size:13px}
.vpv-up time{display:block;font-size:11px;color:rgba(255,255,255,.5);font-variant-numeric:tabular-nums;margin-top:2px}
.vpv-up-a{display:flex;gap:8px;padding:0 12px 12px}
.vpv-up-a button{flex:1;padding:8px;border-radius:8px;background:rgba(255,255,255,.12);font-weight:700;font-size:13px}
.vpv-up-a button.go{background:var(--vp-primary);color:var(--vp-primary-ink)}
.vpv-up-p{height:3px;background:rgba(255,255,255,.12)}
.vpv-up-p i{display:block;height:100%;background:var(--vp-primary);transition:width .5s linear}
.vp-panel{position:absolute;top:0;right:0;bottom:0;width:min(340px,82%);background:rgba(12,14,19,.96);z-index:8;display:flex;flex-direction:column;box-shadow:-10px 0 40px rgba(0,0,0,.4)}
.vp-panel-h{display:flex;align-items:center;justify-content:space-between;padding:12px 8px 8px 16px;font-weight:700}
.vp-panel-l{overflow:auto;flex:1;padding:0 8px 12px}
.vp-prog{display:flex;gap:10px;width:100%;text-align:left;padding:10px 8px;border-radius:10px;align-items:flex-start}
.vp-prog:hover{background:rgba(255,255,255,.07)}
.vp-prog.now{background:rgba(255,255,255,.1)}
.vp-prog time{font-size:12px;font-variant-numeric:tabular-nums;color:rgba(255,255,255,.6);min-width:64px;white-space:nowrap;flex:none;padding-top:1px}
.vp-prog b{display:block;font-size:14px;font-weight:600}
.vp-prog span{display:block;font-size:12px;color:rgba(255,255,255,.6)}
.vp-prog em{font-style:normal;font-size:11px;font-weight:800;letter-spacing:.06em;color:var(--vp-primary);text-transform:uppercase}
.vp-prog .bar{height:3px;border-radius:3px;background:rgba(255,255,255,.15);margin-top:6px;overflow:hidden}
.vp-prog .bar i{display:block;height:100%;background:var(--vp-primary)}

/* ---- event skin: the phases over the promo ---- */
.vpe{position:absolute;inset:0;z-index:9;color:#fff;overflow:hidden;background:#0b0e13;container-type:inline-size}
/* While the event page covers the player it sets the height: at least 16:9,
   taller when a phone-width player needs the room (countdown + offers). */
.vp[data-skin=event].vpe-open{aspect-ratio:auto}
.vpe-open .vpe{position:relative;inset:auto;display:grid}
.vpe::before{content:"";grid-area:1/1;padding-top:56.25%}
.vpe-open .vpe-in{position:relative;inset:auto;grid-area:1/1}
.vpe-poster{position:absolute;inset:0;background:#0b0e13 center/cover no-repeat}
.vpe-shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(6,8,12,.92) 0%,rgba(6,8,12,.72) 45%,rgba(6,8,12,.25) 100%),linear-gradient(0deg,rgba(6,8,12,.7),transparent 55%)}
.vpe-logo{position:absolute;top:18px;right:20px;max-height:36px;max-width:150px;object-fit:contain}
.vpe-in{position:absolute;inset:0;padding:clamp(16px,4cqw,36px);display:flex;gap:28px;align-items:safe center;overflow:auto}
.vpe-info{flex:1 1 auto;max-width:600px;display:flex;flex-direction:column;gap:10px;margin:auto 0}
.vpe-top{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.vpe-kick{font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.75)}
.vpe-badge{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:4px 9px;border-radius:999px;background:var(--vp-primary);color:var(--vp-primary-ink)}
.vpe-badge[data-kind=bad]{background:#dc2626;color:#fff}.vpe-badge[data-kind=warn]{background:#f59e0b;color:#111}
.vpe-title{margin:0;font-size:clamp(20px,4.6cqw,40px);line-height:1.1;font-weight:800;letter-spacing:-.01em}
.vpe-sub{font-size:14px;color:rgba(255,255,255,.78)}
.vpe-sides{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:4px 0}
.vpe-sides.vs{gap:18px}
.vpe-side{display:flex;align-items:center;gap:10px}
.vpe-side img{width:clamp(32px,6cqw,56px);height:clamp(32px,6cqw,56px);object-fit:contain}
.vpe-side b{display:block;font-size:clamp(14px,2.2cqw,18px)}.vpe-side span{display:block;font-size:12px;color:rgba(255,255,255,.65)}
.vpe-sep{font-style:normal;font-weight:800;color:rgba(255,255,255,.55);text-transform:uppercase;font-size:13px}
.vpe-cdl{margin-top:6px;font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--vp-primary);filter:brightness(1.25)}
.vpe-cd{display:flex;gap:8px}
.vpe-tile{min-width:clamp(52px,9cqw,76px);padding:8px 6px;border-radius:calc(var(--vp-radius) - 4px);background:rgba(255,255,255,.1);backdrop-filter:blur(6px);text-align:center}
.vpe-tile b{display:block;font-size:clamp(22px,4.6cqw,38px);font-weight:800;font-variant-numeric:tabular-nums;line-height:1.05}
.vpe-tile small{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.65)}
.vpe-msg{margin:4px 0 0;font-size:14px;color:rgba(255,255,255,.85);max-width:52ch}
.vpe-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.vpe-btn{background:var(--vp-primary);color:var(--vp-primary-ink);font-weight:700;font-size:14px;padding:10px 16px;border-radius:999px}
.vpe-btn.ghost{background:rgba(255,255,255,.14);color:#fff}
.vpe-btn:hover{filter:brightness(1.08)}
.vpe-buy{flex:0 0 min(340px,42%);align-self:flex-end;background:rgba(10,12,16,.78);backdrop-filter:blur(8px);border-radius:calc(var(--vp-radius) - 2px);padding:14px;display:flex;flex-direction:column;gap:8px}
.vpe-buyt{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.7)}
.vpe-offer{display:flex;align-items:center;gap:12px;padding:8px 4px;border-top:1px solid rgba(255,255,255,.1)}
.vpe-offer:first-child{border-top:0}
.vpe-offer>div{flex:1;min-width:0}.vpe-offer b{display:block;font-size:14px}.vpe-offer span{font-size:12px;color:rgba(255,255,255,.6)}
.vpe-offer strong{font-size:15px;font-variant-numeric:tabular-nums}
.vpe-offer .vpe-btn{padding:8px 14px;font-size:13px}
.vpe-link{align-self:flex-start;color:rgba(255,255,255,.75);font-size:12px;text-decoration:underline}
.vpe .vp-spin{width:30px;height:30px}
@container (max-width:640px){.vpe-logo{max-height:22px;top:12px;right:14px}.vpe-in{padding-top:46px}.vpe-in{flex-direction:column;align-items:stretch;gap:14px}.vpe-info{margin:0;max-width:none}.vpe-buy{flex:none;align-self:stretch}.vpe-shade{background:linear-gradient(0deg,rgba(6,8,12,.95) 15%,rgba(6,8,12,.55))}.vpe-sub,.vpe-msg{font-size:12px}}

/* ---- admin skin (console) ---- */
.vp[data-skin=admin]{background:#000;border-radius:10px;overflow:hidden;color:#e6e9ef}
.vpa .vp-stage{aspect-ratio:16/9;max-height:var(--vp-admin-max,430px);width:100%}
.vpa.audio .vp-stage{display:none}
.vpa-ov{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.vpa-ov>*{pointer-events:auto}
.vpa-err{background:rgba(0,0,0,.75);color:#fca5a5;padding:10px 14px;border-radius:8px;font-size:13px;max-width:80%;text-align:center}
.vpa-stats{position:absolute;left:8px;top:8px;background:rgba(0,0,0,.72);font:12px/1.5 ui-monospace,Menlo,monospace;padding:6px 9px;border-radius:6px;color:#d1fae5;pointer-events:none;white-space:pre}
.vpa-bar{background:#11141a;padding:4px 8px 6px;border-top:1px solid rgba(255,255,255,.06)}
.vpa-bar .vp-btn{width:34px;height:34px}
.vpa-bar .vp-btn:hover{background:rgba(255,255,255,.1)}
.vpa-row{display:flex;align-items:center;gap:2px}
.vpa-time{font:12px ui-monospace,Menlo,monospace;color:#aab2c0;padding:0 8px;white-space:nowrap}
.vpa-q{font:12px ui-monospace,Menlo,monospace;color:#aab2c0;padding:0 6px;white-space:nowrap}
.vpa-bar .vp-sl{margin:2px 4px}
.vpa .vpv-vol .vp-sl{width:70px;opacity:1}

/* ---- audio skins ---- */
.vp[data-skin^=audio]{color:var(--vp-text)}
.vpx{background:var(--vp-bg);border-radius:var(--vp-radius);overflow:hidden;position:relative}
.vpx .vp-stage{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.vpx-art{background:rgba(127,127,127,.2) center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:var(--vp-muted)}
.vpx-play{width:52px;height:52px;border-radius:50%;background:var(--vp-primary);color:var(--vp-primary-ink);display:flex;align-items:center;justify-content:center;flex:none;box-shadow:0 6px 18px rgba(0,0,0,.25)}
.vpx-play:hover{filter:brightness(1.08)}
.vpx-play.busy{background:transparent;box-shadow:none}
.vpx-play .vp-spin{width:40px;height:40px}
.vpx-t b{display:block;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vpx-t span{display:block;color:var(--vp-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vpx-err{color:#f87171;font-size:12px}
.vpx .vp-live{background:var(--vp-secondary);color:var(--vp-secondary-ink);border:1px solid rgba(127,127,127,.3)}
.vpx .vp-btn:hover{background:rgba(127,127,127,.18)}
.vpx .vp-sl-track{background:rgba(127,127,127,.35)}
/* square */
.vpx.sq{width:100%;max-width:360px;aspect-ratio:1/1;display:flex;flex-direction:column}
.vpx.sq .vpx-art{position:absolute;inset:0}
.vpx.sq .vpx-fade{position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,.05) 35%,rgba(0,0,0,.82))}
.vpx.sq .vpx-in{position:absolute;left:0;right:0;bottom:0;padding:16px;display:flex;align-items:flex-end;gap:12px;color:#fff}
.vpx.sq .vpx-t{flex:1;min-width:0}.vpx.sq .vpx-t b{font-size:18px}.vpx.sq .vpx-t span{color:rgba(255,255,255,.75)}
.vpx.sq .vpx-top{position:absolute;top:12px;left:12px;right:12px;display:flex;justify-content:space-between;align-items:center}
.vpx.sq .vpx-top img{max-height:28px;max-width:120px;object-fit:contain}
/* wave */
.vpx.wv{display:flex;align-items:center;gap:14px;padding:12px 14px;min-height:88px}
.vpx.wv .vpx-art{width:64px;height:64px;border-radius:calc(var(--vp-radius) - 4px);flex:none}
.vpx.wv .vpx-mid{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.vpx.wv canvas{width:100%;height:34px;display:block}
.vpx.wv .vpx-t b{font-size:15px}.vpx.wv .vpx-t span{font-size:13px}
.vpx.wv .vpx-side{display:flex;align-items:center;gap:4px;flex:none}
/* now playing */
.vpx.np{padding:18px;display:grid;grid-template-columns:minmax(120px,200px) 1fr;gap:18px}
@container (max-width:520px){.vpx.np{grid-template-columns:1fr}}
.vpx.np>.vpx-art{aspect-ratio:1/1;border-radius:calc(var(--vp-radius) - 2px)}
.vpx.np .vpx-head{display:flex;flex-direction:column;gap:6px;min-width:0}
.vpx.np .vpx-kick{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--vp-primary)}
.vpx.np .vpx-t b{font-size:22px;white-space:normal}.vpx.np .vpx-t span{font-size:15px}
.vpx.np .vpx-meta{font-size:13px;color:var(--vp-muted)}
.vpx.np .vpx-ctl{display:flex;align-items:center;gap:8px;margin-top:8px}
.vpx.np .vpx-ctl .vpv-vol .vp-sl{width:90px;opacity:1}
.vpx.np .vpx-lists{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:18px}
@container (max-width:520px){.vpx.np .vpx-lists{grid-template-columns:1fr}}
.vpx.np h4{margin:0 0 8px;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--vp-muted)}
.vpx-li{display:flex;gap:10px;align-items:center;padding:6px 0;border-top:1px solid rgba(127,127,127,.18)}
.vpx-li:first-of-type{border-top:0}
.vpx-li .vpx-art{width:40px;height:40px;border-radius:6px;flex:none}
.vpx .vpx-li .vpx-t{flex:1;min-width:0}.vpx .vpx-li .vpx-t b{font-size:13px;font-weight:600;white-space:nowrap}.vpx .vpx-li .vpx-t span{font-size:12px}
.vpx-li time{font-size:12px;color:var(--vp-muted);font-variant-numeric:tabular-nums}
.vpx-empty{font-size:13px;color:var(--vp-muted)}
.vp[data-skin^=audio]{container-type:inline-size}

/* the Coming up banner (kit.upNextCard 'banner'), inside the audio layouts */
.vpx-up{position:relative;display:grid;grid-template-columns:auto 1fr auto auto;align-items:center;gap:12px;padding:10px 10px 12px 12px;border-radius:calc(var(--vp-radius) - 4px);background:color-mix(in srgb,var(--vp-primary) 14%,var(--vp-bg));border:1px solid color-mix(in srgb,var(--vp-primary) 40%,transparent);overflow:hidden;animation:vpx-up-in .35s ease-out}
@keyframes vpx-up-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.vpx-up{animation:none}}
.vpx-up img{width:52px;height:52px;border-radius:6px;object-fit:cover;background:rgba(127,127,127,.2)}
.vpx-up-t{min-width:0}
.vpx-up small{display:block;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--vp-primary)}
.vpx-up b{display:block;font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vpx-up span{display:block;font-size:12px;color:var(--vp-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vpx-up time{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--vp-text)}
.vpx-up .vpx-up-x{width:30px;height:30px;color:var(--vp-muted)}
.vpx-up-p{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(127,127,127,.18)}
.vpx-up-p i{display:block;height:100%;background:var(--vp-primary);transition:width .5s linear}

/* RADIO (audio_radio): a station player. Header, on-air panel with the
   programme's progress, controls with a waveform, Coming up, then later. */
.vpx.rd{padding:16px;display:flex;flex-direction:column;gap:14px}
.vpx.rd .vpx-rd-h{display:flex;align-items:center;gap:10px;min-height:28px}
.vpx.rd .vpx-rd-h img{max-height:28px;max-width:140px;object-fit:contain}
.vpx.rd .vpx-rd-h .vpx-station{font-weight:800;font-size:15px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vpx.rd .vpx-rd-m{display:grid;grid-template-columns:clamp(84px,24cqw,150px) 1fr;gap:16px;align-items:center}
.vpx.rd .vpx-rd-m>.vpx-art{aspect-ratio:1/1;border-radius:calc(var(--vp-radius) - 4px)}
.vpx.rd .vpx-kick{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--vp-primary);display:flex;align-items:center;gap:6px}
.vpx.rd .vpx-kick i{width:7px;height:7px;border-radius:50%;background:currentColor;animation:vpx-pulse 1.6s ease-in-out infinite}
@keyframes vpx-pulse{50%{opacity:.35}}
.vpx.rd .vpx-t b{font-size:clamp(17px,4.4cqw,24px);white-space:normal;line-height:1.2;margin-top:4px}
.vpx.rd .vpx-t span{font-size:14px;margin-top:2px}
.vpx.rd .vpx-rd-prog{margin-top:10px;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:8px;font-size:12px;color:var(--vp-muted);font-variant-numeric:tabular-nums}
.vpx.rd .vpx-rd-bar{height:4px;border-radius:2px;background:rgba(127,127,127,.25);overflow:hidden}
.vpx.rd .vpx-rd-bar i{display:block;height:100%;background:var(--vp-primary);transition:width 1s linear}
.vpx.rd .vpx-rd-left{font-size:12px;color:var(--vp-muted);margin-top:4px}
.vpx.rd .vpx-rd-c{display:flex;align-items:center;gap:10px}
.vpx.rd .vpx-rd-c canvas{flex:1;min-width:0;height:36px;display:block}
.vpx.rd .vpx-rd-c .vpv-vol .vp-sl{width:80px;opacity:1}
.vpx.rd .vpx-rd-next{font-size:13px;color:var(--vp-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vpx.rd .vpx-rd-next b{color:var(--vp-text);font-weight:600}
.vpx.rd h4{margin:0 0 6px;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--vp-muted)}
@container (max-width:420px){.vpx.rd .vpx-rd-m{grid-template-columns:72px 1fr;gap:12px}.vpx.rd .vpx-rd-c .vpv-vol{display:none}.vpx-up{grid-template-columns:auto 1fr auto}.vpx-up time{display:none}}
`;
