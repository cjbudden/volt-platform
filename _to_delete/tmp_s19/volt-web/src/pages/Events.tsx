import { useEffect, useMemo, useState } from 'react'
import { api, type EventRow, type Group } from '../api'
import { useProtocols, SourceInput, type SourceValue } from '../protocols'
import { ImagePicker } from '../ImagePicker'
import { PageHead, NewButton, FChip, EntityCell, StatusTag, Preset, RecordingSection, RET_UNIT_SEC, SEC, splitDuration, type RetUnit } from '../scaffold'
import { ShareDrawer } from '../ShareDrawer'

/* ============================================================================
   Events — one-off broadcasts on the SAME core workflow as channels (sources,
   encoder, recording, clipping), plus the scheduled window:
   - scheduled start/end: the on-air window. The orchestrator's scheduler spins
     the server up at server_start (optionally minutes BEFORE the on-air time so
     the input can be checked) and stops it when the window closes.
   - recording + clipping: same explicit switch as channels; an event normally
     produces ONE contained recording.
   - auto-VOD: when the recording closes, a full-event VOD asset is derived
     automatically (the event's metadata is harvested onto it).
   ========================================================================== */

const p2 = (n: number) => String(n).padStart(2, '0')
/** ISO/date -> value for <input type=datetime-local> in LOCAL time. */
function toLocalInput(iso: string | Date): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`
}
const fromLocalInput = (v: string) => new Date(v).toISOString()

function fmtWindow(startIso: string, endIso: string): string {
  const s = new Date(startIso), e = new Date(endIso)
  const day = s.toLocaleDateString([], { day: '2-digit', month: 'short' })
  const t = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const sameDay = s.toDateString() === e.toDateString()
  return `${day} ${t(s)} → ${sameDay ? '' : e.toLocaleDateString([], { day: '2-digit', month: 'short' }) + ' '}${t(e)}`
}
function fmtIn(ms: number): string {
  const m = Math.round(ms / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${p2(m % 60)}m`
  return `${Math.floor(h / 24)}d`
}

/** Live state of an event derived from status + windows. Tag classes match the
 *  Channels status pills so both lists read identically. */
type Phase = 'upcoming' | 'live' | 'ended'
function eventPhase(ev: EventRow, now: number): { label: string; cls: string; sub?: string; phase: Phase } {
  const start = Date.parse(ev.scheduled_start), end = Date.parse(ev.scheduled_end)
  const srv = ev.server_start ? Date.parse(ev.server_start) : start
  if (ev.status === 'live') return { label: 'On air', cls: 'live', phase: 'live' }
  if (ev.status === 'ended') return { label: 'Ended', cls: 'idle', phase: 'ended' }
  if (ev.status === 'error') return { label: 'Error', cls: 'down', phase: 'upcoming' }
  if (now >= end) return { label: 'Window over', cls: 'idle', phase: 'ended' }
  if (now >= srv) return { label: 'Starting', cls: 'sched', sub: 'server window open', phase: 'upcoming' }
  return { label: 'Scheduled', cls: 'sched', phase: 'upcoming', sub: `starts in ${fmtIn(start - now)}${srv < start ? ` · server ${fmtIn(srv - now)} early` : ''}` }
}

