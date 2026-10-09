// ============================================================================
//  THE PHASE PANEL.
//
//  What a layout shows when there is nothing to play: before an event, after
//  it, and when it should be producing and is not.
//
//  ONE implementation, used by every skin. Three layouts each writing their own
//  "this event has finished" is three chances for one of them to say nothing at
//  all, and the one that says nothing is a blank box on a customer's launch
//  page.
//
//  ------------------------------------------------------------------------
//  BEFORE THE EVENT, THE PANEL IS AN ADVERT. AFTER IT, A NOTICE.
//
//  The pre-event window is the only time the audience is being assembled, so
//  "starts in 3 days" is a fact rather than a reason to come back. Different
//  events are sold by different things, which is why `pre` dispatches on a
//  template and the other phases do not. See `EventPromo`.
//
//  ------------------------------------------------------------------------
//  A POSTER MAKES THIS THE SAME PROBLEM AS VIDEO.
//
//  Text over artwork nobody has seen cannot have its contrast computed, exactly
//  as over a moving picture. So the panel has two ink modes and switches
//  between them on one condition, whether there is a poster:
//
//    no poster   ink COMPUTED from --vp-surface, as everywhere else
//    poster      ink FIXED to the overlay ink, over a scrim we draw
//
//  Same rule as the stage, same tokens, one fewer thing to reason about.
//
//  ------------------------------------------------------------------------
//  THE TICKING DIGITS ARE HIDDEN FROM SCREEN READERS.
//
//  A live region that changes every second is unusable: it interrupts
//  continuously and the listener never hears a whole sentence. The digits carry
//  aria-hidden and a quiet line beside them says "starts in 3 hours", rewritten
//  only when the minute changes.
// ============================================================================
import type { EventPromo, LayoutContext, LayoutState, PromoSide, PromoTemplate } from '../types';
import { absolute, countdownStyle, pad, parts, relative } from '../countdown';
import { el } from './shared';

export interface Phase {
  el: HTMLElement;
  /** True when the panel has taken over, meaning the layout should hide its
   *  normal body. False during `live`, when there is something to play. */
  update(state: LayoutState, ctx: LayoutContext): boolean;
}

const BADGE: Record<string, string> = {
  pre: 'UPCOMING',
  ended: 'FINISHED',
  replay: 'REPLAY AVAILABLE',
  offline: 'OFF AIR',
  postponed: 'POSTPONED',
  cancelled: 'CANCELLED',
};

const TEMPLATES: PromoTemplate[] = ['plain', 'versus', 'billing', 'people', 'field'];

function template(p: EventPromo | null | undefined, cfg: LayoutContext['config']): PromoTemplate {
  const t = p?.template ?? (cfg.options as any)?.promoTemplate;
  return TEMPLATES.includes(t) ? t : 'plain';
}

