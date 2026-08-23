import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type TimelineFeed, type DaypartStrip, type TimelineProgramme, type ChannelWaveform, type ThumbStrip } from './api'

/* ============================================================================
   THE THREE-LANE TIMELINE

   Three lanes, one x-axis, moving in unison:

     MEDIA      the WAVEFORM for an audio source, run blocks for video, with
                gaps drawn as gaps in both
     TIME       the broadcast day, its daypart strips, and the clock ruler
     ON AIR     what was playing, from the EPG or the now-playing log

   The lanes share one window and are drawn from ONE response, so they cannot
   disagree about where a boundary is — which is exactly what happens when each
   lane fetches for itself and one of them is a request behind.

   WHY IT SPANS CONTAINERS. A capture boundary is an artefact of how storage is
   sliced, not of the content: a show that starts at 23:40 and runs past the
   06:00 anchor lives in two containers and must read as one thing. So the x-axis
   is wall-clock time and container edges are drawn as marks ON it, never as the
   ends of it.

   WHY THE WAVEFORM IS THE MEDIA LANE FOR AUDIO. A flat block only says a
   recording exists. The waveform says where the speech stops and the song
   starts, where the applause is, where the silence between items falls — which
   is the entire job when you are hunting for a clipping point. On a radio
   source the block would be the least useful thing we could draw in the space.

   It is fetched for the VISIBLE window at the pixel resolution being drawn, so
   zooming in decodes more detail rather than stretching what was already there.

   ZOOM IS BOUNDED at both ends, deliberately. Too far in and you are scrubbing
   inside one segment with no useful detail; too far out and the server is asked
   to summarise a month of programmes for a strip a few hundred pixels wide. The
   limits are what keep both the request and the picture meaningful.
   ========================================================================== */

const MIN_WINDOW_MS = 60_000              // one minute
const MAX_WINDOW_MS = 30 * 86_400_000     // thirty days: under the API's 32-day cap

const ZOOMS: { label: string; ms: number }[] = [
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 5 * 60_000 },
  { label: '30m', ms: 30 * 60_000 },
  { label: '2h', ms: 2 * 3_600_000 },
  { label: '6h', ms: 6 * 3_600_000 },
  { label: '1d', ms: 86_400_000 },
  { label: '7d', ms: 7 * 86_400_000 },
]

/** Colour by what a programme IS, matching the radio metadata log. */
const CLASS_COLOR: Record<string, string> = {
  song: 'rgba(99,102,241,.55)',
  ad: 'rgba(251,191,36,.55)',
  content: 'rgba(74,222,128,.5)',
}

export interface TimelineSelection { fromMs: number; toMs: number }

