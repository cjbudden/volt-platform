// ============================================================================
//  ClipTimeline — the zoomable clipping surface for the recording workbench.
//
//  Three stacked, time-aligned rows over ONE view window:
//    1. WAVEFORM   — the audio envelope, so trims land on real boundaries
//                    (where speech starts, where a song ends) instead of being
//                    guessed by scrubbing.
//    2. METADATA   — EPG programmes and radio now-playing entries, coloured by
//                    what they are (song / ad / content). CLICK an entry to
//                    trim to exactly its times: the fastest possible clip.
//    3. SCRUB BAR  — recorded coverage, the loaded player range, trim marks and
//                    the playhead. Drag to mark, click to seek (unchanged
//                    behaviour, now inside the zoom).
//
//  ZOOM exists because a 24x7 channel keeps as much as its retention rule
//  allows: the recording can span days, and a fixed full-width bar makes a
//  30-second clip impossible to place. The OVERVIEW strip on top always shows
//  the whole recording with the current window drawn on it, so you never lose
//  your place; the window can be dragged there, panned by dragging the ruler,
//  or zoomed with the wheel / buttons / +- keys.
// ============================================================================
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RecordingProgramme, Waveform } from './api'

export interface Span { runId: string; startMs: number; endMs: number; segments?: number }

const p2 = (n: number) => String(n).padStart(2, '0')
const clockOf = (ms: number, withSec = true) => {
  const d = new Date(ms)
  return withSec ? `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` : `${p2(d.getHours())}:${p2(d.getMinutes())}`
}
const dayOf = (ms: number) => new Date(ms).toLocaleDateString([], { day: '2-digit', month: 'short' })
function spanLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86400_000) return `${(ms / 3600_000).toFixed(ms < 36000_000 ? 1 : 0)}h`
  return `${(ms / 86400_000).toFixed(1)}d`
}

export const CLASS_COLOR: Record<string, { bg: string; bd: string; fg: string }> = {
  song: { bg: 'rgba(63,123,255,.22)', bd: 'rgba(125,171,255,.65)', fg: '#a9c6ff' },
  ad: { bg: 'rgba(251,191,36,.20)', bd: 'rgba(251,191,36,.6)', fg: '#fbd88a' },
  content: { bg: 'rgba(74,222,128,.18)', bd: 'rgba(74,222,128,.55)', fg: '#9ae6b4' },
  epg: { bg: 'rgba(200,160,60,.22)', bd: 'rgba(220,180,80,.55)', fg: '#e2c68a' },
}
const laneStyleFor = (p: RecordingProgramme) => CLASS_COLOR[p.class || 'epg'] ?? CLASS_COLOR.epg

/** Nice tick interval for the current span (ms per tick). */
function tickStep(spanMs: number, px: number): number {
  const target = Math.max(70, px / 10)             // aim for ~10 labels
  const perPx = spanMs / Math.max(1, px)
  const want = perPx * target
  const steps = [1e3, 2e3, 5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3,
    3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3]
  return steps.find((s) => s >= want) ?? 86400e3
}

