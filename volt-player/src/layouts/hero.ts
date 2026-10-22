// ============================================================================
//  THE HERO LAYOUT.
//
//  Full width, large artwork behind a blurred wash. For a station's own landing
//  page, where the player IS the page rather than a component on it.
//
//  ------------------------------------------------------------------------
//  THE WASH IS THE STATION'S SURFACE COLOUR, NOT A BLACK SCRIM.
//
//  The background is the same artwork, blurred and enlarged, which is what
//  gives the panel its colour and makes every station look like itself. Over
//  it sits an opaque-enough layer of the configured surface colour, and that
//  is deliberate: the ink colour was computed from the surface (see
//  `../tokens.ts`), so the surface has to be what dominates. A black scrim over
//  a pale brand would leave dark computed ink on a dark panel.
//
//  Artwork can be missing, and often is. Nothing here depends on it: the wash
//  falls back to flat surface colour and the panel still reads.
// ============================================================================
import type { Layout, LayoutContext, LayoutState } from '../types';
import {
  artworkImage, baseRules, el, instanceClass, metaLine, playButton,
  scopedStyle, setArtwork, setPlayState, statusLine, volumeSlider,
} from './shared';
import { aspectRatio } from '../tokens';
import { listenEl, setListen, LISTEN_CSS } from './listen';
import { createPhase, phaseRules } from './phase';

export function heroLayout(): Layout {
  const cls = instanceClass('hero');
  let ctx: LayoutContext;
  let box: HTMLElement;
  let coverWrap: HTMLElement;
  let text: HTMLElement;
  let controls: HTMLElement;
  let phase: ReturnType<typeof createPhase>;
  let bg: HTMLImageElement;
  let cover: HTMLImageElement;
  let primary: HTMLElement;
  let secondary: HTMLElement;
  let meta: HTMLElement;
  let listen: HTMLAnchorElement;
  let live: HTMLElement;
  let btn: HTMLButtonElement;
  let status: HTMLElement;

  return {
    mount(c: LayoutContext) {
      ctx = c;
      const shell = el('div', cls);
      scopedStyle(c.root, cls, baseRules() + phaseRules() + rules());

      box = el('div', 'vp-box');
      // A reserved rectangle, when one was asked for. The countdown, the
      // "event has finished" message and the video all occupy exactly the same
      // box, so nothing on the host page moves at the moment the stream
      // starts, which is the moment everyone is looking at it.
      if (aspectRatio((c.config.options as any)?.aspect) !== 'auto') {
        box.classList.add('vp-fixed-aspect');
      }

      bg = artworkImage();
      bg.className = 'vp-bg';
      const wash = el('div', 'vp-wash');

      const fg = el('div', 'vp-fg');

      coverWrap = el('div', 'vp-cover');
      cover = artworkImage();
      coverWrap.appendChild(cover);

      text = el('div', 'vp-text');
      live = el('span', 'vp-live');
      live.textContent = 'ON AIR';
      live.style.display = 'none';
      primary = el('h2', 'vp-primary');
      secondary = el('div', 'vp-secondary');
      meta = el('div', 'vp-meta');
      listen = listenEl();
      text.append(live, primary, secondary, meta, listen);

      controls = el('div', 'vp-controls');
      btn = playButton(c);
      controls.append(btn, volumeSlider(c));

      status = statusLine();

      fg.append(coverWrap, text, controls, status);
      box.append(bg, wash, fg);
      // Inside the hero, not instead of it. An event landing page built three
      // weeks ahead is the main thing this layout is for, so the countdown gets
      // the artwork and the wash rather than a plain panel that looks like
      // every other skin.
      phase = createPhase();
      phase.el.classList.add('vp-phase-inline');
      fg.appendChild(phase.el);
      shell.appendChild(box);
      c.root.appendChild(shell);

      primary.textContent = c.station.name;
      secondary.textContent = c.station.description ?? '';
      if (c.station.artworkUrl) { bg.src = c.station.artworkUrl; cover.src = c.station.artworkUrl; }
    },

    update(s: LayoutState) {
      // The phase panel takes over whenever there is nothing to play. Here it
      // swaps the hero's contents rather than the hero itself, so the panel
      // keeps the blurred artwork behind it.
      const off = phase.update(s, ctx);
      for (const n of [coverWrap, text, controls, status]) n.style.display = off ? 'none' : '';
      if (off) return;
      const np = s.nowPlaying;
      primary.textContent = np?.primary ?? ctx.station.name;
      secondary.textContent = np?.secondary ?? ctx.station.description ?? '';
      const bits = metaLine(np?.album, np?.year);
      meta.textContent = bits;
      meta.style.display = bits ? '' : 'none';
      setListen(listen, np);

      const url = np?.artworkUrl ?? ctx.station.artworkUrl ?? null;
      setArtwork(cover, url);
      setArtwork(bg, url);

      live.style.display = np?.onAir ? '' : 'none';
      setPlayState(btn, s.playing, s.loading);

      status.textContent = s.error ?? (s.loading && !s.playing ? 'Connecting…' : '');
      status.classList.toggle('vp-err', !!s.error);
    },

    destroy() { try { ctx.root.innerHTML = ''; } catch { /* */ } },
  };
}

