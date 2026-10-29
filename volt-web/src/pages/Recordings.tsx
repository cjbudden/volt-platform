import { useEffect, useState } from 'react'
import { api, type RecordingSource, type RecordingSourcesFeed, type RecordingSourceQuery } from '../api'
import { PageHead, FChip, EntityCell, StatusPill } from '../scaffold'
import { navigate } from '../router'
import { usePageNotice } from '../notices'
import { removalText } from '../programmeMedia'

/* ============================================================================
   RECORDINGS — TIER 1: the sources that have recorded content.

   Recordings are grouped by the thing that produced them: a channel, a radio
   station, an event. There is deliberately NO parent row in the database for
   that grouping. The channel IS the container, `recordings.channel_id` already
   carries the link, and a parent row would duplicate identity that exists,
   add a write path that can drift, and need its own retention lifecycle. The
   API answers with a GROUP BY, which cannot get out of step.

   Two things this page exists to get RIGHT, because both were wrong before:

   TYPE. A radio station is a channel with a radio config, so its captures are
   stored with kind='channel_day' — and the old list printed "CHANNEL DAY"
   against every radio station. `kind` describes how a capture is SLICED, not
   what the source IS. The server derives the type from the source; this page
   prints that.

   STATUS. `channels.status` is a cache of "a process is running", written on a
   clean start and stop. After a crash it says 'live' forever, so recordings
   showed RECORDING against stations that had been dead for hours. The server
   now asks the pipeline directly, and the badge only says Recording when
   something is genuinely capturing this second.

   Sorting and filtering are SERVER-SIDE: the count and the available range are
   computed in SQL, so sorting in the browser would mean re-deriving numbers the
   browser does not own.
   ========================================================================== */

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString([], { day: '2-digit', month: 'short' })
const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
function fmtSpan(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m`
}
/** The available range, in the words an operator would use. */
function rangeLabel(s: RecordingSource): string {
  if (s.firstStartMs == null || s.lastEndMs == null) return '—'
  const a = new Date(s.firstStartMs), b = new Date(s.lastEndMs)
  const sameDay = a.toDateString() === b.toDateString()
  return sameDay
    ? `${fmtDate(s.firstStartMs)} ${fmtTime(s.firstStartMs)} → ${fmtTime(s.lastEndMs)}`
    : `${fmtDate(s.firstStartMs)} → ${fmtDate(s.lastEndMs)}`
}

const TYPE_LABEL: Record<RecordingSource['type'], string> = {
  channel: 'Channel', radio: 'Radio', event: 'Event',
}
const TYPE_CLS: Record<RecordingSource['type'], string> = {
  channel: 'chan', radio: 'chan', event: 'event',
}

type SortKey = NonNullable<RecordingSourceQuery['sort']>

/** <input type="date"> gives a yyyy-mm-dd string; the API wants epoch ms. */
const dayStart = (v: string) => (v ? new Date(`${v}T00:00:00`).getTime() : undefined)
const dayEnd = (v: string) => (v ? new Date(`${v}T23:59:59.999`).getTime() : undefined)

export default function Recordings() {
  const [feed, setFeed] = useState<RecordingSourcesFeed | null>(null)
  const [err, setErr] = useState('')
  const [type, setType] = useState<'all' | RecordingSource['type']>('all')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('recorded')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [onlyLive, setOnlyLive] = useState(false)
  const [recFrom, setRecFrom] = useState(''); const [recTo, setRecTo] = useState('')
  const [madeFrom, setMadeFrom] = useState(''); const [madeTo, setMadeTo] = useState('')
  const [datesOpen, setDatesOpen] = useState(false)

  async function load() {
    try {
      setFeed(await api.recordingSources({
        type: type === 'all' ? undefined : type,
        q: q.trim() || undefined,
        sort, dir,
        recordedFrom: dayStart(recFrom), recordedTo: dayEnd(recTo),
        createdFrom: dayStart(madeFrom), createdTo: dayEnd(madeTo),
        recordingNow: onlyLive ? '1' : undefined,
      }))
      setErr('')
    } catch (e: any) { setErr(e.message) }
  }
  // Every control is a server query, so they all share one debounce.
  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0)
    return () => clearTimeout(t)
    /* eslint-disable-next-line */
  }, [type, q, sort, dir, onlyLive, recFrom, recTo, madeFrom, madeTo])
  // A capturing source's numbers move; refresh while any are live.
  useEffect(() => {
    const t = setInterval(() => { if (feed?.counts.capturing) load() }, 15000)
    return () => clearInterval(t)
    /* eslint-disable-next-line */
  }, [feed?.counts.capturing])

  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load recordings.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)

  const counts = feed?.counts
  const rows = feed?.sources ?? []
  const datesSet = !!(recFrom || recTo || madeFrom || madeTo)
  const filtered = !!(q.trim() || type !== 'all' || datesSet || onlyLive)

  return (
    <>
      <PageHead title="Recordings" sub="Everything that has recorded content. Open a source to search, scrub and clip across its whole retained range." />

      <div className="filters">
        <FChip label="All" n={counts?.all ?? 0} on={type === 'all'} onClick={() => setType('all')} />
        <FChip label="Channels" n={counts?.channel ?? 0} on={type === 'channel'} onClick={() => setType('channel')} />
        <FChip label="Radio" n={counts?.radio ?? 0} on={type === 'radio'} onClick={() => setType('radio')} />
        <FChip label="Events" n={counts?.event ?? 0} on={type === 'event'} onClick={() => setType('event')} />
        <FChip label="Recording now" n={counts?.capturing ?? 0} on={onlyLive} onClick={() => setOnlyLive(v => !v)} />
        <button className="btn ghost" onClick={() => setDatesOpen(o => !o)}
          style={datesSet ? { borderColor: 'rgba(63,123,255,.6)', color: 'var(--brand)' } : undefined}>
          Dates{datesSet ? ' ·' : ''}
        </button>
        <input className="inp rec-search" style={{ width: 260, marginLeft: 'auto' }} value={q}
          onChange={e => setQ(e.target.value)} placeholder="Search source names…" />
      </div>

      {datesOpen && (
        <div className="card p-4" style={{ marginBottom: 14 }}>
          <div className="sec-label">Date filters</div>
          <div className="flex flex-wrap items-end gap-4">
            <DateRange label="Recorded between" from={recFrom} to={recTo} setFrom={setRecFrom} setTo={setRecTo} />
            <DateRange label="Source created between" from={madeFrom} to={madeTo} setFrom={setMadeFrom} setTo={setMadeTo} />
            <button className="btn ghost" disabled={!datesSet}
              onClick={() => { setRecFrom(''); setRecTo(''); setMadeFrom(''); setMadeTo('') }}>Clear</button>
          </div>
        </div>
      )}

      {feed === null ? (
        <div className="loading">Loading recordings…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /></svg></div>
          <h3>{filtered ? 'Nothing matches those filters' : 'No recordings yet'}</h3>
          <p>{filtered
            ? 'Widen the filters, or clear the date range.'
            : 'Recordings appear here when a channel, radio station or event runs with recording enabled. The live segments are kept per run and become the recording.'}</p>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <SortTh label="Source" k="name" sort={sort} dir={dir} setSort={setSort} setDir={setDir} />
                <th>Type</th>
                <SortTh label="Recordings" k="count" sort={sort} dir={dir} setSort={setSort} setDir={setDir} />
                <SortTh label="Available range" k="recorded" sort={sort} dir={dir} setSort={setSort} setDir={setDir} />
                <SortTh label="Content held" k="duration" sort={sort} dir={dir} setSort={setSort} setDir={setDir} />
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s, i) => (
                <tr key={s.id} onClick={() => navigate(`/recordings/source/${s.id}`)} style={{ cursor: 'pointer' }}>
                  <td><EntityCell name={s.name} sub={`created ${fmtDate(new Date(s.createdAt).getTime())}`} index={i} /></td>
                  <td><span className={`tag type ${TYPE_CLS[s.type]}`}>{TYPE_LABEL[s.type]}</span></td>
                  <td style={{ color: 'var(--muted)' }}>
                    {s.recordings}
                    {s.retentionDays != null && <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>kept for {s.retentionDays}d</div>}
                    {(s as any).nextExpiry && (() => { const r = removalText((s as any).nextExpiry); return (
                      <div style={{ fontSize: 'var(--fs-micro)', color: r.warn ? '#fbbf24' : 'var(--faint)' }} title={`Oldest recording: ${r.text}`}>next removal {r.short}</div>
                    ) })()}
                  </td>
                  <td style={{ color: 'var(--muted)' }}>{rangeLabel(s)}</td>
                  <td style={{ color: 'var(--muted)' }}>{fmtSpan(s.totalDurationMs)}</td>
                  <td>
                    {/* One vocabulary with the rest of the platform: Recording
                        while capturing, Idle when it is simply not, Off when
                        recording is switched off in the source's settings. */}
                    <StatusPill state={s.state === 'recording' ? 'onair' : 'idle'}
                      label={s.state === 'recording' ? 'Recording' : s.state === 'off' ? 'Off' : 'Idle'} />
                  </td>
                  <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                    <button className="btn primary" onClick={() => navigate(`/recordings/source/${s.id}`)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

/** A sortable column header: click to sort, click again to flip direction. */
function SortTh({ label, k, sort, dir, setSort, setDir }: {
  label: string; k: SortKey; sort: SortKey; dir: 'asc' | 'desc'
  setSort: (k: SortKey) => void; setDir: (d: 'asc' | 'desc') => void
}) {
  const on = sort === k
  return (
    <th onClick={() => { if (on) setDir(dir === 'asc' ? 'desc' : 'asc'); else { setSort(k); setDir(k === 'name' ? 'asc' : 'desc') } }}
      style={{ cursor: 'pointer', userSelect: 'none', color: on ? 'var(--brand)' : undefined }}
      title={`Sort by ${label.toLowerCase()}`}>
      {label}{on ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  )
}

function DateRange({ label, from, to, setFrom, setTo }: {
  label: string; from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void
}) {
  return (
    <label className="grid gap-1">
      <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>{label}</span>
      <span className="flex items-center gap-2">
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        <span style={{ color: 'var(--faint)' }}>→</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} />
      </span>
    </label>
  )
}