export function SourceTimeline({ channelId, tz, onSelect, onClock, initialWindow }: {
  channelId: string
  tz?: string
  onSelect?: (sel: TimelineSelection | null) => void
  /** The channel's clock, reported so the page around this component formats
   *  times in the SAME zone. Without it the timeline renders in the channel's
   *  timezone while a panel beside it renders in the browser's, and the same
   *  instant appears an hour apart on one screen. */
  onClock?: (clock: { tz: string; anchorHour: number }) => void
  initialWindow?: { from: number; to: number }
}) {
  const [feed, setFeed] = useState<TimelineFeed | null>(null)
  const [err, setErr] = useState('')
  const [win, setWin] = useState<{ from: number; to: number } | null>(initialWindow ?? null)
  const [sel, setSel] = useState<TimelineSelection | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [wave, setWave] = useState<ChannelWaveform | null>(null)
  const [strip, setStrip] = useState<ThumbStrip | null>(null)
  const waveRef = useRef<HTMLCanvasElement | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ mode: 'select' | 'pan'; x: number; from: number; to: number } | null>(null)

  const zone = tz ?? feed?.clock.tz ?? 'Europe/London'
  const fmtClock = useMemo(() => new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour12: false, hour: '2-digit', minute: '2-digit',
  }), [zone])
  const fmtDay = useMemo(() => new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, day: '2-digit', month: 'short',
  }), [zone])
  const fmtFull = useMemo(() => new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour12: false, day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }), [zone])

  // ---- load ---------------------------------------------------------------
  async function load(w: { from: number; to: number }) {
    try {
      const f = await api.channelTimeline(channelId, w.from, w.to)
      setFeed(f); setErr('')
    } catch (e: any) { setErr(e.message) }
  }

  // First load: ask for a day, then FIT to whatever media actually exists, so
  // an operator opening a source lands on their content instead of on empty
  // space either side of it.
  useEffect(() => {
    let dead = false
    ;(async () => {
      const now = Date.now()
      const guess = initialWindow ?? { from: now - 86_400_000, to: now }
      try {
        const f = await api.channelTimeline(channelId, guess.from, guess.to)
        if (dead) return
        setFeed(f)
        if (!initialWindow && f.media.runs.length) {
          const a = Math.min(...f.media.runs.map(r => r.startMs))
          const b = Math.max(...f.media.runs.map(r => r.endMs))
          const pad = Math.max(60_000, (b - a) * 0.05)
          const fitted = { from: a - pad, to: b + pad }
          setWin(fitted)
          await load(fitted)
        } else {
          setWin(guess)
        }
      } catch (e: any) { if (!dead) setErr(e.message) }
    })()
    return () => { dead = true }
    /* eslint-disable-next-line */
  }, [channelId])

  // Debounced refetch as the window moves: panning should not fire a request
  // per frame.
  useEffect(() => {
    if (!win) return
    const t = setTimeout(() => load(win), 220)
    return () => clearTimeout(t)
    /* eslint-disable-next-line */
  }, [win?.from, win?.to])

  // THE WAVEFORM, for audio sources. Fetched separately from the timeline
  // because it is the expensive half: the lanes must appear immediately and the
  // waveform fills in behind them, rather than the whole surface waiting on a
  // decode. Bucket count follows the drawn width, so detail matches the zoom.
  useEffect(() => {
    if (!win || feed?.kind !== 'audio') { setWave(null); return }
    let dead = false
    const timers: number[] = []
    // A COLD cache is the normal first visit: nothing has been decoded for this
    // stream yet, the first request comes back thin or fails outright while the
    // server is busy priming, and the poll below only runs once an answer has
    // landed. So the first fetch retries on its own — without this a single
    // failed request left the lane permanently blank with no way back except a
    // reload.
    const attempt = (n: number) => {
      const t = window.setTimeout(async () => {
        if (dead) return
        const px = railRef.current?.clientWidth ?? 900
        try {
          const w = await api.channelWaveform(channelId, win.from, win.to, Math.min(1200, Math.max(120, Math.round(px))))
          if (!dead) setWave(w)
        } catch {
          if (!dead && n < 4) attempt(n + 1)   // 0.9s, 1.8s, 3.6s
        }
      }, n === 0 ? 260 : 450 * 2 ** n)
      timers.push(t)
    }
    attempt(0)
    return () => { dead = true; timers.forEach(clearTimeout) }
    /* eslint-disable-next-line */
  }, [channelId, feed?.kind, win?.from, win?.to])

  // THE FILMSTRIP, for video sources. The same job the waveform does for audio:
  // a flat block says a recording exists, a strip of frames says WHICH recording
  // and where the cut points are. Frame count follows the width actually drawn,
  // so it never asks for more pictures than can be seen.
  useEffect(() => {
    if (!win || !feed || feed.kind !== 'video') { setStrip(null); return }
    let dead = false
    const timers: number[] = []
    const attempt = (n: number) => {
      const h = window.setTimeout(async () => {
        if (dead) return
        const px = railRef.current?.clientWidth ?? 900
        // One frame per 160px: the width of a 16:9 frame at the lane's height.
        const count = Math.max(2, Math.min(40, Math.floor(px / 160)))
        try {
          const s = await api.channelThumbs(channelId, win.from, win.to, count)
          if (!dead) setStrip(s)
        } catch {
          if (!dead && n < 4) attempt(n + 1)
        }
      }, n === 0 ? 300 : 500 * 2 ** n)
      timers.push(h)
    }
    attempt(0)
    return () => { dead = true; timers.forEach(clearTimeout) }
    /* eslint-disable-next-line */
  }, [channelId, feed?.kind, win?.from, win?.to])

  // Frames still being extracted arrive on a later pass, same as the waveform.
  useEffect(() => {
    if (!strip || strip.complete || !win) return
    const h = setTimeout(async () => {
      const px = railRef.current?.clientWidth ?? 900
      const count = Math.max(2, Math.min(40, Math.floor(px / 160)))
      try { setStrip(await api.channelThumbs(channelId, win.from, win.to, count, false)) }
      catch { /* ignore */ }
    }, 1500)
    return () => clearTimeout(h)
    /* eslint-disable-next-line */
  }, [strip?.complete, strip?.pending])

  // A wide window answers from the peak cache and reports what is still
  // missing; the server primes the rest in the background, so poll briefly
  // until the picture is whole rather than leaving it half-drawn.
  useEffect(() => {
    if (!wave || wave.complete || !win) return
    const t = setTimeout(async () => {
      const px = railRef.current?.clientWidth ?? 900
      try {
        const w = await api.channelWaveform(channelId, win.from, win.to, Math.min(1200, Math.max(120, Math.round(px))), false)
        setWave(w)
      } catch { /* ignore */ }
    }, 1500)
    return () => clearTimeout(t)
    /* eslint-disable-next-line */
  }, [wave?.complete, wave?.pending])

  // ---- draw the waveform ---------------------------------------------------
  useEffect(() => {
    const cv = waveRef.current
    if (!cv || !win) return
    const w = cv.clientWidth, h = cv.clientHeight
    const dpr = window.devicePixelRatio || 1
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr)
    }
    const g = cv.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)
    if (!wave?.buckets.length) return

    const mid = h / 2
    g.strokeStyle = 'rgba(255,255,255,.10)'
    g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke()

    // Peak behind, RMS in front — the same treatment as the clipping surface, so
    // the two read as one instrument rather than two different pictures of the
    // same audio. Values are linear amplitude (see audioLevel.ts): this is a
    // waveform, not a loudness plot.
    const span = wave.to - wave.from
    const bw = Math.max(0.7, (w / wave.buckets.length))
    for (let i = 0; i < wave.buckets.length; i++) {
      const b = wave.buckets[i]
      if (!b) continue
      const t = wave.from + (i / wave.buckets.length) * span
      const x = ((t - win.from) / (win.to - win.from)) * w
      if (x < -bw || x > w + bw) continue
      const ph = Math.max(0.7, b.peak * (mid - 1))
      const rh = Math.max(0.5, b.rms * (mid - 1))
      g.fillStyle = 'rgba(125,211,252,.42)'
      g.fillRect(x, mid - ph, bw, ph * 2)
      g.fillStyle = 'rgba(63,123,255,.95)'
      g.fillRect(x, mid - rh, bw, rh * 2)
    }
    /* eslint-disable-next-line */
  }, [wave, win?.from, win?.to])

  useEffect(() => { onSelect?.(sel) /* eslint-disable-next-line */ }, [sel])
  useEffect(() => {
    if (feed) onClock?.({ tz: feed.clock.tz, anchorHour: feed.clock.anchorHour })
    /* eslint-disable-next-line */
  }, [feed?.clock.tz, feed?.clock.anchorHour])

  // ---- geometry -----------------------------------------------------------
  const spanMs = win ? win.to - win.from : 1
  const pxToMs = (px: number) => {
    const el = railRef.current
    if (!el || !win) return 0
    return win.from + (px / el.clientWidth) * spanMs
  }
  const msToPct = (ms: number) => win ? ((ms - win.from) / spanMs) * 100 : 0
  const clampWindow = (from: number, to: number) => {
    let ms = Math.max(MIN_WINDOW_MS, Math.min(MAX_WINDOW_MS, to - from))
    const mid = (from + to) / 2
    return { from: Math.round(mid - ms / 2), to: Math.round(mid + ms / 2) }
  }

  function zoomTo(ms: number) {
    if (!win) return
    const centre = sel ? (sel.fromMs + sel.toMs) / 2 : (win.from + win.to) / 2
    setWin(clampWindow(centre - ms / 2, centre + ms / 2))
  }
  function fitAll() {
    if (!feed?.media.runs.length) return
    const a = Math.min(...feed.media.runs.map(r => r.startMs))
    const b = Math.max(...feed.media.runs.map(r => r.endMs))
    const pad = Math.max(60_000, (b - a) * 0.05)
    setWin(clampWindow(a - pad, b + pad))
  }

  // Wheel zooms around the pointer, which is the behaviour every timeline in
  // every edit tool has; anything else feels broken to someone who edits.
  function onWheel(e: React.WheelEvent) {
    if (!win || !railRef.current) return
    e.preventDefault()
    const rect = railRef.current.getBoundingClientRect()
    const at = pxToMs(e.clientX - rect.left)
    const factor = e.deltaY > 0 ? 1.25 : 0.8
    const next = Math.max(MIN_WINDOW_MS, Math.min(MAX_WINDOW_MS, spanMs * factor))
    const ratio = (at - win.from) / spanMs
    setWin({ from: Math.round(at - ratio * next), to: Math.round(at + (1 - ratio) * next) })
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!win || !railRef.current) return
    const rect = railRef.current.getBoundingClientRect()
    const at = pxToMs(e.clientX - rect.left)
    // Alt or middle drag pans; a plain drag marks a range. Same convention as
    // the clipping surface, so the two do not have to be learned separately.
    const mode = e.altKey || e.button === 1 ? 'pan' : 'select'
    dragRef.current = { mode, x: e.clientX, from: win.from, to: win.to }
    if (mode === 'select') setSel({ fromMs: at, toMs: at })
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!railRef.current || !win) return
    const rect = railRef.current.getBoundingClientRect()
    setHover(pxToMs(e.clientX - rect.left))
    const d = dragRef.current
    if (!d) return
    if (d.mode === 'pan') {
      const dx = e.clientX - d.x
      const shift = (dx / rect.width) * (d.to - d.from)
      setWin({ from: Math.round(d.from - shift), to: Math.round(d.to - shift) })
    } else {
      const at = pxToMs(e.clientX - rect.left)
      setSel((s) => s ? { fromMs: Math.min(s.fromMs, at), toMs: Math.max(s.fromMs, at) } : s)
    }
  }
  function onPointerUp() {
    const d = dragRef.current
    dragRef.current = null
    // A click rather than a drag clears the selection instead of leaving a
    // zero-width range that looks like a bug.
    if (d?.mode === 'select') setSel((s) => (s && s.toMs - s.fromMs < 500 ? null : s))
  }

  // ---- lane data ----------------------------------------------------------
  const strips = feed?.dayparts ?? []
  const programmes = feed?.programmes ?? []
  const atCursor = hover ?? null
  const isAudio = feed?.kind === 'audio'
  const isVideo = feed?.kind === 'video'

  if (err) return <div className="err">{err}</div>
  if (!feed || !win) return <div className="loading">Loading timeline…</div>

  const dur = sel ? sel.toMs - sel.fromMs : 0

  return (
    <div className="card p-4" style={{ minWidth: 0 }}>
      <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 10 }}>
        <div className="sec-label" style={{ margin: 0 }}>Timeline</div>
        <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>
          {feed.clock.tz} · day opens {String(feed.clock.anchorHour).padStart(2, '0')}:00
        </span>
        <div className="flex-1" />
        {ZOOMS.map(z => (
          <button key={z.label} className="btn ghost" style={{ padding: '3px 9px', fontSize: 'var(--fs-sm)' }}
            onClick={() => zoomTo(z.ms)}>{z.label}</button>
        ))}
        <button className="btn ghost" style={{ padding: '3px 9px', fontSize: 'var(--fs-sm)' }}
          onClick={fitAll} disabled={!feed.media.runs.length}>Fit</button>
      </div>

      <div ref={railRef}
        onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUp} onPointerLeave={() => setHover(null)}
        style={{ position: 'relative', userSelect: 'none', cursor: 'crosshair', touchAction: 'none' }}>

        {/* ---------------- LANE 1: media ----------------
             For audio this is the WAVEFORM, which is the whole point of the lane
             on a radio source: it shows where to cut. For video it stays run
             blocks until keyframe thumbnails land. */}
        <Lane label={isAudio ? 'Audio' : isVideo ? 'Video' : 'Media'} tall={isAudio || isVideo}>
          {/* The lane is drawn as GAP-BY-DEFAULT and filled where media exists,
              so a hole is visible rather than implied. */}
          <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(45deg,rgba(148,163,184,.07) 0 6px,transparent 6px 12px)' }} />
          {feed.media.runs.map((r) => (
            <div key={r.runId} title={`run ${r.runId} · ${r.segments} segments`}
              style={{
                position: 'absolute', top: 3, bottom: 3,
                left: `${msToPct(r.startMs)}%`, width: `${Math.max(0.2, msToPct(r.endMs) - msToPct(r.startMs))}%`,
                // OPAQUE, even for audio. The lane's hatching means "no media";
                // a translucent block let the hatch show through the recorded
                // stretch too, so recorded and missing looked the same behind the
                // waveform. The base hides the hatch, the tint says recorded.
                backgroundColor: isAudio ? 'var(--panel-2)' : undefined,
                backgroundImage: isAudio
                  ? 'linear-gradient(rgba(74,222,128,.09),rgba(74,222,128,.09))'
                  : 'linear-gradient(180deg,rgba(74,222,128,.5),rgba(74,222,128,.28))',
                border: `1px solid rgba(74,222,128,${isAudio ? '.35' : '.55'})`, borderRadius: 3,
              }} />
          ))}
          {isAudio && (
            <canvas ref={waveRef} style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              display: 'block', pointerEvents: 'none',
            }} />
          )}
          {/* THE FILMSTRIP. Each frame is placed at the instant it was actually
              taken from, not at the slot it was asked for: a frame from four
              seconds away is still an honest picture of a different moment, and
              putting it where it came from is what keeps the lane truthful. */}
          {isVideo && strip && strip.thumbs.map((th, i) => th && (
            <img key={`${th.runId}-${th.seq}`} src={th.url} alt=""
              title={fmtFull.format(th.t)}
              style={{
                position: 'absolute', top: 3, bottom: 3,
                left: `${msToPct(th.t)}%`,
                // Width is the SLOT this frame stands for, not the frame's own
                // aspect ratio. Sized by aspect the frames sat at their own
                // times with lane showing through between them, which reads as
                // gaps in the recording where there are none. Sized by slot they
                // tile, and the picture covers exactly the time it represents.
                width: `${(strip.slotMs / Math.max(1, spanMs)) * 100}%`,
                height: 'calc(100% - 6px)',
                objectFit: 'cover', pointerEvents: 'none',
                borderLeft: i === 0 ? 'none' : '1px solid rgba(0,0,0,.35)',
              }} />
          ))}
          {isVideo && strip && !strip.complete && (
            <div style={{
              position: 'absolute', right: 6, top: 3, fontSize: 'var(--fs-micro)',
              color: 'var(--faint)', background: 'rgba(0,0,0,.45)', padding: '1px 5px',
              borderRadius: 4, pointerEvents: 'none',
            }}>extracting… {strip.pending} left</div>
          )}
          {isAudio && wave && !wave.complete && (
            <div style={{
              position: 'absolute', right: 6, top: 3, fontSize: 'var(--fs-micro)',
              color: 'var(--faint)', background: 'rgba(0,0,0,.45)', padding: '1px 5px',
              borderRadius: 4, pointerEvents: 'none',
            }}>drawing… {wave.pending} left</div>
          )}
          {/* Container edges: marks ON the axis, not ends OF it. */}
          {feed.containers.map((c) => (
            <div key={c.id} title={`broadcast day ${c.day} · ${c.coveragePct}% recorded`}
              style={{
                position: 'absolute', top: 0, bottom: 0, left: `${msToPct(c.startMs)}%`,
                borderLeft: '1px dashed rgba(148,163,184,.55)',
              }} />
          ))}
        </Lane>

        {/* ---------------- LANE 2: time ---------------- */}
        <Lane label="Time">
          {strips.map((s, i) => (
            <Strip key={`${s.startMs}-${i}`} s={s} i={i} msToPct={msToPct} />
          ))}
          {/* The day in view, pinned, when its 06:00 boundary is off to the left.
              Otherwise zooming inside a day removes the date from the screen. */}
          {feed.days.length > 0 && feed.days[0].startMs < win.from && (
            <div style={{
              position: 'absolute', top: 1, left: 4, whiteSpace: 'nowrap',
              fontSize: 'var(--fs-micro)', color: 'var(--faint)',
            }}>{fmtDay.format(feed.days[0].startMs)}</div>
          )}
          {feed.days.filter((d) => msToPct(d.startMs) >= 0 && msToPct(d.startMs) <= 100).map((d) => (
            <div key={d.day} style={{ position: 'absolute', top: 0, bottom: 0, left: `${msToPct(d.startMs)}%` }}>
              <div style={{ borderLeft: '1px solid rgba(148,163,184,.5)', height: '100%' }} />
              <div style={{
                position: 'absolute', top: 1, left: 4, whiteSpace: 'nowrap',
                fontSize: 'var(--fs-micro)', color: 'var(--faint)',
              }}>
                {fmtDay.format(d.startMs)}
                {/* A 23 or 25 hour day is labelled rather than silently drawn an
                    hour short or long. */}
                {d.clockChange && <span style={{ color: 'var(--warn,#fbbf24)' }}> · clocks {d.clockChange}</span>}
              </div>
            </div>
          ))}
        </Lane>

        {/* ---------------- LANE 3: what was on ---------------- */}
        <Lane label="On air">
          {programmes.map((p) => <Programme key={p.id} p={p} msToPct={msToPct}
            onPick={() => setSel({ fromMs: p.startMs, toMs: p.endMs })} />)}
        </Lane>

        {/* ---- ruler ---- */}
        <Ruler win={win} msToPct={msToPct} fmtClock={fmtClock} />

        {/* ---- selection, drawn across ALL lanes so they read as one axis ---- */}
        {sel && sel.toMs > sel.fromMs && (
          <div style={{
            position: 'absolute', top: 0, bottom: 18,
            left: `${msToPct(sel.fromMs)}%`, width: `${msToPct(sel.toMs) - msToPct(sel.fromMs)}%`,
            background: 'rgba(63,123,255,.16)', border: '1px solid rgba(63,123,255,.7)',
            borderRadius: 2, pointerEvents: 'none',
          }} />
        )}
        {atCursor != null && (
          <div style={{
            position: 'absolute', top: 0, bottom: 18, left: `${msToPct(atCursor)}%`,
            borderLeft: '1px solid rgba(226,232,240,.55)', pointerEvents: 'none',
          }} />
        )}
      </div>

      {/* ---- readout ---- */}
      <div className="flex flex-wrap items-center gap-3" style={{ marginTop: 10, fontSize: 'var(--fs-sm)' }}>
        <span style={{ color: 'var(--faint)' }}>
          {fmtFull.format(win.from)} → {fmtFull.format(win.to)}
        </span>
        <span style={{ color: 'var(--faint)' }}>·</span>
        <span style={{ color: feed.media.coveragePct >= 99.5 ? 'var(--ok,#4ade80)' : 'var(--warn,#fbbf24)' }}>
          {feed.media.coveragePct}% recorded
        </span>
        {feed.media.gaps.length > 0 && (
          <span style={{ color: 'var(--faint)' }}>
            {feed.media.gaps.length} gap{feed.media.gaps.length === 1 ? '' : 's'}
          </span>
        )}
        <div className="flex-1" />
        {sel && dur > 0 ? (
          <>
            <span style={{ fontFamily: 'ui-monospace,monospace' }}>
              {fmtFull.format(sel.fromMs)} → {fmtClock.format(sel.toMs)} ({fmtDur(dur)})
            </span>
            <button className="btn ghost" style={{ padding: '3px 9px' }} onClick={() => setSel(null)}>Clear</button>
          </>
        ) : (
          <span style={{ color: 'var(--faint)' }}>drag to mark a range · alt-drag to pan · wheel to zoom</span>
        )}
      </div>
    </div>
  )
}

