import { useEffect, useRef, useState } from 'react'
import { api, type MediaFile } from '../api'

const KINDS = ['all', 'slate', 'watermark', 'poster', 'brand', 'other'] as const
const STD_FOLDERS = ['slates', 'watermarks', 'brands', 'posters']

function inferKind(folder: string): string {
  const top = folder.split('/')[0]
  if (top === 'slates') return 'slate'
  if (top === 'watermarks') return 'watermark'
  if (top === 'brands') return 'brand'
  if (top === 'posters') return 'poster'
  return 'other'
}
function fileToDataURL(file: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(file) })
}
function human(bytes: number | null) {
  if (!bytes) return '—'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

export default function ImageLibrary() {
  const [folders, setFolders] = useState<{ path: string; name: string; count: number }[]>([])
  const [folder, setFolder] = useState<string>('')      // '' = root; browse recursively from here
  const [kind, setKind] = useState<string>('all')
  const [q, setQ] = useState('')
  const [files, setFiles] = useState<MediaFile[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirm, setConfirm] = useState<{ file: MediaFile; inUse?: any[] } | null>(null)
  const [folderModal, setFolderModal] = useState<null | string>(null) // holds the input value while open
  const fileInput = useRef<HTMLInputElement | null>(null)

  async function loadFolders() { try { setFolders((await api.fileFolders()).folders) } catch { /* */ } }
  async function load() {
    try { setFiles(await api.files({ folder: folder || '', recursive: true, kind: kind === 'all' ? undefined : kind, q: q || undefined })) }
    catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { loadFolders() }, [])
  useEffect(() => { setFiles(null); load() /* eslint-disable-next-line */ }, [folder, kind, q])

  async function onUpload(list: FileList | null) {
    if (!list?.length) return
    setBusy(true); setErr('')
    let ok = 0
    try {
      for (const f of Array.from(list)) {
        if (!f.type.startsWith('image/')) { setErr(`Skipped ${f.name}: not an image`); continue }
        if (f.size > 28 * 1024 * 1024) { setErr(`${f.name} is too large (${(f.size / 1048576).toFixed(1)} MB; max ~28 MB)`); continue }
        try {
          const dataUrl = await fileToDataURL(f)
          await api.uploadFile({ folder, name: f.name, kind: inferKind(folder), contentType: f.type, dataBase64: dataUrl })
          ok++
        } catch (e: any) { setErr(`Couldn’t upload ${f.name}: ${e.message}`) }
      }
      if (ok) await loadFolders()
      if (ok) await load()
    } finally { setBusy(false); if (fileInput.current) fileInput.current.value = '' }
  }

  async function createFolder(name: string) {
    const clean = name.trim().replace(/^\/|\/$/g, '')
    if (!clean) return
    try { await api.createFolder(clean); await loadFolders(); setFolder(clean); setFolderModal(null) }
    catch (e: any) { setErr(e.message) }
  }

  async function doDelete(f: MediaFile, force = false) {
    const r = await api.deleteFile(f.id, { confirm: true, force })
    if (r.ok) { setConfirm(null); await loadFolders(); await load(); return }
    if (r.status === 409) { setConfirm({ file: f, inUse: r.body?.inUseBy || [] }); return } // needs force
    setErr(r.body?.message || r.body?.error || `Delete failed (${r.status})`)
  }

  const shown = files || []

  return (
    <>
      <div className="page-head">
        <div><h1>Image Library</h1><p>Watermarks, slates, posters and channel brands. Hierarchical, searchable, backed by the image store.</p></div>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => setFolderModal(folder ? folder + '/' : '')}>+ New folder</button>
        <button className="btn primary" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? 'Uploading…' : 'Upload images'}</button>
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={e => onUpload(e.target.files)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16, alignItems: 'start' }}>
        {/* folder tree */}
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

        {/* grid */}
        <div>
          <div className="filters" style={{ marginBottom: 12 }}>
            <input className="inp" style={{ maxWidth: 240 }} placeholder="Search name or path…" value={q} onChange={e => setQ(e.target.value)} />
            {KINDS.map(k => <div key={k} className={`chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>{k}</div>)}
          </div>

          {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}

          {files === null ? <div className="loading">Loading…</div>
            : shown.length === 0 ? (
              <div className="empty">
                <div className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg></div>
                <h3>No images here</h3>
                <p>{folder ? `The “${folder}” folder is empty.` : 'Your library is empty.'} Upload images or drop them in.</p>
                <button className="btn primary" onClick={() => fileInput.current?.click()} style={{ margin: '0 auto' }}>Upload images</button>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 14 }}>
                {shown.map(f => (
                  <div key={f.id} className="card" style={{ overflow: 'hidden' }}>
                    <div style={{ aspectRatio: '16/10', background: 'repeating-conic-gradient(#1a1f2b 0% 25%, #141821 0% 50%) 50% / 16px 16px', display: 'grid', placeItems: 'center' }}>
                      <img src={f.url} alt={f.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                    </div>
                    <div style={{ padding: '9px 11px' }}>
                      <div style={{ fontWeight: 650, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={f.path}>{f.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                        <span className="tag type" style={{ fontSize: 10 }}>{f.kind}</span>
                        <span style={{ fontSize: 11, color: 'var(--faint)' }}>{f.width && f.height ? `${f.width}×${f.height}` : ''} · {human(f.size_bytes)}</span>
                        <span className="spacer" style={{ flex: 1 }} />
                        <button className="xbtn" title="Delete" style={{ fontSize: 14 }} onClick={() => setConfirm({ file: f })}>🗑</button>
                      </div>
                      {f.folder && <div style={{ fontSize: 10.5, color: 'var(--faint)', marginTop: 2 }}>{f.folder}/</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>

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
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>
              <b>{confirm.file.path}</b> — this can’t be undone.
            </p>
            {confirm.inUse && confirm.inUse.length > 0 && (
              <div className="err" style={{ marginBottom: 8 }}>In use as a slate by {confirm.inUse.length} channel(s): {confirm.inUse.map((c: any) => c.name).join(', ')}. Force-delete anyway?</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
              <button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="btn primary" style={{ background: 'var(--down)' }}
                onClick={() => doDelete(confirm.file, !!(confirm.inUse && confirm.inUse.length))}>
                {confirm.inUse && confirm.inUse.length ? 'Force delete' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
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
