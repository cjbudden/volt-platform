import { useEffect, useMemo, useState } from 'react'
import { api, type RadioStationRow, type Group, type RadioCfg, type PlanView } from '../api'
import { useProtocols, SourceInput, hlsChoicePending, type SourceValue } from '../protocols'
import { ImageRefField, GuideIconField } from '../ImageRefField'
import { isFull, fullReason, noRoomReason, planFullReason } from '../lib/capacity'
import DeleteChannelDialog, { BulkRemoveDialog } from '../DeleteChannelDialog'
import { usePageNotice, useNotify, FormStatus } from '../notices'
import { usePref, byName, ChipGroup, GroupFilter, SortSelect, ListToolbar, ClearFilters, NoMatches } from '../listFilters'
import { RowMenu, Icons, useSelection, SelectCell, SelectAllHead, BulkBar, ConfirmDialog, runBulk, bulkSummary, type MenuItem } from '../listActions'
import { PageHead, NewButton, EntityCell, StatusPill, Preset, RecordingSection, RET_UNIT_SEC, splitDuration, type RetUnit, type PipelineState } from '../scaffold'
import { SourceMetadataButton } from '../SourceMetadata'
import { navigate, useRoute } from '../router'
import { thumbUrl } from '../api'
import { pressable } from '../a11y'
import { TypePicker, MetadataForm } from '../ContentTypeFields'
import { DrawerTabs, TabPane, type DrawerTab } from '../scaffold'
import { RuleEditor } from '../RuleEditor'
import { useAccess, ReadOnlyBadge } from '../access'

/* ============================================================================
   Radio — audio-only stations on the shared design language (same base
   structure and feature placement as Channels and Events). List page here;
   click a station for the detail page (visualiser, now-playing, metadata log).
   See RADIO.md for the workflow decisions this form encodes.
   ========================================================================== */

export const CLASS_CHIP: Record<string, { label: string; bg: string; fg: string }> = {
  song: { label: 'Song', bg: 'rgba(63,123,255,.16)', fg: '#7dabff' },
  ad: { label: 'Ad', bg: 'rgba(251,191,36,.14)', fg: '#fbbf24' },
  content: { label: 'Content', bg: 'rgba(74,222,128,.14)', fg: '#4ade80' },
}
export function ClassChip({ cls }: { cls: string | null }) {
  const c = CLASS_CHIP[cls || ''] || null
  if (!c) return null
  return <span style={{ fontSize: 'var(--fs-micro)', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: c.bg, color: c.fg, textTransform: 'uppercase', letterSpacing: '.04em' }}>{c.label}</span>
}

/** Audio-valid source protocols only (the point of a radio form). */
export const RADIO_PROTOCOLS = ['icecast', 'hls', 'srt']

/** Signal verdict chip: is what we are receiving actually programme audio? */
const SIGNAL: Record<string, { label: string; color: string }> = {
  audio: { label: 'Audio', color: '#4ade80' },
  quiet: { label: 'Low', color: '#fbbf24' },
  silent: { label: 'Dead air', color: '#f87171' },
  static: { label: 'Static', color: '#fb923c' },
  unknown: { label: 'No data', color: '#64748b' },
}
export function SignalChip({ verdict }: { verdict?: string }) {
  const s = SIGNAL[verdict || 'unknown'] ?? SIGNAL.unknown
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)' }}>
      <span style={{ width: 8, height: 8, borderRadius: 999, background: s.color }} />
      <span style={{ color: 'var(--muted)' }}>{s.label}</span>
    </span>
  )
}

/** Roll-up state badge — delegates to the ONE platform definition so a station
 *  and a channel in the same state always look and read the same. */
export function StateTag({ state, onAir, sub }: { state?: string; onAir?: boolean; sub?: string }) {
  return <StatusPill state={(state ?? (onAir ? 'onair' : 'idle')) as PipelineState} sub={sub} />
}

