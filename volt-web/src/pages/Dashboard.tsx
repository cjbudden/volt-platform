import { useEffect, useRef, useState } from 'react'
import {
  api, type LiveBoard, type MonitoringOverview, type AnalyticsOverview,
  type VodAssetRow, type FleetAlert,
} from '../api'
import { navigate } from '../router'
import { pressable } from '../a11y'

/* ============================================================================
   DASHBOARD — the first screen, and the one with the strongest temptation to
   become a junk drawer.

   The rule applied here: a dashboard is a ROUTER, not a report. Everything on
   it either tells you the system is fine or takes you to the page where you
   would fix it. Nothing here is the only place a number lives, and nothing
   here is meant to be studied. If a figure needs a paragraph to interpret it,
   it belongs on Analytics, not here.

   THE ORDER IS THE ARGUMENT. Reading down the page:

     1. Is anything broken?      — alerts, loudest first, or an explicit
                                   all-clear. This is the answer most people
                                   open the app for.
     2. What is on air?          — the live strip, with viewers now.
     3. How did the week go?     — a small trend, deliberately one sparkline
                                   and not a chart wall.
     4. What is waiting on me?   — review queue, recent output.

   THE ALL-CLEAR IS A FEATURE. A dashboard that renders nothing when the
   system is healthy trains people to distrust it ("is it loading?"). Saying
   "nothing needs attention" in words, with the checks named, is what makes
   the empty state read as an answer rather than a failure.
   ========================================================================== */

const OK = 'var(--live,#4ade80)'
const SEV_COLOR: Record<string, string> = {
  critical: '#f87171', serious: '#fb923c', warning: '#fbbf24',
}

function fmtInt(n: number) { return n.toLocaleString() }

