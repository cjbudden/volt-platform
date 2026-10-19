import { useEffect, useRef, useState } from 'react'
import { api, type LiveBoard, type LiveStream } from '../api'
import { navigate } from '../router'
import { PipelineStrip, StatusPill } from '../scaffold'
import { pressable } from '../a11y'
import { PageError, useNotify, usePageNotice } from '../notices'

/* ============================================================================
   LIVE STREAMS — what is running, right now, across the whole fleet.

   This page answers one question and refuses to answer any others: is
   everything that should be on air actually on air. It is the screen an
   operator leaves open on a second monitor, so it is built to be read at a
   glance from across a desk rather than studied.

   THREE DELIBERATE CHOICES.

   The gates come from the server, not from here. Every row carries the SAME
   five-gate health the channel and radio detail pages compute, from the same
   function. A board that ran its own status logic would eventually disagree
   with the page it links to, and an operator who catches the console lying
   once stops trusting it entirely.

   Trouble sorts to the top and stays there. The server ranks by state before
   name, so a failed channel is the first thing on screen whatever it is
   called. Sorting alphabetically would be tidier and would bury the one row
   that matters.

   NOT-RUNNING IS NOT AN ERROR, and the page says so structurally: idle and
   stopped streams sit in their own quiet section below the fold rather than
   filling the board with grey. A fleet of forty channels with three live is
   the normal case, not an alarm.
   ========================================================================== */

const OK = 'var(--live,#4ade80)'
const WARN = 'var(--warn,#fbbf24)'
const DOWN = 'var(--down,#f87171)'

const KIND_LABEL: Record<string, string> = { tv: 'TV', radio: 'Radio', event: 'Event' }

/** States that mean something is provisioned and doing work. */
const ACTIVE = new Set(['onair', 'ready', 'starting', 'degraded', 'error'])

