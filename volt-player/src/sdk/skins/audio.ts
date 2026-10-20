// ============================================================================
//  AUDIO SKINS: radio stations, podcasts, audio-only events.
//
//    audio_square      a square tile: artwork, title, play. Fits a grid.
//    audio_wave        a strip: artwork, title and a live waveform.
//    audio_nowplaying  a panel: big artwork, track details, the last five
//                      tracks and what is coming up.
//    audio_radio       a station player: the station's logo and name, the
//                      programme on air with how far through it is, a
//                      waveform, and the Coming up banner the stream's own
//                      trigger raises before the next programme.
//
//  The Coming up banner is the shared template (kit.upNextCard 'banner'), the
//  same facts and timing as the video skin's Up next card.
//
//  What they show, best first: the track now playing (radio metadata), else
//  the programme on air (the guide), else the item's own title and artwork.
//  The media element is kept in the page (sound has to come from somewhere)
//  but never shown.
// ============================================================================
import type { PlayerState, Skin, SkinContext, TrackInfo } from '../types';
import { button, el, fmtClock, label, setIcon, show, slider, text, upNextCard, type UpNextCard } from './kit';

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

// ---------------------------------------------------------------- waveform
/**
 * A live waveform: the real spectrum when the samples can be read, otherwise a
 * gentle idle motion that is honest about being decorative (a cross-origin
 * stream), and a flat line when paused. Shared by the wave and radio skins.
 */
function waveform(c: SkinContext, bars = 48) {
  const canvas = el('canvas', undefined, { 'aria-hidden': 'true' });
  let raf = 0;
  let st: PlayerState | null = null;
  let phase = 0;
  let color = '';
  let frame = 0;
  const heights = new Float32Array(bars);

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
    for (let i = 0; i < bars; i++) {
      let target: number;
      if (lv && lv.length) {
        // Speech and music live in the lower bins: spread the first 70% over the bars.
        const bin = Math.floor((i / bars) * lv.length * 0.7);
        target = lv[bin] / 255;
      } else if (playing) {
        target = 0.25 + 0.2 * Math.sin(phase + i * 0.45) * Math.sin(phase * 0.7 + i * 0.13);
      } else target = 0.06;
      heights[i] += (target - heights[i]) * 0.35;
    }
    const gap = 2, bw = Math.max(1, (w - gap * (bars - 1)) / bars);
    if (!color || (frame++ % 120) === 0) color = getComputedStyle(canvas).getPropertyValue('--vp-primary').trim() || '#3f7bff';
    g.fillStyle = color;
    for (let i = 0; i < bars; i++) {
      const bh = Math.max(2, heights[i] * h);
      const x = i * (bw + gap), y = (h - bh) / 2;
      g.globalAlpha = playing ? 0.95 : 0.4;
      g.beginPath();
      (g as any).roundRect ? (g as any).roundRect(x, y, bw, bh, Math.min(2, bw / 2)) : g.rect(x, y, bw, bh);
      g.fill();
    }
  }
  return {
    el: canvas,
    start() { if (!raf) raf = requestAnimationFrame(draw); },
    update(s: PlayerState) { st = s; },
    stop() { cancelAnimationFrame(raf); raf = 0; },
  };
}

// ---------------------------------------------------------------- wave
export function audioWaveSkin(): Skin {
  const p: Record<string, HTMLElement> = {};
  let pb!: ReturnType<typeof playButton>;
  let lv!: ReturnType<typeof liveBadge>;
  let vo!: ReturnType<typeof volume>;
  let wf!: ReturnType<typeof waveform>;

  return {
    mount(ctx) {
      pb = playButton(ctx); lv = liveBadge(ctx); vo = volume(ctx, false); wf = waveform(ctx);
      p.art = el('div', 'vpx-art');
      p.title = el('b'); p.sub = el('span'); p.err = el('div', 'vpx-err');
      const root = el('div', 'vpx wv', undefined, ctx.stage, pb.el, p.art,
        el('div', 'vpx-mid', undefined, el('div', 'vpx-t', undefined, p.title, p.sub), wf.el, p.err),
        el('div', 'vpx-side', undefined, lv.el, vo.el));
      ctx.root.appendChild(root);
      wf.start();
    },
    update(s) {
      wf.update(s);
      const i = info(s);
      setArt(p.art, i.art); show(p.art, !!i.art);
      text(p.title, i.title); text(p.sub, i.sub); text(p.err, errorLine(s)); show(p.err, !!errorLine(s));
      pb.update(s); lv.update(s); vo.update(s);
    },
    destroy() { wf.stop(); },
  };
}

