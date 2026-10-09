import { useEffect, useRef, useState } from 'react'
import { api, type FleetHost, type FleetUsage, type StreamUsage, type UsageBucket } from '../api'
import { pressable } from '../a11y'

/* ============================================================================
   FLEET — the servers, and the billable time they produced.

   Two halves, and the split is the same one Monitoring makes: what is running
   NOW, and what has been used OVER TIME.

   SERVERS answers "is the machine coping". It is a list of real hosts, not of
   streams: on EC2 capacity several tasks share a machine, and it is the
   MACHINE's CPU that tells you whether to add capacity. So each row shows the
   host's total load beside this tenant's share of it, and the two are
   different numbers on purpose. A host at 94% carrying nine streams, one of
   which is yours, is your problem even though your share looks small.

   USAGE answers "what was billable". The unit is TIME. There is a rate table
   behind this and every accrual carries the rate that applied, but no figure
   on this page is money: an indicative dollar amount rendered next to a real
   minute count gets repeated in a meeting as though both were real, and only
   one of them is.

   ------------------------------------------------------------------------
   TWO RENDERING RULES THAT ARE NOT COSMETIC.

   1. A MISSING READING IS NOT ZERO. `metrics: null`, or a null field inside
      it, means we could not measure — an unreachable host, a Fargate microVM
      with no host metric to read, a metrics provider that is not configured.
      Those render as "no reading", never as an empty bar. A capacity screen
      that draws 0% for a host it cannot reach shows an idle fleet at the exact
      moment the fleet is in trouble, and an operator who has learned to trust
      the graph will act on it.

   2. SETTLED AND PENDING TIME ARE SHOWN APART. `pendingSeconds` is time a task
      has been running since the meter last wrote. It is real usage, but it is
      still moving. Adding it silently into the totals would make a closed
      month and a live minute look like the same kind of fact.
   ========================================================================== */

const KIND_LABEL: Record<string, string> = {
  transcode: 'Transcode', package_only: 'Package', radio: 'Radio',
  captions: 'Captions', thumbnailer: 'Thumbnails', unknown: 'Unattributed',
}

const HOST_LABEL: Record<string, string> = {
  ec2: 'EC2 (shared)', fargate: 'Fargate (one task)', local: 'On-premises',
}

/** Seconds as something a person reads. Exact, never rounded to "about". */
function dur(sec: number): string {
  if (!sec) return '0m'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `${d}d ${h % 24}h`
  }
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m`
  return `${sec}s`
}

function bps(v: number | null): string {
  if (v == null) return '—'
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} Gb/s`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} Mb/s`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)} kb/s`
  return `${v} b/s`
}

function ago(iso: string | null): string {
  if (!iso) return ''
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  if (h < 24) return `${h}h ago`
  return new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short' })
}

/** Period label. Weeks are named by their Monday, which is what date_trunc gives. */
function periodLabel(iso: string, period: FleetUsage['period']): string {
  const d = new Date(iso)
  if (period === 'year') return String(d.getUTCFullYear())
  if (period === 'month') return d.toLocaleDateString([], { month: 'short', year: 'numeric', timeZone: 'UTC' })
  if (period === 'week') return `w/c ${d.toLocaleDateString([], { day: '2-digit', month: 'short', timeZone: 'UTC' })}`
  return d.toLocaleDateString([], { day: '2-digit', month: 'short', timeZone: 'UTC' })
}