function fmtDur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
           : `${m}:${String(ss).padStart(2, '0')}`
}

function Lane({ label, children, tall }: {
  label: string; children: React.ReactNode
  /** The waveform needs room to be readable; a 34px strip is a smear. */
  tall?: boolean
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, marginBottom: 4 }}>
      <div style={{
        width: 54, flex: 'none', fontSize: 'var(--fs-micro)', color: 'var(--faint)',
        textTransform: 'uppercase', letterSpacing: 'var(--ls-label)', paddingTop: 8,
      }}>{label}</div>
      <div style={{
        position: 'relative', flex: 1, minWidth: 0, height: tall ? 92 : 34,
        background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6,
        overflow: 'hidden',
      }}>{children}</div>
    </div>
  )
}

function Strip({ s, i, msToPct }: { s: DaypartStrip; i: number; msToPct: (ms: number) => number }) {
  const left = msToPct(s.startMs), right = msToPct(s.endMs)
  if (right < -5 || left > 105) return null
  // CLAMPED TO THE VIEWPORT, deliberately. Zoom into the middle of Breakfast and
  // the strip's true left edge is off-screen; drawn unclamped, its name goes with
  // it and the lane becomes an unlabelled grey band at exactly the zoom where
  // knowing which daypart you are in matters most. So the box is clipped to what
  // is visible, the name rides the visible edge, and the border is drawn ONLY
  // when the real boundary is in view — a clamped edge must never be mistaken
  // for a daypart starting there.
  const vLeft = Math.max(0, left), vRight = Math.min(100, right)
  const startsInView = left >= 0
  return (
    <div title={`${s.name} — click to select this strip`} style={{
      position: 'absolute', top: 15, bottom: 2,
      left: `${vLeft}%`, width: `${Math.max(0.2, vRight - vLeft)}%`,
      // Alternating tint: adjacent strips are otherwise one grey band and the
      // boundary an operator is looking for disappears.
      background: i % 2 ? 'rgba(148,163,184,.20)' : 'rgba(148,163,184,.10)',
      borderLeft: startsInView ? '1px solid rgba(148,163,184,.45)' : 'none',
      display: 'flex', alignItems: 'center', paddingLeft: 5, overflow: 'hidden',
    }}>
      <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
        {startsInView ? s.name : `← ${s.name}`}
      </span>
    </div>
  )
}

