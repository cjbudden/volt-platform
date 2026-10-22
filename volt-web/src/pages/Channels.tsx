import { useEffect, useMemo, useState } from 'react'
import { api, thumbUrl, type Group, type PlanView } from '../api'
import { subscribeLive } from '../liveStatus'
import { useProtocols, SourceInput, hlsChoicePending, sourceProblem, sourceToApi, type SourceValue } from '../protocols'
import { ImageRefField, GuideIconField } from '../ImageRefField'
import { LangPicker, useCaptionLanguages } from '../LangPicker'
import DeleteChannelDialog, { BulkRemoveDialog } from '../DeleteChannelDialog'
import { RowMenu, Icons, useSelection, SelectCell, SelectAllHead, BulkBar, ConfirmDialog, runBulk, bulkSummary, type MenuItem } from '../listActions'
import { navigate } from '../router'
import { usePref, byName, ChipGroup, GroupFilter, SortSelect, ListToolbar, ClearFilters, NoMatches } from '../listFilters'
import { usePageNotice, useNotify, FormStatus } from '../notices'
import { isFull, fullReason, groupLabel, noRoomReason, pickGroup, planFullReason } from '../lib/capacity'
import { PackageRenditions, pkgToSources, DEFAULT_PKG_ROWS, type PkgRow, type PkgFallback } from '../PackageRenditions'
import { PageHead, NewButton, EntityCell, StatusTag, Preset, RecordingSection, RET_UNIT_SEC, type RetUnit } from '../scaffold'
import { useAccess, ReadOnlyBadge } from '../access'
import { pressable } from '../a11y'
import { TypePicker, MetadataForm } from '../ContentTypeFields'
import { DrawerTabs, TabPane, type DrawerTab } from '../scaffold'
import { WatermarkFields, wmDefaults, wmPatch, wmProblem, type WmForm } from '../WatermarkFields'
import { FillerField } from '../FillerField'

type Props = { createOpen: boolean; setCreateOpen: (v: boolean) => void; onOpen?: (id: string) => void }

/** Format retention for the list: prefer the real seconds value (minutes..months),
 *  fall back to the legacy days field. e.g. 3600s -> "1h", not "1d". */
