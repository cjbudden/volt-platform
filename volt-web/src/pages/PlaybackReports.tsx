import { useEffect, useMemo, useState } from 'react'
import { apiRequest } from '../api'
import { PageError, usePageNotice } from '../notices'
import { AnalyticsViewSwitch } from './OperatingReports'

/* ============================================================================
   PLAYBACK EXPERIENCE  (QOE_REPORTING.md, build queue 1.14e)

   The third view under Analytics: what each viewer actually saw, from the
   Volt SDK's CMCD v2 reports. Six reports on one page (playback success,
   startup, buffering, quality, engagement, telemetry health), every one
   filtered by the same bar, plus the worst segments of any dimension so a bad
   device or app release stands out instead of being averaged away.

   Everything comes from GET /api/analytics/qoe/* (modules/qoe.ts), which
   reads the separate analytics database. The definitions behind each number
   are one click away, as the design asks.
   ========================================================================== */

type Trio = { p50: number | null; p95: number | null; p99: number | null }
export interface QoeOverview {
  definitions: number; from: string; to: string
  success: { attempts: number; sessions: number; started: number; startupSuccess: number | null; startupFailures: number; startupFailureRate: number | null; failedSessions: number
    exitsBeforeFirstFrame: number; ebffRate: number | null; ebffByWait: Record<string, number>; fatalAfterStart: number; failureAfterStartRate: number | null; fatalAfterSessions: number
    errors: Array<{ phase: string; step: string | null; code: string | null; views: number; sessions: number }> }
  startup: { views: number; startup: Trio; slowSessions: number; breakdown: Array<Trio & { span: string; views: number; avg: number | null }> }
  buffering: { views: number; viewsWithStalls: number; viewsWithStallsRate: number | null; stalledSessions: number; stalls: number; rebufferRatio: number | null; stallsPerHour: number | null
    avgStallMs: number | null; timeToFirstStall: Trio; rebufferRatioPerView: Trio; seeks: number; avgSeekMs: number | null }
  quality: { views: number; timeWeightedKbps: number | null; perViewKbps: Record<string, number | null>; timeAtBitrate: Array<{ band: string; share: number }>; belowScreenShare: number | null
    switchesPerHour: number | null; oscillationsPerHour: number | null; avgBufferMs: number | null; avgThroughputKbps: number | null }
  engagement: { views: number; sessions: number; started: number; playingHours: number; avgPlayingMs: number | null; ebffRate: number | null; exitAfterStall: number; exitAfterError: number
    leftAfterStallShare: number | null; byContent: Array<{ contentId: string | null; name: string | null; views: number; started: number; playingHours: number; stalledShare: number | null; leftAfterProblem: number }> }
  telemetry: { views: number; reports: number; eventLoss: number | null; missingReports: number; viewsWithLoss: number; viewsWithoutSequence: number; lateReports: number; lateShare: number | null
    clockSkewMs: Trio; unknownKeys: Array<{ key: string; reports: number }>; collector: { accepted: number; rejected: number; rejectedShare: number | null; reasons: Record<string, number> } }
}
interface Series { bucketMs: number; ignoredFilters: string[]; points: Array<{ at: string; attempts: number; starts: number; failures: number; stalls: number; startupP50: number | null; startupP95: number | null; rebufferRatio: number | null }> }
interface Breakdown { label: string; rows: Array<{ value: string | null; name?: string | null; views: number; sessions: number; affected: number; measure: number | null }> }

