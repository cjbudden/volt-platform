import { useEffect, useMemo, useState } from 'react'
import { api, type EventRow, type Group } from '../api'
import { useProtocols, SourceInput, hlsChoicePending, sourceFromRow, sourceProblem, sourceToApi, type SourceValue } from '../protocols'
import { PackageRenditions, pkgFromSources, pkgToSources, type PkgFallback, type PkgRow } from '../PackageRenditions'
import { ImagePicker } from '../ImagePicker'
import { PageHead, NewButton, EntityCell, StatusTag, Preset, RecordingSection, RET_UNIT_SEC, splitDuration, DrawerTabs, TabPane, type DrawerTab, type RetUnit } from '../scaffold'
import { useAccess, ReadOnlyBadge } from '../access'
import { ShareDrawer } from '../ShareDrawer'
import { EmbedDrawer } from '../EmbedDrawer'
import { pressable } from '../a11y'
import { TypePicker, MetadataForm } from '../ContentTypeFields'
import { RuleEditor } from '../RuleEditor'
import { FormStatus, useNotify, usePageNotice } from '../notices'
import { usePref, byName, ChipGroup, GroupFilter, SortSelect, ListToolbar, ClearFilters, NoMatches, Segmented } from '../listFilters'
import { RowMenu, Icons, useSelection, SelectCell, SelectAllHead, BulkBar, ConfirmDialog, runBulk, bulkSummary, type MenuItem } from '../listActions'
import EventCalendar from '../EventCalendar'
import { navigate, useRoute } from '../router'

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

type EventSort = 'date' | 'date_asc' | 'date_desc' | 'name' | 'name_desc'
const EVENT_SORTS: { value: EventSort; label: string }[] = [
  { value: 'date', label: 'Date (live and next first)' },
  { value: 'date_asc', label: 'Date (earliest first)' },
  { value: 'date_desc', label: 'Date (latest first)' },
  { value: 'name', label: 'Name A to Z' },
  { value: 'name_desc', label: 'Name Z to A' },
]
/**
 * EVENT ORDER. The default puts what matters now first: live events, then
 * upcoming ones soonest first, then ended ones most recent first.
 */
function sortEvents(rows: EventRow[], sort: EventSort, now: number): EventRow[] {
  const r = [...rows]
  const t = (e: EventRow) => Date.parse(e.scheduled_start) || 0
  const nm = (a: EventRow, b: EventRow) => byName(a.name, b.name)
  switch (sort) {
    case 'date_asc': return r.sort((a, b) => t(a) - t(b) || nm(a, b))
    case 'date_desc': return r.sort((a, b) => t(b) - t(a) || nm(a, b))
    case 'name': return r.sort(nm)
    case 'name_desc': return r.sort((a, b) => -nm(a, b))
    default: {
      const rank = { live: 0, upcoming: 1, ended: 2 } as const
      return r.sort((a, b) => {
        const pa = eventPhase(a, now).phase, pb = eventPhase(b, now).phase
        if (pa !== pb) return rank[pa] - rank[pb]
        return (pa === 'ended' ? t(b) - t(a) : t(a) - t(b)) || nm(a, b)
      })
    }
  }
}

