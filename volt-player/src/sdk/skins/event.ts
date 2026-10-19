// ============================================================================
//  THE EVENT SKIN: a live event's whole life, not just the part that plays.
//
//  An event is announced, counts down, airs, ends, and may come back as a
//  replay; it can be postponed or called off. Most of that life is not
//  "playing", so this skin draws the phase the control plane reports
//  (state.presentation) over the event's promo (poster, the two teams or the
//  billing), and hands over to the full video skin when it is live:
//
//    pre         countdown, local date and time, Add to calendar
//    offline     past the start but not live yet: "Starting soon"
//    postponed   was / now, or "a new date will be announced"
//    cancelled   said plainly, no countdown
//    ended       the promoter's closing message
//    replay      Watch the replay (the published VOD)
//    locked      at any phase: the paywall's offers, or Sign in, or the
//                region message. Buying before the start is the common case.
//
//  Buy and Sign in are commands: the player opens the purchase / sign-in page
//  (purchaseUrl / signInUrl) or hands the choice to the host page as an event.
// ============================================================================
import type { PlayerState, Product, Skin, SkinContext } from '../types';
import { videoSkin } from './video';
import { el, show, text } from './kit';
import { fmtPrice, fmtTerm } from '../resolver';

function when(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  } catch { return new Date(ms).toISOString(); }
}

function icsDate(ms: number): string { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function icsText(s: string): string { return s.replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\r?\n/g, '\\n'); }

