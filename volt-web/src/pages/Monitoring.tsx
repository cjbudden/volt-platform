import { useEffect, useRef, useState } from 'react'
import { api, type MonitoringOverview, type FleetAlert, type AlertSeverity } from '../api'
import { navigate } from '../router'
import { collapseRuns, fmtClock, fmtAgo, fmtSpan } from '../activityLog'

/* ============================================================================
   MONITORING — what needs attention, and nothing else.

   This is NOT a second copy of the live board. Live Streams answers "what is
   running"; this page answers "what is wrong", and the difference in question
   is the difference in design: there are no rows here for things that are
   fine. A healthy fleet renders an almost empty page, on purpose. An operator
   who has to scan forty green rows to find the one amber one is doing the
   computer's job.

   WHAT IT WATCHES, and why each one is here rather than assumed fine.

   PIPELINE   a failed gate on a running stream. The loudest thing possible:
              viewers are affected right now.
   JOBS       long work that failed, collapsed by type — ten copies of one
              failure is one problem — plus work stranded past its lease,
              which nothing retries and nothing else in the UI would show.
   MEDIA      the catalogue and the bytes are separate records and can
              disagree. An object recorded as readable with no location
              anywhere looks fine until somebody builds a clip from it.
   QC         assets that failed automated checks, and assets waiting on a
              person. Deliberately different severities: one is a fault, the
              other is a queue.
   PUBLISHING a stale publication is the quietest failure in the system. The
              portal keeps serving the OLD build and nothing errors.
   UPLOADS    sessions abandoned mid-flight still hold their parts.
   CAPACITY   a group at its channel limit, and stranded encoder records,
              which are a billing problem as much as an operational one.

   SEVERITY IS THREE VALUES, NOT FIVE. Critical means viewers are affected.
   Serious means something is broken but nobody is watching it break. Warning
   means it will matter later. A scale with more rungs than that gets argued
   about rather than acted on.
   ========================================================================== */

const SEV: Record<AlertSeverity, { label: string; color: string; bg: string }> = {
  critical: { label: 'Critical', color: '#f87171', bg: 'rgba(248,113,113,.10)' },
  serious:  { label: 'Serious',  color: '#fb923c', bg: 'rgba(251,146,60,.10)' },
  warning:  { label: 'Warning',  color: '#fbbf24', bg: 'rgba(251,191,36,.09)' },
}

const SOURCE_LABEL: Record<string, string> = {
  pipeline: 'Pipeline', jobs: 'Jobs', media: 'Media', qc: 'QC',
  publishing: 'Publishing', uploads: 'Uploads', capacity: 'Capacity',
}

/** The event types worth colouring in the feed. Everything else is chatter. */
const EVENT_TONE: Record<string, string> = {
  'channel.start': 'var(--live,#4ade80)',
  'channel.stop': 'var(--faint)',
  'input.error': '#f87171',
  'input.failover': '#fbbf24',
  'output.stall': '#fbbf24',
  'encoder.error': '#f87171',
}

// Alerts are about a CONDITION that is still true, so a relative age is the
// right label there. The fleet log is about EVENTS at points in time, and it
// gets fmtClock + fmtAgo from activityLog.ts instead -- see the note at the top
// of that file for the fourteen minutes this cost.
function fmtWhen(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  if (h < 24) return `${h}h ago`
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' })
}

/** Encoder details arrive as a JSON blob. Show the parts a person reads. */
function summariseDetail(raw: string): string {
  try {
    const o = JSON.parse(raw)
    if (!o || typeof o !== 'object') return String(raw).slice(0, 140)
    const keys = ['reason', 'error', 'message', 'source', 'protocol', 'from', 'to', 'run_id']
    const parts = keys.filter(k => o[k] != null).map(k => `${k}: ${o[k]}`)
    return (parts.length ? parts : Object.entries(o).map(([k, v]) => `${k}: ${v}`))
      .join(' · ').slice(0, 160)
  } catch { return String(raw).slice(0, 140) }
}