function fmtAgo(iso: string | null | undefined) {
  if (!iso) return ''
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

// ---------------------------------------------------------------------------
function Tile({ label, value, sub, tone, onClick }: {
  label: string; value: string | number; sub?: string; tone?: string; onClick?: () => void
}) {
  return (
    <div {...pressable((e: any) => { ((onClick) as any)(e) })} data-a11y-click="" style={{ minWidth: 124, cursor: onClick ? 'pointer' : undefined }}>
      <div style={{
        fontSize: 'var(--fs-micro)', color: 'var(--faint)', textTransform: 'uppercase',
        letterSpacing: 'var(--ls-label)', marginBottom: 4,
      }}>{label}</div>
      <div style={{
        fontSize: 'var(--fs-h1)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums',
        color: tone ?? 'var(--text)',
      }}>{value}</div>
      {sub && <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
//  A sparkline, not a chart. It carries shape and nothing else: no axis, no
//  gridlines, no tooltip. Anyone who wants the numbers goes to Analytics, and
//  the link below it says so.
// ---------------------------------------------------------------------------
function Spark({ values, color = '#3987e5', h = 44 }: {
  values: number[]; color?: string; h?: number
}) {
  // The card is fluid, so the sparkline is measured rather than fixed: one
  // that stops a third of the way across the card reads as a rendering fault.
  // Stretching a viewBox instead would distort the stroke and the end dot.
  const wrap = useRef<HTMLDivElement | null>(null)
  const [w, setW] = useState(320)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  if (values.length < 2) return null
  const max = Math.max(1, ...values)
  const x = (i: number) => (i / (values.length - 1)) * (w - 4) + 2
  const y = (v: number) => h - (v / max) * (h - 4) - 2
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const area = `${d}L${x(values.length - 1).toFixed(1)},${h}L${x(0).toFixed(1)},${h}Z`
  return (
    <div ref={wrap}>
      <svg width={w} height={h} style={{ display: 'block' }} aria-hidden="true">
        <path d={area} fill={`${color}22`} />
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={3} fill={color} />
      </svg>
    </div>
  )
}

function AlertLine({ a }: { a: FleetAlert }) {
  const c = SEV_COLOR[a.severity] ?? 'var(--muted)'
  return (
    <div
      {...pressable((e: any) => { ((() => a.href && navigate(a.href)) as any)(e) })} data-a11y-click=""
      style={{
        display: 'flex', gap: 10, alignItems: 'baseline', padding: '8px 0',
        borderTop: '1px solid var(--border)', cursor: a.href ? 'pointer' : undefined,
      }}
    >
      <span style={{
        fontSize: 'var(--fs-micro)', fontWeight: 700, color: c, width: 60, flex: 'none',
        textTransform: 'uppercase', letterSpacing: 'var(--ls-label)',
      }}>{a.severity}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <b>{a.title}</b>
        <span style={{ color: 'var(--muted)' }}> · {a.detail}</span>
      </span>
      {a.at && <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', flex: 'none' }}>{fmtAgo(a.at)}</span>}
    </div>
  )
}

/** A panel that cannot show its content, and says why in one line. */
function Unavailable({ why, what }: { why: string; what: string }) {
  return (
    <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
      {why === 'not-allowed'
        ? <>Your access does not include {what}.</>
        : <>Could not load {what}: <span style={{ color: 'var(--down,#f87171)' }}>{why}</span></>}
    </div>
  )
}

function Section({ title, action, onAction, children }: {
  title: string; action?: string; onAction?: () => void; children: React.ReactNode
}) {
  return (
    <div className="card p-4" style={{ marginBottom: 16 }}>
      <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
        <div style={{
          fontSize: 'var(--fs-label)', letterSpacing: 'var(--ls-label)',
          textTransform: 'uppercase', color: 'var(--faint)', fontWeight: 700,
        }}>{title}</div>
        <div style={{ flex: 1 }} />
        {action && <button className="btn ghost" onClick={onAction}>{action}</button>}
      </div>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
export default function DashboardPage() {
  const [live, setLive] = useState<LiveBoard | null>(null)
  const [mon, setMon] = useState<MonitoringOverview | null>(null)
  const [an, setAn] = useState<AnalyticsOverview | null>(null)
  const [review, setReview] = useState<number | null>(null)
  const [recent, setRecent] = useState<VodAssetRow[]>([])
  // PER-PANEL failure, not one shared string. A user whose group sets
  // analytics to 'none' gets a 403 on one of these five calls; with a single
  // `err` the whole page showed a bare "403" while the analytics card sat on
  // "Loading…" forever, because its state stayed null and null means loading.
  const [errs, setErrs] = useState<Record<string, string>>({})
  const fail = (k: string) => errs[k] ?? ''

  // Each panel loads independently. One slow or unavailable subsystem should
  // degrade its own card, never blank the whole first screen.
  useEffect(() => {
    let dead = false
    const go = async () => {
      const settle = <T,>(key: string, p: Promise<T>, set: (v: T) => void) =>
        p.then(v => {
          if (dead) return
          set(v)
          setErrs(e => (e[key] ? { ...e, [key]: '' } : e))
        }).catch((e: any) => {
          if (dead) return
          // Say WHICH panel, and say it in the panel. "You do not have access
          // to this" is an answer; an endless spinner is not.
          setErrs(prev => ({ ...prev, [key]: e?.forbidden ? 'not-allowed' : (e?.message || 'failed') }))
        })
      await Promise.all([
        settle('live', api.liveBoard(), setLive),
        settle('mon', api.monitoringOverview(), setMon),
        settle('analytics', api.analyticsOverview(7), setAn),
        settle('review', api.reviewQueue().then(r => r.count), setReview),
        settle('vod', api.vodAssets(), v => setRecent(v.slice(0, 6))),
      ])
    }
    go()
    const h = setInterval(go, 30000)
    return () => { dead = true; clearInterval(h) }
  }, [])

  const onAir = live?.streams.filter(s => s.overall === 'onair') ?? []
  const trouble = live?.streams.filter(s => s.overall === 'error' || s.overall === 'degraded') ?? []
  const topAlerts = (mon?.alerts ?? []).slice(0, 5)
  const week = an?.daily.map(d => d.views) ?? []

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Is anything broken, what is on air, and what is waiting on you.</p>
        </div>
      </div>



      {/* ---- the headline numbers ---- */}
      <div className="card p-4" style={{ marginBottom: 16 }}>
        <div className="flex" style={{ gap: 34, flexWrap: 'wrap' }}>
          {/* The SAME count the Live Streams page shows, from the same field.
              This used to be computed here as overall === 'onair', so a channel
              that was published but degraded counted on one screen and not the
              other — two tiles one click apart, both labelled "On air",
              disagreeing. The server owns the definition. */}
          <Tile label="On air" value={live ? live.onAir : '—'}
            tone={live && live.onAir > 0 ? OK : undefined}
            sub={live ? `${live.running} of ${live.streams.length} running` : undefined}
            onClick={() => navigate('/live')} />
          <Tile label="Watching now" value={live ? fmtInt(live.concurrent) : '—'}
            tone={live && live.concurrent > 0 ? OK : undefined}
            onClick={() => navigate('/analytics')} />
          <Tile label="Needs attention"
            value={mon ? mon.counts.critical + mon.counts.serious : '—'}
            tone={mon && (mon.counts.critical + mon.counts.serious) > 0 ? SEV_COLOR.critical : undefined}
            sub={mon ? `${mon.counts.warning} warning${mon.counts.warning === 1 ? '' : 's'}` : undefined}
            onClick={() => navigate('/monitoring')} />
          <Tile label="Views · 7d" value={an ? fmtInt(an.totals.views) : '—'}
            sub={an ? `${fmtInt(an.totals.watchHours)} watch hours` : undefined}
            onClick={() => navigate('/analytics')} />
          <Tile label="Awaiting review" value={review ?? '—'}
            tone={review ? 'var(--warn,#fbbf24)' : undefined}
            onClick={() => navigate('/review')} />
        </div>
      </div>

      {/* ---- 1. is anything broken ---- */}
      <Section title="Attention" action="Monitoring" onAction={() => navigate('/monitoring')}>
        {fail('mon') ? (
          <Unavailable why={fail('mon')} what="the alert list" />
        ) : !mon ? (
          <div className="loading">Checking…</div>
        ) : topAlerts.length === 0 ? (
          <div style={{ color: 'var(--muted)' }}>
            <b style={{ color: OK }}>Nothing needs attention.</b>{' '}
            Every pipeline gate is passing, no job has failed, no media is missing its bytes,
            nothing is waiting on review and no group is at its limit.
          </div>
        ) : (
          <>
            {topAlerts.map(a => <AlertLine key={a.id} a={a} />)}
            {mon.alerts.length > topAlerts.length && (
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', marginTop: 8 }}>
                and {mon.alerts.length - topAlerts.length} more
              </div>
            )}
          </>
        )}
      </Section>

      {/* ---- 2. what is on air ---- */}
      {/* Published streams, including the ones that are published and broken.
          The tile above counts only what is genuinely serving, so this section
          is named for both cases rather than contradicting it. */}
      <Section title="On air and at risk" action="Live Streams" onAction={() => navigate('/live')}>
        {fail('live') ? (
          <Unavailable why={fail('live')} what="the live board" />
        ) : !live ? (
          <div className="loading">Loading…</div>
        ) : onAir.length === 0 && trouble.length === 0 ? (
          <div style={{ color: 'var(--muted)' }}>
            Nothing is published right now. Start a channel and take it on air, and it appears here.
          </div>
        ) : (
          <table>
            <thead>
              <tr><th>Stream</th><th>State</th><th>Watching</th><th>Source</th></tr>
            </thead>
            <tbody>
              {[...trouble, ...onAir].map(s => (
                <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => navigate(s.href)}>
                  <td><b>{s.name}</b></td>
                  <td>
                    <span style={{
                      color: s.overall === 'error' ? SEV_COLOR.critical
                        : s.overall === 'degraded' ? SEV_COLOR.warning : OK,
                      fontWeight: 700, fontSize: 'var(--fs-sm)',
                    }}>
                      {s.overall === 'error' ? 'DOWN' : s.overall === 'degraded' ? 'DEGRADED' : 'ON AIR'}
                    </span>
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtInt(s.concurrent)}</td>
                  <td style={{ color: 'var(--faint)' }}>
                    {s.fillerInUse ? 'filler' : s.fallbackInUse ? 'backup' : (s.activeSource ?? '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        {/* ---- 3. how the week went ---- */}
        <Section title="Last 7 days" action="Analytics" onAction={() => navigate('/analytics')}>
          {fail('analytics') ? <Unavailable why={fail('analytics')} what="analytics" />
            : !an ? <div className="loading">Loading…</div> : week.length < 2 ? (
            <div style={{ color: 'var(--muted)' }}>Not enough history yet. Figures appear once something has been watched.</div>
          ) : (
            <>
              <Spark values={week} />
              <div className="flex" style={{ gap: 26, marginTop: 10, flexWrap: 'wrap' }}>
                <Tile label="Views" value={fmtInt(an.totals.views)} />
                <Tile label="Unique" value={fmtInt(an.totals.uniques)} />
                <Tile label="Peak concurrent" value={fmtInt(an.totals.peakConcurrent)} />
              </div>
              <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 6 }}>
                Shape only. The numbers behind it, and today's partial day, are on Analytics.
              </div>
            </>
          )}
        </Section>

        {/* ---- 4. recent output ---- */}
        <Section title="Recent output" action="Media Library" onAction={() => navigate('/vod')}>
          {fail('vod') ? (
            <Unavailable why={fail('vod')} what="the media library" />
          ) : recent.length === 0 ? (
            <div style={{ color: 'var(--muted)' }}>No clips or recordings have been built yet.</div>
          ) : (
            <table>
              <thead><tr><th>Title</th><th>State</th><th>Built</th></tr></thead>
              <tbody>
                {recent.map(v => (
                  <tr key={v.id} style={{ cursor: 'pointer' }} onClick={() => navigate('/vod')}>
                    <td><b>{v.title || 'Untitled'}</b></td>
                    <td style={{ color: v.published ? OK : 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                      {v.published ? 'Published' : 'Draft'}
                    </td>
                    <td style={{ color: 'var(--faint)', whiteSpace: 'nowrap' }}>{fmtAgo(v.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>
    </>
  )
}
