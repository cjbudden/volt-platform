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
//  (title, image, description, genre, rating, year, what is next) on pause,
//  for a few seconds when a programme starts, and between programmes (then
//  about what is coming). Never over an ad break. In the console it is also
//  the operator's proof that the metadata is in the stream and read.
// ============================================================================
import type { PlayerState, Programme, SkinContext } from '../types';
import { el, fmtClock, fmtTime, show, text } from './kit';

const INTRO_MS = 8000;

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
  const card = el('div', `vp-pc${variant === 'console' ? ' console' : ''}`, { role: 'region', 'aria-label': t('aboutProgramme') },
    img, el('div', 'vp-pc-b', undefined, kick, title, meta, desc, next));
  show(cd, false); show(card, false);
  // ONE per player. The stage outlives a skin (the console switches Console /
  // Viewer on the same player), so a skin mounted before left its own card
  // and countdown behind: two cards drawn on top of each other.
  c.stage.querySelectorAll(':scope > .vp-cd, :scope > .vp-pc').forEach((n) => n.remove());
  c.stage.append(cd, card);
  // An image that does not load is left out, never drawn as a broken icon.
  let badSrc = '';
  img.addEventListener('error', () => { badSrc = img.getAttribute('src') ?? ''; show(img, false); });
  if (!document.getElementById('vp-onair-css')) {
    const s = document.createElement('style');
    s.id = 'vp-onair-css';
    s.textContent = ON_AIR_CSS;
    document.head.appendChild(s);
  }

  let lastId: string | null = null;
  let introUntil = 0;

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

      // ---- programme card
      const p = st.programme;
      if (p?.id !== lastId) { lastId = p?.id ?? null; introUntil = p && st.playing ? Date.now() + INTRO_MS : 0; }
      const paused = !st.playing && (st.status === 'paused' || st.status === 'ready');
      const subject = b?.kind === 'filler' ? (b.next ?? null) : p;
      const want = live && !!subject && b?.kind !== 'break' && !st.ad
        && (paused || b?.kind === 'filler' || Date.now() < introUntil);
      show(card, want);
      if (!want || !subject) return;
      text(kick, b?.kind === 'filler' ? t('comingUp') : paused ? t('paused') : t('onNow'));
      text(title, subject.title);
      text(meta, metaLine(subject));
      show(meta, !!metaLine(subject));
      text(desc, subject.description ?? '');
      show(desc, !!subject.description);
      const src = subject.imageUrl ?? '';
      if (src && src !== badSrc) { if (img.getAttribute('src') !== src) img.src = src; show(img, img.complete ? img.naturalWidth > 0 : true); }
      else show(img, false);
      const nx = b?.kind === 'filler' ? null : st.nextProgramme;
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
.vp .vp-pc{position:absolute;left:16px;bottom:var(--vp-lift,16px);transition:bottom .25s ease;z-index:6;display:flex;gap:14px;width:min(520px,calc(100% - 32px));padding:14px;background:rgba(14,16,22,.9);border-radius:calc(var(--vp-radius) - 2px);color:#fff;box-shadow:0 12px 40px rgba(0,0,0,.45);pointer-events:none}
.vp .vp-pc.console{bottom:16px}
.vp.vp-gfx-bottom .vp-pc{bottom:auto;top:56px}
.vp.vp-gfx-bottom .vp-pc.console{top:14px}
.vp .vp-pc img{width:128px;height:72px;object-fit:cover;border-radius:6px;flex:none;background:#222}
.vp .vp-pc-b{min-width:0}
.vp .vp-pc small{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--vp-primary)}
.vp .vp-pc b{display:block;font-size:16px;line-height:1.3;margin:2px 0}
.vp .vp-pc-m,.vp .vp-pc-n{display:block;font-size:12px;color:rgba(255,255,255,.7)}
.vp .vp-pc-n{margin-top:6px;color:rgba(255,255,255,.85)}
.vp .vp-pc p{margin:4px 0 0;font-size:12.5px;line-height:1.45;color:rgba(255,255,255,.8);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
/* A SMALL PLAYER (a phone, a console tile): sized by the player, not the screen.
   The card shrinks to what is on and what is next, so it never covers the picture. */
@container (max-width:640px){.vp .vp-pc img{width:96px;height:54px}.vp .vp-pc p{-webkit-line-clamp:2}}
@container (max-width:480px){
  .vp .vp-pc{left:10px;width:auto;max-width:calc(100% - 20px);padding:8px 12px;gap:0}
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
