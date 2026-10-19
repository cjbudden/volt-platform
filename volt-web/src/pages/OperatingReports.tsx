import { useEffect, useMemo, useState } from 'react'
import { api, type OpQuery, type OpReport, type OpStop, type OpStreamKind, type OpSummary } from '../api'
import { navigate, useRoute } from '../router'
import { PageError, usePageNotice } from '../notices'

/* ============================================================================
   OPERATING REPORTS  (docs/REQ_stream_reporting.md)

   Analytics answers "who watched". This answers "what ran, for how long, how
   long was it on air, and why did it stop": the page a client with an SLA
   opens every month, and the one an operator opens after a bad night.

   Lives under Analytics as a second view rather than a new menu item: the
   left nav is already long and this is the same family of question.

   THREE RULES THE PAGE KEEPS, because the API keeps them:
     1. Not known is not zero. A peak outside the raw analytics window renders
        as "not retained", with the day's peak beside it, never as 0.
     2. Run time and air time are different numbers and are never merged.
     3. A fault and an operator stop look different at a glance.
   ========================================================================== */

const DAY = 86_400_000

// ---- formatting -------------------------------------------------------------
function fmtDur(sec: number | null | undefined): string {
  if (sec == null) return '–'
  if (sec < 60) return `${Math.round(sec)} s`
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60)
  if (h >= 100) return `${h.toLocaleString()} h`
  return h ? (m ? `${h} h ${m} m` : `${h} h`) : `${m} m`
}
const fmtHours = (h: number | null | undefined) => (h == null ? '–' : h >= 100 ? `${Math.round(h).toLocaleString()} h` : `${h.toFixed(1)} h`)
const fmtInt = (n: number | null | undefined) => (n == null ? '–' : n.toLocaleString())
const fmtPct = (p: number | null | undefined) => (p == null ? '–' : `${p.toFixed(p >= 99.95 || p === 0 ? 0 : 2)}%`)
function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '–'
  return new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// ---- the period ---------------------------------------------------------------
// Local calendar days, sent as ISO instants: "this month" means this month where
// the operator is sitting, which is what a client invoice means by it too.
type Preset = 'this_month' | 'last_month' | '7d' | '30d' | '90d' | 'custom'
const PRESETS: { key: Exclude<Preset, 'custom'>; label: string }[] = [
  { key: 'this_month', label: 'This month' }, { key: 'last_month', label: 'Last month' },
  { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }, { key: '90d', label: '90 days' },
]
function presetRange(p: Exclude<Preset, 'custom'>): { from: Date; to: Date } {
  const now = new Date()
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (p === 'this_month') return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(today0.getTime() + DAY) }
  if (p === 'last_month') return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 1) }
  const n = p === '7d' ? 7 : p === '30d' ? 30 : 90
  return { from: new Date(today0.getTime() - (n - 1) * DAY), to: new Date(today0.getTime() + DAY) }
}

/** Period and filters live in the URL so a report can be bookmarked and shared. */
function useReportParams() {
  const route = useRoute()
  void route
  const sp = new URLSearchParams(window.location.search)
  const preset = (sp.get('period') as Preset) || 'this_month'
  let from: Date, to: Date
  if (preset === 'custom' && sp.get('from') && sp.get('to')) {
    const [fy, fm, fd] = sp.get('from')!.split('-').map(Number)
    const [ty, tm, td] = sp.get('to')!.split('-').map(Number)
    from = new Date(fy, fm - 1, fd); to = new Date(new Date(ty, tm - 1, td).getTime() + DAY)
  } else ({ from, to } = presetRange(preset === 'custom' ? 'this_month' : preset))
  const kind = (sp.get('kind') as OpStreamKind | null) ?? ''
  const q = sp.get('q') ?? ''
  const sort = sp.get('sort') ?? '-hours_run'
  const set = (patch: Record<string, string | null>, base?: string) => {
    const next = new URLSearchParams(window.location.search)
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v) }
    const qs = next.toString()
    navigate(`${base ?? window.location.pathname}${qs ? '?' + qs : ''}`, { replace: true })
  }
  return { preset, from, to, kind, q, sort, set, query: { from: from.toISOString(), to: to.toISOString(), kind, q, sort } as OpQuery }
}