export default function Events() {
  const [events, setEvents] = useState<EventRow[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<EventRow | null>(null)
  const [now, setNow] = useState(Date.now())
  const [filter, setFilter] = useState<'all' | Phase>('all')

  async function load() {
    try { setEvents(await api.events()) } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load(); api.groups().then(setGroups).catch(() => {}) }, [])
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])

  async function startStop(ev: EventRow, action: 'start' | 'stop') {
    setBusy(ev.id); setErr('')
    try { await api.eventStartStop(ev.id, action); await load() }
    catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }

  const groupName = (id: string) => groups.find(g => g.id === id)?.name || ''
  const counts = useMemo(() => {
    const c = events || []
    const ph = (e: EventRow) => eventPhase(e, now).phase
    return {
      all: c.length,
      upcoming: c.filter(e => ph(e) === 'upcoming').length,
      live: c.filter(e => ph(e) === 'live').length,
      ended: c.filter(e => ph(e) === 'ended').length,
    }
  }, [events, now])
  const shown = useMemo(() => {
    if (!events) return []
    if (filter === 'all') return events
    return events.filter(e => eventPhase(e, now).phase === filter)
  }, [events, filter, now])

  return (
    <>
      <PageHead title="Events" sub="Scheduled broadcasts. The server spins up for the window automatically; recordings and auto-VOD follow the event settings."
        action={<NewButton label="New event" onClick={() => setCreateOpen(true)} />} />
      {err && <div className="err">{err}</div>}
      {events === null ? (
        <div className="loading">Loading events…</div>
      ) : events.length === 0 ? (
        <div className="empty">
          <div className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg></div>
          <h3>No events yet</h3>
          <p>Create an event with its on-air window; the platform starts the server on time, records the broadcast, and can publish the VOD automatically when it ends.</p>
          <button className="btn primary" onClick={() => setCreateOpen(true)} style={{ margin: '0 auto' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
            Create your first event
          </button>
        </div>
      ) : (
        <>
          <div className="filters">
            <FChip label="All" n={counts.all} on={filter === 'all'} onClick={() => setFilter('all')} />
            <FChip label="Upcoming" n={counts.upcoming} on={filter === 'upcoming'} onClick={() => setFilter('upcoming')} />
            <FChip label="Live" n={counts.live} on={filter === 'live'} onClick={() => setFilter('live')} />
            <FChip label="Ended" n={counts.ended} on={filter === 'ended'} onClick={() => setFilter('ended')} />
          </div>
          <div className="card">
            <table>
              <thead><tr><th>Event</th><th>Window</th><th>Status</th><th>Recording</th><th>Auto-VOD</th><th></th></tr></thead>
              <tbody>
                {shown.map((ev, i) => {
                  const ph = eventPhase(ev, now)
                  const recOn = ev.recording_enabled !== false
                  return (
                    <tr key={ev.id} onClick={() => setEditing(ev)} style={{ cursor: 'pointer' }}>
                      <td><EntityCell name={ev.name} sub={groupName(ev.group_id)} index={i} /></td>
                      <td style={{ color: 'var(--muted)' }}>{fmtWindow(ev.scheduled_start, ev.scheduled_end)}</td>
                      <td><StatusTag label={ph.label} cls={ph.cls} sub={ph.sub} /></td>
                      <td style={{ color: 'var(--muted)' }}>{recOn ? 'on' : 'off'}</td>
                      <td style={{ color: 'var(--muted)' }}>{recOn && ev.auto_vod !== false ? 'on' : 'off'}</td>
                      <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                        {ev.status === 'live'
                          ? <button className="btn ghost" disabled={busy === ev.id} onClick={() => startStop(ev, 'stop')}>{busy === ev.id ? '…' : 'Stop'}</button>
                          : ev.status !== 'ended'
                          ? <button className="btn primary" disabled={busy === ev.id} onClick={() => startStop(ev, 'start')} title="Start now (ahead of the scheduled window)">{busy === ev.id ? '…' : 'Start'}</button>
                          : <button className="btn ghost" onClick={() => setEditing(ev)}>Open</button>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {createOpen && <EventDrawer groups={groups} onClose={() => setCreateOpen(false)} onDone={() => { setCreateOpen(false); load() }} />}
      {editing && <EventDrawer groups={groups} event={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load() }} />}
    </>
  )
}

/* --------------------------------------------- create / settings drawer */
function EventDrawer({ groups, event: ev, onClose, onDone }: {
  groups: Group[]; event?: EventRow; onClose: () => void; onDone: () => void
}) {
  const isEdit = !!ev
  const protocols = useProtocols()
  const [name, setName] = useState(ev?.name ?? '')
  // Type presets pick the group by workflow — the SAME control as the channel
  // form, so both drawers open identically: Name → Type → …
  const byType = useMemo(() => ({
    transcode: groups.find(g => g.workflow_type === 'transcode'),
    package_only: groups.find(g => g.workflow_type === 'package_only'),
  }), [groups])
  const initType: 'transcode' | 'package_only' =
    (ev && groups.find(g => g.id === ev.group_id)?.workflow_type === 'package_only') ? 'package_only' : 'transcode'
  const [type, setType] = useState<'transcode' | 'package_only'>(initType)
  const groupId = ev?.group_id ?? byType[type]?.id ?? ''
  const [purchasing, setPurchasing] = useState('spot_fallback')
  // schedule: on-air window + optional early server spin-up (input check time)
  const defStart = useMemo(() => { const d = new Date(Date.now() + 3600_000); d.setMinutes(0, 0, 0); return d }, [])
  const [start, setStart] = useState(ev ? toLocalInput(ev.scheduled_start) : toLocalInput(defStart))
  const [end, setEnd] = useState(ev ? toLocalInput(ev.scheduled_end) : toLocalInput(new Date(defStart.getTime() + 2 * 3600_000)))
  const initLead = ev?.server_start ? Math.max(0, Math.round((Date.parse(ev.scheduled_start) - Date.parse(ev.server_start)) / 60000)) : 15
  const [leadMin, setLeadMin] = useState(initLead)
  // sources (same shape as channels)
  const src0 = ev?.inputs?.find(s => s.role === 'primary')
  const src1 = ev?.inputs?.find(s => s.role === 'backup')
  const [primary, setPrimary] = useState<SourceValue>({ protocol: (src0?.protocol || 'srt').toLowerCase(), url: src0?.ingest_url || '', streamKey: src0?.stream_key || undefined })
  const [backupOn, setBackupOn] = useState(!!src1)
  const [backup, setBackup] = useState<SourceValue>({ protocol: (src1?.protocol || src0?.protocol || 'srt').toLowerCase(), url: src1?.ingest_url || '', streamKey: src1?.stream_key || undefined })
  // loss filler
  const [lossBehavior, setLossBehavior] = useState<'none' | 'slate' | 'vod_loop' | 'last_frame' | 'black'>((ev?.input_loss_behavior as any) || 'slate')
  const [slateRef, setSlateRef] = useState(ev?.filler_slate_ref || '')
  const [pickerOpen, setPickerOpen] = useState(false)
  // recording + auto-VOD
  const [recOn, setRecOn] = useState(ev ? ev.recording_enabled !== false : true)
  const initRetSec = ev?.recording_retention_sec != null ? Number(ev.recording_retention_sec)
    : (ev?.recording_retention_days != null ? ev.recording_retention_days * 86400 : null)
  const initRet = splitDuration(initRetSec)
  const [retNum, setRetNum] = useState(isEdit ? initRet.n : '')
  const [retUnit, setRetUnit] = useState<RetUnit>(initRet.unit)
  const [autoVod, setAutoVod] = useState(ev ? ev.auto_vod !== false : true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [shareOpen, setShareOpen] = useState(false)

  // destructive action lives INSIDE the drawer (common design language: rows
  // carry one primary action; delete is behind the entity's settings).
  async function remove() {
    if (!ev) return
    if (!window.confirm(`Delete event "${ev.name}"? Its recording (if any) stays in the Recordings library.`)) return
    setBusy(true); setErr('')
    try { await api.deleteEvent(ev.id); onDone() }
    catch (e: any) { setErr('Delete failed: ' + e.message) } finally { setBusy(false) }
  }

  async function submit() {
    setErr('')
    if (!name.trim()) { setErr('Give the event a name'); return }
    if (!groupId) { setErr(`No ${type === 'transcode' ? 'transcode' : 'packaging'} group set up yet`); return }
    const sMs = new Date(start).getTime(), eMs = new Date(end).getTime()
    if (!(eMs > sMs)) { setErr('End must be after start'); return }
    if (!isEdit && !primary.url.trim()) { setErr('Add the primary source URL'); return }
    const sources: NonNullable<Parameters<typeof api.createEvent>[0]['sources']> = []
    if (primary.url.trim()) sources.push({ role: 'primary', protocol: primary.protocol, ingestUrl: primary.url.trim(), streamKey: primary.streamKey?.trim() || undefined })
    if (backupOn && backup.url.trim()) sources.push({ role: 'backup', protocol: backup.protocol, ingestUrl: backup.url.trim(), streamKey: backup.streamKey?.trim() || undefined })
    const body = {
      name: name.trim(),
      scheduledStart: fromLocalInput(start),
      scheduledEnd: fromLocalInput(end),
      serverStart: new Date(sMs - leadMin * 60000).toISOString(),
      serverStop: fromLocalInput(end),
      purchasingMode: purchasing as 'on_demand' | 'reserved' | 'spot_fallback',
      recordingEnabled: recOn,
      recordingRetentionSec: recOn && retNum ? Number(retNum) * RET_UNIT_SEC[retUnit] : null,
      autoVod: recOn ? autoVod : false,
      sources,
      inputFailoverEnabled: sources.some(s => s.role === 'backup'),
      inputLossBehavior: lossBehavior,
      fillerSlateRef: (lossBehavior === 'slate' || lossBehavior === 'vod_loop') && slateRef.trim() ? slateRef.trim() : null,
    }
    setBusy(true)
    try {
      if (isEdit) await api.updateEvent(ev!.id, { ...body, version: ev!.version })
      else await api.createEvent({ groupId, ...body })
      onDone()
    } catch (e: any) {
      if (/version|match|409/i.test(String(e.message))) setErr('This event changed since you opened it. Reopen and retry.')
      else setErr(e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-h"><div className="t">{isEdit ? 'Event settings' : 'New event'}</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          <div className="field"><label>Event name</label>
            <input className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Cup Final 2026" />
          </div>

          {!isEdit && (
            <div className="field"><label>Type</label>
              <div className="presets">
                <Preset sel={type === 'transcode'} onClick={() => setType('transcode')} title="Transcode"
                  desc="One source in. We build the ABR ladder with FFmpeg." meta="1 input → many outputs" />
                <Preset sel={type === 'package_only'} onClick={() => setType('package_only')} title="Packaging"
                  desc="You send a pre-encoded ladder; we just package it." meta="N inputs → N outputs" />
              </div>
            </div>
          )}

          <div style={SEC}>Schedule</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="field"><label>On-air start</label>
              <input className="inp" type="datetime-local" value={start} onChange={e => setStart(e.target.value)} />
            </div>
            <div className="field"><label>On-air end</label>
              <input className="inp" type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} />
            </div>
          </div>
          <div className="field"><label>Spin up server early <span style={{ color: 'var(--faint)' }}>— time to receive and check the input before going on air</span></label>
            <select className="inp" value={leadMin} onChange={e => setLeadMin(Number(e.target.value))}>
              <option value={0}>at the on-air time</option>
              <option value={5}>5 minutes before</option>
              <option value={15}>15 minutes before</option>
              <option value={30}>30 minutes before</option>
              <option value={60}>1 hour before</option>
            </select>
            <div className="hintxt">The scheduler starts the encoder automatically at that time and stops it when the window ends. You can also Start now from the list.</div>
          </div>

          <div style={SEC}>Source</div>
          <SourceInput protocols={protocols} value={primary} onChange={setPrimary} label="Primary source" />
          <div className="toggle-row">
            <div><div className="tt">Backup source</div><div className="td">Optional failover input of the same feed.</div></div>
            <div className={`sw ${backupOn ? '' : 'off'}`} onClick={() => setBackupOn(v => !v)}><i /></div>
          </div>
          {backupOn && <SourceInput protocols={protocols} value={backup} onChange={setBackup} label="Backup source" />}

          <div style={SEC}>Filler on total loss</div>
          <div className="field"><label>When no source is available</label>
            <select className="inp" value={lossBehavior} onChange={e => setLossBehavior(e.target.value as any)}>
              <option value="none">Show nothing (output stops)</option>
              <option value="slate">Slate image</option>
              <option value="vod_loop">Loop a video</option>
              <option value="last_frame">Hold last frame</option>
              <option value="black">Black</option>
            </select>
          </div>
          {(lossBehavior === 'slate' || lossBehavior === 'vod_loop') && (
            <div className="field"><label>{lossBehavior === 'slate' ? 'Slate image' : 'Loop video'}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="inp" value={slateRef} onChange={e => setSlateRef(e.target.value)} placeholder="Pick from library or paste a URL" />
                <button type="button" className="btn ghost" onClick={() => setPickerOpen(true)}>Browse…</button>
              </div>
            </div>
          )}
          <ImagePicker open={pickerOpen} kinds={lossBehavior === 'vod_loop' ? ['loop', 'clip', 'vod', 'other'] : ['slate', 'brand', 'other']}
            title={lossBehavior === 'vod_loop' ? 'Choose a loop video' : 'Choose or upload a slate image'}
            uploadKind="slate" uploadFolder="slates" allowUpload={lossBehavior !== 'vod_loop'}
            onClose={() => setPickerOpen(false)} onPick={(url) => { setSlateRef(url); setPickerOpen(false) }} />

          <div style={SEC}>Delivery</div>
          <div className="field"><label>Purchasing mode</label>
            <select className="inp" value={purchasing} onChange={e => setPurchasing(e.target.value)}>
              <option value="reserved">Reserved</option>
              <option value="spot_fallback">Spot with on-demand fallback</option>
              <option value="on_demand">On demand</option>
            </select>
          </div>

          <RecordingSection ctx="event" recOn={recOn} setRecOn={setRecOn}
            retNum={retNum} setRetNum={setRetNum} retUnit={retUnit} setRetUnit={setRetUnit}
            autoVod={autoVod} setAutoVod={setAutoVod} />

          {err && <div className="err">{err}</div>}
        </div>
        <div className="drawer-f">
          {isEdit && (
            <button className="btn ghost" onClick={() => setShareOpen(true)}
              title="Create a private, time-boxed preview link for a client or reviewer (does not go on air)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" /><path d="M16 6l-4-4-4 4" /><path d="M12 2v14" /></svg>Share
            </button>
          )}
          {isEdit && ev!.status !== 'live' && (
            <button className="btn ghost" style={{ color: 'var(--down,#f87171)', marginRight: 'auto' }} disabled={busy} onClick={remove}>Delete event</button>
          )}
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create event'}</button>
        </div>
      </div>
      {shareOpen && ev && <ShareDrawer target={{ kind: 'event', id: ev.id, name: ev.name }} onClose={() => setShareOpen(false)} />}
    </div>
  )
}
