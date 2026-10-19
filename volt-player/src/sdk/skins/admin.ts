// ============================================================================
//  THE ADMIN SKIN: the console's player (recordings, previews).
//
//  For operators, not viewers: no branding, no up next, no casting. The bar
//  sits under the picture so it never covers what is being checked, and it
//  says what is actually playing (resolution, bitrate, buffer, distance from
//  live) instead of "HD". Audio-only streams collapse to the bar alone.
// ============================================================================
import type { PlayerState, Skin, SkinContext } from '../types';
import { button, el, fmtTime, label, menu, setIcon, show, slider, text, type MenuItem } from './kit';

export function adminSkin(): Skin {
  let c!: SkinContext;
  let s: PlayerState | null = null;
  const p: Record<string, HTMLElement> = {};
  let prog!: ReturnType<typeof slider>;
  let vol!: ReturnType<typeof slider>;
  let stats = false;

  function mount(ctx: SkinContext) {
    c = ctx;
    const k = ctx.commands;
    const t = ctx.t;
    const root = el('div', 'vpa');
    const top = el('div', undefined, { style: 'position:relative' }, ctx.stage);
    ctx.stage.addEventListener('click', () => k.toggle());
    p.err = el('div', 'vpa-err');
    p.spin = el('div', 'vp-spin');
    p.ov = el('div', 'vpa-ov', undefined, p.spin, p.err);
    p.stats = el('div', 'vpa-stats');
    p.stats.hidden = true;
    top.append(p.ov, p.stats);

    prog = slider('vpa-sl', 'Seek', (f, final) => {
      if (!s || !final) return;
      const r = range(s); if (r) k.seek(r.start + f * (r.end - r.start));
    });
    p.play = button('play', t('play'), () => k.toggle(), 'vp-btn', 20);
    p.back = button('back10', t('back10'), () => k.seekBy(-10), 'vp-btn', 20);
    p.fwd = button('fwd10', t('fwd10'), () => k.seekBy(10), 'vp-btn', 20);
    p.mute = button('volume', t('mute'), () => k.toggleMute(), 'vp-btn', 20);
    vol = slider('vpa-vol', t('volume'), (f) => k.setVolume(f));
    p.time = el('span', 'vpa-time');
    p.live = el('button', 'vp-live', { type: 'button' }, t('live'));
    p.live.addEventListener('click', () => k.goLive());
    p.q = el('span', 'vpa-q');
    p.cc = button('cc', t('subtitles'), () => openMenu('cc'), 'vp-btn', 20);
    p.qb = button('gear', t('quality'), () => openMenu('q'), 'vp-btn', 20);
    p.statsBtn = button('stats', t('stats'), () => { stats = !stats; p.statsBtn.classList.toggle('on', stats); if (s) update(s); }, 'vp-btn', 20);
    p.fs = button('fullscreen', t('fullscreen'), () => k.toggleFullscreen(), 'vp-btn', 20);
    const bar = el('div', 'vpa-bar', undefined, prog.root,
      el('div', 'vpa-row', undefined, p.play, p.back, p.fwd, el('div', 'vpv-vol', undefined, p.mute, vol.root), p.time, p.live,
        el('div', 'vpv-spacer'), p.q, p.cc, p.qb, p.statsBtn, p.fs));
    p.root = root;
    root.append(top, bar);
    ctx.root.appendChild(root);
  }

  function range(st: PlayerState) {
    if (st.live) return st.seekable && st.seekable.end - st.seekable.start > 10 ? st.seekable : null;
    return Number.isFinite(st.duration) && st.duration > 0 ? { start: 0, end: st.duration } : null;
  }

  function openMenu(w: 'cc' | 'q') {
    if (!s) return;
    const k = c.commands;
    if (w === 'cc') {
      const items: MenuItem[] = [{ id: '', label: c.t('off'), selected: s.textTrack == null }, ...s.textTracks.map((x) => ({ id: x.id, label: x.label, detail: x.lang, selected: s!.textTrack === x.id }))];
      menu(p.root, c.t('subtitles'), items, (id) => k.setTextTrack(id || null), p.cc);
    } else {
      const auto = s.quality === 'auto';
      const items: MenuItem[] = [{ id: 'auto', label: c.t('auto'), detail: auto && s.activeQuality ? s.activeQuality.label : undefined, selected: auto },
        ...s.qualities.map((q) => ({ id: q.id, label: q.width && q.height ? `${q.width}×${q.height}` : q.label, detail: `${Math.round(q.bitrate / 1000)} kbps`, selected: !auto && s!.quality === q.id }))];
      menu(p.root, c.t('quality'), items, (id) => k.setQuality(id), p.qb);
    }
  }

  function update(st: PlayerState) {
    s = st;
    const t = c.t;
    p.root.classList.toggle('audio', st.audioOnly && !st.hasPicture);
    const err = st.status === 'error' || st.status === 'offline';
    show(p.err, err); text(p.err, st.error ?? '');
    show(p.spin, !err && (st.status === 'loading' || st.buffering));
    setIcon(p.play, st.playing ? 'pause' : 'play');
    label(p.play, st.playing ? t('pause') : t('play'));
    const r = range(st);
    show(prog.root, !!r);
    if (r) prog.set((st.currentTime - r.start) / Math.max(0.001, r.end - r.start));
    show(p.back, !!r); show(p.fwd, !!r && !(st.live && st.atLiveEdge));
    setIcon(p.mute, st.muted || st.volume === 0 ? 'mute' : 'volume');
    vol.set(st.muted ? 0 : st.volume);
    if (st.live) {
      text(p.time, st.atLiveEdge ? '' : `-${fmtTime(st.behindLive)}`);
      show(p.live, true);
      p.live.classList.toggle('edge', st.atLiveEdge);
      text(p.live, st.atLiveEdge ? t('live') : t('goLive'));
    } else {
      show(p.live, false);
      text(p.time, Number.isFinite(st.duration) ? `${fmtTime(st.currentTime)} / ${fmtTime(st.duration)}` : fmtTime(st.currentTime));
    }
    const aq = st.activeQuality;
    text(p.q, aq ? `${aq.width && aq.height ? `${aq.height}p` : aq.label} · ${Math.round(aq.bitrate / 1000)} kbps${st.quality === 'auto' ? ' · auto' : ''}` : '');
    show(p.cc, st.textTracks.length > 0);
    p.cc.classList.toggle('on', st.textTrack != null);
    show(p.qb, st.qualities.length > 1);
    show(p.fs, !(st.audioOnly && !st.hasPicture));
    show(p.stats, stats);
    if (stats) {
      const media = c.stage.querySelector('video');
      let buf = 0;
      if (media && media.buffered.length) { for (let i = 0; i < media.buffered.length; i++) if (media.buffered.start(i) <= media.currentTime + 0.5 && media.buffered.end(i) >= media.currentTime) buf = media.buffered.end(i) - media.currentTime; }
      text(p.stats, [
        `${t('resolution')}  ${media && media.videoWidth ? `${media.videoWidth}×${media.videoHeight}` : '-'}`,
        `${t('bitrate')}     ${aq ? `${Math.round(aq.bitrate / 1000)} kbps` : '-'}`,
        `${t('buffer')}      ${buf.toFixed(1)} s`,
        st.live ? `${t('latency')} ${st.behindLive.toFixed(1)} s` : '',
        `status      ${st.status}`,
      ].filter(Boolean).join('\n'));
    }
  }

  return { mount, update };
}
