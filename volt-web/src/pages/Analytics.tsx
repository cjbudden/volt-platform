import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type AnalyticsOverview } from '../api'

/* ============================================================================
   ANALYTICS

   Every figure here is read from the daily rollups, never from raw play
   sessions. That is deliberate and it is the whole point of the retention
   split: raw events age out, reports do not. A page that quietly reached into
   play_sessions would work perfectly until the first prune and then start
   under-reporting history with no visible failure.

   CHART CHOICES, in the order they were made.

   FORM FIRST. Views and unique viewers over time are change-over-time on the
   same scale, so they share one line chart. Peak concurrency is a different
   measure at a different scale, so it gets its own chart rather than a second
   y-axis: two scales on one frame is the most common way a chart lies.
   Device and country are one dimension's magnitude, not competing series, so
   they are bars in a single hue ordered by size.

   COLOUR LAST, and validated rather than eyeballed. The categorical hues are a
   set checked for lightness band, chroma, colourblind separation and contrast
   against this app's panel surface. The app's green, amber and red are STATUS
   colours and are not reused as series colours — a viewer who has learned that
   red means trouble should not meet red as "the third country".

   AN UNSEALED DAY IS DRAWN AS UNFINISHED. Today is a partial day, and a chart
   that renders it like any other invites someone to read a half-day as a fall.
   ========================================================================== */

/** Validated against the panel surface: lightness band, chroma, CVD separation
 *  and contrast all pass. Distinct from the status trio on purpose. */
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'] as const

const GRID = 'rgba(255,255,255,.07)'
const AXIS_TEXT = 'var(--faint)'

function fmtInt(n: number) { return n.toLocaleString() }
function fmtDayShort(day: string) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString([], { day: '2-digit', month: 'short' })
}