/** An .ics file for the event, so "Add to calendar" works with every calendar app. */
export function eventIcs(ev: { id: string; title: string; startsAt: number; endsAt?: number | null; description?: string | null }, url: string): string {
  const end = ev.endsAt && ev.endsAt > ev.startsAt ? ev.endsAt : ev.startsAt + 2 * 3600_000;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Volt//Player//EN', 'BEGIN:VEVENT',
    `UID:${ev.id}@volt-player`, `DTSTAMP:${icsDate(Date.now())}`, `DTSTART:${icsDate(ev.startsAt)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(ev.title)}`, ev.description ? `DESCRIPTION:${icsText(ev.description)}` : '', `URL:${url}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

/** Days, hours, minutes, seconds. */
export function splitCountdown(ms: number): { d: number; h: number; m: number; s: number } {
  const t = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(t / 86400), h: Math.floor((t % 86400) / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}

export function eventSkin(): Skin {
  const video = videoSkin();
  let c!: SkinContext;
  const p: Record<string, HTMLElement> = {};
  const tiles: Record<'d' | 'h' | 'm' | 's', HTMLElement> = {} as any;
  let lastProducts = '';
  let lastSides = '';
  let state: PlayerState | null = null;

  function tile(k: 'd' | 'h' | 'm' | 's', label: string) {
    const n = el('b', undefined, undefined, '00');
    tiles[k] = n;
    return el('div', 'vpe-tile', undefined, n, el('small', undefined, undefined, label));
  }

  function mount(ctx: SkinContext) {
    c = ctx;
    video.mount(ctx);
    const t = ctx.t;
    p.poster = el('div', 'vpe-poster');
    p.badge = el('span', 'vpe-badge');
    p.kick = el('span', 'vpe-kick');
    p.title = el('h2', 'vpe-title');
    p.sides = el('div', 'vpe-sides');
    p.sub = el('div', 'vpe-sub');
    p.cdLabel = el('div', 'vpe-cdl', undefined, t('startsIn2'));
    p.countdown = el('div', 'vpe-cd', { role: 'timer', 'aria-live': 'off' }, tile('d', t('days')), tile('h', t('hours')), tile('m', t('mins')), tile('s', t('secs')));
    p.msg = el('p', 'vpe-msg');
    p.cal = el('button', 'vpe-btn ghost', { type: 'button' }, t('addToCalendar'));
    p.cal.addEventListener('click', (e) => { e.stopPropagation(); addToCalendar(); });
    p.replay = el('button', 'vpe-btn', { type: 'button' }, t('watchReplay'));
    p.replay.addEventListener('click', (e) => { e.stopPropagation(); c.commands.playReplay(); });
    p.signin = el('button', 'vpe-btn', { type: 'button' }, t('signIn'));
    p.signin.addEventListener('click', (e) => { e.stopPropagation(); c.commands.signIn(); });
    p.spin = el('div', 'vp-spin');
    p.actions = el('div', 'vpe-actions', undefined, p.replay, p.signin, p.cal);
    p.buyTitle = el('div', 'vpe-buyt', undefined, t('buyTitle'));
    p.buyList = el('div', 'vpe-buyl');
    p.recheck = el('button', 'vpe-link', { type: 'button' }, t('alreadyBought'));
    p.recheck.addEventListener('click', (e) => { e.stopPropagation(); c.commands.refreshAccess(); });
    p.buy = el('div', 'vpe-buy', undefined, p.buyTitle, p.buyList, p.recheck);
    p.logo = el('img', 'vpe-logo', { alt: '' });
    p.panel = el('div', 'vpe-in', undefined,
      el('div', 'vpe-info', undefined,
        el('div', 'vpe-top', undefined, p.badge, p.kick), p.title, p.sides, p.sub,
        p.cdLabel, p.countdown, p.spin, p.msg, p.actions),
      p.buy);
    p.root = el('div', 'vpe', undefined, p.poster, el('div', 'vpe-shade'), p.logo, p.panel);
    // Clicks on the overlay must not reach the video skin (which would toggle play).
    p.root.addEventListener('click', (e) => e.stopPropagation());
    ctx.root.appendChild(p.root);
    themeChanged();
  }

  function themeChanged() {
    const th = c.theme;
    const l = p.logo as HTMLImageElement;
    if (th.logoUrl && th.logoPosition !== 'none') { if (l.getAttribute('src') !== th.logoUrl) l.src = th.logoUrl; l.hidden = false; }
    else l.hidden = true;
  }

  function addToCalendar() {
    const ev = state?.event;
    if (!ev || ev.startsAt == null) return;
    const ics = eventIcs({ id: ev.id, title: ev.title, startsAt: ev.startsAt, endsAt: ev.endsAt, description: ev.description }, location.href);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    a.download = `${ev.title.replace(/[^\w\- ]+/g, '').trim() || 'event'}.ics`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function renderSides(st: PlayerState) {
    const promo = st.event?.promo;
    const sides = promo?.sides ?? [];
    const key = JSON.stringify([promo?.template, sides]);
    if (key === lastSides) return;
    lastSides = key;
    p.sides.innerHTML = '';
    p.sides.className = `vpe-sides ${promo?.template === 'versus' ? 'vs' : 'list'}`;
    const side = (s: { name: string; imageUrl?: string | null; subtitle?: string | null }) =>
      el('div', 'vpe-side', undefined,
        s.imageUrl ? el('img', undefined, { src: s.imageUrl, alt: '' }) : null,
        el('div', undefined, undefined, el('b', undefined, undefined, s.name), s.subtitle ? el('span', undefined, undefined, s.subtitle) : null));
    if (promo?.template === 'versus' && sides.length === 2) {
      p.sides.append(side(sides[0]), el('i', 'vpe-sep', undefined, promo.separator || 'vs'), side(sides[1]));
    } else sides.slice(0, 6).forEach((s) => p.sides.appendChild(side(s)));
    show(p.sides, sides.length > 0);
  }

  function renderProducts(products: Product[]) {
    const key = JSON.stringify(products);
    if (key === lastProducts) return;
    lastProducts = key;
    p.buyList.innerHTML = '';
    for (const pr of products) {
      const b = el('button', 'vpe-btn', { type: 'button' }, c.t('buy'));
      b.addEventListener('click', (e) => { e.stopPropagation(); c.commands.purchase(pr.productKey); });
      p.buyList.appendChild(el('div', 'vpe-offer', undefined,
        el('div', undefined, undefined, el('b', undefined, undefined, pr.name || fmtTerm(pr)), el('span', undefined, undefined, fmtTerm(pr))),
        el('strong', undefined, undefined, fmtPrice(pr.priceCents, pr.currency)), b));
    }
  }

  function update(st: PlayerState) {
    state = st;
    video.update(st);
    const t = c.t;
    const ev = st.event;
    const ph = st.presentation;
    const locked = st.status === 'locked';
    const playingLive = (ph === 'live' || !ph) && !locked;
    // The overlay covers the player except while it plays: live and unlocked, or the replay.
    const covered = !st.replaying && !playingLive && (!!ev || locked);
    show(p.root, covered);
    (c.root.closest('.vp') as HTMLElement | null)?.classList.toggle('vpe-open', covered);
    if (!covered) return;

    const poster = ev?.promo?.posterUrl ?? st.item?.artworkUrl ?? null;
    const bg = poster ? `url("${poster.replace(/"/g, '%22')}")` : '';
    if (p.poster.style.backgroundImage !== bg) p.poster.style.backgroundImage = bg;
    p.poster.style.backgroundSize = ev?.promo?.posterFit === 'contain' ? 'contain' : 'cover';

    text(p.kick, ev?.promo?.headline ?? '');
    text(p.title, ev?.title ?? st.item?.title ?? '');
    renderSides(st);
    const sub = [ev?.promo?.subhead, ev?.startsAt && ph !== 'cancelled' && ph !== 'ended' && ph !== 'replay' ? when(ev.startsAt) : null].filter(Boolean).join(' · ');
    text(p.sub, sub);

    // The phase badge.
    const badge = locked && ph === 'live' ? t('liveNow') : ph === 'postponed' ? t('postponed') : ph === 'cancelled' ? t('cancelled') : ph === 'live' ? t('liveNow') : '';
    text(p.badge, badge);
    show(p.badge, !!badge);
    p.badge.dataset.kind = ph === 'cancelled' ? 'bad' : ph === 'postponed' ? 'warn' : 'live';

    // Countdown: before the start, and for a postponed event that has a new time.
    const ms = st.msToStart;
    const counting = ms != null && (ph === 'pre' || ph === 'postponed');
    show(p.cdLabel, counting); show(p.countdown, counting);
    if (counting) {
      const d = splitCountdown(ms!);
      text(tiles.d, String(d.d)); show(tiles.d.parentElement as HTMLElement, d.d > 0);
      text(tiles.h, String(d.h).padStart(2, '0')); text(tiles.m, String(d.m).padStart(2, '0')); text(tiles.s, String(d.s).padStart(2, '0'));
    }
    show(p.spin, ph === 'offline' && !locked);

    // The message under it.
    let msg = '';
    if (ph === 'pre') msg = ev?.preMessage ?? '';
    else if (ph === 'offline') msg = `${t('startingSoon')}. ${t('startingSoonText')}`;
    else if (ph === 'postponed') msg = ev?.startsAt && ms != null
      ? [ev.previousStartsAt ? t('wasAt', { when: when(ev.previousStartsAt) }) : '', t('nowAt', { when: when(ev.startsAt) })].filter(Boolean).join(' · ')
      : t('newDateTba');
    else if (ph === 'cancelled') msg = ev?.endedMessage ?? ev?.preMessage ?? '';
    else if (ph === 'ended') msg = ev?.endedMessage ?? t('ended');
    else if (ph === 'replay') msg = ev?.endedMessage ?? t('replayHint');
    if (locked && st.access.mode === 'blocked') msg = st.access.message ?? t('regionBlocked');
    text(p.msg, msg);
    show(p.msg, !!msg);

    // Actions.
    show(p.replay, ph === 'replay' && !!ev?.replayAssetId && !locked);
    show(p.cal, ph === 'pre' && ev?.startsAt != null || (ph === 'postponed' && counting));
    show(p.signin, locked && st.access.mode === 'sign_in');
    p.signin.textContent = t('signIn');
    const paywall = locked && st.access.mode === 'paywall' && st.access.products.length > 0 && ph !== 'cancelled';
    show(p.buy, paywall);
    if (paywall) renderProducts(st.access.products);
    show(p.actions, !p.replay.hidden || !p.cal.hidden || !p.signin.hidden);
  }

  return {
    mount, update,
    themeChanged(th) { video.themeChanged?.(th); themeChanged(); },
    destroy() { video.destroy?.(); },
  };
}
