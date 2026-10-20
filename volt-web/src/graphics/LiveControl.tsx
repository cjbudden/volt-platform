// LIVE CONTROL: drive the graphics of one channel or event while it is on air.
// Opens inside the console or as its own window (popout=1) for a second screen.
// Every change goes through the same state API a sports feed or a customer's
// system uses, so the panel and the API always agree (REQ FR-9).
import { useEffect, useRef, useState } from 'react'
import { navigate } from '../router'
import { useAccess } from '../access'
import { Notice } from '../notices'
import { api } from '../api'
import { gfx, fmtSec, type Live, type LiveItem, type LogRow, type Rundown, type TField } from './gfxApi'
import { GraphicStage } from './GraphicStage'
import { FieldInput } from './TemplateDetail'

function Control({ item, canOperate, onChange, setErr }: { item: LiveItem; canOperate: boolean; onChange: () => void; setErr: (s: string) => void }) {
  const [draft, setDraft] = useState<Record<string, any>>({})
  const [busy, setBusy] = useState(false)
  const editable = item.fields.filter((f) => !f.hidden && ['operator', 'api', 'feed', 'text', 'override'].includes(item.origin[f.id] ?? 'unset') && f.type !== 'image')
  const send = async (values: Record<string, any>, release: string[] = []) => {
    setBusy(true)
    try { await gfx.setValues(item.id, values, release); setDraft({}); onChange() } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const air = async (on: boolean, forSec?: number) => {
    setBusy(true)
    try { await gfx.air(item.id, on, forSec); onChange() } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const dirty = Object.keys(draft).length > 0
  const val = (f: TField) => f.id in draft ? draft[f.id] : item.values[f.id]
  const handOn = item.takenByHand
  return (
    <div className="card gfx-ctl">
      <div className="gfx-ctl-h">
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 15 }}>{item.setupName}</span>
            {!item.enabled ? <span className="tag idle">Switched off</span> : item.onAir ? <span className="tag live">On air</span> : <span className="tag sched">Standby</span>}
            <span className={`gfx-mode ${item.runMode}`}>{item.runMode}</span>
          </div>
          <div className="gfx-meta" style={{ marginTop: 3 }}>{item.targets === 'burn' ? 'Burned into output' : item.targets === 'both' ? 'Burned + player' : 'Player overlay'} · {item.reason}
            {item.offAt ? ` · off at ${new Date(item.offAt).toLocaleTimeString()}` : ''}{item.staleFeeds.length ? ' · feed is stale' : ''}</div>
        </div>
        {canOperate && item.enabled && (handOn
          ? <button className="btn take off" disabled={busy} onClick={() => air(false)}>TAKE OFF</button>
          : item.runMode === 'manual' ? <button className="btn take go" disabled={busy} onClick={() => air(true)}>TAKE ON</button>
          : <button className="btn ghost sm" disabled={busy} title="Keep it on screen whatever its rule says, until you take it off" onClick={() => air(true)}>Hold on screen</button>)}
      </div>
      {canOperate && !handOn && item.enabled && item.runMode === 'manual' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {[10, 15, 30].map((s) => <button key={s} className="btn ghost sm" disabled={busy} onClick={() => air(true, s)}>On for {fmtSec(s)}</button>)}
        </div>
      )}
      {editable.length > 0 && (
        <form onSubmit={(e) => { e.preventDefault(); if (dirty) send(draft) }}>
          <div className="gfx-ctl-fields">
            {editable.map((f) => (
              <div className="field" key={f.id} style={{ margin: 0 }}>
                <label htmlFor={`lc-${item.id}-${f.id}`}>{f.label} <span className="gfx-meta">· {item.origin[f.id] === 'override' ? 'set by hand' : item.origin[f.id] === 'feed' ? 'from feed' : item.origin[f.id]}</span></label>
                {f.type === 'number' && !f.options?.length && canOperate
                  ? <div className="gfx-step">
                      <button type="button" className="btn ghost" aria-label={`${f.label} down`} disabled={busy} onClick={() => send({ [f.id]: Number(item.values[f.id] || 0) - 1 })}>−</button>
                      <div className="v" aria-live="polite">{String(item.values[f.id] ?? '')}</div>
                      <button type="button" className="btn ghost" aria-label={`${f.label} up`} disabled={busy} onClick={() => send({ [f.id]: Number(item.values[f.id] || 0) + 1 })}>+</button>
                    </div>
                  : <FieldInput id={`lc-${item.id}-${f.id}`} f={f} value={val(f)} onChange={(v) => setDraft((d) => ({ ...d, [f.id]: v }))} />}
              </div>
            ))}
          </div>
          {canOperate && dirty && <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
            <button type="button" className="btn ghost sm" onClick={() => setDraft({})}>Discard</button>
            <button className="btn primary sm" disabled={busy}>Update on air</button></div>}
        </form>
      )}
      {item.overrides.length > 0 && canOperate && (
        <div className="gfx-override">
          {item.overrides.map((k) => item.fields.find((f) => f.id === k)?.label ?? k).join(', ')} set by hand: the feed will not change {item.overrides.length === 1 ? 'it' : 'them'} until you hand back.
          <div style={{ flex: 1 }} /><button className="btn ghost sm" disabled={busy} onClick={() => send({}, item.overrides)}>Back to feed</button>
        </div>
      )}
    </div>
  )
}