export function createPhase(): Phase {
  const root = el('div', 'vp-phase');

  const poster = document.createElement('img');
  poster.className = 'vp-phase-poster';
  poster.alt = '';
  poster.addEventListener('error', () => { poster.remove(); root.classList.remove('vp-on-poster'); });
  const scrim = el('div', 'vp-phase-scrim');

  const body = el('div', 'vp-phase-body');
  const badge = el('span', 'vp-phase-badge');
  const headline = el('div', 'vp-phase-headline');
  const promoBlock = el('div', 'vp-promo');
  const title = el('div', 'vp-phase-title');
  const subhead = el('div', 'vp-phase-subhead');
  const count = el('div', 'vp-count');
  count.setAttribute('aria-hidden', 'true');
  const sr = el('div', 'vp-sr');
  sr.setAttribute('role', 'status');
  sr.setAttribute('aria-live', 'polite');
  const when = el('div', 'vp-phase-when');
  const msg = el('div', 'vp-phase-msg');

  const replay = document.createElement('button');
  replay.type = 'button';
  replay.className = 'vp-replay';
  replay.textContent = 'Watch the replay';

  body.append(badge, headline, promoBlock, title, subhead, count, sr, when, msg, replay);
  root.append(poster, scrim, body);

  let lastSr = '';
  let lastPromoKey = '';
  let wiredTo: LayoutContext | null = null;

  return {
    el: root,

    update(s, ctx) {
      if (s.presentation === 'live') { root.style.display = 'none'; return false; }
      root.style.display = '';

      // Wired on first use rather than at construction: the context carries the
      // override an embedder may have supplied.
      if (wiredTo !== ctx) {
        wiredTo = ctx;
        replay.onclick = () => ctx.openReplay();
      }

      const ev = s.event;
      const promo = ev?.promo ?? null;
      const isPre = s.presentation === 'pre';

      // ---- poster ---------------------------------------------------------
      // Kept in every phase, not just `pre`. A finished event that keeps its
      // artwork looks intentional; one that drops to a flat panel looks like
      // the page broke.
      const posterUrl = promo?.posterUrl ?? null;
      if (posterUrl) {
        if (poster.getAttribute('src') !== posterUrl) poster.src = posterUrl;
        if (!poster.isConnected) root.insertBefore(poster, scrim);
        poster.style.objectFit = promo?.posterFit === 'contain' ? 'contain' : 'cover';
        poster.style.objectPosition = promo?.posterFocus ?? 'center';
        root.classList.add('vp-on-poster');
      } else {
        root.classList.remove('vp-on-poster');
      }
      root.classList.remove('vp-at-left', 'vp-at-centre', 'vp-at-bottom');
      root.classList.add(`vp-at-${promo?.overlay ?? 'left'}`);

      // ---- the promotional block, only before the event --------------------
      // The promo block survives a postponement. The two sides are still the two
      // sides, and a fixture page stripped back to one grey line reads as an
      // error rather than as news. It does not survive a cancellation, where
      // there is nothing left to sell.
      const promoted = isPre || s.presentation === 'postponed';
      const tpl = promoted ? template(promo, ctx.config) : 'plain';
      root.classList.remove('vp-t-plain', 'vp-t-versus', 'vp-t-billing', 'vp-t-people', 'vp-t-field');
      root.classList.add(`vp-t-${tpl}`);

      // Rebuilding a row of badges on every countdown tick would rebuild it
      // once a second, so it is rebuilt only when its own content changes.
      const key = `${tpl}|${(promo?.sides ?? []).map(sideKey).join('~')}|${promo?.separator ?? ''}`;
      if (key !== lastPromoKey) {
        lastPromoKey = key;
        promoBlock.innerHTML = '';
        if (tpl !== 'plain' && promo?.sides?.length) {
          promoBlock.appendChild(buildSides(tpl, promo));
        }
      }
      promoBlock.style.display = promoBlock.childElementCount ? '' : 'none';

      badge.textContent = BADGE[s.presentation] ?? '';
      headline.textContent = promoted ? (promo?.headline ?? '') : '';
      headline.style.display = headline.textContent ? '' : 'none';
      subhead.textContent = promoted ? (promo?.subhead ?? '') : '';
      subhead.style.display = subhead.textContent ? '' : 'none';

      // Two templates already name the thing in large type, so repeating the
      // event title underneath is noise: versus names both sides, and billing
      // names the headliner.
      const named = (promo?.sides?.length ?? 0) >= 1;
      const showTitle = !((tpl === 'versus' && (promo?.sides?.length ?? 0) >= 2)
                       || (tpl === 'billing' && named));
      title.textContent = showTitle ? (ev?.title ?? ctx.station.name) : '';
      title.style.display = showTitle ? '' : 'none';

      // ---- countdown -------------------------------------------------------
      const style = countdownStyle((ctx.config.options as any)?.countdown);
      const showCount = isPre && style !== 'none' && s.msToStart !== null;
      count.style.display = showCount ? '' : 'none';
      when.style.display = 'none';
      sr.textContent = '';

      if (showCount) {
        const ms = s.msToStart as number;
        if (ms <= 0) {
          // Past the scheduled time and still not live. Say so, rather than
          // showing a countdown frozen at zero, which reads as broken.
          count.className = 'vp-count vp-count-word';
          count.textContent = 'Starting shortly';
        } else if (style === 'digits') {
          count.className = 'vp-count vp-count-digits';
          count.innerHTML = digits(ms);
        } else if (style === 'relative') {
          count.className = 'vp-count vp-count-word';
          count.textContent = relative(ms);
        } else {
          count.className = 'vp-count vp-count-word';
          count.textContent = ev?.startsAt ? absolute(ev.startsAt) : '';
        }

        const spoken = ms <= 0 ? 'Starting shortly' : relative(ms);
        if (spoken !== lastSr) { lastSr = spoken; sr.textContent = spoken; }

        // Digits alone do not say WHEN. A viewer three weeks out wants the
        // date, not a five-figure number of hours.
        if (style === 'digits' && ev?.startsAt && ms > 0) {
          when.style.display = '';
          when.textContent = absolute(ev.startsAt);
        }
      }

      // After the countdown block, which blanks `when` on every pass.
      if (s.presentation === 'postponed' && ev?.previousStartsAt) {
        when.style.display = '';
        when.textContent = `Originally ${absolute(ev.previousStartsAt)}`;
      }

      const fallback = isPre
        ? ''
        : s.presentation === 'offline'
          ? 'This stream is not being produced right now. It will play here when it starts.'
          : s.presentation === 'replay'
            ? 'This event has finished. The full replay is available.'
            : s.presentation === 'postponed'
              // Said plainly, and without a new time unless there is one. "To be
              // rescheduled" is honest; inventing a date to fill the sentence is
              // how a page ends up lying.
              ? (ev?.startsAt
                  ? `This event has been moved to ${absolute(ev.startsAt)}.`
                  : 'This event has been postponed. A new time will be announced here.')
              : s.presentation === 'cancelled'
                ? 'This event has been cancelled.'
                : 'This event has finished.';
      const copy = (isPre ? ev?.preMessage : ev?.endedMessage) ?? fallback;
      msg.textContent = copy;
      msg.style.display = copy ? '' : 'none';

      replay.style.display = s.presentation === 'replay' && ev?.replayUrl ? '' : 'none';
      return true;
    },
  };
}

