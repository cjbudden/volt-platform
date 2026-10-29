import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { api, type ProgrammeFlag } from './api'
import { navigate } from './router'
import { useNotify } from './notices'
import { flagHref, flagTitle } from './programmeMedia'

/* ============================================================================
   THE SAME GESTURES ON EVERY GUIDE ENTRY OR LOGGED SONG (24 Oct 2026):
   the channel, event and station guide strips and the station's metadata log.

     click            open what the flag leads to (the VOD, or the recording
                      playing from the entry's start)
     double click     the EPG on that entry's day, the entry marked
     Ctrl+click,      Auto VOD on / off, for an entry that has not finished
     Ctrl+R (hovered  airing. Ctrl+R is taken from the browser ONLY while an
       or focused)    entry is hovered or focused. On a Mac, Ctrl+click is a
                      context-menu click, handled the same.
   ========================================================================== */
export interface GestureEntry { id?: string; name: string; startMs?: number; endMs?: number; flag?: ProgrammeFlag | null }

const dayParam = (ms: number) => { const x = new Date(ms); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` }

/** `epgPath`: the owner's guide, e.g. /epg/channel/<id>, /epg/radio/<id>, /epg/event/<id>. */
export function useProgrammeGestures(epgPath: string, onChanged?: () => void) {
  const notify = useNotify()
  const clickTimer = useRef<number | null>(null)
  const hovered = useRef<GestureEntry | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function toggleAutoVod(p: GestureEntry) {
    if (!p.id) return
    if (typeof p.endMs === 'number' && p.endMs <= Date.now()) {
      notify({ kind: 'info', message: `"${p.name}" has already aired, so Auto VOD no longer applies. Convert it from the EPG instead.` }); return
    }
    const on = p.flag?.kind !== 'autovod'
    setBusyId(p.id)
    try {
      await api.patchProgramme(p.id, { autoVod: on } as any)
      notify({ kind: 'ok', message: `Auto VOD ${on ? 'on' : 'off'} for "${p.name}"` })
      onChanged?.()
    } catch (e: any) { notify({ kind: 'error', message: `Could not change Auto VOD: ${e.message}` }) }
    finally { setBusyId(null) }
  }
  const toggleRef = useRef(toggleAutoVod); toggleRef.current = toggleAutoVod

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || (e.key !== 'r' && e.key !== 'R')) return
      const p = hovered.current
      if (!p) return
      e.preventDefault()
      toggleRef.current(p)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])

  const openDay = (p: GestureEntry) => {
    if (typeof p.startMs !== 'number') return
    navigate(`${epgPath}?day=${dayParam(p.startMs)}${p.id ? `&p=${encodeURIComponent(p.id)}` : ''}`)
  }

  /** Props for the element that represents one entry. */
  function bind(p: GestureEntry) {
    const href = flagHref(p.flag)
    const aired = typeof p.endMs === 'number' && p.endMs <= Date.now()
    return {
      tabIndex: 0,
      title: [p.flag ? flagTitle(p.flag) : null, href ? 'Click to open.' : null, 'Double click: this day in the EPG.',
        aired ? null : 'Ctrl+click or Ctrl+R: Auto VOD on/off.'].filter(Boolean).join('\n'),
      onMouseEnter: () => { hovered.current = p },
      onMouseLeave: () => { if (hovered.current?.id === p.id) hovered.current = null },
      onFocus: () => { hovered.current = p },
      onBlur: () => { if (hovered.current?.id === p.id) hovered.current = null },
      onClick: (e: MouseEvent) => {
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleAutoVod(p); return }
        if (!href) return
        if (clickTimer.current) window.clearTimeout(clickTimer.current)
        clickTimer.current = window.setTimeout(() => { clickTimer.current = null; navigate(href) }, 260)
      },
      onContextMenu: (e: MouseEvent) => { if (e.ctrlKey) { e.preventDefault(); toggleAutoVod(p) } },
      onDoubleClick: (e: MouseEvent) => {
        e.preventDefault()
        if (clickTimer.current) { window.clearTimeout(clickTimer.current); clickTimer.current = null }
        openDay(p)
      },
      onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') { if (href) navigate(href); else openDay(p) } },
    }
  }
  return { bind, busyId, toggleAutoVod, openDay }
}

/** The current entry's label by BROADCAST state, not by the clock. */
export type Broadcast = 'onair' | 'ready' | 'off'
export const BROADCAST: Record<Broadcast, { label: string; card: string; pill: string; hint: string }> = {
  onair: { label: 'ON AIR', card: 'ON AIR', pill: 'live', hint: 'Scheduled now, and going out' },
  ready: { label: 'READY · NOT PUBLIC', card: 'READY', pill: 'sched', hint: 'Scheduled now; running but not public' },
  off: { label: 'NOT BROADCASTING', card: 'OFF AIR', pill: 'idle', hint: 'Scheduled now; not running, so nothing is going out' },
}
/** From the five-gate roll-up (health.overall) and whether it is public. */
export function broadcastOf(overall: string | null | undefined, onAir: boolean): Broadcast {
  const ov = overall ?? 'idle'
  if (ov === 'onair' || (ov === 'degraded' && onAir)) return 'onair'
  if (ov === 'ready' || ov === 'starting' || ov === 'degraded') return 'ready'
  return 'off'
}
