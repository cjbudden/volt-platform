// ============================================================================
//  GRAPHICS (/graphics): HTML templates, the setups built from them, where
//  each setup is on air, and the data sources they read.
//
//    /graphics                         library, setups, assignments, data sources (tabs)
//    /graphics/templates/new           add a template: upload, paste, start from Volt
//    /graphics/templates/:id           preview, sample data, versions, used by
//    /graphics/setups/new?version=     build a setup
//    /graphics/setups/:id              edit a setup, assign it
//    /graphics/channel/:id             a channel's graphics: always, rules, triggers, day strip
//    /graphics/rundown/:eventId        an event's graphics rundown: prepare and run
//    /graphics/live?channel_id|event_id[&popout=1]   live control, also as its own window
//
//  docs/REQ_graphics_overlays.md. Video only: radio stations are not offered.
// ============================================================================
import { useEffect, useMemo, useState } from 'react'
import { navigate, useRoute } from '../router'
import { PageHead } from '../scaffold'
import { useAccess } from '../access'
import { Notice } from '../notices'
import { api } from '../api'
import { gfx, previewValues, KIND_LABEL, SOURCE_LABEL, type Assignment, type DataSource, type Kind, type Setup, type Template } from './gfxApi'
import { GraphicStage } from './GraphicStage'
import { TemplateAdd } from './TemplateAdd'
import { TemplateDetailPage } from './TemplateDetail'
import { SetupEditor } from './SetupEditor'
import { ChannelGraphics } from './ChannelGraphics'
import { EventRundown } from './EventRundown'
import { LiveControl } from './LiveControl'
import { SourcesTab } from './Sources'
import { AssignDialog } from './AssignDialog'
import './graphics.css'

export function openLiveControl(t: { channelId?: string | null; eventId?: string | null }) {
  const q = t.eventId ? `event_id=${t.eventId}` : `channel_id=${t.channelId}`
  const w = window.open(`/graphics/live?${q}&popout=1`, `volt-gfx-${t.eventId ?? t.channelId}`, 'popup,width=1360,height=880')
  if (!w) navigate(`/graphics/live?${q}`)
}

export default function GraphicsPage() {
  const route = useRoute()
  const parts = route.path.replace(/^\/+|\/+$/g, '').split('/').slice(1)
  const q = new URLSearchParams(window.location.search)
  if (parts[0] === 'templates' && parts[1] === 'new') return <TemplateAdd />
  if (parts[0] === 'templates' && parts[1]) return <TemplateDetailPage key={parts[1]} id={parts[1]} />
  if (parts[0] === 'setups' && parts[1] === 'new') return <SetupEditor key={'new' + q.get('version')} versionId={q.get('version')} />
  if (parts[0] === 'setups' && parts[1]) return <SetupEditor key={parts[1]} id={parts[1]} />
  if (parts[0] === 'channel' && parts[1]) return <ChannelGraphics key={parts[1]} channelId={parts[1]} />
  if (parts[0] === 'rundown' && parts[1]) return <EventRundown key={parts[1]} eventId={parts[1]} />
  if (parts[0] === 'live') return <LiveControl channelId={q.get('channel_id')} eventId={q.get('event_id')} popout={q.has('popout')} />
  return <GraphicsHome tab={(q.get('tab') as Tab) || 'templates'} />
}

type Tab = 'templates' | 'setups' | 'assignments' | 'sources'

