// ============================================================================
//  THE STAGE LAYOUT. Video, and therefore a different set of rules.
//
//  An event is video, and a video player is not an audio player with a picture
//  bolted on. Three things change, and each one changes the skinning problem:
//
//    THE BOX IS RESERVED FIRST. The picture arrives late or not at all, so the
//    countdown, the stream, the replay message and the error all occupy exactly
//    the same rectangle at exactly the same ratio. Nothing on the host page
//    moves at the moment everybody is looking at it.
//
//    THE CONTROLS SIT ON THE PICTURE, not beside it. So they need their own
//    legibility, and they cannot get it from the surface colour.
//
//    THE BACKGROUND IS UNKNOWABLE. It is somebody else's football match and it
//    changes twenty five times a second.
//
//  ------------------------------------------------------------------------
//  WHICH IS WHY A CUSTOMER CANNOT SET THE OVERLAY TEXT COLOUR.
//
//  Everywhere else in this player the ink is COMPUTED from the background, and
//  that works because the background is a colour we were given. Over video
//  there is no such colour. Contrast cannot be computed against a moving
//  picture, so it has to be constructed: the overlay ink is fixed white, and
//  the legibility comes from a scrim the player draws underneath it.
//
//  The brand still gets in, in the places where it can carry its own contrast:
//  the play button fill, the live badge, the volume track, the logo. Text
//  inside a brand fill uses --vp-accent-on, computed from the fill.
//
//  The brand fill itself is NEVER adjusted. A very dark brand on a dark scrim
//  over dark footage would be hard to find, so the edge is guaranteed instead:
//  a hairline ring of overlay ink whose alpha rises only as the brand gets dark
//  enough to need it, and which is fully transparent for most brands. Lifting
//  the colour was tried and rejected, because a navy lifted far enough to be
//  visible is no longer their navy, and a brand colour is the one thing a
//  customer checks pixel by pixel. See `videoEdge`.
//
//  Offering "overlay text colour" would be offering the setting that makes the
//  player unreadable, and somebody would choose it.
// ============================================================================
import type { Layout, LayoutContext, LayoutState } from '../types';
import {
  baseRules, el, instanceClass, playButton, scopedStyle,
  setPlayState, statusLine, volumeSlider,
} from './shared';
import { createPhase, phaseRules } from './phase';
import { aspectRatio } from '../tokens';

const IDLE_MS = 2600;

