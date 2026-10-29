import { useEffect, useMemo, useState } from 'react'
import { api, type RecordingRow, type RecordingSource } from '../api'
import { PageIdentity, StatusPill, TypeTag } from '../scaffold'
import { navigate } from '../router'
import { SourceTimeline, type TimelineSelection } from '../SourceTimeline'
import { useNotify } from '../notices'
import { removalText } from '../programmeMedia'

/* ============================================================================
   RECORDINGS — TIER 2: one source, everything it has recorded.

   A capture boundary is an ARTEFACT of how we slice storage, not of the
   content: a 24x7 channel is cut per calendar day, and a station that is
   stopped and started makes a new run. A programme does not care, and neither
   does the person clipping it — a show that starts at 23:40 and runs past
   midnight lives in two rows and must read as one thing.

   So this page presents the source's whole retained range as ONE span, lists
   the individual captures underneath as navigation (each still openable in the
   workbench), and offers a jump-to-date-and-time control that lands anywhere in
   the range regardless of which capture holds it.
   ========================================================================== */

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString([], { day: '2-digit', month: 'short' })
const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
function fmtDur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}
const TYPE_LABEL: Record<RecordingSource['type'], string> = { channel: 'Channel', radio: 'Radio', event: 'Event' }

/** epoch ms <-> the value a datetime-local input wants (local time, no zone). */
const toLocalInput = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}
const fromLocalInput = (v: string) => new Date(v).getTime()

/** An instant in the CHANNEL's timezone, not the browser's. */
function inZone(ms: number, tz?: string, timeOnly = false): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false,
    ...(timeOnly ? {} : { day: '2-digit', month: 'short' }),
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(ms)
}

