import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProgrammeRow, ProgrammeVod, VodState } from '../api'

/* ============================================================================
   EPG TIMELINE: the same day as the list, drawn as a vertical time axis.

   The list answers "what is in each slot". The timeline answers the questions
   the list hides: where the day has GAPS (nothing scheduled, so the channel's
   own identity shows), where programmes OVERLAP (drawn side by side in lanes,
   not stacked out of sight), how long each slot really is relative to the
   others, and where NOW is.

   It is a view, not a second editor: a block opens the same programme drawer
   the list does, and clicking empty time opens "Add programme" at that time
   (snapped to 15 minutes). Programmes that cross midnight are clipped to the
   day and say where they continue.
   ========================================================================== */

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const SNAP_MIN = 15
const MIN_GAP_MS = 5 * 60_000
const ZOOMS = [40, 64, 110] as const

const p2 = (n: number) => String(n).padStart(2, '0')
const fmtT = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
function fmtDur(ms: number) {
  const m = Math.round(ms / 60000)
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`
}

const VOD_TAG: Partial<Record<VodState, { label: string; color: string }>> = {
  scheduled: { label: 'Auto VOD', color: 'var(--brand)' },
  converting: { label: 'Converting', color: 'var(--warn,#e2b64f)' },
  converted: { label: 'VOD ready', color: 'var(--live)' },
  convertible: { label: 'Recorded', color: 'var(--warn,#e2b64f)' },
  failed: { label: 'VOD failed', color: 'var(--down,#f87171)' },
}

interface Placed {
  p: ProgrammeRow
  s: number          // clipped to the day
  e: number
  rawS: number
  rawE: number
  lane: number
  lanes: number
}

/** Overlapping programmes share a cluster; inside it each takes the first free lane. */
function layout(progs: ProgrammeRow[], dayStart: number, dayEnd: number): Placed[] {
  const items = progs
    .map(p => {
      const rawS = Date.parse(p.starts_at), rawE = Date.parse(p.ends_at)
      return { p, rawS, rawE, s: Math.max(rawS, dayStart), e: Math.min(rawE, dayEnd), lane: 0, lanes: 1 }
    })
    .filter(x => x.e > x.s)
    .sort((a, b) => a.s - b.s || b.e - a.e)
  const out: Placed[] = []
  let cluster: Placed[] = []
  let laneEnds: number[] = []
  let clusterEnd = -Infinity
  const flush = () => { for (const c of cluster) c.lanes = laneEnds.length; out.push(...cluster); cluster = []; laneEnds = [] }
  for (const it of items) {
    if (it.s >= clusterEnd && cluster.length) flush()
    let lane = laneEnds.findIndex(end => end <= it.s)
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(it.e) } else laneEnds[lane] = it.e
    it.lane = lane
    cluster.push(it)
    clusterEnd = Math.max(clusterEnd === -Infinity ? it.e : clusterEnd, it.e)
  }
  if (cluster.length) flush()
  return out
}

/** Stretches of the day no programme covers. */
function gapsOf(placed: Placed[], dayStart: number, dayEnd: number) {
  const gaps: { s: number; e: number }[] = []
  let cursor = dayStart
  for (const x of [...placed].sort((a, b) => a.s - b.s)) {
    if (x.s - cursor >= MIN_GAP_MS) gaps.push({ s: cursor, e: x.s })
    cursor = Math.max(cursor, x.e)
  }
  if (dayEnd - cursor >= MIN_GAP_MS) gaps.push({ s: cursor, e: dayEnd })
  return gaps
}

export function EpgTimeline({ day, progs, vod, overlapsById, ownerWord, onEdit, onAdd }: {
  day: Date
  progs: ProgrammeRow[]
  vod: Record<string, ProgrammeVod>
  overlapsById: Map<string, string[]>
  ownerWord: string
  onEdit: (p: ProgrammeRow) => void
  onAdd: (hhmm: string) => void
}) {
  const [zoom, setZoom] = useState<number>(() => {
    try { const z = Number(localStorage.getItem('volt.epg.zoom')); return ZOOMS.includes(z as any) ? z : ZOOMS[1] } catch { return ZOOMS[1] }
  })
  useEffect(() => { try { localStorage.setItem('volt.epg.zoom', String(zoom)) } catch { /* per-viewer nicety only */ } }, [zoom])

  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])

  const dayStart = day.getTime()
  const dayEnd = dayStart + DAY_MS
  const isToday = now >= dayStart && now < dayEnd
  const pxPerMs = zoom / HOUR_MS
  const y = (t: number) => (t - dayStart) * pxPerMs

  const placed = useMemo(() => layout(progs, dayStart, dayEnd), [progs, dayStart, dayEnd])
  const gaps = useMemo(() => gapsOf(placed, dayStart, dayEnd), [placed, dayStart, dayEnd])

  /* Open where the work is: today at an hour before now, another day at its
     first programme. Only on a day change, never on a refresh after an edit. */
  const body = useRef<HTMLDivElement>(null)
  const firstStart = placed.length ? Math.min(...placed.map(x => x.s)) : dayStart + 6 * HOUR_MS
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    const target = isToday ? now - HOUR_MS : firstStart
    el.scrollTop = Math.max(0, y(target) - 8)
    // eslint-disable-next-line
  }, [dayStart, zoom])

  /* Hover guide on empty time: where a click would add a programme. */
  const [hover, setHover] = useState<number | null>(null)
  const snapAt = (clientY: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const ms = (clientY - r.top) / pxPerMs
    const snapped = Math.round(ms / (SNAP_MIN * 60_000)) * SNAP_MIN * 60_000
    return Math.min(Math.max(0, snapped), DAY_MS - SNAP_MIN * 60_000)
  }
  const hhmmOf = (offsetMs: number) => { const d = new Date(dayStart + offsetMs); return `${p2(d.getHours())}:${p2(d.getMinutes())}` }

  const zi = ZOOMS.indexOf(zoom as any)
  const legend = gaps.reduce((m, g) => m + (g.e - g.s), 0)

  return (
    <div className="card epg-tl">
      <div className="epg-tl-head">
        <span className="epg-tl-sum">
          {placed.length} programme{placed.length === 1 ? '' : 's'}
          {gaps.length > 0 && <> · <span style={{ color: 'var(--warn,#e2b64f)' }}>{gaps.length} gap{gaps.length === 1 ? '' : 's'} ({fmtDur(legend)})</span></>}
          {overlapsById.size > 0 && <> · <span style={{ color: 'var(--warn,#e2b64f)' }}>{overlapsById.size} overlapping</span></>}
        </span>
        <span className="epg-tl-hint">Click empty time to add a programme there</span>
        <div className="epg-tl-zoom" role="group" aria-label="Zoom">
          <button type="button" className="cal-arrow" disabled={zi <= 0} onClick={() => setZoom(ZOOMS[Math.max(0, zi - 1)])} aria-label="Zoom out">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14" /></svg>
          </button>
          <button type="button" className="cal-arrow" disabled={zi >= ZOOMS.length - 1} onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, zi + 1)])} aria-label="Zoom in">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
      </div>

      <div className="epg-tl-body" ref={body}>
        <div className="epg-tl-grid" style={{ height: 24 * zoom, ['--hour' as any]: `${zoom}px` }}>
          <div className="epg-tl-hours" aria-hidden>
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} style={{ top: h * zoom }}>{h === 0 ? '00:00' : `${p2(h)}:00`}</span>
            ))}
          </div>

          <div className="epg-tl-col"
            onMouseMove={e => { if ((e.target as HTMLElement).closest('.epg-tl-block')) { setHover(null); return } setHover(snapAt(e.clientY, e.currentTarget)) }}
            onMouseLeave={() => setHover(null)}
            onClick={e => { if ((e.target as HTMLElement).closest('.epg-tl-block, .epg-tl-gap')) return; onAdd(hhmmOf(snapAt(e.clientY, e.currentTarget))) }}>

            {gaps.map(g => (
              <button key={g.s} type="button" className="epg-tl-gap"
                style={{ top: y(g.s), height: Math.max(18, y(g.e) - y(g.s)) }}
                onClick={e => onAdd(hhmmOf(Math.max(g.s - dayStart, snapAt(e.clientY, e.currentTarget.parentElement as HTMLElement))))}
                title={`Nothing scheduled ${fmtT(g.s)} to ${fmtT(g.e)}. The ${ownerWord}'s own guide entry shows. Click to add a programme at that time.`}>
                <span>Gap {fmtT(g.s)} to {fmtT(g.e)} · {fmtDur(g.e - g.s)}</span>
                {y(g.e) - y(g.s) >= 34 && <span className="sub">+ Add programme</span>}
              </button>
            ))}

            {placed.map(x => {
              const top = y(x.s)
              const h = Math.max(15, y(x.e) - top - 1)
              const p = x.p
              const live = x.rawS <= now && now < x.rawE
              const past = x.rawE <= now
              const overlaps = overlapsById.get(p.id)
              const v = vod[p.id]
              const vt = v ? VOD_TAG[v.state] : undefined
              const contPrev = x.rawS < dayStart
              const contNext = x.rawE > dayEnd
              const time = `${fmtT(x.rawS)}${contPrev ? ' (prev. day)' : ''} to ${fmtT(x.rawE)}${contNext ? ' (next day)' : ''}`
              const tight = h < 34
              const cls = ['epg-tl-block', live ? 'live' : past ? 'past' : 'upcoming', overlaps ? 'overlap' : '', tight ? 'tight' : '', contPrev ? 'cont-prev' : '', contNext ? 'cont-next' : ''].filter(Boolean).join(' ')
              const tags: { label: string; color: string; title?: string }[] = []
              if (live) tags.push({ label: 'On now', color: 'var(--live)' })
              if (p.series_id) tags.push({ label: 'Repeats', color: 'var(--muted)', title: 'Part of a recurring series' })
              if (p.geo_mode !== 'worldwide') tags.push({
                label: `${p.geo_mode === 'allow' ? 'Only' : 'Not'} ${p.geo_countries.slice(0, 3).join(' ')}${p.geo_countries.length > 3 ? '…' : ''}`.trim(),
                color: 'var(--warn,#e2b64f)', title: p.geo_mode === 'allow' ? 'Allow-list' : 'Block-list',
              })
              if (p.replacement_kind !== 'none') tags.push({ label: `Replaced: ${p.replacement_kind}`, color: 'var(--down,#f87171)', title: p.replacement_ref ?? undefined })
              if (vt) tags.push(vt)
              if (overlaps) tags.push({ label: overlaps.length === 1 ? `Overlaps "${overlaps[0]}"` : `Overlaps ${overlaps.length}`, color: 'var(--warn,#e2b64f)' })
              const w = 100 / x.lanes
              return (
                <button key={p.id} type="button" className={cls}
                  style={{ top, height: h, left: `calc(${x.lane * w}% + 6px)`, width: `calc(${w}% - 12px)` }}
                  onClick={() => onEdit(p)} onMouseEnter={() => setHover(null)}
                  title={`${p.title}\n${time} · ${fmtDur(x.rawE - x.rawS)}${p.metadata?.description ? `\n${p.metadata.description}` : ''}`}>
                  <div className="row1">
                    <b>{p.title}</b>
                    {tight && <span className="t">{fmtT(x.rawS)}</span>}
                    {tight && live && <span className="dot" aria-label="On now" />}
                  </div>
                  {!tight && <div className="t">{time} · {fmtDur(x.rawE - x.rawS)}</div>}
                  {!tight && h >= 54 && tags.length > 0 && (
                    <div className="tags">
                      {tags.map(t => <span key={t.label} className="tl-tag" title={t.title} style={{ color: t.color, borderColor: `color-mix(in srgb, ${t.color} 45%, transparent)` }}>{t.label}</span>)}
                    </div>
                  )}
                  {!tight && h >= 92 && p.metadata?.description && <div className="desc">{p.metadata.description}</div>}
                </button>
              )
            })}

            {hover != null && (
              <div className="epg-tl-ghost" style={{ top: hover * pxPerMs }} aria-hidden>
                <span>+ {hhmmOf(hover)}</span>
              </div>
            )}
            {isToday && <div className="cal-now" style={{ top: y(now) }} aria-label={`Now, ${fmtT(now)}`} />}
          </div>
        </div>
      </div>
    </div>
  )
}