// The filter bar: the dimensions people reach for first. The API takes all of section 6.
const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'content_id', label: 'Content' }, { key: 'stream_type', label: 'Live or on demand' }, { key: 'device_class', label: 'Device class' },
  { key: 'device_model', label: 'Device model' }, { key: 'os', label: 'OS' }, { key: 'browser', label: 'Browser' },
  { key: 'app_name', label: 'App' }, { key: 'app_version', label: 'App version' }, { key: 'sdk_version', label: 'SDK version' },
  { key: 'codec', label: 'Codec' }, { key: 'cdn', label: 'CDN' }, { key: 'country', label: 'Country' }, { key: 'region', label: 'Region' },
  { key: 'asn', label: 'Network (ASN)' }, { key: 'network', label: 'Connection' },
]
const MEASURES: Array<{ key: string; label: string; kind: 'rate' | 'ms' | 'kbps' }> = [
  { key: 'failure', label: 'Startup failure rate', kind: 'rate' }, { key: 'ebff', label: 'Exit before first frame', kind: 'rate' },
  { key: 'fatal', label: 'Failure after start', kind: 'rate' }, { key: 'stalls', label: 'Views with stalls', kind: 'rate' },
  { key: 'rebuffer', label: 'Rebuffer ratio', kind: 'rate' }, { key: 'startup_p95', label: 'Startup time p95', kind: 'ms' },
  { key: 'bitrate', label: 'Time-weighted bitrate', kind: 'kbps' },
]
const PERIODS = [{ h: 1, label: '1 hour' }, { h: 24, label: '24 hours' }, { h: 24 * 7, label: '7 days' }, { h: 24 * 30, label: '30 days' }]

const fmtInt = (n: number | null | undefined) => (n == null ? '–' : n.toLocaleString())
const fmtPct = (r: number | null | undefined, d = 1) => (r == null ? '–' : `${(r * 100).toFixed(r > 0 && r < 0.001 ? 3 : d)}%`)
const fmtMs = (ms: number | null | undefined) => (ms == null ? '–' : ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`)
const fmtKbps = (k: number | null | undefined) => (k == null ? '–' : k >= 1000 ? `${(k / 1000).toFixed(2)} Mbps` : `${Math.round(k)} kbps`)
const fmtRate = (x: number | null | undefined) => (x == null ? '–' : x.toFixed(x >= 10 ? 0 : 2))
const fmtMeasure = (kind: string, v: number | null) => (kind === 'rate' ? fmtPct(v, 2) : kind === 'ms' ? fmtMs(v) : fmtKbps(v))
const valueLabel = (v: string | null) => (v == null || v === '' ? 'Not reported' : v === 'l' ? 'Live' : v === 'll' ? 'Live (low latency)' : v === 'v' ? 'On demand' : v)

/** Small line icons beside each report's title (the house style: an icon with the text, never alone). */
const Ic = {
  play: <path d="M8 5v14l11-7z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  pause: <><path d="M3 12h3l3-8 4 16 3-8h5" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6" /></>,
  pulse: <><path d="M4 12h4l2-5 4 10 2-5h4" /></>,
  filter: <path d="M4 5h16l-6 8v5l-4 2v-7z" />,
  bars: <><path d="M5 20V10M12 20V4M19 20v-7" /></>,
}
function Icon({ d }: { d: React.ReactNode }) {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none', color: 'var(--muted)' }}>{d}</svg>
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: 'var(--ls-label)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 'var(--fs-h2, 20px)', lineHeight: 1.15, color: tone ?? 'var(--text)', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{value}</div>
      {sub && <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}
const statGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 16 }

function Report({ icon, title, question, children }: { icon: React.ReactNode; title: string; question: string; children: React.ReactNode }) {
  return (
    <section className="card p-4" style={{ marginBottom: 16, minWidth: 0 }} aria-label={title}>
      <div className="flex items-center gap-2" style={{ marginBottom: 4 }}><Icon d={icon} /><h3 style={{ margin: 0 }}>{title}</h3></div>
      <p style={{ margin: '0 0 14px', color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{question}</p>
      {children}
    </section>
  )
}

function Bars({ data }: { data: Array<{ label: string; share: number }> }) {
  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 14 }}>
      {data.map((d) => (
        <div key={d.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 140px) 1fr 56px', gap: 8, alignItems: 'center', fontSize: 'var(--fs-sm)' }}>
          <span style={{ color: 'var(--muted)' }}>{d.label}</span>
          <span style={{ height: 8, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${Math.min(100, d.share * 100)}%`, background: 'var(--brand)' }} />
          </span>
          <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtPct(d.share, 0)}</span>
        </div>
      ))}
    </div>
  )
}

