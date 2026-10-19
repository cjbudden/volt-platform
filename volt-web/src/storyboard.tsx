// ============================================================================
//  HOVER PREVIEWS from the encoder's sprite sheets (docs/THUMBNAILS.md).
//
//  Two sources, one picture:
//    * useStoryboard(stream, from, to): the stream's sheets for a wall-clock
//      window (recording timeline, source timeline). Asks the API to build
//      hours that are missing, and refreshes while the window touches "now",
//      so the live hour fills in as the scheduler adds tiles.
//    * parseThumbVtt(text): a WebVTT thumbnail track (a clip or a recording),
//      times relative to the start of the media.
//  <StoryTile> draws one tile out of a sheet with CSS background positioning:
//  one image request per sheet, however many tiles are hovered.
// ============================================================================
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Storyboard } from './api'

export interface Tile { url: string; x: number; y: number; w: number; h: number; sheetW: number }

const HOUR = 3600_000
const MAX_WINDOW = 47 * HOUR

/** Sheets for [from, to) of a stream, with a tile lookup by wall-clock ms. */
export function useStoryboard(stream: string | null | undefined, from: number | null, to: number | null) {
  const [sb, setSb] = useState<Storyboard | null>(null)
  // Round out to whole hours so panning and zooming inside an hour reuses the answer.
  const a = from == null ? null : Math.floor(Math.max(from, (to ?? from) - MAX_WINDOW) / HOUR) * HOUR
  const b = to == null ? null : Math.ceil(to / HOUR) * HOUR
  const live = b != null && b > Date.now() - HOUR
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!live) return
    const t = window.setInterval(() => setTick(n => n + 1), 60_000)
    return () => window.clearInterval(t)
  }, [live])
  useEffect(() => {
    if (!stream || a == null || b == null || b <= a) { setSb(null); return }
    let gone = false
    const t = window.setTimeout(() => {
      api.storyboard(stream, a, b, true).then(r => { if (!gone) setSb(r) }).catch(() => { /* hover previews are optional */ })
    }, 150)
    return () => { gone = true; window.clearTimeout(t) }
  }, [stream, a, b, tick])

  const index = useMemo(() => (sb?.sheets ?? []).map(s => ({ ...s, set: new Set(s.filled) })), [sb])
  function tileAt(ms: number | null): Tile | null {
    if (ms == null) return null
    for (const s of index) {
      if (ms < s.startMs || ms >= s.endMs) continue
      let i = Math.floor((ms - s.startMs) / s.intervalMs)
      // the nearest earlier tile on this sheet, so a single missed frame never blanks the hover
      while (i >= 0 && !s.set.has(i)) i--
      if (i < 0) return null
      return { url: s.url, x: (i % s.cols) * s.tileW, y: Math.floor(i / s.cols) * s.tileH, w: s.tileW, h: s.tileH, sheetW: s.cols * s.tileW }
    }
    return null
  }
  return { storyboard: sb, tileAt }
}

// ---------------------------------------------------------------- WebVTT
export interface VttCue { start: number; end: number; tile: Tile }

const vttTime = (t: string) => {
  const m = /(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/.exec(t)
  return m ? (Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000) : NaN
}

/** WebVTT thumbnails ("url#xywh=x,y,w,h" cues) -> cues in seconds. */
export function parseThumbVtt(text: string): VttCue[] {
  const out: VttCue[] = []
  const blocks = text.replace(/\r/g, '').split(/\n\n+/)
  for (const b of blocks) {
    const lines = b.split('\n').filter(Boolean)
    const ti = lines.findIndex(l => l.includes('-->'))
    if (ti < 0 || !lines[ti + 1]) continue
    const [s, e] = lines[ti].split('-->').map(x => vttTime(x.trim()))
    const m = /^(.*)#xywh=(\d+),(\d+),(\d+),(\d+)/.exec(lines[ti + 1].trim())
    if (!m || !Number.isFinite(s) || !Number.isFinite(e)) continue
    out.push({ start: s, end: e, tile: { url: m[1], x: +m[2], y: +m[3], w: +m[4], h: +m[5], sheetW: 0 } })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** The cue showing second `t` (binary search). */
export function cueAt(cues: VttCue[], t: number): VttCue | null {
  let lo = 0, hi = cues.length - 1, best: VttCue | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid].start <= t) { best = cues[mid]; lo = mid + 1 } else hi = mid - 1
  }
  return best && t < best.end + 0.5 ? best : null
}