type StationState = 'onair' | 'running' | 'stopped'
/** On air, running but off air, or stopped / idle. */
function stationState(r: RadioStationRow): StationState {
  if (r.status !== 'live') return 'stopped'
  return r.onAir ? 'onair' : 'running'
}
type StationSort = 'name' | 'name_desc' | 'status' | 'group' | 'newest'
const STATION_SORTS: { value: StationSort; label: string }[] = [
  { value: 'name', label: 'Name A to Z' },
  { value: 'name_desc', label: 'Name Z to A' },
  { value: 'status', label: 'Status (on air first)' },
  { value: 'group', label: 'Group' },
  { value: 'newest', label: 'Newest first' },
]
const STATION_ORDER: Record<StationState, number> = { onair: 0, running: 1, stopped: 2 }
function sortStations(rows: RadioStationRow[], sort: StationSort): RadioStationRow[] {
  const r = [...rows]
  const nm = (a: RadioStationRow, b: RadioStationRow) => byName(a.name, b.name)
  switch (sort) {
    case 'name_desc': return r.sort((a, b) => -nm(a, b))
    case 'status': return r.sort((a, b) => STATION_ORDER[stationState(a)] - STATION_ORDER[stationState(b)] || nm(a, b))
    case 'group': return r.sort((a, b) => byName(a.group_name ?? '', b.group_name ?? '') || nm(a, b))
    case 'newest': return r.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || nm(a, b))
    default: return r.sort(nm)
  }
}