// ---------------------------------------------------------------------------
function Tile({ label, value, sub, tone }: {
  label: string; value: string | number; sub?: string; tone?: string
}) {
  return (
    <div style={{ minWidth: 128 }}>
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

/**
 * A utilisation bar that can say "I do not know".
 *
 * The null branch is the whole reason this is a component. A bar rendered at
 * zero width and a bar that was never measured look identical unless one of
 * them refuses to draw, so the unmeasured one refuses and says so in words.
 * Colour is a secondary cue behind the number, never the only one.
 */
function Meter({ pct, label }: { pct: number | null; label: string }) {
  if (pct == null) {
    return (
      <div>
        <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>{label}</div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', fontStyle: 'italic' }}>no reading</div>
      </div>
    )
  }
  const tone = pct >= 90 ? '#f87171' : pct >= 75 ? '#fbbf24' : 'var(--live,#4ade80)'
  return (
    <div style={{ minWidth: 104 }}>
      <div className="flex items-center" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>{label}</span>
        <span style={{ fontSize: 'var(--fs-sm)', fontVariantNumeric: 'tabular-nums', color: tone }}>
          {pct.toFixed(0)}%
        </span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: 'var(--border)', marginTop: 4, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: '100%', background: tone }} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
function HostCard({ h }: { h: FleetHost }) {
  const [open, setOpen] = useState(false)
  const m = h.metrics
  // A reading older than this is history, not the present. Saying so beats
  // showing a stale number as though it were live.
  const stale = m ? (Date.now() - new Date(m.at).getTime()) > 10 * 60_000 : false
  const shared = h.tasksTotal > h.tasksYours

  return (
    <div className="card p-4" style={{ marginBottom: 10 }}>
      <div className="flex items-center" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 210, flex: 1 }}>
          <div className="flex items-center gap-2">
            <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
              {h.instanceType ?? 'unknown type'}
            </strong>
            {h.lifecycle === 'spot' && (
              <span className="chip" style={{ fontSize: 'var(--fs-micro)' }}>Spot</span>
            )}
          </div>
          <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 2 }}>
            {HOST_LABEL[h.kind] ?? h.kind}
            {h.availabilityZone ? ` · ${h.availabilityZone}` : ''}
            {h.vcpus ? ` · ${h.vcpus} vCPU` : ''}
          </div>
          <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', fontVariantNumeric: 'tabular-nums' }}>
            {h.externalId}
          </div>
        </div>

        {/* The MACHINE's load beside this tenant's share. Two numbers on
            purpose: the host's is what capacity decisions need, yours is what
            "what am I running" needs, and on shared capacity they differ. */}
        <div style={{ minWidth: 130 }}>
          <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: 'var(--ls-label)' }}>
            Streams
          </div>
          <div style={{ fontSize: 'var(--fs-h2, 20px)', fontVariantNumeric: 'tabular-nums' }}>
            {h.streamsYours}
            {shared && <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}> of {h.streamsTotal}</span>}
          </div>
          <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>
            {h.tasksYours} task{h.tasksYours === 1 ? '' : 's'}
            {shared ? ` · ${h.tasksTotal} on the machine` : ''}
          </div>
        </div>

        <Meter pct={m?.cpuPct ?? null} label="CPU" />
        <Meter pct={m?.memPct ?? null} label="Memory" />

        <div style={{ minWidth: 128 }}>
          <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>Network</div>
          <div style={{ fontSize: 'var(--fs-sm)', fontVariantNumeric: 'tabular-nums' }}>
            ↓ {bps(m?.netInBps ?? null)}
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', fontVariantNumeric: 'tabular-nums' }}>
            ↑ {bps(m?.netOutBps ?? null)}
          </div>
        </div>

        <button className="btn ghost" {...pressable(() => setOpen(o => !o))}>
          {open ? 'Hide' : 'Streams'}
        </button>
      </div>

      <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 8 }}>
        {m
          ? `${m.source} · ${ago(m.at)}${stale ? ' · reading is stale' : ''}`
          : h.kind === 'fargate'
            // Not a fault, and worth saying so: a one-task microVM has no host
            // metric to read, and pretending otherwise would invite someone to
            // "consolidate" capacity that cannot be consolidated.
            ? 'no host metrics: a Fargate task is a machine of one'
            : 'no telemetry provider is reporting for this host'}
      </div>

      {open && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          {h.streams.map(s => (
            <div key={s.instanceId} className="flex items-center" style={{ gap: 10, padding: '4px 0' }}>
              <span className="chip" style={{ fontSize: 'var(--fs-micro)', minWidth: 74, textAlign: 'center' }}>
                {KIND_LABEL[s.taskKind ?? 'unknown'] ?? s.taskKind}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>{s.name ?? s.id}</span>
              <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>{s.type}</span>
              <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>
                up {ago(s.launchedAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The usage series as bars.
 *
 * Deliberately not a library chart. There is one measure on one axis and no
 * second scale, so a row of bars with the value written on it says everything
 * a chart would, reads at any width, and cannot silently mislead the way a
 * dual axis can.
 */
function UsageBars({ series, period }: { series: UsageBucket[]; period: FleetUsage['period'] }) {
  if (!series.length) {
    return <div className="empty" style={{ padding: 20 }}>
      <p>No usage recorded yet. A stream has to run before there is time to report.</p>
    </div>
  }
  const max = Math.max(...series.map(b => b.seconds), 1)
  // Oldest to newest, because that is the direction time is read in.
  const rows = [...series].reverse()
  return (
    <div>
      {rows.map(b => (
        <div key={b.periodStart} className="flex items-center" style={{ gap: 12, padding: '5px 0' }}>
          <span style={{
            minWidth: 108, fontSize: 'var(--fs-sm)', color: 'var(--muted)',
            fontVariantNumeric: 'tabular-nums',
          }}>{periodLabel(b.periodStart, period)}</span>
          <div style={{ flex: 1, minWidth: 60, height: 16, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{
              width: `${(b.seconds / max) * 100}%`, height: '100%',
              background: 'var(--accent, #60a5fa)', borderRadius: 4,
            }} />
          </div>
          <span style={{ minWidth: 78, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {dur(b.seconds)}
          </span>
          <span style={{ minWidth: 118, fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>
            {b.serversUsed} server{b.serversUsed === 1 ? '' : 's'} · {b.streams} stream{b.streams === 1 ? '' : 's'}
          </span>
        </div>
      ))}
    </div>
  )
}

function StreamTable({ streams }: { streams: StreamUsage[] }) {
  if (!streams.length) {
    return <div className="empty" style={{ padding: 20 }}><p>Nothing has run yet.</p></div>
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--faint)', fontSize: 'var(--fs-micro)' }}>
            <th style={{ padding: '6px 8px', textTransform: 'uppercase', letterSpacing: 'var(--ls-label)' }}>Stream</th>
            <th style={{ padding: '6px 8px' }}>Type</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Today</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>This month</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>All time</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Runs</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Last used</th>
          </tr>
        </thead>
        <tbody>
          {streams.map(s => (
            <tr key={s.id} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ padding: '8px' }}>
                {s.name ?? <span style={{ color: 'var(--faint)' }}>{s.id.slice(0, 8)}</span>}
                {/* Time running but not yet settled by the meter. Shown as its
                    own quantity rather than folded in, so a live figure is
                    never mistaken for a closed one. */}
                {s.pendingSeconds > 0 && (
                  <span style={{ color: 'var(--live,#4ade80)', fontSize: 'var(--fs-micro)', marginLeft: 8 }}>
                    +{dur(s.pendingSeconds)} running
                  </span>
                )}
              </td>
              <td style={{ padding: '8px', color: 'var(--muted)' }}>
                {s.kind === 'event' ? 'Event' : s.channelKind === 'radio' ? 'Radio' : 'Channel'}
              </td>
              <td style={{ padding: '8px', textAlign: 'right' }}>{dur(s.todaySeconds)}</td>
              <td style={{ padding: '8px', textAlign: 'right' }}>{dur(s.monthSeconds)}</td>
              <td style={{ padding: '8px', textAlign: 'right' }}>{dur(s.allTimeSeconds)}</td>
              <td style={{ padding: '8px', textAlign: 'right', color: 'var(--muted)' }}>{s.runs}</td>
              <td style={{ padding: '8px', textAlign: 'right', color: 'var(--faint)', fontSize: 'var(--fs-micro)' }}>
                {ago(s.lastUsedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
export default function FleetPage() {
  const [hosts, setHosts] = useState<FleetHost[] | null>(null)
  const [usage, setUsage] = useState<FleetUsage | null>(null)
  const [period, setPeriod] = useState<FleetUsage['period']>('day')
  const [err, setErr] = useState('')
  const dead = useRef(false)

  async function load(p: FleetUsage['period']) {
    try {
      const [h, u] = await Promise.all([api.fleetHosts(), api.fleetUsage(p, p === 'day' ? 30 : 24)])
      setHosts(h.hosts); setUsage(u); setErr('')
    } catch (e: any) { setErr(e.message) }
  }

  useEffect(() => {
    dead.current = false
    load(period)
    // Slower than Monitoring's poll: the fleet pass itself runs once a minute,
    // so polling faster would redraw the same numbers.
    const t = setInterval(() => { if (!dead.current) load(period) }, 30_000)
    return () => { dead.current = true; clearInterval(t) }
    /* eslint-disable-next-line */
  }, [period])

  if (err && !usage) return <div className="card p-4"><div className="err">{err}</div></div>
  if (!usage || !hosts) return <div className="card p-4"><div className="loading">Reading the fleet…</div></div>

  const t = usage.totals
  const liveStreams = hosts.reduce((n, h) => n + h.streamsYours, 0)

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Fleet &amp; Usage</h1>
          <p>The servers running your streams, and the billable time they have produced.</p>
        </div>
        <div className="spacer" />
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>
            read {new Date(usage.generatedAt).toLocaleTimeString()}
          </span>
          <button className="btn ghost" {...pressable(() => load(period))}>Refresh</button>
        </div>
      </div>

      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="card p-4" style={{ marginBottom: 16 }}>
        <div className="flex" style={{ gap: 34, flexWrap: 'wrap' }}>
          <Tile label="Servers now" value={hosts.length}
                sub={`${liveStreams} stream${liveStreams === 1 ? '' : 's'} running`} />
          <Tile label="Billable today" value={dur(t.todaySeconds)}
                sub={`${t.serversToday} server${t.serversToday === 1 ? '' : 's'} · ${t.streamsToday} stream${t.streamsToday === 1 ? '' : 's'}`} />
          <Tile label="Billable this month" value={dur(t.monthSeconds)}
                sub={`${t.serversMonth} server${t.serversMonth === 1 ? '' : 's'} used`} />
          <Tile label="All time" value={dur(t.allTimeSeconds)} sub="since metering began" />
          {/* Its own tile rather than an addition to the ones above. Pending
              time is real but unsettled, and the distinction is the honest
              part of a live figure. */}
          <Tile label="Not yet settled" value={dur(t.pendingSeconds)}
                tone={t.pendingSeconds ? 'var(--live,#4ade80)' : undefined}
                sub="running since the last meter pass" />
        </div>
      </div>

      <h2 style={{ margin: '0 0 8px' }}>Servers</h2>
      {hosts.length === 0
        ? <div className="card p-4">
            <div className="empty" style={{ padding: 20 }}>
              <h3>No servers carrying your work</h3>
              <p>Servers appear here once a channel, event or station is running on one.</p>
            </div>
          </div>
        : hosts.map(h => <HostCard key={h.id} h={h} />)}

      <div className="flex items-center" style={{ margin: '22px 0 8px', gap: 10 }}>
        <h2 style={{ margin: 0 }}>Billable time</h2>
        <div className="spacer" />
        {(['day', 'week', 'month', 'year'] as const).map(p => (
          <button key={p} className={`btn ${period === p ? '' : 'ghost'}`}
                  {...pressable(() => setPeriod(p))}>
            {p === 'day' ? 'Daily' : p === 'week' ? 'Weekly' : p === 'month' ? 'Monthly' : 'Yearly'}
          </button>
        ))}
      </div>
      <div className="card p-4" style={{ marginBottom: 16 }}>
        <UsageBars series={usage.series} period={usage.period} />
      </div>

      <h2 style={{ margin: '0 0 8px' }}>By stream</h2>
      <div className="card p-4">
        <StreamTable streams={usage.streams} />
      </div>
    </>
  )
}
