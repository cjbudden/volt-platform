/**
 * CHANNEL GROUPS (Admin > Channel groups, docs/PLAN_AND_GROUPS.md).
 *
 * Every channel, radio station and event belongs to a group. The group's name
 * is the grey line under each item in the lists. A group sets:
 *   - the OUTPUT PROFILE: transcode or packaging, the rendition ladder,
 *     captions. New items in the group use it.
 *   - its SHARE OF THE PLAN: how many channels and stations it may hold, and
 *     how many may run at once. The plan itself is the account's
 *     (Admin > Plan & limits); shares add up to no more than it.
 * One group is the DEFAULT: new channels, stations and events start there.
 *
 *   settings:manage          rename, choose another output profile of the same type
 *   account admin, owner,    new group, change a share, make default, remove
 *   system administrator     (never the default, never while in use)
 *   Manage on a stream's     move it to another group of the same workflow
 *   own feature              (TV channels, Radio, FAST or Events)
 */
import { useEffect, useMemo, useState } from 'react'
import { api, type Group, type GroupUse, type PlanView, type LiveStreamListRow, type GroupMoveResult } from '../api'
import { useAccess } from '../access'
import { PageHead, NewButton, Preset } from '../scaffold'
import { navigate } from '../router'
import { useNotify, usePageNotice, FormStatus, FieldError, Notice } from '../notices'
import { RowMenu, Icons, type MenuItem } from '../listActions'
import { ListToolbar } from '../listFilters'
import { Meter } from './PlanLimits'

interface Profile { id: string; name: string; workflow_type?: string }
const typeLabel = (t: string | null | undefined) => t === 'package_only' ? 'Packaging' : t === 'transcode' ? 'Transcode' : '—'
const ICON_MOVE = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
/** The feature that owns a stream row (the move route checks Manage on it). */
const featureOf = (r: LiveStreamListRow) => r.kind === 'event' ? 'events' : r.kind === 'fast_channel' ? 'fast' : r.medium === 'radio' ? 'radio' : 'channels'
const kindWord = (r: LiveStreamListRow) => r.kind === 'event' ? 'event' : r.kind === 'fast_channel' ? 'FAST channel' : r.medium === 'radio' ? 'radio station' : 'TV channel'
const ICON_DEFAULT = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z" /></svg>

