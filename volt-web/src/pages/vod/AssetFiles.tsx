// Companion files of an asset (docs/COMPANION_FILES.md): caption files that
// become subtitle tracks for viewers, metadata sidecars a person reviews and
// applies to the asset's fields, and other files kept with it.
// Every change here saves at once; a text box that has not been saved yet is
// marked and says how to save it.
import { useEffect, useRef, useState } from 'react'
import { apiRequest, getToken } from '../../api'
import './assetFiles.css'

interface Issue { level: 'error' | 'warning'; code: string; message: string }
interface CFile {
  id: string; kind: 'captions' | 'metadata' | 'other'; format: string; name: string; bytes: number; encoding: string | null
  language: string | null; label: string | null; isDefault: boolean; forced: boolean; sdh: boolean; enabled: boolean; offsetMs: number
  report: null | { ok: boolean; cues?: number; firstMs?: number | null; lastMs?: number | null; issues?: Issue[]; values?: number }
  applied: null | { fields: string[]; by: string; at: string }
  uploadedBy: string | null; createdAt: string; download: string; webvtt?: string; duplicate?: boolean
}
interface Proposal { field: string; label: string; value: any; from: string; current: any; changes: boolean; byPerson: boolean }

const J = (b: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)
const clock = (ms: number | null | undefined) => {
  if (ms == null) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  return `${s >= 3600 ? `${Math.floor(s / 3600)}:` : ''}${String(Math.floor(s / 60) % 60).padStart(s >= 3600 ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`
}
const show = (v: any) => (v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : String(v))

