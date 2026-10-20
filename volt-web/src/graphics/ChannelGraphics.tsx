// A channel's graphics: each runs always, by rule, on a trigger or by hand,
// and the day strip shows from the guide when each one will be on.
import { useEffect, useState } from 'react'
import { navigate } from '../router'
import { useAccess } from '../access'
import { Notice, useNotify } from '../notices'
import { ConfirmDialog } from '../listActions'
import { gfx, type Assignment, type Live, type Plan, type Setup } from './gfxApi'
import { GraphicStage } from './GraphicStage'
import { AssignDialog } from './AssignDialog'
import { openLiveControl } from './Graphics'

const LANE_COLOR: Record<string, string> = { always: '#3f7bff', rule: '#a78bfa', trigger: '#38bdf8', manual: '#98a1b6' }

export function DayStrip({ plan, from, to }: { plan: Plan; from: Date; to: Date }) {
  const span = to.getTime() - from.getTime()
  const pct = (d: string | Date) => `${Math.max(0, Math.min(100, ((new Date(d).getTime() - from.getTime()) / span) * 100))}%`
  const width = (a: string, b: string) => `${Math.max(0.15, ((Math.min(new Date(b).getTime(), to.getTime()) - Math.max(new Date(a).getTime(), from.getTime())) / span) * 100)}%`
  const hours = Array.from({ length: 9 }, (_, i) => new Date(from.getTime() + (span / 8) * i))
  const now = Date.now()
  const showNow = now >= from.getTime() && now <= to.getTime()
  return (
    <div style={{ overflowX: 'auto' }}>
      <div className="gfx-strip">
        <span />
        <div style={{ position: 'relative', height: 16 }}>
          {hours.map((h, i) => <span key={i} className="gfx-meta" style={{ position: 'absolute', left: pct(h), transform: i === 0 ? 'none' : i === 8 ? 'translateX(-100%)' : 'translateX(-50%)', fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 11 }}>
            {h.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span>)}
        </div>
        <span className="sec-label" style={{ margin: 0 }}>Guide</span>
        <div className="lane guide">
          {plan.programmes.map((p) => <div key={p.id} className="prog" title={`${p.title} ${new Date(p.startsAt).toLocaleTimeString()}`}
            style={{ left: pct(p.startsAt), width: width(p.startsAt, p.endsAt), background: p.kind === 'ad' ? '#5b3a1a' : p.genres.some((g) => /news/i.test(g)) ? '#1e3a8a' : '#2b3244' }}>{p.title}</div>)}
          {showNow && <div className="now" style={{ left: pct(new Date()) }} />}
        </div>
        {plan.assignments.map((a) => (
          <div key={a.id} style={{ display: 'contents' }}>
            <span style={{ fontSize: 'var(--fs-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.setupName}</span>
            <div className="lane">
              {a.windows.map((w, i) => <div key={i} className="bar" title={w.reason} style={{ left: pct(w.start), width: width(w.start, w.end), background: LANE_COLOR[a.runMode] }} />)}
              {a.runMode === 'manual' && <span className="gfx-meta" style={{ position: 'absolute', left: 8, top: 2, fontSize: 11 }}>By hand from live control</span>}
              {showNow && <div className="now" style={{ left: pct(new Date()) }} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ChannelGraphics({ channelId }: { channelId: string }) {
  const { can } = useAccess()
  const canManage = can('graphics', 'manage')
  const notify = useNotify()
  const [live, setLive] = useState<Live | null>(null)
  const [list, setList] = useState<Assignment[] | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [setups, setSetups] = useState<Setup[]>([])
  const [day, setDay] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d })
  const [pick, setPick] = useState(false)
  const [assignSetup, setAssignSetup] = useState<Setup | null>(null)
  const [edit, setEdit] = useState<Assignment | null>(null)
  const [confirm, setConfirm] = useState<Assignment | null>(null)
  const [err, setErr] = useState('')
  const to = new Date(day.getTime() + 86400_000)
  const load = () => {
    gfx.live({ channel_id: channelId }).then(setLive).catch((e) => setErr(e.message))
    gfx.assignments({ channel_id: channelId }).then((r) => setList(r.items)).catch((e) => setErr(e.message))
    gfx.plan({ channel_id: channelId, from: day.toISOString(), to: to.toISOString() }).then(setPlan).catch(() => setPlan(null))
  }
  useEffect(load, [channelId, day]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { gfx.setups().then((r) => setSetups(r.items)).catch(() => {}) }, [])
  useEffect(() => { const h = setInterval(() => gfx.live({ channel_id: channelId }).then(setLive).catch(() => {}), 5000); return () => clearInterval(h) }, [channelId])

  const toggle = async (a: Assignment) => {
    try { await gfx.patchAssignment(a.id, { enabled: !a.enabled }); load() } catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }
  const nowItem = (id: string) => live?.items.find((i) => i.id === id)
  const name = live?.target.name ?? 'Channel'
  return (
    <>
      <div className="gfx-meta" style={{ marginBottom: 6 }}>
        <a href={`/channels/${channelId}`} onClick={(e) => { e.preventDefault(); navigate(`/channels/${channelId}`) }}>{name}</a> / Graphics</div>
      <div className="page-head">
        <div style={{ flex: '1 1 320px' }}>
          <h1>{name} graphics</h1>
          <p>Graphics here run on their own from the guide. {live?.target.workflow === 'package_only' ? 'This channel is packaging only, so graphics are drawn by the player; burned graphics come from your encoder.' : ''}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn ghost" onClick={() => openLiveControl({ channelId })}>Live control</button>
          {canManage && <button className="btn primary" onClick={() => setPick(true)}>Add graphic</button>}
        </div>
      </div>
      {err && <Notice kind="error" message={err} />}
      <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
        {([['always', 'Always', 'On whenever the channel is on air.'], ['rule', 'Rule', 'While the programme matches a genre, title or time.'],
          ['trigger', 'Trigger', 'For a set time at the start or end of each programme.']] as const).map(([k, t, d]) => (
          <div className="card card-b" key={k}><span className={`gfx-mode ${k}`}>{t}</span><div className="gfx-meta" style={{ marginTop: 8 }}>{d}</div></div>))}
      </div>

      <div className="gfx-split">
        <div className="main">
          <div className="card" style={{ overflowX: 'auto' }}>
            {!list ? <div className="loading">Loading…</div> : list.length === 0 ? <div className="empty"><h3>No graphics on this channel</h3><p>Add a setup and choose how it runs.</p></div> : (
              <table className="tbl">
                <thead><tr><th>On</th><th>Graphic</th><th>How it runs</th><th>Shown in</th><th>Now</th><th /></tr></thead>
                <tbody>{list.map((a) => {
                  const n = nowItem(a.id)
                  return (
                    <tr key={a.id}>
                      <td><button className={`sw ${a.enabled ? '' : 'off'}`} aria-label={`${a.enabled ? 'Switch off' : 'Switch on'} ${a.setupName}`} aria-pressed={a.enabled} disabled={!canManage} onClick={() => toggle(a)}><i /></button></td>
                      <td><div style={{ fontWeight: 650 }}>{a.setupName}</div><div className="gfx-meta">{a.templateName} v{a.version}</div></td>
                      <td><span className={`gfx-mode ${a.runMode}`}>{a.runMode}</span><div className="gfx-meta" style={{ marginTop: 4 }}>{a.describe}</div></td>
                      <td className="gfx-meta">{a.targets === 'burn' ? 'Burned' : a.targets === 'both' ? 'Burned + player' : 'Player'}
                        {a.impressions24h != null && <div title="Times it came on screen in viewers' players in the last 24 hours">{a.impressions24h.toLocaleString()} views today</div>}</td>
                      <td>{!a.enabled ? <span className="tag idle">Off</span> : n?.onAir ? <span className="tag live" title={n.reason}>On air</span> : <span className="tag sched" title={n?.reason}>Waiting</span>}
                        {n && <div className="gfx-meta">{n.reason}</div>}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {canManage && <><button className="btn ghost sm" onClick={() => setEdit(a)}>Edit</button>{' '}
                          <button className="btn ghost sm" onClick={() => setConfirm(a)}>Remove</button></>}</td>
                    </tr>)
                })}</tbody>
              </table>
            )}
          </div>
          <div className="card card-b">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <b>{day.toDateString() === new Date().toDateString() ? 'Today' : day.toLocaleDateString()}, from the guide</b>
              <span className="gfx-meta">When each graphic will be on. Change the guide and this follows.</span>
              <div style={{ flex: 1 }} />
              <button className="btn ghost sm" aria-label="Previous day" onClick={() => setDay(new Date(day.getTime() - 86400_000))}>‹</button>
              <button className="btn ghost sm" onClick={() => { const d = new Date(); d.setHours(0, 0, 0, 0); setDay(d) }}>Today</button>
              <button className="btn ghost sm" aria-label="Next day" onClick={() => setDay(new Date(day.getTime() + 86400_000))}>›</button>
            </div>
            {plan ? (plan.programmes.length === 0 ? <div className="gfx-meta">No guide for this day. Rules and triggers need one; always-on graphics run regardless.</div>
              : <DayStrip plan={plan} from={day} to={to} />) : <div className="loading">Loading…</div>}
          </div>
        </div>
        <div className="side">
          <div className="card card-b">
            <b>On screen now</b>
            <div style={{ marginTop: 10 }}>
              <GraphicStage layers={(live?.items ?? []).map((i) => ({ key: i.id, url: i.templateUrl, values: i.values, onAir: i.onAir, canvas: i.canvas, placement: i.placement }))} safeArea />
            </div>
            <div className="gfx-meta" style={{ marginTop: 8 }}>Refreshes every 5 seconds. Live control updates as you work.</div>
          </div>
        </div>
      </div>

      {pick && (
        <div className="drawer-scrim" onClick={() => setPick(false)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Choose a setup">
            <div className="drawer-h"><div className="t">Choose a setup</div><button className="xbtn" aria-label="Close" onClick={() => setPick(false)}>✕</button></div>
            <div className="drawer-b">
              {setups.length === 0 && <p className="gfx-meta">No setups yet. Build one from a template first.</p>}
              {setups.map((s) => <button key={s.id} className="gfx-opt" style={{ width: '100%', marginBottom: 8 }} onClick={() => { setPick(false); setAssignSetup(s) }}>
                <span><b>{s.name}</b><small>{s.templateName} v{s.version}</small></span></button>)}
              <button className="btn ghost" onClick={() => navigate('/graphics')}>Go to templates</button>
            </div>
          </div>
        </div>
      )}
      {assignSetup && <AssignDialog setup={assignSetup} fixed={{ channelId }} onClose={() => setAssignSetup(null)} onDone={() => { setAssignSetup(null); load() }} />}
      {edit && <AssignDialog setup={{ id: edit.setupId, name: edit.setupName }} edit={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load() }} />}
      {confirm && <ConfirmDialog danger title={`Remove ${confirm.setupName} from ${name}?`} body="The setup itself stays in the library." confirmLabel="Remove"
        onCancel={() => setConfirm(null)} onConfirm={async () => { const a = confirm; setConfirm(null); try { await gfx.unassign(a.id); load() } catch (e: any) { notify({ kind: 'error', message: e.message }) } }} />}
    </>
  )
}