function fmtUptime(ms: number | null) {
  if (ms == null) return null
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m`
  return `${s}s`
}

function fmtAge(ms: number | null) {
  if (ms == null) return 'never'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

// ---------------------------------------------------------------------------
//  A summary tile. One number, one label, and a tone only when the number
//  means something is wrong: a count of zero errors should not be red.
// ---------------------------------------------------------------------------
function Tile({ label, value, tone, sub }: {
  label: string; value: string | number; tone?: string; sub?: string
}) {
  return (
    <div style={{ minWidth: 116 }}>
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
//  One stream. The strip is the row's substance: the name and the numbers only
//  say WHICH stream, the gates say what is happening to it.
// ---------------------------------------------------------------------------
function StreamCard({ s, onOpen, busy, onStop }: {
  s: LiveStream; onOpen: () => void; busy: boolean; onStop: () => void
}) {
  const uptime = fmtUptime(s.uptimeMs)
  const stale = s.uptimeMs != null && s.reportAgeMs != null && s.reportAgeMs > 120_000
  return (
    <div className="card p-4" style={{ marginBottom: 10 }}>
      <div className="flex items-center gap-3" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <span
          {...pressable((e: any) => { ((onOpen) as any)(e) })} data-a11y-click=""
          style={{ fontSize: 'var(--fs-h2)', fontWeight: 700, cursor: 'pointer' }}
          className="lnk"
        >{s.name}</span>
        <span className={`tag type ${s.kind === 'event' ? 'event' : 'chan'}`}>{KIND_LABEL[s.kind] ?? s.kind}</span>
        <StatusPill state={s.overall} />
        {s.onAir && (
          <span className="tag live" title="Published: the public URL is open">
            <span className="dot-s live" />ON AIR
          </span>
        )}
        {s.fallbackInUse && (
          <span className="tag warn" title="The primary source is not usable">
            <span className="dot-s warn" />on backup
          </span>
        )}
        {s.fillerInUse && (
          <span className="tag warn" title="No usable input: filler is being played">
            <span className="dot-s warn" />filler
          </span>
        )}
        {/* The gates cannot show this: they are all green for a stream that is
            producing everything EXCEPT the output that needed a second piece of
            infrastructure. Named per output, because "degraded" without saying
            which one sends an operator to look at the source. */}
        {Object.keys(s.degradedOutputs ?? {}).map(k => (
          <span key={k} className="tag warn" title={s.degradedOutputs[k]}>
            <span className="dot-s warn" />{k.toUpperCase()} unavailable
          </span>
        ))}
        <div className="spacer" style={{ flex: 1 }} />
        <div className="flex items-center gap-4" style={{ fontSize: 'var(--fs-sm)' }}>
          {uptime && (
            <span><span style={{ color: 'var(--faint)' }}>up </span>
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>{uptime}</b></span>
          )}
          <span>
            <span style={{ color: 'var(--faint)' }}>watching </span>
            <b style={{ fontVariantNumeric: 'tabular-nums', color: s.concurrent > 0 ? OK : 'var(--muted)' }}>
              {s.concurrent.toLocaleString()}
            </b>
          </span>
          {s.groupName && <span style={{ color: 'var(--faint)' }}>{s.groupName}</span>}
        </div>
      </div>

      <PipelineStrip gates={s.gates} />

      <div className="flex items-center gap-3" style={{ fontSize: 'var(--fs-sm)', flexWrap: 'wrap' }}>
        {s.primaryError && (
          <span style={{ color: DOWN }}>
            <b>{s.primaryError.label}:</b> {s.primaryError.message}
          </span>
        )}
        {!s.primaryError && s.activeSource && (
          <span style={{ color: 'var(--faint)' }}>source: {s.activeSource}</span>
        )}
        {/* WHY, in the operator's own line of sight. The reason carries the
            address it failed to reach, which is the whole diagnosis, and by the
            time anyone reads it the container that logged it is usually gone. */}
        {Object.entries(s.degradedOutputs ?? {}).map(([k, why]) => (
          <span key={k} style={{ color: WARN }}>
            <b>{k.toUpperCase()}:</b> {why}
          </span>
        ))}
        {/* Telemetry that stopped arriving is its own fault: the gates read the
            manifest on disk and can look healthy while the reporter is dead. */}
        {stale && (
          <span style={{ color: WARN }} title="The encoder has not reported recently">
            last report {fmtAge(s.reportAgeMs)}
          </span>
        )}
        {s.orphanedInstance && (
          <span style={{ color: WARN }} title="An encoder is recorded as provisioned but nothing is running">
            stranded encoder record
          </span>
        )}
        <div className="spacer" style={{ flex: 1 }} />
        {/* Stop is also the remedy for a stranded record: it is what clears the
            instance row and takes the stream off air. Hiding it because the
            gates say nothing is up would leave the operator no way to fix it. */}
        {(s.uptimeMs != null || s.orphanedInstance || s.onAir) && (
          <button className="btn ghost" disabled={busy} onClick={onStop}>
            {busy ? 'Stopping…' : 'Stop'}
          </button>
        )}
        <button className="btn ghost" onClick={onOpen}>Open</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
export default function LivePage() {
  const [b, setB] = useState<LiveBoard | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [showIdle, setShowIdle] = useState(false)
  const [at, setAt] = useState<number>(0)
  const dead = useRef(false)

  async function load() {
    try { setB(await api.liveBoard()); setErr(''); setAt(Date.now()) }
    catch (e: any) { setErr(e.message) }
  }

  // A board that does not refresh itself is worse than no board: it looks
  // current and is not. Ten seconds is the encoder's own report cadence.
  useEffect(() => {
    dead.current = false
    load()
    const h = setInterval(() => { if (!dead.current) load() }, 10000)
    return () => { dead.current = true; clearInterval(h) }
    /* eslint-disable-next-line */
  }, [])

  const notify = useNotify()
  async function stop(s: LiveStream) {
    setBusy(s.id)
    try {
      if (s.kind === 'radio') await api.radioStartStop(s.id, 'stop')
      else if (s.kind === 'event') await api.eventStartStop(s.id, 'stop')
      else await api.startStop(s.id, 'stop')
      await load()
    } catch (e: any) { notify({ kind: 'error', message: e.message }) }
    finally { setBusy(null) }
  }

  function open(s: LiveStream) {
    navigate(s.href)
  }

  usePageNotice('load', err && b ? { kind: 'error', title: "Couldn't refresh the live board.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)

  if (err && !b) return <PageError message={err} onRetry={load} />
  if (!b) return <div className="card p-4"><div className="loading">Loading the fleet…</div></div>

  const active = b.streams.filter(s => ACTIVE.has(s.overall))
  const quiet = b.streams.filter(s => !ACTIVE.has(s.overall))
  const errors = b.streams.filter(s => s.overall === 'error').length
  // DEGRADED IS TWO CONDITIONS. A failed or degraded GATE means the pipeline is
  // not right. A dropped OUTPUT means the pipeline is fine and we are not
  // delivering everything we promised -- a station whose MP3 relay is missing
  // has five green gates and a URL that does not serve. Counting only the first
  // put "Degraded 0" next to exactly that station. The server computes it so
  // the two cannot drift; the local expression is the fallback for an API that
  // predates the field.
  const degraded = b.degraded ?? b.streams.filter(
    s => s.overall === 'degraded' || Object.keys(s.degradedOutputs ?? {}).length > 0
  ).length

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Live Streams</h1>
          <p>Every channel, station and event with a pipeline up, with the same five-gate health the detail pages show.</p>
        </div>
        <div className="spacer" />
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>
            {at ? `updated ${new Date(at).toLocaleTimeString()}` : ''}
          </span>
          <button className="btn ghost" onClick={load}>Refresh</button>
        </div>
      </div>


      <div className="card p-4" style={{ marginBottom: 16 }}>
        <div className="flex" style={{ gap: 34, flexWrap: 'wrap' }}>
          <Tile label="On air" value={b.onAir} tone={b.onAir > 0 ? OK : undefined}
            sub={b.onAir === 0 && b.running > 0 ? 'running, not published' : 'published'} />
          {/* ENCODERS UP is a capacity number and belongs beside the others
              rather than buried as a subtitle: it is what somebody checks
              before starting another stream, and what they compare against the
              host count on Fleet & Usage. */}
          <Tile label="Encoders up" value={b.running}
            tone={b.running > 0 ? OK : undefined}
            sub={`of ${b.streams.length} in the fleet`} />
          <Tile label="Watching now" value={b.concurrent.toLocaleString()}
            tone={b.concurrent > 0 ? OK : undefined} />
          <Tile label="Down" value={errors} tone={errors > 0 ? DOWN : undefined}
            sub={errors ? 'needs attention' : 'nothing failed'} />
          <Tile label="Degraded" value={degraded} tone={degraded > 0 ? WARN : undefined}
            sub={degraded ? (errors || b.streams.some(s => s.overall === 'degraded')
                  ? 'on air but not right'
                  : 'an output is missing')
               : 'none'} />
          <Tile label="Fleet" value={b.streams.length} sub="channels, stations and events" />
        </div>
      </div>

      {active.length === 0 ? (
        <div className="empty">
          <h3>Nothing is running</h3>
          <p>No channel, station or event has a pipeline up. Start one from its page and it appears here within ten seconds.</p>
        </div>
      ) : (
        active.map(s => (
          <StreamCard key={s.id} s={s} busy={busy === s.id}
            onOpen={() => open(s)} onStop={() => stop(s)} />
        ))
      )}

      {/* Idle is the normal state for most of a fleet, so it is folded away
          rather than allowed to fill the board with grey rows. */}
      {quiet.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <button className="btn ghost" onClick={() => setShowIdle(v => !v)}>
            {showIdle ? 'Hide' : 'Show'} {quiet.length} not running
          </button>
          {showIdle && (
            <div className="card" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr><th>Name</th><th>Kind</th><th>State</th><th>Group</th></tr>
                </thead>
                <tbody>
                  {quiet.map(s => (
                    <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => open(s)}>
                      <td><b>{s.name}</b></td>
                      <td style={{ color: 'var(--muted)' }}>{KIND_LABEL[s.kind] ?? s.kind}</td>
                      <td><StatusPill state={s.overall} /></td>
                      <td style={{ color: 'var(--faint)' }}>{s.groupName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  )
}
