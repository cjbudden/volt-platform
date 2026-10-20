// Build or edit a SETUP: a pinned template version, where each field's
// content comes from, position, size and layer. Then assign it.
import { useEffect, useMemo, useState } from 'react'
import { navigate } from '../router'
import { useAccess } from '../access'
import { Notice, useNotify } from '../notices'
import { ConfirmDialog } from '../listActions'
import { ImagePicker } from '../ImagePicker'
import { gfx, SOURCE_LABEL, type Binding, type DataSource, type Placement, type Setup, type SourceKind, type TField, type Template } from './gfxApi'
import { GraphicStage } from './GraphicStage'
import { AssignDialog } from './AssignDialog'
import { FieldInput } from './TemplateDetail'
import { openLiveControl } from './Graphics'

const ANCHORS = ['top_left', 'top', 'top_right', 'left', 'center', 'right', 'bottom_left', 'bottom', 'bottom_right']
const ANCHOR_LABEL = ['Top left', 'Top centre', 'Top right', 'Middle left', 'Centre', 'Middle right', 'Bottom left', 'Bottom centre', 'Bottom right']
const pick = (o: any, p?: string) => !p ? o : p.split('.').filter(Boolean).reduce((a, k) => a == null ? a : Array.isArray(a) && /^\d+$/.test(k) ? a[+k] : a[k], o)