function GraphicsHome({ tab }: { tab: Tab }) {
  const { can } = useAccess()
  const canManage = can('graphics', 'manage')
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [setups, setSetups] = useState<Setup[] | null>(null)
  const [assignments, setAssignments] = useState<Assignment[] | null>(null)
  const [sources, setSources] = useState<DataSource[] | null>(null)
  const [err, setErr] = useState('')
  const load = () => {
    gfx.templates().then((r) => setTemplates(r.items)).catch((e) => setErr(e.message))
    gfx.setups().then((r) => setSetups(r.items)).catch((e) => setErr(e.message))
    gfx.assignments().then((r) => setAssignments(r.items)).catch((e) => setErr(e.message))
    gfx.sources().then((r) => setSources(r.items)).catch(() => setSources([]))
  }
  useEffect(load, [])
  const go = (t: Tab) => navigate(t === 'templates' ? '/graphics' : `/graphics?tab=${t}`, { replace: true })
  const onAir = (assignments ?? []).filter((a) => a.onAir).length

  return (
    <>
      <PageHead title="Graphics" sub="HTML templates, the setups you build from them, and where each one is on air. Video channels and events."
        action={<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canManage && <button className="btn primary" onClick={() => navigate('/graphics/templates/new')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>Add template</button>}
        </div>} />
      {err && <Notice kind="error" message={err} />}
      <div className="stats">
        <Stat label="Templates" value={templates?.length} sub={templates ? `${templates.filter((t) => t.owner === 'volt').length} from Volt · ${templates.filter((t) => t.owner === 'account').length} yours` : ''} />
        <Stat label="Setups" value={setups?.length} sub="Saved configurations" />
        <Stat label="On air now" value={assignments ? onAir : undefined} sub={assignments ? `${assignments.length} assignment${assignments.length === 1 ? '' : 's'}` : ''} color="var(--live)" />
        <Stat label="Need attention" value={setups && sources ? setups.filter((s) => s.upgradeAvailable).length + sources.filter((s) => s.status === 'error' || s.status === 'stale').length : undefined}
          sub="Newer versions, feed problems" color="var(--warn)" />
      </div>
      <div className="gfx-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'templates'} className={tab === 'templates' ? 'on' : ''} onClick={() => go('templates')}>Templates</button>
        <button role="tab" aria-selected={tab === 'setups'} className={tab === 'setups' ? 'on' : ''} onClick={() => go('setups')}>Setups</button>
        <button role="tab" aria-selected={tab === 'assignments'} className={tab === 'assignments' ? 'on' : ''} onClick={() => go('assignments')}>
          On channels and events {onAir > 0 && <span className="tag live">{onAir} on air</span>}</button>
        <button role="tab" aria-selected={tab === 'sources'} className={tab === 'sources' ? 'on' : ''} onClick={() => go('sources')}>Data sources</button>
      </div>
      {tab === 'templates' && <TemplatesTab templates={templates} />}
      {tab === 'setups' && <SetupsTab setups={setups} canManage={canManage} onChanged={load} />}
      {tab === 'assignments' && <AssignmentsTab assignments={assignments} setups={setups ?? []} canManage={canManage} onChanged={load} />}
      {tab === 'sources' && <SourcesTab sources={sources} canManage={canManage} onChanged={load} />}
    </>
  )
}

function Stat({ label, value, sub, color }: { label: string; value: number | undefined; sub: string; color?: string }) {
  return (
    <div className="card stat">
      <div className="lbl">{label}</div>
      <div className="val" style={color ? { color } : undefined}>{value ?? '–'}</div>
      <div className="gfx-meta" style={{ marginTop: 6 }}>{sub}</div>
    </div>
  )
}

const STATE_TONE: Record<string, string> = { ready: 'ok', in_development: 'dev', incomplete: 'err', empty: 'idle' }

/** Ready / In development / N errors / No files, with the draft's state when one is waiting. */
export function StatusPill({ t, full }: { t: Template; full?: boolean }) {
  const s = t.status
  if (!s) return null
  const extra = s.state === 'ready' && s.draft ? (s.draft.publishable ? 'draft ready to publish' : `draft has ${s.draft.errors} error${s.draft.errors === 1 ? '' : 's'}`) : ''
  const pill = (
    <span className={`gfx-status ${STATE_TONE[s.state]}`} title={s.detail}>
      <span className="d" aria-hidden="true" />{s.label}{!full && extra && <span className="x"> · {extra}</span>}
    </span>
  )
  if (!full) return pill
  return <div className="gfx-status-full">{pill}<span className="gfx-meta">{s.detail}</span></div>
}

/** The ribbon on a preview, for anything that cannot be used yet. */
export function stageBadge(t: Template): { text: string; tone: 'dev' | 'error' } | undefined {
  if (t.status?.state === 'in_development') return { text: 'In development', tone: 'dev' }
  if (t.status?.state === 'incomplete') return { text: t.status.label, tone: 'error' }
  return undefined
}