function Programme({ p, msToPct, onPick }: {
  p: TimelineProgramme; msToPct: (ms: number) => number; onPick: () => void
}) {
  const left = msToPct(p.startMs), right = msToPct(p.endMs)
  if (right < -5 || left > 105) return null
  // Same clamping rule as the daypart strip: a programme running in from before
  // the window keeps its title on screen, and only a REAL start gets a rounded,
  // bordered left edge, so a clipped edge is never read as a boundary.
  const vLeft = Math.max(0, left), vRight = Math.min(100, right)
  const startsInView = left >= 0, endsInView = right <= 100
  return (
    <div title={`${p.title} — click to select this range`}
      onPointerDown={(e) => { e.stopPropagation(); onPick() }}
      style={{
        position: 'absolute', top: 3, bottom: 3,
        left: `${vLeft}%`, width: `${Math.max(0.15, vRight - vLeft)}%`,
        background: CLASS_COLOR[p.class ?? ''] ?? 'rgba(99,102,241,.35)',
        border: '1px solid rgba(255,255,255,.12)',
        borderLeftStyle: startsInView ? 'solid' : 'none',
        borderRightStyle: endsInView ? 'solid' : 'none',
        borderRadius: `${startsInView ? 3 : 0}px ${endsInView ? 3 : 0}px ${endsInView ? 3 : 0}px ${startsInView ? 3 : 0}px`,
        display: 'flex', alignItems: 'center', paddingLeft: 4, overflow: 'hidden', cursor: 'pointer',
      }}>
      <span style={{ fontSize: 'var(--fs-micro)', color: '#eaf0f7', whiteSpace: 'nowrap' }}>
        {startsInView ? p.title : `← ${p.title}`}
      </span>
    </div>
  )
}