async function download(path: string, name: string) {
  const r = await fetch(path, { headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {} })
  if (!r.ok) throw new Error(`Download failed (${r.status})`)
  const url = URL.createObjectURL(await r.blob())
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function AssetFiles({ id, onMetadataApplied }: { id: string; onMetadataApplied?: () => void }) {
  const [files, setFiles] = useState<CFile[] | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [err, setErr] = useState('')
  const [uploads, setUploads] = useState<{ name: string; state: 'sending' | 'done' | 'failed'; note?: string }[]>([])
  const [over, setOver] = useState(false)
  const [review, setReview] = useState<CFile | null>(null)
  const [preview, setPreview] = useState<{ id: string; text: string } | null>(null)
  const input = useRef<HTMLInputElement | null>(null)

  const load = () => apiRequest(`/vod/${id}/files`).then((r: any) => { setFiles(r.files); setDuration(r.durationMs) }, (e: any) => setErr(e.message))
  useEffect(() => { setFiles(null); load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (list: FileList | File[]) => {
    setErr('')
    for (const f of Array.from(list)) {
      setUploads((u) => [...u.filter((x) => x.name !== f.name), { name: f.name, state: 'sending' }])
      try {
        const r: CFile = await apiRequest(`/vod/${id}/files?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f, headers: { 'content-type': 'application/octet-stream' } })
        const note = r.duplicate ? 'already attached' : r.kind === 'captions' ? (r.report?.ok ? `${r.report.cues} cues, ${r.label}` : 'could not be used') : r.kind === 'metadata' ? `${r.report?.values ?? 0} values read` : 'kept'
        setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, state: 'done', note } : x)))
      } catch (e: any) {
        setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, state: 'failed', note: e.message } : x)))
      }
    }
    load()
  }
  const patch = async (f: CFile, body: Partial<CFile>) => {
    setErr('')
    try { const nf: CFile = await apiRequest(`/vod/${id}/files/${f.id}`, J(body)); setFiles((fs) => fs?.map((x) => (x.id === f.id ? nf : body.isDefault ? { ...x, isDefault: false } : x)) ?? null) }
    catch (e: any) { setErr(e.message); throw e }
  }
  const remove = async (f: CFile) => {
    if (!window.confirm(`Remove "${f.name}" from this asset?${f.kind === 'captions' && f.enabled ? ' Viewers will no longer be offered this subtitle track.' : ''}`)) return
    try { await apiRequest(`/vod/${id}/files/${f.id}`, { method: 'DELETE' }); load() } catch (e: any) { setErr(e.message) }
  }
  const showCues = async (f: CFile) => {
    if (preview?.id === f.id) return setPreview(null)
    try {
      const r = await fetch(`/api/vod/${id}/files/${f.id}/content?as=vtt&inline=1`, { headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {} })
      setPreview({ id: f.id, text: (await r.text()).split('\n').slice(0, 60).join('\n') })
    } catch (e: any) { setErr(e.message) }
  }

  const caps = (files ?? []).filter((f) => f.kind === 'captions')
  const metas = (files ?? []).filter((f) => f.kind === 'metadata')
  const others = (files ?? []).filter((f) => f.kind === 'other')

  return (
    <div className="afiles">
      <div className={`afiles-drop${over ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) send(e.dataTransfer.files) }}>
        <div>
          <div className="afiles-drop-t">Drop companion files here</div>
          <div className="lib-faint">Captions: SRT, WebVTT, TTML/DFXP (language from the name, e.g. <span className="mono">episode.fr.srt</span>, <span className="mono">.sdh</span>, <span className="mono">.forced</span>). Metadata sidecars: JSON, XML/NFO, CSV. Up to 25 MB each.</div>
        </div>
        <button className="btn primary" onClick={() => input.current?.click()}>Add files</button>
        <input ref={input} type="file" multiple hidden accept=".srt,.vtt,.webvtt,.ttml,.dfxp,.xml,.nfo,.json,.csv,.tsv,.txt,*/*"
          onChange={(e) => { if (e.target.files?.length) send(e.target.files); e.target.value = '' }} />
      </div>
      {uploads.length > 0 && (
        <ul className="afiles-up">
          {uploads.map((u) => <li key={u.name} className={u.state}><span className="mono">{u.name}</span> <span>{u.state === 'sending' ? 'Uploading…' : u.state === 'done' ? `Added: ${u.note}` : `Not added: ${u.note}`}</span></li>)}
          {uploads.every((u) => u.state !== 'sending') && <li><button className="linklike" onClick={() => setUploads([])}>Clear</button></li>}
        </ul>
      )}
      {err && <div className="asset-img-err">{err}</div>}
      {!files && !err && <div className="lib-faint">Loading…</div>}

      {files && (
        <>
          <div className="afiles-sec">
            <div className="sec-label">Captions and subtitles</div>
            <div className="lib-faint afiles-note">Tracks that are offered appear in the player's subtitle menu for HLS and DASH as soon as they are saved. One track can be the default.</div>
            {!caps.length ? <div className="lib-faint">No caption files yet.</div> : (
              <table className="afiles-t">
                <thead><tr><th>File</th><th>Language</th><th>Track name</th><th title="Shown by default">Default</th><th>Forced</th><th title="Subtitles for the deaf and hard of hearing">SDH</th><th>Offered</th><th title="Added to every cue, in seconds">Offset (s)</th><th>Check</th><th /></tr></thead>
                <tbody>
                  {caps.map((f) => {
                    const issues = f.report?.issues ?? []
                    const errs = issues.filter((i) => i.level === 'error'), warns = issues.filter((i) => i.level === 'warning')
                    return (
                      <tr key={f.id} className={f.enabled ? '' : 'off'}>
                        <td><div className="mono afiles-name" title={f.name}>{f.name}</div><div className="lib-faint">{f.format.toUpperCase()} · {size(f.bytes)}{f.encoding === 'windows-1252' ? ' · read as Windows-1252' : ''}</div></td>
                        <td><SaveOnBlur value={f.language ?? ''} width={70} placeholder="en" onSave={(v) => patch(f, { language: v || null } as any)} /></td>
                        <td><SaveOnBlur value={f.label ?? ''} width={150} onSave={(v) => patch(f, { label: v })} /></td>
                        <td><input type="radio" name={`def-${id}`} checked={f.isDefault} disabled={!f.report?.ok} onChange={() => patch(f, { isDefault: true })} /></td>
                        <td><input type="checkbox" checked={f.forced} onChange={(e) => patch(f, { forced: e.target.checked })} /></td>
                        <td><input type="checkbox" checked={f.sdh} onChange={(e) => patch(f, { sdh: e.target.checked })} /></td>
                        <td><input type="checkbox" checked={f.enabled} disabled={!f.report?.ok} onChange={(e) => patch(f, { enabled: e.target.checked })} /></td>
                        <td><SaveOnBlur value={String((f.offsetMs ?? 0) / 1000)} width={70} onSave={(v) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error('Offset is a number of seconds, for example -36000'); return patch(f, { offsetMs: Math.round(n * 1000) }) }} /></td>
                        <td className="afiles-check">
                          {f.report?.ok ? <span className="ok">{f.report.cues} cues, {clock(f.report.firstMs)}–{clock(f.report.lastMs)}{duration ? ` of ${clock(duration)}` : ''}</span> : <span className="bad">Not usable</span>}
                          {[...errs, ...warns].map((i) => <div key={i.code} className={i.level}>{i.message}</div>)}
                        </td>
                        <td className="afiles-acts">
                          {f.webvtt && <button className="btn ghost sm" onClick={() => showCues(f)}>{preview?.id === f.id ? 'Hide' : 'Cues'}</button>}
                          <button className="btn ghost sm" onClick={() => download(f.download, f.name).catch((e) => setErr(e.message))}>Download</button>
                          <button className="btn ghost sm" onClick={() => remove(f)}>Remove</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {preview && <pre className="afiles-pre">{preview.text}</pre>}
          </div>

          <div className="afiles-sec">
            <div className="sec-label">Metadata sidecars</div>
            <div className="lib-faint afiles-note">Values in the file are matched to this asset's fields. Nothing changes until you review and apply them.</div>
            {!metas.length ? <div className="lib-faint">No metadata sidecars yet.</div> : metas.map((f) => (
              <div key={f.id} className="afiles-row">
                <span className="mono afiles-name" title={f.name}>{f.name}</span>
                <span className="lib-faint">{f.format.toUpperCase()} · {f.report?.ok ? `${f.report.values} values` : 'could not be read'}{f.applied ? ` · applied ${f.applied.fields.length} field${f.applied.fields.length === 1 ? '' : 's'} by ${f.applied.by}, ${new Date(f.applied.at).toLocaleString()}` : ' · not applied'}</span>
                <div style={{ flex: 1 }} />
                {f.report?.ok && <button className="btn sm primary" onClick={() => setReview(f)}>Review and apply…</button>}
                <button className="btn ghost sm" onClick={() => download(f.download, f.name).catch((e) => setErr(e.message))}>Download</button>
                <button className="btn ghost sm" onClick={() => remove(f)}>Remove</button>
              </div>
            ))}
          </div>

          {others.length > 0 && (
            <div className="afiles-sec">
              <div className="sec-label">Other files</div>
              {others.map((f) => (
                <div key={f.id} className="afiles-row">
                  <span className="mono afiles-name" title={f.name}>{f.name}</span><span className="lib-faint">{size(f.bytes)}</span><div style={{ flex: 1 }} />
                  <button className="btn ghost sm" onClick={() => download(f.download, f.name).catch((e) => setErr(e.message))}>Download</button>
                  <button className="btn ghost sm" onClick={() => remove(f)}>Remove</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {review && <SidecarReview assetId={id} file={review} onClose={() => setReview(null)} onApplied={() => { setReview(null); load(); onMetadataApplied?.() }} />}
    </div>
  )
}

/** A text box that saves when you leave it or press Enter, and shows that it has not been saved until then. */
function SaveOnBlur({ value, onSave, width, placeholder }: { value: string; onSave: (v: string) => Promise<unknown> | unknown; width?: number; placeholder?: string }) {
  const [v, setV] = useState(value)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  useEffect(() => { setV(value) }, [value])
  const dirty = v.trim() !== value
  const save = async () => {
    if (!dirty) return
    setState('saving')
    try { await onSave(v.trim()); setState('saved'); setTimeout(() => setState('idle'), 1500) } catch { setState('error') }
  }
  return (
    <span className="afiles-sob">
      <input className={`inp${dirty ? ' unsaved' : ''}`} style={{ width }} value={v} placeholder={placeholder} title={dirty ? 'Not saved yet: press Enter or click away to save' : undefined}
        onChange={(e) => { setV(e.target.value); setState('idle') }} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setV(value) }} />
      <span className={`afiles-sob-s ${state}`}>{dirty && state !== 'saving' ? 'unsaved' : state === 'saving' ? 'saving…' : state === 'saved' ? 'saved' : state === 'error' ? 'not saved' : ''}</span>
    </span>
  )
}

function SidecarReview({ assetId, file, onClose, onApplied }: { assetId: string; file: CFile; onClose: () => void; onApplied: () => void }) {
  const [plan, setPlan] = useState<{ hasType: boolean; proposals: Proposal[]; unmatched: { path: string; value: any }[] } | null>(null)
  const [tick, setTick] = useState<Set<string>>(new Set())
  const [vals, setVals] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    apiRequest(`/vod/${assetId}/files/${file.id}/proposal`).then((p: any) => {
      setPlan(p)
      // Empty fields are ticked; a value already there changes only if ticked.
      setTick(new Set(p.proposals.filter((x: Proposal) => x.changes && (x.current == null || x.current === '')).map((x: Proposal) => x.field)))
    }, (e: any) => setErr(e.message))
  }, [assetId, file.id])
  const apply = async () => {
    setBusy(true); setErr('')
    try {
      const values: Record<string, any> = {}
      for (const [k, v] of Object.entries(vals)) if (tick.has(k)) { const p = plan!.proposals.find((x) => x.field === k)!; values[k] = Array.isArray(p.value) ? v.split(/\s*,\s*/).filter(Boolean) : typeof p.value === 'number' ? Number(v) : v }
      await apiRequest(`/vod/${assetId}/files/${file.id}/apply`, { method: 'POST', body: JSON.stringify({ fields: [...tick], values }), headers: { 'content-type': 'application/json' } })
      onApplied()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" role="dialog" aria-modal="true" aria-label="Apply metadata sidecar" style={{ width: 860, maxWidth: '96vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column' }}>
        <div className="card-h"><h3>Apply <span className="mono">{file.name}</span></h3><div style={{ flex: 1 }} /><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="card-b" style={{ overflow: 'auto' }}>
          {err && <div className="asset-img-err">{err}</div>}
          {!plan ? <div className="loading">Reading the file…</div> : !plan.hasType ? <div className="lib-faint">This asset has no content type, so it has no fields to fill. Choose a type in Metadata first.</div> : (
            <>
              {!plan.proposals.length ? <div className="lib-faint">Nothing in this file matches the asset's fields.</div> : (
                <table className="afiles-t">
                  <thead><tr><th /><th>Field</th><th>Now</th><th>From the file</th><th>Found as</th></tr></thead>
                  <tbody>
                    {plan.proposals.map((p) => (
                      <tr key={p.field} className={p.changes ? '' : 'off'}>
                        <td><input type="checkbox" checked={tick.has(p.field)} disabled={!p.changes} onChange={(e) => { const n = new Set(tick); e.target.checked ? n.add(p.field) : n.delete(p.field); setTick(n) }} /></td>
                        <td>{p.label}{p.byPerson && p.changes && <div className="afiles-warn-s">a person entered the current value</div>}</td>
                        <td className="lib-faint">{show(p.current)}</td>
                        <td>{p.changes ? <input className="inp" value={vals[p.field] ?? show(p.value)} onChange={(e) => { setVals({ ...vals, [p.field]: e.target.value }); setTick(new Set(tick).add(p.field)) }} /> : <span className="lib-faint">same</span>}</td>
                        <td className="mono lib-faint">{p.from}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {plan.unmatched.length > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary className="lib-faint">{plan.unmatched.length} value{plan.unmatched.length === 1 ? '' : 's'} with no matching field</summary>
                  <table className="afiles-t"><tbody>{plan.unmatched.map((u) => <tr key={u.path}><td className="mono">{u.path}</td><td>{show(u.value)}</td></tr>)}</tbody></table>
                </details>
              )}
            </>
          )}
        </div>
        <div className="modal-f">
          <span className="lib-faint">{tick.size} field{tick.size === 1 ? '' : 's'} will change</span>
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !tick.size} onClick={apply}>{busy ? 'Applying…' : 'Apply to the asset'}</button>
        </div>
      </div>
    </div>
  )
}
