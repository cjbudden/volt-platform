import { useEffect, useMemo, useState } from 'react'
import { api, thumbUrl, type EpgOwnerRow } from '../api'
import { PageHead, NewButton, FChip, EntityCell, StatusTag } from '../scaffold'
import { navigate } from '../router'
import { pressable } from '../a11y'
import XmltvDrawer from './EpgXmltv'
import XmltvImportDrawer from './EpgXmltvImport'

/* ============================================================================
   EPG section — one guide per channel (the traditional programme guide) and
   per event (the day's schedule of proceedings). Standard list format: click a
   guide (or New EPG on an owner without one) to open the builder page where
   programmes are added, edited, copied across days, and wired to per-slot geo
   access, slot replacement, and post-airing clip automation.
   ========================================================================== */

/** One place that knows what each kind is called, so the table, the picker and
 *  the empty state cannot drift into three different vocabularies. */
const LABEL: Record<string, string> = { channel: 'Channel', radio: 'Radio', event: 'Event' }
const SUB: Record<string, string> = {
  channel: 'Channel guide', radio: 'Station guide', event: 'Event schedule',
}
const TAG_CLASS: Record<string, string> = { channel: 'chan', radio: 'radio', event: 'event' }

const fmtDT = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function Epg() {
  const [rows, setRows] = useState<EpgOwnerRow[] | null>(null)
  const [err, setErr] = useState('')
  // THREE KINDS, NOT TWO. A radio station is not a television channel: it has a
  // different control page, a different source form and a different idea of what
  // a programme is. Folding it into "Channels" put twenty-one stations in a
  // filter alongside two channels and made the filter useless for either.
  const [filter, setFilter] = useState<'all' | 'channel' | 'radio' | 'event'>('all')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [xmltvOpen, setXmltvOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  useEffect(() => {
    api.epgOwners().then(setRows).catch((e: any) => setErr(e.message))
  }, [])

  const counts = useMemo(() => {
    const c = rows || []
    return {
      all: c.length,
      channel: c.filter(r => r.kind === 'channel').length,
      radio: c.filter(r => r.kind === 'radio').length,
      event: c.filter(r => r.kind === 'event').length,
    }
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
      <PageHead title="EPG" sub="Programme guides. Channels and radio stations carry a traditional guide; events carry the day's schedule. Each slot can control geo access, trigger a slate/loop/VOD replacement, and cut a clip automatically after airing."
        action={<div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => setImportOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="14" height="14" aria-hidden="true"><path d="M12 15V4M7 9l5-5 5 5M5 20h14" /></svg>
            XMLTV import
          </button>
          <button className="btn" onClick={() => setXmltvOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="14" height="14" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
            XMLTV export
          </button>
          <NewButton label="New EPG" onClick={() => setPickerOpen(true)} />
        </div>} />
      {xmltvOpen && <XmltvDrawer onClose={() => setXmltvOpen(false)} />}
      {importOpen && <XmltvImportDrawer onClose={() => setImportOpen(false)} onImported={() => api.epgOwners().then(setRows).catch(() => {})} />}
      {err && <div className="err">{err}</div>}
      {rows === null ? (
        <div className="loading">Loading guides…</div>
      ) : (
        <>
          <div className="filters">
            <FChip label="All" n={counts.all} on={filter === 'all'} onClick={() => setFilter('all')} />
            <FChip label="Channels" n={counts.channel} on={filter === 'channel'} onClick={() => setFilter('channel')} />
            <FChip label="Radio stations" n={counts.radio} on={filter === 'radio'} onClick={() => setFilter('radio')} />
            <FChip label="Events" n={counts.event} on={filter === 'event'} onClick={() => setFilter('event')} />
          </div>
          <div className="card">
            <table>
              <thead><tr><th>Guide</th><th>Kind</th><th>Programmes</th><th>Coverage</th><th>Next up</th><th>Automation</th><th></th></tr></thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={r.kind + r.id} onClick={() => open(r)} style={{ cursor: 'pointer' }}>
                    <td><EntityCell name={r.name} sub={SUB[r.kind]} index={i} imgUrl={r.icon_ref ? thumbUrl(r.icon_ref, 80, 80, 'inside') : null} /></td>
                    <td><span className={`tag type ${TAG_CLASS[r.kind]}`}>{LABEL[r.kind]}</span></td>
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
        <div className="drawer-scrim" {...pressable((e: any) => { ((() => setPickerOpen(false)) as any)(e) })} data-a11y-click="" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div className="card" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" style={{ width: 480, maxWidth: '95vw', padding: 20 }}>
            <h3 style={{ margin: '0 0 4px' }}>New EPG</h3>
            <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', margin: '0 0 12px' }}>A guide belongs to a channel or an event. Pick one without programmes yet; guides that already exist open from the list.</p>
            {empty.length === 0 ? (
              <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-body)' }}>Every channel, station and event already has a guide started. Open one from the list.</div>
            ) : (
              <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                {empty.map(r => (
                  <div key={r.kind + r.id} {...pressable((e: any) => { ((() => open(r)) as any)(e) })} data-a11y-click=""
                    style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '9px 12px', cursor: 'pointer', borderTop: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 'var(--fs-micro)', fontWeight: 700, color: 'var(--brand)', width: 60, textTransform: 'uppercase' }}>{LABEL[r.kind] ?? r.kind}</span>
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
