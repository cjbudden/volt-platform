// ============================================================================
//  ON AIR: what a live channel viewer is told about what is on, shared by the
//  built-in skins (video for viewers, admin for the console preview).
//
//  THE COUNTDOWN. Between programmes (the channel's loop or slate, from the
//  stream's own programme markers: PlayerState.between) and during an ad
//  break, a small panel over the picture says what comes back and when:
//  "Up next · Big Buck Bunny · Starts in 0:42", "Back in 1:30". It is drawn
//  inside the stage, so it stays in full screen (the root's, or the player's
//  own on iPhone), and the player hides every other graphic meanwhile.
//
//  THE PROGRAMME CARD. The programme's details as the stream carries them
//  (title, image, description, genre, rating, year, what is next), bottom left.
//  It gives context, nothing more (Christian, 6 Nov): it shows "Now playing"
//  for a few seconds when playback starts and when a new programme starts, then
//  fades; it has a close button; it shows on pause. It is NEVER shown for an ad,
//  an ad break, or the channel's loop, slate or brand between programmes: what
//  comes next there is the countdown's job (top right), so the card never says
//  "Coming up" a second time. In the console it is also the operator's proof
//  that the metadata is in the stream and read.
// ============================================================================
import type { PlayerState, Programme, SkinContext } from '../types';
import { button, el, fmtClock, fmtTime, show, text } from './kit';

/** How long the Now playing card stays up when playback or a programme starts. */
export const INTRO_MS = 3000;
/** Its fade out (matches the CSS transition). */
const FADE_MS = 400;

/** Genre · rating · year · language · S1 E2, from a programme marker's metadata. */
export function metaLine(p: Programme | null): string {
  const m = p?.meta ?? {};
  const se = m.season || m.episode ? [m.season ? `S${m.season}` : '', m.episode ? `E${m.episode}` : ''].join(' ').trim() : '';
  return [m.genre, m.rating, m.year, m.language, se].filter(Boolean).join(' · ');
}

/** Seconds from the playhead to `at` (both on the stream's clock), or null. */
export function secondsTo(at: number | null | undefined, st: Pick<PlayerState, 'wallClock'>): number | null {
  if (at == null || !Number.isFinite(at)) return null;
  const from = st.wallClock ?? Date.now();
  return Math.max(0, Math.round((at - from) / 1000));
}

export interface OnAir { update(st: PlayerState): void }

/**
 * Mount the countdown and programme card in the stage.
 * `variant`: 'overlay' (controls over the picture: keep clear of the bar) or 'console' (bar below the picture).
 */