function fmtRetention(sec?: number | null, days?: number | null): string {
  if (sec != null && sec > 0) {
    for (const [u, l] of [[2592000, 'mo'], [604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']] as [number, string][]) {
      if (sec % u === 0 && sec >= u) return `${sec / u}${l}`
    }
    return `${Math.max(1, Math.round(sec / 60))}m`
  }
  return days != null && days > 0 ? `${days}d` : '—'
}

export default function Channels({ createOpen, setCreateOpen, onOpen }: Props) {
  // ACCESS (access.tsx): manage = create; operate = start/stop (in the table).
  const { can } = useAccess()
  const canManage = can('channels', 'manage')
  const [channels, setChannels] = useState<any[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  // FILTERS AND SORT (listFilters.tsx), remembered in this browser.
  const [filter, setFilter] = usePref<'all' | 'transcode' | 'package_only'>('channels.type', 'all', ['all', 'transcode', 'package_only'])
  const [stat, setStat] = usePref<'all' | RunState>('channels.status', 'all', ['all', 'running', 'stopped', 'problem'])
  const [groupId, setGroupId] = usePref<string>('channels.group', '')
  const [sort, setSort] = usePref<ChannelSort>('channels.sort', 'name', ['name', 'name_desc', 'status', 'group', 'newest'])
  const [err, setErr] = useState('')

  // This is the app's DEFAULT route, and it had no error path at all: `load()`
  // was uncaught, so a user whose group sets channels to 'none' — or any 500 —
  // left "Loading channels…" on screen forever while an unhandled rejection
  // fired every six seconds for the life of the tab.
  async function load() {
    try {
      // live only: FAST (playlist) channels are listed and run under FAST channels
      const [chs, gs] = await Promise.all([api.channels('tv', 'live'), api.groups()])
      const gmap = new Map(gs.map(g => [g.id, g]))
      setChannels(chs.map(c => ({ ...c, _g: gmap.get(c.group_id) })))
      setGroups(gs)
      setErr('')
    } catch (e: any) {
      setErr(e?.forbidden ? 'Your access does not include channels.' : (e?.message || 'Could not load channels'))
    }
  }
  useEffect(() => { load() }, [])
  // live: refresh the list on any stream status/event change (one shared SSE socket)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const refetch = () => { if (t) return; t = setTimeout(() => { t = null; load() }, 500) }
    const unsub = subscribeLive('*', refetch)
    return () => { if (t) clearTimeout(t); unsub() }
  }, [])
  // ground-truth transitions (e.g. Starting -> Ready when the manifest starts advancing)
  // aren't always a discrete SSE event, so reconcile gently so the list stays honest+live.
  useEffect(() => {
    const iv = setInterval(() => load(), 6000)
    return () => clearInterval(iv)
  }, [])

  // OVER THE LIMIT, NO CREATE. Only once the groups are known (an empty list
  // while loading must not read as "no group").
  const tvGroups = groups.filter(g => g.workflow_type === 'transcode' || g.workflow_type === 'package_only')
  // THE PLAN FIRST (Admin > Plan & limits), then the groups' shares.
  const [plan, setPlan] = useState<PlanView | null>(null)
  useEffect(() => { api.plan().then(setPlan).catch(() => {}) }, [channels?.length])
  const noRoom = channels === null ? null : (planFullReason(plan, 'channel') ?? noRoomReason(tvGroups, 'channel'))
  // Standard places (notices.tsx): why New channel is unavailable, and a load
  // failure with Retry, both in the page notice region.
  const radioInFull = tvGroups.some(g => (g.radio_count ?? 0) > 0)
  usePageNotice('limit', noRoom ? {
    kind: 'warn', title: 'New channels are unavailable.', message: noRoom,
    actions: [...(radioInFull ? [{ label: 'View radio stations', onClick: () => navigate('/radio') }] : []), { label: 'Plan & limits', onClick: () => navigate('/plan') }],
  } : null)
  usePageNotice('load', err ? {
    kind: 'error', title: "Couldn't load channels.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }],
  } : null)

  // Each chip set counts what the OTHER filters leave, so the numbers match
  // what clicking the chip would show.
  const typeOk = (c: any, f = filter) => f === 'all' || c._g?.workflow_type === f
  const statOk = (c: any, f = stat) => f === 'all' || runState(c) === f
  const groupOk = (c: any) => !groupId || c.group_id === groupId
  const shown = useMemo(() => {
    if (!channels) return channels
    const rows = channels.filter(c => typeOk(c) && statOk(c) && groupOk(c))
    return sortChannels(rows, sort)
    // eslint-disable-next-line
  }, [channels, filter, stat, groupId, sort])
  const counts = useMemo(() => {
    const c = channels || []
    const forType = c.filter(x => statOk(x) && groupOk(x))
    const forStat = c.filter(x => typeOk(x) && groupOk(x))
    return {
      all: forType.length,
      transcode: forType.filter(x => typeOk(x, 'transcode')).length,
      package_only: forType.filter(x => typeOk(x, 'package_only')).length,
      sAll: forStat.length,
      running: forStat.filter(x => runState(x) === 'running').length,
      stopped: forStat.filter(x => runState(x) === 'stopped').length,
      problem: forStat.filter(x => runState(x) === 'problem').length,
    }
    // eslint-disable-next-line
  }, [channels, filter, stat, groupId])
  const filtered = filter !== 'all' || stat !== 'all' || !!groupId
  const clearFilters = () => { setFilter('all'); setStat('all'); setGroupId('') }
  // a remembered group that no longer exists is dropped
  useEffect(() => { if (groupId && groups.length && !groups.some(g => g.id === groupId)) setGroupId('') /* eslint-disable-next-line */ }, [groups, groupId])

  return (
    <>
      <PageHead title="Channels" sub="24×7 live channels. Transcode builds the rendition ladder for you; packaging takes a pre-encoded ladder." />


      {channels === null ? (
        err ? null : <div className="loading">Loading channels…</div>
      ) : channels.length === 0 ? (
        <EmptyState onCreate={canManage && !noRoom ? () => setCreateOpen(true) : undefined} />
      ) : (
        <>
          <ListToolbar
            left={<>
              <ChipGroup label="Type" value={filter} onChange={setFilter} options={[
                { value: 'all', label: 'All', n: counts.all },
                { value: 'transcode', label: 'Transcode', n: counts.transcode },
                { value: 'package_only', label: 'Packaging', n: counts.package_only },
              ]} />
              <ChipGroup label="Status" value={stat} onChange={setStat} options={[
                { value: 'all', label: 'All', n: counts.sAll },
                { value: 'running', label: 'Running', n: counts.running },
                { value: 'stopped', label: 'Stopped / idle', n: counts.stopped },
                ...(counts.problem || stat === 'problem' ? [{ value: 'problem' as const, label: 'Problems', n: counts.problem }] : []),
              ]} />
              <ClearFilters on={filtered} onClear={clearFilters} />
            </>}
            right={<>
              <GroupFilter groups={groups} value={groupId} onChange={setGroupId} />
              <SortSelect value={sort} onChange={setSort} options={CHANNEL_SORTS} />
              <span className="tb-sep" aria-hidden="true" />
              {canManage ? <NewButton label="New channel" onClick={() => setCreateOpen(true)} blockedReason={noRoom} /> : <ReadOnlyBadge feature="channels" />}
            </>} />
          {shown && shown.length === 0
            ? <div className="card"><NoMatches what="channels" onClear={clearFilters} /></div>
            : <ChannelTable channels={shown || []} onChanged={load} onOpen={onOpen} />}
        </>
      )}

      {createOpen && canManage && (
        <CreateChannel groups={groups} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); load() }} />
      )}
    </>
  )
}

