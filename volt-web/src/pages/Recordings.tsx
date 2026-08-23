import { useEffect, useMemo, useState } from 'react'
import { api, type RecordingRow } from '../api'
import { PageHead, FChip, EntityCell, StatusTag } from '../scaffold'
import { navigate } from '../router'

/* ============================================================================
   Recordings LIST — same structural flow as Channels and Events: this page
   lists and filters; clicking a recording opens its DETAIL page
   (/recordings/:id) where the player, trim marks, transcript search, and
   clip creation live. The search box matches recording names, EPG programme
   titles that aired inside a recording, and the words spoken (transcript);
   the query is carried onto the detail page so a "spoken match" lands with
   the search already run.
   ========================================================================== */

const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString([], { day: '2-digit', month: 'short' })
function fmtDur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}
const KIND_LABEL: Record<string, string> = { event: 'Event', channel_day: 'Channel day' }
const MATCH_LABEL: Record<string, string> = { title: 'name match', programme: 'EPG match', transcript: 'spoken match' }

export default function Recordings() {
  const [rows, setRows] = useState<RecordingRow[] | null>(null)
  const [err, setErr] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | 'event' | 'channel_day'>('all')
  const [q, setQ] = useState('')

  async function load(searchQ = q) {
    try { setRows(await api.recordings(searchQ.trim() ? { q: searchQ.trim() } : {})) }
    catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [])
  // debounced content search (names + EPG + spoken words)
  useEffect(() => {
    const t = setTimeout(() => { load() }, 350)
    return () => clearTimeout(t)
    /* eslint-disable-next-line */
  }, [q])

  const counts = useMemo(() => {
    const c = rows || []
    return {
      all: c.length,
      event: c.filter(r => r.kind === 'event').length,
      channel_day: c.filter(r => r.kind === 'channel_day').length,
    }
  }, [rows])
  const shown = useMemo(() => {
    if (!rows) return []
    return kindFilter === 'all' ? rows : rows.filter(r => r.kind === kindFilter)
  }, [rows, kindFilter])

  const open = (r: RecordingRow) =>
    navigate(`/recordings/${r.id}${q.trim() && r.matched_by === 'transcript' ? `?q=${encodeURIComponent(q.trim())}` : ''}`)

  return (
    <>
      <PageHead title="Recordings" sub="Review captures, select a range, preview it, and create clips or VOD assets." />
      {err && <div className="err">{err}</div>}
      {rows === null ? (
        <div className="loading">Loading recordings…</div>
      ) : rows.length === 0 && !q.trim() ? (
        <div className="empty">
          <div className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /></svg></div>
          <h3>No recordings yet</h3>
          <p>Recordings appear here when a channel or event runs with recording enabled (the toggle in its settings). The live segments are kept per run and become the recording.</p>
        </div>
      ) : (
        <>
          <div className="filters">
            <FChip label="All" n={counts.all} on={kindFilter === 'all'} onClick={() => setKindFilter('all')} />
            <FChip label="Events" n={counts.event} on={kindFilter === 'event'} onClick={() => setKindFilter('event')} />
            <FChip label="Channel days" n={counts.channel_day} on={kindFilter === 'channel_day'} onClick={() => setKindFilter('channel_day')} />
            <input className="inp rec-search" style={{ width: 300, marginLeft: 'auto' }} value={q} onChange={e => setQ(e.target.value)}
              placeholder="Search names, EPG programmes, spoken words…" />
          </div>
          <div className="card">
            <table>
              <thead><tr><th>Recording</th><th>Kind</th><th>Window</th><th>Duration</th><th>Status</th><th>Assets</th><th></th></tr></thead>
              <tbody>
                {shown.map((r, i) => {
                  const start = Number(r.start_epoch_ms)
                  const end = r.end_epoch_ms != null ? Number(r.end_epoch_ms) : null
                  const live = r.status === 'recording'
                  return (
                    <tr key={r.id} onClick={() => open(r)} style={{ cursor: 'pointer' }}>
                      <td><EntityCell name={r.source_name || 'Recording'} sub={r.title || undefined} index={i} /></td>
                      <td>
                        <span className={`tag type ${r.kind === 'event' ? 'event' : 'chan'}`}>{KIND_LABEL[r.kind] || r.kind}</span>
                        {r.matched_by && <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--brand)', marginTop: 3 }}>{MATCH_LABEL[r.matched_by] || r.matched_by}</div>}
                      </td>
                      <td style={{ color: 'var(--muted)' }}>{fmtDate(start)} {fmtClock(start)} → {end != null ? fmtClock(end) : '…'}</td>
                      <td style={{ color: 'var(--muted)' }}>{end != null ? fmtDur(end - start) : fmtDur(Date.now() - start)}</td>
                      <td>{live ? <StatusTag label="Recording" cls="live" /> : <StatusTag label="Closed" cls="idle" />}</td>
                      <td style={{ color: 'var(--muted)' }}>{r.vod_count ? `${r.vod_count} VOD` : '—'}</td>
                      <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                        <button className="btn primary" onClick={() => open(r)}>Open</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}