// ---------------------------------------------------------------- now playing
export function audioNowPlayingSkin(): Skin {
  let c!: SkinContext;
  const p: Record<string, HTMLElement> = {};
  let pb!: ReturnType<typeof playButton>;
  let lv!: ReturnType<typeof liveBadge>;
  let vo!: ReturnType<typeof volume>;
  let up!: UpNextCard;
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
      up = upNextCard(ctx, 'banner');
      up.el.style.gridColumn = '1 / -1';
      const root = el('div', 'vpx np', undefined, ctx.stage, p.art,
        el('div', 'vpx-head', undefined, p.kick, el('div', 'vpx-t', undefined, p.title, p.sub), p.meta, p.err,
          el('div', 'vpx-ctl', undefined, pb.el, vo.el, lv.el)),
        up.el, p.lists);
      ctx.root.appendChild(root);
    },
    update(st) {
      const i = info(st);
      setArt(p.art, i.art);
      text(p.title, i.title); text(p.sub, i.sub); text(p.meta, i.meta); text(p.err, errorLine(st));
      text(p.kick, st.nowPlaying ? c.t('nowPlaying') : st.programme ? c.t('onNow') : st.live ? c.t('live') : c.t('nowPlaying'));
      pb.update(st); lv.update(st); vo.update(st); up.update(st);
      lists(st);
    },
  };
}

// ---------------------------------------------------------------- radio
/** "12 min left", "1 h 5 min left", "40 s left". Words, never a clock-like 12:00. */
function leftWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