function sideKey(s: PromoSide): string {
  return `${s.name}|${s.imageUrl ?? ''}|${s.subtitle ?? ''}`;
}

function digits(ms: number): string {
  const p = parts(ms);
  return unit(p.d, 'days') + unit(p.h, 'hrs') + unit(p.m, 'min') + unit(p.s, 'sec');
}

function unit(n: number, label: string): string {
  return `<span class="vp-unit"><b>${pad(n)}</b><i>${label}</i></span>`;
}

/**
 * One row builder for four templates, because structurally they are the same
 * thing: an ordered list of parties with a name, a picture and a qualifier.
 * Only the arrangement and the emphasis differ, and those are CSS.
 */
function buildSides(tpl: PromoTemplate, promo: EventPromo): HTMLElement {
  const sides = promo.sides ?? [];
  const wrap = el('div', `vp-sides vp-sides-${tpl}`);

  if (tpl === 'versus') {
    const [a, b] = sides;
    wrap.appendChild(sideEl(a, 'vp-side'));
    const vs = el('div', 'vp-vs');
    vs.textContent = promo.separator ?? 'V';
    wrap.appendChild(vs);
    if (b) wrap.appendChild(sideEl(b, 'vp-side'));
    return wrap;
  }

  if (tpl === 'billing') {
    // The poster is doing the selling. The support acts are one quiet line
    // under it, not a second display treatment competing with the headliner.
    const line = el('div', 'vp-billing-support');
    const rest = sides.slice(1).map((x) => x.name).filter(Boolean);
    if (rest.length) line.textContent = `with ${rest.join(', ')}`;
    if (sides[0]) {
      const lead = el('div', 'vp-billing-lead');
      lead.textContent = sides[0].name;
      wrap.append(lead, line);
    } else {
      wrap.appendChild(line);
    }
    return wrap;
  }

  // people and field: a row. `people` is round and captioned with roles,
  // `field` is dense and captioned with numbers. Both are the same DOM.
  for (const s of sides) wrap.appendChild(sideEl(s, 'vp-person'));
  return wrap;
}

