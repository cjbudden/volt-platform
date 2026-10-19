import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as RKeyboardEvent, MouseEvent as RMouseEvent, PointerEvent as RPointerEvent } from 'react'
import {
  api, type EpgOwner, type ProgrammeRow, type ProgrammeVod,
  type TimelineGridBlock, type TimelineGridRow,
} from './api'
import { navigate } from './router'
import { StatusPill } from './scaffold'
import { Segmented } from './listFilters'
import { subscribeLive } from './liveStatus'
import { useNotify } from './notices'
import { ProgrammeDrawer } from './pages/EpgDetail'

/* ============================================================================
   TIMELINE GRID: Past · Now · Next, the Live Streams page's third view.

   Every stream the user can see is one row on a shared clock. Left of the
   current-time line is what went to air (programmes that aired, with the media
   actually recorded underneath and gaps hatched), the programme on now
   straddles the line, and what is scheduled sits to the right as outlined
   blocks. TIMELINE_MODE.md is the spec; this is phase 1, read-only.

   ONE REQUEST PER WINDOW, NOT PER ROW. Everything comes from
   GET /api/timeline/grid, which composes the EPG, coverage and health services
   on the server. The window fetched is wider than the window shown, so panning
   inside it costs nothing; leaving it fetches again.

   STATUS IS THE SERVER'S. Pills come from the grid's five-gate roll-up and are
   refreshed from the shared status stream (one socket for the whole console)
   by re-reading the Live board, never by computing state here and never by
   polling the grid.

   The engine state is the same two numbers every Volt timeline uses:
   {startMs, msPerPx}. No timeline library.
   ========================================================================== */

const MIN = 60_000
const HOUR = 3_600_000
const MAX_FETCH_MS = 48 * HOUR
const MIN_SPAN_MS = 30 * MIN
const LABEL_W = 248
const ROW_H = 48
const HEAD_H = 34
const OVERSCAN = 6

const PRESETS = [
  { value: '1-2', label: '−1h / +2h', back: 1, ahead: 2 },
  { value: '2-4', label: '−2h / +4h', back: 2, ahead: 4 },
  { value: '6-6', label: '−6h / +6h', back: 6, ahead: 6 },
  { value: '12-12', label: '−12h / +12h', back: 12, ahead: 12 },
] as const
type PresetId = typeof PRESETS[number]['value']
const DEFAULT_PRESET: PresetId = '2-4'

const KIND_LABEL: Record<string, string> = { channel: 'TV', radio: 'Radio', event: 'Event', loop: 'Loop' }
const KIND_CLS: Record<string, string> = { channel: 'chan', radio: 'radio', event: 'event', loop: 'loop' }
/** Trouble first inside a group: the Board's rule. */
const TROUBLE: Record<string, number> = { error: 0, degraded: 1 }

const LS = {
  preset: 'volt.live.timeline.preset',
  pins: 'volt.live.timeline.pins',
  pinnedFirst: 'volt.live.timeline.pinnedFirst',
  collapsed: 'volt.live.timeline.collapsed',
}
function readLs<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v) as T } catch { return fallback }
}
function writeLs(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* a per-viewer nicety only */ }
}

const p2 = (n: number) => String(n).padStart(2, '0')
const fmtT = (ms: number) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}` }
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
function fmtDur(ms: number) {
  const m = Math.round(ms / MIN)
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`
}
const TICK_STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720].map(m => m * MIN)

type Item =
  | { type: 'group'; key: string; name: string; count: number; trouble: number; top: number }
  | { type: 'row'; key: string; row: TimelineGridRow; top: number }

function ownerOf(r: TimelineGridRow): EpgOwner {
  return { kind: r.kind === 'event' ? 'event' : r.kind === 'radio' ? 'radio' : 'channel', id: r.id }
}