export function SetupEditor({ id, versionId }: { id?: string; versionId?: string | null }) {
  const { can } = useAccess()
  const canManage = can('graphics', 'manage')
  const notify = useNotify()
  const [setup, setSetup] = useState<Setup | null>(null)
  const [tpl, setTpl] = useState<{ templateId: string; templateName: string; versionId: string; version: number | null; latestVersionId: string | null; latestVersion: number | null; url: string; fields: TField[]; sample: Record<string, any>; canvas: [number, number] } | null>(null)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [fields, setFields] = useState<Record<string, Binding>>({})
  const [placement, setPlacement] = useState<Placement>({ anchor: 'top_left', x: 0, y: 0, scale: 1, layer: 2 })
  const [sources, setSources] = useState<DataSource[]>([])
  const [imgFor, setImgFor] = useState<string | null>(null)
  const [imgUrls, setImgUrls] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [assign, setAssign] = useState(false)
  const [confirm, setConfirm] = useState<'delete' | 'move' | null>(null)
  const [onAir, setOnAir] = useState(true)

  useEffect(() => { gfx.sources().then((r) => setSources(r.items)).catch(() => {}) }, [])
  const loadSetup = (sid: string) => gfx.setup(sid).then((s) => {
    setSetup(s); setName(s.name); setNote(s.note ?? ''); setFields(s.fields); setPlacement({ anchor: 'top_left', x: 0, y: 0, scale: 1, layer: 2, ...s.placement })
    setTpl({ templateId: s.templateId, templateName: s.templateName, versionId: s.versionId, version: s.version, latestVersionId: s.latestVersionId, latestVersion: s.latestVersion,
      url: s.templateUrl, fields: s.templateFields, sample: {}, canvas: s.canvas })
  }).catch((e) => setErr(e.message))
  useEffect(() => {
    if (id) { loadSetup(id); return }
    if (!versionId) { setErr('Choose a template first.'); return }
    gfx.templates().then((r) => {
      const t: Template | undefined = r.items.find((x) => x.latest?.id === versionId || x.draft?.id === versionId)
      const v = t && (t.latest?.id === versionId ? t.latest : t.draft)
      if (!t || !v) { setErr('That template version was not found.'); return }
      setTpl({ templateId: t.id, templateName: t.name, versionId: v.id, version: v.version, latestVersionId: t.latest?.id ?? null, latestVersion: t.latest?.version ?? null,
        url: v.url, fields: v.manifest.fields.filter((f) => !f.hidden), sample: v.manifest.sample ?? {}, canvas: v.manifest.canvas })
      setName(`${t.name} setup`)
      // Start every field as fixed text holding the sample, so the preview shows something real.
      setFields(Object.fromEntries(v.manifest.fields.filter((f) => !f.hidden).map((f) => [f.id, { source: (f.type === 'image' ? 'image' : 'text') as SourceKind, value: v.manifest.sample?.[f.id] ?? '' }])))
    }).catch((e) => setErr(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, versionId])

  const preview = useMemo(() => {
    const out: Record<string, any> = {}
    for (const f of tpl?.fields ?? []) {
      const b = fields[f.id]
      if (!b) { out[f.id] = tpl?.sample[f.id] ?? ''; continue }
      if (b.source === 'feed') { const s = sources.find((x) => x.id === b.sourceId); out[f.id] = pick(s?.payload, b.path) ?? b.value ?? '' }
      else if (b.source === 'image') out[f.id] = (b.imageId && imgUrls[b.imageId]) || b.value || ''
      else if (b.source === 'guide') out[f.id] = b.guide?.startsWith('next') ? '[Next programme]' : '[Current programme]'
      else out[f.id] = b.value ?? ''
    }
    return out
  }, [tpl, fields, sources, imgUrls])

  if (err && !tpl) return <Notice kind="error" message={err} />
  if (!tpl) return <div className="loading">Loading…</div>

  const setB = (fid: string, p: Partial<Binding>) => setFields((x) => ({ ...x, [fid]: { ...(x[fid] ?? { source: 'text' }), ...p } as Binding }))
  const save = async (thenAssign = false) => {
    setErr(''); setBusy(true)
    const clean = Object.fromEntries(Object.entries(fields).map(([k, b]) => {
      const o: any = { source: b.source }
      if (b.source === 'text' || b.source === 'operator' || b.source === 'api') o.value = b.value ?? ''
      if (b.source === 'image') o.imageId = b.imageId
      if (b.source === 'feed') { o.sourceId = b.sourceId; o.path = b.path ?? '' }
      if (b.source === 'guide') o.guide = b.guide ?? 'now_title'
      return [k, o]
    }))
    try {
      const s = setup ? await gfx.patchSetup(setup.id, { name, note: note || null, fields: clean, placement })
        : await gfx.createSetup({ name, note: note || null, versionId: tpl.versionId, fields: clean, placement })
      notify({ kind: 'ok', message: setup ? 'Setup saved.' : 'Setup created.' })
      if (!setup) navigate(`/graphics/setups/${s.id}`, { replace: true })
      else await loadSetup(s.id)
      if (thenAssign) setAssign(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const moveToLatest = async () => {
    if (!setup || !tpl.latestVersionId) return
    setBusy(true)
    try {
      const r = await gfx.patchSetup(setup.id, { versionId: tpl.latestVersionId })
      notify({ kind: 'ok', message: `Moved to v${r.version}.${r.droppedFields?.length ? ` Fields no longer in the template were dropped: ${r.droppedFields.join(', ')}.` : ''} Channels and events using it now draw the new version.` })
      await loadSetup(setup.id)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const upgrade = setup && tpl.latestVersion != null && (tpl.version == null || tpl.latestVersion > tpl.version)
  const ai = Math.max(0, ANCHORS.indexOf(placement.anchor ?? 'top_left'))

  return (
    <>
      <div className="gfx-meta" style={{ marginBottom: 6 }}><a href="/graphics?tab=setups" onClick={(e) => { e.preventDefault(); navigate('/graphics?tab=setups') }}>Graphics</a> / Setups / {setup?.name ?? 'New'}</div>
      <div className="page-head">
        <div style={{ flex: '1 1 360px', minWidth: 0 }}>
          <label className="sec-label" htmlFor="su-name" style={{ display: 'block', margin: 0 }}>Setup name</label>
          <input id="su-name" className="inp" value={name} disabled={!canManage} onChange={(e) => setName(e.target.value)} style={{ fontSize: 20, fontWeight: 700, maxWidth: 520, marginTop: 4 }} />
          <p style={{ marginTop: 8 }}>From <a href={`/graphics/templates/${tpl.templateId}`} onClick={(e) => { e.preventDefault(); navigate(`/graphics/templates/${tpl.templateId}`) }}>{tpl.templateName}</a>{' '}
            <span className="tag type">v{tpl.version ?? 'draft'}</span>
            {upgrade && <> <span style={{ color: 'var(--warn)' }}>· v{tpl.latestVersion} available</span> {canManage && <button className="btn ghost sm" disabled={busy} onClick={() => setConfirm('move')}>Move to v{tpl.latestVersion}</button>}</>}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn ghost" onClick={() => navigate('/graphics?tab=setups')}>{canManage ? 'Cancel' : 'Back'}</button>
          {canManage && <><button className="btn ghost" disabled={busy || !name.trim()} onClick={() => save(false)}>Save</button>
            <button className="btn primary" disabled={busy || !name.trim()} onClick={() => save(true)}>Save and assign</button></>}
        </div>
      </div>
      {err && <Notice kind="error" message={err} />}

      <div className="gfx-split">
        <div className="side" style={{ flex: '1 1 520px' }}>
          <div className="card card-b">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <b>Preview with this setup's content</b><div style={{ flex: 1 }} />
              <button className="btn ghost sm" onClick={() => setOnAir(!onAir)}>{onAir ? 'Stop' : 'Play'}</button>
            </div>
            <GraphicStage layers={[{ key: 'setup', url: tpl.url, values: preview, onAir, canvas: tpl.canvas, placement }]} safeArea />
            <div className="gfx-meta" style={{ marginTop: 8 }}>Feed values are the last ones fetched. Guide fields show a placeholder until it is on a channel.</div>
          </div>
          <div className="card card-b">
            <b>Position and size</b>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 22, alignItems: 'flex-start', marginTop: 12 }}>
              <div><div className="sec-label" style={{ marginTop: 0 }}>Anchor</div>
                <div className="gfx-anchor" role="group" aria-label="Anchor">
                  {ANCHORS.map((a, i) => <button key={a} type="button" className={i === ai ? 'on' : ''} aria-label={ANCHOR_LABEL[i]} aria-pressed={i === ai} disabled={!canManage}
                    onClick={() => setPlacement({ ...placement, anchor: a })} />)}
                </div></div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(90px, 130px))', gap: 10 }}>
                <div className="field" style={{ margin: 0 }}><label htmlFor="px">Move right (px)</label><input id="px" className="inp" type="number" value={placement.x ?? 0} disabled={!canManage} onChange={(e) => setPlacement({ ...placement, x: Number(e.target.value) })} /></div>
                <div className="field" style={{ margin: 0 }}><label htmlFor="py">Move down (px)</label><input id="py" className="inp" type="number" value={placement.y ?? 0} disabled={!canManage} onChange={(e) => setPlacement({ ...placement, y: Number(e.target.value) })} /></div>
                <div className="field" style={{ margin: 0 }}><label htmlFor="ps">Size</label>
                  <select id="ps" className="inp" value={placement.scale ?? 1} disabled={!canManage} onChange={(e) => setPlacement({ ...placement, scale: Number(e.target.value) })}>
                    {[0.75, 0.85, 1, 1.15, 1.25, 1.5].map((s) => <option key={s} value={s}>{Math.round(s * 100)}%</option>)}</select></div>
                <div className="field" style={{ margin: 0 }}><label htmlFor="pl">Layer</label>
                  <select id="pl" className="inp" value={placement.layer ?? 2} disabled={!canManage} onChange={(e) => setPlacement({ ...placement, layer: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 5].map((l) => <option key={l} value={l}>{l}{l === 1 ? ' · bottom' : l === 5 ? ' · top' : ''}</option>)}</select></div>
              </div>
            </div>
            <div className="field" style={{ marginTop: 14, marginBottom: 0 }}><label htmlFor="su-note">Note</label>
              <input id="su-note" className="inp" value={note} disabled={!canManage} placeholder="What this setup is for" onChange={(e) => setNote(e.target.value)} /></div>
          </div>
        </div>

        <div className="main" style={{ flex: '1.3 1 600px' }}>
          <div className="card" style={{ overflowX: 'auto' }}>
            <div className="card-h"><h3>Where each field gets its content</h3><div className="spacer" /><span className="sub">{tpl.fields.length} fields</span></div>
            <div style={{ minWidth: 640 }}>
              <div className="gfx-frow"><span className="sec-label" style={{ margin: 0 }}>Field</span><span className="sec-label" style={{ margin: 0 }}>Comes from</span><span className="sec-label" style={{ margin: 0 }}>Setting</span><span className="sec-label" style={{ margin: 0 }}>Now</span></div>
              {tpl.fields.map((f) => {
                const b: Binding = fields[f.id] ?? { source: 'text', value: '' }
                const src = sources.find((s) => s.id === b.sourceId)
                return (
                  <div className="gfx-frow" key={f.id}>
                    <div><div style={{ fontWeight: 600 }}>{f.label}</div><div className="gfx-meta">{f.type}</div></div>
                    <select className="inp" aria-label={`Source for ${f.label}`} value={b.source} disabled={!canManage} onChange={(e) => setB(f.id, { source: e.target.value as SourceKind })}>
                      {(Object.keys(SOURCE_LABEL) as SourceKind[]).filter((k) => k !== 'image' || f.type === 'image' || b.source === 'image').map((k) => <option key={k} value={k}>{SOURCE_LABEL[k]}</option>)}
                    </select>
                    <div style={{ minWidth: 0 }}>
                      {(b.source === 'text') && <FieldInput id={`b-${f.id}`} f={f} value={b.value} onChange={(v) => setB(f.id, { value: v })} />}
                      {(b.source === 'operator' || b.source === 'api') && <div>
                        <FieldInput id={`b-${f.id}`} f={f} value={b.value} onChange={(v) => setB(f.id, { value: v })} />
                        <div className="gfx-meta" style={{ marginTop: 4 }}>{b.source === 'api' ? 'Starting value; your system changes it with PATCH …/state.' : 'Starting value; changed live in live control.'}</div></div>}
                      {b.source === 'image' && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        {(b.imageId && imgUrls[b.imageId]) ? <img src={imgUrls[b.imageId]} alt="" style={{ width: 34, height: 34, objectFit: 'contain', background: '#fff', borderRadius: 6 }} /> : null}
                        <span className="gfx-meta" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.imageId ? 'Image chosen' : 'No image yet'}</span>
                        {canManage && <button type="button" className="btn ghost sm" onClick={() => setImgFor(f.id)}>Image Library</button>}</div>}
                      {b.source === 'feed' && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <select className="inp" aria-label="Data source" value={b.sourceId ?? ''} disabled={!canManage} onChange={(e) => setB(f.id, { sourceId: e.target.value })} >
                          <option value="">Choose a source…</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                        <input className="inp" aria-label="Path in the data" placeholder="score.home" value={b.path ?? ''} disabled={!canManage} onChange={(e) => setB(f.id, { path: e.target.value })} style={{ fontFamily: 'ui-monospace,Menlo,monospace' }} />
                      </div>}
                      {b.source === 'guide' && <select className="inp" aria-label="Guide value" value={b.guide ?? 'now_title'} disabled={!canManage} onChange={(e) => setB(f.id, { guide: e.target.value })}>
                        <option value="now_title">Current programme title</option><option value="now_subtitle">Current programme subtitle</option>
                        <option value="next_title">Next programme title</option><option value="next_subtitle">Next programme subtitle</option><option value="next_start">Next programme start time</option></select>}
                    </div>
                    <div className="now" title={String(preview[f.id] ?? '')}>{b.source === 'feed' && src && src.status !== 'ok' ? <span style={{ color: 'var(--warn)' }}>{src.status}</span> : Array.isArray(preview[f.id]) ? `${preview[f.id].length} items` : String(preview[f.id] ?? '')}</div>
                  </div>
                )
              })}
            </div>
          </div>
          {sources.length === 0 && Object.values(fields).some((b) => b.source === 'feed') && (
            <Notice kind="info" message="No data sources yet. Add one under Graphics, Data sources: a JSON or RSS URL, or a push source your system sends to." />
          )}
          {setup && (
            <div className="card card-b">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><b>Assigned to</b><div style={{ flex: 1 }} />
                {canManage && <button className="btn ghost sm" onClick={() => setAssign(true)}>Assign</button>}</div>
              {setup.assignments.length === 0 ? <div className="gfx-meta" style={{ marginTop: 6 }}>Not assigned yet.</div> : setup.assignments.map((a) => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                  <span className={`tag type ${a.eventId ? 'event' : 'chan'}`}>{a.eventId ? 'Event' : 'Channel'}</span>
                  <div style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>{a.name} <span className="gfx-meta" style={{ fontWeight: 400 }}>· <span className={`gfx-mode ${a.runMode}`}>{a.runMode}</span> · {a.targets === 'burn' ? 'burned' : a.targets === 'both' ? 'burned + player' : 'player'}</span></div>
                  {a.onAir && <span className="tag live">On air</span>}
                  <button className="btn ghost sm" onClick={() => openLiveControl({ channelId: a.channelId, eventId: a.eventId })}>Live control</button>
                </div>))}
            </div>
          )}
          {setup && canManage && <button className="btn ghost" style={{ alignSelf: 'flex-start', color: 'var(--down)' }} onClick={() => setConfirm('delete')}>Delete setup</button>}
        </div>
      </div>
      <ImagePicker open={!!imgFor} onClose={() => setImgFor(null)} title="Choose an image" uploadFolder="graphics"
        onPick={(url, file) => { if (imgFor) { setB(imgFor, { imageId: file.id }); setImgUrls((m) => ({ ...m, [file.id]: url })) } setImgFor(null) }} />
      {assign && setup && <AssignDialog setup={setup} onClose={() => setAssign(false)} onDone={() => { setAssign(false); notify({ kind: 'ok', message: 'Assigned.' }); loadSetup(setup.id) }} />}
      {confirm === 'delete' && setup && <ConfirmDialog danger title={`Delete ${setup.name}?`} body="Its assignments go with it. A setup on air or in a rundown cannot be deleted." confirmLabel="Delete"
        onCancel={() => setConfirm(null)} onConfirm={async () => { setConfirm(null); try { await gfx.deleteSetup(setup.id); navigate('/graphics?tab=setups') } catch (e: any) { setErr(e.message) } }} />}
      {confirm === 'move' && <ConfirmDialog title={`Move to v${tpl.latestVersion}?`} body="Every channel and event using this setup switches to the new version straight away, including any that are on air now. Preview the new version on the template page first." confirmLabel="Move"
        onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); moveToLatest() }} />}
    </>
  )
}