export function stageLayout(): Layout {
  const cls = instanceClass('stage');
  let ctx: LayoutContext;
  let box: HTMLElement;
  let screen: HTMLElement;
  let poster: HTMLImageElement;
  let chrome: HTMLElement;
  let live: HTMLElement;
  let title: HTMLElement;
  let btn: HTMLButtonElement;
  let bigBtn: HTMLButtonElement;
  let fs: HTMLButtonElement;
  let status: HTMLElement;
  let phase: ReturnType<typeof createPhase>;
  let idle: ReturnType<typeof setTimeout> | null = null;

  function wake(): void {
    box.classList.remove('vp-idle');
    if (idle) clearTimeout(idle);
    // Only hide while something is actually playing. Chrome that vanishes over
    // a paused picture leaves the viewer with no way back in and no clue that
    // there was ever a control there.
    idle = setTimeout(() => {
      if (box.classList.contains('vp-playing')) box.classList.add('vp-idle');
    }, IDLE_MS);
  }

  return {
    mount(c: LayoutContext) {
      ctx = c;
      const shell = el('div', cls);
      scopedStyle(c.root, cls, baseRules() + phaseRules() + rules());

      box = el('div', 'vp-box');
      // Video always reserves a ratio. `auto` is meaningful for an audio strip
      // and meaningless for a stage, so the default here is 16:9 rather than
      // whatever the content happens to be.
      const ratio = aspectRatio((c.config.options as any)?.aspect);
      box.style.setProperty('--vp-aspect', ratio === 'auto' ? '16 / 9' : ratio);

      screen = el('div', 'vp-screen');
      if (c.media) screen.appendChild(c.media);

      // The poster holds the box until the first frame paints. A black
      // rectangle that is technically playing looks exactly like a black
      // rectangle that is broken.
      poster = document.createElement('img');
      poster.className = 'vp-poster';
      poster.alt = '';
      poster.addEventListener('error', () => { poster.style.opacity = '0'; });

      const scrimTop = el('div', 'vp-scrim vp-scrim-t');
      const scrimBot = el('div', 'vp-scrim vp-scrim-b');

      chrome = el('div', 'vp-chrome');

      const top = el('div', 'vp-top');
      const logoUrl = str((c.config.options as any)?.logoUrl);
      if (logoUrl) {
        const logo = document.createElement('img');
        logo.className = 'vp-logo';
        logo.alt = '';
        logo.src = logoUrl;
        logo.addEventListener('error', () => { logo.remove(); });
        top.appendChild(logo);
        const pos = str((c.config.options as any)?.logoPosition) ?? 'top-left';
        box.classList.add(`vp-logo-${pos}`);
      }
      live = el('span', 'vp-live');
      live.textContent = 'LIVE';
      live.style.display = 'none';
      top.appendChild(live);

      const centre = el('div', 'vp-centre');
      bigBtn = playButton(c, 'vp-play vp-play-big');
      centre.appendChild(bigBtn);

      const bottom = el('div', 'vp-bottom');
      btn = playButton(c);
      title = el('div', 'vp-title');
      status = statusLine();
      fs = document.createElement('button');
      fs.type = 'button';
      fs.className = 'vp-fs';
      fs.setAttribute('aria-label', 'Full screen');
      fs.innerHTML = ICON_FS;
      fs.addEventListener('click', () => {
        try {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void box.requestFullscreen();
        } catch { /* denied by the host page's permissions policy */ }
      });
      bottom.append(btn, volumeSlider(c), title, status, fs);

      chrome.append(top, centre, bottom);

      // NOT the inline modifier the hero uses. On a stage the panel owns the
      // whole reserved box, so its poster is full bleed at the player's own
      // ratio rather than inset inside somebody else's padding.
      phase = createPhase();
      const cover = el('div', 'vp-cover');
      cover.appendChild(phase.el);

      box.append(screen, poster, scrimTop, scrimBot, chrome, cover);
      shell.appendChild(box);
      c.root.appendChild(shell);

      for (const ev of ['pointermove', 'pointerdown', 'focusin'] as const) {
        box.addEventListener(ev, wake);
      }
      box.addEventListener('pointerleave', () => {
        if (box.classList.contains('vp-playing')) box.classList.add('vp-idle');
      });

      title.textContent = c.station.name;
      const p = str((c.config.options as any)?.posterUrl) ?? c.station.artworkUrl;
      if (p) poster.src = p; else poster.style.opacity = '0';
    },

    update(s: LayoutState) {
      const off = phase.update(s, ctx);
      // The chrome goes away entirely outside `live`. A play button over a
      // countdown is an invitation to press something that cannot work.
      box.classList.toggle('vp-off', off);
      if (off) { poster.style.opacity = '0'; return; }

      box.classList.toggle('vp-playing', s.playing);
      if (!s.playing) box.classList.remove('vp-idle');

      // The poster stays until there is a real frame behind it.
      poster.style.opacity = s.hasPicture ? '0' : '';

      const np = s.nowPlaying;
      title.textContent = np?.primary ?? s.event?.title ?? ctx.station.name;
      live.style.display = s.presentation === 'live' ? '' : 'none';

      setPlayState(btn, s.playing, s.loading);
      setPlayState(bigBtn, s.playing, s.loading);
      // The big centre control is the one people aim at before playback and the
      // one that is in the way during it. Hide the BUTTON, never its container:
      // the container is the flex spacer that holds the control bar against the
      // bottom of the frame, and collapsing it walks the whole bar up under the
      // logo.
      bigBtn.style.display = s.playing ? 'none' : '';

      status.textContent = s.error ?? (s.loading && !s.playing ? 'Connecting…' : '');
      status.classList.toggle('vp-err', !!s.error);
    },

    destroy() {
      if (idle) clearTimeout(idle);
      try { ctx.root.innerHTML = ''; } catch { /* */ }
    },
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

const ICON_FS =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
  + '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round"/></svg>';

function rules(): string {
  return `
& .vp-box {
  position: relative; overflow: hidden; isolation: isolate;
  width: 100%; aspect-ratio: var(--vp-aspect, 16 / 9);
  border-radius: var(--vp-radius);
  background: var(--vp-letterbox);
  color: var(--vp-on-video);
}
& .vp-screen { position: absolute; inset: 0; z-index: 0; }
& .vp-screen video {
  width: 100%; height: 100%; display: block;
  object-fit: contain; background: var(--vp-letterbox);
}
& .vp-poster {
  position: absolute; inset: 0; z-index: 1;
  width: 100%; height: 100%; object-fit: cover; display: block;
  transition: opacity .25s ease;
}

/* Legibility is CONSTRUCTED, not computed. Two gradients, top and bottom,
   under the two places chrome actually sits. A full-frame wash would dim the
   picture for no benefit. */
& .vp-scrim { position: absolute; left: 0; right: 0; z-index: 2; pointer-events: none; }
& .vp-scrim-t {
  top: 0; height: 34%;
  background: linear-gradient(to bottom, rgba(0,0,0,var(--vp-scrim-top, .38)), rgba(0,0,0,0));
}
& .vp-scrim-b {
  bottom: 0; height: 46%;
  background: linear-gradient(to top, rgba(0,0,0,var(--vp-scrim-bottom, .70)), rgba(0,0,0,0));
}

& .vp-chrome {
  position: absolute; inset: 0; z-index: 3;
  display: flex; flex-direction: column;
  transition: opacity .2s ease;
}
& .vp-box.vp-idle .vp-chrome { opacity: 0; }
& .vp-box.vp-idle { cursor: none; }
& .vp-box.vp-off .vp-chrome,
& .vp-box.vp-off .vp-scrim { display: none; }

& .vp-top {
  display: flex; align-items: flex-start; gap: 10px;
  padding: calc(var(--vp-pad) * 0.9);
}
& .vp-box.vp-logo-top-right .vp-top { flex-direction: row-reverse; }
& .vp-logo { max-height: 30px; max-width: 130px; object-fit: contain; opacity: .95; }
& .vp-live {
  font-size: 10px; font-weight: 700; letter-spacing: .09em;
  padding: 4px 8px; border-radius: 4px;
  background: var(--vp-primary); color: var(--vp-accent-on);
  margin-left: auto;
  box-shadow: 0 0 0 1.5px var(--vp-edge, transparent), 0 2px 8px rgba(0,0,0,.4);
}
& .vp-box.vp-logo-top-right .vp-live { margin-left: 0; margin-right: auto; }

& .vp-centre { flex: 1; display: grid; place-items: center; }
& .vp-play {
  background: var(--vp-primary); color: var(--vp-accent-on);
  /* The ring is transparent for any brand bright enough not to need it, so
     most players carry no extra edge at all. */
  box-shadow: 0 0 0 2px var(--vp-edge, transparent), 0 6px 18px rgba(0,0,0,.38);
}
& .vp-play-big {
  width: calc(var(--vp-hit) * 1.6); height: calc(var(--vp-hit) * 1.6);
  box-shadow: 0 0 0 2px var(--vp-edge, transparent), 0 10px 30px rgba(0,0,0,.45);
}
& .vp-play-big svg { width: calc(var(--vp-icon) * 1.6); height: calc(var(--vp-icon) * 1.6); }

& .vp-bottom {
  display: flex; align-items: center; gap: 12px;
  padding: calc(var(--vp-pad) * 0.9);
}
& .vp-bottom .vp-play { width: 38px; height: 38px; }
& .vp-bottom .vp-play svg { width: 18px; height: 18px; }
& .vp-vol { width: 84px; accent-color: var(--vp-primary); }
& .vp-title {
  flex: 1; min-width: 0; font-weight: 620;
  text-shadow: 0 1px 3px rgba(0,0,0,.6);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
& .vp-status { margin-top: 0; flex: none; color: var(--vp-on-video-dim); }
& .vp-fs {
  flex: none; width: 34px; height: 34px; border: 0; padding: 0; cursor: pointer;
  background: none; color: var(--vp-on-video);
  display: grid; place-items: center; border-radius: 6px;
}
& .vp-fs svg { width: 20px; height: 20px; }
& .vp-fs:focus-visible,
& .vp-play:focus-visible {
  outline: 3px solid var(--vp-on-video); outline-offset: 3px;
}

/* The phase panel owns the whole reserved box, on the letterbox rather than on
   the surface colour, because it is standing in for a picture. */
& .vp-cover {
  position: absolute; inset: 0; z-index: 4;
  display: none;
  background: var(--vp-surface);
}
& .vp-box.vp-off .vp-cover { display: block; }
& .vp-cover .vp-phase { width: 100%; height: 100%; border-radius: 0; }
/* The box sets overlay ink for the chrome that sits on the picture. A phase
   panel with no poster is NOT on a picture, it is on the surface colour, so it
   goes back to the computed ink. Without this a pale surface gets white text. */
& .vp-cover .vp-phase:not(.vp-on-poster) { color: var(--vp-ink); }
& .vp-cover .vp-phase:not(.vp-on-poster) .vp-phase-headline,
& .vp-cover .vp-phase:not(.vp-on-poster) .vp-phase-subhead,
& .vp-cover .vp-phase:not(.vp-on-poster) .vp-side-sub,
& .vp-cover .vp-phase:not(.vp-on-poster) .vp-unit i { color: var(--vp-ink-dim); }
& .vp-cover .vp-phase-body {
  height: 100%; justify-content: center;
  padding: calc(var(--vp-pad) * 1.6);
}
& .vp-cover .vp-phase.vp-at-bottom .vp-phase-body { justify-content: flex-end; }

@media (max-width: 480px) {
& .vp-vol { display: none; }
}
@media (prefers-reduced-motion: reduce) {
& .vp-poster, & .vp-chrome { transition: none; }
}
`;
}