// ---------------------------------------------------------------------------
function Tile({ label, value, tone, sub }: {
  label: string; value: string | number; tone?: string; sub?: string
}) {
  return (
    <div style={{ minWidth: 118 }}>
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
//  One alert. Severity is carried by a left rule and a word, never by colour
//  alone: the whole point of the page is that it still works for someone who
//  cannot separate amber from red.
// ---------------------------------------------------------------------------
function AlertRow({ a }: { a: FleetAlert }) {
  const s = SEV[a.severity]
  return (
    <div style={{
      display: 'flex', gap: 12, alignItems: 'flex-start',
      padding: '11px 13px', marginBottom: 8, borderRadius: 10,
      background: s.bg, borderLeft: `3px solid ${s.color}`,
      border: '1px solid var(--border)', borderLeftWidth: 3, borderLeftColor: s.color,
    }}>
      <div style={{ minWidth: 66, flex: 'none' }}>
        <div style={{
          fontSize: 'var(--fs-micro)', fontWeight: 700, color: s.color,
          textTransform: 'uppercase', letterSpacing: 'var(--ls-label)',
        }}>{s.label}</div>
        <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 2 }}>
          {SOURCE_LABEL[a.source] ?? a.source}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{a.title}</div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 2 }}>{a.detail}</div>
      </div>
      <div className="flex items-center gap-2" style={{ flex: 'none' }}>
        {a.at && <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>{fmtWhen(a.at)}</span>}
        {a.href && (
          <button className="btn ghost" onClick={() => navigate(a.href!)}>Open</button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
export default function MonitoringPage() {
  const [d, setD] = useState<MonitoringOverview | null>(null)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState<AlertSeverity | 'all'>('all')
  const dead = useRef(false)

  async function load() {
    try { setD(await api.monitoringOverview()); setErr('') }
    catch (e: any) { setErr(e.message) }
  }

  useEffect(() => {
    dead.current = false
    load()
    const h = setInterval(() => { if (!dead.current) load() }, 20000)
    return () => { dead.current = true; clearInterval(h) }
    /* eslint-disable-next-line */
  }, [])

  if (err && !d) return <div className="card p-4"><div className="err">{err}</div></div>
  if (!d) return <div className="card p-4"><div className="loading">Checking the fleet…</div></div>

  const shown = filter === 'all' ? d.alerts : d.alerts.filter(a => a.severity === filter)
  const worst: AlertSeverity | null =
    d.counts.critical ? 'critical' : d.counts.serious ? 'serious' : d.counts.warning ? 'warning' : null

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Monitoring</h1>
          <p>Problems only. A healthy fleet leaves this page nearly empty, which is the point.</p>
        </div>
        <div className="spacer" />
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>
            checked {new Date(d.generatedAt).toLocaleTimeString()}
          </span>
          <button className="btn ghost" onClick={load}>Refresh</button>
        </div>
      </div>

      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="card p-4" style={{ marginBottom: 16 }}>
        <div className="flex" style={{ gap: 34, flexWrap: 'wrap' }}>
          <Tile label="Critical" value={d.counts.critical}
            tone={d.counts.critical ? SEV.critical.color : undefined}
            sub={d.counts.critical ? 'viewers affected' : 'none'} />
          <Tile label="Serious" value={d.counts.serious}
            tone={d.counts.serious ? SEV.serious.color : undefined}
            sub={d.counts.serious ? 'broken, unwatched' : 'none'} />
          <Tile label="Warning" value={d.counts.warning}
            tone={d.counts.warning ? SEV.warning.color : undefined}
            sub={d.counts.warning ? 'will matter later' : 'none'} />
          <Tile label="On air" value={d.fleet.onAir}
            tone={d.fleet.onAir ? 'var(--live,#4ade80)' : undefined}
            sub={`${d.fleet.running} of ${d.fleet.total} running`} />
          <Tile label="Watching now" value={d.fleet.concurrent.toLocaleString()}
            tone={d.fleet.concurrent ? 'var(--live,#4ade80)' : undefined} />
        </div>
      </div>

      <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
        <div style={{
          fontSize: 'var(--fs-label)', letterSpacing: 'var(--ls-label)',
          textTransform: 'uppercase', color: 'var(--faint)', fontWeight: 700,
        }}>Alerts</div>
        <div className="spacer" style={{ flex: 1 }} />
        {(['all', 'critical', 'serious', 'warning'] as const).map(f => (
          <button key={f} className={`btn ${filter === f ? '' : 'ghost'}`}
            onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : SEV[f].label}
          </button>
        ))}
      </div>

      {d.alerts.length === 0 ? (
        <div className="empty">
          <h3>Nothing needs attention</h3>
          <p>
            Every pipeline gate is passing, no job has failed, no media is missing its bytes,
            nothing is waiting on review and no group is at its limit.
          </p>
        </div>
      ) : shown.length === 0 ? (
        <div className="card p-4" style={{ color: 'var(--muted)' }}>
          No {filter} alerts. {worst && `The worst open right now is ${SEV[worst].label.toLowerCase()}.`}
        </div>
      ) : (
        shown.map(a => <AlertRow key={a.id} a={a} />)
      )}

      {/* The running commentary. Not alerts: what the fleet has been doing,
          so an operator can see the shape of a problem before it is one. */}
      <div style={{
        fontSize: 'var(--fs-label)', letterSpacing: 'var(--ls-label)',
        textTransform: 'uppercase', color: 'var(--faint)', fontWeight: 700,
        margin: '24px 0 10px',
      }}>Fleet activity</div>

      <div className="card">
        <table>
          <thead>
            <tr><th style={{ width: 132 }}>When</th><th style={{ width: 170 }}>Stream</th><th style={{ width: 150 }}>Event</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {collapseRuns(d.feed).map(run => (
              <tr key={run.row.id}>
                {/* ABSOLUTE FIRST. The relative age underneath is the
                    convenience; the clock is the fact, and it is what lets this
                    log be lined up against a station's own event log. */}
                <td style={{ whiteSpace: 'nowrap', lineHeight: 1.35 }}>
                  <div style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                    {fmtClock(run.newestTs)}
                  </div>
                  <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>
                    {fmtAgo(run.newestTs)}
                  </div>
                </td>
                <td><b>{run.row.name ?? '—'}</b></td>
                <td style={{ color: EVENT_TONE[run.row.type] ?? 'var(--muted)', fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }}>
                  {run.row.type}
                  {run.count > 1 && (
                    <span title={`${run.count} identical events between ${fmtClock(run.oldestTs)} and ${fmtClock(run.newestTs)}`}
                      style={{
                        marginLeft: 7, padding: '1px 6px', borderRadius: 5,
                        background: 'var(--panel-3)', color: 'var(--faint)',
                        fontSize: 'var(--fs-micro)', fontWeight: 700,
                      }}>{fmtSpan(run)}</span>
                  )}
                </td>
                <td style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', wordBreak: 'break-word' }}>
                  {summariseDetail(run.row.detail)}
                </td>
              </tr>
            ))}
            {d.feed.length === 0 && (
              <tr><td colSpan={4} style={{ color: 'var(--faint)' }}>
                Nothing has happened yet. Stream lifecycle events appear here as they are reported.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
