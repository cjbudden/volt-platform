import { useEffect, useRef, useState } from 'react'
import { api, apiRequest, thumbUrl, isMotionFile, type MediaFile, type LibraryFolder, type BugAd } from '../api'
import { MotionThumb, motionOf } from '../MotionThumb'
import { signImage } from '../imageSigning'

/** The service's default IMAGE_MAX_DIMENSION; larger sizes are refused, not clamped. */
const MAX_DIM = 4096
import { enqueueUploads, useUploads } from '../uploads'
import { pressable } from '../a11y'
import { SocialComposer, SocialPanel } from './SocialPublish'
import { FieldError, FormStatus, Notice, useNotify, usePageNotice } from '../notices'
import { MoveDialog, DeleteFolderDialog, DuplicatesDialog, ReplaceDialog, describeMove, DRAG_TYPE } from './library/LibraryMove'

// Sprite sheets are not library images (they live in the sprite store, docs/THUMBNAILS.md), so no chip for them.
const KINDS = ['all', 'slate', 'watermark', 'poster', 'cover', 'brand', 'bug', 'other', 'keyframe'] as const
const ASSIGNABLE = ['slate', 'watermark', 'poster', 'cover', 'brand', 'bug', 'other'] // user-assignable usage types (cover: song and album artwork)
const STD_FOLDERS = ['slates', 'watermarks', 'brands', 'posters', 'bugs']

