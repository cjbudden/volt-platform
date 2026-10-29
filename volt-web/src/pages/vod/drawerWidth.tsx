// The asset panel's width: drag its left edge, or use the width button in its header
// (Normal, Wide, Full width). Remembered in this browser for next time.
import { useEffect, useRef, useState, type CSSProperties } from 'react'

const KEY = 'volt.assetPanel.width'
const MIN = 560
export const PRESETS = [
  { key: 'normal', label: 'Normal width', px: 980 },
  { key: 'wide', label: 'Wide', px: 1360 },
  { key: 'full', label: 'Full width', px: Infinity },
] as const

const read = (): number => { try { const v = Number(localStorage.getItem(KEY)); return Number.isFinite(v) && v >= MIN ? v : 980 } catch { return 980 } }
const write = (v: number) => { try { localStorage.setItem(KEY, String(Math.round(v))) } catch { /* private window */ } }

export function useDrawerWidth() {
  const [width, setWidthRaw] = useState<number>(read)
  const [vw, setVw] = useState(() => window.innerWidth)
  useEffect(() => { const on = () => setVw(window.innerWidth); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on) }, [])
  const setWidth = (v: number) => { const c = Math.max(MIN, Math.min(v, 100000)); setWidthRaw(c); write(c) }
  const shown = Math.min(width, vw)
  const full = width >= vw - 4
  const current = full ? 'full' : PRESETS.find((p) => Math.abs(p.px - width) < 24)?.key ?? 'custom'
  const next = current === 'normal' ? PRESETS[1] : current === 'wide' ? PRESETS[2] : PRESETS[0]
  const style: CSSProperties = { width: shown, maxWidth: '100vw', position: 'relative' }
  return { width: shown, setWidth, style, current, next, cycle: () => setWidth(next.px === Infinity ? 100000 : next.px) }
}

/** The drag handle on the panel's left edge. Arrow keys move it 40 px; double-click goes back to normal. */
export function DrawerResizeHandle({ width, setWidth }: { width: number; setWidth: (v: number) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null)
  const [on, setOn] = useState(false)
  return (
    <div className={`drawer-resize${on ? ' on' : ''}`} role="separator" aria-orientation="vertical" aria-label="Panel width"
      aria-valuenow={Math.round(width)} aria-valuemin={MIN} tabIndex={0} title="Drag to resize · double-click for normal width"
      onPointerDown={(e) => { drag.current = { x: e.clientX, w: width }; setOn(true); (e.target as HTMLElement).setPointerCapture(e.pointerId) }}
      onPointerMove={(e) => { if (drag.current) setWidth(drag.current.w + (drag.current.x - e.clientX)) }}
      onPointerUp={() => { drag.current = null; setOn(false) }} onPointerCancel={() => { drag.current = null; setOn(false) }}
      onDoubleClick={() => setWidth(980)}
      onKeyDown={(e) => { if (e.key === 'ArrowLeft') { e.preventDefault(); setWidth(width + 40) } else if (e.key === 'ArrowRight') { e.preventDefault(); setWidth(width - 40) } }} />
  )
}

/** The header button: Normal > Wide > Full width. */
export function WidthButton({ current, next, onClick }: { current: string; next: { label: string; key: string }; onClick: () => void }) {
  const expand = next.key !== 'normal'
  return (
    <button type="button" className="icon-btn" onClick={onClick} aria-label={`Panel width is ${current}; change to ${next.label}`} title={next.label}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {expand
          ? <><path d="M3 12h18" /><path d="M7 8l-4 4 4 4" /><path d="M17 8l4 4-4 4" /></>
          : <><path d="M2 12h7" /><path d="M15 12h7" /><path d="M6 9l3 3-3 3" /><path d="M18 9l-3 3 3 3" /><path d="M12 5v14" /></>}
      </svg>
    </button>
  )
}