export default function ClipTimeline({
  domain, spans, view, setView, programmes, waveform, waveLoading,
  from, to, loaded, playheadMs, flash, onChange, onSeek, onPickProgramme,
}: {
  domain: { start: number; end: number }
  spans: Span[]
  view: { start: number; end: number }
  setView: (v: { start: number; end: number }) => void
  programmes: RecordingProgramme[]
  waveform: Waveform | null
  waveLoading: boolean
  from: number | null; to: number | null
  loaded: { from: number; to: number } | null
  playheadMs: number | null
  flash?: { from: number; to: number } | null
  onChange: (from: number, to: number) => void
  onSeek: (ms: number) => void
  onPickProgramme: (p: RecordingProgramme) => void
}) {
  const barRef = useRef<HTMLDivElement | null>(null)
  const waveRef = useRef<HTMLCanvasElement | null>(null)
  const drag = useRef<{ mode: 'new' | 'from' | 'to' | 'pan'; anchor: number; startX: number; viewStart: number; moved: boolean } | null>(null)
  const [width, setWidth] = useState(1000)

  const VW = Math.max(1000, view.end - view.start)
  const DW = Math.max(1, domain.end - domain.start)
  const pctOf = (ms: number) => Math.max(-5, Math.min(105, ((ms - view.start) / VW) * 100))
  const pct = (ms: number) => `${pctOf(ms)}%`
  const msAt = (clientX: number) => {
    const el = barRef.current
    if (!el) return view.start
    const r = el.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    return view.start + f * VW
  }

  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 1000))
    ro.observe(el); setWidth(el.clientWidth || 1000)
    return () => ro.disconnect()
  }, [])

  /** Zoom keeping `atMs` under the cursor. */
  function zoomTo(newSpan: number, atMs?: number) {
    const span = Math.max(2000, Math.min(DW, newSpan))
    const anchor = atMs ?? (view.start + VW / 2)
    const f = Math.max(0, Math.min(1, (anchor - view.start) / VW))
    let s = anchor - f * span
    let e = s + span
    if (s < domain.start) { s = domain.start; e = s + span }
    if (e > domain.end) { e = domain.end; s = Math.max(domain.start, e - span) }
    setView({ start: s, end: e })
  }
  function panBy(deltaMs: number) {
    let s = view.start + deltaMs, e = view.end + deltaMs
    if (s < domain.start) { e += domain.start - s; s = domain.start }
    if (e > domain.end) { s -= e - domain.end; e = domain.end }
    setView({ start: Math.max(domain.start, s), end: Math.min(domain.end, e) })
  }

  // wheel: zoom at the cursor (ctrl/plain), shift+wheel pans
  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.shiftKey) { panBy((e.deltaY || e.deltaX) * (VW / Math.max(1, width))); return }
      const factor = e.deltaY > 0 ? 1.25 : 0.8
      zoomTo(VW * factor, msAt(e.clientX))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  // ---- waveform painting ----------------------------------------------------
  useEffect(() => {
    const c = waveRef.current
    if (!c) return
    const g = c.getContext('2d')!
    const w = c.clientWidth, h = c.clientHeight
    if (c.width !== w * devicePixelRatio || c.height !== h * devicePixelRatio) {
      c.width = w * devicePixelRatio; c.height = h * devicePixelRatio
    }
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
    g.clearRect(0, 0, w, h)
    const mid = h / 2

    // recorded coverage behind the wave, so gaps are visible even with no data
    for (const s of spans) {
      const x0 = ((s.startMs - view.start) / VW) * w
      const x1 = ((s.endMs - view.start) / VW) * w
      if (x1 < 0 || x0 > w) continue
      g.fillStyle = 'rgba(120,150,255,.06)'
      g.fillRect(Math.max(0, x0), 0, Math.min(w, x1) - Math.max(0, x0), h)
    }
    g.strokeStyle = 'rgba(255,255,255,.10)'
    g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke()

    if (waveform && waveform.buckets.length) {
      const n = waveform.buckets.length
      const bw = w / n
      for (let i = 0; i < n; i++) {
        const b = waveform.buckets[i]
        if (!b) continue
        const x = i * bw
        const ph = Math.max(0.7, b.peak * (h / 2 - 2))
        const rh = Math.max(0.5, b.rms * (h / 2 - 2))
        g.fillStyle = 'rgba(125,211,252,.42)'
        g.fillRect(x, mid - ph, Math.max(0.7, bw - 0.2), ph * 2)
        g.fillStyle = 'rgba(63,123,255,.95)'
        g.fillRect(x, mid - rh, Math.max(0.7, bw - 0.2), rh * 2)
      }
    }
    // selection + playhead overlays on the wave
    if (from != null && to != null && to > from) {
      const x0 = ((from - view.start) / VW) * w
      const x1 = ((to - view.start) / VW) * w
      g.fillStyle = 'rgba(90,220,150,.13)'
      g.fillRect(x0, 0, Math.max(1, x1 - x0), h)
      g.strokeStyle = 'rgba(90,220,150,.85)'
      g.lineWidth = 1
      g.beginPath(); g.moveTo(x0, 0); g.lineTo(x0, h); g.moveTo(x1, 0); g.lineTo(x1, h); g.stroke()
    }
    if (playheadMs != null) {
      const x = ((playheadMs - view.start) / VW) * w
      g.strokeStyle = '#fff'; g.lineWidth = 1.5
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke()
    }
  }, [waveform, view.start, view.end, VW, spans, from, to, playheadMs, width])

  // ---- drag on the scrub bar ------------------------------------------------
  function down(e: React.PointerEvent, mode: 'new' | 'from' | 'to' | 'pan') {
    e.preventDefault(); (e.target as Element).setPointerCapture?.(e.pointerId)
    const at = msAt(e.clientX)
    drag.current = {
      mode: e.altKey || e.button === 1 ? 'pan' : mode,
      anchor: mode === 'new' ? at : (mode === 'from' ? (to ?? at) : (from ?? at)),
      startX: e.clientX, viewStart: view.start, moved: false,
    }
  }
  function move(e: React.PointerEvent) {
    const d = drag.current
    if (!d) return
    if (Math.abs(e.clientX - d.startX) > 3) d.moved = true
    if (!d.moved) return
    if (d.mode === 'pan') {
      const dx = e.clientX - d.startX
      panBy(-(dx / Math.max(1, width)) * VW - (view.start - d.viewStart))
      return
    }
    const at = msAt(e.clientX); const a = d.anchor
    onChange(Math.min(a, at), Math.max(a, at))
  }
  function up(e: React.PointerEvent) {
    const d = drag.current
    if (d && !d.moved && d.mode === 'new') onSeek(msAt(e.clientX))
    drag.current = null
  }

  // ---- ruler ticks ----------------------------------------------------------
  const ticks = useMemo(() => {
    const step = tickStep(VW, width)
    const first = Math.ceil(view.start / step) * step
    const out: { ms: number; label: string; major: boolean }[] = []
    for (let t = first; t <= view.end; t += step) {
      const d = new Date(t)
      const major = step >= 3600_000 ? d.getHours() === 0 : d.getMinutes() === 0
      out.push({ ms: t, label: step >= 86400_000 ? dayOf(t) : clockOf(t, step < 60_000), major })
      if (out.length > 60) break
    }
    return out
  }, [view.start, view.end, VW, width])

  const PRESETS: [string, number][] = [
    ['1m', 60_000], ['5m', 300_000], ['15m', 900_000], ['1h', 3600_000],
    ['4h', 4 * 3600_000], ['1d', 86400_000],
  ]
  const visibleProgs = programmes.filter(p => p.endMs > view.start && p.startMs < view.end)

  return (
    <div>
      {/* ---------- overview: the WHOLE recording + where you are ---------- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <div style={{ fontSize: 10.5, color: 'var(--faint)', width: 58, flex: 'none' }}>
          {dayOf(domain.start)}
        </div>
        <div
          onPointerDown={(e) => {
            const el = e.currentTarget as HTMLDivElement
            const r = el.getBoundingClientRect()
            const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
            const centre = domain.start + f * DW
            setView({
              start: Math.max(domain.start, centre - VW / 2),
              end: Math.min(domain.end, Math.max(domain.start, centre - VW / 2) + VW),
            })
          }}
          title="Click to move the view window"
          style={{ position: 'relative', flex: 1, height: 22, background: '#080c13', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', overflow: 'hidden' }}>
          {spans.map((s, i) => (
            <div key={s.runId + i} style={{
              position: 'absolute', top: 3, bottom: 3,
              left: `${((s.startMs - domain.start) / DW) * 100}%`,
              width: `${Math.max(0.3, ((s.endMs - s.startMs) / DW) * 100)}%`,
              background: 'rgba(120,150,255,.4)', borderRadius: 3,
            }} />
          ))}
          <div style={{
            position: 'absolute', top: 0, bottom: 0,
            left: `${((view.start - domain.start) / DW) * 100}%`,
            width: `${Math.max(0.6, (VW / DW) * 100)}%`,
            background: 'rgba(90,220,150,.16)', border: '1px solid rgba(90,220,150,.8)', borderRadius: 4,
          }} />
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--faint)', width: 58, flex: 'none', textAlign: 'right' }}>
          {dayOf(domain.end)}
        </div>
      </div>

      {/* ---------- zoom controls ---------- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--faint)', marginRight: 2 }}>Zoom</span>
        {PRESETS.map(([label, ms]) => (
          <button key={label} className={`chip ${Math.abs(VW - ms) / ms < 0.05 ? 'active' : ''}`}
            style={{ padding: '3px 10px', fontSize: 11.5 }}
            disabled={ms > DW * 1.05}
            onClick={() => zoomTo(ms)}>{label}</button>
        ))}
        <button className="chip" style={{ padding: '3px 10px', fontSize: 11.5 }}
          onClick={() => setView({ start: domain.start, end: domain.end })}>Fit all</button>
        <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
          <button className="chip" style={{ padding: '3px 9px', fontSize: 11.5 }} title="Zoom out" onClick={() => zoomTo(VW * 2)}>−</button>
          <button className="chip" style={{ padding: '3px 9px', fontSize: 11.5 }} title="Zoom in" onClick={() => zoomTo(VW / 2)}>+</button>
          <button className="chip" style={{ padding: '3px 9px', fontSize: 11.5 }} title="Pan left" onClick={() => panBy(-VW / 3)}>◀</button>
          <button className="chip" style={{ padding: '3px 9px', fontSize: 11.5 }} title="Pan right" onClick={() => panBy(VW / 3)}>▶</button>
        </div>
        {from != null && to != null && to > from && (
          <button className="chip" style={{ padding: '3px 10px', fontSize: 11.5 }}
            title="Zoom to the current trim marks"
            onClick={() => { const pad = (to - from) * 0.25; setView({ start: Math.max(domain.start, from - pad), end: Math.min(domain.end, to + pad) }) }}>
            Zoom to marks
          </button>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--faint)' }}>
          showing {spanLabel(VW)} · {dayOf(view.start)} {clockOf(view.start, VW < 3600_000)} → {clockOf(view.end, VW < 3600_000)}
          {waveLoading ? ' · measuring audio…' : waveform?.mode === 'sampled' ? ' · sampled envelope' : ''}
        </span>
      </div>

      {/* ---------- waveform ---------- */}
      <div style={{ position: 'relative', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: '#0b0f16' }}>
        <canvas ref={waveRef} style={{ width: '100%', height: 96, display: 'block' }} />
        {!waveform && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 11.5, color: 'var(--faint)', pointerEvents: 'none' }}>
            {waveLoading ? 'measuring audio…' : 'no audio measured for this window'}
          </div>
        )}
      </div>

      {/* ---------- metadata lane (EPG + radio now-playing) ---------- */}
      <div style={{ position: 'relative', height: visibleProgs.length ? 26 : 0, marginTop: visibleProgs.length ? 4 : 0, transition: 'height .15s' }}>
        {visibleProgs.map(p => {
          const l = pctOf(p.startMs), r = pctOf(p.endMs)
          if (r <= l) return null
          const c = laneStyleFor(p)
          return (
            <div key={p.id} onClick={() => onPickProgramme(p)}
              title={`${p.title}\n${clockOf(p.startMs)} → ${clockOf(p.endMs)}${p.class ? ` · ${p.class}` : ''}${p.asRun ? ' · as run' : ''}\nClick to set the trim to this item`}
              style={{
                position: 'absolute', top: 2, bottom: 2, left: `${l}%`, width: `${Math.max(r - l, 0.35)}%`,
                background: c.bg, border: `1px solid ${c.bd}`, borderRadius: 5, cursor: 'pointer',
                overflow: 'hidden', display: 'flex', alignItems: 'center', padding: '0 5px',
              }}>
              <span style={{ fontSize: 10.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: c.fg }}>{p.title}</span>
            </div>
          )
        })}
      </div>

      {/* ---------- scrub bar: coverage, marks, playhead ---------- */}
      <div ref={barRef} className="rec-timeline" onPointerDown={e => down(e, 'new')} onPointerMove={move} onPointerUp={up}
        style={{ position: 'relative', height: 40, marginTop: 4, background: '#0b0f16', border: '1px solid var(--border)', borderRadius: 8, cursor: 'crosshair', userSelect: 'none', touchAction: 'none' }}>
        {loaded && (
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: pct(loaded.from), width: `calc(${pct(loaded.to)} - ${pct(loaded.from)})`, background: 'rgba(120,150,255,.07)', borderLeft: '1px dashed rgba(120,150,255,.4)', borderRight: '1px dashed rgba(120,150,255,.4)', pointerEvents: 'none' }} />
        )}
        {spans.map((s, i) => (
          <div key={s.runId + i} title={`${clockOf(s.startMs)} → ${clockOf(s.endMs)}`}
            style={{ position: 'absolute', top: 6, bottom: 6, left: pct(s.startMs), width: `calc(${pct(s.endMs)} - ${pct(s.startMs)})`, background: 'rgba(120,150,255,.35)', borderRadius: 4, minWidth: 2, pointerEvents: 'none' }} />
        ))}
        {from != null && to != null && to > from && (
          <>
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: pct(from), width: `calc(${pct(to)} - ${pct(from)})`, background: 'rgba(90,220,150,.18)', border: '1px solid rgba(90,220,150,.7)', borderRadius: 6, pointerEvents: 'none' }} />
            <div onPointerDown={e => { e.stopPropagation(); down(e, 'from') }} onPointerMove={move} onPointerUp={up}
              style={{ position: 'absolute', top: -2, bottom: -2, left: pct(from), width: 12, marginLeft: -6, cursor: 'ew-resize', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ width: 4, height: '100%', background: 'rgba(90,220,150,.95)', borderRadius: 2 }} />
            </div>
            <div onPointerDown={e => { e.stopPropagation(); down(e, 'to') }} onPointerMove={move} onPointerUp={up}
              style={{ position: 'absolute', top: -2, bottom: -2, left: pct(to), width: 12, marginLeft: -6, cursor: 'ew-resize', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ width: 4, height: '100%', background: 'rgba(90,220,150,.95)', borderRadius: 2 }} />
            </div>
          </>
        )}
        {flash && (
          <div style={{ position: 'absolute', top: 2, bottom: 2, left: pct(flash.from),
            width: `max(3px, calc(${pct(flash.to)} - ${pct(flash.from)}))`,
            background: 'rgba(255,200,80,.55)', border: '1px solid rgba(255,210,110,.9)', borderRadius: 4,
            pointerEvents: 'none', animation: 'pulse 1.2s ease-in-out infinite' }} />
        )}
        {playheadMs != null && (
          <div style={{ position: 'absolute', top: -3, bottom: -3, left: pct(playheadMs), width: 2, marginLeft: -1, background: '#fff', boxShadow: '0 0 6px rgba(255,255,255,.6)', pointerEvents: 'none' }} />
        )}
      </div>

      {/* ---------- ruler ---------- */}
      <div style={{ position: 'relative', height: 16, marginTop: 2 }}>
        {ticks.map(t => (
          <div key={t.ms} style={{ position: 'absolute', left: pct(t.ms), transform: 'translateX(-50%)', fontSize: 10, color: t.major ? 'var(--muted)' : 'var(--faint)', whiteSpace: 'nowrap' }}>
            {t.label}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--faint)', marginTop: 3 }}>
        wheel = zoom · shift+wheel or alt+drag = pan · drag = mark in/out · click = seek · click a metadata item to trim to it
      </div>
    </div>
  )
}
