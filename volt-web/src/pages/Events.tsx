import { useEffect, useMemo, useState } from 'react'
import { api, type EventRow, type Group } from '../api'
import { useProtocols, SourceInput, type SourceValue } from '../protocols'
import { ImagePicker } from '../ImagePicker'

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

const SEC: React.CSSProperties = { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint)', margin: '18px 0 8px' }
type RetUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months'
const RET_UNIT_SEC: Record<RetUnit, number> = { minutes: 60, hours: 3600, days: 86400, weeks: 604800, months: 2592000 }

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

/** Live state of an event derived from status + windows. */
function eventPhase(ev: EventRow, now: number): { label: string; cls: string; sub?: string } {
  const start = Date.parse(ev.scheduled_start), end = Date.parse(ev.scheduled_end)
  const srv = ev.server_start ? Date.parse(ev.server_start) : start
  if (ev.status === 'live') return { label: 'ON AIR', cls: 'live' }
  if (ev.status === 'ended') return { label: 'ended', cls: '' }
  if (ev.status === 'error') return { label: 'error', cls: 'err' }
  if (now >= end) return { label: 'window over', cls: '' }
  if (now >= srv) return { label: 'starting', cls: '', sub: 'server window open' }
  return { label: 'scheduled', cls: '', sub: `starts in ${fmtIn(start - now)}${srv < start ? ` · server ${fmtIn(srv - now)} early` : ''}` }
}

export default function Events() {
  const [events, setEvents] = useState<EventRow[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<EventRow | null>(null)
  const [now, setNow] = useState(Date.now())

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
  async function remove(ev: EventRow) {
    if (!window.confirm(`Delete event "${ev.name}"? Its recording (if any) stays in the Recordings library.`)) return
    setBusy(ev.id)
    try { await api.deleteEvent(ev.id); await load() } catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }

  const groupName = (id: string) => groups.find(g => g.id === id)?.name || ''

  return (
    <>
      <div className="page-head">
        <div><h1>Events</h1><p>Scheduled broadcasts. The server spins up for the window automatically; recordings and auto-VOD follow the event settings.</p></div>
        <button className="btn primary" onClick={() => setCreateOpen(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" style={{ width: 15 }}><path d="M12 5v14M5 12h14" /></svg>New event
        </button>
      </div>
      {err && <div className="err">{err}</div>}
      {events === null ? <div className="card" style={{ padding: 18, color: 'var(--faint)' }}>Loading…</div>
        : events.length === 0 ? (
          <div className="empty"><h3>No events yet</h3><p>Create an event with its on-air window; the platform starts the server on time, records the broadcast, and can publish the VOD automatically when it ends.</p></div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            <table className="table">
              <thead><tr><th>Event</th><th>Window</th><th>Status</th><th>Recording</th><th>Auto-VOD</th><th></th></tr></thead>
              <tbody>
                {events.map(ev => {
                  const ph = eventPhase(ev, now)
                  const recOn = ev.recording_enabled !== false
                  return (
                    <tr key={ev.id} onClick={() => setEditing(ev)} style={{ cursor: 'pointer' }}>
                      <td><b>{ev.name}</b>{groupName(ev.group_id) && <span style={{ color: 'var(--faint)' }}> · {groupName(ev.group_id)}</span>}</td>
                      <td style={{ color: 'var(--muted)' }}>{fmtWindow(ev.scheduled_start, ev.scheduled_end)}</td>
                      <td>
                        <span className={`badge ${ph.cls}`}>{ph.label}</span>
                        {ph.sub && <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>{ph.sub}</div>}
                      </td>
                      <td style={{ color: 'var(--muted)' }}>{recOn ? 'on' : 'off'}</td>
                      <td style={{ color: 'var(--muted)' }}>{recOn && ev.auto_vod !== false ? 'on' : 'off'}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                        {ev.status === 'live'
                          ? <button className="btn ghost" disabled={busy === ev.id} onClick={() => startStop(ev, 'stop')}>{busy === ev.id ? '…' : 'Stop'}</button>
                          : ev.status !== 'ended' && <button className="btn primary" disabled={busy === ev.id} onClick={() => startStop(ev, 'start')} title="Start now (ahead of the scheduled window)">{busy === ev.id ? '…' : 'Start now'}</button>}
                        <button className="btn ghost" style={{ marginLeft: 6 }} onClick={() => setEditing(ev)}>Settings</button>
                        {ev.status !== 'live' && <button className="btn ghost" style={{ marginLeft: 6 }} disabled={busy === ev.id} onClick={() => remove(ev)}>✕</button>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
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
  const [groupId, setGroupId] = useState(ev?.group_id ?? (groups[0]?.id ?? ''))
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
  const initRet = initRetSec == null ? { n: '', unit: 'days' as RetUnit }
    : (() => { for (const u of ['months', 'weeks', 'days', 'hours', 'minutes'] as RetUnit[]) { const s = RET_UNIT_SEC[u]; if (initRetSec % s === 0 && initRetSec >= s) return { n: String(initRetSec / s), unit: u } } return { n: String(Math.round(initRetSec / 60)), unit: 'minutes' as RetUnit } })()
  const [retNum, setRetNum] = useState(isEdit ? initRet.n : '')
  const [retUnit, setRetUnit] = useState<RetUnit>(initRet.unit)
  const [autoVod, setAutoVod] = useState(ev ? ev.auto_vod !== false : true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit() {
    setErr('')
    if (!name.trim()) { setErr('Give the event a name'); return }
    if (!groupId) { setErr('Pick a group'); return }
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
            <div className="field"><label>Group</label>
              <select className="inp" value={groupId} onChange={e => setGroupId(e.target.value)}>
                {groups.map(g => <option key={g.id} value={g.id}>{g.name}{g.workflow_type ? ` · ${g.workflow_type === 'transcode' ? 'transcode' : 'packaging'}` : ''}</option>)}
              </select>
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

          <div style={SEC}>Recording</div>
          <div className="toggle-row">
            <div><div className="tt">Recording and clipping</div><div className="td">Keep the event's output as one contained recording: review it, clip highlights, publish VOD. Off means nothing can be clipped later.</div></div>
            <div className={`sw ${recOn ? '' : 'off'}`} onClick={() => setRecOn(v => !v)}><i /></div>
          </div>
          {recOn && (<>
            <div className="field"><label>Retention <span style={{ color: 'var(--faint)' }}>— blank number = keep forever</span></label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="inp" style={{ width: 110 }} inputMode="numeric" placeholder="keep forever"
                  value={retNum} onChange={e => setRetNum(e.target.value.replace(/[^0-9]/g, ''))} />
                <select className="inp" value={retUnit} onChange={e => setRetUnit(e.target.value as RetUnit)}>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                  <option value="weeks">weeks</option>
                  <option value="months">months</option>
                </select>
              </div>
            </div>
            <div className="toggle-row">
              <div><div className="tt">Automatic VOD on end</div><div className="td">When the event's recording closes, publish it as a full-event VOD asset automatically (the event's metadata is carried over).</div></div>
              <div className={`sw ${autoVod ? '' : 'off'}`} onClick={() => setAutoVod(v => !v)}><i /></div>
            </div>
          </>)}

          {err && <div className="err">{err}</div>}
        </div>
        <div className="drawer-f">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create event'}</button>
        </div>
      </div>
    </div>
  )
}