function sideEl(s: PromoSide | undefined, cls: string): HTMLElement {
  const n = el('div', cls);
  if (!s) return n;
  if (s.imageUrl) {
    const img = document.createElement('img');
    img.className = 'vp-side-img';
    img.alt = '';
    img.src = s.imageUrl;
    // A missing badge must not leave a broken-image icon on a launch page.
    img.addEventListener('error', () => { img.remove(); });
    n.appendChild(img);
  }
  // Name and qualifier go in their own column. As direct children of the
  // side they join its flex ROW, and "Harbour" sits beside "Won last 5"
  // instead of above it.
  const text = el('div', 'vp-side-text');
  const name = el('div', 'vp-side-name');
  name.textContent = s.name;
  text.appendChild(name);
  if (s.subtitle) {
    const sub = el('div', 'vp-side-sub');
    sub.textContent = s.subtitle;
    text.appendChild(sub);
  }
  n.appendChild(text);
  return n;
}

export function phaseRules(): string {
  return `
& .vp-phase {
  position: relative; overflow: hidden;
  border-radius: var(--vp-radius); background: var(--vp-surface);
  width: 100%;
}
& .vp-phase-poster {
  position: absolute; inset: 0; width: 100%; height: 100%;
  display: block; background: var(--vp-letterbox);
}
& .vp-phase-scrim { position: absolute; inset: 0; display: none; }
/* Poster present: same construction as the video stage. Fixed overlay ink,
   legibility from a gradient rather than from a colour we were given. */
& .vp-phase.vp-on-poster .vp-phase-scrim {
  display: block;
  background: linear-gradient(to top,
    rgba(0,0,0,var(--vp-scrim-bottom, .70)) 0%,
    rgba(0,0,0,calc(var(--vp-scrim-bottom, .70) * 0.55)) 45%,
    rgba(0,0,0,var(--vp-scrim-top, .38)) 100%);
}
& .vp-phase.vp-on-poster { color: var(--vp-on-video); }
& .vp-phase.vp-on-poster .vp-phase-when,
& .vp-phase.vp-on-poster .vp-phase-msg,
& .vp-phase.vp-on-poster .vp-side-sub,
& .vp-phase.vp-on-poster .vp-billing-support { color: var(--vp-on-video-dim); }
& .vp-phase:not(.vp-on-poster) .vp-phase-poster { display: none; }

& .vp-phase-body {
  position: relative; z-index: 2;
  display: flex; flex-direction: column; align-items: flex-start;
  gap: 8px; padding: calc(var(--vp-pad) * 1.4);
}
& .vp-phase.vp-at-centre .vp-phase-body { align-items: center; text-align: center; }
& .vp-phase.vp-at-bottom .vp-phase-body { justify-content: flex-end; min-height: 100%; }

& .vp-phase-badge {
  font-size: 10px; font-weight: 700; letter-spacing: .1em;
  padding: 4px 8px; border-radius: 5px;
  background: var(--vp-primary); color: var(--vp-accent-on);
  box-shadow: 0 0 0 1.5px var(--vp-edge, transparent);
}
& .vp-phase-headline {
  font-size: 11px; font-weight: 700; letter-spacing: .12em;
  text-transform: uppercase; opacity: .85;
}
& .vp-phase-title { font-size: 18px; font-weight: 680; line-height: 1.2; }
& .vp-phase-subhead { font-size: 13px; opacity: .8; }
& .vp-phase-when { color: var(--vp-ink-dim); font-size: 13px; }
& .vp-phase-msg { color: var(--vp-ink-dim); max-width: 46ch; }
& .vp-count-word { font-size: 20px; font-weight: 620; margin-top: 2px; }
& .vp-count-digits { display: flex; gap: 14px; margin-top: 4px; }
& .vp-unit { display: flex; flex-direction: column; align-items: center; min-width: 44px; }
& .vp-unit b {
  font-size: 30px; font-weight: 700; line-height: 1;
  font-variant-numeric: tabular-nums; letter-spacing: -.02em;
}
& .vp-unit i {
  font-style: normal; font-size: 10px; letter-spacing: .09em;
  text-transform: uppercase; opacity: .7; margin-top: 5px;
}
& .vp-replay {
  margin-top: 6px; cursor: pointer; border: 0;
  padding: 10px 16px; border-radius: 999px;
  font: inherit; font-weight: 620;
  background: var(--vp-primary); color: var(--vp-accent-on);
  box-shadow: 0 0 0 2px var(--vp-edge, transparent);
}
& .vp-replay:focus-visible { outline: 3px solid var(--vp-on-video); outline-offset: 3px; }
& .vp-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* ---- versus: symmetric, and the two sides ARE the headline --------------- */
/* The block is a flex item in a column that aligns to the start, so without
   this it shrinks to its content and the two sides huddle in the middle. */
& .vp-promo { width: 100%; }
& .vp-sides-versus {
  display: flex; align-items: center; gap: 18px;
  /* Capped rather than full width: on a wide stage, two sides pushed to
     opposite edges stop reading as a fixture and start reading as two
     unrelated logos. */
  width: 100%; max-width: 560px;
  margin: 2px 0 4px;
}
& .vp-phase.vp-at-centre .vp-sides-versus { margin-left: auto; margin-right: auto; }
& .vp-side { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
& .vp-side-text { min-width: 0; }
& .vp-sides-versus .vp-side:last-child { flex-direction: row-reverse; text-align: right; }
& .vp-side .vp-side-img {
  width: 54px; height: 54px; flex: none; object-fit: contain;
  border-radius: 8px; background: var(--vp-ink-faint);
}
& .vp-side-name { font-size: 19px; font-weight: 700; line-height: 1.15; }
& .vp-side-sub { font-size: 12px; opacity: .75; margin-top: 2px; }
& .vp-vs {
  flex: none; font-size: 13px; font-weight: 800; letter-spacing: .06em;
  width: 30px; height: 30px; border-radius: 50%;
  display: grid; place-items: center;
  background: var(--vp-primary); color: var(--vp-accent-on);
  box-shadow: 0 0 0 1.5px var(--vp-edge, transparent);
}

/* ---- billing: the poster sells it, the type stays out of the way --------- */
& .vp-billing-lead {
  font-size: 30px; font-weight: 760; line-height: 1.05; letter-spacing: -.02em;
}
& .vp-billing-support { font-size: 13px; margin-top: 4px; color: var(--vp-ink-dim); }

/* ---- people and field: one row builder, two densities ------------------- */
& .vp-sides-people, & .vp-sides-field {
  display: flex; flex-wrap: wrap; gap: 16px; margin: 4px 0;
}
& .vp-person { display: flex; align-items: center; gap: 9px; }
& .vp-sides-people .vp-side-img {
  width: 44px; height: 44px; border-radius: 50%; object-fit: cover;
  background: var(--vp-ink-faint);
}
& .vp-sides-field { gap: 10px 14px; }
& .vp-sides-field .vp-side-img {
  width: 30px; height: 30px; border-radius: 6px; object-fit: contain;
  background: var(--vp-ink-faint);
}
& .vp-sides-field .vp-side-name { font-size: 14px; font-weight: 620; }
& .vp-sides-people .vp-side-name { font-size: 15px; font-weight: 660; }

/* Nested inside a layout that already draws its own panel (the hero, the
   stage). The panel keeps its content and drops its box. */
& .vp-phase-inline { background: none; }
& .vp-phase-inline .vp-phase-body { padding: 0; }
/* One row, for a header or footer strip. A bar that grows to 200px when an
   event has not started is a layout shift on somebody's homepage. */
& .vp-phase-row .vp-phase-body {
  flex-direction: row; align-items: center; flex-wrap: wrap;
  gap: 12px; padding: calc(var(--vp-pad) * 0.6) var(--vp-pad);
}
& .vp-phase-row .vp-phase-title { font-size: 15px; }
& .vp-phase-row .vp-phase-msg,
& .vp-phase-row .vp-phase-when,
& .vp-phase-row .vp-promo,
& .vp-phase-row .vp-phase-headline,
& .vp-phase-row .vp-phase-subhead { display: none !important; }
& .vp-phase-row .vp-count-word { font-size: 15px; }
& .vp-phase-row .vp-count-digits { gap: 10px; }
& .vp-phase-row .vp-unit { min-width: 34px; }
& .vp-phase-row .vp-unit b { font-size: 19px; }
& .vp-phase-row .vp-unit i { font-size: 9px; margin-top: 3px; }
& .vp-phase-row .vp-replay { margin-top: 0; padding: 7px 13px; }

@media (max-width: 520px) {
& .vp-sides-versus { gap: 10px; }
& .vp-side .vp-side-img { width: 40px; height: 40px; }
& .vp-side-name { font-size: 16px; }
& .vp-billing-lead { font-size: 23px; }
}
`;
}
