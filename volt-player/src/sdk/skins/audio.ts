// ============================================================================
//  AUDIO SKINS: radio stations, podcasts, audio-only events.
//
//    audio_square      a square tile: artwork, title, play. Fits a grid.
//    audio_wave        a strip: artwork, title and a live waveform.
//    audio_nowplaying  a panel: big artwork, track details, the last five
//                      tracks and what is coming up.
//
//  What they show, best first: the track now playing (radio metadata), else
//  the programme on air (the guide), else the item's own title and artwork.
//  The media element is kept in the page (sound has to come from somewhere)
//  but never shown.
// ============================================================================
import type { PlayerState, Skin, SkinContext, TrackInfo } from '../types';
import { button, el, fmtClock, label, setIcon, show, slider, text } from './kit';

interface Info { title: string; sub: string; art: string | null; meta: string }

function info(st: PlayerState): Info {
  const item = st.item;
  const np = st.nowPlaying;
  if (np && np.title) {
    return { title: np.title, sub: np.artist ?? '', art: np.artworkUrl ?? item?.artworkUrl ?? null,
      meta: [np.album, np.year].filter(Boolean).join(' · ') };
  }
  if (st.programme) {
    return { title: st.programme.title, sub: st.programme.subtitle ?? item?.title ?? '', art: st.programme.imageUrl ?? item?.artworkUrl ?? null,
      meta: `${fmtClock(st.programme.startsAt)} – ${fmtClock(st.programme.endsAt)}` };
  }
  return { title: item?.title ?? '', sub: item?.subtitle ?? item?.description ?? '', art: item?.artworkUrl ?? null, meta: '' };
}

function setArt(e: HTMLElement, url: string | null) {
  const v = url ? `url("${url.replace(/"/g, '%22')}")` : '';
  if (e.style.backgroundImage !== v) e.style.backgroundImage = v;
  e.classList.toggle('empty', !url);
}

/** The shared play button: play, pause, or a spinner while loading. */
function playButton(c: SkinContext) {
  const b = button('play', c.t('play'), () => c.commands.toggle(), 'vpx-play', 26);
  const spin = el('div', 'vp-spin');
  b.appendChild(spin);
  return {
    el: b,
    update(st: PlayerState) {
      const busy = st.status === 'loading' || st.buffering;
      b.classList.toggle('busy', busy);
      show(spin, busy);
      const svg = b.querySelector('svg') as SVGElement | null;
      if (svg) svg.style.display = busy ? 'none' : '';
      setIcon(b, st.playing ? 'pause' : 'play');
      label(b, st.playing ? c.t('pause') : c.t('play'));
    },
  };
}

function liveBadge(c: SkinContext) {
  const b = el('button', 'vp-live', { type: 'button' }, c.t('live'));
  b.addEventListener('click', () => c.commands.goLive());
  return {
    el: b,
    update(st: PlayerState) {
      show(b, st.live);
      b.classList.toggle('edge', st.live && st.atLiveEdge && st.playing);
      text(b, !st.atLiveEdge && st.playing ? c.t('goLive') : c.t('live'));
    },
  };
}

function volume(c: SkinContext, withSlider: boolean) {
  const m = button('volume', c.t('mute'), () => c.commands.toggleMute(), 'vp-btn', 20);
  const sl = withSlider ? slider('vpx-vol', c.t('volume'), (f) => c.commands.setVolume(f)) : null;
  const wrap = el('div', 'vpv-vol', undefined, m, sl?.root ?? null);
  return {
    el: wrap,
    update(st: PlayerState) {
      setIcon(m, st.muted || st.volume === 0 ? 'mute' : 'volume');
      label(m, st.muted ? c.t('unmute') : c.t('mute'));
      sl?.set(st.muted ? 0 : st.volume);
    },
  };
}

function errorLine(st: PlayerState): string {
  return st.status === 'error' || st.status === 'offline' ? st.error ?? '' : '';
}