// ---------------------------------------------------------------- drawing
/** One tile out of a sprite sheet. `width` scales it; the aspect is kept. */
export function StoryTile({ tile, width, label, style }: { tile: Tile; width?: number; label?: string; style?: React.CSSProperties }) {
  const scale = (width ?? tile.w) / tile.w
  // sheet width: known for storyboard tiles; for VTT tiles the browser works it out
  const ref = useRef<HTMLDivElement | null>(null)
  const [sheetW, setSheetW] = useState(tile.sheetW)
  useEffect(() => {
    if (tile.sheetW) { setSheetW(tile.sheetW); return }
    const img = new Image()
    img.onload = () => setSheetW(img.naturalWidth)
    img.src = tile.url
  }, [tile.url, tile.sheetW])
  return (
    <div ref={ref} style={{
      width: tile.w * scale, height: tile.h * scale, borderRadius: 6, overflow: 'hidden', position: 'relative',
      background: '#000', boxShadow: '0 6px 18px rgba(0,0,0,.55)', border: '1px solid rgba(255,255,255,.18)', ...style,
    }}>
      {sheetW > 0 && (
        <div style={{
          position: 'absolute', inset: 0, backgroundImage: `url("${tile.url}")`, backgroundRepeat: 'no-repeat',
          backgroundSize: `${sheetW * scale}px auto`, backgroundPosition: `-${tile.x * scale}px -${tile.y * scale}px`,
        }} />
      )}
      {label && (
        <span style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, padding: '1px 5px', fontSize: 11, color: '#fff',
          background: 'linear-gradient(transparent, rgba(0,0,0,.75))', fontVariantNumeric: 'tabular-nums',
        }}>{label}</span>
      )}
    </div>
  )
}

/** A thin scrub strip under a player: hover shows the frame, click seeks. */
export function ThumbScrubStrip({ cues, duration, current, onSeek }: {
  cues: VttCue[]; duration: number; current: number; onSeek: (sec: number) => void
}) {
  const [hover, setHover] = useState<{ x: number; t: number; w: number } | null>(null)
  if (!cues.length || !Number.isFinite(duration) || duration <= 0) return null
  const fmt = (t: number) => {
    const s = Math.max(0, Math.floor(t)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`
  }
  const cue = hover ? cueAt(cues, hover.t) : null
  const tileW = 176
  return (
    <div style={{ position: 'relative', marginTop: 6 }}>
      <div
        role="slider" aria-label="Scrub with previews" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(current)}
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'ArrowRight') onSeek(Math.min(duration, current + 5))
          if (e.key === 'ArrowLeft') onSeek(Math.max(0, current - 5))
        }}
        onPointerMove={e => {
          const r = e.currentTarget.getBoundingClientRect()
          const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
          setHover({ x: e.clientX - r.left, t: f * duration, w: r.width })
        }}
        onPointerLeave={() => setHover(null)}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          onSeek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * duration)
        }}
        style={{ height: 10, borderRadius: 5, background: 'var(--panel-3, #1b2130)', cursor: 'pointer', position: 'relative' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(current / duration) * 100}%`, background: 'var(--brand, #4f7cff)', borderRadius: 5, pointerEvents: 'none' }} />
      </div>
      {hover && cue && (
        <div style={{ position: 'absolute', bottom: 16, left: Math.min(Math.max(0, hover.x - tileW / 2), hover.w - tileW), pointerEvents: 'none', zIndex: 5 }}>
          <StoryTile tile={cue.tile} width={tileW} label={fmt(hover.t)} />
        </div>
      )}
    </div>
  )
}
