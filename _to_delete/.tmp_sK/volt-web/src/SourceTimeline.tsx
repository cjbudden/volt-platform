import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type TimelineFeed, type DaypartStrip, type TimelineProgramme } from './api'

/* ============================================================================
   THE THREE-LANE TIMELINE

   Three lanes, one x-axis, moving in unison:

     MEDIA      what actually exists on disk, with gaps drawn as gaps
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

        {/* ---------------- LANE 1: media ---------------- */}
        <Lane label="Media">
          {/* The lane is drawn as GAP-BY-DEFAULT and filled where media exists,
              so a hole is visible rather than implied. */}
          <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(45deg,rgba(148,163,184,.07) 0 6px,transparent 6px 12px)' }} />
          {feed.media.runs.map((r) => (
            <div key={r.runId} title={`run ${r.runId} · ${r.segments} segments`}
              style={{
                position: 'absolute', top: 3, bottom: 3,
                left: `${msToPct(r.startMs)}%`, width: `${Math.max(0.2, msToPct(r.endMs) - msToPct(r.startMs))}%`,
                background: 'linear-gradient(180deg,rgba(74,222,128,.5),rgba(74,222,128,.28))',
                border: '1px solid rgba(74,222,128,.55)', borderRadius: 3,
              }} />
          ))}
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
          {feed.days.map((d) => (
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

function Lane({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, marginBottom: 4 }}>
      <div style={{
        width: 54, flex: 'none', fontSize: 'var(--fs-micro)', color: 'var(--faint)',
        textTransform: 'uppercase', letterSpacing: 'var(--ls-label)', paddingTop: 8,
      }}>{label}</div>
      <div style={{
        position: 'relative', flex: 1, minWidth: 0, height: 34,
        background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6,
        overflow: 'hidden',
      }}>{children}</div>
    </div>
  )
}

function Strip({ s, i, msToPct }: { s: DaypartStrip; i: number; msToPct: (ms: number) => number }) {
  const left = msToPct(s.startMs), right = msToPct(s.endMs)
  if (right < -5 || left > 105) return null
  return (
    <div title={`${s.name} — click to select this strip`} style={{
      position: 'absolute', top: 15, bottom: 2,
      left: `${left}%`, width: `${Math.max(0.2, right - left)}%`,
      // Alternating tint: adjacent strips are otherwise one grey band and the
      // boundary an operator is looking for disappears.
      background: i % 2 ? 'rgba(148,163,184,.20)' : 'rgba(148,163,184,.10)',
      borderLeft: '1px solid rgba(148,163,184,.45)',
      display: 'flex', alignItems: 'center', paddingLeft: 5, overflow: 'hidden',
    }}>
      <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--muted)', whiteSpace: 'nowrap' }}>{s.name}</span>
    </div>
  )
}

function Programme({ p, msToPct, onPick }: {
  p: TimelineProgramme; msToPct: (ms: number) => number; onPick: () => void
}) {
  const left = msToPct(p.startMs), right = msToPct(p.endMs)
  if (right < -5 || left > 105) return null
  return (
    <div title={`${p.title} — click to select this range`}
      onPointerDown={(e) => { e.stopPropagation(); onPick() }}
      style={{
        position: 'absolute', top: 3, bottom: 3,
        left: `${left}%`, width: `${Math.max(0.15, right - left)}%`,
        background: CLASS_COLOR[p.class ?? ''] ?? 'rgba(99,102,241,.35)',
        border: '1px solid rgba(255,255,255,.12)', borderRadius: 3,
        display: 'flex', alignItems: 'center', paddingLeft: 4, overflow: 'hidden', cursor: 'pointer',
      }}>
      <span style={{ fontSize: 'var(--fs-micro)', color: '#eaf0f7', whiteSpace: 'nowrap' }}>{p.title}</span>
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