// ---------------------------------------------------------------- square
export function audioSquareSkin(): Skin {
  const p: Record<string, HTMLElement> = {};
  let pb!: ReturnType<typeof playButton>;
  let lv!: ReturnType<typeof liveBadge>;
  return {
    mount(ctx) {
      pb = playButton(ctx); lv = liveBadge(ctx);
      p.art = el('div', 'vpx-art');
      p.logo = el('img', undefined, { alt: '' });
      p.title = el('b'); p.sub = el('span'); p.err = el('div', 'vpx-err');
      const root = el('div', 'vpx sq', undefined, ctx.stage, p.art, el('div', 'vpx-fade'),
        el('div', 'vpx-top', undefined, p.logo, lv.el),
        el('div', 'vpx-in', undefined, el('div', 'vpx-t', undefined, p.title, p.sub, p.err), pb.el));
      ctx.root.appendChild(root);
      this.themeChanged?.(ctx.theme);
    },
    themeChanged(th) { const l = p.logo as HTMLImageElement; if (th.logoUrl && th.logoPosition !== 'none') { l.src = th.logoUrl; l.hidden = false; } else l.hidden = true; },
    update(st) {
      const i = info(st);
      setArt(p.art, i.art);
      text(p.title, i.title); text(p.sub, i.sub); text(p.err, errorLine(st));
      pb.update(st); lv.update(st);
    },
  };
}

// ---------------------------------------------------------------- wave
export function audioWaveSkin(): Skin {
  let c!: SkinContext;
  const p: Record<string, HTMLElement> = {};
  let pb!: ReturnType<typeof playButton>;
  let lv!: ReturnType<typeof liveBadge>;
  let vo!: ReturnType<typeof volume>;
  let canvas!: HTMLCanvasElement;
  let raf = 0;
  let st: PlayerState | null = null;
  let phase = 0;
  let color = '';
  let frame = 0;
  const BARS = 48;
  const heights = new Float32Array(BARS);

  function draw() {
    raf = requestAnimationFrame(draw);
    const g = canvas.getContext('2d');
    if (!g) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const playing = !!st?.playing;
    let lv = playing && !st?.muted ? c.commands.levels() : null;
    // All zeros (muted at the source, or silence): show the idle motion rather than a dead line.
    if (lv) { let mx = 0; for (let i = 0; i < lv.length; i++) if (lv[i] > mx) mx = lv[i]; if (mx < 4) lv = null; }
    phase += 0.06;
    for (let i = 0; i < BARS; i++) {
      let target: number;
      if (lv && lv.length) {
        // Speech and music live in the lower bins: spread the first 70% over the bars.
        const bin = Math.floor((i / BARS) * lv.length * 0.7);
        target = lv[bin] / 255;
      } else if (playing) {
        // No access to the samples (a cross-origin stream): a gentle idle motion, honest about being decorative.
        target = 0.25 + 0.2 * Math.sin(phase + i * 0.45) * Math.sin(phase * 0.7 + i * 0.13);
      } else target = 0.06;
      heights[i] += (target - heights[i]) * 0.35;
    }
    const gap = 2, bw = Math.max(1, (w - gap * (BARS - 1)) / BARS);
    if (!color || (frame++ % 120) === 0) color = getComputedStyle(canvas).getPropertyValue('--vp-primary').trim() || '#3f7bff';
    g.fillStyle = color;
    for (let i = 0; i < BARS; i++) {
      const bh = Math.max(2, heights[i] * h);
      const x = i * (bw + gap), y = (h - bh) / 2;
      g.globalAlpha = playing ? 0.95 : 0.4;
      g.beginPath();
      (g as any).roundRect ? (g as any).roundRect(x, y, bw, bh, Math.min(2, bw / 2)) : g.rect(x, y, bw, bh);
      g.fill();
    }
  }

  return {
    mount(ctx) {
      c = ctx;
      pb = playButton(ctx); lv = liveBadge(ctx); vo = volume(ctx, false);
      p.art = el('div', 'vpx-art');
      p.title = el('b'); p.sub = el('span'); p.err = el('div', 'vpx-err');
      canvas = el('canvas', undefined, { 'aria-hidden': 'true' });
      const root = el('div', 'vpx wv', undefined, ctx.stage, pb.el, p.art,
        el('div', 'vpx-mid', undefined, el('div', 'vpx-t', undefined, p.title, p.sub), canvas, p.err),
        el('div', 'vpx-side', undefined, lv.el, vo.el));
      ctx.root.appendChild(root);
      raf = requestAnimationFrame(draw);
    },
    update(s) {
      st = s;
      const i = info(s);
      setArt(p.art, i.art); show(p.art, !!i.art);
      text(p.title, i.title); text(p.sub, i.sub); text(p.err, errorLine(s)); show(p.err, !!errorLine(s));
      pb.update(s); lv.update(s); vo.update(s);
    },
    destroy() { cancelAnimationFrame(raf); },
  };
}

