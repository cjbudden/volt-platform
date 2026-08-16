import { useEffect, useRef, useState } from 'react'
import { api, thumbUrl, type MediaFile } from '../api'
import { enqueueUploads, useUploads } from '../uploads'

const KINDS = ['all', 'slate', 'watermark', 'poster', 'brand', 'other'] as const
const ASSIGNABLE = ['slate', 'watermark', 'poster', 'brand', 'other'] // user-assignable usage types
const STD_FOLDERS = ['slates', 'watermarks', 'brands', 'posters']

function inferKind(folder: string): string {
  const top = folder.split('/')[0]
  if (top === 'slates') return 'slate'
  if (top === 'watermarks') return 'watermark'
  if (top === 'brands') return 'brand'
  if (top === 'posters') return 'poster'
  return 'other'
}
function human(bytes: number | null) {
  if (!bytes) return '—'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

interface Staged { file: File; name: string; kind: string; preview: string }

export default function ImageLibrary() {
  const [folders, setFolders] = useState<{ path: string; name: string; count: number }[]>([])
  const [folder, setFolder] = useState<string>('')
  const [kind, setKind] = useState<string>('all')
  const [q, setQ] = useState('')
  const [files, setFiles] = useState<MediaFile[] | null>(null)
  const [err, setErr] = useState('')
  const [confirm, setConfirm] = useState<{ file: MediaFile; inUse?: any[] } | null>(null)
  const [folderModal, setFolderModal] = useState<null | string>(null)
  const [staged, setStaged] = useState<{ items: Staged[]; folder: string } | null>(null)
  const [preview, setPreview] = useState<MediaFile | null>(null)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState('')
  const fileInput = useRef<HTMLInputElement | null>(null)
  const uploads = useUploads()

  function flash(msg: string) { setToast(msg); window.setTimeout(() => setToast(t => (t === msg ? '' : t)), 3200) }

  // refresh the grid as background uploads complete (seq bumps per success)
  useEffect(() => { if (uploads.seq) { loadFolders(); load() } /* eslint-disable-next-line */ }, [uploads.seq])

  async function loadFolders() { try { setFolders((await api.fileFolders()).folders) } catch { /* */ } }
  async function load() {
    try { setErr(''); setFiles(await api.files({ folder: folder || '', recursive: true, kind: kind === 'all' ? undefined : kind, q: q.trim() || undefined })) }
    catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { loadFolders() }, [])
  // folder / kind change reloads immediately; the search term is debounced so typing
  // doesn't fire a request per keystroke (and doesn't flicker the grid to Loading).
  useEffect(() => { setFiles(null); load() /* eslint-disable-next-line */ }, [folder, kind])
  useEffect(() => {
    const t = setTimeout(() => { load() }, 200)
    return () => clearTimeout(t)
    // eslint-disable-next-line
  }, [q])

  // ---- staging: build a review list instead of uploading immediately ---------
  function stageFiles(list: FileList | File[]) {
    const arr = Array.from(list).filter(f => f.type.startsWith('image/'))
    if (!arr.length) { setErr('No image files in that selection'); return }
    const items: Staged[] = arr.map(file => ({ file, name: file.name, kind: inferKind(folder), preview: URL.createObjectURL(file) }))
    setStaged({ items, folder })
  }
  function updateStaged(i: number, patch: Partial<Staged>) {
    setStaged(s => s ? { ...s, items: s.items.map((it, j) => j === i ? { ...it, ...patch } : it) } : s)
  }
  // hand off to the background uploader and close the review panel; progress shows in
  // the topbar indicator and the grid refreshes as each item completes.
  function commitUpload() {
    if (!staged) return
    enqueueUploads(staged.items.map(it => ({ file: it.file, folder: staged.folder, name: it.name, kind: it.kind })))
    const n = staged.items.length
    staged.items.forEach(it => URL.revokeObjectURL(it.preview))
    setStaged(null)
    flash(`Uploading ${n} image${n > 1 ? 's' : ''} in the background…`)
  }

  async function createFolder(name: string) {
    const clean = name.trim().replace(/^\/|\/$/g, '')
    if (!clean) return
    try { await api.createFolder(clean); await loadFolders(); setFolder(clean); setFolderModal(null) }
    catch (e: any) { setErr(e.message) }
  }

  async function changeKind(f: MediaFile, newKind: string) {
    try { const updated = await api.patchFile(f.id, { kind: newKind, version: f.version }); setPreview(updated); await load() }
    catch (e: any) { setErr(e.message) }
  }

  async function doDelete(f: MediaFile, force = false) {
    const r = await api.deleteFile(f.id, { confirm: true, force })
    if (r.ok) { setConfirm(null); setPreview(null); await loadFolders(); await load(); return }
    if (r.status === 409) { setConfirm({ file: f, inUse: r.body?.inUseBy || [] }); return }
    setErr(r.body?.message || r.body?.error || `Delete failed (${r.status})`)
  }

  const shown = files || []

  return (
    <div
      onDragOver={e => { e.preventDefault(); if (!dragging) setDragging(true) }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false) }}
      onDrop={e => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files?.length) stageFiles(e.dataTransfer.files) }}
      style={{ position: 'relative', minHeight: 400 }}
    >
      <div className="page-head">
        <div><h1>Image Library</h1><p>Watermarks, slates, posters and channel brands. Drag &amp; drop or upload; assign a usage type on the way in.</p></div>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => setFolderModal(folder ? folder + '/' : '')}>+ New folder</button>
        <button className="btn primary" onClick={() => fileInput.current?.click()}>Upload images</button>
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={e => { if (e.target.files) stageFiles(e.target.files); if (fileInput.current) fileInput.current.value = '' }} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16, alignItems: 'start' }}>
        <div className="card" style={{ padding: 10 }}>
          <FolderRow label="All images" active={folder === ''} onClick={() => setFolder('')} count={folders.reduce((a, f) => a + f.count, 0)} depth={0} />
          {folders.map(f => (
            <FolderRow key={f.path} label={f.name} active={folder === f.path} onClick={() => setFolder(f.path)} count={f.count} depth={f.path.split('/').length} />
          ))}
          {folders.length === 0 && (
            <div style={{ padding: '10px 8px', fontSize: 12, color: 'var(--faint)' }}>
              No folders yet. Quick-create:
              <div className="chipset" style={{ marginTop: 8 }}>
                {STD_FOLDERS.map(name => <div key={name} className="selchip" onClick={async () => { await api.createFolder(name); await loadFolders(); setFolder(name) }}>{name}</div>)}
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="filters" style={{ marginBottom: 12 }}>
            <input className="inp" style={{ maxWidth: 240 }} placeholder="Search name or path…" value={q} onChange={e => setQ(e.target.value)} />
            {KINDS.map(k => <div key={k} className={`chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>{k}</div>)}
          </div>

          {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}

          {files === null ? <div className="loading">Loading…</div>
            : shown.length === 0 ? (
              <div className="empty" onClick={() => fileInput.current?.click()} style={{ cursor: 'pointer' }}>
                <div className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg></div>
                <h3>No images here</h3>
                <p>{folder ? `The “${folder}” folder is empty.` : 'Your library is empty.'} Drag images in, or click to upload.</p>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 14 }}>
                {shown.map(f => (
                  <div key={f.id} className="card" style={{ overflow: 'hidden', cursor: 'pointer' }} onClick={() => setPreview(f)}>
                    <div style={{ aspectRatio: '16/10', background: 'repeating-conic-gradient(#1a1f2b 0% 25%, #141821 0% 50%) 50% / 16px 16px', display: 'grid', placeItems: 'center' }}>
                      <img src={thumbUrl(f.url, 300, 190)} alt={f.name} loading="lazy" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                    </div>
                    <div style={{ padding: '9px 11px' }}>
                      <div style={{ fontWeight: 650, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={f.path}>{f.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                        <span className="tag type" style={{ fontSize: 10 }}>{f.kind}</span>
                        <span style={{ fontSize: 11, color: 'var(--faint)' }}>{f.width && f.height ? `${f.width}×${f.height}` : ''} · {human(f.size_bytes)}</span>
                      </div>
                      {f.folder && <div style={{ fontSize: 10.5, color: 'var(--faint)', marginTop: 2 }}>{f.folder}/</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>

      {/* drag overlay */}
      {dragging && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(11,15,22,.7)', display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <div style={{ border: '2px dashed var(--brand)', borderRadius: 16, padding: '48px 64px', textAlign: 'center', color: '#dbe6ff', background: 'var(--brand-dim)' }}>
            <div style={{ fontSize: 30, marginBottom: 8 }}>⬇</div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Drop images to add</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>You’ll set the usage type before they upload.</div>
          </div>
        </div>
      )}

      {/* staging / review before commit */}
      {staged && (
        <div className="drawer-scrim" onClick={() => { staged.items.forEach(it => URL.revokeObjectURL(it.preview)); setStaged(null) }}>
          <div className="drawer" onClick={e => e.stopPropagation()} style={{ width: 560, maxWidth: '96vw' }}>
            <div className="drawer-h"><div className="t">Add {staged.items.length} image{staged.items.length > 1 ? 's' : ''}</div>
              <button className="xbtn" onClick={() => { staged.items.forEach(it => URL.revokeObjectURL(it.preview)); setStaged(null) }}>✕</button></div>
            <div className="drawer-b">
              <div className="field"><label>Destination folder</label>
                <input className="inp" value={staged.folder} onChange={e => setStaged(s => s ? { ...s, folder: e.target.value.replace(/^\/|\/$/g, '') } : s)} placeholder="(root) or e.g. slates/news" />
              </div>
              <div className="field"><label>Set all to type</label>
                <div className="chipset">
                  {ASSIGNABLE.map(k => <div key={k} className="selchip" onClick={() => setStaged(s => s ? { ...s, items: s.items.map(it => ({ ...it, kind: k })) } : s)}>{k}</div>)}
                </div>
                <div className="hintxt">Pre-filled from the folder. Confirm or change per image below so nothing is stored as the wrong type.</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {staged.items.map((it, i) => (
                  <div key={i} style={{ display: 'flex', gap: 11, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 11, padding: 9 }}>
                    <img src={it.preview} alt="" style={{ width: 56, height: 42, objectFit: 'cover', borderRadius: 7, background: '#000', flex: 'none' }} />
                    <input className="inp" value={it.name} onChange={e => updateStaged(i, { name: e.target.value })} style={{ flex: 1 }} />
                    <select className="inp" style={{ width: 116 }} value={it.kind} onChange={e => updateStaged(i, { kind: e.target.value })}>
                      {ASSIGNABLE.map(k => <option key={k} value={k}>{k}</option>)}
                    </select>
                    <button className="xbtn" title="Remove" onClick={() => { URL.revokeObjectURL(it.preview); setStaged(s => s ? { ...s, items: s.items.filter((_, j) => j !== i) } : s) }}>✕</button>
                  </div>
                ))}
              </div>
            </div>
            <div className="drawer-f">
              <button className="btn ghost" onClick={() => { staged.items.forEach(it => URL.revokeObjectURL(it.preview)); setStaged(null) }}>Cancel</button>
              <button className="btn primary" disabled={!staged.items.length} onClick={commitUpload}>Upload {staged.items.length}</button>
            </div>
          </div>
        </div>
      )}

      {/* preview / detail with editable type */}
      {preview && (
        <div className="drawer-scrim" onClick={() => setPreview(null)} style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div className="card" onClick={e => e.stopPropagation()} style={{ width: 560, maxWidth: '95vw', padding: 0, overflow: 'hidden' }}>
            <div style={{ background: 'repeating-conic-gradient(#1a1f2b 0% 25%, #141821 0% 50%) 50% / 18px 18px', display: 'grid', placeItems: 'center', maxHeight: 360 }}>
              <img src={thumbUrl(preview.url, 1000, 720, 'inside')} alt={preview.name} style={{ maxWidth: '100%', maxHeight: 360, objectFit: 'contain' }} />
            </div>
            <div style={{ padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{preview.name}</div>
                <span className="spacer" style={{ flex: 1 }} />
                <button className="xbtn" title="Delete" onClick={() => setConfirm({ file: preview })}>🗑</button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--faint)', margin: '2px 0 12px' }}>{preview.folder ? preview.folder + '/' : '(root)'} · {preview.width && preview.height ? `${preview.width}×${preview.height}` : 'unknown size'} · {human(preview.size_bytes)} · {preview.content_type}</div>
              <div className="field"><label>Usage type</label>
                <select className="inp" value={preview.kind} onChange={e => changeKind(preview, e.target.value)}>
                  {ASSIGNABLE.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
                <div className="hintxt">Controls where it appears in pickers (slate / watermark / brand / poster). Change any time.</div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                <button className="btn ghost" onClick={() => setPreview(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div style={{ position: 'fixed', left: '50%', bottom: 26, transform: 'translateX(-50%)', zIndex: 60, background: 'var(--panel-3)', border: '1px solid var(--border-2)', color: 'var(--text)', padding: '10px 16px', borderRadius: 10, fontSize: 13, boxShadow: 'var(--shadow)' }}>{toast}</div>
      )}

      {folderModal !== null && (
        <div className="drawer-scrim" onClick={() => setFolderModal(null)} style={{ alignItems: 'center', justifyContent: 'center' }}>
          <form className="card" onClick={e => e.stopPropagation()} style={{ width: 420, padding: 20 }}
            onSubmit={e => { e.preventDefault(); createFolder(folderModal) }}>
            <h3 style={{ margin: '0 0 4px' }}>New folder</h3>
            <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: '0 0 12px' }}>Use “/” for nested folders, e.g. <span style={{ fontFamily: 'ui-monospace,monospace' }}>slates/news</span>.</p>
            <input className="inp" autoFocus value={folderModal} onChange={e => setFolderModal(e.target.value)} placeholder="slates/news" />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
              <button type="button" className="btn ghost" onClick={() => setFolderModal(null)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={!folderModal.trim()}>Create folder</button>
            </div>
          </form>
        </div>
      )}

      {confirm && (
        <div className="drawer-scrim" onClick={() => setConfirm(null)} style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div className="card" onClick={e => e.stopPropagation()} style={{ width: 420, padding: 20 }}>
            <h3 style={{ margin: '0 0 8px' }}>Delete image?</h3>
            <p style={{ color: 'var(--muted)', fontSize: 13 }}><b>{confirm.file.path}</b> — this can’t be undone.</p>
            {confirm.inUse && confirm.inUse.length > 0 && (
              <div className="err" style={{ marginBottom: 8 }}>In use as a slate by {confirm.inUse.length} channel(s): {confirm.inUse.map((c: any) => c.name).join(', ')}. Force-delete anyway?</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
              <button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="btn primary" style={{ background: 'var(--down)' }} onClick={() => doDelete(confirm.file, !!(confirm.inUse && confirm.inUse.length))}>
                {confirm.inUse && confirm.inUse.length ? 'Force delete' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function FolderRow({ label, active, onClick, count, depth }: { label: string; active: boolean; onClick: () => void; count: number; depth: number }) {
  return (
    <div onClick={onClick} className={`nav-item ${active ? 'active' : ''}`}
      style={{ paddingLeft: 8 + depth * 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderRadius: 8 }}>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
      <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <span style={{ fontSize: 11, color: 'var(--faint)' }}>{count}</span>
    </div>
  )
}