export function onAir(c: SkinContext, variant: 'overlay' | 'console' = 'overlay'): OnAir {
  const t = c.t;
  // countdown
  const cdKick = el('small');
  const cdTitle = el('b');
  const cdTime = el('span', 'vp-cd-t');
  const cd = el('div', 'vp-cd', { role: 'status', 'aria-live': 'polite' }, el('div', undefined, undefined, cdKick, cdTitle), cdTime);
  // programme card
  const img = el('img', undefined, { alt: '' });
  const kick = el('small');
  const title = el('b');
  const meta = el('span', 'vp-pc-m');
  const desc = el('p');
  const next = el('span', 'vp-pc-n');
  // Close: hides the card until there is something new to say (the next
  // programme, or the next pause). The card itself lets clicks through to the
  // player; only this button takes them.
  const close = button('close', t('dismiss'), (e) => { e.stopPropagation(); e.preventDefault(); dismissed = shownKey; fadeOut(); }, 'vp-btn vp-pc-x', 16);
  const card = el('div', `vp-pc${variant === 'console' ? ' console' : ''}`, { role: 'region', 'aria-label': t('aboutProgramme') },
    img, el('div', 'vp-pc-b', undefined, kick, title, meta, desc, next), close);
  show(cd, false); show(card, false);
  // ONE per player. The stage outlives a skin (the console switches Console /
  // Viewer on the same player), so a skin mounted before left its own card
  // and countdown behind: two cards drawn on top of each other.
  c.stage.querySelectorAll(':scope > .vp-cd, :scope > .vp-pc').forEach((n) => n.remove());
  c.stage.append(cd, card);
  // An image that does not load is left out, never drawn as a broken icon.
  let badSrc = '';
  img.addEventListener('error', () => { badSrc = img.getAttribute('src') ?? ''; show(img, false); });
  // Injected once per page, but REFRESHED when it differs: a page left open
  // across an update (or a dev hot reload) otherwise keeps the old rules, which
  // is how the close button ended up beside the title instead of top right.
  let css = document.getElementById('vp-onair-css') as HTMLStyleElement | null;
  if (!css) { css = document.createElement('style'); css.id = 'vp-onair-css'; document.head.appendChild(css); }
  if (css.textContent !== ON_AIR_CSS) css.textContent = ON_AIR_CSS;

  // The intro runs once per programme, from the moment it is actually playing
  // (so a player that loads paused, or buffers first, still gets its few seconds).
  let introFor: string | null = null;
  let introUntil = 0;
  // What the card is showing now ('intro:<id>' or 'pause:<id>'), and what the
  // viewer closed: a closed card stays closed until the key changes.
  let shownKey = '';
  let dismissed = '';
  let visible = false;
  let wasPaused = false;
  let pauseSeq = 0;
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;
  function fadeIn() {
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    show(card, true);
    if (!visible) { card.classList.add('vp-pc-out'); void card.offsetWidth; }
    card.classList.remove('vp-pc-out');
    visible = true;
  }
  function fadeOut() {
    if (!visible) return;
    visible = false;
    card.classList.add('vp-pc-out');
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => { fadeTimer = null; if (!visible) show(card, false); }, FADE_MS);
  }

  return {
    update(st: PlayerState) {
      const live = st.live && st.status !== 'offline' && st.status !== 'error';
      const b = live ? st.between : null;

      // ---- countdown (filler and breaks)
      show(cd, !!b);
      if (b) {
        const s = secondsTo(b.resumesAt, st);
        if (b.kind === 'break') {
          text(cdKick, t('adBreak'));
          text(cdTitle, b.next?.title ?? '');
          text(cdTime, s != null && s > 0 ? t('backIn', { time: fmtTime(s) }) : t('startingSoon'));
        } else {
          text(cdKick, t('upNext'));
          text(cdTitle, b.next?.title ?? '');
          text(cdTime, s != null && s > 0 ? t('startsIn', { time: fmtTime(s) }) : t('startingSoon'));
        }
      }

      // ---- programme card: Now playing, only for real programme content
      const p = st.programme;
      const content = live && !!p && !b && !st.ad && !st.adBreak;
      if (content && st.playing && p!.id !== introFor) { introFor = p!.id; introUntil = Date.now() + INTRO_MS; }
      const paused = !st.playing && (st.status === 'paused' || st.status === 'ready');
      if (paused && !wasPaused) pauseSeq++;
      wasPaused = paused;
      const intro = content && st.playing && Date.now() < introUntil;
      const key = !content ? '' : paused ? `pause:${p!.id}:${pauseSeq}` : intro ? `intro:${p!.id}` : '';
      const want = !!key && key !== dismissed;
      if (!want) { fadeOut(); return; }
      shownKey = key;
      fadeIn();
      const subject = p!;
      text(kick, paused ? t('paused') : t('nowPlaying'));
      text(title, subject.title);
      text(meta, metaLine(subject));
      show(meta, !!metaLine(subject));
      text(desc, subject.description ?? '');
      show(desc, !!subject.description);
      const src = subject.imageUrl ?? '';
      if (src && src !== badSrc) { if (img.getAttribute('src') !== src) img.src = src; show(img, img.complete ? img.naturalWidth > 0 : true); }
      else show(img, false);
      const nx = st.nextProgramme;
      text(next, nx ? `${t('next')}: ${nx.title}${Number.isFinite(nx.startsAt) ? ` · ${fmtClock(nx.startsAt)}` : ''}` : '');
      show(next, !!nx);
    },
  };
}

