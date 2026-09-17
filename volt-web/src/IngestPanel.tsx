// ============================================================================
//  INGEST PANEL: one action for the basic case, everything else within reach.
//
//  Drop files or a folder, choose from the picker, or on a phone open the
//  camera roll or record now. Before a byte moves the server previews what
//  the rules will do to each file (its new name, a duplicate it matches, a
//  reject), and the operator can pick a content type and fill metadata while
//  the bytes go. Held items (waiting for metadata, duplicates to decide) are
//  listed here too, because the place you dropped the file is the place you
//  look for what happened to it.
//
//  TRANSPORT. The chunk protocol (three chunks in flight, Background Fetch
//  on Chromium) is the default; on a phone browser the tus client is used
//  instead because sequential and resumable is what a suspended Safari tab
//  needs. Both land in the same rules.
// ============================================================================
import { useEffect, useRef, useState } from 'react'
import { api, getToken, type IngestPreviewRow, type IngestHeld } from './api'
import { startUpload, subscribe, type UploadItem } from './uploadManager'
import { tusUpload, isCellular } from './tusClient'
import { TypePicker, MetadataForm } from './ContentTypeFields'

const isPhone = () => /iPhone|iPad|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && window.innerWidth < 900)

function fmtBytes(n: number) { return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(0) + ' MB' : (n / 1e3).toFixed(0) + ' KB' }

/** Walk a dropped DataTransfer so a dropped FOLDER yields its files with paths. */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const items = [...(dt.items ?? [])]
  const entries = items.map(i => (i as any).webkitGetAsEntry?.()).filter(Boolean)
  if (!entries.length) return [...(dt.files ?? [])]
  const out: File[] = []
  const readDir = (dir: any): Promise<any[]> => new Promise(res => { const r = dir.createReader(); const all: any[] = []; const next = () => r.readEntries((es: any[]) => { if (!es.length) return res(all); all.push(...es); next() }, () => res(all)); next() })
  const visit = async (e: any, prefix: string) => {
    if (e.isFile) {
      const f: File = await new Promise(res => e.file(res))
      try { Object.defineProperty(f, 'webkitRelativePath', { value: prefix + f.name }) } catch { /* readonly in some browsers */ }
      out.push(f)
    } else if (e.isDirectory) {
      for (const c of await readDir(e)) await visit(c, prefix + e.name + '/')
    }
  }
  for (const e of entries) await visit(e, '')
  return out
}

interface Picked { file: File; preview?: IngestPreviewRow; skip?: boolean }