/**
 * An adaptive ruler: the tick interval is chosen so labels never collide,
 * whatever the zoom. Without this a day-wide view prints a label per minute and
 * a minute-wide view prints none.
 */
function Ruler({ win, msToPct, fmtClock }: {
  win: { from: number; to: number }
  msToPct: (ms: number) => number
  fmtClock: Intl.DateTimeFormat
}) {
  const span = win.to - win.from
  const steps = [1, 5, 15, 30, 60, 300, 900, 1800, 3600, 7200, 21600, 43200, 86400]
    .map(s => s * 1000)
  const step = steps.find(s => span / s <= 12) ?? steps[steps.length - 1]
  const first = Math.ceil(win.from / step) * step
  const ticks: number[] = []
  for (let t = first; t < win.to && ticks.length < 40; t += step) ticks.push(t)
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <div style={{ width: 54, flex: 'none' }} />
      <div style={{ position: 'relative', flex: 1, minWidth: 0, height: 18 }}>
        {ticks.map(t => (
          <div key={t} style={{ position: 'absolute', left: `${msToPct(t)}%`, top: 0 }}>
            <div style={{ width: 1, height: 4, background: 'var(--border-2)' }} />
            <div style={{
              fontSize: 'var(--fs-micro)', color: 'var(--faint)',
              transform: 'translateX(-50%)', whiteSpace: 'nowrap', marginTop: 1,
            }}>{fmtClock.format(t)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
