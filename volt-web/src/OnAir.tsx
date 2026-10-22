// ON AIR, from any page. A pill in the top bar with the live counts, and a
// drawer listing what is on air or in trouble, so an operator working in the
// Media Library or the Admin area can see a station drop without leaving.
//
// One request (GET /monitoring/live, the same board the Live page reads),
// refreshed when the shared status stream says something changed and every
// 30 s as a floor in case that stream has given up. Nothing per stream.
import { useEffect, useRef, useState } from 'react'
import { api, type LiveBoard, type LiveStream } from './api'
import { subscribeLive } from './liveStatus'
import { navigate } from './router'

const TROUBLE = new Set(['error', 'degraded'])
const SHOWN = new Set(['onair', 'ready', 'starting', 'degraded', 'error'])
const RANK: Record<string, number> = { error: 0, degraded: 1, starting: 2, onair: 3, ready: 4 }

function fmtUptime(ms: number | null): string {
  if (ms == null) return ''
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

function detail(s: LiveStream): string {
  if (s.overall === 'error') return s.primaryError?.label || 'error'
  if (s.overall === 'degraded') {
    if (s.fallbackInUse) return 'on backup'
    if (s.fillerInUse) return 'on filler'
    const drop = Object.keys(s.degradedOutputs || {})[0]
    return drop ? `${drop} dropped` : (s.primaryError?.label || 'degraded')
  }
  if (s.overall === 'starting') return 'starting'
  if (s.fillerInUse) return 'on filler'
  return fmtUptime(s.uptimeMs)
}

const KIND: Record<string, string> = { tv: 'Channel', radio: 'Radio', event: 'Event' }

export function OnAirButton() {
  const [board, setBoard] = useState<LiveBoard | null>(null)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let alive = true
    let pending: ReturnType<typeof setTimeout> | null = null
    const load = () => { api.liveBoard().then(b => { if (alive) setBoard(b) }).catch(() => { /* keep the last board */ }) }
    // Coalesce bursts: a fleet start sends a status frame per stream.
    const soon = () => { if (!pending) pending = setTimeout(() => { pending = null; load() }, 1500) }
    load()
    const off = subscribeLive('*', m => { if (m.type === 'status' || m.type === 'resync') soon() })
    const h = setInterval(load, 30_000)
    return () => { alive = false; off(); clearInterval(h); if (pending) clearTimeout(pending) }
  }, [])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  if (!board) return null
  const streams = board.streams.filter(s => SHOWN.has(s.overall))
    .sort((a, b) => (RANK[a.overall] ?? 9) - (RANK[b.overall] ?? 9) || a.name.localeCompare(b.name))
  const errors = board.streams.filter(s => s.overall === 'error').length
  const degraded = board.streams.filter(s => s.overall === 'degraded').length
  const go = (href: string) => { setOpen(false); navigate(href) }

  return (
    <div className="onair-box" ref={boxRef}>
      <button className={`onair-pill${open ? ' open' : ''}`} onClick={() => setOpen(o => !o)}
        aria-haspopup="dialog" aria-expanded={open}
        title="What is on air right now, from any page">
        <span className={`dot-s ${board.onAir > 0 ? 'live' : 'idle'}`} />
        <span>On air <b>{board.onAir}</b></span>
        {degraded > 0 && <span className="onair-n"><span className="dot-s warn" />{degraded}</span>}
        {errors > 0 && <span className="onair-n"><span className="dot-s down" />{errors}</span>}
      </button>
      {open && (
        <div className="onair-drawer card" role="dialog" aria-label="On air">
          <div className="onair-head">
            <b>On air</b>
            <span className="onair-sum">{board.onAir} on air{degraded ? ` · ${degraded} degraded` : ''}{errors ? ` · ${errors} failed` : ''}</span>
          </div>
          {streams.length === 0
            ? <div className="onair-empty">Nothing is running right now.</div>
            : <div className="onair-list">
                {streams.map(s => (
                  <a key={s.kind + s.id} href={s.href} className="onair-row"
                    onClick={e => { if (e.metaKey || e.ctrlKey || e.button === 1) return; e.preventDefault(); go(s.href) }}>
                    <span className={`dot-s ${s.overall === 'error' ? 'down' : s.overall === 'degraded' ? 'warn' : s.overall === 'starting' ? 'sched' : 'live'}`} />
                    <span className="nm">{s.name}<span className="k">{KIND[s.kind] ?? s.kind}{s.groupName ? ` · ${s.groupName}` : ''}</span></span>
                    <span className={`m${TROUBLE.has(s.overall) ? ' bad' : ''}`}>{detail(s)}</span>
                  </a>
                ))}
              </div>}
          <div className="onair-foot">
            <button className="btn ghost" onClick={() => go('/monitoring')}>Open Monitoring</button>
            <button className="btn ghost" onClick={() => go('/live')}>All live streams</button>
          </div>
        </div>
      )}
    </div>
  )
}