export function LiveControl({ channelId, eventId, popout }: { channelId: string | null; eventId: string | null; popout: boolean }) {
  const { can } = useAccess()
  const canOperate = can('graphics', 'operate')
  const [live, setLive] = useState<Live | null>(null)
  const [rd, setRd] = useState<Rundown | null>(null)
  const [log, setLog] = useState<LogRow[]>([])
  const [targets, setTargets] = useState<{ v: string; name: string; group: string }[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const t = useRef({ channelId, eventId })
  t.current = { channelId, eventId }
  const q = eventId ? { event_id: eventId } : channelId ? { channel_id: channelId } : null
  const load = () => {
    if (!q) return
    gfx.live(q).then((l) => { setLive(l); setErr((e) => e.startsWith('Lost') ? '' : e) }).catch((e) => setErr(`Lost the connection: ${e.message}`))
    gfx.log({ ...q, limit: '30' }).then((r) => setLog(r.items)).catch(() => {})
    if (eventId) gfx.rundown(eventId).then(setRd).catch(() => {})
  }
  useEffect(() => { load(); const h = setInterval(load, 1000); return () => clearInterval(h) }, [channelId, eventId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    Promise.all([api.channels('tv').catch(() => []), api.events().catch(() => [])]).then(([c, e]: any) => setTargets([
      ...(c as any[]).map((x) => ({ v: `channel_id=${x.id}`, name: x.name, group: 'Channels' })),
      ...((Array.isArray(e) ? e : e.items ?? []) as any[]).map((x) => ({ v: `event_id=${x.id}`, name: x.name, group: 'Events' })),
    ]))
  }, [])
  useEffect(() => { if (live) document.title = `${live.target.name} · Graphics live control` }, [live?.target.name]) // eslint-disable-line react-hooks/exhaustive-deps

  const switchTo = (v: string) => navigate(`/graphics/live?${v}${popout ? '&popout=1' : ''}`)
  const take = async (fn: () => Promise<any>) => { setBusy(true); try { setRd(await fn()); load() } catch (e: any) { setErr(e.message) } finally { setBusy(false) } }
  const onAirRd = rd?.items.filter((i) => i.status === 'on_air') ?? []
  const next = rd?.items.find((i) => i.id === rd.nextId)
  const cur = eventId ? `event_id=${eventId}` : channelId ? `channel_id=${channelId}` : ''

  const body = (
    <div className="gfx-live-b">
      <div style={{ flex: '1 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="card card-b">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}><span className="sec-label" style={{ margin: 0 }}>Output</span>
            <span className="gfx-meta">What the graphics look like now. Viewers see it a few seconds behind, with the stream.</span></div>
          <GraphicStage layers={(live?.items ?? []).map((i) => ({ key: i.id, url: i.templateUrl, values: i.values, onAir: i.onAir, canvas: i.canvas, placement: i.placement }))} />
        </div>
        <div className="card card-b gfx-log">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}><span className="sec-label" style={{ margin: 0 }}>Changes</span><div style={{ flex: 1 }} /><span className="gfx-meta">Kept with who made each one</span></div>
          {log.length === 0 && <div className="gfx-meta">Nothing yet.</div>}
          {log.map((l, i) => (
            <div key={i}><time>{new Date(l.at).toLocaleTimeString()}</time><b title={l.actor}>{l.actor.replace(/@.*/, '')}</b>
              <span>{l.action === 'set' ? `${l.setupName ?? ''}: ${l.field} ${l.old != null ? JSON.stringify(l.old) + ' → ' : ''}${JSON.stringify(l.new)}`
                : l.action === 'take' ? `Took ${l.new?.title ?? ''}` : l.action === 'take_off' ? `Took off ${l.old?.title ?? ''}`
                : l.action === 'release' ? `${l.setupName ?? ''}: ${l.field} back to the feed` : `${l.setupName ?? ''} ${l.action === 'on' ? 'taken on' : 'taken off'}`}</span></div>
          ))}
        </div>
      </div>
      <div style={{ flex: '1 1 460px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {rd && rd.items.length > 0 && (
          <div className="card gfx-runbar" style={{ margin: 0 }}>
            <div className="slot"><div className="lbl" style={{ color: 'var(--live)' }}>Rundown on air</div><div style={{ fontWeight: 700, marginTop: 3 }}>{onAirRd.map((i) => i.title).join(', ') || 'Nothing'}</div></div>
            <div className="slot"><div className="lbl" style={{ color: 'var(--sched)' }}>Next</div><div style={{ fontWeight: 700, marginTop: 3 }}>{next?.title ?? 'End of the manual items'}</div></div>
            {canOperate && <><button className="btn take off" disabled={busy || !onAirRd.length} onClick={() => take(() => gfx.takeOff(eventId!))}>TAKE OFF</button>
              <button className="btn take go" disabled={busy || !next} onClick={() => take(() => gfx.take(eventId!))}>TAKE NEXT</button></>}
            <button className="btn ghost sm" onClick={() => popout ? window.open(`/graphics/rundown/${eventId}`, '_blank') : navigate(`/graphics/rundown/${eventId}`)}>Full rundown</button>
          </div>
        )}
        {live?.items.length === 0 && <div className="empty"><h3>No graphics here yet</h3><p>Assign a setup to this {live.target.kind}{live.target.kind === 'event' ? ' or build its rundown' : ''}.</p></div>}
        {live?.items.map((i) => <Control key={i.id} item={i} canOperate={canOperate} onChange={load} setErr={setErr} />)}
      </div>
    </div>
  )

  return (
    <div className={popout ? 'gfx-live' : ''}>
      <div className={popout ? 'gfx-live-h' : 'page-head'} style={popout ? undefined : { alignItems: 'center' }}>
        {popout && <span style={{ fontWeight: 800 }}>Graphics live control</span>}
        {!popout && <div style={{ flex: '1 1 260px' }}><h1>Live control</h1><p>Take graphics on and off and change their values while on air.</p></div>}
        <label htmlFor="lc-target" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Channel or event</label>
        <select id="lc-target" className="inp" style={{ width: 'auto', minWidth: 260, fontWeight: 600 }} value={cur} onChange={(e) => switchTo(e.target.value)}>
          {!cur && <option value="">Choose a channel or event…</option>}
          {['Channels', 'Events'].map((g) => <optgroup key={g} label={g}>{targets.filter((x) => x.group === g).map((x) => <option key={x.v} value={x.v}>{x.name}</option>)}</optgroup>)}
        </select>
        {live && (live.target.live ? <span className="tag live">Live</span> : <span className="tag idle">Not live</span>)}
        <div style={{ flex: 1 }} />
        {!popout && cur && <button className="btn ghost" onClick={() => window.open(`/graphics/live?${cur}&popout=1`, `volt-gfx-${eventId ?? channelId}`, 'popup,width=1360,height=880')}>Open in its own window</button>}
        {popout && <button className="btn ghost sm" onClick={() => window.close()}>Close</button>}
      </div>
      {err && <div style={popout ? { padding: '12px 20px 0' } : undefined}><Notice kind="error" message={err} /></div>}
      {!q ? <div className="empty"><h3>Choose a channel or event</h3></div> : !live ? <div className="loading">Loading…</div> : body}
    </div>
  )
}
