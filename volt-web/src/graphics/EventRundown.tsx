// An event's graphics rundown: the graphics the event needs, in order and by
// segment, each with its content and cue. Prepare it before; run it live with
// Take next. Automatic cues (a time, an offset from the start, a feed event, a
// repeat) fire on their own and stay visible in the list.
import { useEffect, useMemo, useRef, useState } from 'react'
import { navigate } from '../router'
import { useAccess } from '../access'
import { Notice, useNotify } from '../notices'
import { ConfirmDialog } from '../listActions'
import { api } from '../api'
import { cueText, fmtSec, gfx, type Cue, type DataSource, type Rundown, type RundownItem, type Setup } from './gfxApi'
import { GraphicStage } from './GraphicStage'
import { FieldInput } from './TemplateDetail'
import { openLiveControl } from './Graphics'

const STATUS: Record<RundownItem['status'], [string, string]> = { ready: ['Ready', 'type'], on_air: ['On air', 'live'], done: ['Done', 'idle'], skipped: ['Skipped', 'idle'] }

function CueEditor({ cue, setCue, sources }: { cue: Cue; setCue: (c: Cue) => void; sources: DataSource[] }) {
  const localTime = (iso?: string) => { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }
  return (
    <>
      <div className="field"><label htmlFor="cue-kind">Cue</label>
        <select id="cue-kind" className="inp" value={cue.kind} onChange={(e) => {
          const k = e.target.value as Cue['kind']
          setCue(k === 'repeat' ? { kind: k, everySec: 600 } : k === 'offset' ? { kind: k, fromStartSec: 0 } : k === 'time' ? { kind: k, at: new Date().toISOString() } : k === 'feed' ? { kind: k, sourceId: sources[0]?.id, path: '' } : { kind: 'manual' })
        }}>
          <option value="manual">Manual: Take next</option><option value="time">At a clock time</option><option value="offset">After the event starts</option>
          <option value="feed">On a data feed event</option><option value="repeat">Repeat while live</option></select></div>
      {cue.kind === 'time' && <div className="field"><label htmlFor="cue-at">At</label><input id="cue-at" className="inp" type="datetime-local" value={localTime(cue.at)} onChange={(e) => setCue({ ...cue, at: new Date(e.target.value).toISOString() })} /></div>}
      {cue.kind === 'offset' && <div className="field"><label htmlFor="cue-off">Minutes after the start</label><input id="cue-off" className="inp" type="number" min={0} value={Math.round((cue.fromStartSec ?? 0) / 60)} onChange={(e) => setCue({ ...cue, fromStartSec: Number(e.target.value) * 60 })} /></div>}
      {cue.kind === 'repeat' && <div className="field"><label htmlFor="cue-ev">Every (minutes)</label><input id="cue-ev" className="inp" type="number" min={1} value={Math.round((cue.everySec ?? 600) / 60)} onChange={(e) => setCue({ ...cue, everySec: Number(e.target.value) * 60 })} /></div>}
      {cue.kind === 'feed' && <>
        <div className="field"><label htmlFor="cue-src">Data source</label><select id="cue-src" className="inp" value={cue.sourceId ?? ''} onChange={(e) => setCue({ ...cue, sourceId: e.target.value })}>
          <option value="">Choose…</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="field"><label htmlFor="cue-path">When this changes</label><input id="cue-path" className="inp" placeholder="lastEvent.type" value={cue.path ?? ''} onChange={(e) => setCue({ ...cue, path: e.target.value })} /></div>
          <div className="field"><label htmlFor="cue-eq">To (optional)</label><input id="cue-eq" className="inp" placeholder="try" value={cue.equals ?? ''} onChange={(e) => setCue({ ...cue, equals: e.target.value || undefined })} /></div>
        </div></>}
    </>
  )
}