// ---------------------------------------------------------------------------
//  A stat tile. Not a chart: when the answer is one number, one number is the
//  right form and a sparkline beside it is decoration.
// ---------------------------------------------------------------------------
function Stat({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: string
}) {
  return (
    <div style={{ minWidth: 132 }}>
      <div style={{
        fontSize: 'var(--fs-micro)', color: 'var(--faint)',
        textTransform: 'uppercase', letterSpacing: 'var(--ls-label)', marginBottom: 4,
      }}>{label}</div>
      <div style={{
        fontSize: 'var(--fs-h1)', lineHeight: 1.1, color: tone ?? 'var(--text)',
        fontVariantNumeric: 'tabular-nums',
      }}>{value}</div>
      {sub && <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Line chart with a crosshair. Interactive by default: an HTML chart that
//  cannot be interrogated is a picture of data.
// ---------------------------------------------------------------------------
interface Series { key: string; label: string; color: string; values: number[] }

function LineChart({ days, series, height = 200, format = fmtInt, unsealedFrom }: {
  days: string[]
  series: Series[]
  height?: number
  format?: (n: number) => string
  /** Index from which days are not final. Drawn dashed, and said in words. */
  unsealedFrom?: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [w, setW] = useState(760)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const PAD = { l: 52, r: 14, t: 10, b: 24 }
  const iw = Math.max(80, w - PAD.l - PAD.r)
  const ih = height - PAD.t - PAD.b

  const max = Math.max(1, ...series.flatMap(s => s.values))
  // A round top so the axis reads in whole numbers rather than "1,437".
  const step = Math.pow(10, Math.floor(Math.log10(max)))
  const top = Math.ceil(max / step) * step
  const x = (i: number) => PAD.l + (days.length <= 1 ? iw / 2 : (i / (days.length - 1)) * iw)
  const y = (v: number) => PAD.t + ih - (v / top) * ih

  const ticks = [0, 0.5, 1].map(f => Math.round(top * f))
  // Enough labels to read, few enough not to collide.
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(iw / 70))))

  function path(vals: number[], from = 0, to = vals.length - 1) {
    let d = ''
    for (let i = from; i <= to; i++) d += `${i === from ? 'M' : 'L'}${x(i).toFixed(1)},${y(vals[i]).toFixed(1)}`
    return d
  }

  const split = unsealedFrom != null && unsealedFrom > 0 && unsealedFrom < days.length
    ? unsealedFrom - 1 : null

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <svg width="100%" height={height} role="img"
        onMouseLeave={() => setHover(null)}
        onMouseMove={e => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const px = e.clientX - r.left
          if (days.length <= 1) { setHover(0); return }
          const i = Math.round(((px - PAD.l) / iw) * (days.length - 1))
          setHover(Math.max(0, Math.min(days.length - 1, i)))
        }}>
        {/* recessive grid: present, never competing with the data */}
        {ticks.map(t => (
          <g key={t}>
            <line x1={PAD.l} x2={PAD.l + iw} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end"
              fill={AXIS_TEXT} fontSize={10.5} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {format(t)}
            </text>
          </g>
        ))}
        {/* The first and last labels anchor inward: a centred label at either
            end of the plot hangs past the frame and gets clipped. */}
        {days.map((d, i) => (i % labelEvery === 0 ? (
          <text key={d} x={x(i)} y={height - 6}
            textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}
            fill={AXIS_TEXT} fontSize={10.5}>
            {fmtDayShort(d)}
          </text>
        ) : null))}

        {series.map(s => (
          <g key={s.key}>
            {/* Days that are final: a solid 2px line. */}
            <path d={path(s.values, 0, split ?? days.length - 1)} fill="none"
              stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {/* Days that can still change: dashed, so nobody quotes a partial
                day as a trend. */}
            {split != null && (
              <path d={path(s.values, split, days.length - 1)} fill="none"
                stroke={s.color} strokeWidth={2} strokeDasharray="3 3"
                strokeLinejoin="round" strokeLinecap="round" />
            )}
          </g>
        ))}

        {hover != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + ih}
              stroke="rgba(255,255,255,.28)" strokeWidth={1} />
            {series.map(s => (
              <circle key={s.key} cx={x(hover)} cy={y(s.values[hover])} r={4.5}
                fill={s.color} stroke="var(--panel)" strokeWidth={2} />
            ))}
          </>
        )}
      </svg>

      {hover != null && (
        <div style={{
          position: 'absolute', pointerEvents: 'none',
          left: Math.min(Math.max(0, x(hover) - 88), Math.max(0, w - 186)),
          top: 4, width: 186,
          background: 'var(--panel-3)', border: '1px solid var(--border-2)',
          borderRadius: 6, padding: '6px 8px', fontSize: 'var(--fs-sm)',
        }}>
          <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-micro)', marginBottom: 3 }}>
            {fmtDayShort(days[hover])}
            {unsealedFrom != null && hover >= unsealedFrom && ' · not final'}
          </div>
          {series.map(s => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flex: 'none' }} />
              <span style={{ flex: 1, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{s.label}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{format(s.values[hover])}</span>
            </div>
          ))}
        </div>
      )}

      {/* Identity is never colour alone: the legend is always there for two or
          more series, and each entry is named. */}
      {series.length > 1 && (
        <div className="flex flex-wrap items-center gap-4" style={{ marginTop: 6 }}>
          {series.map(s => (
            <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
              <span style={{ width: 10, height: 2.5, borderRadius: 2, background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
//  A magnitude list. One dimension, ordered by size: bars in ONE hue, because
//  the categories are not competing identities and colouring them separately
//  would imply a meaning that is not there.
// ---------------------------------------------------------------------------
function BarList({ title, data, empty, format = fmtInt }: {
  title: string
  data: Record<string, number>
  empty: string
  format?: (n: number) => string
}) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 8)
  const max = Math.max(1, ...rows.map(r => r[1]))
  return (
    <div>
      <div className="sec-label">{title}</div>
      {rows.length === 0 ? (
        <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>{empty}</div>
      ) : rows.map(([k, v]) => (
        <div key={k} style={{ marginBottom: 8 }}>
          <div className="flex items-baseline gap-2" style={{ fontSize: 'var(--fs-sm)', marginBottom: 3 }}>
            <span style={{ flex: 1, color: 'var(--muted)' }}>{k}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{format(v)}</span>
          </div>
          <div style={{ height: 6, background: 'var(--panel-2)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              width: `${(v / max) * 100}%`, height: '100%',
              background: SERIES[0], borderRadius: 3,
            }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
export default function AnalyticsPage() {
  const [d, setD] = useState<AnalyticsOverview | null>(null)
  const [days, setDays] = useState(30)
  const [err, setErr] = useState('')
  const [live, setLive] = useState<number | null>(null)

  async function load(n = days) {
    try { setD(await api.analyticsOverview(n)); setErr('') } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load(days) /* eslint-disable-next-line */ }, [days])

  // Concurrency is a NOW figure and goes stale in seconds, so it is polled
  // rather than left sitting at whatever it was when the page opened.
  useEffect(() => {
    let dead = false
    const tick = async () => {
      try { const r = await api.analyticsRealtime(); if (!dead) setLive(r.total_concurrent) } catch { /* */ }
    }
    tick()
    const h = setInterval(tick, 15000)
    return () => { dead = true; clearInterval(h) }
  }, [])

  const chart = useMemo(() => {
    if (!d) return null
    const dayLabels = d.daily.map(x => x.day)
    const firstUnsealed = d.daily.findIndex(x => !x.sealed)
    return {
      dayLabels,
      unsealedFrom: firstUnsealed >= 0 ? firstUnsealed : undefined,
      audience: [
        { key: 'views', label: 'Views', color: SERIES[0], values: d.daily.map(x => x.views) },
        { key: 'uniques', label: 'Unique viewers', color: SERIES[1], values: d.daily.map(x => x.uniques) },
      ],
      concurrent: [
        { key: 'peak', label: 'Peak concurrent', color: SERIES[5], values: d.daily.map(x => x.peakConcurrent) },
      ],
    }
  }, [d])

  if (err && !d) return <div className="err">{err}</div>
  if (!d || !chart) return <div className="loading">Loading analytics…</div>

  const nothing = d.totals.views === 0 && d.daily.length === 0

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>Read from the daily rollups, so it keeps answering after the raw events age out.</p>
        </div>
        <div className="spacer" />
        <div className="flex items-center gap-2">
          {[7, 30, 90].map(n => (
            <button key={n} className={`btn ${days === n ? 'primary' : 'ghost'}`}
              style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }}
              onClick={() => setDays(n)}>{n} days</button>
          ))}
          <button className="btn ghost" onClick={() => load()}>Refresh</button>
        </div>
      </div>
      {err && <div className="err">{err}</div>}

      <div className="card p-4" style={{ marginBottom: 16 }}>
        <div className="flex flex-wrap gap-6">
          <Stat label="Watching now" value={fmtInt(live ?? d.liveConcurrent)}
            sub={d.liveStreams.length ? `${d.liveStreams.length} stream${d.liveStreams.length === 1 ? '' : 's'}` : 'nothing live'}
            tone={(live ?? d.liveConcurrent) > 0 ? 'var(--ok,#4ade80)' : undefined} />
          <Stat label={`Views · ${days}d`} value={fmtInt(d.totals.views)} />
          <Stat label="Unique viewers" value={fmtInt(d.totals.uniques)} />
          <Stat label="Watch hours" value={fmtInt(d.totals.watchHours)} />
          <Stat label="Peak concurrent" value={fmtInt(d.totals.peakConcurrent)} />
          {d.totals.blocked > 0 && (
            <Stat label="Blocked" value={fmtInt(d.totals.blocked)}
              sub="geo or access rules" tone="var(--warn,#fbbf24)" />
          )}
        </div>
      </div>

      {nothing ? (
        <div className="empty">
          <h3>No audience data yet</h3>
          <p>Figures appear once something has been watched. Playback is recorded
             per session and rolled up daily; the reports here read the rollups.</p>
        </div>
      ) : (
        <>
          <div className="card p-4" style={{ marginBottom: 16 }}>
            <div className="flex items-baseline gap-3">
              <div className="sec-label" style={{ marginBottom: 0 }}>Audience</div>
              {chart.unsealedFrom !== undefined && (
                <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-micro)' }}>
                  dashed days are not final yet
                </span>
              )}
            </div>
            <LineChart days={chart.dayLabels} series={chart.audience}
              unsealedFrom={chart.unsealedFrom} height={220} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div className="card p-4">
              {/* Its OWN chart, not a second axis on the one above. Concurrency
                  and view counts are different measures at different scales, and
                  sharing a frame would make one of them meaningless. */}
              <div className="sec-label">Peak concurrent</div>
              <LineChart days={chart.dayLabels} series={chart.concurrent}
                unsealedFrom={chart.unsealedFrom} height={160} />
            </div>
            <div className="card p-4">
              <BarList title="By device" data={d.byDevice} empty="No device breakdown yet." />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div className="card p-4">
              <BarList title="By country" data={d.byGeo} empty="No geography yet." />
            </div>
            <div className="card p-4">
              <BarList title="By app" data={d.byApp} empty="No app breakdown yet." />
            </div>
          </div>

          <div className="card">
            <div style={{ padding: '12px 14px 0' }}>
              <div className="sec-label">Most watched</div>
            </div>
            <table>
              <thead><tr><th>What</th><th>Kind</th><th>Views</th><th>Watch hours</th><th>Peak concurrent</th></tr></thead>
              <tbody>
                {d.top.map(t => (
                  <tr key={`${t.kind}:${t.id}`}>
                    <td><b>{t.name}</b></td>
                    <td style={{ color: 'var(--muted)' }}>{t.kind}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtInt(t.views)}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>{fmtInt(t.watchHours)}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}>{fmtInt(t.peakConcurrent)}</td>
                  </tr>
                ))}
                {d.top.length === 0 && (
                  <tr><td colSpan={5} style={{ color: 'var(--faint)' }}>
                    Nothing has been watched in this window.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}
