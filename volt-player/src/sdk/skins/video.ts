// ============================================================================
//  THE DEFAULT VIDEO SKIN: what viewers see on a client's site, the share
//  page and the apps' web views.
//
//  Top: title (the item, or the programme on air), logo, cast and AirPlay.
//  Middle: the big play button, a spinner, or a message with a retry.
//  Bottom: scrubber (VOD, or the DVR window on live), play, ±10 s, volume,
//  time or LIVE / Go live, Start over, then subtitles (only when the stream
//  has them), quality, schedule/playlist, picture in picture, full screen.
//  Up next appears bottom right before the end of an item or a programme.
// ============================================================================
import type { PlayerState, Programme, Skin, SkinContext } from '../types';
import { autoHide, button, el, fmtClock, fmtTime, label, menu, setIcon, show, skipButton, slider, text, upNextCard, type MenuItem, type UpNextCard } from './kit';

export function videoSkin(): Skin {
  let c!: SkinContext;
  let s: PlayerState | null = null;
  const parts: Record<string, HTMLElement> = {};
  let prog!: ReturnType<typeof slider>;
  let vol!: ReturnType<typeof slider>;
  let tip!: HTMLElement;
  let unhide = () => {};
  let up!: UpNextCard;
  let skip!: ReturnType<typeof skipButton>;
  let panelOpen = false;
  let lastPanelKey = '';

  const t = (k: string, v?: Record<string, string | number>) => c.t(k, v);

  function mount(ctx: SkinContext) {
    c = ctx;
    const k = ctx.commands;
    const root = el('div', 'vpv');
    root.appendChild(ctx.stage);
    root.addEventListener('click', (e) => { if (e.target === root || ctx.stage.contains(e.target as Node)) k.toggle(); });
    root.addEventListener('dblclick', (e) => { if (ctx.stage.contains(e.target as Node)) k.toggleFullscreen(); });
    parts.shade = el('div', 'vpv-shade');

    parts.title = el('b'); parts.sub = el('span');
    parts.logo = el('img', 'vpv-logo', { alt: '' });
    parts.cast = button('cast', t('cast'), () => k.cast());
    parts.airplay = button('airplay', t('airplay'), () => k.airplay());
    parts.top = el('div', 'vpv-top', undefined, el('div', 'vpv-title', undefined, parts.title, parts.sub), parts.cast, parts.airplay);

    parts.big = button('play', t('play'), () => k.play(), 'vpv-big', 34);
    parts.spin = el('div', 'vp-spin');
    parts.msgText = el('p');
    parts.retry = el('button', 'vp-pill', { type: 'button' }, t('retry'));
    parts.retry.addEventListener('click', (e) => { e.stopPropagation(); k.play(); });
    parts.msg = el('div', 'vpv-msg', undefined, parts.msgText, parts.retry);
    parts.center = el('div', 'vpv-center', undefined, parts.big, parts.spin, parts.msg);

    // Up next: the shared template (kit.upNextCard), the same card whatever drives
    // it: the stream's own trigger, the guide, or the end of a playlist item.
    up = upNextCard(ctx, 'overlay');
    parts.up = up.el;
    // Skip intro / credits (on-demand only), where Up next would sit.
    skip = skipButton(ctx);
    parts.skip = skip.el;

    // Bar
    tip = el('div', 'vpv-tip'); tip.hidden = true;
    prog = slider('vpv-sl', 'Seek', (f, final) => {
      if (!s) return;
      const r = range(s);
      if (!r) return;
      const target = r.start + f * (r.end - r.start);
      if (final) k.seek(target);
      else showTip(f, target);
    }, (f) => {
      if (f == null || !s) { tip.hidden = true; return; }
      const r = range(s); if (!r) return;
      showTip(f, r.start + f * (r.end - r.start));
    });
    parts.prog = el('div', 'vpv-prog', undefined, prog.root, tip);
    parts.play = button('play', t('play'), () => k.toggle());
    parts.back = button('back10', t('back10'), () => k.seekBy(-10));
    parts.fwd = button('fwd10', t('fwd10'), () => k.seekBy(10));
    parts.mute = button('volume', t('mute'), () => k.toggleMute());
    vol = slider('vpv-volsl', t('volume'), (f) => k.setVolume(f));
    parts.vol = el('div', 'vpv-vol', undefined, parts.mute, vol.root);
    parts.time = el('span', 'vpv-time');
    parts.live = el('button', 'vp-live', { type: 'button' }, t('live'));
    parts.live.addEventListener('click', (e) => { e.stopPropagation(); k.goLive(); });
    parts.startOver = el('button', 'vpv-chip', { type: 'button', 'data-tip': '' });
    parts.startOver.append(t('startOver'));
    parts.startOver.addEventListener('click', (e) => { e.stopPropagation(); k.startOver(); });
    parts.cc = button('cc', t('subtitles'), () => openMenu('cc'));
    parts.q = button('gear', t('quality'), () => openMenu('q'));
    parts.audio = button('music', t('audio'), () => openMenu('audio'));
    parts.list = button('list', t('schedule'), () => togglePanel());
    parts.prev = button('prev', t('previous'), () => k.previous());
    parts.next = button('next', t('nextItem'), () => k.next());
    parts.pip = button('pip', t('pip'), () => k.togglePip());
    parts.fs = button('fullscreen', t('fullscreen'), () => k.toggleFullscreen());
    parts.bar = el('div', 'vpv-bar', undefined, parts.prog,
      el('div', 'vpv-row', undefined, parts.play, parts.prev, parts.next, parts.back, parts.fwd, parts.vol, parts.time, parts.live, parts.startOver,
        el('div', 'vpv-spacer'), parts.cc, parts.audio, parts.q, parts.list, parts.pip, parts.fs));
    parts.bar.addEventListener('click', (e) => e.stopPropagation());

    parts.panelTitle = el('span');
    parts.panelList = el('div', 'vp-panel-l');
    parts.panel = el('div', 'vp-panel', undefined,
      el('div', 'vp-panel-h', undefined, parts.panelTitle, button('close', t('cancel'), () => togglePanel(false))), parts.panelList);
    parts.panel.hidden = true;
    parts.panel.addEventListener('click', (e) => e.stopPropagation());

    root.append(parts.shade, parts.top, parts.logo, parts.center, parts.up, parts.skip, parts.bar, parts.panel);
    ctx.root.appendChild(root);
    parts.root = root;
    applyLogo();
    unhide = autoHide(ctx.root.closest('.vp') as HTMLElement ?? ctx.root, () => !!s?.playing);
  }

  function applyLogo() {
    const th = c.theme;
    const logo = parts.logo as HTMLImageElement;
    if (th.logoUrl && th.logoPosition !== 'none') {
      if (logo.getAttribute('src') !== th.logoUrl) logo.src = th.logoUrl;
      logo.hidden = false;
      if (th.logoPosition === 'bottom-right') { logo.className = 'vpv-logo br'; parts.root.appendChild(logo); }
      else { logo.className = 'vpv-logo'; if (th.logoPosition === 'top-left') parts.top.prepend(logo); else parts.top.insertBefore(logo, parts.cast); }
    } else logo.hidden = true;
  }

  function range(st: PlayerState): { start: number; end: number } | null {
    if (st.live) return st.dvr && st.seekable ? st.seekable : null;
    return Number.isFinite(st.duration) && st.duration > 0 ? { start: 0, end: st.duration } : null;
  }

  function showTip(f: number, target: number) {
    if (!s) return;
    tip.hidden = false;
    tip.style.left = `${f * 100}%`;
    if (s.live && s.seekable) {
      const behind = s.seekable.end - target;
      tip.textContent = s.wallClock != null ? fmtClock(s.wallClock + (target - s.currentTime) * 1000) : behind < 8 ? t('live') : `-${fmtTime(behind)}`;
    } else tip.textContent = fmtTime(target);
  }

  function openMenu(which: 'cc' | 'q' | 'audio') {
    if (!s) return;
    const k = c.commands;
    let items: MenuItem[] = [];
    let title = '';
    if (which === 'cc') {
      title = t('subtitles');
      items = [{ id: '', label: t('off'), selected: s.textTrack == null }, ...s.textTracks.map((x) => ({ id: x.id, label: x.label, selected: s!.textTrack === x.id }))];
      menu(parts.root, title, items, (id) => k.setTextTrack(id || null), parts.cc);
    } else if (which === 'q') {
      title = t('quality');
      const auto = s.quality === 'auto';
      items = [{ id: 'auto', label: auto && s.activeQuality ? t('autoNow', { q: s.activeQuality.label }) : t('auto'), selected: auto },
        ...s.qualities.map((q) => ({ id: q.id, label: q.label, detail: `${(q.bitrate / 1e6).toFixed(1)} Mbps`, selected: !auto && s!.quality === q.id }))];
      menu(parts.root, title, items, (id) => k.setQuality(id), parts.q);
    } else {
      title = t('audio');
      items = s.audioTracks.map((a) => ({ id: a.id, label: a.label, detail: a.channels && a.channels > 2 ? `${a.channels} ch` : undefined, selected: s!.audioTrack === a.id }));
      menu(parts.root, title, items, (id) => k.setAudioTrack(id), parts.audio);
    }
  }

  function togglePanel(on = !panelOpen) {
    panelOpen = on;
    show(parts.panel, on);
    lastPanelKey = '';
    if (on && s) renderPanel(s);
  }

  /** Schedule (EPG) for live, the playlist otherwise. Rebuilt only when it changes. */
  function renderPanel(st: PlayerState) {
    const useSchedule = st.live && st.schedule.length > 0;
    const now = st.wallClock ?? Date.now();
    const key = useSchedule ? `s:${st.programme?.id}:${st.schedule.length}:${Math.floor(now / 30000)}` : `p:${st.index}:${st.items.length}`;
    if (key === lastPanelKey) return;
    lastPanelKey = key;
    text(parts.panelTitle, useSchedule ? t('schedule') : t('playlist'));
    const list = parts.panelList;
    list.innerHTML = '';
    if (useSchedule) {
      const upcoming = st.schedule.filter((p) => p.endsAt > now - 3 * 3600_000).slice(0, 40);
      for (const p of upcoming) list.appendChild(progRow(p, st, now));
      list.querySelector('.now')?.scrollIntoView?.({ block: 'center' });
    } else {
      st.items.forEach((it, i) => {
        const r = el('button', 'vp-prog' + (i === st.index ? ' now' : ''), { type: 'button' },
          el('time', undefined, undefined, String(i + 1)),
          el('div', undefined, undefined, el('b', undefined, undefined, it.title ?? `Item ${i + 1}`),
            it.subtitle ? el('span', undefined, undefined, it.subtitle) : null,
            i === st.index ? el('em', undefined, undefined, t('now')) : null));
        r.addEventListener('click', () => { c.commands.playItem(i); togglePanel(false); });
        list.appendChild(r);
      });
    }
  }

  function progRow(p: Programme, st: PlayerState, now: number): HTMLElement {
    const isNow = st.programme?.id === p.id;
    const pct = isNow ? Math.min(100, Math.max(0, ((now - p.startsAt) / (p.endsAt - p.startsAt)) * 100)) : 0;
    const row = el('button', 'vp-prog' + (isNow ? ' now' : ''), { type: 'button' },
      el('time', undefined, undefined, fmtClock(p.startsAt)),
      el('div', undefined, undefined,
        isNow ? el('em', undefined, undefined, t('onNow')) : null,
        el('b', undefined, undefined, p.title),
        p.subtitle ? el('span', undefined, undefined, p.subtitle) : null,
        isNow ? (() => { const b = el('div', 'bar'); const i = el('i'); i.style.width = `${pct}%`; b.appendChild(i); return b; })() : null));
    if (isNow && st.canStartOver) {
      row.setAttribute('data-tip', t('startOverHint', { title: p.title }));
      row.addEventListener('click', () => { c.commands.startOver(); togglePanel(false); });
    } else if (isNow) row.addEventListener('click', () => { c.commands.goLive(); togglePanel(false); });
    return row;
  }

  function update(st: PlayerState) {
    s = st;
    const ctl = c.theme.controls;
    const item = st.item;
    // Title: the programme on air (live with a guide), else the item.
    const title = st.live && st.programme ? st.programme.title : item?.title ?? '';
    const sub = st.live && st.programme ? (st.programme.subtitle ?? item?.title ?? '') : item?.subtitle ?? '';
    text(parts.title as HTMLElement, ctl.title ? title : '');
    text(parts.sub as HTMLElement, ctl.title && sub !== title ? sub : '');
    show(parts.top.querySelector('.vpv-title') as HTMLElement, ctl.title && !!title);

    // Cast / AirPlay
    show(parts.cast, ctl.cast && (st.cast.available || st.cast.state !== 'none'));
    setIcon(parts.cast, st.cast.state === 'connected' ? 'castOn' : 'cast');
    parts.cast.classList.toggle('on', st.cast.state === 'connected');
    label(parts.cast, st.cast.state === 'connected' ? t('stopCasting') : t('cast'));
    show(parts.airplay, ctl.airplay && st.airplay.available);
    parts.airplay.classList.toggle('on', st.airplay.active);

    // Centre
    const busy = st.status === 'loading' || st.buffering;
    const err = st.status === 'error' || st.status === 'offline';
    const casting = st.cast.state === 'connected';
    show(parts.spin, busy && !err);
    show(parts.msg, err || casting);
    if (err) { text(parts.msgText, st.error ?? t('offline')); show(parts.retry, true); }
    else if (casting) { text(parts.msgText, t('castingTo', { device: st.cast.device ?? 'TV' })); show(parts.retry, false); }
    const showBig = !st.playing && !busy && !err && !casting;
    show(parts.big, showBig);
    setIcon(parts.big, st.status === 'ended' ? 'replay' : 'play');

    // Up next, and Skip
    up.update(st);
    skip.update(st);

    // Bar
    setIcon(parts.play, st.playing ? 'pause' : st.status === 'ended' ? 'replay' : 'play');
    label(parts.play, st.playing ? t('pause') : t('play'));
    const r = range(st);
    show(parts.prog, !!r);
    if (r) {
      const f = (st.currentTime - r.start) / Math.max(0.001, r.end - r.start);
      prog.set(f);
    }
    const seekable = !!r;
    show(parts.back, ctl.seekButtons && seekable);
    show(parts.fwd, ctl.seekButtons && seekable && !(st.live && st.atLiveEdge));
    const many = st.items.length > 1;
    show(parts.prev, many);
    show(parts.next, many && st.index < st.items.length - 1);
    show(parts.vol, ctl.volume);
    setIcon(parts.mute, st.muted || st.volume === 0 ? 'mute' : 'volume');
    label(parts.mute, st.muted ? t('unmute') : t('mute'));
    vol.set(st.muted ? 0 : st.volume);
    if (st.live) {
      text(parts.time, st.atLiveEdge ? '' : t('behindLive', { time: fmtTime(st.behindLive) }));
      show(parts.time, !st.atLiveEdge);
      show(parts.live, st.status !== 'offline');
      parts.live.classList.toggle('edge', st.atLiveEdge);
      text(parts.live, st.atLiveEdge ? t('live') : t('goLive'));
      parts.live.setAttribute('aria-label', st.atLiveEdge ? t('live') : t('goLive'));
    } else {
      show(parts.live, false);
      show(parts.time, true);
      text(parts.time, Number.isFinite(st.duration) ? `${fmtTime(st.currentTime)} / ${fmtTime(st.duration)}` : fmtTime(st.currentTime));
    }
    show(parts.startOver, ctl.startOver && st.canStartOver && st.currentTime - (st.seekable?.start ?? 0) > 5);
    if (st.programme) parts.startOver.setAttribute('data-tip', t('startOverHint', { title: st.programme.title }));
    show(parts.cc, ctl.subtitles && st.textTracks.length > 0);
    parts.cc.classList.toggle('on', st.textTrack != null);
    show(parts.audio, ctl.audioTracks && st.audioTracks.length > 1);
    show(parts.q, ctl.quality && st.qualities.length > 1);
    const hasPanel = (st.live && st.schedule.length > 0) || st.items.length > 1;
    show(parts.list, ctl.schedule && hasPanel);
    label(parts.list, st.live && st.schedule.length ? t('schedule') : t('playlist'));
    show(parts.pip, ctl.pip && st.pip.available && !st.audioOnly);
    show(parts.fs, ctl.fullscreen);
    setIcon(parts.fs, st.fullscreen ? 'exitFullscreen' : 'fullscreen');
    label(parts.fs, st.fullscreen ? t('exitFullscreen') : t('fullscreen'));
    if (panelOpen) renderPanel(st);
  }

  return {
    mount, update,
    themeChanged() { applyLogo(); },
    destroy() { unhide(); },
  };
}