export function IngestPanel({ onDone, source = 'panel' }: { onDone: () => void; source?: string }) {
  const [picked, setPicked] = useState<Picked[]>([])
  const [typeId, setTypeId] = useState<string | null>(null)
  const [meta, setMeta] = useState<Record<string, any>>({})
  const [autoUpload, setAutoUpload] = useState(true)
  const [items, setItems] = useState<UploadItem[]>([])
  const [held, setHeld] = useState<IngestHeld[]>([])
  const [over, setOver] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [tusProgress, setTusProgress] = useState<Record<string, number>>({})
  const fileRef = useRef<HTMLInputElement | null>(null)
  const folderRef = useRef<HTMLInputElement | null>(null)
  const camRef = useRef<HTMLInputElement | null>(null)
  const depth = useRef(0)
  const phone = isPhone()

  const loadHeld = () => api.ingestHeld().then(setHeld).catch(() => {})
  useEffect(() => { loadHeld() }, [])
  useEffect(() => subscribe((all) => { setItems(all); if (all.some(i => i.status === 'done')) { onDone(); loadHeld() } }), [onDone])
  useEffect(() => { api.ingestBaseline().then(b => setAutoUpload(b.baseline.autoUpload)).catch(() => {}) }, [])

  /** Add files: preview them first so the operator sees renames, duplicates and rejects before starting. */
  async function add(files: File[]) {
    setErr('')
    if (!files.length) return
    const next: Picked[] = files.map(file => ({ file }))
    setPicked(p => [...p, ...next])
    try {
      const rows = await api.ingestPreview({
        files: files.map(f => ({ name: f.name, bytes: f.size, relativePath: (f as any).webkitRelativePath || null, mime: f.type || null })),
        source, contentTypeId: typeId,
      })
      const withPreview = files.map((f, i) => ({ file: f, preview: rows[i], skip: rows[i]?.reject != null || rows[i]?.duplicate === 'skip' }))
      setPicked(p => p.map(x => withPreview.find(w => w.file === x.file) ?? x))
      if (autoUpload) void start(withPreview)
    } catch (e: any) { setErr(String(e?.message ?? e)) }
  }

  async function start(list: Picked[]) {
    setBusy(true)
    for (const p of list) {
      if (p.skip || p.preview?.reject) continue
      try {
        if (phone) {
          const key = p.file.name + p.file.size
          await tusUpload(p.file, {
            endpoint: '/api/tus', token: getToken() ?? '',
            metadata: { source, ...(typeId ? { schemaId: typeId } : {}), ...(Object.keys(meta).length ? { metadata: JSON.stringify(meta) } : {}) },
            onProgress: (sent, total) => setTusProgress(t => ({ ...t, [key]: sent / total })),
          })
          setTusProgress(t => { const c = { ...t }; delete c[key]; return c })
          onDone(); loadHeld()
        } else {
          await startUpload(p.file, { kind: 'loop', purpose: 'vod', source, schemaId: typeId, metadata: Object.keys(meta).length ? meta : null })
        }
      } catch (e: any) { setErr(String(e?.message ?? e)) }
    }
    setPicked(cur => cur.filter(x => !list.some(l => l.file === x.file) || x.skip || x.preview?.reject))
    setBusy(false)
  }

  const pending = picked.filter(p => !p.skip && !p.preview?.reject)
  const active = items.filter(i => i.status !== 'done' || Date.now() - i.startedAt < 60_000)

  return (
    <div className="card" style={{ padding: 16, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--fs-body)' }}>Add to the library</strong>
        <button type="button" className="btn primary" onClick={() => fileRef.current?.click()}>Choose files</button>
        {!phone && <button type="button" className="btn" onClick={() => folderRef.current?.click()}>Choose folder</button>}
        {phone && <button type="button" className="btn" onClick={() => camRef.current?.click()}>Record now</button>}
        <label style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={autoUpload} onChange={e => setAutoUpload(e.target.checked)} /> Start as soon as added
        </label>
        <input ref={fileRef} type="file" accept="video/*,audio/*,image/*" multiple hidden onChange={e => { add([...(e.target.files ?? [])]); e.target.value = '' }} />
        <input ref={folderRef} type="file" multiple hidden {...({ webkitdirectory: '' } as any)} onChange={e => { add([...(e.target.files ?? [])]); e.target.value = '' }} />
        <input ref={camRef} type="file" accept="video/*" capture="environment" hidden onChange={e => { add([...(e.target.files ?? [])]); e.target.value = '' }} />
      </div>

      <div
        onDragEnter={e => { e.preventDefault(); depth.current++; setOver(true) }}
        onDragLeave={e => { e.preventDefault(); if (--depth.current <= 0) setOver(false) }}
        onDragOver={e => e.preventDefault()}
        onDrop={async e => { e.preventDefault(); depth.current = 0; setOver(false); add(await filesFromDrop(e.dataTransfer)) }}
        style={{ marginTop: 10, padding: '18px 14px', borderRadius: 10, textAlign: 'center',
                 border: `1px dashed ${over ? 'var(--brand,#3f7bff)' : 'var(--border,#242a36)'}`,
                 background: over ? 'rgba(63,123,255,.08)' : 'transparent', fontSize: 'var(--fs-sm)', color: 'var(--faint,#8b93a7)' }}>
        {phone ? 'Files from your camera roll or Files app' : 'Drop video, audio or image files, or a whole folder, here'}
        {phone && isCellular() && <div style={{ fontSize: 'var(--fs-xs)', marginTop: 4 }}>On cellular: smaller chunks, resumes if the connection drops.</div>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: phone ? '1fr' : '260px 1fr', gap: 12, marginTop: 12 }}>
        <div>
          <div className="sec-label">Content type</div>
          <TypePicker appliesTo="vod" value={typeId} onChange={id => { setTypeId(id); setMeta({}) }} hint="Applied to everything added from now. Leave it for the rules to decide." />
        </div>
        <div>
          <div className="sec-label">Metadata (fills in while the upload runs)</div>
          {typeId ? <MetadataForm typeId={typeId} value={meta} onChange={setMeta} compact /> : <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}>Pick a content type to enter metadata up front, or fill it in afterwards from the held list.</div>}
        </div>
      </div>

      {err && <p style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)' }}>{err}</p>}

      {picked.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="sec-label">Ready to go</div>
          {picked.map((p, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, fontSize: 'var(--fs-sm)', padding: '4px 0', borderBottom: '1px solid var(--border,#242a36)', alignItems: 'center', opacity: p.skip ? .6 : 1 }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={(p.file as any).webkitRelativePath || p.file.name}>{p.file.name}</span>
              <span style={{ color: 'var(--faint,#8b93a7)' }}>{fmtBytes(p.file.size)}</span>
              {p.preview ? (
                p.preview.reject ? <span style={{ color: 'var(--danger,#f87171)' }}>refused: {p.preview.reject}</span>
                : p.preview.duplicate !== 'proceed' ? <span style={{ color: 'var(--warn,#f5a524)' }}>looks like a duplicate ({p.preview.duplicateOf?.strength.replace('_', ' ')}), rule says {p.preview.duplicate}</span>
                : <span style={{ color: 'var(--faint,#8b93a7)' }} title={p.preview.matched.map(m => m.ruleName).join(' < ')}>{p.preview.settings.naming === 'honour' ? (p.preview.changed ? `renamed ${p.preview.sanitised}` : 'name kept') : `filed as ${p.preview.settings.naming.replace('_', ' ')}`}{p.preview.deferred ? ', checked again after upload' : ''}</span>
              ) : <span style={{ color: 'var(--faint,#8b93a7)' }}>checking rules</span>}
              {tusProgress[p.file.name + p.file.size] != null && <span>{Math.round(tusProgress[p.file.name + p.file.size] * 100)}%</span>}
              <button type="button" className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => setPicked(cur => cur.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          {!autoUpload && pending.length > 0 && (
            <button type="button" className="btn primary" style={{ marginTop: 8 }} disabled={busy} onClick={() => start(pending)}>
              Upload {pending.length} file{pending.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}

      {active.map(i => (
        <div key={i.id} style={{ marginTop: 8, fontSize: 'var(--fs-sm)' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</span>
            <span style={{ color: 'var(--faint,#8b93a7)' }}>
              {i.status === 'done' ? label(i.ingest) : i.status === 'error' ? (i.error ?? 'failed') : i.status === 'background' ? 'browser is carrying it' : `${Math.round((i.sentBytes / Math.max(1, i.totalBytes)) * 100)}%`}
            </span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'var(--panel-2,#151922)', marginTop: 4 }}>
            <div style={{ height: '100%', borderRadius: 2, width: `${Math.round((i.sentBytes / Math.max(1, i.totalBytes)) * 100)}%`, background: i.status === 'error' ? 'var(--danger,#f87171)' : 'var(--brand,#3f7bff)' }} />
          </div>
        </div>
      ))}

      {held.length > 0 && <HeldList held={held} onChange={() => { loadHeld(); onDone() }} />}
    </div>
  )
}

export function label(g: UploadItem['ingest']): string {
  if (!g) return 'uploaded, encoding next'
  switch (g.status) {
    case 'ingested': return g.naming?.renamed ? 'uploaded and filed, encoding next' : 'uploaded, encoding next'
    case 'awaiting_metadata': return `uploaded, waiting for ${(g.awaitingMetadata ?? []).join(', ') || 'metadata'}`
    case 'duplicate': return g.duplicate?.outcome === 'skip' ? 'skipped, already in the library' : 'already in the library, needs a decision below'
    case 'rejected': return 'refused by an ingest rule'
    default: return 'uploaded'
  }
}

/** Assets the rules are holding: fill the metadata, or decide a duplicate. */
function HeldList({ held, onChange }: { held: IngestHeld[]; onChange: () => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const [meta, setMeta] = useState<Record<string, any>>({})
  const [err, setErr] = useState('')
  const act = async (fn: () => Promise<any>) => { setErr(''); try { await fn(); setOpen(null); setMeta({}); onChange() } catch (e: any) { setErr(String(e?.message ?? e)) } }
  return (
    <div style={{ marginTop: 14 }}>
      <div className="sec-label">Waiting on you ({held.length})</div>
      {err && <p style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)' }}>{err}</p>}
      {held.map(h => (
        <div key={h.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border,#242a36)', fontSize: 'var(--fs-sm)' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.originalFilename ?? h.title}</span>
            <span style={{ color: 'var(--faint,#8b93a7)' }}>{h.bytes != null ? fmtBytes(h.bytes) : ''}</span>
            {h.status === 'awaiting_metadata' && <>
              <span style={{ color: 'var(--warn,#f5a524)' }}>needs {(h.awaitingMetadata ?? []).join(', ')}</span>
              <button type="button" className="btn" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => { setOpen(open === h.id ? null : h.id); setMeta({}) }}>{open === h.id ? 'Close' : 'Fill in'}</button>
            </>}
            {h.status === 'duplicate' && <>
              <span style={{ color: 'var(--warn,#f5a524)' }}>same {h.duplicate?.strength === 'content' ? 'content' : 'name and size'} as an asset already in the library</span>
              <button type="button" className="btn" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => act(() => api.ingestResolveDuplicate(h.id, 'skip'))}>Skip it</button>
              <button type="button" className="btn" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => act(() => api.ingestResolveDuplicate(h.id, 'version'))}>Keep both</button>
              <button type="button" className="btn" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => act(() => api.ingestResolveDuplicate(h.id, 'replace'))}>Replace the old one</button>
            </>}
            {h.status === 'rejected' && <span style={{ color: 'var(--danger,#f87171)' }}>refused by rule {h.rules.map(r => r.ruleName).join(', ')}</span>}
          </div>
          {open === h.id && h.status === 'awaiting_metadata' && (
            <div style={{ marginTop: 8 }}>
              <MetadataForm typeId={h.schemaId} value={meta} onChange={setMeta} compact />
              <button type="button" className="btn primary" style={{ marginTop: 6 }} onClick={() => act(() => api.ingestSetMetadata(h.id, meta))}>Save and ingest</button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