function EmptyState({ onCreate }: { onCreate?: () => void }) {
  return (
    <div className="empty">
      <div className="ic">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="13" rx="2" /><path d="m17 2-5 5-5-5" /></svg>
      </div>
      <h3>No channels yet</h3>
      <p>Create your first channel to start a live stream. You can make a transcode channel — we build the ABR ladder — or a packaging channel, where you send a pre-encoded ladder and we package it.</p>
      {onCreate && (
      <button className="btn primary" onClick={onCreate} style={{ margin: '0 auto' }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
        Create your first channel
      </button>
      )}
    </div>
  )
}

type RunState = 'running' | 'stopped' | 'problem'
/** Running (encoder up), stopped / idle, or a problem (error or degraded). */
export function runState(c: any): RunState {
  const ps = c.pipelineState
  if (ps === 'error' || ps === 'degraded') return 'problem'
  if (c.status === 'live' || ps === 'onair' || ps === 'ready' || ps === 'starting') return 'running'
  return 'stopped'
}
type ChannelSort = 'name' | 'name_desc' | 'status' | 'group' | 'newest'
const CHANNEL_SORTS: { value: ChannelSort; label: string }[] = [
  { value: 'name', label: 'Name A to Z' },
  { value: 'name_desc', label: 'Name Z to A' },
  { value: 'status', label: 'Status (running first)' },
  { value: 'group', label: 'Group' },
  { value: 'newest', label: 'Newest first' },
]
const STATE_ORDER: Record<RunState, number> = { running: 0, problem: 1, stopped: 2 }
function sortChannels(rows: any[], sort: ChannelSort): any[] {
  const r = [...rows]
  const nm = (a: any, b: any) => byName(a.name, b.name)
  switch (sort) {
    case 'name_desc': return r.sort((a, b) => -nm(a, b))
    case 'status': return r.sort((a, b) => STATE_ORDER[runState(a)] - STATE_ORDER[runState(b)] || nm(a, b))
    case 'group': return r.sort((a, b) => byName(a._g?.name ?? '', b._g?.name ?? '') || nm(a, b))
    case 'newest': return r.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || nm(a, b))
    default: return r.sort(nm)
  }
}

