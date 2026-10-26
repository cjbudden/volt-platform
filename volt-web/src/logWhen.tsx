// ============================================================================
//  WHEN A LOG ROW HAPPENED, and whether it is still happening.
//
//  Encoder lines used to arrive with no time (the column read "encoder"), so
//  an operator could not tell a burst an hour ago from a fault right now. The
//  API now sends `at` (ISO) on every row, and for a repeated encoder message
//  `count` and `firstAt` (volt-app services/encoderLog.ts). Shown in the
//  viewer's own time zone:
//    09:31:02   Encoder   Still happening · 5 times since 09:28:10
//    09:02:44   Encoder   29 min ago
// ============================================================================
import { useEffect, useState } from 'react'

export interface WhenRow { ts?: string; at?: string | null; firstAt?: string | null; count?: number; level?: string }

/** A row this recent, at warn or down, is still happening rather than history. */
export const ONGOING_MS = 60_000

/** 24-hour, so it fits the log's time column and matches the other rows. */
const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()

/** The time column: 09:31:02 today, "26 Oct 21:14" on another day. */
export function logClock(r: WhenRow): string {
  if (!r.at) return r.ts && r.ts !== 'encoder' && !/T\d\d:/.test(r.ts) ? r.ts : '—'
  const d = new Date(r.at)
  const t = d.toLocaleTimeString([], CLOCK)
  return sameDay(d, new Date()) ? t : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t.slice(0, 5)}`
}

/** Full date and time for the hover title, or why there is none. */
export function logClockTitle(r: WhenRow): string {
  return r.at ? new Date(r.at).toLocaleString() : 'Written before log lines carried a time'
}

export function ago(ms: number): string {
  if (ms < 60_000) return 'just now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ${m % 60 ? `${m % 60} min ` : ''}ago`
  return `${Math.floor(h / 24)} d ago`
}

/** Re-render every 15 s so "2 min ago" keeps up between the page's own polls. */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(h) }, [everyMs])
  return now
}

/** "Still happening · 5 times since 09:28:10", or "29 min ago". Nothing for an untimed row. */
export function LogWhen({ r, now }: { r: WhenRow; now: number }) {
  if (!r.at) return null
  const age = now - Date.parse(r.at)
  const ongoing = age < ONGOING_MS && (r.level === 'warn' || r.level === 'down')
  const n = r.count ?? 1
  const first = r.firstAt && n > 1 ? new Date(r.firstAt).toLocaleTimeString([], CLOCK) : null
  return (
    <span style={{ marginLeft: 8, fontSize: 'var(--fs-xs)', color: 'var(--faint)', fontWeight: 400, whiteSpace: 'nowrap' }}>
      {ongoing
        ? <span className="tag warn" style={{ fontSize: 'var(--fs-micro)', padding: '0 6px' }}>Still happening</span>
        : ago(Math.max(0, age))}
      {n > 1 && <> · {n} times{first ? ` since ${first}` : ''}</>}
    </span>
  )
}