/** Attempts per bucket with the startup p95 line: enough to see a spike, not a charting library. */
function Trend({ s }: { s: Series }) {
  const w = 640, h = 120, pts = s.points
  if (pts.length < 2) return <p style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', margin: 0 }}>Not enough data for a trend in this period yet.</p>
  const maxA = Math.max(1, ...pts.map((p) => p.attempts)), maxS = Math.max(1, ...pts.map((p) => p.startupP95 ?? 0))
  const x = (i: number) => (i / (pts.length - 1)) * (w - 8) + 4
  const line = (vals: Array<number | null>, max: number) => vals.map((v, i) => (v == null ? '' : `${i === 0 || vals[i - 1] == null ? 'M' : 'L'}${x(i).toFixed(1)},${(h - 6 - (v / max) * (h - 16)).toFixed(1)}`)).join(' ')
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label="Attempts and startup time p95 over the period">
        <path d={line(pts.map((p) => p.attempts), maxA)} fill="none" stroke="var(--brand)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <path d={line(pts.map((p) => p.startupP95), maxS)} fill="none" stroke="var(--warn)" strokeWidth="2" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex flex-wrap gap-3" style={{ fontSize: 'var(--fs-micro)', color: 'var(--muted)' }}>
        <span><span style={{ display: 'inline-block', width: 12, height: 2, background: 'var(--brand)', verticalAlign: 'middle', marginRight: 6 }} />Play attempts (peak {fmtInt(maxA)})</span>
        <span><span style={{ display: 'inline-block', width: 12, height: 2, background: 'var(--warn)', verticalAlign: 'middle', marginRight: 6 }} />Startup time p95 (peak {fmtMs(maxS)})</span>
        {s.ignoredFilters.length > 0 && <span>The trend is not filtered by {s.ignoredFilters.join(', ')}: minute data keeps content, live or on demand, country, device class and CDN.</span>}
      </div>
    </div>
  )
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<React.ReactNode>> }) {
  return (
    <div style={{ overflowX: 'auto', marginTop: 14 }}>
      <table>
        <thead><tr>{head.map((x) => <th key={x}>{x}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={j ? { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } : undefined}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

export default function PlaybackReports() {
  const [hours, setHours] = useState(24)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [d, setD] = useState<QoeOverview | null>(null)
  const [series, setSeries] = useState<Series | null>(null)
  const [dims, setDims] = useState<Record<string, Array<{ value: string | null; views: number }>>>({})
  const [defs, setDefs] = useState<any>(null)
  const [by, setBy] = useState('device_model')
  const [measure, setMeasure] = useState('failure')
  const [minViews, setMinViews] = useState(20)
  const [bd, setBd] = useState<Breakdown | null>(null)
  const [err, setErr] = useState('')

  const qs = useMemo(() => {
    const p = new URLSearchParams({ hours: String(hours) })
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v)
    return p.toString()
  }, [hours, filters])

  async function load() {
    try {
      const [o, s] = await Promise.all([apiRequest(`/analytics/qoe/overview?${qs}`), apiRequest(`/analytics/qoe/series?${qs}`)])
      setD(o); setSeries(s); setErr('')
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [qs])
  useEffect(() => { apiRequest(`/analytics/qoe/dimensions?hours=${hours}`).then(setDims).catch(() => {}) }, [hours])
  useEffect(() => { apiRequest('/analytics/qoe/definitions').then(setDefs).catch(() => {}) }, [])
  useEffect(() => {
    apiRequest(`/analytics/qoe/breakdown?${qs}&by=${by}&measure=${measure}&minViews=${minViews}`).then(setBd).catch(() => setBd(null))
  }, [qs, by, measure, minViews])

  usePageNotice('qoe', err && d ? { kind: 'error', title: "Couldn't load playback reports.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)
  if (err && !d) return <PageError message={err} onRetry={() => load()} />
  if (!d) return <div className="loading">Loading playback reports…</div>

  const s = d.success, st = d.startup, b = d.buffering, q = d.quality, e = d.engagement, t = d.telemetry
  const m = MEASURES.find((x) => x.key === measure)!
  const active = Object.entries(filters).filter(([, v]) => v)
  const nothing = s.attempts === 0 && e.views === 0

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>What viewers actually saw, from the player's own reports. Counted per play attempt, from the moment play is pressed.</p>
        </div>
        <div className="spacer" />
        <div className="flex flex-wrap items-center gap-2">
          <AnalyticsViewSwitch view="playback" />
          {PERIODS.map((p) => (
            <button key={p.h} className={`btn ${hours === p.h ? 'primary' : 'ghost'}`} style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }} onClick={() => setHours(p.h)}>{p.label}</button>
          ))}
          <button className="btn ghost" onClick={() => load()}>Refresh</button>
        </div>
      </div>

      <section className="card p-4" style={{ marginBottom: 16 }} aria-label="Filters">
        <div className="flex items-center gap-2" style={{ marginBottom: 10 }}><Icon d={Ic.filter} /><h3 style={{ margin: 0 }}>Filters</h3>
          <div className="spacer" />
          {active.length > 0 && <button className="btn ghost" style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }} onClick={() => setFilters({})}>Clear filters</button>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
          {FILTERS.map((f) => {
            const vals = dims[f.key] ?? []
            return (
              <label key={f.key} style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-sm)', color: 'var(--muted)', minWidth: 0 }}>
                {f.label}
                <select value={filters[f.key] ?? ''} onChange={(ev) => setFilters({ ...filters, [f.key]: ev.target.value })} disabled={!vals.length && !filters[f.key]} style={{ minWidth: 0 }}>
                  <option value="">All</option>
                  {vals.map((v) => <option key={v.value ?? '__none'} value={v.value ?? '__none'}>{valueLabel(v.value)} ({fmtInt(v.views)})</option>)}
                </select>
              </label>
            )
          })}
        </div>
      </section>

      {nothing ? (
        <div className="card p-4" style={{ marginBottom: 16 }}>
          <h3>No playback reports in this period{active.length ? ' for these filters' : ''}</h3>
          <p style={{ color: 'var(--muted)', margin: 0 }}>Players built on the Volt SDK with <code>cmcd</code> on send their reports to <code>POST /api/cmcd</code>. They appear here within a minute.</p>
        </div>
      ) : (
        <>
          {series && <section className="card p-4" style={{ marginBottom: 16 }} aria-label="Trend"><Trend s={series} /></section>}

          <Report icon={Ic.play} title="Playback success" question="Can viewers actually watch?">
            <div style={statGrid}>
              <Stat label="Play attempts" value={fmtInt(s.attempts)} sub={`${fmtInt(s.sessions)} sessions`} />
              <Stat label="Startup success" value={fmtPct(s.startupSuccess)} sub={`${fmtInt(s.started)} reached a first frame`} tone={s.startupSuccess != null && s.startupSuccess < 0.95 ? 'var(--warn)' : undefined} />
              <Stat label="Startup failures" value={fmtPct(s.startupFailureRate)} sub={`${fmtInt(s.startupFailures)} attempts, ${fmtInt(s.failedSessions)} sessions`} tone={s.startupFailures ? 'var(--down)' : undefined} />
              <Stat label="Exit before first frame" value={fmtPct(s.ebffRate)} sub={`${fmtInt(s.exitsBeforeFirstFrame)} left without an error`} />
              <Stat label="Failure after start" value={fmtPct(s.failureAfterStartRate)} sub={`${fmtInt(s.fatalAfterStart)} of the started views`} tone={s.fatalAfterStart ? 'var(--down)' : undefined} />
            </div>
            {s.exitsBeforeFirstFrame > 0 && <Bars data={[
              { label: 'Left within 2 s', share: s.ebffByWait.under2s / s.exitsBeforeFirstFrame }, { label: '2 to 5 s', share: s.ebffByWait.from2to5s / s.exitsBeforeFirstFrame },
              { label: '5 to 10 s', share: s.ebffByWait.from5to10s / s.exitsBeforeFirstFrame }, { label: 'After 10 s', share: s.ebffByWait.over10s / s.exitsBeforeFirstFrame },
            ]} />}
            {s.errors.length > 0 && <Table head={['When', 'Step', 'Code', 'Views', 'Sessions']} rows={s.errors.map((x) => [x.phase === 'before_start' ? 'Before the first frame' : 'After the start', x.step ?? '–', <code key="c">{x.code ?? '–'}</code>, fmtInt(x.views), fmtInt(x.sessions)])} />}
          </Report>

          <Report icon={Ic.clock} title="Startup" question="Why does playback start slowly? Play pressed to the first frame on screen, for the views that started.">
            <div style={statGrid}>
              <Stat label="p50" value={fmtMs(st.startup.p50)} sub={`${fmtInt(st.views)} views`} />
              <Stat label="p95" value={fmtMs(st.startup.p95)} />
              <Stat label="p99" value={fmtMs(st.startup.p99)} />
              <Stat label="Waited 2 s or more" value={fmtInt(st.slowSessions)} sub="sessions" />
            </div>
            <Table head={['Step', 'p50', 'p95', 'p99', 'Average', 'Views']} rows={st.breakdown.map((x) => [x.span === 'drm' ? 'DRM licence' : x.span === 'segment' ? 'First segment' : x.span[0].toUpperCase() + x.span.slice(1), fmtMs(x.p50), fmtMs(x.p95), fmtMs(x.p99), fmtMs(x.avg), fmtInt(x.views)])} />
          </Report>

          <Report icon={Ic.pause} title="Buffering and interruptions" question="How often is viewing interrupted? Startup, seeking, pauses and background time are left out.">
            <div style={statGrid}>
              <Stat label="Views with stalls" value={fmtPct(b.viewsWithStallsRate)} sub={`${fmtInt(b.viewsWithStalls)} views, ${fmtInt(b.stalledSessions)} sessions`} tone={b.viewsWithStalls ? 'var(--warn)' : undefined} />
              <Stat label="Rebuffer ratio" value={fmtPct(b.rebufferRatio, 2)} sub={`per view p95 ${fmtPct(b.rebufferRatioPerView.p95, 2)}`} />
              <Stat label="Stalls per hour" value={fmtRate(b.stallsPerHour)} sub={`${fmtInt(b.stalls)} stalls, average ${fmtMs(b.avgStallMs)}`} />
              <Stat label="Time to first stall" value={fmtMs(b.timeToFirstStall.p50)} sub={`p50; p95 ${fmtMs(b.timeToFirstStall.p95)}`} />
              <Stat label="Seek delay" value={fmtMs(b.avgSeekMs)} sub={`average over ${fmtInt(b.seeks)} seeks`} />
            </div>
          </Report>

          <Report icon={Ic.layers} title="Quality and adaptive bitrate" question="Is the player choosing a quality it can sustain?">
            <div style={statGrid}>
              <Stat label="Time-weighted bitrate" value={fmtKbps(q.timeWeightedKbps)} sub={`per view p50 ${fmtKbps(q.perViewKbps.p50)}`} />
              <Stat label="Below what the screen can use" value={fmtPct(q.belowScreenShare)} sub="of playing time" />
              <Stat label="Switches per hour" value={fmtRate(q.switchesPerHour)} sub={`oscillations ${fmtRate(q.oscillationsPerHour)} per hour`} />
              <Stat label="Buffer and throughput" value={q.avgBufferMs == null ? '–' : fmtMs(q.avgBufferMs)} sub={`average; throughput ${fmtKbps(q.avgThroughputKbps)}`} />
            </div>
            {q.timeAtBitrate.length > 0 && <Bars data={q.timeAtBitrate.map((x) => ({ label: x.band, share: x.share }))} />}
          </Report>

          <Report icon={Ic.users} title="Engagement and abandonment" question="How does quality relate to retention? Views counted by when they started.">
            <div style={statGrid}>
              <Stat label="Playing time" value={`${e.playingHours >= 10 ? Math.round(e.playingHours).toLocaleString() : e.playingHours.toFixed(2)} h`} sub={`average ${fmtMs(e.avgPlayingMs)} per started view`} />
              <Stat label="Left after a stall" value={fmtInt(e.exitAfterStall)} sub={`${fmtPct(e.leftAfterStallShare)} of the views that stalled`} tone={e.exitAfterStall ? 'var(--warn)' : undefined} />
              <Stat label="Left after an error" value={fmtInt(e.exitAfterError)} sub="within 30 s" />
              <Stat label="Exit before first frame" value={fmtPct(e.ebffRate)} />
            </div>
            {e.byContent.length > 0 && <Table head={['Content', 'Views', 'Playing hours', 'Stalled', 'Left after a problem']} rows={e.byContent.map((c) => [c.name ?? valueLabel(c.contentId), fmtInt(c.views), c.playingHours.toFixed(2), fmtPct(c.stalledShare), fmtInt(c.leftAfterProblem)])} />}
          </Report>

          <Report icon={Ic.bars} title="Worst segments" question="Which device, app release, network or place is worse than the rest? Only values with enough views to mean something are ranked.">
            <div className="flex flex-wrap items-end gap-3">
              <label style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>By
                <select value={by} onChange={(ev) => setBy(ev.target.value)}>{FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>Ranked by
                <select value={measure} onChange={(ev) => setMeasure(ev.target.value)}>{MEASURES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>At least
                <select value={minViews} onChange={(ev) => setMinViews(Number(ev.target.value))}>{[1, 10, 20, 100, 1000].map((x) => <option key={x} value={x}>{x} views</option>)}</select>
              </label>
            </div>
            {bd && bd.rows.length > 0
              ? <Table head={[FILTERS.find((f) => f.key === by)?.label ?? by, m.label, 'Views', 'Sessions affected']} rows={bd.rows.map((r) => [r.name ?? valueLabel(r.value), fmtMeasure(m.kind, r.measure), fmtInt(r.views), fmtInt(r.affected)])} />
              : <p style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', margin: '12px 0 0' }}>No value has {minViews} views or more in this period.</p>}
          </Report>

          <Report icon={Ic.pulse} title="Telemetry health" question="Can these numbers be trusted? Reports lost, late or refused, and keys the collector does not know.">
            <div style={statGrid}>
              <Stat label="Reports lost" value={fmtPct(t.eventLoss, 2)} sub={`${fmtInt(t.missingReports)} missing in ${fmtInt(t.viewsWithLoss)} views`} tone={t.eventLoss != null && t.eventLoss > 0.01 ? 'var(--warn)' : undefined} />
              <Stat label="Late reports" value={fmtPct(t.lateShare, 2)} sub={`${fmtInt(t.lateReports)} arrived over 60 s after they were made`} />
              <Stat label="Refused by the collector" value={fmtPct(t.collector.rejectedShare, 2)} sub={`${fmtInt(t.collector.rejected)} of ${fmtInt(t.collector.accepted + t.collector.rejected)} lines`} />
              <Stat label="Device clock skew" value={fmtMs(t.clockSkewMs.p50)} sub={`p50; p95 ${fmtMs(t.clockSkewMs.p95)}`} />
              <Stat label="Without a sequence" value={fmtInt(t.viewsWithoutSequence)} sub="views (players other than the Volt SDK)" />
            </div>
            {(Object.keys(t.collector.reasons).length > 0 || t.unknownKeys.length > 0) && (
              <Table head={['What', 'Count']} rows={[
                ...Object.entries(t.collector.reasons).map(([k, v]) => [`Refused: ${k}`, fmtInt(v)]),
                ...t.unknownKeys.map((k) => [<span key={k.key}>Unknown key <code>{k.key}</code></span>, fmtInt(k.reports)]),
              ]} />
            )}
          </Report>
        </>
      )}

      {defs && (
        <details className="card p-4" style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer' }}>How these are measured (definitions version {defs.version})</summary>
          <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{defs.view} {defs.windows} {defs.states}</p>
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, max-content) minmax(0, 1fr)', gap: '6px 16px', fontSize: 'var(--fs-sm)', margin: 0 }}>
            {Object.entries(defs.measures as Record<string, string>).map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}><dt style={{ color: 'var(--text)' }}>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt><dd style={{ margin: 0, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{v}</dd></div>
            ))}
          </dl>
        </details>
      )}
    </>
  )
}