export default function ChannelGroups() {
  const { can } = useAccess()
  const canRename = can('settings', 'manage')
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [plan, setPlan] = useState<PlanView | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [err, setErr] = useState('')
  const [drawer, setDrawer] = useState<{ mode: 'new' } | { mode: 'edit'; group: Group } | null>(null)
  const [removing, setRemoving] = useState<Group | null>(null)
  const [moving, setMoving] = useState<Group | null>(null)
  const notify = useNotify()
  // MOVING A STREAM is work on that stream, not on the group: Manage on its own
  // feature. Shown to anyone who manages some kind of stream; the dialog says
  // which of the group's streams this role cannot move.
  const canMoveSome = ['channels', 'radio', 'events', 'fast'].some(f => can(f, 'manage'))
  const canList = can('monitoring', 'view')

  const load = () => Promise.all([api.groups(), api.plan()])
    .then(([g, p]) => { setGroups(g); setPlan(p); setErr('') })
    .catch(e => setErr(e?.message || 'Could not load groups'))
  useEffect(() => {
    load()
    api.outputProfiles().then((p: Profile[]) => setProfiles(p)).catch(() => {})
  }, [])
  const manage = !!plan?.canManageGroups
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load channel groups.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)
  usePageNotice('who', plan && !manage ? { kind: 'info', message: canRename
    ? 'You can rename groups and change their output profile. New groups, shares of the plan, the default group and removal are for account administrators.'
    : 'You can see the groups. Changes are made by account administrators.' } : null)

  const newBlocked = !plan ? null : plan.unallocated < 1
    ? `The whole plan (${plan.maxChannels} channels and stations) is shared out. Lower a group's share, or raise the plan, to add a group.` : null

  async function makeDefault(g: Group) {
    try { await api.patchGroup(g.id, { isDefault: true }); notify({ kind: 'ok', message: `${g.name} is now the default group.` }); load() }
    catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }

  function menuFor(g: Group): MenuItem[] {
    const items: MenuItem[] = []
    if (manage) items.push({ key: 'default', label: 'Make default', icon: ICON_DEFAULT, onSelect: () => makeDefault(g),
      disabledReason: g.is_default ? 'Already the default group' : null })
    const held = g.channel_count + (g.event_count ?? 0)
    const sameType = (groups ?? []).filter(o => o.id !== g.id && o.workflow_type === g.workflow_type)
    // THE STREAMS OF THIS GROUP, not the whole Channels list: Live Streams'
    // list view filtered to it (channels, stations, events and FAST together).
    items.push({ key: 'channels', label: 'View its streams', icon: Icons.view, onSelect: () => navigate(`/live?view=list&group=${g.id}`),
      disabledReason: !canList ? 'Needs Live & monitoring: View' : !held ? 'Nothing is in this group' : null })
    if (canMoveSome) items.push({ key: 'move', label: 'Move streams', icon: ICON_MOVE, onSelect: () => setMoving(g),
      disabledReason: !held ? 'Nothing is in this group'
        : !canList ? 'Needs Live & monitoring: View to list the streams'
        : !sameType.length ? `No other ${typeLabel(g.workflow_type)} group to move them to` : null })
    if (manage) items.push({ key: 'remove', label: 'Remove', icon: Icons.remove, danger: true, separator: true,
      disabledReason: g.is_default ? 'The default group cannot be removed' : null, onSelect: () => setRemoving(g) })
    return items
  }

  return (
    <>
      <PageHead title="Channel groups" sub="Each channel, station and event sits in a group. A group sets the output profile and is given a share of the plan." />
      {groups === null || plan === null ? (!err && <div className="loading">Loading…</div>) : (
        <>
          <ListToolbar
            left={<div className="plan-strip">
              <span><b>{plan.maxChannels}</b> in the plan</span><span className="dot" />
              <span><b>{plan.allocated}</b> shared out</span><span className="dot" />
              <span className={plan.unallocated ? '' : 'none'}><b>{plan.unallocated}</b> not yet shared</span>
              <button className="btn ghost sm" onClick={() => navigate('/plan')}>Plan & limits</button>
            </div>}
            right={manage ? <NewButton label="New group" onClick={() => setDrawer({ mode: 'new' })} blockedReason={newBlocked} /> : undefined} />
          {newBlocked && manage && <div style={{ marginBottom: 12 }}><Notice kind="warn" variant="compact" message={newBlocked} /></div>}
          <div className="card">
            <table>
              <thead><tr><th>Group</th><th>Workflow</th><th>Output profile</th><th style={{ width: '24%' }}>Share of the plan</th><th>Running at once</th><th>Events</th><th /></tr></thead>
              <tbody>
                {groups.map(g => {
                  const tv = g.channel_count - (g.radio_count ?? 0)
                  return (
                    <tr key={g.id}>
                      <td><b>{g.name}</b>{g.is_default && <span className="tag sched" style={{ marginLeft: 8 }} title="New channels, stations and events start here">Default</span>}</td>
                      <td>{typeLabel(g.workflow_type)}</td>
                      <td style={{ color: 'var(--muted)' }}>{g.profile_name ?? '—'}</td>
                      <td>
                        <div className="share-cell">
                          <span><b>{g.channel_count}</b> of {g.max_channels}</span>
                          <Meter total={g.max_channels} label={`${g.name} use`} parts={[{ n: tv, cls: 'tv', label: 'TV' }, { n: g.radio_count ?? 0, cls: 'radio', label: 'radio' }]} />
                        </div>
                        <div className="hintxt">{tv} TV, {g.radio_count ?? 0} radio</div>
                      </td>
                      <td>{g.max_concurrent ?? '—'}</td>
                      <td style={{ color: 'var(--muted)' }}>{g.event_count ?? 0}</td>
                      <td style={{ textAlign: 'right' }}>
                        <div className="row-actions">
                          {(manage || canRename)
                            ? <button className="btn act ghost" onClick={() => setDrawer({ mode: 'edit', group: g })}>Edit</button>
                            : null}
                          <RowMenu label={`More actions for ${g.name}`} items={menuFor(g)} />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="hintxt" style={{ marginTop: 10 }}>A group is not a server or pool: where a stream runs is decided by placement.</div>
        </>
      )}
      {drawer && plan && (
        <GroupDrawer plan={plan} profiles={profiles} manage={manage} group={drawer.mode === 'edit' ? drawer.group : null}
          onClose={() => setDrawer(null)}
          onSaved={(g, created) => { setDrawer(null); notify({ kind: 'ok', message: created ? `${g.name} was created.` : `${g.name} was saved.` }); load() }} />
      )}
      {moving && groups && <MoveStreamsDialog group={moving} groups={groups} can={can}
        onClose={changed => { setMoving(null); if (changed) load() }} />}
      {removing && <RemoveGroupDialog group={removing} onClose={() => setRemoving(null)}
        onMove={canMoveSome && canList ? () => { const g = removing; setRemoving(null); setMoving(g) } : undefined}
        onRemoved={name => { setRemoving(null); notify({ kind: 'ok', message: `${name} was removed. The removal is in the audit log.` }); load() }} />}
    </>
  )
}

function GroupDrawer({ plan, profiles, manage, group, onClose, onSaved }: {
  plan: PlanView; profiles: Profile[]; manage: boolean; group: Group | null
  onClose: () => void; onSaved: (g: Group, created: boolean) => void
}) {
  const isNew = !group
  const [name, setName] = useState(group?.name ?? '')
  const [type, setType] = useState<'transcode' | 'package_only'>((group?.workflow_type as any) ?? 'transcode')
  const [profile, setProfile] = useState(group?.output_profile_id ?? '')
  const [share, setShare] = useState(String(group?.max_channels ?? Math.min(5, Math.max(1, plan.unallocated))))
  const [conc, setConc] = useState(String(group?.max_concurrent ?? 1))
  const [makeDefault, setMakeDefault] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const sameType = useMemo(() => profiles.filter(p => !p.workflow_type || p.workflow_type === type), [profiles, type])
  const used = group?.channel_count ?? 0
  const room = plan.unallocated + (group?.max_channels ?? 0)   // the most this group can be given
  const shareN = Number(share), concN = Number(conc)
  const shareErr = !manage ? '' : !Number.isInteger(shareN) || shareN < 1 ? 'A whole number, 1 or more.'
    : shareN < used ? `At least ${used}: the group holds ${used}.` : shareN > room ? `At most ${room}: that is all the plan has left for it.` : ''
  const concErr = !manage ? '' : !Number.isInteger(concN) || concN < 1 ? 'A whole number, 1 or more.'
    : concN > plan.maxConcurrent ? `At most ${plan.maxConcurrent}: the plan's limit.` : ''
  const nameErr = !name.trim() ? 'Give the group a name.' : ''

  async function save() {
    setErr('')
    if (nameErr || shareErr || concErr) { setErr('Check the highlighted fields.'); return }
    setBusy(true)
    try {
      if (isNew) {
        const g = await api.createGroup({ name: name.trim(), workflowType: type, outputProfileId: profile || undefined,
          maxChannels: shareN, maxConcurrent: concN, makeDefault })
        onSaved(g, true)
      } else {
        const g = await api.patchGroup(group!.id, {
          ...(name.trim() !== group!.name ? { name: name.trim() } : {}),
          ...(profile && profile !== group!.output_profile_id ? { outputProfileId: profile } : {}),
          ...(manage && shareN !== group!.max_channels ? { maxChannels: shareN } : {}),
          ...(manage && concN !== group!.max_concurrent ? { maxConcurrent: concN } : {}),
        })
        onSaved(g, false)
      }
    } catch (e: any) { setErr(e?.message || 'The group could not be saved.') } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="grp-t" onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose() }}>
        <div className="drawer-h"><div className="t" id="grp-t">{isNew ? 'New group' : `Edit ${group!.name}`}</div><button className="xbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="drawer-b">
          <div className={`field${nameErr && err ? ' has-err' : ''}`}><label htmlFor="grp-name">Name <span className="req">*</span></label>
            <input id="grp-name" className="inp" autoFocus value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="e.g. Radio" />
            {err && <FieldError>{nameErr}</FieldError>}
            <div className="hintxt">Shown under each channel, station and event in the lists.</div>
          </div>
          <div className="field"><label>Workflow</label>
            {isNew ? (
              <div className="presets">
                <Preset sel={type === 'transcode'} onClick={() => { setType('transcode'); setProfile('') }} title="Transcode" desc="One source in; we build the ladder." meta="1 input → many outputs" />
                <Preset sel={type === 'package_only'} onClick={() => { setType('package_only'); setProfile('') }} title="Packaging" desc="A pre-encoded ladder, packaged as sent. Radio stations use this." meta="N inputs → N outputs" />
              </div>
            ) : <div className="ro-val">{typeLabel(group!.workflow_type)} <span className="hintxt">(fixed: a running channel never changes workflow)</span></div>}
          </div>
          <div className="field"><label htmlFor="grp-prof">Output profile</label>
            <select id="grp-prof" className="inp" value={profile} onChange={e => setProfile(e.target.value)}>
              {isNew && <option value="">New profile with the default ladder (1080p, 720p, 480p)</option>}
              {sameType.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="sec-label">Share of the plan</div>
          {!manage && <div style={{ marginBottom: 12 }}><Notice kind="info" variant="compact" message="Shares of the plan are changed by account administrators." /></div>}
          <div className={`field${shareErr ? ' has-err' : ''}`}><label htmlFor="grp-share">Channels and stations <span className="req">*</span></label>
            <input id="grp-share" className="inp" type="number" min={Math.max(1, used)} max={room} value={share} disabled={!manage} onChange={e => setShare(e.target.value)} />
            <FieldError>{shareErr}</FieldError>
            <div className="hintxt">{isNew ? '' : `Holds ${used} now. `}The plan has {plan.unallocated} not yet shared{isNew ? '' : `, so this group can have up to ${room}`}.</div>
          </div>
          <div className={`field${concErr ? ' has-err' : ''}`}><label htmlFor="grp-conc">Running at once <span className="req">*</span></label>
            <input id="grp-conc" className="inp" type="number" min={1} max={plan.maxConcurrent} value={conc} disabled={!manage} onChange={e => setConc(e.target.value)} />
            <FieldError>{concErr}</FieldError>
            <div className="hintxt">Up to {plan.maxConcurrent}, the plan's limit for the whole account.</div>
          </div>
          {isNew && manage && (
            <label className="chk-row"><input type="checkbox" checked={makeDefault} onChange={e => setMakeDefault(e.target.checked)} />
              <span>Make this the default group <span className="hintxt">(new channels, stations and events start here)</span></span></label>
          )}
        </div>
        <div className="drawer-f">
          <FormStatus error={err} blocked={isNew && plan.unallocated < 1 ? 'The whole plan is shared out.' : null} />
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || (isNew && plan.unallocated < 1)}>{busy ? 'Saving…' : isNew ? 'Create group' : 'Save changes'}</button>
        </div>
      </div>
    </div>
  )
}

/**
 * REMOVE A GROUP: never the default, never while anything is in it. The
 * dialog says what is in it, so the person knows what to move first.
 */
function RemoveGroupDialog({ group, onClose, onRemoved, onMove }: { group: Group; onClose: () => void; onRemoved: (name: string) => void; onMove?: () => void }) {
  const [use, setUse] = useState<GroupUse | null>(null)
  const [typed, setTyped] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.groupUsage(group.id).then(setUse).catch((e: any) => setErr(e?.message || 'Could not check the group')) }, [group.id])
  const ok = !!use && !use.blocker && typed.trim() === group.name.trim()

  async function go() {
    if (!ok) return
    setBusy(true); setErr('')
    try { await api.deleteGroup(group.id); onRemoved(group.name) }
    catch (e: any) { setErr(e?.message || 'The group could not be removed'); api.groupUsage(group.id).then(setUse).catch(() => {}) }
    finally { setBusy(false) }
  }
  const c = use?.counts
  const lines = c ? [
    c.channels ? `${c.channels} TV channel${c.channels === 1 ? '' : 's'}` : null,
    c.stations ? `${c.stations} radio station${c.stations === 1 ? '' : 's'}` : null,
    c.events ? `${c.events} event${c.events === 1 ? '' : 's'}${c.eventsUpcoming ? `, ${c.eventsUpcoming} not yet ended` : ''}` : null,
  ].filter(Boolean) as string[] : []

  return (
    <div className="drawer-scrim" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" role="dialog" aria-modal="true" aria-labelledby="rmg-t" onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose() }}
        style={{ width: 480, maxWidth: 'calc(100vw - 32px)', padding: 20 }}>
        <h3 id="rmg-t" style={{ margin: '0 0 8px' }}>Remove group {group.name}?</h3>
        {!use && !err && <div className="loading">Checking what is in the group…</div>}
        {use?.isDefault && <Notice kind="warn" variant="compact" title="This is the default group." message="New channels, stations and events start here. Make another group the default first." />}
        {use && !use.isDefault && use.inUse && (
          <Notice kind="warn" variant="compact" title="This group is in use." >
            <ul className="bulk-list" style={{ marginTop: 4 }}>{lines.map(l => <li key={l}>{l}</li>)}</ul>
            <div style={{ marginTop: 6 }}>Move them to another group or remove them first.</div>
            {onMove && <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={onMove}>{ICON_MOVE_SM} Move streams</button>}
          </Notice>
        )}
        {use && !use.blocker && (
          <>
            <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-body)', margin: '0 0 10px' }}>The group is empty. Its share of the plan ({group.max_channels}) becomes free to give to another group. This cannot be undone.</p>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="rmg-name">Type <b>{group.name}</b> to confirm</label>
              <input id="rmg-name" className="inp" autoFocus value={typed} onChange={e => setTyped(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') go() }} autoComplete="off" spellCheck={false} />
            </div>
          </>
        )}
        <div className="modal-f">
          <FormStatus error={err} blocked={use?.blocker ? 'Cannot be removed yet.' : null} />
          <button className="btn ghost" onClick={onClose} disabled={busy}>{use?.blocker ? 'Close' : 'Cancel'}</button>
          {!use?.blocker && <button className="btn primary danger" disabled={busy || !ok} onClick={go}>{busy ? 'Removing…' : 'Remove group'}</button>}
        </div>
      </div>
    </div>
  )
}