export function audioRadioSkin(): Skin {
  let c!: SkinContext;
  const p: Record<string, HTMLElement> = {};
  let pb!: ReturnType<typeof playButton>;
  let lv!: ReturnType<typeof liveBadge>;
  let vo!: ReturnType<typeof volume>;
  let wf!: ReturnType<typeof waveform>;
  let up!: UpNextCard;
  let lastLater: string | null = null;

  function later(st: PlayerState) {
    const now = st.wallClock ?? Date.now();
    const rows = st.schedule.filter((x) => x.startsAt >= (st.nextProgramme?.endsAt ?? st.programme?.endsAt ?? now)).slice(0, 3);
    const key = rows.map((x) => x.id + x.startsAt).join('|');
    if (key === lastLater) return;
    lastLater = key;
    p.laterList.innerHTML = '';
    for (const x of rows) {
      const art = el('div', 'vpx-art'); setArt(art, x.imageUrl ?? null);
      p.laterList.appendChild(el('div', 'vpx-li', undefined, art,
        el('div', 'vpx-t', undefined, el('b', undefined, undefined, x.title), x.subtitle ? el('span', undefined, undefined, x.subtitle) : null),
        el('time', undefined, undefined, fmtClock(x.startsAt))));
    }
    show(p.later, c.theme.controls.schedule && rows.length > 0);
  }

  return {
    mount(ctx) {
      c = ctx;
      pb = playButton(ctx); lv = liveBadge(ctx); vo = volume(ctx, true); wf = waveform(ctx, 40);
      up = upNextCard(ctx, 'banner');
      p.logo = el('img', undefined, { alt: '' });
      p.station = el('div', 'vpx-station');
      p.art = el('div', 'vpx-art');
      p.kick = el('div', 'vpx-kick');
      p.title = el('b'); p.sub = el('span'); p.err = el('div', 'vpx-err');
      p.from = el('span'); p.to = el('span'); p.fill = el('i');
      p.prog = el('div', 'vpx-rd-prog', undefined, p.from, el('div', 'vpx-rd-bar', undefined, p.fill), p.to);
      p.left = el('div', 'vpx-rd-left');
      p.next = el('div', 'vpx-rd-next');
      p.laterList = el('div');
      p.later = el('div', 'vpx-rd-later', undefined, el('h4', undefined, undefined, ctx.t('laterToday')), p.laterList);
      const root = el('div', 'vpx rd', undefined, ctx.stage,
        el('div', 'vpx-rd-h', undefined, p.logo, p.station, lv.el),
        el('div', 'vpx-rd-m', undefined, p.art,
          el('div', undefined, undefined, p.kick, el('div', 'vpx-t', undefined, p.title, p.sub), p.prog, p.left, p.err)),
        el('div', 'vpx-rd-c', undefined, pb.el, wf.el, vo.el),
        up.el, p.next, p.later);
      ctx.root.appendChild(root);
      this.themeChanged?.(ctx.theme);
      wf.start();
    },
    themeChanged(th) {
      const l = p.logo as HTMLImageElement;
      if (th.logoUrl && th.logoPosition !== 'none') { if (l.getAttribute('src') !== th.logoUrl) l.src = th.logoUrl; l.hidden = false; } else l.hidden = true;
    },
    update(st) {
      wf.update(st);
      const i = info(st);
      // The station is the item; what is on is the programme or the track.
      text(p.station, st.item?.title ?? '');
      setArt(p.art, i.art);
      const onAir = st.live && (st.programme || st.nowPlaying);
      p.kick.textContent = '';
      if (onAir) p.kick.appendChild(el('i'));
      p.kick.append(st.nowPlaying ? c.t('nowPlaying') : st.programme ? c.t('onAir') : st.live ? c.t('live') : c.t('nowPlaying'));
      text(p.title, st.programme || st.nowPlaying ? i.title : (st.item?.subtitle ?? i.title));
      text(p.sub, st.programme && st.nowPlaying ? `${st.programme.title}` : i.sub);
      text(p.err, errorLine(st)); show(p.err, !!errorLine(st));

      // The programme's own progress: start, a bar, end, and the time left in words.
      const pr = st.programme;
      const finite = !!pr && Number.isFinite(pr.endsAt) && pr.endsAt > pr.startsAt;
      show(p.prog, finite); show(p.left, finite);
      if (pr && finite) {
        const now = st.wallClock ?? Date.now();
        const f = Math.max(0, Math.min(1, (now - pr.startsAt) / (pr.endsAt - pr.startsAt)));
        text(p.from, fmtClock(pr.startsAt)); text(p.to, fmtClock(pr.endsAt));
        p.fill.style.width = `${(f * 100).toFixed(2)}%`;
        text(p.left, c.t('timeLeft', { time: leftWords(pr.endsAt - now) }));
      }

      // Coming up: the stream's trigger (or the guide) raises the banner. Between
      // banners, a quiet line says what is next when the guide knows.
      up.update(st);
      const nx = st.nextProgramme;
      const quiet = !st.upNext && !!nx && c.theme.controls.upNext;
      show(p.next, quiet);
      if (quiet && nx) {
        p.next.textContent = '';
        p.next.append(`${c.t('next')} · `, el('b', undefined, undefined, nx.title), ` · ${fmtClock(nx.startsAt)}`);
        const ms = nx.startsAt - (st.wallClock ?? Date.now());
        // The same rounding as the time left above, so the two never disagree.
        if (ms > 0 && ms < 3 * 3600_000) p.next.append(` (in ${leftWords(ms)})`);
      }
      later(st);
      pb.update(st); lv.update(st); vo.update(st);
    },
    destroy() { wf.stop(); },
  };
}