function rules(): string {
  return `
& .vp-box {
  position: relative; overflow: hidden;
  border-radius: var(--vp-radius);
  background: var(--vp-surface);
  width: 100%; min-height: 260px;
  isolation: isolate;
}
/* The floor is dropped when a ratio is set, because on a narrow phone a
   260px minimum would be taller than 16:9 and would quietly break the ratio
   on exactly the devices where holding it matters most. */
& .vp-box.vp-fixed-aspect {
  aspect-ratio: var(--vp-aspect, 16 / 9);
  min-height: 0;
}
& .vp-box.vp-fixed-aspect .vp-fg { height: 100%; min-height: 0; }
& .vp-bg {
  position: absolute; inset: -12%; width: 124%; height: 124%;
  object-fit: cover; display: block;
  filter: blur(34px) saturate(1.35);
  transform: scale(1.06);
  z-index: 0;
}
& .vp-wash {
  position: absolute; inset: 0; z-index: 1;
  background: var(--vp-surface); opacity: .74;
}
& .vp-fg {
  position: relative; z-index: 2;
  display: flex; align-items: center; flex-wrap: wrap;
  gap: calc(var(--vp-gap) * 1.4);
  padding: calc(var(--vp-pad) * 1.8);
  min-height: 260px;
}
& .vp-cover {
  width: 150px; height: 150px; flex: none;
  border-radius: calc(var(--vp-radius) * 0.85); overflow: hidden;
  background: var(--vp-ink-faint);
  box-shadow: 0 14px 40px rgba(0,0,0,.34);
}
& .vp-cover img {
  width: 100%; height: 100%; object-fit: cover; display: block;
  transition: opacity .2s ease;
}
& .vp-text { min-width: 0; flex: 1 1 220px; }
& .vp-live {
  display: inline-block; margin-bottom: 8px;
  font-size: 10px; font-weight: 700; letter-spacing: .1em;
  padding: 4px 8px; border-radius: 5px;
  background: var(--vp-primary); color: var(--vp-accent-on);
}
& .vp-primary {
  margin: 0; font-size: 26px; line-height: 1.15; font-weight: 700;
  letter-spacing: -.01em;
  overflow-wrap: anywhere;
}
& .vp-secondary { color: var(--vp-ink-dim); margin-top: 6px; font-size: 15px; }
& .vp-meta { color: var(--vp-ink-dim); font-size: 13px; margin-top: 4px; }
& .vp-controls {
  flex: none; display: flex; align-items: center; gap: 14px;
}
& .vp-play {
  width: calc(var(--vp-hit) * 1.5); height: calc(var(--vp-hit) * 1.5);
  box-shadow: 0 8px 24px rgba(0,0,0,.28);
}
& .vp-play svg { width: calc(var(--vp-icon) * 1.5); height: calc(var(--vp-icon) * 1.5); }
& .vp-vol { width: 96px; }
& .vp-status {
  position: absolute; left: calc(var(--vp-pad) * 1.8); bottom: 10px;
  margin-top: 0;
}
@media (max-width: 560px) {
& .vp-fg { gap: var(--vp-gap); padding: var(--vp-pad); }
& .vp-cover { width: 96px; height: 96px; }
& .vp-primary { font-size: 20px; }
& .vp-vol { display: none; }
}
@media (prefers-reduced-motion: reduce) {
& .vp-cover img { transition: none; }
}
${LISTEN_CSS('&')}
`;
}