export default function RecordingSourceView({ id, onBack }: { id: string; onBack: () => void }) {
  const [src, setSrc] = useState<RecordingSource | null>(null)
  const [rows, setRows] = useState<RecordingRow[] | null>(null)
  const [err, setErr] = useState('')
  const notify = useNotify()
  const [jump, setJump] = useState('')
  const [sel, setSel] = useState<TimelineSelection | null>(null)
  // The channel's clock, so every time on this page reads in the SAME zone
  // the timeline draws in. Mixing the browser's zone with the channel's puts
  // the same instant an hour apart on one screen.
  const [clock, setClock] = useState<{ tz: string; anchorHour: number } | null>(null)

  useEffect(() => {
    let dead = false
    ;(async () => {
      try {
        const [feed, recs] = await Promise.all([
          api.recordingSources({}),
          api.recordings({ sourceId: id }),
        ])
        if (dead) return
        setSrc(feed.sources.find(s => s.id === id) ?? null)
        setRows(recs)
      } catch (e: any) { if (!dead) setErr(e.message) }
    })()
    return () => { dead = true }
  }, [id])

  const span = useMemo(() => {
    if (!rows || !rows.length) return null
    const starts = rows.map(r => Number(r.start_epoch_ms))
    const ends = rows.map(r => (r.end_epoch_ms != null ? Number(r.end_epoch_ms) : Date.now()))
    return { from: Math.min(...starts), to: Math.max(...ends) }
  }, [rows])

  // Which capture holds a given instant? That is the whole point of the jump
  // control: the operator knows the time, not which row it landed in.
  function captureAt(ms: number): RecordingRow | null {
    if (!rows) return null
    return rows.find(r => {
      const a = Number(r.start_epoch_ms)
      const b = r.end_epoch_ms != null ? Number(r.end_epoch_ms) : Date.now()
      return ms >= a && ms <= b
    }) ?? null
  }
  function doJump() {
    if (!jump) return
    const ms = fromLocalInput(jump)
    if (!Number.isFinite(ms)) return
    const hit = captureAt(ms)
    if (!hit) { notify({ kind: 'error', message: `Nothing was recorded at ${fmtDate(ms)} ${fmtClock(ms)}.` }); return }
    navigate(`/recordings/${hit.id}?t=${ms}`)
  }

  if (err && !rows) return <div className="loading">{err}</div>
  if (!rows) return <div className="loading">Loading recordings…</div>

  return (
    <>
      <div className="page-head">
        <PageIdentity
          crumbLabel="Recordings" onCrumb={onBack} name={src?.name ?? 'Source'} imgUrl={null}
          tags={<>
            {src && <TypeTag label={TYPE_LABEL[src.type]} kind={src.type === 'event' ? 'event' : 'chan'} />}
            {src && <StatusPill state={src.capturing ? 'onair' : 'idle'}
              label={src.capturing ? 'Recording' : src.state === 'off' ? 'Off' : 'Idle'} />}
          </>}
          sub={span
            ? `${rows.length} recording${rows.length === 1 ? '' : 's'} · ${fmtDate(span.from)} ${fmtClock(span.from)} → ${fmtDate(span.to)} ${fmtClock(span.to)}`
            : 'No captures retained'}
        />
        <div className="spacer" />
      </div>

      {/* THE TIMELINE. Three lanes on one wall-clock axis, spanning every
          capture this source holds, so a programme that crosses a boundary
          reads as one thing. Selecting on it fills the clip range below. */}
      {src?.type !== 'event' && (
        <div style={{ marginBottom: 16 }}>
          <SourceTimeline channelId={id} onSelect={setSel} onClock={setClock} />
        </div>
      )}
      {sel && sel.toMs > sel.fromMs && (
        <div className="card p-4" style={{ marginBottom: 16 }}>
          <div className="sec-label">Selected range</div>
          <div className="flex flex-wrap items-center gap-3">
            <span style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }}>
              {inZone(sel.fromMs, clock?.tz)} → {inZone(sel.toMs, clock?.tz, true)}
            </span>
            {clock && <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-micro)' }}>{clock.tz}</span>}
            <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>
              {fmtDur(sel.toMs - sel.fromMs)}
            </span>
            <div className="flex-1" />
            <button className="btn primary" onClick={() => {
              const hit = captureAt(sel.fromMs)
              if (!hit) { notify({ kind: 'error', message: 'Nothing was recorded at the start of that range.' }); return }
              navigate(`/recordings/${hit.id}?from=${Math.round(sel.fromMs)}&to=${Math.round(sel.toMs)}`)
            }}>Open in the clipper</button>
          </div>
        </div>
      )}

      {/* JUMP TO A MOMENT — the control that makes capture boundaries invisible.
          Type a date and time anywhere in the retained range and land there,
          whichever capture happens to hold it. */}
      <div className="card p-4" style={{ marginBottom: 16 }}>
        <div className="sec-label">Jump to a date and time</div>
        <div className="flex flex-wrap items-center gap-2">
          <input type="datetime-local" step={1} value={jump} onChange={e => setJump(e.target.value)}
            min={span ? toLocalInput(span.from) : undefined} max={span ? toLocalInput(span.to) : undefined}
            style={{ width: 230 }} />
          <button className="btn primary" disabled={!jump} onClick={doJump}>Go</button>
          {span && (
            <>
              <button className="btn ghost" onClick={() => setJump(toLocalInput(span.from))}>Earliest held</button>
              <button className="btn ghost" onClick={() => setJump(toLocalInput(span.to - 60_000))}>Most recent</button>
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>
                held: {fmtDate(span.from)} {fmtClock(span.from)} → {fmtDate(span.to)} {fmtClock(span.to)}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <table>
          <thead><tr><th>Capture</th><th>Window</th><th>Duration</th><th>Status</th><th title="When each recording is deleted by the keep period">Removed</th><th>Assets</th><th /></tr></thead>
          <tbody>
            {rows.map(r => {
              const start = Number(r.start_epoch_ms)
              const end = r.end_epoch_ms != null ? Number(r.end_epoch_ms) : null
              // A row only reads as Recording when the SOURCE is genuinely
              // capturing; a stale open row on a dead source is Closed.
              const live = r.status === 'recording' && !!src?.capturing
              return (
                <tr key={r.id} onClick={() => navigate(`/recordings/${r.id}`)} style={{ cursor: 'pointer' }}>
                  <td style={{ fontWeight: 600 }}>{r.title || fmtDate(start)}</td>
                  <td style={{ color: 'var(--muted)' }}>{fmtDate(start)} {fmtClock(start)} → {end != null ? fmtClock(end) : '…'}</td>
                  <td style={{ color: 'var(--muted)' }}>{fmtDur((end ?? Date.now()) - start)}</td>
                  <td><StatusPill state={live ? 'onair' : 'idle'} label={live ? 'Recording' : 'Closed'} /></td>
                  <td style={{ color: removalText(r.expires_at).warn ? '#fbbf24' : 'var(--muted)', whiteSpace: 'nowrap' }} title={removalText(r.expires_at).text}>
                    {removalText(r.expires_at).short === 'kept' ? 'kept' : removalText(r.expires_at).text.replace(/^Removed /, '')}</td>
                  <td style={{ color: 'var(--muted)' }}>{r.vod_count ? `${r.vod_count} VOD` : '—'}</td>
                  <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                    <button className="btn primary" onClick={() => navigate(`/recordings/${r.id}`)}>Open</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