export default function Radio() {
  const [rows, setRows] = useState<RadioStationRow[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [groupsLoaded, setGroupsLoaded] = useState(false)
  // NOTICES (notices.tsx): a load failure is held in the page region with
  // Retry; an action's failure or result is raised there once.
  const [loadErr, setLoadErr] = useState('')
  const notify = useNotify()
  const setErr = (m: string) => { if (m) notify({ kind: 'error', message: m }) }
  const [busy, setBusy] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  // /radio?new (New Stream > Radio station) or /radio/new opens the drawer, then the URL is put back.
  const route = useRoute()
  useEffect(() => { if (route.create) { setCreateOpen(true); navigate('/radio', { replace: true }) } }, [route.create])
  // FILTERS AND SORT (listFilters.tsx), remembered in this browser.
  const [filter, setFilter] = usePref<'all' | StationState>('radio.status', 'all', ['all', 'onair', 'running', 'stopped'])
  const [groupId, setGroupId] = usePref<string>('radio.group', '')
  const [sort, setSort] = usePref<StationSort>('radio.sort', 'name', ['name', 'name_desc', 'status', 'group', 'newest'])

  async function load() {
    try { setRows(await api.radioStations()); setLoadErr('') } catch (e: any) { setLoadErr(e.message || 'Could not load stations') }
  }
  useEffect(() => {
    load(); api.groups().then(g => { setGroups(g); setGroupsLoaded(true) }).catch(() => {})
    const t = setInterval(load, 10_000)   // keep now-playing fresh
    return () => clearInterval(t)
  }, [])

  async function startStop(r: RadioStationRow, action: 'start' | 'stop') {
    setBusy(r.id); setErr('')
    try { await api.radioStartStop(r.id, action); await load() }
    catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }

  async function setAir(r: RadioStationRow, on: boolean) {
    setBusy(r.id); setErr('')
    try { await api.radioSetAir(r.id, on); await load() }
    catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }

  const inGroup = (r: RadioStationRow) => !groupId || r.group_id === groupId
  const counts = useMemo(() => {
    const c = (rows || []).filter(inGroup)
    return {
      all: c.length,
      onair: c.filter(r => stationState(r) === 'onair').length,
      running: c.filter(r => stationState(r) === 'running').length,
      off: c.filter(r => stationState(r) === 'stopped').length,
    }
    // eslint-disable-next-line
  }, [rows, groupId])
  const shown = useMemo(() => {
    if (!rows) return []
    const list = rows.filter(r => inGroup(r) && (filter === 'all' || stationState(r) === filter))
    return sortStations(list, sort)
    // eslint-disable-next-line
  }, [rows, filter, groupId, sort])
  const filtered = filter !== 'all' || !!groupId
  const clearFilters = () => { setFilter('all'); setGroupId('') }
  useEffect(() => { if (groupId && groups.length && !groups.some(g => g.id === groupId)) setGroupId('') /* eslint-disable-next-line */ }, [groups, groupId])

  const open = (r: RadioStationRow) => navigate(`/radio/${r.id}`)
  // ACCESS (access.tsx): view = this list and the detail page; operate =
  // start/stop and on/off air; manage = new station and settings.
  const { can, isAdminTier } = useAccess()
  const canRun = can('radio', 'operate')
  const canManage = can('radio', 'manage')
  // SELECTION AND BULK (listActions.tsx): start, stop (confirmed), remove (admins, confirmed).
  const sel = useSelection(shown.map(r => r.id))
  const picked = shown.filter(r => sel.sel.has(r.id))
  const [delId, setDelId] = useState<string | null>(null)
  const [bulkRemove, setBulkRemove] = useState<{ id: string; name: string }[] | null>(null)
  const [confirmStop, setConfirmStop] = useState<RadioStationRow[] | null>(null)
  const [bulkBusy, setBulkBusy] = useState<string | null>(null)
  const setDone = (m: string) => { if (m) notify({ kind: 'ok', message: m }) }
  usePageNotice('load', loadErr ? { kind: 'error', title: "Couldn't load stations.", message: loadErr, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)
  async function bulk(action: 'start' | 'stop', list: RadioStationRow[]) {
    setErr(''); setDone('')
    const verb = action === 'start' ? 'Starting' : 'Stopping'
    setBulkBusy(`${verb} 0 of ${list.length}…`)
    const res = await runBulk(list, r => api.radioStartStop(r.id, action), d => setBulkBusy(`${verb} ${d} of ${list.length}…`))
    setBulkBusy(null)
    const msg = bulkSummary(action === 'start' ? 'Started' : 'Stopped', res)
    if (res.failed.length) setErr(msg); else setDone(msg)
    sel.clear(); load()
  }
  function menuFor(r: RadioStationRow): MenuItem[] {
    const items: MenuItem[] = [{ key: 'view', label: 'View', icon: Icons.view, onSelect: () => open(r) }]
    if (canManage) items.push({ key: 'edit', label: 'Edit settings', icon: Icons.settings, onSelect: () => navigate(`/radio/${r.id}?settings`) })
    if (isAdminTier) items.push({ key: 'remove', label: 'Remove', icon: Icons.remove, danger: true, separator: true,
      disabledReason: r.status === 'live' ? 'Stop the station first' : null, onSelect: () => { setDone(''); setDelId(r.id) } })
    return items
  }
  const toStart = picked.filter(r => r.status !== 'live')
  const toStop = picked.filter(r => r.status === 'live')
  // Over the limit, no create: the reason is shown beside the button.
  const [plan, setPlan] = useState<PlanView | null>(null)
  useEffect(() => { api.plan().then(setPlan).catch(() => {}) }, [rows?.length])
  const noRoom = rows === null || !groupsLoaded ? null : (planFullReason(plan, 'station') ?? noRoomReason(groups, 'station'))
  usePageNotice('limit', noRoom ? { kind: 'warn', title: 'New stations are unavailable.', message: noRoom } : null)

  return (
    <>
      <PageHead title="Radio" sub="Audio-only stations: MP3, HLS and DASH out, Icecast in, and a timed now-playing log for search and clipping." />
      {rows === null ? (
        loadErr ? null : <div className="loading">Loading stations…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 11h16a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" /><circle cx="8" cy="15.5" r="2.5" /><path d="M17 14h2M17 17h2M18 3 7 8" /></svg></div>
          <h3>No stations yet</h3>
          <p>Create a station from an Icecast mount, or from HLS or SRT audio. Paste the stream address from your encoder or playout system.</p>
          {canManage && (
            <button className="btn primary" onClick={() => setCreateOpen(true)} style={{ margin: '0 auto' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
              Create your first station
            </button>
          )}
        </div>
      ) : (
        <>
          <ListToolbar
            left={<>
              <ChipGroup label="Status" value={filter} onChange={setFilter} options={[
                { value: 'all', label: 'All', n: counts.all },
                { value: 'onair', label: 'On air', n: counts.onair },
                { value: 'running', label: 'Running, off air', n: counts.running },
                { value: 'stopped', label: 'Stopped / idle', n: counts.off },
              ]} />
              <ClearFilters on={filtered} onClear={clearFilters} />
            </>}
            right={<>
              <GroupFilter groups={groups} value={groupId} onChange={setGroupId} />
              <SortSelect value={sort} onChange={setSort} options={STATION_SORTS} />
              <span className="tb-sep" aria-hidden="true" />
              {canManage ? <NewButton label="New station" onClick={() => setCreateOpen(true)} blockedReason={noRoom} /> : <ReadOnlyBadge feature="radio" />}
            </>} />
          <BulkBar count={picked.length} noun={['station', 'stations']} onClear={sel.clear} busy={bulkBusy} actions={[
            ...(canRun ? [
              { key: 'start', label: 'Start', icon: Icons.start, count: toStart.length, onRun: () => bulk('start', toStart),
                hint: toStart.length ? undefined : 'All of them are running already' },
              { key: 'stop', label: 'Stop', icon: Icons.stop, count: toStop.length, onRun: () => setConfirmStop(toStop),
                hint: toStop.length ? undefined : 'None of them are running' },
            ] : []),
            ...(isAdminTier ? [{ key: 'remove', label: 'Remove', icon: Icons.remove, danger: true, count: toStart.length,
              onRun: () => { setDone(''); setBulkRemove(toStart.map(r => ({ id: r.id, name: r.name }))) },
              hint: toStart.length ? (toStart.length < picked.length ? 'Running stations are left out: stop them first' : undefined) : 'Stop them first' }] : []),
          ]} />
          {shown.length === 0 ? <div className="card"><NoMatches what="stations" onClear={clearFilters} /></div> : (
          <div className="card">
            <table>
              <thead><tr><SelectAllHead allOn={sel.allOn} someOn={sel.someOn} onToggle={sel.toggleAll} label="Select all stations" /><th>Station</th><th>Now playing</th><th>Signal</th><th>Outputs</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {shown.map((r, i) => {
                  const live = r.status === 'live'
                  const outs = [r.outputs.mp3 && 'MP3', r.outputs.hls && 'HLS', r.outputs.dash && 'DASH'].filter(Boolean).join(' · ')
                  // The server's resolved line (services/radio/nowPlaying.ts), as on
                  // the station page: "Untitled break" only for a source that can
                  // send titles. An HLS source with none would otherwise read as a
                  // metadata fault. no_metadata shows the dash: its text is the
                  // station name, already in the next column. The raw title is the
                  // fallback for an older API that sends no view.
                  const nowView = r.nowPlayingView
                  const nowText = nowView
                    ? (nowView.kind === 'no_metadata' || nowView.kind === 'off' ? null : nowView.text)
                    : (r.nowPlaying != null ? (r.nowPlaying || 'Untitled break') : null)
                  return (
                    <tr key={r.id} className={sel.sel.has(r.id) ? 'selected' : undefined} onClick={() => open(r)} style={{ cursor: 'pointer' }}>
                      <SelectCell on={sel.sel.has(r.id)} onToggle={() => sel.toggle(r.id)} label={`Select ${r.name}`} />
                      <td><EntityCell name={r.name} sub={r.group_name} index={i}
                        imgUrl={r.brand_ref ? thumbUrl(r.brand_ref, 80, 80, 'cover') : undefined} /></td>
                      <td style={{ maxWidth: 230 }}>
                        {live && nowText != null ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nowText}</span>
                            <ClassChip cls={nowView && nowView.kind !== 'icy' ? null : r.nowPlayingClass} />
                          </div>
                        ) : <span style={{ color: 'var(--faint)' }}>—</span>}
                      </td>
                      <td>{live ? <SignalChip verdict={r.signal} /> : <span style={{ color: 'var(--faint)' }}>—</span>}</td>
                      <td style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{outs} · {r.radio_config?.bitrateKbps ?? 128}k</td>
                      <td><StateTag state={r.pipelineState} onAir={r.onAir}
                        sub={live && r.pipeline.running ? `${r.pipeline.listeners ?? 0} listener${(r.pipeline.listeners ?? 0) === 1 ? '' : 's'}` : undefined} /></td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                        {/* two steps, like channels: run it, then publish it; "⋯" for the rest */}
                        <div className="row-actions">
                        {!canRun ? <button className="btn act primary" onClick={() => open(r)}>Open</button> : live
                          ? <>
                              {r.onAir
                                ? <button className="btn act ghost" style={{ color: 'var(--warn)' }} disabled={busy === r.id} onClick={() => setAir(r, false)}>{busy === r.id ? '…' : 'Off air'}</button>
                                : <button className="btn act primary" disabled={busy === r.id} onClick={() => setAir(r, true)}>{busy === r.id ? '…' : 'Go on air'}</button>}
                              <button className="btn act ghost" disabled={busy === r.id} onClick={() => startStop(r, 'stop')}>Stop</button>
                            </>
                          : <button className="btn act primary" disabled={busy === r.id || !!bulkBusy} onClick={() => startStop(r, 'start')}>{busy === r.id ? '…' : 'Start'}</button>}
                          <RowMenu label={`More actions for ${r.name}`} items={menuFor(r)} />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          )}
        </>
      )}
      {delId && <DeleteChannelDialog id={delId} onClose={() => setDelId(null)}
        onDeleted={(name) => { setDelId(null); setDone(`${name} was removed. The removal is in the audit log.`); load() }} />}
      {bulkRemove && <BulkRemoveDialog rows={bulkRemove} what="station" onClose={() => setBulkRemove(null)}
        onDone={(summary) => { setBulkRemove(null); sel.clear(); setDone(`${summary} Each removal is in the audit log.`); load() }} />}
      {confirmStop && (
        <ConfirmDialog title={`Stop ${confirmStop.length} station${confirmStop.length === 1 ? '' : 's'}?`} confirmLabel="Stop" danger
          body={<>
            <p style={{ margin: '0 0 6px' }}>They go off air and listeners lose the stream. They can be started again.</p>
            <ul className="bulk-list">{confirmStop.map(r => <li key={r.id}>{r.name}</li>)}</ul>
          </>}
          onCancel={() => setConfirmStop(null)} onConfirm={() => { const list = confirmStop; setConfirmStop(null); bulk('stop', list) }} />
      )}
      {createOpen && <RadioDrawer groups={groups} onClose={() => setCreateOpen(false)} onDone={(id) => { setCreateOpen(false); id ? navigate(`/radio/${id}`) : load() }} />}
    </>
  )
}

/* --------------------------------------------- create / settings drawer.
   Same section order as channels/events: Name → Type → Source → Outputs →
   Metadata log → Recording → Transcription. Exported for the detail page. */
export function RadioDrawer({ groups, station, onClose, onDone }: {
  groups: Group[]
  station?: {
    id: string; name: string; version: number; brand_ref?: string | null; guide_icon_ref?: string | null
    schema_id?: string | null; metadata?: Record<string, any>
    radio_config: RadioCfg | null; recording_enabled?: boolean
    recording_retention_sec?: number | string | null
    sources?: { role: string; protocol: string; ingest_url: string | null; stream_key?: string | null }[]
    status?: string
  }
  onClose: () => void
  onDone: (createdId?: string) => void
}) {
  const isEdit = !!station
  const protocols = useProtocols()
  const radioProtocols = useMemo(
    () => protocols.filter(p => RADIO_PROTOCOLS.includes(p.id)),
    [protocols])
  const cfg = station?.radio_config ?? {}
  const [name, setName] = useState(station?.name ?? '')
  // CONTENT TYPE: a station always has one (Radio station by default); its
  // metadata is the base entry when nothing is scheduled or playing.
  const [tab, setTab] = useState<DrawerTab>('settings')
  const [typeId, setTypeId] = useState<string | null>(station?.schema_id ?? null)
  const [meta, setMeta] = useState<Record<string, any>>(station?.metadata ?? {})
  // Packaging is the default; transcode exists to change bitrate or format.
  const [transcode, setTranscode] = useState(cfg.transcode === true)
  const src0 = station?.sources?.find(s => s.role === 'primary')
  const [primary, setPrimary] = useState<SourceValue>({
    protocol: (src0?.protocol || 'icecast').toLowerCase(),
    url: src0?.ingest_url || '', streamKey: src0?.stream_key || undefined,
  })
  const [outMp3, setOutMp3] = useState(cfg.outputs?.mp3 !== false)
  const [outHls, setOutHls] = useState(cfg.outputs?.hls !== false)
  const [outDash, setOutDash] = useState(cfg.outputs?.dash !== false)
  const [bitrate, setBitrate] = useState(cfg.bitrateKbps ?? 128)
  const [metaCapture, setMetaCapture] = useState(cfg.metadataCapture !== false)
  const [transcription, setTranscription] = useState(cfg.transcription === true)
  const [artRef, setArtRef] = useState(station?.brand_ref || '')
  const [guideIcon, setGuideIcon] = useState(station?.guide_icon_ref || '')
  const [recOn, setRecOn] = useState(station ? station.recording_enabled !== false : true)
  const initRet = splitDuration(station?.recording_retention_sec != null ? Number(station.recording_retention_sec) : null)
  const [retNum, setRetNum] = useState(isEdit ? initRet.n : '')
  const [retUnit, setRetUnit] = useState<RetUnit>(initRet.unit)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const isIcecast = primary.protocol === 'icecast'
  // A station goes into the first group with room (packaging groups first).
  const ordered = [...groups.filter(g => g.workflow_type === 'package_only'), ...groups.filter(g => g.workflow_type !== 'package_only')]
  const target = ordered.find(g => !isFull(g)) ?? ordered[0]
  const groupId = target?.id ?? ''
  const blocked = isEdit ? null : !target ? 'This account has no group yet, so a station cannot be created.' : isFull(target) ? fullReason(target) : null

  // NOTHING FAILS SILENTLY: anything thrown before the request is shown too.
  async function submit() {
    setErr('')
    try { await submitInner() }
    catch (e: any) {
      const msg = String(e?.message || '').trim()
      setErr(msg && msg !== 'ValidationError' ? msg : 'The station could not be saved. Check the fields and try again.')
      setBusy(false)
    }
  }

  async function submitInner() {
    if (!name.trim()) { setErr('Give the station a name'); return }
    if (!isEdit && !primary.url.trim()) { setErr('Add the source stream URL'); return }
    if (!isEdit && !groupId) { setErr('No group set up yet'); return }
    if (!outMp3 && !outHls && !outDash) { setErr('Enable at least one output'); return }
    const hlsWait = await hlsChoicePending([{ url: primary.url, protocol: primary.protocol, original: src0?.ingest_url }]); if (hlsWait) { setErr(hlsWait); return }
    const radio: RadioCfg = {
      outputs: { mp3: outMp3, hls: outHls, dash: outDash },
      bitrateKbps: bitrate,
      metadataCapture: isIcecast ? metaCapture : false,
      transcode,
      transcription: isIcecast ? transcription : false,
    }
    const retention = recOn && retNum ? Number(retNum) * RET_UNIT_SEC[retUnit] : null
    const sources = primary.url.trim()
      ? [{ role: 'primary' as const, protocol: primary.protocol, ingestUrl: primary.url.trim(), streamKey: primary.streamKey?.trim() || undefined }]
      : []
    setBusy(true)
    try {
      if (isEdit) {
        await api.updateChannel(station!.id, {
          name: name.trim(), radio, recordingEnabled: recOn, recordingRetentionSec: retention,
          ...(sources.length ? { sources } : {}), brandRef: artRef.trim() || null, guideIconRef: guideIcon.trim() || null,
          ...(typeId ? { schemaId: typeId, metadata: meta } : {}),
          version: station!.version,
        } as any)
        onDone()
      } else {
        const ch = await api.createChannel({
          groupId, name: name.trim(), kind: 'radio', radio,
          recordingEnabled: recOn, recordingRetentionSec: retention,
          sources, brandRef: artRef.trim() || null, guideIconRef: guideIcon.trim() || null,
          ...(typeId ? { schemaId: typeId, metadata: meta } : {}),
        })
        onDone(ch.id)
      }
    } catch (e: any) {
      if (/version|match|409/i.test(String(e.message))) setErr('This station changed since you opened it. Reopen and retry.')
      else setErr(e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="">
      <div className="drawer" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="">
        <div className="drawer-h"><div className="t">{isEdit ? 'Station settings' : 'New station'}</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          <DrawerTabs tab={tab} setTab={setTab} />
          <TabPane active={tab === 'metadata'}>
            <TypePicker appliesTo="radio" value={typeId} onChange={(id) => setTypeId(id)}
              hint="The station's identity (schema.org RadioStation). Its metadata is what the guide and now/next show when nothing is scheduled." />
            <MetadataForm typeId={typeId} value={meta} onChange={setMeta} entityName={{ value: name, where: 'station' }} hide={['logo']} />
            <GuideIconField what="station" value={guideIcon} onChange={setGuideIcon} brandRef={artRef} />
          </TabPane>
          <TabPane active={tab === 'access'}>
            {isEdit
              ? <RuleEditor scopeKind="owner" scopeId={station!.id} compact resolveQuery={{ channelId: station!.id, schemaId: typeId }} />
              : <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>Create the station first; its publishing and access rules are set here afterwards. Until then it inherits its content type's and the account's rules.</div>}
          </TabPane>
          <TabPane active={tab === 'settings'}>
          <div className="field"><label>Station name <span className="req">*</span></label>
            <input className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Coast FM" />
          </div>
          <ImageRefField label="Station artwork" hint="shown on the detail page, the player and the guide"
            value={artRef} onChange={setArtRef} pickerTitle="Choose or upload station artwork" />

          <div className="field"><label>Type</label>
            <div className="presets">
              <Preset sel={!transcode} onClick={() => setTranscode(false)} title="Packaging"
                desc="Repackage the source audio as-is. The default for radio." meta="copy where possible" />
              <Preset sel={transcode} onClick={() => setTranscode(true)} title="Transcode"
                desc="Only needed to change the bitrate or format of the source." meta="re-encode at the bitrate below" />
            </div>
          </div>

          <div className="sec-label">Source</div>
          <SourceInput protocols={radioProtocols} value={primary} onChange={setPrimary} label="Audio source" validate={false} />
          {/* The stream already announces its name, genre, bitrate, codec and
              often a logo. Read it here and adopt what is useful, rather than
              retyping it from the station's website. */}
          <div className="flex items-center gap-2" style={{ marginTop: 8 }}>
            <SourceMetadataButton url={primary.url} targets={{
              onName: (v) => setName(v),
              onArtwork: (v) => setArtRef(v),
              onBitrate: (v) => setBitrate(v),
              onUrl: (v) => setPrimary(p => ({ ...p, url: v })),
            }} />
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>
              Reads the stream's own name, genre, bitrate and artwork. Nothing is saved until you apply it.
            </span>
          </div>
          {isIcecast && <div className="hintxt">Icecast mounts carry now-playing (ICY) metadata: enable the log below to capture it.</div>}

          <div className="sec-label">Outputs — single bitrate</div>
          <div className="toggle-row"><div><div className="tt">MP3 stream</div><div className="td">Universal HTTP audio (hardware receivers, old apps, VLC). Now-playing titles pass through.</div></div>
            <div className={`sw ${outMp3 ? '' : 'off'}`} {...pressable((e: any) => { ((() => setOutMp3(v => !v)) as any)(e) })} data-a11y-click=""><i /></div></div>
          <div className="toggle-row"><div><div className="tt">HLS (audio-only)</div><div className="td">Apple and modern web players; also what recording and clipping use.</div></div>
            <div className={`sw ${outHls ? '' : 'off'}`} {...pressable((e: any) => { ((() => setOutHls(v => !v)) as any)(e) })} data-a11y-click=""><i /></div></div>
          <div className="toggle-row"><div><div className="tt">DASH</div><div className="td">Android and TV stacks.</div></div>
            <div className={`sw ${outDash ? '' : 'off'}`} {...pressable((e: any) => { ((() => setOutDash(v => !v)) as any)(e) })} data-a11y-click=""><i /></div></div>
          <div className="field"><label>Output bitrate</label>
            <select className="inp" value={bitrate} onChange={e => setBitrate(Number(e.target.value))}>
              {[64, 96, 128, 192, 256, 320].map(b => <option key={b} value={b}>{b} kbps</option>)}
            </select>
            <div className="hintxt">Radio is single bitrate by design: no ladder to manage. Packaging keeps the source bitrate for MP3 when the source is already MP3.</div>
          </div>

          {isIcecast && (
            <>
              <div className="sec-label">Metadata log</div>
              <div className="toggle-row">
                <div><div className="tt">Capture now-playing log</div><div className="td">Every ICY title change becomes a timed entry (stored on the programme guide), classified as song, ad or content. Drives search, trimming and clipping.</div></div>
                <div className={`sw ${metaCapture ? '' : 'off'}`} {...pressable((e: any) => { ((() => setMetaCapture(v => !v)) as any)(e) })} data-a11y-click=""><i /></div>
              </div>
            </>
          )}

          <RecordingSection ctx="channel" recOn={recOn} setRecOn={setRecOn}
            retNum={retNum} setRetNum={setRetNum} retUnit={retUnit} setRetUnit={setRetUnit} />

          {isIcecast && (
            <>
              <div className="sec-label">Transcription</div>
              <div className="toggle-row">
                <div><div className="tt">Transcribe speech segments</div><div className="td">Uses the metadata log to transcribe only the parts classified as content (DJ talk, news, interviews). Songs and adverts are skipped. Only offered for Icecast sources, where metadata can tell speech from music.</div></div>
                <div className={`sw ${transcription ? '' : 'off'}`} {...pressable((e: any) => { ((() => setTranscription(v => !v)) as any)(e) })} data-a11y-click=""><i /></div>
              </div>
            </>
          )}
          {!isIcecast && <div className="hintxt" style={{ marginTop: 10 }}>Transcription is available for Icecast sources only: without now-playing metadata there is no way to tell speech from songs and adverts, and transcripts of music are noise.</div>}

          </TabPane>
        </div>
        <div className="drawer-f">
          {/* In the footer, so a problem is seen whichever tab is open. */}
          <FormStatus error={err} blocked={blocked} />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !!blocked} title={blocked ?? ''} onClick={submit}>{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create station'}</button>
        </div>
      </div>
    </div>
  )
}