export function sourceTag(t: Template) {
  if (t.owner === 'volt') return <span className="tag gfx-volt" title={t.set ? `In Volt's ${t.set.name} set` : undefined}>{t.set ? `Volt · ${t.set.name}` : 'Volt'}</span>
  if (!t.latest) return <span className="tag gfx-draft">Draft</span>
  return <span className="tag gfx-imported">{t.source === 'duplicate' ? 'Copy' : 'Imported'}</span>
}

function TemplatesTab({ templates }: { templates: Template[] | null }) {
  const [kind, setKind] = useState<Kind | 'all'>('all')
  const [source, setSource] = useState<'all' | 'volt' | 'mine' | 'draft'>('all')
  const [q, setQ] = useState('')
  const [setKey, setSetKey] = useState('all')
  const [state, setState] = useState<'all' | 'ready' | 'in_development' | 'incomplete'>('all')
  const list = useMemo(() => (templates ?? []).filter((t) =>
    (kind === 'all' || t.kind === kind) &&
    (state === 'all' || t.status?.state === state || (state === 'incomplete' && t.status?.state === 'empty')) &&
    (source === 'all' || (source === 'volt' ? t.owner === 'volt' : source === 'mine' ? t.owner === 'account' : !!t.draft)) &&
    (setKey === 'all' || t.set?.key === setKey) &&
    (!q || t.name.toLowerCase().includes(q.toLowerCase()))), [templates, kind, source, q, state, setKey])
  if (!templates) return <div className="loading">Loading templates…</div>
  const kinds = (['all', 'scorebug', 'lower_third', 'ticker', 'bug', 'full_frame', 'other'] as const).filter((k) => k === 'all' || templates.some((t) => t.kind === k))
  const sets = [...new Map(templates.filter((t) => t.set).map((t) => [t.set!.key, t.set!.name])).entries()]
  return (
    <>
      <div className="gfx-toolbar">
        <input className="inp" style={{ width: 240 }} placeholder="Search templates" aria-label="Search templates" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="chipset">
          {kinds.map((k) => <button key={k} className={`selchip ${kind === k ? 'sel' : ''}`} onClick={() => setKind(k)}>{k === 'all' ? 'All' : KIND_LABEL[k]}</button>)}
        </div>
        <div className="spacer" />
        <label className="gfx-meta" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>Status
          <select className="inp" style={{ width: 'auto' }} value={state} onChange={(e) => setState(e.target.value as any)}>
            <option value="all">Any status</option><option value="ready">Ready</option><option value="in_development">In development</option><option value="incomplete">Has errors</option>
          </select></label>
        <label className="gfx-meta" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>Source
          <select className="inp" style={{ width: 'auto' }} value={source} onChange={(e) => setSource(e.target.value as any)}>
            <option value="all">All sources</option><option value="volt">Volt</option><option value="mine">Yours</option><option value="draft">With a draft</option>
          </select></label>
        {sets.length > 1 && <label className="gfx-meta" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>Set
          <select className="inp" style={{ width: 'auto' }} value={setKey} onChange={(e) => setSetKey(e.target.value)}>
            <option value="all">Any set</option>{sets.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
          </select></label>}
      </div>
      {list.length === 0 ? <div className="empty"><h3>No templates match</h3><p>Change the filters, or add a template.</p></div> : (
        <div className="gfx-grid">
          {list.map((t) => {
            const v = t.latest ?? t.draft
            const used = t.assignments ?? 0
            return (
              <div className="card gfx-card" key={t.id}>
                <a href={`/graphics/templates/${t.id}`} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(`/graphics/templates/${t.id}`) }} aria-label={`Preview ${t.name}`}>
                  <GraphicStage compact autoFocus focus={v?.manifest.bbox} badge={stageBadge(t)} empty="No files uploaded yet"
                    layers={v ? [{ key: t.id, url: v.url, values: previewValues(v.manifest), onAir: true, canvas: v.manifest.canvas }] : []} />
                </a>
                <div className="gfx-card-b">
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="gfx-card-t">{t.name}</div>
                      <div className="gfx-meta">{KIND_LABEL[t.kind]} · {t.latest ? `v${t.latest.version}` : 'not published'}{t.draft && t.latest ? ' · draft waiting' : ''} · {v?.manifest.fields.filter((f) => !f.hidden).length ?? 0} fields</div>
                    </div>
                    {sourceTag(t)}
                  </div>
                  <StatusPill t={t} />
                  {t.available === false && <div className="gfx-meta" style={{ color: 'var(--warn)' }}>{t.retired ? 'Retired by Volt' : 'Not switched on for this account'}: your setups keep working, new ones cannot start from it</div>}
                  <div className="gfx-meta"><span className={`gfx-dot ${used ? 'live' : ''}`} />{t.setups ? `${t.setups} setup${t.setups === 1 ? '' : 's'} · ${used} assigned` : 'Not used yet'}</div>
                  <div className="gfx-actions">
                    <button className="btn ghost sm" onClick={() => navigate(`/graphics/templates/${t.id}`)}>Preview</button>
                    {t.latest && t.available !== false && <button className="btn ghost sm" onClick={() => navigate(`/graphics/setups/new?version=${t.latest!.id}`)}>New setup</button>}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

function SetupsTab({ setups, canManage, onChanged }: { setups: Setup[] | null; canManage: boolean; onChanged: () => void }) {
  const [assign, setAssign] = useState<Setup | null>(null)
  if (!setups) return <div className="loading">Loading setups…</div>
  return (
    <>
      <div className="gfx-toolbar">
        <p className="gfx-meta" style={{ margin: 0, flex: '1 1 380px' }}>A setup is a template version plus its saved text, images, data feeds, position and layer. Build it once and assign it to any number of channels and events.</p>
      </div>
      {setups.length === 0 ? <div className="empty"><h3>No setups yet</h3><p>Open a template and choose New setup.</p></div> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Setup</th><th>Template</th><th>Content comes from</th><th>Assigned to</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {setups.map((s) => (
                <tr key={s.id}>
                  <td><a href={`/graphics/setups/${s.id}`} onClick={(e) => { e.preventDefault(); navigate(`/graphics/setups/${s.id}`) }} style={{ fontWeight: 650, color: 'var(--text)', textDecoration: 'none' }}>{s.name}</a>
                    {s.note && <div className="gfx-meta">{s.note}</div>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{s.templateName} <span className="tag type">v{s.version ?? 'draft'}</span>
                    {s.upgradeAvailable && <div className="gfx-meta" style={{ color: 'var(--warn)' }}>v{s.latestVersion} available</div>}</td>
                  <td>{s.sources.map((x) => <span key={x} className="gfx-chip">{SOURCE_LABEL[x]}</span>)}</td>
                  <td>{s.assignments.length ? s.assignments.map((a) => a.name).join(', ') : <span className="gfx-meta">Not assigned</span>}</td>
                  <td className="gfx-meta" style={{ whiteSpace: 'nowrap' }}>{new Date(s.updatedAt).toLocaleDateString()}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn ghost sm" onClick={() => navigate(`/graphics/setups/${s.id}`)}>{canManage ? 'Edit' : 'View'}</button>{' '}
                    {canManage && <button className="btn ghost sm" onClick={() => setAssign(s)}>Assign</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {assign && <AssignDialog setup={assign} onClose={() => setAssign(null)} onDone={() => { setAssign(null); onChanged() }} />}
    </>
  )
}

function AssignmentsTab({ assignments, setups, canManage, onChanged }: { assignments: Assignment[] | null; setups: Setup[]; canManage: boolean; onChanged: () => void }) {
  const [filter, setFilter] = useState<'all' | 'channel' | 'event' | 'air'>('all')
  const [pick, setPick] = useState(false)
  const [setup, setSetup] = useState<Setup | null>(null)
  const [events, setEvents] = useState<{ id: string; name: string; status: string; scheduled_start?: string }[]>([])
  useEffect(() => { api.events().then((r: any) => setEvents((Array.isArray(r) ? r : r.items ?? []).slice(0, 200))).catch(() => {}) }, [])
  if (!assignments) return <div className="loading">Loading…</div>
  const list = assignments.filter((a) => filter === 'all' || (filter === 'air' ? a.onAir : filter === 'channel' ? !!a.channelId : !!a.eventId))
  const groups = new Map<string, Assignment[]>()
  for (const a of list) { const k = (a.channelId ?? a.eventId)!; groups.set(k, [...(groups.get(k) ?? []), a]) }
  const withRundown = events.filter((e) => !assignments.some((a) => a.eventId === e.id))
  return (
    <>
      <div className="gfx-toolbar">
        <div className="chipset">
          {(['all', 'channel', 'event', 'air'] as const).map((f) => <button key={f} className={`selchip ${filter === f ? 'sel' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'Everything' : f === 'channel' ? 'Channels' : f === 'event' ? 'Events' : 'On air now'}</button>)}
        </div>
        <div className="spacer" />
        {canManage && <button className="btn ghost" onClick={() => setPick(true)}>Assign a setup</button>}
      </div>
      {groups.size === 0 && <div className="empty"><h3>Nothing assigned yet</h3><p>Assign a setup to a channel, or open an event's rundown.</p></div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {[...groups.entries()].map(([k, rows]) => {
          const first = rows[0]
          const isEvent = !!first.eventId
          return (
            <div className="card" key={k}>
              <div className="card-h">
                <h3>{first.targetName}</h3><span className={`tag type ${isEvent ? 'event' : 'chan'}`}>{isEvent ? 'Event' : 'Channel'}</span>
                <div className="spacer" />
                {isEvent ? <button className="btn ghost sm" onClick={() => navigate(`/graphics/rundown/${first.eventId}`)}>Rundown</button>
                  : <button className="btn ghost sm" onClick={() => navigate(`/graphics/channel/${first.channelId}`)}>Rules and day</button>}
                <button className="btn ghost sm" onClick={() => openLiveControl({ channelId: first.channelId, eventId: first.eventId })}>Live control</button>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="tbl">
                  <thead><tr><th>Setup</th><th>Template</th><th>Shown in</th><th>How it runs</th><th>State</th></tr></thead>
                  <tbody>{rows.map((a) => (
                    <tr key={a.id}>
                      <td style={{ fontWeight: 600 }}>{a.setupName}</td>
                      <td>{a.templateName} <span className="tag type">v{a.version ?? 'draft'}</span></td>
                      <td>{a.targets === 'burn' ? 'Burned into output' : a.targets === 'both' ? 'Burned + player' : 'Player overlay'}
                        {a.impressions24h != null && <div className="gfx-meta" title="Times it came on screen in viewers' players in the last 24 hours">{a.impressions24h.toLocaleString()} views today</div>}</td>
                      <td><span className={`gfx-mode ${a.runMode}`}>{a.runMode}</span> <span className="gfx-meta">{a.describe}</span></td>
                      <td>{!a.enabled ? <span className="tag idle">Switched off</span> : a.onAir ? <span className="tag live">Taken on</span> : <span className="tag sched">Standby</span>}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            </div>
          )
        })}
      </div>
      {withRundown.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-h"><h3>Events without graphics yet</h3><span className="sub">Open one to build its rundown</span></div>
          <div className="card-b" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {withRundown.slice(0, 12).map((e) => <button key={e.id} className="btn ghost sm" onClick={() => navigate(`/graphics/rundown/${e.id}`)}>{e.name}</button>)}
          </div>
        </div>
      )}
      {pick && (
        <div className="drawer-scrim" onClick={() => setPick(false)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Choose a setup">
            <div className="drawer-h"><div className="t">Choose a setup</div><button className="xbtn" aria-label="Close" onClick={() => setPick(false)}>✕</button></div>
            <div className="drawer-b">
              {setups.length === 0 && <p className="gfx-meta">No setups yet. Open a template and choose New setup.</p>}
              {setups.map((s) => <button key={s.id} className="gfx-opt" style={{ width: '100%', marginBottom: 8 }} onClick={() => { setPick(false); setSetup(s) }}>
                <span><b>{s.name}</b><small>{s.templateName} v{s.version}</small></span></button>)}
            </div>
          </div>
        </div>
      )}
      {setup && <AssignDialog setup={setup} onClose={() => setSetup(null)} onDone={() => { setSetup(null); onChanged() }} />}
    </>
  )
}