function inferKind(folder: string): string {
  const top = folder.split('/')[0]
  if (top === 'slates') return 'slate'
  if (top === 'watermarks') return 'watermark'
  if (top === 'brands') return 'brand'
  if (top === 'posters') return 'poster'
  if (top === 'bugs') return 'bug'
  return 'other'
}
function human(bytes: number | null) {
  if (!bytes) return '—'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

interface Staged { file: File; name: string; kind: string; preview: string; video?: boolean }

type SourceFilter = 'library' | 'encoder' | 'all'
type SortBy = 'name' | 'newest' | 'taken'
const PAGE = 120

export default function ImageLibrary() {
  // the folder tree loads lazily: the top level here, children as they open
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [treeKey, setTreeKey] = useState(0)
  const [folder, setFolderRaw] = useState<string>('')
  const [kind, setKind] = useState<string>('all')
  const [q, setQ] = useState('')
  const [files, setFiles] = useState<MediaFile[] | null>(null)
  const [total, setTotal] = useState(0)
  const [matchedFolders, setMatchedFolders] = useState<LibraryFolder[]>([])
  // Encoder thumbnails can run to thousands a day, so the library shows what
  // people put there unless you open the thumbnails folder or ask for them.
  const [source, setSource] = useState<SourceFilter>('library')
  const [hasLocation, setHasLocation] = useState(false)
  const [sort, setSort] = useState<SortBy>('name')
  const [near, setNear] = useState<string | null>(null)
  const setFolder = (f: string) => {
    setFolderRaw(f)
    if (f.split('/')[0] === 'thumbnails') { setSource('all'); setSort('newest') }
  }
  const [err, setErr] = useState('')
  const notify = useNotify()
  // Errors that belong to a dialog or a field, keyed so they never show against another file.
  const [folderErr, setFolderErr] = useState('')
  const [kindErr, setKindErr] = useState<{ id: string; msg: string } | null>(null)
  const [delErr, setDelErr] = useState<{ id: string; msg: string } | null>(null)
  const [confirm, setConfirm] = useState<{ file: MediaFile; inUse?: any[] } | null>(null)
  const [folderModal, setFolderModal] = useState<null | string>(null)
  // What previews sit on. A dark logo vanishes on the dark checker and a white one on light,
  // so it is the viewer's choice, remembered in this browser.
  const [backdrop, setBackdrop] = useState<Backdrop>(() => { try { const v = localStorage.getItem('volt.images.backdrop'); return v === 'dark' || v === 'light' ? v : 'checker' } catch { return 'checker' } })
  const setBackdropSaved = (b: Backdrop) => { setBackdrop(b); try { localStorage.setItem('volt.images.backdrop', b) } catch { /* private window */ } }
  const [stagedAd, setStagedAd] = useState<Required<BugAd>>({ advertiser: '', agency: '', campaign: '', adCode: '' })
  const [staged, setStaged] = useState<{ items: Staged[]; folder: string } | null>(null)
  const [preview, setPreview] = useState<MediaFile | null>(null)
  const [builder, setBuilder] = useState<MediaFile | null>(null)
  // A picture to publish as an Instagram feed post (build queue 1.14i), and a nudge for its status list.
  const [publishImg, setPublishImg] = useState<MediaFile | null>(null)
  const [socialKey, setSocialKey] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState('')
  // SELECTING AND MOVING (library/LibraryMove.tsx): pick images (tick, Ctrl/Cmd or Shift
  // click), then Move to folder, or drag them onto a folder in the tree.
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [lastPick, setLastPick] = useState<number | null>(null)
  const [moving, setMoving] = useState<MediaFile[] | null>(null)
  const [delFolder, setDelFolder] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const uploads = useUploads()

  function flash(msg: string) { setToast(msg); window.setTimeout(() => setToast(t => (t === msg ? '' : t)), 3200) }

  // refresh the grid as background uploads complete (seq bumps per success)
  useEffect(() => { if (uploads.seq) { loadFolders(); load() } /* eslint-disable-next-line */ }, [uploads.seq])

  // Folder counts follow the grid's source filter, and "All images" counts the top level too.
  const [allCount, setAllCount] = useState<number | null>(null)
  const [dupes, setDupes] = useState(false)
  const [replacing, setReplacing] = useState<MediaFile[] | null>(null)
  async function loadFolders() {
    try {
      const r: any = await apiRequest(`/files/folders?parent=&source=${source === 'all' ? '' : source}`)
      setFolders(r.folders); setAllCount(typeof r.total === 'number' ? r.total : null); setTreeKey(k => k + 1)
    } catch { /* */ }
  }
  async function load(more = false) {
    try {
      setErr('')
      const term = q.trim()
      // A search looks through every folder; browsing stays in the open one.
      const r = await api.searchLibrary({
        folder: term ? undefined : (folder || ''), recursive: true, q: term || undefined,
        kind: kind === 'all' ? undefined : kind, source: source === 'all' ? undefined : source,
        hasLocation: hasLocation || undefined, near: near ?? undefined, sort: term && sort === 'name' ? 'relevance' : sort,
        limit: PAGE, offset: more ? (files?.length ?? 0) : 0,
      })
      setFiles(more ? [...(files ?? []), ...r.files] : r.files)
      setTotal(r.total)
      setMatchedFolders(r.folders)
    }
    catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { loadFolders() /* eslint-disable-next-line */ }, [source])
  // folder / filter changes reload immediately; the search term is debounced so typing
  // doesn't fire a request per keystroke (and doesn't flicker the grid to Loading).
  useEffect(() => { setFiles(null); load() /* eslint-disable-next-line */ }, [folder, kind, source, hasLocation, sort, near])
  useEffect(() => { setSel(new Set()); setLastPick(null) }, [folder, kind, source, hasLocation, sort, near, q])
  useEffect(() => {
    const t = setTimeout(() => { load() }, 200)
    return () => clearTimeout(t)
    // eslint-disable-next-line
  }, [q])

  // ---- staging: build a review list instead of uploading immediately ---------
  function stageFiles(list: FileList | File[]) {
    // Images, and videos for graphics (animated bugs: converted to alpha WebM on upload).
    const arr = Array.from(list).filter(f => f.type.startsWith('image/') || isMotionFile(f))
    if (!arr.length) { notify({ kind: 'error', message: 'No image or video files in that selection' }); return }
    const items: Staged[] = arr.map(file => ({ file, name: file.name, kind: isMotionFile(file) ? 'bug' : inferKind(folder), preview: URL.createObjectURL(file), video: isMotionFile(file) }))
    setStaged({ items, folder: folder || (items.every(i => i.video) ? 'bugs' : folder) })
  }
  function updateStaged(i: number, patch: Partial<Staged>) {
    setStaged(s => s ? { ...s, items: s.items.map((it, j) => j === i ? { ...it, ...patch } : it) } : s)
  }
  // hand off to the background uploader and close the review panel; progress shows in
  // the topbar indicator and the grid refreshes as each item completes.
  function commitUpload() {
    if (!staged) return
    const ad = Object.fromEntries(Object.entries(stagedAd).filter(([, v]) => v.trim())) as BugAd
    enqueueUploads(staged.items.map(it => ({ file: it.file, folder: staged.folder, name: it.name, kind: it.kind, ad: it.kind === 'bug' ? ad : undefined })))
    setStagedAd({ advertiser: '', agency: '', campaign: '', adCode: '' })
    const n = staged.items.length
    staged.items.forEach(it => URL.revokeObjectURL(it.preview))
    setStaged(null)
    flash(`Uploading ${n} image${n > 1 ? 's' : ''} in the background…`)
  }

  async function createFolder(name: string) {
    const clean = name.trim().replace(/^\/|\/$/g, '')
    if (!clean) return
    setFolderErr('')
    try { await api.createFolder(clean); await loadFolders(); setFolder(clean); setFolderModal(null) }
    catch (e: any) { setFolderErr(e.message) }
  }

  async function changeKind(f: MediaFile, newKind: string) {
    setKindErr(null)
    try { const updated = await api.patchFile(f.id, { kind: newKind, version: f.version }); setPreview(updated); await load() }
    catch (e: any) { setKindErr({ id: f.id, msg: e.message }) }
  }

  const movable = (f: MediaFile) => f.source !== 'encoder'
  function pick(e: any, f: MediaFile, i: number) {
    const list = files ?? []
    if (e?.shiftKey && lastPick != null) {
      const [a, b] = lastPick < i ? [lastPick, i] : [i, lastPick]
      setSel(s => { const n = new Set(s); list.slice(a, b + 1).filter(movable).forEach(x => n.add(x.id)); return n })
    } else {
      setSel(s => { const n = new Set(s); n.has(f.id) ? n.delete(f.id) : n.add(f.id); return n })
      setLastPick(i)
    }
  }
  function onCard(e: any, f: MediaFile, i: number) {
    // Plain click opens the image; with a selection going, or Ctrl/Cmd/Shift held, it selects.
    if (movable(f) && (sel.size || e?.shiftKey || e?.metaKey || e?.ctrlKey)) { e?.preventDefault?.(); pick(e, f, i); return }
    setPreview(f)
  }
  async function dropOnFolder(path: string, ids: string[]) {
    if (!ids.length) return
    try {
      const r = await apiRequest('/files/move', { method: 'POST', body: JSON.stringify({ ids, folder: path }), headers: { 'content-type': 'application/json' } })
      flash(describeMove(r, path)); setSel(new Set()); await loadFolders(); await load()
    } catch (e: any) { flash(`Not moved: ${e.message}`) }
  }

  async function doDelete(f: MediaFile, force = false) {
    setDelErr(null)
    const r = await api.deleteFile(f.id, { confirm: true, force })
    if (r.ok) { setConfirm(null); setPreview(null); await loadFolders(); await load(); return }
    if (r.status === 409) { setConfirm({ file: f, inUse: r.body?.inUseBy || [] }); return }
    setDelErr({ id: f.id, msg: r.body?.message || r.body?.error || `Delete failed (${r.status})` })
  }
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load the image library.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)

  const shown = files || []

  return (
    <div
      onDragOver={e => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); if (!dragging) setDragging(true) }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false) }}
      onDrop={e => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); setDragging(false); if (e.dataTransfer.files?.length) stageFiles(e.dataTransfer.files) }}
      style={{ position: 'relative', minHeight: 400 }}
    >
      <div className="page-head">
        <div><h1>Image Library</h1><p>Watermarks, slates, posters and channel brands. Drag &amp; drop or upload; assign a usage type on the way in.</p></div>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => setDupes(true)} title="Find images stored more than once and keep one">Duplicates…</button>
        <button className="btn ghost" onClick={() => { setFolderErr(''); setFolderModal(folder ? folder + '/' : '') }}>+ New folder</button>
        <button className="btn primary" onClick={() => fileInput.current?.click()}>Upload images</button>
        <input ref={fileInput} type="file" accept="image/*,video/*,.mov,.webm" multiple hidden onChange={e => { if (e.target.files) stageFiles(e.target.files); if (fileInput.current) fileInput.current.value = '' }} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16, alignItems: 'start' }}>
        <div className="card" style={{ padding: 10 }}>
          <FolderRow label="All images" active={folder === ''} onClick={() => setFolder('')} count={allCount ?? folders.reduce((a, f) => a + (f.total ?? f.count), 0)} depth={0} onDropImages={ids => dropOnFolder('', ids)} />
          {folders.map(f => (
            <FolderNode key={`${treeKey}-${f.path}`} node={f} active={folder} onPick={setFolder} depth={1} onDropImages={dropOnFolder} source={source} />
          ))}
          {folders.length === 0 && (
            <div style={{ padding: '10px 8px', fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>
              No folders yet. Quick-create:
              <div className="chipset" style={{ marginTop: 8 }}>
                {STD_FOLDERS.map(name => <div key={name} className="selchip" {...pressable((e: any) => { ((async () => { await api.createFolder(name); await loadFolders(); setFolder(name) }) as any)(e) })} data-a11y-click="">{name}</div>)}
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="filters" style={{ marginBottom: 12, gap: 8, alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: '1 1 320px', maxWidth: 420 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', width: 16, height: 16, color: 'var(--faint)', pointerEvents: 'none' }}><circle cx="11" cy="11" r="7" /><path d="m21 21-4-4" /></svg>
              <input className="inp" style={{ width: '100%', paddingLeft: 34 }} placeholder="Search images and folders: name, tag, place, camera, programme…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search images and folders" />
              {q && <button className="xbtn" onClick={() => setQ('')} title="Clear" style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)' }}>✕</button>}
            </div>
            {KINDS.map(k => <div key={k} className={`chip ${kind === k ? 'active' : ''}`} {...pressable((e: any) => { ((() => setKind(k)) as any)(e) })} data-a11y-click="">{k === 'keyframe' ? 'still' : k === 'bug' ? 'bugs' : k}</div>)}
            <span style={{ flex: 1 }} />
            <div className="chipset" role="radiogroup" aria-label="Preview background" title="What the previews sit on: transparent logos and bugs read best on the one that contrasts with them">
              {(['checker', 'dark', 'light'] as const).map(b => (
                <button key={b} type="button" role="radio" aria-checked={backdrop === b} className={`selchip ${backdrop === b ? 'sel' : ''}`} onClick={() => setBackdropSaved(b)}
                  style={{ padding: '6px 9px' }} aria-label={`${b} background`}>
                  <span aria-hidden="true" style={{ width: 14, height: 14, borderRadius: 3, display: 'inline-block', border: '1px solid var(--border-2)', background: BACKDROP[b] }} />
                </button>
              ))}
            </div>
          </div>
          <div className="filters" style={{ marginBottom: 12, gap: 8, alignItems: 'center' }}>
            {([['library', 'Uploaded'], ['encoder', 'Encoder thumbnails'], ['all', 'Everything']] as const).map(([k, label]) => (
              <div key={k} className={`chip ${source === k ? 'active' : ''}`} {...pressable((e: any) => { ((() => setSource(k)) as any)(e) })} data-a11y-click="">{label}</div>
            ))}
            {near && <div className="chip active" title="Showing images taken within 5 km" {...pressable((e: any) => { ((() => setNear(null)) as any)(e) })} data-a11y-click="">Within 5 km ✕</div>}
            <div className={`chip ${hasLocation ? 'active' : ''}`} title="Only images that carry a GPS position or a place name"
              {...pressable((e: any) => { ((() => setHasLocation(v => !v)) as any)(e) })} data-a11y-click="">Has location</div>
            <select className="inp" value={sort} onChange={e => setSort(e.target.value as SortBy)} style={{ width: 150 }} aria-label="Sort">
              <option value="name">Sort by name</option>
              <option value="newest">Newest first</option>
              <option value="taken">Date taken</option>
            </select>
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', marginLeft: 'auto' }}>
              {files ? `${total} image${total === 1 ? '' : 's'}${q.trim() ? ' in all folders' : folder ? ` in ${folder}` : ''}` : ''}
            </span>
          </div>

          {q.trim() && matchedFolders.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 'var(--fs-label)', color: 'var(--faint)', marginBottom: 6 }}>Folders</div>
              <div className="chipset">
                {matchedFolders.map(f => (
                  <div key={f.path} className="selchip" title={f.path} {...pressable((e: any) => { ((() => { setQ(''); setFolder(f.path) }) as any)(e) })} data-a11y-click="">
                    📁 {f.path} <span style={{ color: 'var(--faint)' }}>({f.count})</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {folder && !q.trim() && (
            <div className="lib-folderbar">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
              <span className="mono">{folder}</span>
              <button className="btn ghost sm" onClick={() => setDelFolder(folder)} title="A folder can be deleted when it holds no images">Delete folder…</button>
            </div>
          )}
          {sel.size > 0 && (
            <div className="lib-selbar" role="region" aria-label="Selected images">
              <b>{sel.size} selected</b>
              <button className="btn primary sm" onClick={() => setMoving((files ?? []).filter(f => sel.has(f.id)))}>Move to folder…</button>
              <button className="btn ghost sm" onClick={() => setReplacing((files ?? []).filter(f => sel.has(f.id) && movable(f)))} title="These go to the restore bin; everything that uses them uses the image you choose">Replace with…</button>
              {(files ?? []).filter(movable).some(f => !sel.has(f.id)) && <button className="btn ghost sm" onClick={() => setSel(new Set((files ?? []).filter(movable).map(f => f.id)))}>Select all {(files ?? []).filter(movable).length} shown</button>}
              <button className="btn ghost sm" onClick={() => { setSel(new Set()); setLastPick(null) }}>Clear</button>
              <span className="lib-faint" style={{ marginLeft: 'auto' }}>Or drag them onto a folder. Shift-click selects a range.</span>
            </div>
          )}
          {files === null ? <div className="loading">Loading…</div>
            : shown.length === 0 ? (
              <div className="empty" {...pressable((e: any) => { ((() => fileInput.current?.click()) as any)(e) })} data-a11y-click="" style={{ cursor: 'pointer' }}>
                <div className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg></div>
                <h3>No images here</h3>
                <p>{folder ? `The “${folder}” folder is empty.` : 'Your library is empty.'} Drag images in, or click to upload.</p>
              </div>
            ) : (
              <div className={sel.size ? 'lib-selecting' : undefined} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 14 }}>
                {shown.map((f, i) => (
                  <div key={f.id} className={`card lib-card${sel.has(f.id) ? ' sel' : ''}`} style={{ overflow: 'hidden', cursor: 'pointer' }} {...pressable((e: any) => onCard(e, f, i))} data-a11y-click=""
                    draggable={movable(f)} onDragStart={e => {
                      const ids = sel.has(f.id) ? [...sel] : [f.id]
                      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids)); e.dataTransfer.effectAllowed = 'move'
                    }}>
                    <button type="button" className={`lib-pick${sel.has(f.id) ? ' on' : ''}`} disabled={!movable(f)} aria-pressed={sel.has(f.id)}
                      aria-label={`${sel.has(f.id) ? 'Unselect' : 'Select'} ${f.name}`} onClick={e => { e.stopPropagation(); pick(e, f, i) }}>{sel.has(f.id) ? '✓' : ''}</button>
                    <GridThumb f={f} backdrop={backdrop} />
                    <div style={{ padding: '9px 11px' }}>
                      <div style={{ fontWeight: 650, fontSize: 'var(--fs-sm)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={f.path}>{f.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                        <span className="tag type" style={{ fontSize: 'var(--fs-micro)' }}>{f.kind}</span>
                        {f.kind === 'bug' && f.metadata?.ad?.advertiser && <span style={{ fontSize: 'var(--fs-label)', color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={[f.metadata.ad.advertiser, f.metadata.ad.campaign].filter(Boolean).join(' · ')}>{f.metadata.ad.advertiser}</span>}
                        <span style={{ fontSize: 'var(--fs-label)', color: 'var(--faint)' }}>{f.width && f.height ? `${f.width}×${f.height}` : ''} · {human(f.size_bytes)}</span>
                      </div>
                      {f.source === 'encoder' && f.captured_at
                        ? <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 2 }}>{new Date(f.captured_at).toLocaleString()}{f.metadata?.programme ? ` · ${f.metadata.programme}` : ''}</div>
                        : f.location ? <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={f.location}>📍 {f.location}</div>
                        : f.folder && <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 2 }}>{f.folder}/</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          {files && files.length < total && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
              <button className="btn ghost" onClick={() => load(true)}>Show more ({total - files.length} left)</button>
            </div>
          )}
        </div>
      </div>

      {/* drag overlay */}
      {dragging && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(11,15,22,.7)', display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <div style={{ border: '2px dashed var(--brand)', borderRadius: 16, padding: '48px 64px', textAlign: 'center', color: '#dbe6ff', background: 'var(--brand-dim)' }}>
            <div style={{ fontSize: 30, marginBottom: 8 }}>⬇</div>
            <div style={{ fontWeight: 700, fontSize: 'var(--fs-h2)' }}>Drop images to add</div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 4 }}>You’ll set the usage type before they upload.</div>
          </div>
        </div>
      )}

      {/* staging / review before commit */}
      {staged && (
        <div className="drawer-scrim" {...pressable((e: any) => { ((() => { staged.items.forEach(it => URL.revokeObjectURL(it.preview)); setStaged(null) }) as any)(e) })} data-a11y-click="">
          <div className="drawer" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" style={{ width: 560, maxWidth: '96vw' }}>
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
              {staged.items.some(it => it.kind === 'bug') && (
                <div className="field"><label>Bug details (applied to the bugs above)</label>
                  <BugAdFields value={stagedAd} onChange={setStagedAd} />
                  {staged.items.some(it => it.video) && <div className="hintxt">Videos are converted to WebM with transparency for graphics. Export ProRes 4444, QuickTime Animation or WebM with alpha so the background stays clear.</div>}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {staged.items.map((it, i) => (
                  <div key={i} style={{ display: 'flex', gap: 11, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 11, padding: 9 }}>
                    {it.video
                      ? <video src={it.preview} muted style={{ width: 56, height: 42, objectFit: 'cover', borderRadius: 7, background: '#000', flex: 'none' }} />
                      : <img src={it.preview} alt="" style={{ width: 56, height: 42, objectFit: 'cover', borderRadius: 7, background: '#000', flex: 'none' }} />}
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
        <div className="drawer-scrim" {...pressable((e: any) => { ((() => setPreview(null)) as any)(e) })} data-a11y-click="" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div className="card" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" style={{ width: 600, maxWidth: '95vw', maxHeight: '92vh', padding: 0, overflow: 'auto' }}>
            <div style={{ background: BACKDROP[backdrop], display: 'grid', placeItems: 'center', maxHeight: 360, padding: 12 }}>
              {preview.metadata?.motion?.video
                ? <video src={'/' + preview.metadata.motion.video} poster={preview.url} autoPlay muted loop playsInline style={{ maxWidth: '100%', maxHeight: 360, objectFit: 'contain' }} />
                : <img src={motionOf(preview)?.kind === 'animated' ? preview.url : thumbUrl(preview.url, 1000, 720, 'inside')} alt={preview.name} style={{ maxWidth: '100%', maxHeight: 360, objectFit: 'contain' }} />}
            </div>
            <div style={{ padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 'var(--fs-h2)' }}>{preview.name}</div>
                <span className="spacer" style={{ flex: 1 }} />
                {movable(preview) && <button className="btn ghost sm" onClick={() => { setMoving([preview]); setPreview(null) }}>Move…</button>}
                {movable(preview) && <button className="btn ghost sm" onClick={() => { setReplacing([preview]); setPreview(null) }} title="A duplicate, a better version, or a broken image: everything that uses this image uses the one you choose">Replace with…</button>}
                <button className="xbtn" title="Delete" onClick={() => setConfirm({ file: preview })}>🗑</button>
              </div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', margin: '2px 0 12px' }}>{preview.folder ? preview.folder + '/' : '(root)'} · {preview.width && preview.height ? `${preview.width}×${preview.height}` : 'unknown size'} · {human(preview.size_bytes)} · {preview.content_type}</div>
              <MetadataPanel file={preview} onRefreshed={f => { setPreview(f); load() }}
                onNear={(lat, lng) => { setPreview(null); setQ(''); setFolder(''); setSource('all'); setNear(`${lat.toFixed(5)},${lng.toFixed(5)},5`) }} />
              {preview.metadata?.motion && (
                <div className="hintxt" style={{ marginBottom: 10 }}>
                  Video for graphics: {preview.metadata.motion.alpha ? 'with transparency' : 'no transparency (it will show as a solid rectangle)'}
                  {preview.metadata.motion.durationSec ? ` · ${Number(preview.metadata.motion.durationSec).toFixed(1)} s` : ''}{preview.metadata.motion.fps ? ` · ${preview.metadata.motion.fps} fps` : ''}
                  {' '}· plays as WebM in Chrome, Edge, Firefox and burned-in graphics; Safari shows the first frame.
                </div>
              )}
              {preview.kind === 'bug' && <BugAdPanel file={preview} onSaved={f => { setPreview(f); load() }} />}
              {preview.source === 'encoder' ? null : (
              <div className="field"><label>Usage type</label>
                <select className="inp" value={preview.kind} onChange={e => changeKind(preview, e.target.value)}>
                  {ASSIGNABLE.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
                <FieldError>{kindErr?.id === preview.id ? kindErr.msg : null}</FieldError>
                <div className="hintxt">Controls where it appears in pickers (slate / watermark / brand / poster / bug). Change any time.</div>
              </div>
              )}
              <SocialPanel imageId={preview.id} refreshKey={socialKey} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
                {preview.source !== 'encoder' && <button className="btn" onClick={() => { setPublishImg(preview); setPreview(null) }}>Publish to social…</button>}
                <button className="btn primary" onClick={() => { setBuilder(preview); setPreview(null) }}>URL builder…</button>
                <button className="btn ghost" onClick={() => setPreview(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {publishImg && <SocialComposer imageId={publishImg.id} onClose={() => setPublishImg(null)} onPublished={() => { setSocialKey(k => k + 1); setPreview(publishImg) }} />}
      {builder && <UrlBuilder file={builder} onClose={() => setBuilder(null)} notify={m => { setToast(m); setTimeout(() => setToast(''), 2200) }} />}

      {moving && (
        <MoveDialog ids={moving.map(f => f.id)} names={moving.map(f => f.name)} from={moving.length && moving.every(f => f.folder === moving[0].folder) ? moving[0].folder : '\u0000'}
          onClose={() => setMoving(null)}
          onMoved={async (r, dest) => { setMoving(null); setSel(new Set()); flash(describeMove(r, dest)); await loadFolders(); await load() }} />
      )}
      {replacing && replacing.length > 0 && <ReplaceDialog files={replacing} onClose={() => setReplacing(null)}
        onReplaced={async (msg) => { setReplacing(null); setSel(new Set()); flash(msg); await loadFolders(); await load() }} />}
      {dupes && <DuplicatesDialog onClose={() => setDupes(false)} onMerged={async (msg) => { setDupes(false); flash(msg); await loadFolders(); await load() }} />}
      {delFolder !== null && (
        <DeleteFolderDialog path={delFolder} onClose={() => setDelFolder(null)} onShow={() => { setDelFolder(null); setQ(''); setSource('all') }}
          onDeleted={async (removed) => {
            const gone = delFolder; setDelFolder(null)
            flash(`Deleted ${removed.length > 1 ? `${removed.length} empty folders` : `the folder ${gone}`}.`)
            setFolder(gone.includes('/') ? gone.slice(0, gone.lastIndexOf('/')) : ''); await loadFolders()
          }} />
      )}

      {toast && (
        <div style={{ position: 'fixed', left: '50%', bottom: 26, transform: 'translateX(-50%)', zIndex: 60, background: 'var(--panel-3)', border: '1px solid var(--border-2)', color: 'var(--text)', padding: '10px 16px', borderRadius: 10, fontSize: 'var(--fs-body)', boxShadow: 'var(--shadow)' }}>{toast}</div>
      )}

      {folderModal !== null && (
        <div className="drawer-scrim" {...pressable((e: any) => { ((() => setFolderModal(null)) as any)(e) })} data-a11y-click="" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <form className="card" onClick={e => e.stopPropagation()} style={{ width: 420, padding: 20 }}
            onSubmit={e => { e.preventDefault(); createFolder(folderModal) }}>
            <h3 style={{ margin: '0 0 4px' }}>New folder</h3>
            <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', margin: '0 0 12px' }}>Use “/” for nested folders, e.g. <span style={{ fontFamily: 'ui-monospace,monospace' }}>slates/news</span>.</p>
            <input className="inp" autoFocus value={folderModal} onChange={e => setFolderModal(e.target.value)} placeholder="slates/news" />
            <div className="modal-f">
              <FormStatus error={folderErr} />
              <button type="button" className="btn ghost" onClick={() => { setFolderModal(null); setFolderErr('') }}>Cancel</button>
              <button type="submit" className="btn primary" disabled={!folderModal.trim()}>Create folder</button>
            </div>
          </form>
        </div>
      )}

      {confirm && (
        <div className="drawer-scrim" {...pressable((e: any) => { ((() => setConfirm(null)) as any)(e) })} data-a11y-click="" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div className="card" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" style={{ width: 420, padding: 20 }}>
            <h3 style={{ margin: '0 0 8px' }}>Delete image?</h3>
            <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-body)' }}><b>{confirm.file.path}</b> — this can’t be undone.</p>
            {confirm.inUse && confirm.inUse.length > 0 && (
              <Notice kind="warn" variant="compact" message={`Used in ${confirm.inUse.length} place${confirm.inUse.length === 1 ? '' : 's'}: ${[...new Set(confirm.inUse.map((c: any) => c.name))].slice(0, 5).join(', ')}${confirm.inUse.length > 5 ? ' and more' : ''}. Deleting leaves them without a picture; replacing points them at another image.`} />
            )}
            <div className="modal-f">
              <FormStatus error={delErr?.id === confirm.file.id ? delErr.msg : null} />
              <button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
              {confirm.inUse && confirm.inUse.length > 0 && movable(confirm.file) && (
                <button className="btn" onClick={() => { setReplacing([confirm.file]); setConfirm(null); setPreview(null) }}>Replace with another image…</button>
              )}
              <button className="btn primary danger" onClick={() => doDelete(confirm.file, !!(confirm.inUse && confirm.inUse.length))}>
                {confirm.inUse && confirm.inUse.length ? 'Force delete' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

type Backdrop = 'checker' | 'dark' | 'light'
const BACKDROP: Record<Backdrop, string> = {
  checker: 'repeating-conic-gradient(#2a3040 0% 25%, #171b25 0% 50%) 50% / 16px 16px',
  dark: '#0b0e14',
  light: 'repeating-conic-gradient(#ffffff 0% 25%, #e9ecf1 0% 50%) 50% / 16px 16px',
}

/* ONE GRID PREVIEW. The whole image, never cropped (a wide bug or a tall poster keeps its
   shape), fetched at twice the tile size so it is sharp on a retina screen, padded so a
   small logo is not edge to edge, on the backdrop the viewer chose. A video (an animated
   bug) shows its first frame and plays in place while the pointer is over it. */
function GridThumb({ f, backdrop }: { f: MediaFile; backdrop: Backdrop }) {
  // Videos and animated GIF / WebP play while hovered (MotionThumb).
  return <MotionThumb f={f} w={600} h={380} style={{ aspectRatio: '16/10', background: BACKDROP[backdrop], padding: 10 }} />
}

/* A BUG's advertising details: kept small on purpose. Stored as metadata.ad and
   described in schema.org as the creative's sponsor (advertiser), producer (agency),
   isPartOf (campaign) and identifier (Ad-ID or key number). */
function BugAdFields({ value, onChange }: { value: Required<BugAd>; onChange: (v: Required<BugAd>) => void }) {
  const f = (k: keyof BugAd, label: string, ph: string) => (
    <input className="inp" aria-label={label} placeholder={ph} value={value[k]} onChange={e => onChange({ ...value, [k]: e.target.value })} />
  )
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      {f('advertiser', 'Advertiser', 'Advertiser, e.g. Qantas')}
      {f('agency', 'Agency', 'Agency (optional)')}
      {f('campaign', 'Campaign', 'Campaign, e.g. Summer Sale 2026')}
      {f('adCode', 'Ad code', 'Ad-ID or key number (optional)')}
    </div>
  )
}
function BugAdPanel({ file, onSaved }: { file: MediaFile; onSaved: (f: MediaFile) => void }) {
  const cur = file.metadata?.ad ?? {}
  const [v, setV] = useState<Required<BugAd>>({ advertiser: cur.advertiser ?? '', agency: cur.agency ?? '', campaign: cur.campaign ?? '', adCode: cur.adCode ?? '' })
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [ok, setOk] = useState('')
  const dirty = (['advertiser', 'agency', 'campaign', 'adCode'] as const).some(k => (cur[k] ?? '') !== v[k])
  async function save() {
    setBusy(true); setErr(''); setOk('')
    try { onSaved(await api.setFileAd(file.id, v)); setOk('Saved') } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="field"><label>Bug details</label>
      <BugAdFields value={v} onChange={setV} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <FormStatus error={err} success={ok} />
        <span style={{ flex: 1 }} />
        <button className="btn primary sm" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save details'}</button>
      </div>
    </div>
  )
}

/** Drag targets in the folder tree: images dragged from the grid move into the folder. */
function useImageDrop(onDropImages?: (ids: string[]) => void) {
  const [over, setOver] = useState(false)
  if (!onDropImages) return { over: false, props: {} }
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => { if (!e.dataTransfer.types.includes(DRAG_TYPE)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!over) setOver(true) },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
        e.preventDefault(); e.stopPropagation(); setOver(false)
        try { onDropImages(JSON.parse(e.dataTransfer.getData(DRAG_TYPE))) } catch { /* not ours */ }
      },
    },
  }
}

function FolderRow({ label, active, onClick, count, depth, onDropImages }: { label: string; active: boolean; onClick: () => void; count: number; depth: number; onDropImages?: (ids: string[]) => void }) {
  const drop = useImageDrop(onDropImages)
  return (
    <div {...pressable((e: any) => { ((onClick) as any)(e) })} data-a11y-click="" className={`nav-item ${active ? 'active' : ''}${drop.over ? ' lib-drop' : ''}`} {...drop.props}
      style={{ paddingLeft: 8 + depth * 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderRadius: 8 }}>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
      <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <span style={{ fontSize: 'var(--fs-label)', color: 'var(--faint)' }}>{count}</span>
    </div>
  )
}

/** One folder in the lazy tree: its children load the first time it opens. */
function FolderNode({ node, active, onPick, depth, onDropImages, source }: { node: LibraryFolder; active: string; onPick: (p: string) => void; depth: number; onDropImages?: (path: string, ids: string[]) => void; source?: string }) {
  const drop = useImageDrop(onDropImages ? (ids) => onDropImages(node.path, ids) : undefined)
  const inside = active === node.path || active.startsWith(node.path + '/')
  const [open, setOpen] = useState(inside)
  const [kids, setKids] = useState<LibraryFolder[] | null>(null)
  useEffect(() => { if (inside) setOpen(true) }, [inside])
  useEffect(() => {
    if (!open || kids || !node.hasChildren) return
    apiRequest(`/files/folders?parent=${encodeURIComponent(node.path)}&source=${source && source !== 'all' ? source : ''}`).then((r: any) => setKids(r.folders)).catch(() => setKids([]))
  }, [open, kids, node.path, node.hasChildren, source])
  return (
    <>
      <div className={`nav-item ${active === node.path ? 'active' : ''}${drop.over ? ' lib-drop' : ''}`} {...drop.props}
        style={{ paddingLeft: 4 + depth * 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, borderRadius: 8 }}
        {...pressable((e: any) => { ((() => { onPick(node.path); setOpen(true) }) as any)(e) })} data-a11y-click="" title={node.path}>
        <button type="button" aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`} aria-expanded={open}
          onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
          style={{ width: 16, border: 0, background: 'none', color: 'var(--faint)', cursor: 'pointer', padding: 0, visibility: node.hasChildren ? 'visible' : 'hidden' }}>
          {open ? '▾' : '▸'}
        </button>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
        <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
        <span style={{ fontSize: 'var(--fs-label)', color: 'var(--faint)' }}>{node.total ?? node.count}</span>
      </div>
      {open && kids?.map(k => <FolderNode key={k.path} node={k} active={active} onPick={onPick} depth={depth + 1} onDropImages={onDropImages} source={source} />)}
    </>
  )
}

/** What the file says about itself, and where it came from. */
function MetadataPanel({ file, onRefreshed, onNear }: { file: MediaFile; onRefreshed: (f: MediaFile) => void; onNear: (lat: number, lng: number) => void }) {
  const [busy, setBusy] = useState(false)
  const m = file.metadata ?? {}
  const fmtWhen = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : null)
  const exposure = [m.exposure, m.fNumber ? `f/${m.fNumber}` : null, m.iso ? `ISO ${m.iso}` : null, m.focalLength ? `${m.focalLength} mm` : null].filter(Boolean).join(' · ')
  const rows: [string, React.ReactNode][] = []
  if (file.source === 'encoder') {
    rows.push(['From', 'The encoder (thumbnail)'])
    if (m.channel) rows.push(['Channel', m.channel])
    if (m.programme) rows.push(['Programme', m.programme])
    if (file.captured_at) rows.push(['Captured', fmtWhen(file.captured_at)])
  } else if (file.source === 'watchfolder') rows.push(['From', 'A watchfolder'])
  if (file.title && file.title !== m.programme) rows.push(['Title', file.title])
  if (file.description) rows.push(['Description', file.description])
  if (file.taken_at) rows.push(['Taken', fmtWhen(file.taken_at)])
  if (file.camera) rows.push(['Camera', [file.camera, m.lens].filter(Boolean).join(' · ')])
  if (exposure) rows.push(['Exposure', exposure])
  if (file.location || file.gps_lat != null) {
    rows.push(['Location', (
      <span>
        {file.location}
        {file.gps_lat != null && file.gps_lng != null && (
          <>
            {file.location ? ' · ' : ''}
            <a href={`https://www.openstreetmap.org/?mlat=${file.gps_lat}&mlon=${file.gps_lng}#map=15/${file.gps_lat}/${file.gps_lng}`} target="_blank" rel="noreferrer">
              {file.gps_lat.toFixed(5)}, {file.gps_lng.toFixed(5)}
            </a>
            {file.gps_alt != null ? ` · ${Math.round(file.gps_alt)} m` : ''}
            {' · '}<a href="#near" onClick={e => { e.preventDefault(); onNear(file.gps_lat!, file.gps_lng!) }}>images taken nearby</a>
          </>
        )}
      </span>
    )])
  }
  if (file.keywords?.length) rows.push(['Keywords', file.keywords.join(', ')])
  if (file.creator) rows.push(['Creator', file.creator])
  if (file.copyright) rows.push(['Copyright', file.copyright])
  if (m.space || m.hasAlpha != null) rows.push(['Colour', [m.space, m.hasAlpha ? 'transparency' : null, m.depth].filter(Boolean).join(' · ')])
  if (file.checksum) rows.push(['Checksum', <span title={file.checksum} style={{ fontFamily: 'ui-monospace,monospace' }}>sha256 {file.checksum.slice(0, 16)}…</span>])
  async function refresh() {
    setBusy(true)
    try { onRefreshed(await api.refreshFileMetadata(file.id)) } catch { /* the panel keeps what it had */ } finally { setBusy(false) }
  }
  return (
    <div className="field">
      <label style={{ display: 'flex', alignItems: 'center' }}>Details
        <span style={{ flex: 1 }} />
        {file.source !== 'encoder' && <button type="button" className="btn ghost" style={{ padding: '2px 8px', fontSize: 'var(--fs-label)' }} disabled={busy} onClick={refresh}
          title="Read the metadata from the stored file again">{busy ? 'Reading…' : 'Re-read'}</button>}
      </label>
      {rows.length === 0
        ? <div className="hintxt">The file carries no camera, place or caption metadata.</div>
        : (
          <dl style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '4px 12px', margin: 0, fontSize: 'var(--fs-sm)' }}>
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt style={{ color: 'var(--faint)' }}>{k}</dt>
                <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{v}</dd>
              </div>
            ))}
          </dl>
        )}
    </div>
  )
}

/* ------------------------------------------------------------- URL builder */
/** Compose a derivative URL for an image in ONE preview window.
 *
 *  The preview shows the source with the filters approximated live (CSS), and
 *  everything is set by interacting directly ON it:
 *    - focal point: a draggable CROSSHAIR; cover resizes keep it in frame
 *    - crop: drag a rectangle in Crop mode (outside dimmed)
 *    - the bright outline is the OUTPUT FRAME: exactly what a cover resize at
 *      the current size will keep, so the result is visible without a second
 *      pane. The URL below is copy-ready. */
function UrlBuilder({ file, onClose, notify }: { file: MediaFile; onClose: () => void; notify: (m: string) => void }) {
  const srcW = file.width || 1280, srcH = file.height || 720
  const [w, setW] = useState(String(Math.min(640, srcW)))
  const [h, setH] = useState(String(Math.max(1, Math.round(Math.min(640, srcW) * (srcH / srcW)))))
  const [fit, setFit] = useState<'cover' | 'inside' | 'contain' | 'fill'>('cover')
  const [mode, setMode] = useState<'focus' | 'crop'>('focus')
  const [focus, setFocus] = useState<{ x: number; y: number } | null>(null)
  const [crop, setCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [gray, setGray] = useState(false)
  const [blur, setBlur] = useState(0)
  const [bright, setBright] = useState(100)
  const [sat, setSat] = useState(100)
  const [sharpen, setSharpen] = useState(false)
  const [q, setQ] = useState(80)
  const [fmt, setFmt] = useState<'webp' | 'avif' | 'jpeg' | 'png'>('webp')
  const drag = useRef<{ kind: 'focus' | 'crop'; ax: number; ay: number } | null>(null)
  const box = useRef<HTMLDivElement | null>(null)

  const key = file.url.replace(/^\//, '')      // library/<acct>/<path>
  const spec = (() => {
    const t: string[] = [`${Math.min(MAX_DIM, Math.max(1, +w || 1))}x${Math.min(MAX_DIM, Math.max(1, +h || 1))}`, fit]
    if (crop) t.push(`crop=${Math.round(crop.x)}-${Math.round(crop.y)}-${Math.round(crop.w)}-${Math.round(crop.h)}`)
    if (fit === 'cover' && focus) t.push(`focus=${Math.round(focus.x)}-${Math.round(focus.y)}`)
    if (gray) t.push('gray')
    if (blur > 0) t.push(`blur=${blur}`)
    if (bright !== 100) t.push(`bright=${bright}`)
    if (sat !== 100) t.push(`sat=${sat}`)
    if (sharpen) t.push('sharp')
    if (q !== 80) t.push(`q=${q}`)
    if (fmt !== 'webp') t.push(`fmt=${fmt}`)
    return t.join(',')
  })()
  // Signed with the account key (imageSigning.ts): the service renders nothing unsigned.
  // `absolute` points at the image CDN when one is configured, so it can be pasted anywhere.
  const absolute = signImage(spec, key, true) ?? 'Loading the signing key…'

  /** The OUTPUT FRAME in source-percent coords: what a cover resize keeps.
   *  Mirrors the server maths (crop first, focal window inside it). */
  const kept = (() => {
    if (fit !== 'cover') return crop     // non-cover: the crop is the frame
    const W = Math.max(1, +w || 1), H = Math.max(1, +h || 1)
    const rg = crop ?? { x: 0, y: 0, w: 100, h: 100 }
    const rw = (rg.w / 100) * srcW, rh = (rg.h / 100) * srcH
    const scale = Math.max(W / rw, H / rh)
    const kw = Math.min(rw, W / scale), kh = Math.min(rh, H / scale)
    const fx = focus ? Math.max(rg.x, Math.min(rg.x + rg.w, focus.x)) : rg.x + rg.w / 2
    const fy = focus ? Math.max(rg.y, Math.min(rg.y + rg.h, focus.y)) : rg.y + rg.h / 2
    const kwP = (kw / srcW) * 100, khP = (kh / srcH) * 100
    const x = Math.max(rg.x, Math.min(rg.x + rg.w - kwP, fx - kwP / 2))
    const y = Math.max(rg.y, Math.min(rg.y + rg.h - khP, fy - khP / 2))
    return { x, y, w: kwP, h: khP }
  })()

  // ---- pointer interactions on the ONE preview ------------------------------
  const pct = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)),
      y: Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100)),
    }
  }
  function down(e: React.PointerEvent) {
    e.preventDefault(); (e.target as Element).setPointerCapture?.(e.pointerId)
    const p = pct(e)
    if (mode === 'focus') {
      drag.current = { kind: 'focus', ax: p.x, ay: p.y }
      setFocus(p)
      if (fit !== 'cover') setFit('cover')
    } else {
      drag.current = { kind: 'crop', ax: p.x, ay: p.y }
      setCrop({ x: p.x, y: p.y, w: 0, h: 0 })
    }
  }
  function move(e: React.PointerEvent) {
    if (!drag.current) return
    const p = pct(e)
    if (drag.current.kind === 'focus') setFocus(p)
    else {
      const { ax, ay } = drag.current
      setCrop({ x: Math.min(ax, p.x), y: Math.min(ay, p.y), w: Math.abs(p.x - ax), h: Math.abs(p.y - ay) })
    }
  }
  function up() {
    if (drag.current?.kind === 'crop') {
      setCrop(c => (c && (c.w < 2 || c.h < 2)) ? null : c)   // sub-2% drag = click
      setMode('focus')
    }
    drag.current = null
  }

  async function copy() {
    try { await navigator.clipboard.writeText(absolute); notify('URL copied') }
    catch {
      const el = document.createElement('textarea')
      el.value = absolute; document.body.appendChild(el); el.select()
      document.execCommand('copy'); document.body.removeChild(el)
      notify('URL copied')
    }
  }

  const cssFilter = [
    gray ? 'grayscale(1)' : '',
    blur > 0 ? `blur(${(blur / 5).toFixed(1)}px)` : '',
    bright !== 100 ? `brightness(${bright / 100})` : '',
    sat !== 100 ? `saturate(${sat / 100})` : '',
  ].filter(Boolean).join(' ')

  const Slider = ({ label, value, set, min, max, step = 1, suffix = '' }: {
    label: string; value: number; set: (v: number) => void; min: number; max: number; step?: number; suffix?: string
  }) => (
    <div className="field" style={{ margin: 0 }}>
      <label>{label} — {value}{suffix}</label>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => set(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--brand)' }} />
    </div>
  )

  return (
    <div className="drawer-scrim" {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" style={{ width: 1040, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto', padding: 0 }}>
        <div className="drawer-h"><div className="t">Image URL builder — {file.name}</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 18, padding: 18 }}>
          <div>
            {/* -------- the ONE preview: filters live, focus + crop overlaid -------- */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <button className={`btn ${mode === 'focus' ? 'primary' : 'ghost'}`} style={{ padding: '4px 10px', fontSize: 'var(--fs-sm)' }} onClick={() => setMode('focus')}>Focus point</button>
              <button className={`btn ${mode === 'crop' ? 'primary' : 'ghost'}`} style={{ padding: '4px 10px', fontSize: 'var(--fs-sm)' }} onClick={() => setMode('crop')}>Crop</button>
              {focus && <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 'var(--fs-sm)' }} onClick={() => setFocus(null)}>clear focus</button>}
              {crop && <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 'var(--fs-sm)' }} onClick={() => setCrop(null)}>clear crop</button>}
              <span style={{ fontSize: 'var(--fs-label)', color: 'var(--faint)', marginLeft: 'auto' }}>{srcW}×{srcH}</span>
            </div>
            <div style={{ display: 'grid', placeItems: 'center', background: 'repeating-conic-gradient(#1a1f2b 0% 25%, #141821 0% 50%) 50% / 18px 18px', borderRadius: 10, padding: 8 }}>
              <div ref={box} className="src-view" onPointerDown={down} onPointerMove={move} onPointerUp={up}
                style={{ position: 'relative', display: 'inline-block', cursor: mode === 'crop' ? 'crosshair' : 'default', touchAction: 'none', userSelect: 'none', lineHeight: 0 }}>
                <img src={thumbUrl(file.url, 900, 520, 'inside')} alt="" draggable={false}
                  style={{ maxWidth: '100%', maxHeight: 380, display: 'block', pointerEvents: 'none', filter: cssFilter || undefined }} />
                {/* crop: dim everything outside */}
                {crop && crop.w > 0 && (
                  <>
                    <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.55)', pointerEvents: 'none',
                      clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 ${crop.y}%, ${crop.x}% ${crop.y}%, ${crop.x}% ${crop.y + crop.h}%, ${crop.x + crop.w}% ${crop.y + crop.h}%, ${crop.x + crop.w}% ${crop.y}%, 0 ${crop.y}%)` }} />
                    <div style={{ position: 'absolute', left: `${crop.x}%`, top: `${crop.y}%`, width: `${crop.w}%`, height: `${crop.h}%`, border: '1.5px dashed rgba(255,255,255,.85)', pointerEvents: 'none' }} />
                  </>
                )}
                {/* the output frame a cover resize keeps */}
                {kept && fit === 'cover' && (
                  <div style={{ position: 'absolute', left: `${kept.x}%`, top: `${kept.y}%`, width: `${kept.w}%`, height: `${kept.h}%`,
                    border: '2px solid var(--brand,#5b8cff)', borderRadius: 3, boxShadow: '0 0 0 1px rgba(0,0,0,.6), inset 0 0 0 1px rgba(0,0,0,.35)', pointerEvents: 'none' }} />
                )}
                {/* focal CROSSHAIR */}
                {focus && (
                  <div style={{ position: 'absolute', left: `${focus.x}%`, top: `${focus.y}%`, width: 0, height: 0, pointerEvents: 'none' }}>
                    <div style={{ position: 'absolute', left: -14, top: -1, width: 28, height: 2, background: '#fff', boxShadow: '0 0 3px rgba(0,0,0,.9)' }} />
                    <div style={{ position: 'absolute', left: -1, top: -14, width: 2, height: 28, background: '#fff', boxShadow: '0 0 3px rgba(0,0,0,.9)' }} />
                  </div>
                )}
              </div>
            </div>
            <div className="hintxt" style={{ marginTop: 6 }}>
              <b>Drag</b> to {mode === 'focus' ? 'place the focus crosshair' : 'draw the crop rectangle'}.
              {fit === 'cover' ? ' The blue outline is the output frame: exactly what your size keeps.' : ''}
              {crop ? ` Crop ${Math.round(crop.w)}×${Math.round(crop.h)}% at ${Math.round(crop.x)},${Math.round(crop.y)}.` : ''}
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label>URL — paste anywhere; resized and cached on first request</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="inp url-out" readOnly value={absolute} onFocus={e => e.currentTarget.select()} style={{ flex: 1, fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }} />
                <button className="btn ghost" onClick={() => window.open(absolute, '_blank')} title="Open the rendered output in a new tab">View</button>
                <button className="btn primary" onClick={copy}>Copy</button>
              </div>
            </div>
          </div>
          {/* -------- controls -------- */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div className="field" style={{ margin: 0 }}><label>Width</label>
                <input className="inp" inputMode="numeric" value={w} onChange={e => setW(e.target.value.replace(/[^0-9]/g, ''))} />
              </div>
              <div className="field" style={{ margin: 0 }}><label>Height</label>
                <input className="inp" inputMode="numeric" value={h} onChange={e => setH(e.target.value.replace(/[^0-9]/g, ''))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {([['16:9', 16 / 9], ['4:3', 4 / 3], ['1:1', 1], ['9:16', 9 / 16]] as const).map(([lbl, r]) => (
                <button key={lbl} className="btn ghost" style={{ padding: '4px 10px', fontSize: 'var(--fs-sm)' }}
                  onClick={() => setH(String(Math.max(1, Math.round((+w || 640) / r))))}>{lbl}</button>
              ))}
            </div>
            <div className="field" style={{ margin: 0 }}><label>Fit</label>
              <select className="inp" value={fit} onChange={e => setFit(e.target.value as any)}>
                <option value="cover">Cover — fill the box, crop overflow</option>
                <option value="inside">Inside — fit within, keep aspect</option>
                <option value="contain">Contain — fit within, pad to box</option>
                <option value="fill">Fill — stretch to box</option>
              </select>
            </div>
            <div style={{ fontSize: 'var(--fs-label)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint)', marginTop: 4 }}>Filters</div>
            <Slider label="Brightness" value={bright} set={setBright} min={10} max={300} suffix="%" />
            <Slider label="Saturation" value={sat} set={setSat} min={0} max={300} suffix="%" />
            <Slider label="Blur" value={blur} set={setBlur} min={0} max={30} />
            <div style={{ display: 'flex', gap: 14 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-body)', cursor: 'pointer' }}>
                <input type="checkbox" checked={gray} onChange={e => setGray(e.target.checked)} /> Grayscale
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-body)', cursor: 'pointer' }}>
                <input type="checkbox" checked={sharpen} onChange={e => setSharpen(e.target.checked)} /> Sharpen
              </label>
            </div>
            <div style={{ fontSize: 'var(--fs-label)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint)', marginTop: 4 }}>Output</div>
            <Slider label="Quality" value={q} set={setQ} min={30} max={100} />
            <div className="field" style={{ margin: 0 }}><label>Format</label>
              <select className="inp" value={fmt} onChange={e => setFmt(e.target.value as any)}>
                <option value="webp">WebP (recommended)</option>
                <option value="avif">AVIF (smallest)</option>
                <option value="jpeg">JPEG</option>
                <option value="png">PNG (lossless)</option>
              </select>
            </div>
            <button className="btn ghost" style={{ marginTop: 4 }} onClick={() => {
              setFit('cover'); setMode('focus'); setFocus(null); setCrop(null); setGray(false); setBlur(0); setBright(100); setSat(100); setSharpen(false); setQ(80); setFmt('webp')
              setW(String(Math.min(640, srcW))); setH(String(Math.max(1, Math.round(Math.min(640, srcW) * (srcH / srcW)))))
            }}>Reset</button>
          </div>
        </div>
      </div>
    </div>
  )
}
