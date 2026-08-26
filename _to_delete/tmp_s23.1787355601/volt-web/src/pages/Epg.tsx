import { useEffect, useMemo, useState } from 'react'
import { api, type EpgOwnerRow } from '../api'
import { PageHead, NewButton, FChip, EntityCell, StatusTag } from '../scaffold'
import { navigate } from '../router'

/* ============================================================================
   EPG section — one guide per channel (the traditional programme guide) and
   per event (the day's schedule of proceedings). Standard list format: click a
   guide (or New EPG on an owner without one) to open the builder page where
   programmes are added, edited, copied across days, and wired to per-slot geo
   access, slot replacement, and post-airing clip automation.
   ========================================================================== */

const fmtDT = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function Epg() {
  const [rows, setRows] = useState<EpgOwnerRow[] | null>(null)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState<'all' | 'channel' | 'event'>('all')
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    api.epgOwners().then(setRows).catch((e: any) => setErr(e.message))
  }, [])

  const counts = useMemo(() => {
    const c = rows || []
    return { all: c.length, channel: c.filter(r => r.kind === 'channel').length, event: c.filter(r => r.kind === 'event').length }
  }, [rows])
  const shown = useMemo(() => {
    if (!rows) return []
    const f = filter === 'all' ? rows : rows.filter(r => r.kind === filter)
    return f
  }, [rows, filter])
  const empty = useMemo(() => (rows || []).filter(r => r.programme_count === 0), [rows])

  const open = (r: EpgOwnerRow) => navigate(`/epg/${r.kind}/${r.id}`)

  return (
    <>
      <PageHead title="EPG" sub="Programme guides. Channels carry a traditional guide; events carry the day's schedule. Each slot can control geo access, trigger a slate/loop/VOD replacement, and cut a clip automatically after airing."
        action={<NewButton label="New EPG" onClick={() => setPickerOpen(true)} />} />
      {err && <div className="err">{err}</div>}
      {rows === null ? (
        <div className="loading">Loading guides…</div>
      ) : (
        <>
          <div className="filters">
            <FChip label="All" n={counts.all} on={filter === 'all'} onClick={() => setFilter('all')} />
            <FChip label="Channels" n={counts.channel} on={filter === 'channel'} onClick={() => setFilter('channel')} />
            <FChip label="Events" n={counts.event} on={filter === 'event'} onClick={() => setFilter('event')} />
          </div>
          <div className="card">
            <table>
              <thead><tr><th>Guide</th><th>Kind</th><th>Programmes</th><th>Coverage</th><th>Next up</th><th>Automation</th><th></th></tr></thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={r.kind + r.id} onClick={() => open(r)} style={{ cursor: 'pointer' }}>
                    <td><EntityCell name={r.name} sub={r.kind === 'channel' ? 'Channel guide' : 'Event schedule'} index={i} /></td>
                    <td><span className={`tag type ${r.kind === 'event' ? 'event' : 'chan'}`}>{r.kind === 'channel' ? 'Channel' : 'Event'}</span></td>
                    <td style={{ color: 'var(--muted)' }}>{r.programme_count || '—'}</td>
                    <td style={{ color: 'var(--muted)' }}>
                      {r.first_at && r.last_at ? `${fmtDT(r.first_at)} → ${fmtDT(r.last_at)}` : 'no programmes yet'}
                    </td>
                    <td style={{ color: 'var(--muted)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.next_title ? `${r.next_title} · ${fmtDT(r.next_at!)}` : '—'}
                    </td>
                    <td>{r.auto_clip_count > 0
                      ? <StatusTag label={`${r.auto_clip_count} auto-clip`} cls="sched" />
                      : <span style={{ color: 'var(--faint)' }}>—</span>}</td>
                    <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                      <button className={`btn ${r.programme_count ? 'primary' : 'ghost'}`} onClick={() => open(r)}>{r.programme_count ? 'Open' : 'Build'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* New EPG: pick the channel/event the guide belongs to */}
      {pickerOpen && (
        <div className="drawer-scrim" onClick={() => setPickerOpen(false)} style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div className="card" onClick={e => e.stopPropagation()} style={{ width: 480, maxWidth: '95vw', padding: 20 }}>
            <h3 style={{ margin: '0 0 4px' }}>New EPG</h3>
            <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: '0 0 12px' }}>A guide belongs to a channel or an event. Pick one without programmes yet; guides that already exist open from the list.</p>
            {empty.length === 0 ? (
              <div style={{ color: 'var(--faint)', fontSize: 13 }}>Every channel and event already has a guide started. Open one from the list.</div>
            ) : (
              <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                {empty.map(r => (
                  <div key={r.kind + r.id} onClick={() => open(r)}
                    style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '9px 12px', cursor: 'pointer', borderTop: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--brand)', width: 60, textTransform: 'uppercase' }}>{r.kind}</span>
                    <span style={{ flex: 1 }}>{r.name}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="btn ghost" onClick={() => setPickerOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