export function EventRundown({ eventId }: { eventId: string }) {
  const { can } = useAccess()
  const canManage = can('graphics', 'manage'), canOperate = can('graphics', 'operate')
  const notify = useNotify()
  const [rd, setRd] = useState<Rundown | null>(null)
  const [setups, setSetups] = useState<Setup[]>([])
  const [sources, setSources] = useState<DataSource[]>([])
  const [mode, setMode] = useState<'prepare' | 'run'>('prepare')
  const [sel, setSel] = useState<string | null>(null)
  const [form, setForm] = useState<Partial<RundownItem> & { isNew?: boolean } | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [copy, setCopy] = useState(false)
  const [events, setEvents] = useState<{ id: string; name: string }[]>([])
  const [confirm, setConfirm] = useState<RundownItem | null>(null)
  const csv = useRef<HTMLInputElement>(null)

  const load = () => gfx.rundown(eventId).then((r) => { setRd(r); if (r.event.live && mode === 'prepare' && !sel) setMode('run') }).catch((e) => setErr(e.message))
  useEffect(() => { load(); gfx.setups().then((r) => setSetups(r.items)).catch(() => {}); gfx.sources().then((r) => setSources(r.items)).catch(() => {}) }, [eventId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (mode !== 'run') return; const h = setInterval(load, 2000); return () => clearInterval(h) }, [mode, eventId]) // eslint-disable-line react-hooks/exhaustive-deps
  const item = rd?.items.find((i) => i.id === sel) ?? null
  useEffect(() => { if (item && mode === 'prepare') setForm({ ...item }) }, [sel]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<Rundown | any>, ok?: string) => {
    setErr(''); setBusy(true)
    try { const r = await fn(); if (r?.items) setRd(r); else await load(); if (ok) notify({ kind: 'ok', message: ok }) } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const segments = useMemo(() => {
    const out: { name: string; items: RundownItem[] }[] = []
    for (const i of rd?.items ?? []) { const last = out[out.length - 1]; if (last && last.name === i.segment) last.items.push(i); else out.push({ name: i.segment, items: [i] }) }
    return out
  }, [rd])
  if (err && !rd) return <Notice kind="error" message={err} />
  if (!rd) return <div className="loading">Loading rundown…</div>

  const formSetup = setups.find((s) => s.id === form?.setupId)
  const operatorFields = (formSetup?.templateFields ?? []).filter((f) => !f.hidden)
  const saveForm = () => form && act(async () => {
    if (!form.title?.trim()) throw new Error('Give the item a title.')
    if (!form.setupId) throw new Error('Choose a setup.')
    const body = { title: form.title, segment: form.segment ?? '', setupId: form.setupId, values: form.values ?? {}, cue: form.cue ?? { kind: 'manual' as const }, staysSec: form.staysSec ?? null }
    const r = form.isNew ? await gfx.addItem(eventId, body) : await gfx.patchItem(eventId, form.id!, body)
    if (form.isNew) { setForm(null); setSel(null) }
    return r
  }, 'Saved.')
  const move = (i: RundownItem, d: -1 | 1) => {
    const ids = rd.items.map((x) => x.id); const k = ids.indexOf(i.id); const j = k + d
    if (j < 0 || j >= ids.length) return
    ;[ids[k], ids[j]] = [ids[j], ids[k]]
    // Moving across a segment boundary takes the neighbour's segment.
    const segs = { [i.id]: rd.items[j].segment }
    act(() => gfx.reorder(eventId, ids, segs))
  }
  const onAir = rd.items.filter((i) => i.status === 'on_air')
  const next = rd.items.find((i) => i.id === rd.nextId)
  const preview = form ?? item
  const pSetup = setups.find((s) => s.id === preview?.setupId)
  const pValues = pSetup ? { ...Object.fromEntries(Object.entries(pSetup.fields).map(([k, b]) => [k, b.value ?? ''])), ...(preview?.values ?? {}) } : {}

  return (
    <>
      <div className="gfx-meta" style={{ marginBottom: 6 }}><a href="/events" onClick={(e) => { e.preventDefault(); navigate('/events') }}>Events</a> / {rd.event.name} / Graphics</div>
      <div className="page-head">
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}><h1>{rd.event.name}</h1>
            {rd.event.live ? <span className="tag live">Live</span> : <span className="tag sched">Scheduled</span>}</div>
          <p>{rd.event.start ? new Date(rd.event.start).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}
            {rd.event.end ? ` to ${new Date(rd.event.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''} · {rd.items.length} graphics
            {rd.items.some((i) => i.needsContent) ? ` · ${rd.items.filter((i) => i.needsContent).length} need content` : ''}</p>
        </div>
        <div className="seg-choice" role="group" aria-label="Mode"><button className={mode === 'prepare' ? 'sel' : ''} onClick={() => setMode('prepare')}>Prepare</button>
          <button className={mode === 'run' ? 'sel' : ''} onClick={() => { setMode('run'); setForm(null) }}>Run</button></div>
        <button className="btn ghost" onClick={() => openLiveControl({ eventId })}>Pop out</button>
      </div>
      {err && <Notice kind="error" message={err} />}

      {mode === 'run' && (
        <div className="card gfx-runbar">
          <div className="slot"><div className="lbl" style={{ color: 'var(--live)' }}>On air</div>
            <div style={{ fontWeight: 700, fontSize: 15, marginTop: 3 }}>{onAir.length ? onAir.map((i) => i.title).join(', ') : 'Nothing from the rundown'}</div>
            {onAir[0] && <div className="gfx-meta">{onAir[0].setupName} · {fmtSec(onAir[0].staysSec)}</div>}</div>
          <div className="slot"><div className="lbl" style={{ color: 'var(--sched)' }}>Next</div>
            <div style={{ fontWeight: 700, fontSize: 15, marginTop: 3 }}>{next ? next.title : 'End of the manual items'}</div>
            {next && <div className="gfx-meta">{next.setupName}{next.needsContent ? ' · needs content' : ''}</div>}</div>
          {canOperate && <>
            <button className="btn take off" disabled={busy || !onAir.length} onClick={() => act(() => gfx.takeOff(eventId))}>TAKE OFF</button>
            <button className="btn take go" disabled={busy || !next} onClick={() => act(() => gfx.take(eventId))}>TAKE NEXT</button></>}
        </div>
      )}

      <div className="gfx-split">
        <div className="main">
          <div className="card" style={{ overflowX: 'auto' }}>
            <div className="card-h"><h3>Graphics rundown</h3><div className="spacer" />
              {mode === 'prepare' && canManage && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn ghost sm" onClick={() => { setCopy(true); api.events().then((r: any) => setEvents((Array.isArray(r) ? r : r.items ?? []).filter((e: any) => e.id !== eventId))).catch(() => {}) }}>Copy from another event</button>
                <input ref={csv} type="file" accept=".csv,text/csv" hidden onChange={async (e) => {
                  const f = e.target.files?.[0]; if (!f) return; const text = await f.text(); e.target.value = ''
                  act(() => gfx.importCsv(eventId, text, Intl.DateTimeFormat().resolvedOptions().timeZone), 'Imported.')
                }} />
                <button className="btn ghost sm" title="Columns: segment, title, setup, cue (manual, HH:MM, +seconds, every N), stays, values (field=value;field=value)" onClick={() => csv.current?.click()}>Import CSV</button>
                <button className="btn primary sm" onClick={() => { setSel(null); setForm({ isNew: true, title: '', segment: rd.items[rd.items.length - 1]?.segment ?? '', setupId: setups[0]?.id, values: {}, cue: { kind: 'manual' }, staysSec: 8 }) }}>Add graphic</button>
              </div>}
            </div>
            {rd.items.length === 0 ? <div className="empty"><h3>No graphics yet</h3><p>Add the graphics this event needs, in the order they go to air. Group them by segment.</p></div> : (
              <table className="gfx-rd" style={{ minWidth: 760 }}>
                <thead><tr>{mode === 'prepare' && canManage && <th style={{ width: 30 }} />}<th style={{ width: 34 }}>#</th><th>Graphic</th><th>Setup</th><th>Cue</th><th>Stays</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {segments.map((g, gi) => [
                    <tr className="gfx-seg" key={'s' + gi}><td colSpan={8}>{g.name || 'No segment'}</td></tr>,
                    ...g.items.map((i) => {
                      const cls = ['item', i.id === sel ? 'sel' : '', i.status === 'on_air' ? 'air' : '', i.id === rd.nextId ? 'next' : '', i.status === 'skipped' ? 'skipped' : ''].join(' ')
                      const [label, tag] = i.status === 'ready' && i.cue.kind !== 'manual' ? ['Armed', 'filler'] : i.id === rd.nextId ? ['Next', 'sched'] : STATUS[i.status]
                      return (
                        <tr key={i.id} className={cls} onClick={() => setSel(i.id)} aria-selected={i.id === sel}>
                          {mode === 'prepare' && canManage && <td><span className="mv"><button aria-label={`Move ${i.title} up`} onClick={(e) => { e.stopPropagation(); move(i, -1) }}>▲</button>
                            <button aria-label={`Move ${i.title} down`} onClick={(e) => { e.stopPropagation(); move(i, 1) }}>▼</button></span></td>}
                          <td className="gfx-meta" style={{ fontFamily: 'ui-monospace,Menlo,monospace' }}>{i.position}</td>
                          <td><div style={{ fontWeight: 650 }}>{i.title}</div>
                            <div className="gfx-meta" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{Object.values(i.values ?? {}).filter((v) => typeof v === 'string' || typeof v === 'number').join(' · ') || ' '}</div></td>
                          <td className="gfx-meta">{i.setupName}</td>
                          <td style={{ fontSize: 'var(--fs-sm)' }}>{cueText(i.cue, sources)}</td>
                          <td className="gfx-meta">{fmtSec(i.staysSec)}</td>
                          <td><span className={`tag ${i.needsContent && i.status === 'ready' ? 'warn' : tag}`}>{i.needsContent && i.status === 'ready' ? 'Needs content' : label}</span></td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                            {mode === 'run' && canOperate && (i.status === 'on_air'
                              ? <button className="btn ghost sm" onClick={() => act(() => gfx.takeOff(eventId, i.id))}>Take off</button>
                              : i.status === 'skipped' ? <button className="btn ghost sm" onClick={() => act(() => gfx.skip(eventId, i.id, true))}>Restore</button>
                              : <><button className="btn ghost sm" onClick={() => act(() => gfx.take(eventId, i.id))}>Take</button>{' '}
                                  {i.status === 'ready' && <button className="btn ghost sm" onClick={() => act(() => gfx.skip(eventId, i.id))}>Skip</button>}</>)}
                            {mode === 'prepare' && canManage && i.status !== 'on_air' && <button className="btn ghost sm" aria-label={`Remove ${i.title}`} title="Remove" onClick={() => setConfirm(i)} style={{ padding: '0 8px' }}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg></button>}
                          </td>
                        </tr>)
                    }),
                  ])}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="side">
          <div className="card card-b">
            <b>{form?.isNew ? 'New graphic' : preview ? `#${(preview as RundownItem).position ?? ''} ${preview.title}` : 'Select a graphic'}</b>
            <div style={{ marginTop: 10 }}>
              {pSetup ? <GraphicStage layers={[{ key: 'rd', url: pSetup.templateUrl, values: pValues, onAir: true, canvas: pSetup.canvas, placement: pSetup.placement }]} safeArea />
                : <div className="gfx-stage bg-picture" />}
            </div>
            {mode === 'prepare' && form && canManage ? (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="field"><label htmlFor="it-title">Title</label><input id="it-title" className="inp" value={form.title ?? ''} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
                  <div className="field"><label htmlFor="it-seg">Segment</label><input id="it-seg" className="inp" list="rd-segs" value={form.segment ?? ''} onChange={(e) => setForm({ ...form, segment: e.target.value })} />
                    <datalist id="rd-segs">{[...new Set(rd.items.map((i) => i.segment).filter(Boolean))].map((s) => <option key={s} value={s} />)}</datalist></div>
                </div>
                <div className="field"><label htmlFor="it-setup">Setup</label><select id="it-setup" className="inp" value={form.setupId ?? ''} onChange={(e) => setForm({ ...form, setupId: e.target.value })}>
                  <option value="">Choose…</option>{setups.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.templateName}</option>)}</select></div>
                {operatorFields.length > 0 && <>
                  <div className="sec-label">Content</div>
                  {operatorFields.map((f) => {
                    const b = formSetup?.fields[f.id]
                    const fromElsewhere = b && (b.source === 'feed' || b.source === 'guide' || b.source === 'image')
                    return <div className="field" key={f.id}><label htmlFor={`v-${f.id}`}>{f.label}{fromElsewhere ? <span className="gfx-meta"> · from the {b!.source === 'feed' ? 'data feed' : b!.source === 'guide' ? 'guide' : 'setup'}</span> : null}</label>
                      {fromElsewhere ? <div className="inp ro">{String(b!.source === 'image' ? 'Setup image' : 'Filled live')}</div>
                        : <FieldInput id={`v-${f.id}`} f={f} value={(form.values ?? {})[f.id] ?? ''} onChange={(v) => setForm({ ...form, values: { ...(form.values ?? {}), [f.id]: v } })} />}</div>
                  })}
                </>}
                <div className="sec-label">Cue</div>
                <CueEditor cue={form.cue ?? { kind: 'manual' }} setCue={(c) => setForm({ ...form, cue: c })} sources={sources} />
                <div className="field"><label htmlFor="it-stays">Stays on</label>
                  <select id="it-stays" className="inp" value={form.staysSec ?? ''} onChange={(e) => setForm({ ...form, staysSec: e.target.value === '' ? null : Number(e.target.value) })}>
                    <option value="">Until taken off</option>{[5, 8, 10, 12, 15, 20, 30, 60, 120].map((s) => <option key={s} value={s}>{fmtSec(s)}</option>)}</select></div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn ghost" onClick={() => { setForm(null); setSel(null) }}>Cancel</button>
                  <button className="btn primary" disabled={busy} onClick={saveForm}>{form.isNew ? 'Add' : 'Save'}</button>
                </div>
              </div>
            ) : preview ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 14px', fontSize: 'var(--fs-sm)', marginTop: 14 }}>
                <span className="gfx-meta">Setup</span><span>{preview.setupName ?? pSetup?.name}</span>
                <span className="gfx-meta">Cue</span><span>{cueText(preview.cue ?? { kind: 'manual' }, sources)}</span>
                <span className="gfx-meta">Stays</span><span>{fmtSec(preview.staysSec ?? null)}</span>
              </div>
            ) : <div className="gfx-meta" style={{ marginTop: 10 }}>Click a row to see and edit it.</div>}
          </div>
          <div className="card card-b gfx-meta" style={{ lineHeight: 1.55 }}>
            <b style={{ color: 'var(--text)' }}>Cues</b><br />
            Manual items go to air in order with Take next. Clock times, offsets from the start, feed events and repeats fire on their own while the event is live, and show here as Armed so you can skip them.
          </div>
        </div>
      </div>

      {copy && (
        <div className="drawer-scrim" onClick={() => setCopy(false)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Copy a rundown">
            <div className="drawer-h"><div className="t">Copy a rundown</div><button className="xbtn" aria-label="Close" onClick={() => setCopy(false)}>✕</button></div>
            <div className="drawer-b">
              <p className="gfx-meta">Items are added after the ones already here. Clock-time cues become manual so you can set this event's times.</p>
              {events.map((e) => <button key={e.id} className="gfx-opt" style={{ width: '100%', marginBottom: 8 }} onClick={() => { setCopy(false); act(async () => { const r = await gfx.copyFrom(eventId, e.id); notify({ kind: 'ok', message: `${r.copied} copied. ${r.note}` }); return r }) }}>
                <span><b>{e.name}</b></span></button>)}
            </div>
          </div>
        </div>
      )}
      {confirm && <ConfirmDialog danger title={`Remove ${confirm.title}?`} body="It leaves this rundown. The setup stays in the library." confirmLabel="Remove"
        onCancel={() => setConfirm(null)} onConfirm={() => { const i = confirm; setConfirm(null); if (sel === i.id) { setSel(null); setForm(null) } act(() => gfx.deleteItem(eventId, i.id)) }} />}
    </>
  )
}