function ChannelTable({ channels, onChanged, onOpen }: { channels: any[]; onChanged: () => void; onOpen?: (id: string) => void }) {
  // ACCESS: operate = start/stop (one or many); manage = edit settings;
  // administrators remove (one or many, always confirmed).
  const { can, isAdminTier } = useAccess()
  const canRun = can('channels', 'operate')
  const canManage = can('channels', 'manage')
  const [busy, setBusy] = useState<string | null>(null)
  const notify = useNotify()
  const setErr = (m: string) => { if (m) notify({ kind: 'error', message: m }) }
  const setDone = (m: string) => { if (m) notify({ kind: 'ok', message: m }) }
  const [delId, setDelId] = useState<string | null>(null)
  const [bulkRemove, setBulkRemove] = useState<{ id: string; name: string }[] | null>(null)
  const [confirmStop, setConfirmStop] = useState<any[] | null>(null)
  const [bulkBusy, setBulkBusy] = useState<string | null>(null)
  const sel = useSelection(channels.map(c => c.id))
  const picked = channels.filter(c => sel.sel.has(c.id))
  const isLive = (c: any) => c.status === 'live'
  const view = (id: string) => onOpen ? onOpen(id) : navigate(`/channels/${id}`)

  // try/finally with no catch: a viewer pressing Start watched the button
  // flicker to "…" and back with no explanation at all, and the rejection went
  // to the console. Starting a channel is not a silent operation.
  async function toggle(c: any) {
    setBusy(c.id); setErr('')
    try { await api.startStop(c.id, isLive(c) ? 'stop' : 'start'); await onChanged() }
    catch (e: any) {
      setErr(`${c.name}: ${e?.forbidden ? 'you do not have permission to do that' : (e?.message || 'failed')}`)
    }
    finally { setBusy(null) }
  }

  async function bulk(action: 'start' | 'stop', rows: any[]) {
    setErr(''); setDone('')
    const verb = action === 'start' ? 'Starting' : 'Stopping'
    setBulkBusy(`${verb} 0 of ${rows.length}…`)
    const res = await runBulk(rows, r => api.startStop(r.id, action), d => setBulkBusy(`${verb} ${d} of ${rows.length}…`))
    setBulkBusy(null)
    const msg = bulkSummary(action === 'start' ? 'Started' : 'Stopped', res)
    if (res.failed.length) setErr(msg); else setDone(msg)
    sel.clear(); onChanged()
  }

  function menuFor(c: any): MenuItem[] {
    const items: MenuItem[] = [{ key: 'view', label: 'View', icon: Icons.view, onSelect: () => view(c.id) }]
    if (canManage) items.push({ key: 'edit', label: 'Edit settings', icon: Icons.settings, onSelect: () => navigate(`/channels/${c.id}?settings`) })
    if (isAdminTier) items.push({
      key: 'remove', label: 'Remove', icon: Icons.remove, danger: true, separator: true,
      disabledReason: isLive(c) ? 'Stop the channel first' : null,
      onSelect: () => { setDone(''); setDelId(c.id) },
    })
    return items
  }

  const toStart = picked.filter(c => !isLive(c))
  const toStop = picked.filter(isLive)
  const toRemove = picked.filter(c => !isLive(c))

  return (
    <>
      <BulkBar count={picked.length} noun={['channel', 'channels']} onClear={sel.clear} busy={bulkBusy} actions={[
        ...(canRun ? [
          { key: 'start', label: 'Start', icon: Icons.start, count: toStart.length, onRun: () => bulk('start', toStart),
            hint: toStart.length ? undefined : 'All of them are running already' },
          { key: 'stop', label: 'Stop', icon: Icons.stop, count: toStop.length, onRun: () => setConfirmStop(toStop),
            hint: toStop.length ? undefined : 'None of them are running' },
        ] : []),
        ...(isAdminTier ? [{ key: 'remove', label: 'Remove', icon: Icons.remove, danger: true, count: toRemove.length,
          onRun: () => { setDone(''); setBulkRemove(toRemove.map(c => ({ id: c.id, name: c.name }))) },
          hint: toRemove.length ? (toRemove.length < picked.length ? 'Running channels are left out: stop them first' : undefined) : 'Stop them first' }] : []),
      ]} />
    <div className="card">
      {delId && <DeleteChannelDialog id={delId} onClose={() => setDelId(null)}
        onDeleted={(name) => { setDelId(null); setDone(`${name} was removed. The removal is in the audit log.`); onChanged() }} />}
      {bulkRemove && <BulkRemoveDialog rows={bulkRemove} what="channel" onClose={() => setBulkRemove(null)}
        onDone={(summary) => { setBulkRemove(null); sel.clear(); setDone(`${summary} Each removal is in the audit log.`); onChanged() }} />}
      {confirmStop && (
        <ConfirmDialog title={`Stop ${confirmStop.length} channel${confirmStop.length === 1 ? '' : 's'}?`} confirmLabel="Stop" danger
          body={<>
            <p style={{ margin: '0 0 6px' }}>Their encoders come down and viewers lose the stream. They can be started again.</p>
            <ul className="bulk-list">{confirmStop.map(c => <li key={c.id}>{c.name}</li>)}</ul>
          </>}
          onCancel={() => setConfirmStop(null)} onConfirm={() => { const rows = confirmStop; setConfirmStop(null); bulk('stop', rows) }} />
      )}
      <table>
        <thead>
          <tr>
            <SelectAllHead allOn={sel.allOn} someOn={sel.someOn} onToggle={sel.toggleAll} label="Select all channels" />
            <th>Channel</th>
            <th>Type</th>
            <th>Renditions</th>
            <th>Status</th>
            <th>Retention</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {channels.map((c, i) => {
            const wt = c._g?.workflow_type
            const live = isLive(c)
            const on = sel.sel.has(c.id)
            return (
              <tr key={c.id} className={on ? 'selected' : undefined} onClick={() => view(c.id)} style={{ cursor: 'pointer' }}>
                <SelectCell on={on} onToggle={() => sel.toggle(c.id)} label={`Select ${c.name}`} />
                <td><EntityCell name={c.name} sub={c._g?.name} index={i} imgUrl={c.brand_ref ? thumbUrl(c.brand_ref, 80, 80, 'inside') : null} /></td>
                <td>
                  <span className={`tag type ${wt === 'transcode' ? 'chan' : 'event'}`}>
                    {wt === 'transcode' ? 'Transcode' : wt === 'package_only' ? 'Packaging' : '—'}
                  </span>
                </td>
                <td style={{ color: 'var(--muted)' }}>
                  {wt === 'transcode'
                    ? ((c.output_ladder && c.output_ladder.length ? c.output_ladder : c._g?.rungs) || []).map((r: any) => `${r.height}p`).join(' · ') || '—'
                    : 'source ladder'}
                </td>
                <td>
                  {(() => {
                    const ps = c.pipelineState
                    // same overall roll-up as the detail page — one consistent status.
                    const map: Record<string, { label: string; cls: string }> = {
                      onair: { label: 'On air', cls: 'live' },
                      ready: { label: 'Ready', cls: 'sched' },
                      starting: { label: 'Starting', cls: 'sched' },
                      degraded: { label: 'Degraded', cls: 'warn' },
                      error: { label: 'Error', cls: 'down' },
                      stopped: { label: 'Stopped', cls: 'idle' },
                      idle: { label: 'Idle', cls: 'idle' },
                    }
                    const m = (ps && map[ps]) || (live ? map.starting : c.status === 'scheduled' ? { label: 'Scheduled', cls: 'sched' } : map.idle)
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <StatusTag label={m.label} cls={m.cls} />
                        {c.billable && <span title="encoder up (billable)" style={{ fontSize: 'var(--fs-micro)', color: '#fbbf24' }}>● billable</span>}
                      </div>
                    )
                  })()}
                </td>
                <td style={{ color: 'var(--muted)' }}>{c.recording_enabled === false ? 'rec off' : fmtRetention(c.recording_retention_sec, c.recording_retention_days)}</td>
                <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                  {/* One primary action, then "⋯" for the rest: same height, side by side. */}
                  <div className="row-actions">
                    {canRun ? (
                      <button className={`btn act ${live ? 'ghost' : 'primary'}`} disabled={busy === c.id || !!bulkBusy} onClick={() => toggle(c)}>
                        {busy === c.id ? '…' : live ? 'Stop' : 'Start'}
                      </button>
                    ) : <button className="btn act primary" onClick={() => view(c.id)}>Open</button>}
                    <RowMenu label={`More actions for ${c.name}`} items={menuFor(c)} />
                  </div>
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

const RUNG_PRESETS = [
  { height: 1080, bitrateKbps: 5000 }, { height: 720, bitrateKbps: 2800 },
  { height: 480, bitrateKbps: 1200 }, { height: 360, bitrateKbps: 800 }, { height: 240, bitrateKbps: 400 },
]

/* ============================================================================
   NEW CHANNEL, in the same three tabs as a radio station:
     Settings  what the channel IS and how it runs: name and logo, transcode or
               packaging and the GROUP it goes in, sources, ladder, watermark,
               filler, captions, delivery, recording
     Metadata  its content type and the guide fields (description, genre,
               language ...). The name is not one of them: the channel name on
               Settings is the metadata name, so it is never typed twice.
     Access    publishing and access rules, set once the channel exists

   THE GROUP. A channel goes into a group, and the group's profile decides
   what kind of channel it is. The form used to pick the first group of the
   chosen type silently and say "No transcode group set up yet" at the bottom
   after everything was filled in. Now the group is a visible choice, a type
   with no group in the account says so where the type is chosen (with what to
   do about it), and the form starts on a type the account can actually create.
   ========================================================================== */
function CreateChannel({ groups, onClose, onCreated }: { groups: Group[]; onClose: () => void; onCreated: () => void }) {
  const ofType = useMemo(() => ({
    transcode: groups.filter(g => g.workflow_type === 'transcode'),
    package_only: groups.filter(g => g.workflow_type === 'package_only'),
  }), [groups])
  const [type, setType] = useState<'transcode' | 'package_only'>(() => groups.some(g => g.workflow_type === 'transcode') || !groups.some(g => g.workflow_type === 'package_only') ? 'transcode' : 'package_only')
  const [groupId, setGroupId] = useState('')
  const [tab, setTab] = useState<DrawerTab>('settings')
  const [name, setNameRaw] = useState('')
  const [brandRef, setBrandRef] = useState('')
  const [guideIcon, setGuideIcon] = useState('')
  const [wm, setWm] = useState<WmForm>(wmDefaults())
  const [typeId, setTypeId] = useState<string | null>(null)
  const [meta, setMeta] = useState<Record<string, any>>({})
  const [purchasing, setPurchasing] = useState('reserved')
  const [recOn, setRecOn] = useState(true)
  const [retNum, setRetNum] = useState<string>('7')
  const [retUnit, setRetUnit] = useState<RetUnit>('days')
  const [dvrMin, setDvrMin] = useState(60)
  const DVR_MAX_MIN = 240

  const protocols = useProtocols('video')
  // transcode: single source + optional backup + selectable ladder
  const [tSrc, setTSrc] = useState<SourceValue>({ protocol: 'srt', url: '' })
  const [tBackupOn, setTBackupOn] = useState(false)
  const [tBackup, setTBackup] = useState<SourceValue>({ protocol: 'srt', url: '' })
  const [ladder, setLadder] = useState(() => RUNG_PRESETS.map(r => ({ ...r, on: [1080, 720, 480].includes(r.height) })))

  // package: per-rendition input rows + fallback
  const [rows, setRows] = useState<PkgRow[]>(() => DEFAULT_PKG_ROWS.map(r => ({ ...r })))
  const [fallbackMode, setFallbackMode] = useState<PkgFallback>('none')
  const [fbSrc, setFbSrc] = useState<SourceValue>({ protocol: 'hls', url: '' })

  // filler on total loss (both flows)
  const [lossBehavior, setLossBehavior] = useState<'none' | 'slate' | 'vod_loop' | 'last_frame' | 'black'>('slate')
  const [slateRef, setSlateRef] = useState('')
  const [fillerAssetId, setFillerAssetId] = useState<string | null>(null)

  // live captions: the spoken language is detected automatically; the operator picks
  // the OUTPUT languages to publish. Applied right after create (captions live on the
  // group's shared output profile, same path the settings drawer uses).
  const [capOn, setCapOn] = useState(false)
  const [capLangs, setCapLangs] = useState<string[]>(['en'])
  const langOpts = useCaptionLanguages()

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const candidates = ofType[type]
  const group = pickGroup(candidates, groupId)
  const groupFull = !!group && isFull(group)
  // Why Create is unavailable, shown in the footer (not only a tooltip).
  const blocked = !group
    ? `This account has no ${type === 'transcode' ? 'transcode' : 'packaging'} group, so this type of channel cannot be created yet.`
    : groupFull ? fullReason(group) : null

  // The channel name IS the metadata name (the server writes it there).
  const setName = setNameRaw


  // NOTHING FAILS SILENTLY. Anything thrown on the way to the request (a
  // source check, a watermark check, the network) used to escape as an
  // unhandled rejection: the button did nothing and said nothing.
  async function submit() {
    setErr('')
    try { await submitInner() }
    catch (e: any) {
      const msg = String(e?.message || '').trim()
      if (/metadata|required field/i.test(msg)) setTab('metadata')
      setErr(e?.forbidden ? 'Your access does not allow creating channels.'
        : msg && msg !== 'ValidationError' ? msg : 'The channel could not be created. Check the fields and try again.')
      setBusy(false)
    }
  }

  async function submitInner() {
    if (!name.trim()) { setTab('settings'); setErr('Give the channel a name'); return }
    if (!group) { setTab('settings'); setErr(`This account has no ${type === 'transcode' ? 'transcode' : 'packaging'} group, so a ${type === 'transcode' ? 'transcode' : 'packaging'} channel cannot be created yet. See Group under Type.`); return }
    if (groupFull) { setTab('settings'); setErr(fullReason(group) ?? `${group.name} is full`); return }
    if (type === 'transcode') { const w = wmProblem(wm); if (w) { setTab('settings'); setErr(w); return } }
    const hlsWait = await hlsChoicePending(type === 'transcode'
      ? [tSrc, ...(tBackupOn ? [tBackup] : [])]
      : [...rows.map(r => ({ url: r.url, protocol: r.protocol })), ...(fallbackMode === 'matching' ? rows.map(r => ({ url: r.backupUrl, protocol: r.protocol })) : []), ...(fallbackMode === 'single' ? [fbSrc] : [])])
    if (hlsWait) { setErr(hlsWait); return }

    const sources: NonNullable<Parameters<typeof api.createChannel>[0]['sources']> = []
    let outputLadder: { height: number; bitrateKbps: number }[] = []
    let fallbackTranscode = false

    if (type === 'transcode') {
      if (!tSrc.url.trim()) { setErr('Add the primary source URL'); return }
      const rungs = ladder.filter(r => r.on)
      if (!rungs.length) { setErr('Select at least one output rendition'); return }
      outputLadder = rungs.map(r => ({ height: r.height, bitrateKbps: r.bitrateKbps }))
      const why = sourceProblem(protocols, tSrc) ?? (tBackupOn && tBackup.url.trim() ? sourceProblem(protocols, tBackup) : null)
      if (why) { setErr(`${sourceProblem(protocols, tSrc) ? 'Primary' : 'Backup'} source: ${why}`); return }
      sources.push({ role: 'primary', ...sourceToApi(tSrc, protocols) })
      if (tBackupOn && tBackup.url.trim()) sources.push({ role: 'backup', ...sourceToApi(tBackup, protocols) })
    } else {
      const out = pkgToSources(rows, fallbackMode, fbSrc, protocols)
      if ('error' in out) { setErr(out.error); return }
      sources.push(...out.sources)
      outputLadder = out.outputLadder
      fallbackTranscode = out.fallbackTranscode // one source, transcoded up to all matching bitrates
    }

    setBusy(true)
    try {
      const created = await api.createChannel({
        groupId: group.id, name: name.trim(), purchasingMode: purchasing,
        resilienceTier: 'standard',
        recordingEnabled: recOn,
        recordingRetentionSec: recOn && retNum ? Math.max(Number(retNum) * RET_UNIT_SEC[retUnit], dvrMin * 60) : null,
        dvrWindowSec: Math.max(30, dvrMin * 60), dvrMode: 'sliding',
        outputLadder, sources,
        inputFailoverEnabled: sources.some(s => s.role === 'backup'),
        inputLossBehavior: lossBehavior,
        fillerAssetId: (lossBehavior === 'slate' || lossBehavior === 'vod_loop') && fillerAssetId ? fillerAssetId : null,
        fillerSlateRef: (lossBehavior === 'slate' || lossBehavior === 'vod_loop') && !fillerAssetId && slateRef.trim() ? slateRef.trim() : null,
        fallbackTranscode,
        brandRef: brandRef.trim() || null, guideIconRef: guideIcon.trim() || null,
        // Burned in by the encoder, so transcode only: a packaging channel passes the source through.
        ...(type === 'transcode' ? { watermark: wmPatch(wm) } : {}),
        ...(typeId ? { schemaId: typeId, metadata: meta } : {}),
      })
      // captions ride on the group's shared output profile, so they are applied via the
      // same channel-update path the settings drawer uses (after the channel exists)
      if (capOn && created?.id) {
        try { await api.updateChannel(created.id, { captions: { enabled: true, targets: capLangs } }) }
        catch { /* channel created fine; captions can still be set in Settings */ }
      }
      onCreated()
    } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="">
      <div className="drawer" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="">
        <div className="drawer-h"><div className="t">New channel</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          <DrawerTabs tab={tab} setTab={setTab} />
          <TabPane active={tab === 'metadata'}>
            <TypePicker appliesTo="tv" value={typeId} onChange={(id) => setTypeId(id)}
              hint="The channel's identity (schema.org TelevisionChannel). Its metadata is what the guide and now/next show when no programme is scheduled." />
            <MetadataForm typeId={typeId} value={meta} onChange={setMeta} entityName={{ value: name, where: 'channel' }} hide={['logo']} />
            <GuideIconField value={guideIcon} onChange={setGuideIcon} brandRef={brandRef} />
          </TabPane>
          <TabPane active={tab === 'access'}>
            <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>Create the channel first; its publishing and access rules are set here afterwards, from the channel's Settings. Until then it inherits its content type's and the account's rules.</div>
          </TabPane>
          <TabPane active={tab === 'settings'}>
          <div className="field"><label>Channel name <span className="req">*</span></label>
            <input className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. RTM News 24" />
          </div>
          <ImageRefField label="Channel logo" hint="shown in lists, on the channel page and in the guide"
            value={brandRef} onChange={setBrandRef} pickerTitle="Choose or upload the channel logo" kinds={['brand', 'poster', 'other']} />

          <div className="field"><label>Type</label>
            <div className="presets">
              <Preset sel={type === 'transcode'} onClick={() => { setType('transcode'); setGroupId('') }} title="Transcode"
                desc="One source in. We build the ABR ladder with FFmpeg." meta={ofType.transcode.length ? '1 input → many outputs' : 'no transcode group yet'} />
              <Preset sel={type === 'package_only'} onClick={() => { setType('package_only'); setGroupId('') }} title="Packaging"
                desc="You send a pre-encoded ladder; we just package it." meta={ofType.package_only.length ? 'N inputs → N outputs' : 'no packaging group yet'} />
            </div>
          </div>
          <div className="field"><label>Group</label>
            {candidates.length === 0 ? (
              <div className="group-missing" role="status">
                <strong>This account has no {type === 'transcode' ? 'transcode' : 'packaging'} group.</strong> A channel goes into a group, and the group decides whether it is transcode or packaging.
                {' '}An account administrator adds one under Admin, Channel groups.
                {ofType[type === 'transcode' ? 'package_only' : 'transcode'].length > 0 && <> You can create a {type === 'transcode' ? 'packaging' : 'transcode'} channel now.</>}
              </div>
            ) : (
              <>
                <select className="inp" value={group?.id ?? ''} onChange={e => setGroupId(e.target.value)} disabled={candidates.length === 1}>
                  {candidates.map(g => <option key={g.id} value={g.id} disabled={isFull(g)}>{groupLabel(g)}</option>)}
                </select>
                <div className="hintxt">{group?.profile_name ? `Output profile ${group.profile_name}` : ''}{group?.rungs?.length ? `, default ladder ${group.rungs.map(r => `${r.height}p`).join(', ')}` : ''}{candidates.length === 1 ? '. The only group of this type in the account.' : ''}</div>
              </>
            )}
          </div>

          {type === 'transcode' ? (
            <>
              <div className="sec-label">Source</div>
              <SourceInput protocols={protocols} value={tSrc} onChange={setTSrc} label="Primary source" />
              <div className="toggle-row">
                <div><div className="tt">Backup source</div><div className="td">Optional failover input of the same feed.</div></div>
                <div className={`sw ${tBackupOn ? '' : 'off'}`} {...pressable((e: any) => { ((() => setTBackupOn(v => !v)) as any)(e) })} data-a11y-click=""><i /></div>
              </div>
              {tBackupOn && <SourceInput protocols={protocols} value={tBackup} onChange={setTBackup} label="Backup source" />}

              <div className="sec-label">Output rendition ladder</div>
              <div className="field">
                {ladder.map((r, i) => (
                  <div key={r.height} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <div className={`selchip ${r.on ? 'sel' : ''}`} style={{ minWidth: 78, justifyContent: 'center' }}
                      {...pressable((e: any) => { ((() => setLadder(l => l.map((x, j) => j === i ? { ...x, on: !x.on } : x))) as any)(e) })} data-a11y-click="">{r.height}p</div>
                    <input className="inp" style={{ maxWidth: 130, opacity: r.on ? 1 : 0.45 }} disabled={!r.on}
                      value={r.bitrateKbps} onChange={e => setLadder(l => l.map((x, j) => j === i ? { ...x, bitrateKbps: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 } : x))} />
                    <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>kbps</span>
                  </div>
                ))}
                <div className="hintxt">We encode the single source into every selected rendition.</div>
              </div>
            </>
          ) : (
            <>
              <PackageRenditions protocols={protocols} rows={rows} onRows={setRows}
                mode={fallbackMode} onMode={setFallbackMode} fb={fbSrc} onFb={setFbSrc} />
            </>
          )}

          <div className="sec-label">Watermark</div>
          {type === 'transcode'
            ? <WatermarkFields value={wm} onChange={(p) => setWm(w => ({ ...w, ...p }))} />
            : <div className="hintxt" style={{ marginTop: 0, marginBottom: 12 }}>A packaging channel passes your encoded ladder through untouched, so a watermark cannot be added here: burn it in upstream, or choose Transcode.</div>}

          <div className="sec-label">Filler on total loss</div>
          <div className="field"><label>When no source is available</label>
            <select className="inp" value={lossBehavior} onChange={e => setLossBehavior(e.target.value as any)}>
              <option value="none">None (output stops)</option>
              <option value="slate">Slate image</option>
              <option value="vod_loop">Loop video</option>
              <option value="last_frame">Freeze last frame</option>
              <option value="black">Black</option>
            </select>
          </div>
          {(lossBehavior === 'slate' || lossBehavior === 'vod_loop') && (
            <FillerField behavior={lossBehavior} assetId={fillerAssetId} onAssetId={setFillerAssetId}
              legacyRef={slateRef} onLegacyRef={setSlateRef} />
          )}

          <div className="sec-label">Subtitles</div>
          <div className="toggle-row">
            <div><div className="tt">Live captions / subtitles</div><div className="td">The spoken language is detected automatically, chunk by chunk, and translated into each selected output language.</div></div>
            <div className={`sw ${capOn ? '' : 'off'}`} {...pressable((e: any) => { ((() => setCapOn(v => !v)) as any)(e) })} data-a11y-click=""><i /></div>
          </div>
          {capOn && (
            <div className="field"><label>Output languages</label>
              <LangPicker value={capLangs} onChange={setCapLangs} options={langOpts} />
            </div>
          )}

          <div className="sec-label">Delivery</div>
          <div className="field"><label>Purchasing mode</label>
            <select className="inp" value={purchasing} onChange={e => setPurchasing(e.target.value)}>
              <option value="reserved">Reserved</option>
              <option value="spot_fallback">Spot with on-demand fallback</option>
              <option value="on_demand">On demand</option>
            </select>
          </div>
          <div className="field">
            <label>DVR catch-up window — {dvrMin} min{dvrMin >= 60 ? ` (${(dvrMin / 60).toFixed(dvrMin % 60 ? 1 : 0)}h)` : ''}</label>
            <input type="range" min={1} max={DVR_MAX_MIN} step={1} value={dvrMin} onChange={e => setDvrMin(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--brand)' }} />
            <div className="hintxt">Max 4h for 24×7 channels; event streams scrub back to the event start.</div>
          </div>

          <RecordingSection ctx="channel" recOn={recOn} setRecOn={setRecOn}
            retNum={retNum} setRetNum={setRetNum} retUnit={retUnit} setRetUnit={setRetUnit}
            retWarn={retNum && Number(retNum) * RET_UNIT_SEC[retUnit] < dvrMin * 60
              ? `Will be raised to the DVR window (${dvrMin}m): retention can’t be shorter than DVR.` : null} />
          </TabPane>
        </div>
        <div className="drawer-f">
          {/* In the footer, so a problem is seen wherever the form is scrolled to. */}
          <FormStatus error={err} blocked={blocked} />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !!blocked} onClick={submit} title={blocked ?? ''}>{busy ? 'Creating…' : 'Create channel'}</button>
        </div>
      </div>
    </div>
  )
}

