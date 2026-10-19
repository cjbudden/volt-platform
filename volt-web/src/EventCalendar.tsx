// ============================================================================
//  EVENT CALENDAR: the Events page's second view, laid out like a mail
//  calendar. Day and Week are time grids (an event is a block from its start
//  to its end; overlapping events sit side by side; a red line marks now).
//  Month is a grid of days with the first few events in each and "+N more".
//  Year is twelve small months with a mark on each day that has events.
//
//  Times are the browser's local time. Weeks start on Monday. The filters and
//  group picker above it apply here too. Clicking an event opens it; clicking
//  a day in Month or Year opens that day.
// ============================================================================
import { useEffect, useMemo, useRef, useState } from 'react'
import type { EventRow } from './api'
import { Segmented, usePref } from './listFilters'

export type CalMode = 'day' | 'week' | 'month' | 'year'
export type EvPhase = 'upcoming' | 'live' | 'ended'

const HOUR_PX = 48
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const startOfWeek = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7))   // Monday
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleString(undefined, o)
const hm = (d: Date) => fmt(d, { hour: 'numeric', minute: '2-digit' })

interface CalEvent { ev: EventRow; start: Date; end: Date; phase: EvPhase }

/** Events that touch [from, to). */
function inRange(list: CalEvent[], from: Date, to: Date) {
  return list.filter(e => e.start < to && e.end > from)
}

/** Columns for overlapping blocks in one day: greedy, by start. */
function layoutDay(items: CalEvent[], dayStart: Date) {
  const dayEnd = addDays(dayStart, 1)
  const segs = items.map(e => ({
    e,
    s: Math.max(e.start.getTime(), dayStart.getTime()),
    t: Math.min(e.end.getTime(), dayEnd.getTime()),
  })).sort((a, b) => a.s - b.s || b.t - a.t)
  const out: { e: CalEvent; s: number; t: number; col: number; cols: number }[] = []
  let cluster: typeof out = []; let clusterEnd = -Infinity
  const flush = () => { const n = Math.max(1, ...cluster.map(c => c.col + 1)); cluster.forEach(c => { c.cols = n }); out.push(...cluster); cluster = []; clusterEnd = -Infinity }
  for (const g of segs) {
    if (g.s >= clusterEnd && cluster.length) flush()
    const used = new Set(cluster.filter(c => c.t > g.s).map(c => c.col))
    let col = 0; while (used.has(col)) col++
    cluster.push({ ...g, col, cols: 1 })
    clusterEnd = Math.max(clusterEnd, g.t)
  }
  if (cluster.length) flush()
  return out
}

export default function EventCalendar({ events, phaseOf, now, onOpen }: {
  events: EventRow[]; phaseOf: (e: EventRow) => EvPhase; now: number; onOpen: (e: EventRow) => void
}) {
  const [mode, setMode] = usePref<CalMode>('events.calmode', 'month', ['day', 'week', 'month', 'year'])
  const [cursor, setCursor] = useState(() => startOfDay(new Date()))
  const list = useMemo<CalEvent[]>(() => events.map(ev => {
    const start = new Date(ev.scheduled_start)
    let end = new Date(ev.scheduled_end)
    if (!(end > start)) end = new Date(start.getTime() + 30 * 60_000)
    return { ev, start, end, phase: phaseOf(ev) }
  }).sort((a, b) => a.start.getTime() - b.start.getTime()), [events, phaseOf])

  function step(dir: -1 | 1) {
    const c = cursor
    setCursor(mode === 'day' ? addDays(c, dir) : mode === 'week' ? addDays(c, 7 * dir)
      : mode === 'month' ? new Date(c.getFullYear(), c.getMonth() + dir, 1) : new Date(c.getFullYear() + dir, 0, 1))
  }
  const openDay = (d: Date) => { setCursor(startOfDay(d)); setMode('day') }

  const title = mode === 'day' ? fmt(cursor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : mode === 'week' ? (() => {
        const a = startOfWeek(cursor), b = addDays(a, 6)
        return a.getMonth() === b.getMonth()
          ? `${a.getDate()} – ${fmt(b, { day: 'numeric', month: 'long', year: 'numeric' })}`
          : `${fmt(a, { day: 'numeric', month: 'short' })} – ${fmt(b, { day: 'numeric', month: 'short', year: 'numeric' })}`
      })()
    : mode === 'month' ? fmt(cursor, { month: 'long', year: 'numeric' }) : String(cursor.getFullYear())

  return (
    <div className="card cal">
      <div className="cal-head">
        <button type="button" className="btn ghost sm" onClick={() => setCursor(startOfDay(new Date()))}>Today</button>
        <div className="cal-nav">
          <button type="button" className="cal-arrow" onClick={() => step(-1)} aria-label="Previous">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 6-6 6 6 6" /></svg>
          </button>
          <button type="button" className="cal-arrow" onClick={() => step(1)} aria-label="Next">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 6 6 6-6 6" /></svg>
          </button>
        </div>
        <h2 className="cal-title" aria-live="polite">{title}</h2>
        <div className="cal-legend" aria-hidden="true">
          <span><i className="live" />Live</span><span><i className="upcoming" />Upcoming</span><span><i className="ended" />Ended</span>
        </div>
        <Segmented label="Calendar view" value={mode} onChange={setMode} options={[
          { value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'year', label: 'Year' },
        ]} />
      </div>
      {mode === 'day' && <TimeGrid days={[cursor]} list={list} now={now} onOpen={onOpen} onDay={openDay} />}
      {mode === 'week' && <TimeGrid days={Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i))} list={list} now={now} onOpen={onOpen} onDay={openDay} />}
      {mode === 'month' && <MonthGrid month={startOfMonth(cursor)} list={list} now={now} onOpen={onOpen} onDay={openDay} />}
      {mode === 'year' && <YearGrid year={cursor.getFullYear()} list={list} now={now} onDay={openDay}
        onMonth={m => { setCursor(new Date(cursor.getFullYear(), m, 1)); setMode('month') }} />}
    </div>
  )
}

