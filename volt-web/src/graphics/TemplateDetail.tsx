// One template: preview it against sample data, read its checks, edit or
// re-upload the draft, publish it, see its versions and what uses it.
import { useEffect, useMemo, useRef, useState } from 'react'
import { navigate } from '../router'
import { useAccess } from '../access'
import { Notice, useNotify } from '../notices'
import { ConfirmDialog } from '../listActions'
import { gfx, previewValues, KIND_LABEL, type Check, type Kind, type TField, type TemplateDetail, type Version } from './gfxApi'
import { GraphicStage, type StageBackground, type StageHandle } from './GraphicStage'
import { sourceTag, StatusPill } from './Graphics'
import { StyleEditor } from './StyleEditor'

export function ChecksList({ checks }: { checks: Check[] }) {
  const order = { error: 0, warn: 1, ok: 2 }
  return <>{[...checks].sort((a, b) => order[a.level] - order[b.level]).map((c) => (
    <div className="gfx-check" key={c.id}>
      <span className={`dot ${c.level}`} aria-label={c.level}>{c.level === 'ok' ? '✓' : '!'}</span>
      <div><div style={{ fontWeight: 600 }}>{c.title}</div><div className="d">{c.detail}</div></div>
    </div>))}</>
}

/** An input for each declared field: what a sample-data form and live control both use. */
export function FieldInput({ f, value, onChange, id }: { f: TField; value: any; onChange: (v: any) => void; id: string }) {
  if (f.options?.length) return (
    <select id={id} className="inp" value={value ?? ''} onChange={(e) => {
      const o = f.options!.find((x) => String(x.value) === e.target.value)
      onChange(o ? o.value : e.target.value)
    }}>
      {!f.options.some((o) => String(o.value) === String(value ?? '')) && <option value={value ?? ''}>{value === '' || value == null ? 'Choose…' : String(value)}</option>}
      {f.options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>)
  if (f.type === 'number') return (
    <div className="gfx-step">
      <button type="button" className="btn ghost" aria-label={`${f.label} down`} onClick={() => onChange(Number(value || 0) - 1)}>−</button>
      <input id={id} className="inp" style={{ textAlign: 'center', fontWeight: 700 }} inputMode="numeric" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
      <button type="button" className="btn ghost" aria-label={`${f.label} up`} onClick={() => onChange(Number(value || 0) + 1)}>+</button>
    </div>)
  if (f.type === 'boolean') return <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} style={{ width: 20, height: 20 }} />
  if (f.type === 'color') return (
    <div style={{ display: 'flex', gap: 6 }}>
      <input type="color" aria-label={`${f.label} picker`} value={/^#[0-9a-f]{6}$/i.test(value ?? '') ? value : '#000000'} onChange={(e) => onChange(e.target.value)} style={{ width: 44, height: 38, border: 0, background: 'none' }} />
      <input id={id} className="inp" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </div>)
  if (f.type === 'list') return (
    <textarea id={id} className="inp" rows={3} style={{ padding: 10 }} value={Array.isArray(value) ? value.map((v) => typeof v === 'string' ? v : v?.title ?? '').join('\n') : ''}
      onChange={(e) => onChange(e.target.value.split('\n').filter((x) => x.trim()))} placeholder="One item per line" />)
  return <input id={id} className="inp" value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={f.type === 'image' ? 'Image URL' : ''} />
}

export function TemplateDetailPage({ id }: { id: string }) {
  const { can } = useAccess()
  const notify = useNotify()
  const [t, setT] = useState<TemplateDetail | null>(null)
  const [err, setErr] = useState('')
  const [vid, setVid] = useState<string | null>(null)
  const [bg, setBg] = useState<StageBackground>('picture')
  const [safe, setSafe] = useState(true)
  const [onAir, setOnAir] = useState(true)
  const [sample, setSample] = useState<Record<string, any>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [editPath, setEditPath] = useState('index.html')
  const [styling, setStyling] = useState(() => new URLSearchParams(window.location.search).has('customise'))
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'archive' | 'discard' | null>(null)
  const [nameEdit, setNameEdit] = useState<string | null>(null)
  const stage = useRef<StageHandle>(null)
  const upload = useRef<HTMLInputElement>(null)
  const own = t?.owner === 'account'
  const canManage = can('graphics', 'manage') && own

  const load = (keepVid = false) => gfx.template(id).then((r) => {
    setT(r)
    if (!keepVid || !r.versions.some((v) => v.id === vid)) {
      const pick = r.versions.find((v) => v.status === 'draft') ?? r.versions[0] ?? null
      setVid(pick?.id ?? null); setSample(previewValues(pick?.manifest))
    }
  }).catch((e) => setErr(e.message))
  useEffect(() => { load(); setStyling(new URLSearchParams(window.location.search).has('customise')) }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const v: Version | null = useMemo(() => t?.versions.find((x) => x.id === vid) ?? null, [t, vid])
  const draft = t?.versions.find((x) => x.status === 'draft') ?? null
  const latest = t?.versions.find((x) => x.status === 'published') ?? null
  if (err && !t) return <Notice kind="error" message={err} />
  if (!t) return <div className="loading">Loading template…</div>

  const act = async (fn: () => Promise<any>, ok?: string) => {
    setBusy(true); setErr('')
    try { await fn(); if (ok) notify({ kind: 'ok', message: ok }); await load(true) } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const openEditor = async () => {
    const from = draft ?? latest
    if (!from) return
    try { const s = await gfx.source(t.id, from.id); setEditPath(s.path ?? 'index.html'); setEditing(s.html) } catch (e: any) { setErr(e.message) }
  }
  const saveEditor = () => act(async () => {
    const nv = await gfx.putDraftPaste(t.id, { html: editing!, path: editPath, keep: true })
    setEditing(null); setVid(nv.id); setSample(previewValues(nv.manifest))
  }, 'Draft saved and checked.')
  const uploadVersion = (f: File | undefined) => f && act(async () => {
    const nv = await gfx.putDraftUpload(t.id, f, f.name); setVid(nv.id); setSample(previewValues(nv.manifest))
  }, 'New draft uploaded and checked.')

  const fields = (v?.manifest.fields ?? []).filter((f) => !f.hidden)
  return (
    <>
      <div className="gfx-meta" style={{ marginBottom: 6 }}><a href="/graphics" onClick={(e) => { e.preventDefault(); navigate('/graphics') }}>Graphics</a> / Templates / {t.name}</div>
      <div className="page-head" style={{ alignItems: 'center' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          {nameEdit != null ? (
            <form onSubmit={(e) => { e.preventDefault(); act(() => gfx.patchTemplate(t.id, { name: nameEdit }), 'Renamed.').then(() => setNameEdit(null)) }} style={{ display: 'flex', gap: 8 }}>
              <input className="inp" aria-label="Template name" autoFocus value={nameEdit} onChange={(e) => setNameEdit(e.target.value)} style={{ maxWidth: 420 }} />
              <button className="btn primary sm">Save</button><button type="button" className="btn ghost sm" onClick={() => setNameEdit(null)}>Cancel</button>
            </form>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h1>{t.name}</h1>{sourceTag(t)}<span className="tag type">{KIND_LABEL[t.kind]}</span>
              {v?.manifest.ograf && <span className="tag type" title={`EBU OGraf graphic ${v.manifest.ograf.id}${v.manifest.ograf.version ? ' v' + v.manifest.ograf.version : ''}${v.manifest.ograf.author ? ', by ' + v.manifest.ograf.author : ''}`}>OGraf</span>}
              {canManage && <button className="btn ghost sm" onClick={() => setNameEdit(t.name)}>Rename</button>}
            </div>
          )}
          <div style={{ margin: '4px 0 2px' }}><StatusPill t={t} full /></div>
          <p>{v ? `${v.manifest.canvas[0]}×${v.manifest.canvas[1]}${v.manifest.fps ? ` at ${v.manifest.fps} fps` : ''} · ${fields.length} field${fields.length === 1 ? '' : 's'} · ${v.fileCount} file${v.fileCount === 1 ? '' : 's'}` : 'No files yet'}
            {t.owner === 'volt' && ' · shipped with Volt, read-only'}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {v && <a className="btn ghost" href={gfx.downloadUrl(t.id, v.id)} onClick={async (e) => {
            e.preventDefault()
            const r = await fetch(gfx.downloadUrl(t.id, v.id), { headers: { authorization: `Bearer ${(await import('../api')).getToken()}` } })
            const b = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${t.name}-${v.version ? 'v' + v.version : 'draft'}.zip`; a.click()
          }}>Download</a>}
          {can('graphics', 'manage') && <button className="btn ghost" disabled={busy} onClick={() => act(async () => { const c = await gfx.duplicate(t.id); navigate(`/graphics/templates/${c.id}`) })}>Duplicate</button>}
          {canManage && <><input ref={upload} type="file" hidden accept=".zip,.html,.htm" onChange={(e) => uploadVersion(e.target.files?.[0])} />
            <button className="btn ghost" disabled={busy} onClick={() => upload.current?.click()}>Upload new version</button>
            <button className="btn ghost" disabled={busy} onClick={openEditor}>Edit code</button></>}
          {canManage && v && <button className="btn ghost" disabled={busy} aria-pressed={styling} onClick={() => setStyling(!styling)}>Customise look</button>}
          {!own && v && can('graphics', 'manage') && <button className="btn ghost" disabled={busy} title="Volt templates are read-only: this makes your own copy and opens it for changes"
            onClick={() => act(async () => { const c = await gfx.duplicate(t.id, `${t.name} (custom)`); navigate(`/graphics/templates/${c.id}?customise`) })}>Customise a copy</button>}
          {latest && can('graphics', 'manage') && <button className="btn primary" onClick={() => navigate(`/graphics/setups/new?version=${latest.id}`)}>New setup from this</button>}
        </div>
      </div>
      {err && <Notice kind="error" message={err} />}

      {styling && canManage && v && (
        <StyleEditor templateId={t.id} version={v} replacesDraft={!!draft && v.status !== 'draft'} onClose={() => setStyling(false)}
          onSaved={(nv) => { setVid(nv.id); setSample(previewValues(nv.manifest)); notify({ kind: 'ok', message: nv.publishable ? 'Saved to the draft. Preview it, then publish.' : 'Saved to the draft, but it has errors: see Checks.' }); load(true) }} />
      )}
      {editing != null && (
        <div className="card card-b" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <b>Edit {editPath}</b><span className="gfx-meta">Saving replaces the draft and runs the checks again. Other files in the package are kept.</span>
            <div style={{ flex: 1 }} />
            <button className="btn ghost sm" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary sm" disabled={busy} onClick={saveEditor}>{busy ? 'Saving…' : 'Save draft'}</button>
          </div>
          <textarea className="gfx-code" aria-label={editPath} spellCheck={false} value={editing} onChange={(e) => setEditing(e.target.value)} />
        </div>
      )}

      <div className="gfx-split">
        <div className="main">
          <div className="card card-b">
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontWeight: 650 }}>Previewing</span>
              <div className="seg-choice" role="group" aria-label="Version">
                {t.versions.slice(0, 4).map((x) => <button key={x.id} className={x.id === vid ? 'sel' : ''} onClick={() => { setVid(x.id); setSample(previewValues(x.manifest)) }}>
                  {x.status === 'draft' ? 'Draft' : `v${x.version}`}</button>)}
              </div>
              <div style={{ flex: 1 }} />
              <span className="gfx-meta">Behind it</span>
              <div className="seg-choice" role="group" aria-label="Background">
                {(['picture', 'checker', 'black'] as const).map((b) => <button key={b} className={bg === b ? 'sel' : ''} onClick={() => setBg(b)}>{b === 'picture' ? 'Picture' : b === 'checker' ? 'Transparent' : 'Black'}</button>)}
              </div>
              <button className={`btn sm ${safe ? 'primary' : 'ghost'}`} aria-pressed={safe} onClick={() => setSafe(!safe)}>Safe area</button>
            </div>
            <GraphicStage ref={stage} layers={v ? [{ key: v.id, url: v.url, values: sample, onAir, canvas: v.manifest.canvas }] : []} background={bg} safeArea={safe}
              empty="No files yet. Upload a package or paste HTML to see it here."
              badge={v?.status === 'draft' ? (v.publishable ? { text: latest ? 'Draft changes' : 'In development', tone: 'dev' } : { text: `Draft · ${v.checks.filter((c) => c.level === 'error').length} error${v.checks.filter((c) => c.level === 'error').length === 1 ? '' : 's'}`, tone: 'error' }) : undefined} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12, alignItems: 'center' }}>
              <button className="btn primary" onClick={() => { if (onAir) stage.current?.replay(); else setOnAir(true) }}>Play</button>
              <button className="btn ghost" onClick={() => stage.current?.next()}>Next</button>
              <button className="btn ghost" onClick={() => setOnAir(false)}>Stop</button>
              <div style={{ flex: 1 }} />
              <span className="gfx-meta">The same page the player and the burned output draw</span>
            </div>
          </div>
          {fields.length > 0 && (
            <div className="card card-b">
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
                <b>Sample data</b><span className="gfx-meta">Try values here. Nothing is saved.</span><div style={{ flex: 1 }} />
                <button className="btn ghost sm" onClick={() => setSample(previewValues(v?.manifest))}>Reset</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 12 }}>
                {fields.map((f) => <div className="field" key={f.id} style={{ margin: 0 }}>
                  <label htmlFor={`s-${f.id}`}>{f.label}</label>
                  <FieldInput id={`s-${f.id}`} f={f} value={sample[f.id]} onChange={(val) => setSample((s) => ({ ...s, [f.id]: val }))} />
                </div>)}
              </div>
            </div>
          )}
        </div>

        <div className="side">
          {v && <div className="card card-b">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <b>Checks</b><span className="gfx-meta">{v.status === 'draft' ? 'draft' : `v${v.version}`}</span><div style={{ flex: 1 }} />
              {v.publishable ? <span className="tag live">Ready</span> : <span className="tag down">Fix first</span>}
            </div>
            <ChecksList checks={v.checks} />
            <div style={{ marginTop: 10 }}>
              <div className="sec-label" style={{ marginTop: 8 }}>Fields found</div>
              {fields.length ? fields.map((f) => <span className="gfx-chip" key={f.id}>{f.label} <small>{f.type}</small></span>) : <span className="gfx-meta">None: a fixed graphic.</span>}
            </div>
          </div>}

          <div className="card card-b">
            <b>Versions</b>
            <div className="gfx-meta" style={{ marginBottom: 6 }}>A published version never changes. Setups stay on their version until you move them.</div>
            {t.versions.map((x) => {
              const users = t.usedBy.filter((u) => u.versionId === x.id)
              return (
                <div key={x.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                  <span className={`tag ${x.status === 'draft' ? 'gfx-draft' : 'type'}`} style={{ minWidth: 26, justifyContent: 'center' }}>{x.status === 'draft' ? 'Draft' : `v${x.version}`}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 'var(--fs-body)' }}>{x.status === 'draft' ? (x.publishable ? 'Ready to publish' : 'Has checks to fix') : `Published ${new Date(x.publishedAt!).toLocaleDateString()}`}</div>
                    <div className="gfx-meta">{x.note ? `${x.note} · ` : ''}{users.length ? `${users.length} setup${users.length === 1 ? '' : 's'}` : 'Not in use'}</div>
                  </div>
                  {x.status === 'draft' && canManage && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <button className="btn ghost sm" disabled={busy} onClick={() => setConfirm('discard')}>Discard</button>
                    <button className="btn primary sm" disabled={busy || !x.publishable} title={x.publishable ? '' : 'Fix the checks first'}
                      onClick={() => act(async () => { const p = await gfx.publish(t.id); setVid(p.id) }, 'Published. Nothing on air changes until a setup is moved to it.')}>Publish v{(latest?.version ?? 0) + 1}</button>
                  </div>}
                </div>
              )
            })}
            {!draft && canManage && <div className="gfx-meta" style={{ marginTop: 8 }}>To change it, use Edit code or Upload new version. That makes a draft; what is on air keeps its version.</div>}
          </div>

          <div className="card card-b">
            <b>Used by</b>
            {t.usedBy.length === 0 ? <div className="gfx-meta" style={{ marginTop: 6 }}>No setups yet.</div> : t.usedBy.map((u) => (
              <div key={u.setupId} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <a href={`/graphics/setups/${u.setupId}`} onClick={(e) => { e.preventDefault(); navigate(`/graphics/setups/${u.setupId}`) }} style={{ fontWeight: 600, color: 'var(--text)', textDecoration: 'none' }}>{u.setupName}</a>
                  <div className="gfx-meta">v{u.version ?? 'draft'} · {u.assignments.length ? u.assignments.map((a) => a.name).join(', ') : 'not assigned'}</div>
                </div>
                {u.assignments.some((a) => a.onAir) && <span className="tag live">On air</span>}
              </div>
            ))}
          </div>
          {canManage && <button className="btn ghost" style={{ alignSelf: 'flex-start', color: 'var(--down)' }} onClick={() => setConfirm('archive')}>Remove template</button>}
        </div>
      </div>
      {confirm && <ConfirmDialog danger title={confirm === 'archive' ? `Remove ${t.name}?` : 'Discard the draft?'}
        body={confirm === 'archive' ? 'It leaves the library. A template that setups still use cannot be removed.' : 'The published versions are not affected.'}
        confirmLabel={confirm === 'archive' ? 'Remove' : 'Discard'} onCancel={() => setConfirm(null)}
        onConfirm={() => { const c = confirm; setConfirm(null)
          if (c === 'archive') act(async () => { await gfx.archiveTemplate(t.id); navigate('/graphics') })
          else act(async () => { await gfx.discardDraft(t.id); setVid(null) }, 'Draft discarded.') }} />}
    </>
  )
}

export type { Kind }