export default function TimelineGrid() {
  const notify = useNotify()

  // ---- the clock -----------------------------------------------------------
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])

  // ---- the view: {startMs, msPerPx}, plus where "now" sits while following --
  const [preset, setPreset] = useState<PresetId>(() => {
    const v = readLs<string>(LS.preset, DEFAULT_PRESET)
    return (PRESETS.some(p => p.value === v) ? v : DEFAULT_PRESET) as PresetId
  })
  const presetDef = PRESETS.find(p => p.value === preset)!
  const [spanMs, setSpanMs] = useState(() => (presetDef.back + presetDef.ahead) * HOUR)
  /** Following: the window rides along with now, keeping now at this offset. */
  const [follow, setFollow] = useState(true)
  const [backMs, setBackMs] = useState(presetDef.back * HOUR)
  const [manualStart, setManualStart] = useState(() => Date.now() - presetDef.back * HOUR)
  const startMs = follow ? now - backMs : manualStart

  const scroller = useRef<HTMLDivElement>(null)
  const [trackW, setTrackW] = useState(800)
  const [viewH, setViewH] = useState(480)
  const [scrollTop, setScrollTop] = useState(0)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => { setTrackW(Math.max(200, el.clientWidth - LABEL_W)); setViewH(el.clientHeight) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const msPerPx = spanMs / trackW
  const endMs = startMs + spanMs
  const xOf = useCallback((t: number) => (t - startMs) / msPerPx, [startMs, msPerPx])

  function applyPreset(id: PresetId) {
    const p = PRESETS.find(x => x.value === id)!
    setPreset(id); writeLs(LS.preset, id)
    setSpanMs((p.back + p.ahead) * HOUR); setBackMs(p.back * HOUR); setFollow(true)
  }
  /** Recentre on now at the preset's offset. */
  function recentre() { setBackMs(presetDef.back * HOUR * (spanMs / ((presetDef.back + presetDef.ahead) * HOUR))); setFollow(true) }
  function panBy(ms: number) { setManualStart(startMs + ms); setFollow(false) }
  function zoom(factor: number) {
    const next = Math.min(MAX_FETCH_MS, Math.max(MIN_SPAN_MS, spanMs * factor))
    if (next === spanMs) return
    // Keep the centre where it is, or keep now where it is while following.
    if (follow) setBackMs(backMs * (next / spanMs))
    else setManualStart(startMs + (spanMs - next) / 2)
    setSpanMs(next)
  }

  // ---- data: a buffered window, all pages ---------------------------------
  const [rows, setRows] = useState<TimelineGridRow[] | null>(null)
  const [fetched, setFetched] = useState<{ from: number; to: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const reqId = useRef(0)

  const load = useCallback(async (visFrom: number, visTo: number) => {
    const span = visTo - visFrom
    const pad = Math.max(0, Math.min(span / 2, (MAX_FETCH_MS - span) / 2))
    const from = Math.round(visFrom - pad), to = Math.round(visTo + pad)
    const id = ++reqId.current
    setLoading(true)
    try {
      const all: TimelineGridRow[] = []
      let cursor: string | undefined
      // 50 rows a page; ten pages is far beyond any fleet this view is for.
      for (let i = 0; i < 10; i++) {
        const page = await api.timelineGrid({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), cursor })
        if (id !== reqId.current) return
        all.push(...page.rows)
        if (!page.next) break
        cursor = page.next
      }
      setRows(all); setFetched({ from, to }); setErr('')
    } catch (e: any) {
      if (id === reqId.current) setErr(e.message)
    } finally {
      if (id === reqId.current) setLoading(false)
    }
  }, [])

  // Refetch only when the visible window leaves what was fetched, debounced so
  // a drag does not fire a request per pixel.
  useEffect(() => {
    if (fetched && startMs >= fetched.from && endMs <= fetched.to) return
    const t = setTimeout(() => load(startMs, endMs), fetched ? 250 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.floor(startMs / MIN), Math.floor(endMs / MIN), fetched, load])
  const reload = () => load(startMs, endMs)

  // ---- live state from the shared status stream ----------------------------
  const [liveState, setLiveState] = useState<Record<string, string>>({})
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let dead = false
    const refresh = () => {
      if (timer) return
      timer = setTimeout(async () => {
        timer = null
        try {
          const b = await api.liveBoard()
          if (!dead) setLiveState(Object.fromEntries(b.streams.map(s => [s.id, s.overall])))
        } catch { /* the grid's own roll-up stays on screen */ }
      }, 600)
    }
    const off = subscribeLive('*', (m) => { if (m.type === 'status' || m.type === 'event' || m.type === 'resync') refresh() })
    return () => { dead = true; off(); if (timer) clearTimeout(timer) }
  }, [])
  const stateOf = (r: TimelineGridRow) => liveState[r.id] ?? r.status.state

  // ---- grouping, pins, trouble first ---------------------------------------
  const [pins, setPins] = useState<string[]>(() => readLs<string[]>(LS.pins, []))
  const [pinnedFirst, setPinnedFirst] = useState<boolean>(() => readLs<boolean>(LS.pinnedFirst, true))
  const [collapsed, setCollapsed] = useState<string[]>(() => readLs<string[]>(LS.collapsed, []))
  const togglePin = (id: string) => setPins(p => { const n = p.includes(id) ? p.filter(x => x !== id) : [...p, id]; writeLs(LS.pins, n); return n })
  const toggleGroup = (k: string) => setCollapsed(c => { const n = c.includes(k) ? c.filter(x => x !== k) : [...c, k]; writeLs(LS.collapsed, n); return n })
  useEffect(() => { writeLs(LS.pinnedFirst, pinnedFirst) }, [pinnedFirst])

  const items = useMemo<{ list: Item[]; height: number }>(() => {
    if (!rows) return { list: [], height: 0 }
    const pinSet = new Set(pins)
    const groups = new Map<string, { name: string; rows: TimelineGridRow[] }>()
    const pinned: TimelineGridRow[] = []
    for (const r of rows) {
      if (pinnedFirst && pinSet.has(r.id)) { pinned.push(r); continue }
      const k = r.groupId ?? 'none'
      if (!groups.has(k)) groups.set(k, { name: r.groupName ?? 'No group', rows: [] })
      groups.get(k)!.rows.push(r)
    }
    // The server orders by group then name; only trouble moves, as on the Board.
    const order = (list: TimelineGridRow[]) => list
      .map((r, i) => ({ r, i }))
      .sort((a, b) => (TROUBLE[stateOf(a.r)] ?? 9) - (TROUBLE[stateOf(b.r)] ?? 9) || a.i - b.i)
      .map(x => x.r)
    const sections = [
      ...(pinned.length ? [{ key: 'pinned', name: 'Pinned', rows: order(pinned) }] : []),
      ...[...groups.entries()].map(([key, g]) => ({ key, name: g.name, rows: order(g.rows) })),
    ]
    const list: Item[] = []
    let top = 0
    for (const s of sections) {
      list.push({ type: 'group', key: `g:${s.key}`, name: s.name, count: s.rows.length,
        trouble: s.rows.filter(r => TROUBLE[stateOf(r)] != null).length, top })
      top += HEAD_H
      if (collapsed.includes(s.key)) continue
      for (const r of s.rows) { list.push({ type: 'row', key: `${s.key}:${r.id}`, row: r, top }); top += ROW_H }
    }
    return { list, height: top }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, pins, pinnedFirst, collapsed, liveState])

  // Simple windowing: only rows in (or near) the viewport are rendered.
  const visible = useMemo(() => {
    const lo = scrollTop - OVERSCAN * ROW_H, hi = scrollTop + viewH + OVERSCAN * ROW_H
    return items.list.filter(it => it.top + (it.type === 'group' ? HEAD_H : ROW_H) >= lo && it.top <= hi)
  }, [items, scrollTop, viewH])

  // ---- drag the ruler to pan -------------------------------------------------
  const drag = useRef<{ x: number; start: number } | null>(null)
  function onRulerDown(e: RPointerEvent<HTMLDivElement>) {
    drag.current = { x: e.clientX, start: startMs }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onRulerMove(e: RPointerEvent<HTMLDivElement>) {
    if (!drag.current) return
    setManualStart(drag.current.start - (e.clientX - drag.current.x) * msPerPx)
    setFollow(false)
  }
  function onRulerUp() { drag.current = null }

  // ---- keyboard --------------------------------------------------------------
  function onKey(e: RKeyboardEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement
    if (t.closest('input, select, textarea, .drawer, [role="dialog"]')) return
    const step = spanMs * (e.shiftKey ? 0.5 : 0.1)
    if (e.key === 'ArrowLeft') { panBy(-step); e.preventDefault() }
    else if (e.key === 'ArrowRight') { panBy(step); e.preventDefault() }
    else if (e.key === '+' || e.key === '=') { zoom(1 / 1.5); e.preventDefault() }
    else if (e.key === '-' || e.key === '_') { zoom(1.5); e.preventDefault() }
    else if (e.key === 'n' || e.key === 'N') { recentre(); e.preventDefault() }
  }

  // ---- click-through ---------------------------------------------------------
  const [drawer, setDrawer] = useState<{ owner: EpgOwner; day: Date; p: ProgrammeRow; vod?: ProgrammeVod } | null>(null)
  const [converting, setConverting] = useState(false)

  /** Past: the recording workbench at that moment. */
  function openPast(r: TimelineGridRow, at: number) {
    const rec = r.recordings.find(x => Date.parse(x.start) <= at && (x.end == null || at < Date.parse(x.end)))
    navigate(rec ? `/recordings/${rec.id}?t=${Math.round(at)}` : r.links.workbench)
  }
  /** Future: the programme drawer the EPG pages use. */
  async function openFuture(r: TimelineGridRow, b: TimelineGridBlock) {
    if (b.source !== 'epg') { navigate(r.links.detail); return }
    const owner = ownerOf(r)
    try {
      const [list, vod] = await Promise.all([
        api.epgProgrammes(owner, b.scheduledStart, b.scheduledEnd),
        api.epgVodStatus(owner, b.scheduledStart, b.scheduledEnd).then(x => x.programmes).catch(() => ({} as Record<string, ProgrammeVod>)),
      ])
      const p = list.find(x => x.id === b.id)
      if (!p) { notify({ kind: 'error', message: 'That programme has changed since the timeline loaded. Refreshing.' }); reload(); return }
      const day = new Date(p.starts_at); day.setHours(0, 0, 0, 0)
      setDrawer({ owner, day, p, vod: vod[p.id] })
    } catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }
  function openBlock(e: RMouseEvent<HTMLButtonElement>, r: TimelineGridRow, b: TimelineGridBlock) {
    e.stopPropagation()
    const s = Date.parse(b.start), en = Date.parse(b.end)
    // A pointer click lands at a time; Enter on a focused block has no position.
    const rect = e.currentTarget.getBoundingClientRect()
    const at = e.detail > 0 ? s + (e.clientX - rect.left) * msPerPx : Math.max(s, startMs)
    if (s <= now && now < en) navigate(r.links.detail)
    else if (en <= now) openPast(r, Math.min(at, en - 1))
    else openFuture(r, b)
  }
  function onTrackClick(e: RMouseEvent<HTMLDivElement>, r: TimelineGridRow) {
    const rect = e.currentTarget.getBoundingClientRect()
    const at = startMs + (e.clientX - rect.left) * msPerPx
    if (at < now - MIN) openPast(r, at)
    else if (at <= now + MIN) navigate(r.links.detail)
  }
  async function convert() {
    if (!drawer) return
    setConverting(true)
    try { await api.convertProgramme(drawer.p.id); notify({ kind: 'ok', message: 'Conversion started' }); setDrawer(null); reload() }
    catch (e: any) { notify({ kind: 'error', message: e.message }) }
    finally { setConverting(false) }
  }

  // ---- the ruler -------------------------------------------------------------
  const ticks = useMemo(() => {
    const step = TICK_STEPS.find(s => s / msPerPx >= 72) ?? TICK_STEPS[TICK_STEPS.length - 1]
    const off = new Date(startMs).getTimezoneOffset() * MIN
    const first = Math.ceil((startMs - off) / step) * step + off
    const out: { t: number; day: boolean }[] = []
    for (let t = first; t <= endMs; t += step) {
      const d = new Date(t)
      out.push({ t, day: d.getHours() === 0 && d.getMinutes() === 0 })
    }
    return out
  }, [startMs, endMs, msPerPx])

  const nowX = xOf(now)
  const nowVisible = nowX >= 0 && nowX <= trackW

  // ---- render ----------------------------------------------------------------
  function renderRow(r: TimelineGridRow) {
    const state = stateOf(r)
    const pinned = pins.includes(r.id)
    const inView = (s: number, e: number) => e > startMs && s < endMs
    const clampX = (t: number) => Math.max(-2, Math.min(trackW + 2, xOf(t)))
    return (
      <div className="tlg-row" role="row">
        <div className="tlg-label" role="rowheader">
          <button type="button" className="tlg-name" onClick={() => navigate(r.links.detail)} title={`Open ${r.name}`}>{r.name}</button>
          <div className="tlg-meta">
            <span className={`tag type ${KIND_CLS[r.kind] ?? 'chan'}`}>{KIND_LABEL[r.kind] ?? r.kind}</span>
            <StatusPill state={state} />
          </div>
          <button type="button" className={`icon-btn tlg-pin${pinned ? ' on' : ''}`} aria-pressed={pinned}
            aria-label={pinned ? `Unpin ${r.name}` : `Pin ${r.name}`} title={pinned ? 'Unpin' : 'Pin to the top'}
            onClick={() => togglePin(r.id)}>
            <svg viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"><path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z" /></svg>
          </button>
        </div>
        <div className="tlg-track" role="gridcell" onClick={e => onTrackClick(e, r)}>
          {r.media.gaps.filter(g => inView(Date.parse(g.start), Date.parse(g.end))).map(g => {
            const s = Date.parse(g.start), e = Date.parse(g.end)
            return <div key={`g${s}`} className="tlg-gap" style={{ left: clampX(s), width: Math.max(1, clampX(e) - clampX(s)) }}
              title={`No media ${fmtT(s)} to ${fmtT(e)} · ${fmtDur(e - s)}`} />
          })}
          {r.media.runs.filter(m => inView(Date.parse(m.start), Date.parse(m.end))).map(m => {
            const s = Date.parse(m.start), e = Date.parse(m.end)
            return <div key={`m${s}`} className="tlg-run" style={{ left: clampX(s), width: Math.max(1, clampX(e) - clampX(s)) }}
              title={`Recorded ${fmtT(s)} to ${fmtT(e)}`} />
          })}
          {r.programmes.filter(b => inView(Date.parse(b.start), Date.parse(b.end))).map(b => {
            const s = Date.parse(b.start), e = Date.parse(b.end)
            const when = e <= now ? 'past' : s <= now ? 'now' : 'next'
            const left = clampX(s), w = Math.max(3, clampX(e) - left - 1)
            const verb = when === 'past' ? 'Open the recording' : when === 'now' ? 'Open the stream' : 'Open the programme'
            return (
              <button key={b.id} type="button" className={`tlg-block ${when}`} style={{ left, width: w }}
                onClick={ev => openBlock(ev, r, b)}
                title={`${b.title}\n${fmtT(s)} to ${fmtT(e)} · ${fmtDur(e - s)}${b.asRun ? ' · as run' : ''}\n${verb}`}>
                {w > 34 && <span className="tlg-bt">{b.title}</span>}
                {w > 110 && <span className="tlg-bs">{fmtT(s)}</span>}
              </button>
            )
          })}
          {r.clips.filter(c => inView(Date.parse(c.start), Date.parse(c.start) + 1)).map(c => (
            <span key={c.id} className="tlg-clip" style={{ left: xOf(Date.parse(c.start)) }} title={`Clip${c.title ? `: ${c.title}` : ''} at ${fmtT(Date.parse(c.start))}`} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="tlg card" onKeyDown={onKey}>
      <div className="tlg-bar">
        <Segmented label="Window" value={preset} onChange={applyPreset}
          options={PRESETS.map(p => ({ value: p.value, label: p.label }))} />
        <button type="button" className="btn ghost" onClick={recentre} disabled={follow} title="Recentre on now (N)">Now</button>
        <label className="tlg-check">
          <input type="checkbox" checked={pinnedFirst} onChange={e => setPinnedFirst(e.target.checked)} /> Pinned first
        </label>
        <span className="tlg-hint">Drag the ruler or use ← → to move, + and − to zoom, N for now</span>
        <span className="tlg-status">{loading ? 'Loading…' : rows ? `${rows.length} stream${rows.length === 1 ? '' : 's'}` : ''}</span>
        <button type="button" className="btn ghost" onClick={reload}>Refresh</button>
      </div>

      {err && <div className="tlg-err">Couldn't load the timeline: {err} <button type="button" className="btn ghost" onClick={reload}>Retry</button></div>}

      <div className="tlg-ruler" style={{ width: LABEL_W + trackW }}>
        <div className="tlg-ruler-l">{fmtDay(startMs)}</div>
        <div className="tlg-ruler-t" role="group" tabIndex={0}
          aria-label={`Time window ${fmtT(startMs)} to ${fmtT(endMs)}. Drag, or use the arrow keys to move, plus and minus to zoom, N for now.`}
          onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp} onPointerCancel={onRulerUp}>
          {ticks.map(k => (
            <span key={k.t} className={`tlg-tick${k.day ? ' day' : ''}`} style={{ left: xOf(k.t) }}>
              {k.day ? fmtDay(k.t) : fmtT(k.t)}
            </span>
          ))}
          {nowVisible && <span className="tlg-now-flag" style={{ left: nowX }}>{fmtT(now)}</span>}
        </div>
      </div>

      <div className="tlg-scroll" ref={scroller} role="grid" aria-label="Streams on a shared clock"
        onScroll={e => setScrollTop(e.currentTarget.scrollTop)}>
        {rows && rows.length === 0 && !loading && (
          <div className="tlg-empty">No streams you can see have anything in this window.</div>
        )}
        <div className="tlg-inner" style={{ height: items.height }}>
          {visible.map(it => (
            <div key={it.key} className="tlg-item" style={{ top: it.top, height: it.type === 'group' ? HEAD_H : ROW_H }}>
              {it.type === 'group' ? (
                <button type="button" className="tlg-group" aria-expanded={!collapsed.includes(it.key.slice(2))}
                  onClick={() => toggleGroup(it.key.slice(2))}>
                  <svg className="tlg-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 6l6 6-6 6" /></svg>
                  <span className="tlg-gname">{it.name}</span>
                  <span className="tlg-gcount">{it.count}</span>
                  {it.trouble > 0 && <StatusPill state="error" label={`${it.trouble} need attention`} />}
                </button>
              ) : renderRow(it.row)}
            </div>
          ))}
          {nowVisible && items.height > 0 && <div className="tlg-now" style={{ left: LABEL_W + nowX }} aria-hidden />}
        </div>
      </div>

      {drawer && (
        <ProgrammeDrawer owner={drawer.owner} day={drawer.day} programme={drawer.p} vod={drawer.vod}
          converting={converting} onConvert={convert}
          onClose={() => setDrawer(null)}
          onDone={(msg) => { setDrawer(null); if (msg) notify({ kind: 'ok', message: msg }); reload() }} />
      )}
    </div>
  )
}
