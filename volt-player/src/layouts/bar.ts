// ============================================================================
//  THE BAR LAYOUT.
//
//  One row: play, title, volume. For a site header or a sticky footer, where
//  the player is a persistent strip rather than a thing on the page.
//
//  ------------------------------------------------------------------------
//  THE TITLE SCROLLS ONLY WHEN IT HAS TO.
//
//  A bar is narrow by definition and track titles are not, so the title moves.
//  It is measured rather than assumed: a title that fits does not move, because
//  a permanently animating strip in a site header is the kind of thing people
//  ask to have turned off, and the request arrives as "your player is
//  distracting" rather than as a bug.
//
//  Under `prefers-reduced-motion` it never moves and truncates instead. That is
//  not a downgrade to apologise for: it is the same information, held still.
// ============================================================================
import type { Layout, LayoutContext, LayoutState } from '../types';
import {
  baseRules, el, instanceClass, metaLine, playButton,
  scopedStyle, setPlayState, statusLine, volumeSlider,
} from './shared';
import { createPhase, phaseRules } from './phase';

/** Pixels per second the title travels. Slow enough to read at a glance. */
const SCROLL_SPEED = 34;

export function barLayout(): Layout {
  const cls = instanceClass('bar');
  let ctx: LayoutContext;
  let box: HTMLElement;
  let phase: ReturnType<typeof createPhase>;
  let marquee: HTMLElement;
  let track: HTMLElement;
  let primary: HTMLElement;
  let secondary: HTMLElement;
  let btn: HTMLButtonElement;
  let status: HTMLElement;
  let live: HTMLElement;
  let lastText = '';

  /** Decide whether the title needs to move, and how far. Cheap, but not free,
   *  so it runs only when the text actually changed. */
  function measure(): void {
    const overflow = track.scrollWidth - marquee.clientWidth;
    if (overflow > 4) {
      marquee.style.setProperty('--vp-marq-shift', `${overflow + 16}px`);
      marquee.style.setProperty('--vp-marq-dur', `${Math.max(4, (overflow + 16) / SCROLL_SPEED)}s`);
      marquee.classList.add('vp-scroll');
    } else {
      marquee.classList.remove('vp-scroll');
    }
  }

  return {
    mount(c: LayoutContext) {
      ctx = c;
      const shell = el('div', cls);
      scopedStyle(c.root, cls, baseRules() + phaseRules() + rules(cls));

      box = el('div', 'vp-box');
      btn = playButton(c);

      live = el('span', 'vp-live');
      live.textContent = 'LIVE';
      live.style.display = 'none';

      marquee = el('div', 'vp-marquee');
      track = el('div', 'vp-track');
      primary = el('span', 'vp-primary');
      secondary = el('span', 'vp-secondary');
      track.append(primary, secondary);
      marquee.appendChild(track);

      status = statusLine();
      box.append(btn, live, marquee, status, volumeSlider(c));
      phase = createPhase();
      phase.el.classList.add('vp-phase-row');
      shell.append(box, phase.el);
      c.root.appendChild(shell);

      primary.textContent = c.station.name;
    },

    update(s: LayoutState) {
      // The phase panel takes over whenever there is nothing to play. It
      // returns false for a station or a channel, which are always live, so
      // this costs one boolean on every ordinary embed.
      if (phase.update(s, ctx)) { box.style.display = 'none'; return; }
      box.style.display = '';
      const np = s.nowPlaying;
      const p = np?.primary ?? ctx.station.name;
      const bits = [np?.secondary, metaLine(np?.album, np?.year)].filter(Boolean).join(' · ');

      // Re-measuring on every poll would reflow the host page four times a
      // minute for nothing. The text is the only thing that changes the width.
      const text = `${p} ${bits}`;
      if (text !== lastText) {
        lastText = text;
        primary.textContent = p;
        secondary.textContent = bits ? ` · ${bits}` : '';
        measure();
      }

      live.style.display = np?.onAir ? '' : 'none';
      setPlayState(btn, s.playing, s.loading);

      status.textContent = s.error ?? '';
      status.classList.toggle('vp-err', !!s.error);
      status.style.display = s.error ? '' : 'none';
    },

    destroy() { try { ctx.root.innerHTML = ''; } catch { /* */ } },
  };
}

function rules(cls: string): string {
  return `
& .vp-box {
  display: flex; align-items: center; gap: var(--vp-gap);
  padding: calc(var(--vp-pad) * 0.6) var(--vp-pad);
  border-radius: var(--vp-radius);
  background: var(--vp-surface);
  width: 100%;
}
& .vp-live {
  flex: none; font-size: 10px; font-weight: 700; letter-spacing: .08em;
  padding: 3px 6px; border-radius: 4px;
  background: var(--vp-primary); color: var(--vp-accent-on);
}
& .vp-marquee { flex: 1; min-width: 0; overflow: hidden; position: relative; }
& .vp-track {
  display: inline-block; white-space: nowrap; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; vertical-align: bottom;
}
& .vp-marquee.vp-scroll .vp-track {
  max-width: none; overflow: visible; text-overflow: clip;
  animation: vp-marq-${cls} var(--vp-marq-dur, 8s) linear infinite alternate;
}
& .vp-primary { font-weight: 650; }
& .vp-secondary { color: var(--vp-ink-dim); }
& .vp-vol { flex: none; width: 72px; }
& .vp-status { margin-top: 0; flex: none; max-width: 40%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@keyframes vp-marq-${cls} {
  from { transform: translateX(0); }
  to   { transform: translateX(calc(-1 * var(--vp-marq-shift, 0px))); }
}
@media (max-width: 420px) {
& .vp-vol { display: none; }
}
@media (prefers-reduced-motion: reduce) {
& .vp-marquee.vp-scroll .vp-track {
  animation: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
}
}
`;
}
