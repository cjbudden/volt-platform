// ============================================================================
//  HOVER PREVIEW FROM SPRITE SHEETS (Loops & Fillers; Christian, 3 Nov 2026).
//
//  A loop's rollover used to play its ORIGINAL file in a <video>. That only
//  worked when the browser could decode the upload: a ProRes, MXF or (outside
//  Safari) HEVC loop showed nothing, and an H.264 master pulled megabytes to
//  animate a 112-pixel box. The sprite sheets made with the thumbnails
//  (services/media/fillerThumbs.ts) are plain JPEGs, so stepping through their
//  tiles looks the same in every browser, whatever the source format, for
//  about 100 KB that is often already cached.
//
//  The WebVTT (one cue per tile, `<sheet url>#xywh=x,y,w,h`) is fetched on the
//  first hover and kept for the page's life. The sheets are drawn as a CSS
//  background, scaled to the box, so no canvas and no decoding. A viewer who
//  asks for reduced motion gets the thumbnail only.
//
//  SMOOTH AT THE WRAP AND BETWEEN SHEETS (11 Nov 2026). Every sheet is its own
//  layer, painted once and shown or hidden, because swapping one element's
//  background image could blank it for a frame each time the preview moved
//  to the next sheet. The steps are spread evenly over the whole loop and
//  always end on its last tile, so the jump back to the start is one ordinary
//  step, not a skip of a varying size. (The black frame at the wrap was a
//  server fault, fixed in fillerThumbs.ts: the sheets claimed one tile more
//  than they held.)
// ============================================================================
import { useEffect, useRef, useState } from 'react'

interface Tile { url: string; x: number; y: number; w: number; h: number }
interface Sheets { tiles: Tile[]; size: Map<string, { w: number; h: number }> }

const cache = new Map<string, Promise<Sheets>>()
const FRAMES = 40       // at most this many steps, spread over the whole loop
const STEP_MS = 180     // about five and a half a second

/** Tiles from a sprite WebVTT, in time order. */
export function parseSpriteVtt(vtt: string): Sheets {
  const tiles: Tile[] = []
  for (const m of vtt.matchAll(/-->[^\n]*\n([^\n#]+)#xywh=(\d+),(\d+),(\d+),(\d+)/g))
    tiles.push({ url: m[1].trim(), x: +m[2], y: +m[3], w: +m[4], h: +m[5] })
  // A sheet's size is read from the image itself when it loads (sheetSizes): a sheet is
  // always the full grid, mostly empty for a short loop, so the filled tiles understate it.
  const size = new Map<string, { w: number; h: number }>()
  for (const t of tiles) {
    const s = size.get(t.url) ?? { w: 0, h: 0 }
    size.set(t.url, { w: Math.max(s.w, t.x + t.w), h: Math.max(s.h, t.y + t.h) })
  }
  return { tiles, size }
}

/** Load every sheet once and record its real size; the preview starts when they are in. */
async function sheetSizes(s: Sheets): Promise<Sheets> {
  await Promise.all([...s.size.keys()].map((u) => new Promise<void>((done) => {
    const im = new Image()
    im.onload = () => { if (im.naturalWidth) s.size.set(u, { w: im.naturalWidth, h: im.naturalHeight }); done() }
    im.onerror = () => done()
    im.src = u
  })))
  return s
}

const reduceMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } }

export function SpriteHover({ id, poster, width, height, loadVtt, label }: {
  /** Cache key: the asset id. */
  id: string
  /** Shown at rest, and when there is nothing to animate. */
  poster: string | null
  /** The box in pixels; leave both out to fill the parent (measured when the hover starts). */
  width?: number
  height?: number
  loadVtt: () => Promise<string>
  label?: string
}) {
  const [sheets, setSheets] = useState<Sheets | null>(null)
  const [i, setI] = useState(-1)           // -1: at rest, the thumbnail
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const el = useRef<HTMLSpanElement | null>(null)
  const [dims, setDims] = useState({ w: width ?? 0, h: height ?? 0 })
  const hovering = useRef(false)
  const stop = () => { hovering.current = false; if (timer.current) clearInterval(timer.current); timer.current = null; setI(-1) }
  useEffect(() => stop, [])

  const start = () => {
    if (reduceMotion() || timer.current) return
    if (width == null || height == null) { const r = el.current?.getBoundingClientRect(); if (r) setDims({ w: r.width, h: r.height }) }
    let p = cache.get(id)
    if (!p) { p = loadVtt().then(parseSpriteVtt).then(sheetSizes); cache.set(id, p); p.catch(() => cache.delete(id)) }
    hovering.current = true
    p.then((s) => {
      if (!s.tiles.length || !hovering.current || timer.current) return
      setSheets(s)
      const n = s.tiles.length, frames = Math.min(n, FRAMES)
      // step j shows tile round(j * (n-1) / (frames-1)): 0 first, the last tile last
      const at = (j: number) => (frames <= 1 ? 0 : Math.round((j * (n - 1)) / (frames - 1)))
      let j = 0
      setI(0)
      timer.current = setInterval(() => { j = (j + 1) % frames; setI(at(j)) }, STEP_MS)
    }).catch(() => { /* no sprites: the thumbnail stays */ })
  }

  const t = i >= 0 && sheets ? sheets.tiles[i] : null
  const sheet = t ? sheets!.size.get(t.url)! : null
  // Cover the box: scale so the tile fills it, centred.
  const W = width ?? dims.w, H = height ?? dims.h
  const scale = t ? Math.max(W / t.w, H / t.h) : 1
  const box = { width: width ?? '100%', height: height ?? '100%', borderRadius: 4, background: '#000', overflow: 'hidden', position: 'relative' as const, display: 'block' }
  return (
    <span ref={el} style={box} onMouseEnter={start} onMouseLeave={stop} onFocus={start} onBlur={stop} aria-label={label}>
      {t && sheet && sheets ? (
        // one layer per sheet, all painted; only the current tile's sheet is shown
        [...sheets.size.entries()].map(([url, sz]) => (
          <span key={url} aria-hidden="true" style={{
            position: 'absolute', inset: 0, visibility: url === t.url ? 'visible' : 'hidden',
            backgroundImage: `url("${url}")`, backgroundRepeat: 'no-repeat',
            backgroundSize: `${sz.w * scale}px ${sz.h * scale}px`,
            backgroundPosition: url === t.url ? `${-t.x * scale + (W - t.w * scale) / 2}px ${-t.y * scale + (H - t.h * scale) / 2}px` : '0 0',
          }} />
        ))
      ) : poster ? (
        <img src={poster} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : null}
      {t && sheets && (
        // Where in the loop the preview is: a thin line along the foot.
        <span aria-hidden="true" style={{ position: 'absolute', left: 0, bottom: 0, height: 2, background: 'var(--brand)',
          width: `${((i + 1) / sheets.tiles.length) * 100}%` }} />
      )}
    </span>
  )
}