// ---- shared pieces -------------------------------------------------------------
export function AnalyticsViewSwitch({ view }: { view: 'audience' | 'operating' }) {
  return (
    <div className="seg-choice" role="tablist" aria-label="Analytics view">
      <button role="tab" aria-selected={view === 'audience'} className={view === 'audience' ? 'sel' : ''}
        onClick={() => navigate('/analytics')}>Audience</button>
      <button role="tab" aria-selected={view === 'operating'} className={view === 'operating' ? 'sel' : ''}
        onClick={() => navigate('/analytics/operating')}>Operating</button>
    </div>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={{ minWidth: 128 }}>
      <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: 'var(--ls-label)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 'var(--fs-h1)', lineHeight: 1.1, color: tone ?? 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

const KIND_LABEL: Record<OpStreamKind, string> = { channel: 'Channel', radio: 'Station', event: 'Event' }
const KIND_CLASS: Record<OpStreamKind, string> = { channel: 'chan', radio: 'radio', event: 'event' }
function KindTag({ kind }: { kind: OpStreamKind }) {
  return <span className={`tag type ${KIND_CLASS[kind]}`}>{KIND_LABEL[kind]}</span>
}

const STOP: Record<OpStop | 'running', { label: string; cls: string; why: string }> = {
  operator: { label: 'Operator', cls: 'idle', why: 'Stopped by a person. Planned.' },
  schedule: { label: 'Schedule', cls: 'sched', why: 'The scheduled window ended. Planned.' },
  fault: { label: 'Fault', cls: 'down', why: 'The stream failed. Unplanned.' },
  internal: { label: 'Platform', cls: 'idle', why: 'The platform restarted or moved it. Nobody decided to stop it.' },
  unknown: { label: 'Unknown', cls: 'warn', why: 'This run ended without the platform recording why, for example a lost server.' },
  running: { label: 'Running', cls: 'live', why: 'Still running.' },
}
function StopTag({ stop }: { stop: OpStop | null }) {
  const s = STOP[stop ?? 'running']
  return <span className={`tag ${s.cls}`} title={s.why}>{s.label}</span>
}

function PeriodBar({ p }: { p: ReturnType<typeof useReportParams> }) {
  const [f, setF] = useState(ymd(p.from))
  const [t, setT] = useState(ymd(new Date(p.to.getTime() - 1)))
  useEffect(() => { setF(ymd(p.from)); setT(ymd(new Date(p.to.getTime() - 1))) }, [p.from.getTime(), p.to.getTime()])
  return (
    <div className="flex flex-wrap items-center gap-2" style={{ minWidth: 0 }}>
      {PRESETS.map((x) => (
        <button key={x.key} className={`chip${p.preset === x.key ? ' active' : ''}`} style={{ padding: '5px 11px' }}
          onClick={() => p.set({ period: x.key, from: null, to: null })}>{x.label}</button>
      ))}
      <span className="flex flex-wrap items-center gap-2" style={{ marginLeft: 4 }}>
        <input className="inp" type="date" value={f} max={t} aria-label="From"
          onChange={(e) => { setF(e.target.value); if (e.target.value) p.set({ period: 'custom', from: e.target.value, to: t }) }} />
        <span style={{ color: 'var(--faint)' }}>to</span>
        <input className="inp" type="date" value={t} min={f} aria-label="To"
          onChange={(e) => { setT(e.target.value); if (e.target.value) p.set({ period: 'custom', from: f, to: e.target.value }) }} />
      </span>
    </div>
  )
}

// ============================================================================
//  The run strip: every run across the period, with the on-air time inside it.
//  Not a chart of a measure; a map of time. Faults end in a red tick so a crash
//  loop is visible as a pattern before anyone reads a number.
// ============================================================================
function RunStrip({ r }: { r: OpReport }) {
  const a = Date.parse(r.period.from), b = Date.parse(r.period.to)
  const span = Math.max(1, b - a)
  const x = (ms: number) => Math.max(0, Math.min(1000, ((ms - a) / span) * 1000))
  const ticks = useMemo(() => {
    const days = span / DAY
    const step = days <= 2 ? DAY / 4 : days <= 10 ? DAY : days <= 45 ? 7 * DAY : 30 * DAY
    const out: number[] = []
    const start = new Date(a); start.setHours(0, 0, 0, 0)
    for (let t = start.getTime(); t <= b; t += step) if (t >= a) out.push(t)
    return out.slice(0, 14)
  }, [a, b, span])
  return (
    <div>
      <svg viewBox="0 0 1000 54" width="100%" height="64" preserveAspectRatio="none" role="img"
        aria-label={`${r.totals.runs} runs and ${fmtDur(r.totals.on_air_seconds)} on air across the period`}>
        <rect x="0" y="10" width="1000" height="26" fill="var(--panel-2)" />
        {r.runs.map((run) => {
          const s = Date.parse(run.started_at), e = run.ended_at ? Date.parse(run.ended_at) : Date.now()
          const w = Math.max(1.5, x(e) - x(s))
          return (
            <g key={run.instance_id}>
              <rect x={x(s)} y="10" width={w} height="26" fill="var(--border-2)">
                <title>{`Run ${fmtWhen(run.started_at)} to ${run.ended_at ? fmtWhen(run.ended_at) : 'now'} · ${fmtDur(run.duration_seconds)} · ${STOP[run.stop ?? 'running'].label}`}</title>
              </rect>
              {run.stop === 'fault' && run.ended_at && <rect x={x(e) - 1} y="6" width="2.5" height="34" fill="var(--down)" />}
            </g>
          )
        })}
        {r.air_windows.map((w, i) => (
          <rect key={i} x={x(Date.parse(w.from))} y="16" width={Math.max(1.5, x(Date.parse(w.to)) - x(Date.parse(w.from)))} height="14" fill="var(--brand)">
            <title>{`On air ${fmtWhen(w.from)} to ${fmtWhen(w.to)}`}</title>
          </rect>
        ))}
        {ticks.map((t) => <line key={t} x1={x(t)} x2={x(t)} y1="36" y2="41" stroke="var(--faint)" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
      </svg>
      <div style={{ position: 'relative', height: 16, fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>
        {ticks.map((t) => (
          <span key={t} style={{ position: 'absolute', left: `${x(t) / 10}%`, whiteSpace: 'nowrap',
            // centred under its tick, except at the edges where centring would push it off the card
            transform: x(t) < 40 ? 'none' : x(t) > 960 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
            {new Date(t).toLocaleDateString([], { day: '2-digit', month: 'short' })}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-4" style={{ fontSize: 'var(--fs-micro)', color: 'var(--muted)', marginTop: 6 }}>
        <span className="flex items-center gap-2"><i style={{ width: 14, height: 10, background: 'var(--border-2)', display: 'inline-block' }} />Running</span>
        <span className="flex items-center gap-2"><i style={{ width: 14, height: 6, background: 'var(--brand)', display: 'inline-block' }} />On air</span>
        <span className="flex items-center gap-2"><i style={{ width: 3, height: 12, background: 'var(--down)', display: 'inline-block' }} />Ended in a fault</span>
      </div>
    </div>
  )
}

// ============================================================================
//  One stream
// ============================================================================
function StreamReportView({ id }: { id: string }) {
  const p = useReportParams()
  const [r, setR] = useState<OpReport | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try { setR(await api.operatingReport(id, p.query)); setErr('') } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { setR(null); load() /* eslint-disable-next-line */ }, [id, p.query.from, p.query.to])
  usePageNotice('op-load', err && r ? { kind: 'error', title: "Couldn't load the report.", message: err, actions: [{ label: 'Retry', onClick: load }] } : null)

  const back = () => {
    const sp = new URLSearchParams(window.location.search)
    navigate(`/analytics/operating${sp.toString() ? '?' + sp.toString() : ''}`)
  }
  if (err && !r) return <PageError message={err} onRetry={load} />
  if (!r) return <div className="loading">Loading report…</div>
  const t = r.totals
  const isRadio = r.stream.kind === 'radio'
  const hasCost = t.cost_basis_usd !== undefined
  const streamHref = r.stream.deleted ? null : r.stream.kind === 'event' ? `/events/${r.stream.id}` : r.stream.kind === 'radio' ? `/radio/${r.stream.id}` : `/channels/${r.stream.id}`

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb" style={{ marginBottom: 6 }}>
            <a href="/analytics/operating" style={{ color: 'var(--brand)', textDecoration: 'none' }}
              onClick={(e) => { e.preventDefault(); back() }}>Operating reports</a>
            &nbsp;/&nbsp; <b>{r.stream.name}</b>
          </div>
          <h1 className="flex items-center gap-3" style={{ flexWrap: 'wrap' }}>
            {r.stream.name} <KindTag kind={r.stream.kind} />
            {r.stream.deleted && <span className="tag idle" title="The stream was deleted. Its history is kept.">Deleted</span>}
          </h1>
          <p>Every run in the period, how long it was on air, and why it ended.</p>
        </div>
        <div className="spacer" />
        <div className="flex items-center gap-2">
          {streamHref && <button className="btn ghost" onClick={() => navigate(streamHref)}>Open {KIND_LABEL[r.stream.kind].toLowerCase()}</button>}
          <button className="btn primary" disabled={busy}
            onClick={async () => { setBusy(true); try { await api.downloadOperatingCsv(p.query, id) } catch (e: any) { setErr(e.message) } finally { setBusy(false) } }}>
            {busy ? 'Preparing…' : 'Download CSV'}
          </button>
        </div>
      </div>

      <div className="card p-4" style={{ marginBottom: 16 }}>
        <PeriodBar p={p} />
      </div>

      <div className="card p-4" style={{ marginBottom: 16 }}>
        <div className="flex flex-wrap gap-6">
          <Stat label="Hours run" value={fmtDur(t.run_seconds)} sub={`${t.runs} run${t.runs === 1 ? '' : 's'}`} />
          <Stat label="Hours on air" value={fmtDur(t.on_air_seconds)}
            sub={r.air_basis === 'public_window' ? 'run time inside the public window' : r.air_basis === 'none' ? 'not recorded' : 'from the on-air log'} />
          <Stat label="Availability" value={fmtPct(t.availability_pct)}
            sub={t.availability_window === 'period' ? 'on air over the period' : t.availability_window === 'public_window' ? 'of the public window' : t.availability_window === 'scheduled_window' ? 'of the scheduled window' : 'no expected window'} />
          <Stat label="Unplanned stops" value={fmtInt(t.stops.unplanned)}
            sub={`${t.stops.planned} planned${t.stops.unknown ? ` · ${t.stops.unknown} unknown` : ''}`}
            tone={t.stops.unplanned ? 'var(--down)' : undefined} />
          <Stat label="Time to recover" value={t.mttr_seconds == null ? '–' : fmtDur(t.mttr_seconds)}
            sub={t.unrecovered_faults ? `${t.unrecovered_faults} not recovered` : 'mean, after a fault'} />
          <Stat label="Peak concurrent" value={t.peak_concurrent == null ? 'not retained' : fmtInt(t.peak_concurrent)}
            sub={t.peak_basis === 'exact' ? (t.peak_at ? `at ${fmtWhen(t.peak_at)}` : 'exact') : t.peak_basis === 'daily' ? 'highest daily peak' : 'no audience data'} />
          <Stat label="Watch hours" value={t.watch_seconds == null ? '–' : fmtDur(t.watch_seconds)} sub={t.views != null ? `${fmtInt(t.views)} views` : undefined} />
          {hasCost && <Stat label="Cost basis" value={t.cost_basis_usd == null ? '–' : `$${t.cost_basis_usd.toFixed(2)}`} sub="platform view only" />}
        </div>
      </div>

      {r.runs.length > 0 && (
        <div className="card p-4" style={{ marginBottom: 16 }}>
          <div className="sec-label">Runs and air time</div>
          <RunStrip r={r} />
        </div>
      )}

      {r.notes.length > 0 && (
        <div className="note" style={{ marginBottom: 16 }}>
          {r.notes.map((n, i) => <div key={i}>{n}</div>)}
        </div>
      )}

      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr>
            <th>Started</th><th>Ended</th><th>Run</th><th>On air</th><th>Stop</th>
            <th>Peak</th><th>Views</th><th>Watch</th>
            {isRadio && <th title="MP3 relay listeners, a separate delivery path">MP3 listeners</th>}
            {hasCost && <th>Cost basis</th>}
          </tr></thead>
          <tbody>
            {r.runs.map((run) => {
              const a = run.audience
              const renamed = run.name_at_run && run.name_at_run !== r.stream.name
              return (
                <tr key={run.instance_id} style={{ cursor: 'default' }}>
                  <td className="nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {fmtWhen(run.started_at)}
                    {renamed && <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>as {run.name_at_run}</div>}
                  </td>
                  <td className="nowrap" style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>{run.running ? 'running' : fmtWhen(run.ended_at)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }} title={run.seconds_in_period !== run.duration_seconds ? `${fmtDur(run.duration_seconds)} in total, ${fmtDur(run.seconds_in_period)} inside this period` : undefined}>
                    {fmtDur(run.seconds_in_period)}
                    {run.seconds_in_period !== run.duration_seconds && <span style={{ color: 'var(--faint)' }}> of {fmtDur(run.duration_seconds)}</span>}
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums', color: run.on_air_seconds ? 'var(--text)' : 'var(--faint)' }}>{fmtDur(run.on_air_seconds)}</td>
                  <td>
                    <StopTag stop={run.stop} />
                    {run.stop_detail && run.stop === 'fault' && <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--muted)', marginTop: 3, maxWidth: 260 }}>{run.stop_detail}</div>}
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {a.peak_basis === 'not_retained'
                      ? <span title="The raw viewing sessions for this run have aged out of the account's analytics window, so its exact peak no longer exists. The day's peak is shown instead.">
                          <span style={{ color: 'var(--faint)' }}>not retained</span>
                          {a.day_peak_concurrent != null && <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--muted)' }}>day peak {fmtInt(a.day_peak_concurrent)}</div>}
                        </span>
                      : <span title={a.peak_at ? `at ${fmtWhen(a.peak_at)}` : undefined}>{fmtInt(a.peak_concurrent)}</span>}
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>{fmtInt(a.views)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>{a.watch_seconds == null ? '–' : fmtDur(a.watch_seconds)}</td>
                  {isRadio && <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>{run.listeners ? `${fmtInt(run.listeners.sessions)} · peak ${fmtInt(run.listeners.peak_concurrent)}` : '–'}</td>}
                  {hasCost && <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>{run.cost_basis_usd == null ? '–' : `$${run.cost_basis_usd.toFixed(2)}`}</td>}
                </tr>
              )
            })}
            {r.runs.length === 0 && (
              <tr><td colSpan={10} style={{ color: 'var(--faint)', cursor: 'default' }}>Nothing ran in this period.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ============================================================================
//  Every stream, for a period
// ============================================================================
const COLS: { key: string; label: string; num?: boolean; title?: string }[] = [
  { key: 'name', label: 'Stream' }, { key: 'runs', label: 'Runs', num: true },
  { key: 'hours_run', label: 'Hours run', num: true }, { key: 'hours_on_air', label: 'On air', num: true },
  { key: 'availability_pct', label: 'Availability', num: true, title: 'On-air time over the expected window: the period for a 24x7 channel or station, the public window for an event' },
  { key: 'unplanned_stops', label: 'Faults', num: true, title: 'Unplanned stops' },
  { key: 'mttr_seconds', label: 'Recover', num: true, title: 'Mean time from a fault to the next run' },
  { key: 'peak_concurrent', label: 'Peak', num: true }, { key: 'watch_hours', label: 'Watch hours', num: true },
]

function SummaryView() {
  const p = useReportParams()
  const [d, setD] = useState<OpSummary | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState(p.q)
  const load = async () => {
    try { setD(await api.operatingSummary(p.query)); setErr('') } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [p.query.from, p.query.to, p.kind, p.q, p.sort])
  useEffect(() => { const h = setTimeout(() => { if (q !== p.q) p.set({ q }) }, 300); return () => clearTimeout(h) /* eslint-disable-next-line */ }, [q])
  usePageNotice('op-load', err && d ? { kind: 'error', title: "Couldn't load operating reports.", message: err, actions: [{ label: 'Retry', onClick: load }] } : null)

  const hasCost = d?.totals.cost_basis_usd !== undefined
  const sortBy = (key: string) => {
    const cur = p.sort.replace(/^-/, '')
    const desc = p.sort.startsWith('-')
    p.set({ sort: cur === key ? (desc ? key : `-${key}`) : (key === 'name' ? key : `-${key}`) })
  }
  const arrow = (key: string) => (p.sort.replace(/^-/, '') === key ? (p.sort.startsWith('-') ? ' ↓' : ' ↑') : '')

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>What ran, for how long, how long it was on air, and why it stopped.</p>
        </div>
        <div className="spacer" />
        <div className="flex items-center gap-2">
          <AnalyticsViewSwitch view="operating" />
          <button className="btn primary" disabled={busy || !d}
            onClick={async () => { setBusy(true); try { await api.downloadOperatingCsv(p.query) } catch (e: any) { setErr(e.message) } finally { setBusy(false) } }}>
            {busy ? 'Preparing…' : 'Download CSV'}
          </button>
        </div>
      </div>

      <div className="card p-4" style={{ marginBottom: 16 }}>
        <div className="flex flex-wrap items-center gap-3" style={{ justifyContent: 'space-between' }}>
          <PeriodBar p={p} />
          <div className="flex flex-wrap items-center gap-2" style={{ minWidth: 0 }}>
            <div className="seg-choice" aria-label="Kind">
              {(['', 'channel', 'radio', 'event'] as const).map((k) => (
                <button key={k || 'all'} className={p.kind === k ? 'sel' : ''} onClick={() => p.set({ kind: k || null })}>
                  {k ? `${KIND_LABEL[k]}s` : 'All'}
                </button>
              ))}
            </div>
            <input className="inp" placeholder="Find a stream" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 150px', minWidth: 0, maxWidth: 220 }} />
          </div>
        </div>
      </div>

      {err && !d ? <PageError message={err} onRetry={load} /> : !d ? <div className="loading">Loading operating reports…</div> : (
        <>
          <div className="card p-4" style={{ marginBottom: 16 }}>
            <div className="flex flex-wrap gap-6">
              <Stat label="Streams" value={fmtInt(d.totals.streams)} sub="ran or were on air" />
              <Stat label="Hours run" value={fmtHours(d.totals.hours_run)} />
              <Stat label="Hours on air" value={fmtHours(d.totals.hours_on_air)} />
              <Stat label="Unplanned stops" value={fmtInt(d.totals.unplanned_stops)} tone={d.totals.unplanned_stops ? 'var(--down)' : undefined} />
              {hasCost && <Stat label="Cost basis" value={`$${(d.totals.cost_basis_usd ?? 0).toFixed(2)}`} sub="platform view only" />}
            </div>
          </div>

          {d.items.length === 0 ? (
            <div className="empty">
              <h3>Nothing ran in this period</h3>
              <p>Runs are read from the usage meter and air time from the on-air log. A stream appears here once it has run.</p>
            </div>
          ) : (
            <div className="card" style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr>
                  {COLS.map((c) => (
                    <th key={c.key} title={c.title} aria-sort={p.sort.replace(/^-/, '') === c.key ? (p.sort.startsWith('-') ? 'descending' : 'ascending') : 'none'}>
                      <button onClick={() => sortBy(c.key)} style={{ all: 'unset', cursor: 'pointer' }}>{c.label}{arrow(c.key)}</button>
                    </th>
                  ))}
                  {hasCost && <th><button onClick={() => sortBy('cost_basis_usd')} style={{ all: 'unset', cursor: 'pointer' }}>Cost basis{arrow('cost_basis_usd')}</button></th>}
                </tr></thead>
                <tbody>
                  {d.items.map((row) => (
                    <tr key={row.stream_id} onClick={() => navigate(`/analytics/operating/${row.stream_id}${window.location.search}`)}>
                      <td>
                        <div className="flex items-center gap-2">
                          <b>{row.name}</b> <KindTag kind={row.kind} />
                          {row.deleted && <span className="tag idle">Deleted</span>}
                        </div>
                      </td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtInt(row.runs)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtHours(row.hours_run)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtHours(row.hours_on_air)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtPct(row.availability_pct)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums', color: row.unplanned_stops ? 'var(--down)' : 'var(--faint)' }}>
                        {fmtInt(row.unplanned_stops)}{row.unknown_stops ? <span style={{ color: 'var(--warn)' }} title="Runs that ended without a recorded reason"> +{row.unknown_stops}?</span> : null}
                      </td>
                      <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>{row.mttr_seconds == null ? '–' : fmtDur(row.mttr_seconds)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }} title={row.peak_basis === 'daily' ? 'Highest daily peak: the exact figure is outside the raw analytics window' : undefined}>
                        {row.peak_concurrent == null ? <span style={{ color: 'var(--faint)' }}>–</span> : fmtInt(row.peak_concurrent)}{row.peak_basis === 'daily' ? <sup style={{ color: 'var(--faint)' }}> d</sup> : null}
                      </td>
                      <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>{fmtHours(row.watch_hours)}</td>
                      {hasCost && <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>{row.cost_basis_usd == null ? '–' : `$${row.cost_basis_usd.toFixed(2)}`}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  )
}

/** /analytics/operating and /analytics/operating/:id */
export default function OperatingReports() {
  const route = useRoute()
  const parts = route.path.replace(/^\/+|\/+$/g, '').split('/')
  const id = parts[2] ? decodeURIComponent(parts[2]) : null
  return id ? <StreamReportView key={id} id={id} /> : <SummaryView />
}