function EvBlock({ e, onOpen, style, compact }: { e: CalEvent; onOpen: (ev: EventRow) => void; style?: React.CSSProperties; compact?: boolean }) {
  const label = `${e.ev.name}, ${hm(e.start)} to ${hm(e.end)}, ${e.phase}`
  return (
    <button type="button" className={`cal-ev ${e.phase}${compact ? ' compact' : ''}`} style={style} title={label} aria-label={label}
      onClick={x => { x.stopPropagation(); onOpen(e.ev) }}>
      <b>{e.ev.name}</b>
      {!compact && <span>{hm(e.start)} – {hm(e.end)}</span>}
    </button>
  )
}

/** Day and Week: hours down the side, one column per day. */
function TimeGrid({ days, list, now, onOpen, onDay }: {
  days: Date[]; list: CalEvent[]; now: number; onOpen: (e: EventRow) => void; onDay: (d: Date) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const today = new Date(now)
  // open at the first event of the span, or 7am, or now if today is shown
  const key = days.map(d => d.getTime()).join(',')
  useEffect(() => {
    const el = scroller.current; if (!el) return
    const from = days[0], to = addDays(days[days.length - 1], 1)
    const first = inRange(list, from, to)[0]
    const showsToday = days.some(d => sameDay(d, today))
    const hour = showsToday ? Math.max(0, today.getHours() - 2) : first ? Math.max(0, Math.min(first.start < from ? 0 : first.start.getHours() - 1, 23)) : 7
    el.scrollTop = hour * HOUR_PX
    // eslint-disable-next-line
  }, [key])
  return (
    <div className="cal-tg">
      <div className="cal-tg-head" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)` }}>
        <span />
        {days.map(d => (
          <button type="button" key={d.getTime()} className={`cal-tg-day${sameDay(d, today) ? ' today' : ''}`} onClick={() => onDay(d)} disabled={days.length === 1}>
            <span>{fmt(d, { weekday: 'short' })}</span><b>{d.getDate()}</b>
          </button>
        ))}
      </div>
      <div className="cal-tg-body" ref={scroller}>
        <div className="cal-tg-grid" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)`, height: 24 * HOUR_PX }}>
          <div className="cal-hours">
            {Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR_PX }}>{h === 0 ? '' : fmt(new Date(2000, 0, 1, h), { hour: 'numeric' })}</span>)}
          </div>
          {days.map(d => {
            const segs = layoutDay(inRange(list, d, addDays(d, 1)), d)
            const isToday = sameDay(d, today)
            return (
              <div key={d.getTime()} className={`cal-col${isToday ? ' today' : ''}`}>
                {segs.map(g => {
                  const top = (g.s - d.getTime()) / 3600_000 * HOUR_PX
                  const h = Math.max(22, (g.t - g.s) / 3600_000 * HOUR_PX - 2)
                  return <EvBlock key={g.e.ev.id} e={g.e} onOpen={onOpen} compact={h < 36}
                    style={{ position: 'absolute', top, height: h, left: `calc(${(g.col / g.cols) * 100}% + 2px)`, width: `calc(${100 / g.cols}% - 4px)` }} />
                })}
                {isToday && <div className="cal-now" style={{ top: (now - d.getTime()) / 3600_000 * HOUR_PX }} aria-label="Now" />}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** Month: six weeks of days, the first three events in each. */
function MonthGrid({ month, list, now, onOpen, onDay }: {
  month: Date; list: CalEvent[]; now: number; onOpen: (e: EventRow) => void; onDay: (d: Date) => void
}) {
  const first = startOfWeek(month)
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i))
  const today = new Date(now)
  const MAX = 3
  return (
    <div className="cal-month">
      <div className="cal-month-dow">{days.slice(0, 7).map(d => <span key={d.getTime()}>{fmt(d, { weekday: 'short' })}</span>)}</div>
      <div className="cal-month-grid">
        {days.map(d => {
          const items = inRange(list, d, addDays(d, 1))
          const out = d.getMonth() !== month.getMonth()
          return (
            <div key={d.getTime()} className={`cal-cell${out ? ' out' : ''}${sameDay(d, today) ? ' today' : ''}`}
              onClick={() => onDay(d)} role="button" tabIndex={0} aria-label={`${fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}, ${items.length} event${items.length === 1 ? '' : 's'}`}
              onKeyDown={e => { if (e.key === 'Enter') onDay(d) }}>
              <span className="cal-date">{d.getDate()}</span>
              {items.slice(0, MAX).map(e => (
                <button type="button" key={e.ev.id} className={`cal-chip ${e.phase}`} title={`${e.ev.name}, ${hm(e.start)} to ${hm(e.end)}`}
                  onClick={x => { x.stopPropagation(); onOpen(e.ev) }}>
                  <i />{e.start >= d ? <span className="t">{hm(e.start)}</span> : null}<span className="n">{e.ev.name}</span>
                </button>
              ))}
              {items.length > MAX && <span className="cal-more">+{items.length - MAX} more</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Year: twelve small months; a dot on each day with events. */
function YearGrid({ year, list, now, onDay, onMonth }: {
  year: number; list: CalEvent[]; now: number; onDay: (d: Date) => void; onMonth: (m: number) => void
}) {
  const today = new Date(now)
  // events per local day, counted once per day they touch
  const perDay = useMemo(() => {
    const m = new Map<number, { n: number; live: boolean }>()
    const y0 = new Date(year, 0, 1), y1 = new Date(year + 1, 0, 1)
    for (const e of inRange(list, y0, y1)) {
      for (let d = startOfDay(e.start < y0 ? y0 : e.start); d < e.end && d < y1; d = addDays(d, 1)) {
        const k = d.getTime(); const v = m.get(k) ?? { n: 0, live: false }
        v.n++; v.live = v.live || e.phase === 'live'; m.set(k, v)
      }
    }
    return m
  }, [list, year])
  return (
    <div className="cal-year">
      {Array.from({ length: 12 }, (_, mi) => {
        const m0 = new Date(year, mi, 1)
        const first = startOfWeek(m0)
        const cells = Array.from({ length: 42 }, (_, i) => addDays(first, i))
        let total = 0
        for (let d = m0; d.getMonth() === mi; d = addDays(d, 1)) total += perDay.get(d.getTime())?.n ?? 0
        return (
          <div key={mi} className="cal-ym">
            <button type="button" className="cal-ym-title" onClick={() => onMonth(mi)}>
              {fmt(m0, { month: 'long' })}{total ? <span>{total}</span> : null}
            </button>
            <div className="cal-ym-grid">
              {cells.slice(0, 7).map(d => <span key={'h' + d.getTime()} className="dow">{fmt(d, { weekday: 'narrow' })}</span>)}
              {cells.map(d => {
                const v = perDay.get(d.getTime())
                const out = d.getMonth() !== mi
                if (out) return <span key={d.getTime()} className="day out" />
                return (
                  <button type="button" key={d.getTime()} className={`day${v ? ' has' : ''}${v?.live ? ' live' : ''}${sameDay(d, today) ? ' today' : ''}`}
                    onClick={() => onDay(d)} title={v ? `${v.n} event${v.n === 1 ? '' : 's'}` : undefined}
                    aria-label={`${fmt(d, { day: 'numeric', month: 'long' })}${v ? `, ${v.n} event${v.n === 1 ? '' : 's'}` : ''}`}>
                    {d.getDate()}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