const ICON_MOVE_SM = <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>

/**
 * MOVE STREAMS TO ANOTHER GROUP (build queue 1.14-G3a-5). Lists what is in
 * the group (GET /api/live-streams?group_id=, so channels, stations, events
 * and FAST channels in one list), lets the person pick some and a target of
 * the same workflow, and moves them one at a time through each stream's own
 * route, which checks the target's share and running at once. Every stream
 * gets its own answer: one refused does not stop the rest.
 */
function MoveStreamsDialog({ group, groups, can, onClose }: {
  group: Group; groups: Group[]; can: (feature: string, level: 'view' | 'operate' | 'manage') => boolean
  onClose: (changed: boolean) => void
}) {
  const targets = groups.filter(o => o.id !== group.id && o.workflow_type === group.workflow_type)
  const [rows, setRows] = useState<LiveStreamListRow[] | null>(null)
  const [more, setMore] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState(targets[0]?.id ?? '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ ok: GroupMoveResult[]; failed: { name: string; why: string }[] } | null>(null)

  useEffect(() => {
    api.liveStreams({ group_id: group.id, limit: '200' })
      .then(r => { setRows(r.rows); setMore(!!r.next) })
      .catch((e: any) => setErr(e?.message || 'Could not list the streams in this group'))
  }, [group.id])

  const movable = (r: LiveStreamListRow) => can(featureOf(r), 'manage')
  const choosable = (rows ?? []).filter(movable)
  const toggle = (id: string) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const allOn = choosable.length > 0 && choosable.every(r => picked.has(r.id))
  const targetName = targets.find(t => t.id === target)?.name ?? ''

  async function go() {
    if (!target || !picked.size || !rows) return
    setBusy(true); setErr('')
    const ok: GroupMoveResult[] = [], failed: { name: string; why: string }[] = []
    for (const r of rows.filter(x => picked.has(x.id))) {
      try { ok.push(await api.moveToGroup(r.kind === 'event' ? 'event' : 'channel', r.id, target)) }
      catch (e: any) { failed.push({ name: r.name, why: e?.message || 'Could not be moved' }) }
    }
    setBusy(false); setDone({ ok, failed })
  }

  const later = done?.ok.filter(m => m.running && m.profileChanges) ?? []
  return (
    <div className="drawer-scrim" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(!!done?.ok.length) }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" role="dialog" aria-modal="true" aria-labelledby="mvg-t" onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose(!!done?.ok.length) }}
        style={{ width: 560, maxWidth: 'calc(100vw - 32px)', padding: 20 }}>
        <h3 id="mvg-t" style={{ margin: '0 0 8px' }}>Move streams out of {group.name}</h3>
        {done ? (
          <>
            {!!done.ok.length && <Notice kind="ok" variant="compact" title={`Moved ${done.ok.length} to ${done.ok[0].to.name}.`}
              message="Each move is in the audit log." />}
            {!!later.length && <div style={{ marginTop: 8 }}><Notice kind="info" variant="compact"
              message={`${later.map(m => m.name).join(', ')} ${later.length === 1 ? 'is' : 'are'} running. The new group's output profile applies from the next start.`} /></div>}
            {!!done.failed.length && <div style={{ marginTop: 8 }}><Notice kind="warn" variant="compact" title={`${done.failed.length} could not be moved.`}>
              <ul className="bulk-list" style={{ marginTop: 4 }}>{done.failed.map(f => <li key={f.name}><b>{f.name}</b>: {f.why}</li>)}</ul>
            </Notice></div>}
          </>
        ) : (
          <>
            <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-body)', margin: '0 0 10px' }}>
              A stream keeps its workflow, so only {typeLabel(group.workflow_type)} groups are offered. The target group needs room in its share of the plan
              (channels and stations) or in its running at once (events that have not ended).
            </p>
            <div className="field"><label htmlFor="mvg-to">Move to</label>
              <select id="mvg-to" className="inp" value={target} onChange={e => setTarget(e.target.value)} disabled={busy}>
                {targets.map(t => <option key={t.id} value={t.id}>{t.name} ({t.channel_count} of {t.max_channels} channels and stations, {t.max_concurrent ?? 1} at once)</option>)}
              </select>
            </div>
            {rows === null && !err && <div className="loading">Listing what is in the group…</div>}
            {rows && (
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="chk-row" style={{ fontWeight: 600 }}>
                  <input type="checkbox" checked={allOn} disabled={busy || !choosable.length}
                    onChange={() => setPicked(allOn ? new Set() : new Set(choosable.map(r => r.id)))} />
                  <span>All that you can move ({choosable.length} of {rows.length})</span>
                </label>
                <div style={{ maxHeight: 260, overflow: 'auto', paddingLeft: 4 }}>
                  {rows.map(r => {
                    const ok = movable(r)
                    return (
                      <label key={r.id} className="chk-row" style={ok ? undefined : { cursor: 'default', color: 'var(--faint)' }}>
                        <input type="checkbox" checked={picked.has(r.id)} disabled={busy || !ok} onChange={() => toggle(r.id)} />
                        <span><b>{r.name}</b> <span className="hintxt">{kindWord(r)}{r.status && r.status !== 'idle' ? `, ${r.status}` : ''}
                          {ok ? '' : `. Your role cannot change this ${kindWord(r)}.`}</span></span>
                      </label>
                    )
                  })}
                  {!rows.length && <div className="hintxt">Nothing in this group is visible to you.</div>}
                </div>
                {more && <div className="hintxt" style={{ marginTop: 6 }}>Showing the first 200. Move these, then open the dialog again for the rest.</div>}
              </div>
            )}
          </>
        )}
        <div className="modal-f">
          <FormStatus error={err} blocked={!done && !targets.length ? 'There is no other group of this workflow.' : null} />
          {done ? <button className="btn primary" onClick={() => onClose(!!done.ok.length)}>Done</button> : <>
            <button className="btn ghost" onClick={() => onClose(false)} disabled={busy}>Cancel</button>
            <button className="btn primary" disabled={busy || !picked.size || !target} onClick={go}>
              {busy ? 'Moving…' : picked.size ? `Move ${picked.size} to ${targetName}` : 'Move'}
            </button>
          </>}
        </div>
      </div>
    </div>
  )
}