// ---------------------------------------------------------------- now playing
export function audioNowPlayingSkin(): Skin {
  let c!: SkinContext;
  const p: Record<string, HTMLElement> = {};
  let pb!: ReturnType<typeof playButton>;
  let lv!: ReturnType<typeof liveBadge>;
  let vo!: ReturnType<typeof volume>;
  let lastLists = '';

  function trackRow(tr: TrackInfo, right: string) {
    const art = el('div', 'vpx-art'); setArt(art, tr.artworkUrl ?? null);
    return el('div', 'vpx-li', undefined, art,
      el('div', 'vpx-t', undefined, el('b', undefined, undefined, tr.title), tr.artist ? el('span', undefined, undefined, tr.artist) : null),
      right ? el('time', undefined, undefined, right) : null);
  }

  function lists(st: PlayerState) {
    // History: tracks (radio), else earlier programmes, else earlier items.
    const now = st.wallClock ?? Date.now();
    const recent: Array<[TrackInfo, string]> = st.history.length
      ? st.history.slice(0, 5).map((h) => [h, h.startedAt ? fmtClock(h.startedAt) : ''])
      : st.schedule.filter((x) => x.endsAt <= now).slice(-5).reverse().map((x) => [{ title: x.title, artist: x.subtitle, artworkUrl: x.imageUrl }, fmtClock(x.startsAt)]);
    if (!recent.length && st.index > 0) st.items.slice(Math.max(0, st.index - 5), st.index).reverse().forEach((it) => recent.push([{ title: it.title ?? '', artist: it.subtitle, artworkUrl: it.artworkUrl }, '']));
    const upcoming: Array<[TrackInfo, string]> = [];
    if (st.nextTrack) upcoming.push([st.nextTrack, '']);
    for (const x of st.schedule.filter((x) => x.startsAt >= (st.programme?.endsAt ?? now)).slice(0, 3))
      upcoming.push([{ title: x.title, artist: x.subtitle, artworkUrl: x.imageUrl }, fmtClock(x.startsAt)]);
    if (!upcoming.length) st.items.slice(st.index + 1, st.index + 4).forEach((it) => upcoming.push([{ title: it.title ?? '', artist: it.subtitle, artworkUrl: it.artworkUrl }, '']));
    const key = JSON.stringify([recent.map((r) => r[0].title + r[1]), upcoming.map((r) => r[0].title + r[1])]);
    if (key === lastLists) return;
    lastLists = key;
    const ctl = c.theme.controls;
    p.hist.innerHTML = ''; p.next.innerHTML = '';
    p.hist.appendChild(el('h4', undefined, undefined, c.t('recentlyPlayed')));
    if (recent.length) recent.forEach(([tr, r]) => p.hist.appendChild(trackRow(tr, r)));
    else p.hist.appendChild(el('div', 'vpx-empty', undefined, '–'));
    p.next.appendChild(el('h4', undefined, undefined, c.t('comingUp')));
    if (upcoming.length) upcoming.forEach(([tr, r]) => p.next.appendChild(trackRow(tr, r)));
    else p.next.appendChild(el('div', 'vpx-empty', undefined, '–'));
    show(p.hist, ctl.history && recent.length > 0);
    show(p.next, ctl.upNext && upcoming.length > 0);
    show(p.lists, (ctl.history && recent.length > 0) || (ctl.upNext && upcoming.length > 0));
  }

  return {
    mount(ctx) {
      c = ctx;
      pb = playButton(ctx); lv = liveBadge(ctx); vo = volume(ctx, true);
      p.art = el('div', 'vpx-art');
      p.kick = el('div', 'vpx-kick', undefined, ctx.t('nowPlaying'));
      p.title = el('b'); p.sub = el('span'); p.meta = el('div', 'vpx-meta'); p.err = el('div', 'vpx-err');
      p.hist = el('div'); p.next = el('div');
      p.lists = el('div', 'vpx-lists', undefined, p.hist, p.next);
      const root = el('div', 'vpx np', undefined, ctx.stage, p.art,
        el('div', 'vpx-head', undefined, p.kick, el('div', 'vpx-t', undefined, p.title, p.sub), p.meta, p.err,
          el('div', 'vpx-ctl', undefined, pb.el, vo.el, lv.el)),
        p.lists);
      ctx.root.appendChild(root);
    },
    update(st) {
      const i = info(st);
      setArt(p.art, i.art);
      text(p.title, i.title); text(p.sub, i.sub); text(p.meta, i.meta); text(p.err, errorLine(st));
      text(p.kick, st.nowPlaying ? c.t('nowPlaying') : st.programme ? c.t('onNow') : st.live ? c.t('live') : c.t('nowPlaying'));
      pb.update(st); lv.update(st); vo.update(st);
      lists(st);
    },
  };
}