export default function Events() {
  // ACCESS (access.tsx): manage = create/edit/delete; operate = start/stop.
  const { can } = useAccess()
  const canManage = can('events', 'manage')
  const canRun = can('events', 'operate')
  const [events, setEvents] = useState<EventRow[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  // /events?new (New Stream > Event) opens the drawer, then the URL is put back.
  const route = useRoute()
  useEffect(() => { if (route.create) { setCreateOpen(true); navigate('/events', { replace: true }) } }, [route.create])
  const [editing, setEditing] = useState<EventRow | null>(null)
  const [now, setNow] = useState(Date.now())
  // FILTERS, SORT AND VIEW (listFilters.tsx), remembered in this browser.
  const [filter, setFilter] = usePref<'all' | Phase>('events.status', 'all', ['all', 'upcoming', 'live', 'ended'])
  const [groupId, setGroupId] = usePref<string>('events.group', '')
  const [sort, setSort] = usePref<EventSort>('events.sort', 'date', ['date', 'date_asc', 'date_desc', 'name', 'name_desc'])
  const [view, setView] = usePref<'list' | 'calendar'>('events.view', 'list', ['list', 'calendar'])

  async function load() {
    try { setEvents(await api.events()); setErr('') } catch (e: any) { setErr(e.message) }
  }
  const notify = useNotify()
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load events.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)
  useEffect(() => { load(); api.groups().then(setGroups).catch(() => {}) }, [])
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])

  async function startStop(ev: EventRow, action: 'start' | 'stop') {
    setBusy(ev.id)
    try { await api.eventStartStop(ev.id, action); await load() }
    catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy('') }
  }

  const groupName = (id: string) => groups.find(g => g.id === id)?.name || ''
  const inGroup = (e: EventRow) => !groupId || e.group_id === groupId
  const counts = useMemo(() => {
    const c = (events || []).filter(inGroup)
    const ph = (e: EventRow) => eventPhase(e, now).phase
    return {
      all: c.length,
      upcoming: c.filter(e => ph(e) === 'upcoming').length,
      live: c.filter(e => ph(e) === 'live').length,
      ended: c.filter(e => ph(e) === 'ended').length,
    }
    // eslint-disable-next-line
  }, [events, now, groupId])
  const shown = useMemo(() => {
    if (!events) return []
    const list = events.filter(e => inGroup(e) && (filter === 'all' || eventPhase(e, now).phase === filter))
    return sortEvents(list, sort, now)
    // eslint-disable-next-line
  }, [events, filter, groupId, sort, now])
  const filtered = filter !== 'all' || !!groupId
  const clearFilters = () => { setFilter('all'); setGroupId('') }
  useEffect(() => { if (groupId && groups.length && !groups.some(g => g.id === groupId)) setGroupId('') /* eslint-disable-next-line */ }, [groups, groupId])
  const phaseOf = useMemo(() => (e: EventRow) => eventPhase(e, now).phase, [now])

  // ROW MENU, SELECTION, BULK (listActions.tsx)
  const sel = useSelection(view === 'list' ? shown.map(e => e.id) : [])
  const picked = shown.filter(e => sel.sel.has(e.id))
  const [bulkBusy, setBulkBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'stop' | 'remove'; rows: EventRow[] } | null>(null)
  const canStart = (e: EventRow) => e.status !== 'live' && e.status !== 'ended'
  const toStart = picked.filter(canStart)
  const toStop = picked.filter(e => e.status === 'live')
  const toRemove = picked.filter(e => e.status !== 'live')
  async function bulk(kind: 'start' | 'stop' | 'remove', rows: EventRow[]) {
    const verb = kind === 'start' ? 'Starting' : kind === 'stop' ? 'Stopping' : 'Removing'
    setBulkBusy(`${verb} 0 of ${rows.length}…`)
    const res = await runBulk(rows, r => kind === 'remove' ? api.deleteEvent(r.id) : api.eventStartStop(r.id, kind),
      d => setBulkBusy(`${verb} ${d} of ${rows.length}…`))
    setBulkBusy(null)
    const msg = bulkSummary(kind === 'start' ? 'Started' : kind === 'stop' ? 'Stopped' : 'Removed', res)
    notify({ kind: res.failed.length ? 'error' : 'ok', message: kind === 'remove' && res.ok.length ? `${msg} Each removal is in the audit log.` : msg })
    sel.clear(); load()
  }
  function menuFor(ev: EventRow): MenuItem[] {
    const items: MenuItem[] = [{ key: 'view', label: canManage ? 'View and edit settings' : 'View', icon: canManage ? Icons.settings : Icons.view, onSelect: () => setEditing(ev) }]
    if (canManage) items.push({ key: 'remove', label: 'Remove', icon: Icons.remove, danger: true, separator: true,
      disabledReason: ev.status === 'live' ? 'Stop the event first' : null, onSelect: () => setConfirm({ kind: 'remove', rows: [ev] }) })
    return items
  }

  return (
    <>
      <PageHead title="Events" sub="Scheduled broadcasts. The server spins up for the window automatically; recordings and auto-VOD follow the event settings." />
      {events === null ? (
        <div className="loading">Loading events…</div>
      ) : events.length === 0 ? (
        <div className="empty">
          <div className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg></div>
          <h3>No events yet</h3>
          <p>Create an event with its on-air window; the platform starts the server on time, records the broadcast, and can publish the VOD automatically when it ends.</p>
          {canManage && (
          <button className="btn primary" onClick={() => setCreateOpen(true)} style={{ margin: '0 auto' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
            Create your first event
          </button>
          )}
        </div>
      ) : (
        <>
          <ListToolbar
            left={<>
              <ChipGroup label="Status" value={filter} onChange={setFilter} options={[
                { value: 'all', label: 'All', n: counts.all },
                { value: 'live', label: 'Live', n: counts.live },
                { value: 'upcoming', label: 'Upcoming', n: counts.upcoming },
                { value: 'ended', label: 'Ended', n: counts.ended },
              ]} />
              <ClearFilters on={filtered} onClear={clearFilters} />
            </>}
            right={<>
              <GroupFilter groups={groups} value={groupId} onChange={setGroupId} />
              {view === 'list' && <SortSelect value={sort} onChange={setSort} options={EVENT_SORTS} />}
              <Segmented label="View" value={view} onChange={setView} options={[
                { value: 'list', label: 'List', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg> },
                { value: 'calendar', label: 'Calendar', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg> },
              ]} />
              <span className="tb-sep" aria-hidden="true" />
              {canManage ? <NewButton label="New event" onClick={() => setCreateOpen(true)} /> : <ReadOnlyBadge feature="events" />}
            </>} />
          {view === 'calendar' ? <EventCalendar events={shown} phaseOf={phaseOf} now={now} onOpen={setEditing} /> : shown.length === 0 ? (
            <div className="card"><NoMatches what="events" onClear={clearFilters} /></div>
          ) : (<>
          <BulkBar count={picked.length} noun={['event', 'events']} onClear={sel.clear} busy={bulkBusy} actions={[
            ...(canRun ? [
              { key: 'start', label: 'Start', icon: Icons.start, count: toStart.length, onRun: () => bulk('start', toStart),
                hint: toStart.length ? undefined : 'None of them can be started (running or ended)' },
              { key: 'stop', label: 'Stop', icon: Icons.stop, count: toStop.length, onRun: () => setConfirm({ kind: 'stop', rows: toStop }),
                hint: toStop.length ? undefined : 'None of them are running' },
            ] : []),
            ...(canManage ? [{ key: 'remove', label: 'Remove', icon: Icons.remove, danger: true, count: toRemove.length,
              onRun: () => setConfirm({ kind: 'remove', rows: toRemove }),
              hint: toRemove.length ? (toRemove.length < picked.length ? 'Running events are left out: stop them first' : undefined) : 'Stop them first' }] : []),
          ]} />
          <div className="card">
            <table>
              <thead><tr><SelectAllHead allOn={sel.allOn} someOn={sel.someOn} onToggle={sel.toggleAll} label="Select all events" /><th>Event</th><th>Window</th><th>Status</th><th>Recording</th><th>Auto-VOD</th><th></th></tr></thead>
              <tbody>
                {shown.map((ev, i) => {
                  const ph = eventPhase(ev, now)
                  const recOn = ev.recording_enabled !== false
                  return (
                    <tr key={ev.id} className={sel.sel.has(ev.id) ? 'selected' : undefined} onClick={() => setEditing(ev)} style={{ cursor: 'pointer' }}>
                      <SelectCell on={sel.sel.has(ev.id)} onToggle={() => sel.toggle(ev.id)} label={`Select ${ev.name}`} />
                      <td><EntityCell name={ev.name} sub={groupName(ev.group_id)} index={i} /></td>
                      <td style={{ color: 'var(--muted)' }}>{fmtWindow(ev.scheduled_start, ev.scheduled_end)}</td>
                      <td><StatusTag label={ph.label} cls={ph.cls} sub={ph.sub} /></td>
                      <td style={{ color: 'var(--muted)' }}>{recOn ? 'on' : 'off'}</td>
                      <td style={{ color: 'var(--muted)' }}>{recOn && ev.auto_vod !== false ? 'on' : 'off'}</td>
                      <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                        <div className="row-actions">
                        {!canRun
                          ? <button className="btn act ghost" onClick={() => setEditing(ev)}>Open</button>
                          : ev.status === 'live'
                          ? <button className="btn act ghost" disabled={busy === ev.id} onClick={() => startStop(ev, 'stop')}>{busy === ev.id ? '…' : 'Stop'}</button>
                          : ev.status !== 'ended'
                          ? <button className="btn act primary" disabled={busy === ev.id || !!bulkBusy} onClick={() => startStop(ev, 'start')} title="Start now (ahead of the scheduled window)">{busy === ev.id ? '…' : 'Start'}</button>
                          : <button className="btn act ghost" onClick={() => setEditing(ev)}>Open</button>}
                          <RowMenu label={`More actions for ${ev.name}`} items={menuFor(ev)} />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          </>)}
        </>
      )}
      {confirm && (
        <ConfirmDialog danger
          title={`${confirm.kind === 'stop' ? 'Stop' : 'Remove'} ${confirm.rows.length === 1 ? confirm.rows[0].name : `${confirm.rows.length} events`}?`}
          confirmLabel={confirm.kind === 'stop' ? 'Stop' : `Remove ${confirm.rows.length === 1 ? 'event' : `${confirm.rows.length} events`}`}
          typeToConfirm={confirm.kind === 'remove' ? (confirm.rows.length === 1 ? confirm.rows[0].name : `remove ${confirm.rows.length}`) : undefined}
          body={<>
            <p style={{ margin: '0 0 6px' }}>{confirm.kind === 'stop'
              ? 'The broadcast ends now and viewers lose the stream.'
              : 'This cannot be undone. Its recordings, clips, guide entries and schedules go with it.'}</p>
            {confirm.rows.length > 1 && <ul className="bulk-list">{confirm.rows.map(r => <li key={r.id}>{r.name}</li>)}</ul>}
          </>}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); bulk(c.kind, c.rows) }} />
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
  const { can } = useAccess()
  const canManage = can('events', 'manage')
  const isEdit = !!ev
  const protocols = useProtocols('video')
  const [name, setName] = useState(ev?.name ?? '')
  // CONTENT TYPE, required: decides the metadata captured here and on everything derived.
  const [tab, setTab] = useState<DrawerTab>('settings')
  const [typeId, setTypeId] = useState<string | null>(ev?.schema_id ?? null)
  const [meta, setMeta] = useState<Record<string, any>>(ev?.metadata ?? {})
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
  const [primary, setPrimary] = useState<SourceValue>(sourceFromRow(src0))
  const [backupOn, setBackupOn] = useState(!!src1)
  const [backup, setBackup] = useState<SourceValue>(src1 ? sourceFromRow(src1) : { protocol: (src0?.protocol || 'srt').toLowerCase(), url: '' })
  // PACKAGING: the sent ladder, one input per rendition (the channel's form)
  const pkgInit = useMemo(() => pkgFromSources((ev?.inputs ?? []) as any, [], false), [ev?.id])
  const [pkgRows, setPkgRows] = useState<PkgRow[]>(pkgInit.rows)
  const [pkgMode, setPkgMode] = useState<PkgFallback>(pkgInit.mode)
  const [pkgFb, setPkgFb] = useState<SourceValue>(pkgInit.fb)
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
  const [embedOpen, setEmbedOpen] = useState(false)

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
    const sources: NonNullable<Parameters<typeof api.createEvent>[0]['sources']> = []
    if (type === 'package_only') {
      const hlsWaitP = await hlsChoicePending(pkgRows.map(r => ({ url: r.url, protocol: r.protocol }))); if (hlsWaitP) { setErr(hlsWaitP); return }
      const out = pkgToSources(pkgRows, pkgMode, pkgFb, protocols)
      if ('error' in out) { setErr(out.error); return }
      sources.push(...out.sources)
    } else {
      if (!isEdit && !primary.url.trim()) { setErr('Add the primary source URL'); return }
      const hlsWait = await hlsChoicePending([{ url: primary.url, protocol: primary.protocol, original: src0?.ingest_url }, ...(backupOn ? [{ url: backup.url, protocol: backup.protocol, original: src1?.ingest_url }] : [])]); if (hlsWait) { setErr(hlsWait); return }
      const why = (primary.url.trim() ? sourceProblem(protocols, primary) : null) ?? (backupOn && backup.url.trim() ? sourceProblem(protocols, backup) : null)
      if (why) { setErr(`${primary.url.trim() && sourceProblem(protocols, primary) ? 'Primary' : 'Backup'} source: ${why}`); return }
      if (primary.url.trim()) sources.push({ role: 'primary', ...sourceToApi(primary, protocols) })
      if (backupOn && backup.url.trim()) sources.push({ role: 'backup', ...sourceToApi(backup, protocols) })
    }
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
      ...(typeId ? { schemaId: typeId, metadata: meta } : {}),
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
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="">
      <div className="drawer" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="">
        <div className="drawer-h"><div className="t">{isEdit ? 'Event settings' : 'New event'}</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          {/* Read-only for roles without events:manage: every field is disabled. */}
          <fieldset disabled={!canManage} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <DrawerTabs tab={tab} setTab={setTab} />
          <TabPane active={tab === 'metadata'}>
            {/* THE EVENT'S KIND: a town hall, a match, a service. It decides
                the fields under it and the EPG fields they fill. */}
            <TypePicker appliesTo="event" value={typeId} onChange={(id) => setTypeId(id)} />
            <MetadataForm typeId={typeId} value={meta} onChange={setMeta} entityName={{ value: name, where: 'event' }} />
          </TabPane>
          <TabPane active={tab === 'access'}>
            {isEdit
              ? <RuleEditor scopeKind="owner" scopeId={ev!.id} compact resolveQuery={{ eventId: ev!.id, schemaId: typeId }} />
              : <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>Create the event first; its publishing and access rules are set here afterwards. Until then it inherits its content type's and the account's rules.</div>}
          </TabPane>
          <TabPane active={tab === 'settings'}>
          <div className="field"><label>Event name <span className="req">*</span></label>
            <input className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Cup Final 2026" />
          </div>

          {!isEdit && (
            <div className="field"><label>Workflow</label>
              <div className="presets">
                <Preset sel={type === 'transcode'} onClick={() => setType('transcode')} title="Transcode"
                  desc="One source in. We build the ABR ladder with FFmpeg." meta="1 input → many outputs" />
                <Preset sel={type === 'package_only'} onClick={() => setType('package_only')} title="Packaging"
                  desc="You send a pre-encoded ladder; we just package it." meta="N inputs → N outputs" />
              </div>
            </div>
          )}

          <div className="sec-label">Schedule</div>
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

          {type === 'package_only' ? (
            <PackageRenditions protocols={protocols} rows={pkgRows} onRows={setPkgRows} mode={pkgMode} onMode={setPkgMode} fb={pkgFb} onFb={setPkgFb} />
          ) : (
            <>
              <div className="sec-label">Source</div>
              <SourceInput protocols={protocols} value={primary} onChange={setPrimary} label="Primary source" />
              <div className="toggle-row">
                <div><div className="tt">Backup source</div><div className="td">Optional failover input of the same feed.</div></div>
                <div className={`sw ${backupOn ? '' : 'off'}`} {...pressable((e: any) => { ((() => setBackupOn(v => !v)) as any)(e) })} data-a11y-click=""><i /></div>
              </div>
              {backupOn && <SourceInput protocols={protocols} value={backup} onChange={setBackup} label="Backup source" />}
            </>
          )}

          <div className="sec-label">Filler on total loss</div>
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

          <div className="sec-label">Delivery</div>
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

          </TabPane>
          </fieldset>
        </div>
        <div className="drawer-f">
          {isEdit && can('sharing', 'manage') && (
            <button className="btn ghost" onClick={() => setShareOpen(true)}
              title="Create a private, time-boxed preview link for a client or reviewer (does not go on air)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" /><path d="M16 6l-4-4-4 4" /><path d="M12 2v14" /></svg>Share
            </button>
          )}
          {isEdit && can('apps', 'view') && (
            <button className="btn ghost" onClick={() => setEmbedOpen(true)}
              title="A tag to put this event on a website: countdown, Buy when paid, then the live player">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5" /><path d="M10 9.2v5.6l4.6-2.8z" fill="currentColor" stroke="none" /></svg>Player
            </button>
          )}
          {isEdit && canManage && ev!.status !== 'live' && (
            <button className="btn ghost" style={{ color: 'var(--down,#f87171)', marginRight: 'auto' }} disabled={busy} onClick={remove}>Delete event</button>
          )}
          <FormStatus error={err} />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          {canManage && <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create event'}</button>}
        </div>
      </div>
      {shareOpen && ev && <ShareDrawer target={{ kind: 'event', id: ev.id, name: ev.name }} onClose={() => setShareOpen(false)} />}
      {embedOpen && ev && <EmbedDrawer target={{ kind: 'event', id: ev.id, name: ev.name, startsAt: (ev as any).public_start ?? (ev as any).scheduled_start ?? null }} onClose={() => setEmbedOpen(false)} />}
    </div>
  )
}