export const ON_AIR_CSS = `
.vp .vp-cd{position:absolute;top:14px;right:14px;z-index:6;display:flex;align-items:center;gap:14px;max-width:min(420px,80%);padding:10px 14px;background:rgba(14,16,22,.88);border-radius:calc(var(--vp-radius) - 2px);color:#fff;box-shadow:0 8px 28px rgba(0,0,0,.4);pointer-events:none}
.vp .vp-cd small{display:block;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--vp-primary)}
.vp .vp-cd b{display:block;font-size:13px;line-height:1.3;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vp .vp-cd-t{font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap;color:rgba(255,255,255,.85)}
.vp .vp-pc{position:absolute;left:16px;bottom:var(--vp-lift,16px);transition:bottom .25s ease,opacity .4s ease;opacity:1;z-index:6;display:flex;gap:14px;width:min(520px,calc(100% - 32px));padding:14px 40px 14px 14px;background:rgba(14,16,22,.9);border-radius:calc(var(--vp-radius) - 2px);color:#fff;box-shadow:0 12px 40px rgba(0,0,0,.45);pointer-events:none}
.vp .vp-pc.console{bottom:16px}
.vp .vp-pc.vp-pc-out{opacity:0}
.vp .vp-pc .vp-btn.vp-pc-x{position:absolute;top:8px;right:8px;z-index:1;width:28px;height:28px;padding:0;pointer-events:auto;color:rgba(255,255,255,.7);background:transparent;border:0;border-radius:6px;cursor:pointer}
.vp .vp-pc .vp-btn.vp-pc-x:hover,.vp .vp-pc .vp-btn.vp-pc-x:focus-visible{color:#fff;background:rgba(255,255,255,.12)}
.vp.vp-gfx-bottom .vp-pc{bottom:auto;top:56px}
.vp.vp-gfx-bottom .vp-pc.console{top:14px}
.vp .vp-pc img{width:128px;height:72px;object-fit:cover;border-radius:6px;flex:none;background:#222}
.vp .vp-pc-b{min-width:0;flex:1 1 auto}
.vp .vp-pc small{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--vp-primary)}
.vp .vp-pc b{display:block;font-size:16px;line-height:1.3;margin:2px 0}
.vp .vp-pc-m,.vp .vp-pc-n{display:block;font-size:12px;color:rgba(255,255,255,.7)}
.vp .vp-pc-n{margin-top:6px;color:rgba(255,255,255,.85)}
.vp .vp-pc p{margin:4px 0 0;font-size:12.5px;line-height:1.45;color:rgba(255,255,255,.8);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
/* A SMALL PLAYER (a phone, a console tile): sized by the player, not the screen.
   The card shrinks to what is on and what is next, so it never covers the picture. */
@container (max-width:640px){.vp .vp-pc img{width:96px;height:54px}.vp .vp-pc p{-webkit-line-clamp:2}}
@container (max-width:480px){
  .vp .vp-pc{left:10px;width:auto;max-width:calc(100% - 20px);padding:8px 40px 8px 12px;gap:0}
  .vp .vp-pc img,.vp .vp-pc p,.vp .vp-pc-m{display:none}
  .vp .vp-pc b{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .vp .vp-pc small{font-size:10px}
  .vp .vp-pc-n{margin-top:2px;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .vp.vp-gfx-bottom .vp-pc{top:44px}
  .vp .vp-cd{top:8px;right:8px;padding:6px 10px;gap:10px}.vp .vp-cd b{max-width:140px}
}
.vp.vp-between .vp-brandmark,.vp.vp-in-break .vp-brandmark{opacity:0;transition:opacity .3s}
.vp.vp-pseudo-fs{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;height:100dvh!important;max-width:none!important;max-height:none!important;z-index:2147483646!important;background:#000;border-radius:0!important;margin:0!important}
html.vp-noscroll,html.vp-noscroll body{overflow:hidden!important}
`;
