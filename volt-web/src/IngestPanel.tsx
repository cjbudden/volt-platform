// ============================================================================
//  INGEST DASHBOARD: the Uppy shape, with Volt's ingest behind it.
//
//  What the operator sees: a rail of places files come from, one big drop
//  zone, the files as cards, one primary button. What the rules do to each
//  file (rename, duplicate, refuse, cloud to cloud) is a small badge on its
//  card, decided before a byte moves. Metadata is a sheet that slides in for
//  one file or for all of them, never a form in the way of the drop zone.
//  Anything long-running goes to the Ingest Queue drawer (IngestQueue.tsx),
//  which follows the operator around the console.
//
//  TRANSPORT. Chunk protocol (three in flight, Background Fetch on Chromium)
//  on desktop; the tus client on phones. Cloud sources and accelerated
//  providers never move bytes through this device at all.
// ============================================================================
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, getToken, type IngestPreviewRow, type IngestHeld, type IngestTransfer } from './api'
import { startUpload, subscribe, type UploadItem } from './uploadManager'
import { tusUpload, isCellular } from './tusClient'
import { TypePicker, MetadataForm } from './ContentTypeFields'
import { openDropboxChooser, openOneDrivePicker, openGooglePicker, pickerConfigured } from './cloudPickers'
import './ingest.css'

const isPhone = () => /iPhone|iPad|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && window.innerWidth < 900)
export const fmtBytes = (n: number) => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(0) + ' MB' : (n / 1e3).toFixed(0) + ' KB'

/** Walk a dropped DataTransfer so a dropped FOLDER yields its files with paths. */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = [...(dt.items ?? [])].map(i => (i as any).webkitGetAsEntry?.()).filter(Boolean)
  if (!entries.length) return [...(dt.files ?? [])]
  const out: File[] = []
  const readDir = (dir: any): Promise<any[]> => new Promise(res => { const r = dir.createReader(); const all: any[] = []; const next = () => r.readEntries((es: any[]) => { if (!es.length) return res(all); all.push(...es); next() }, () => res(all)); next() })
  const visit = async (e: any, prefix: string) => {
    if (e.isFile) { const f: File = await new Promise(res => e.file(res)); try { Object.defineProperty(f, 'webkitRelativePath', { value: prefix + f.name }) } catch { /* readonly */ } out.push(f) }
    else if (e.isDirectory) for (const c of await readDir(e)) await visit(c, prefix + e.name + '/')
  }
  for (const e of entries) await visit(e, '')
  return out
}

type Source = 'device' | 'folder' | 'link' | 'dropbox' | 'onedrive' | 'gdrive' | 'camera'
interface Picked { id: string; file: File; preview?: IngestPreviewRow; skip?: boolean; meta?: Record<string, any>; typeId?: string | null
  cloud?: { provider: string; ref: string; providerAccountId: string; label: string; strength: string } | null; thumb?: string | null }

const I = {
  device: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 20h8"/></svg>,
  folder: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>,
  link: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>,
  camera: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>,
  cloud: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M7 18a4 4 0 0 1-.6-7.95A6 6 0 0 1 18 9a4.5 4.5 0 0 1-1 8.9z"/><path d="M12 12v8m-3-3 3 3 3-3"/></svg>,
  up: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 16V5m-5 5 5-5 5 5"/><path d="M4 19h16"/></svg>,
}

export function IngestPanel({ onDone, source = 'panel' }: { onDone: () => void; source?: string }) {
  const [src, setSrc] = useState<Source>('device')
  const [picked, setPicked] = useState<Picked[]>([])
  const [typeId, setTypeId] = useState<string | null>(null)
  const [meta, setMeta] = useState<Record<string, any>>({})
  const [sheet, setSheet] = useState<null | 'all' | string>(null)      // metadata sheet: all files, or one id
  const [autoUpload, setAutoUpload] = useState(true)
  const [items, setItems] = useState<UploadItem[]>([])
  const [held, setHeld] = useState<IngestHeld[]>([])
  const [providers, setProviders] = useState<{ id: string; provider: string; label: string }[]>([])
  const [transfers, setTransfers] = useState<IngestTransfer[]>([])
  const [over, setOver] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState('')
  const [tusProg, setTusProg] = useState<Record<string, number>>({})
  const fileRef = useRef<HTMLInputElement | null>(null); const folderRef = useRef<HTMLInputElement | null>(null); const camRef = useRef<HTMLInputElement | null>(null)
  const depth = useRef(0)
  const phone = isPhone()
  const pickers = useMemo(() => pickerConfigured(), [])

  const loadHeld = () => api.ingestHeld().then(setHeld).catch(() => {})
  useEffect(() => { loadHeld() }, [])
  useEffect(() => subscribe(all => { setItems(all); if (all.some(i => i.status === 'done')) { onDone(); loadHeld() } }), [onDone])
  useEffect(() => { api.ingestBaseline().then(b => setAutoUpload(b.baseline.autoUpload)).catch(() => {}) }, [])
  useEffect(() => { api.ingestProviders().then(p => setProviders(p.linked.filter(l => ['aspera', 'masv', 'signiant'].includes(l.provider)))).catch(() => {}) }, [])
  useEffect(() => { const load = () => api.ingestTransfers().then(ts => setTransfers(ts.filter(x => x.state !== 'landed' || Date.now() - new Date(x.createdAt).getTime() < 10 * 60_000))).catch(() => {}); load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [])

  /** Thumbnails for images and short video posters, like Uppy's cards. Best effort. */
  async function thumb(file: File): Promise<string | null> {
    try {
      if (file.type.startsWith('image/') && file.size < 40e6) return URL.createObjectURL(file)
      if (file.type.startsWith('video/') && file.size < 600e6) {
        return await new Promise(res => { const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true; v.src = URL.createObjectURL(file)
          v.onloadeddata = () => { try { v.currentTime = Math.min(1, v.duration / 2) } catch { res(null) } }
          v.onseeked = () => { const c = document.createElement('canvas'); c.width = 240; c.height = Math.round(240 * v.videoHeight / Math.max(1, v.videoWidth)); c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', .7)); URL.revokeObjectURL(v.src) }
          v.onerror = () => res(null); setTimeout(() => res(null), 4000) })
      }
    } catch { /* */ }
    return null
  }

  /** Add files: preview them (rules, rename, duplicate, refuse, cloud) before anything moves. */
  async function add(files: File[]) {
    setErr(''); if (!files.length) return
    const next: Picked[] = files.map(file => ({ id: Math.random().toString(36).slice(2), file }))
    setPicked(p => [...p, ...next])
    next.forEach(async n => { const t = await thumb(n.file); if (t) setPicked(p => p.map(x => x.id === n.id ? { ...x, thumb: t } : x)) })
    try {
      const rows = await api.ingestPreview({ files: files.map(f => ({ name: f.name, bytes: f.size, relativePath: (f as any).webkitRelativePath || null, mime: f.type || null })), source, contentTypeId: typeId })
      next.forEach((n, i) => { n.preview = rows[i]; n.skip = rows[i]?.reject != null || rows[i]?.duplicate === 'skip' })
      const wantCloud = next.filter(w => w.preview && w.preview.settings.transfer !== 'local' && !w.skip)
      if (wantCloud.length) {
        try {
          const hits = await api.ingestLocate(wantCloud.map(w => ({ name: w.file.name, bytes: w.file.size, relativePath: (w.file as any).webkitRelativePath || null })))
          for (const w of wantCloud) { const h = hits.find(x => x.name === w.file.name)?.hit; if (h) w.cloud = { provider: h.ref.provider, ref: h.ref.ref, providerAccountId: h.providerAccountId, label: h.label, strength: h.strength } }
        } catch { /* no linked accounts, the local route still works */ }
      }
      setPicked(p => p.map(x => next.find(n => n.id === x.id) ?? x))
      if (autoUpload) void start(next)
    } catch (e: any) { setErr(String(e?.message ?? e)) }
  }

  async function start(list: Picked[]) {
    setBusy(true)
    const done: string[] = []
    for (const p of list) {
      if (p.skip || p.preview?.reject) continue
      const m = { ...meta, ...(p.meta ?? {}) }; const t = p.typeId ?? typeId
      try {
        if (p.cloud && p.preview?.settings.transfer !== 'local') {
          await api.ingestRemote({ ref: { provider: p.cloud.provider as any, ref: p.cloud.ref }, name: p.file.name, bytes: p.file.size, relativePath: (p.file as any).webkitRelativePath || null, schemaId: t, metadata: Object.keys(m).length ? m : undefined, providerAccountId: p.cloud.providerAccountId })
          onDone(); done.push(p.id); continue
        }
        if (phone) {
          await tusUpload(p.file, { endpoint: '/api/tus', token: getToken() ?? '', metadata: { source, ...(t ? { schemaId: t } : {}), ...(Object.keys(m).length ? { metadata: JSON.stringify(m) } : {}) }, onProgress: (s, tot) => setTusProg(x => ({ ...x, [p.id]: s / tot })) })
          setTusProg(x => { const c = { ...x }; delete c[p.id]; return c }); onDone(); loadHeld()
        } else {
          await startUpload(p.file, { kind: 'loop', purpose: 'vod', source, schemaId: t, metadata: Object.keys(m).length ? m : null })
        }
        done.push(p.id)
      } catch (e: any) { setErr(String(e?.message ?? e)) }
    }
    setPicked(cur => cur.filter(x => !done.includes(x.id)))
    setBusy(false)
  }

  async function fetchLink() {
    if (!link.trim()) return
    setErr('')
    try { await api.ingestRemote({ ref: { provider: 'url', ref: link.trim() }, schemaId: typeId, metadata: Object.keys(meta).length ? meta : undefined }); setLink(''); onDone(); setSrc('device') }
    catch (e: any) { setErr(String(e?.message ?? e)) }
  }

  /** A cloud picker hands back either direct links (Dropbox, OneDrive) or file ids plus a token (Google). */
  async function fromPicker(kind: 'dropbox' | 'onedrive' | 'gdrive') {
    setErr('')
    try {
      const picks = kind === 'dropbox' ? await openDropboxChooser() : kind === 'onedrive' ? await openOneDrivePicker() : await openGooglePicker()
      for (const p of picks) await api.ingestRemote({ ref: p.ref, name: p.name, bytes: p.bytes ?? undefined, schemaId: typeId, metadata: Object.keys(meta).length ? meta : undefined })
      if (picks.length) { onDone(); setSrc('device') }
    } catch (e: any) { setErr(String(e?.message ?? e)) }
  }

  async function sendWith(pa: { id: string; provider: string; label: string }) {
    const list = picked.filter(p => !p.skip && !p.preview?.reject); if (!list.length) return
    setErr('')
    try {
      const t = await api.createIngestTransfer({ provider: pa.provider as any, files: list.map(p => ({ name: p.file.name, bytes: p.file.size, relativePath: (p.file as any).webkitRelativePath || null })), providerAccountId: pa.id })
      setTransfers(cur => [t, ...cur]); setPicked(cur => cur.filter(p => !list.includes(p)))
      if (t.launch?.kind === 'portal') window.open(t.launch.url, '_blank')
      if (t.launch?.kind === 'aspera_spec') { const sdk = (window as any).AsperaSdk ?? (window as any).asperaWeb; if (sdk?.startTransfer) sdk.startTransfer(t.launch.transferSpec, {}) }
    } catch (e: any) { setErr(String(e?.message ?? e)) }
  }

  const pending = picked.filter(p => !p.skip && !p.preview?.reject)
  const totalBytes = pending.reduce((a, p) => a + p.file.size, 0)
  const active = items.filter(i => ['queued', 'uploading', 'assembling', 'background', 'paused'].includes(i.status))
  const recentDone = items.filter(i => i.status === 'done' && Date.now() - i.startedAt < 20_000)
  const sent = active.reduce((a, i) => a + i.sentBytes, 0), tot = active.reduce((a, i) => a + i.totalBytes, 0)
  const rate = active.reduce((a, i) => a + (i.rate ?? 0), 0)
  const eta = rate > 0 ? Math.round((tot - sent) / rate) : null

  const railBtn = (k: Source, label: string, icon: ReactNode, onClick: () => void, disabled = false, title = '') => (
    <button type="button" className={`ig-src${src === k ? ' on' : ''}`} onClick={onClick} disabled={disabled} title={title}>{icon}<span>{label}</span></button>
  )
  const brandIco = (bg: string, letter: string) => <span className="ig-ico" style={{ background: bg }}>{letter}</span>

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="ig">
        <div className="ig-rail">
          <div className="ig-t">Add from</div>
          {railBtn('device', phone ? 'Camera roll' : 'My device', I.device, () => { setSrc('device'); fileRef.current?.click() })}
          {!phone && railBtn('folder', 'A folder', I.folder, () => { setSrc('folder'); folderRef.current?.click() })}
          {phone && railBtn('camera', 'Record now', I.camera, () => { setSrc('camera'); camRef.current?.click() })}
          {railBtn('link', 'Link', I.link, () => setSrc('link'))}
          <div className="ig-t" style={{ marginTop: 8 }}>Cloud to cloud</div>
          {railBtn('dropbox', 'Dropbox', brandIco('#0061fe', 'D'), () => { setSrc('dropbox'); fromPicker('dropbox') }, !pickers.dropbox, pickers.dropbox ? 'Pick in Dropbox; Volt fetches it, nothing goes through this device' : 'Set VITE_DROPBOX_APP_KEY to enable the Dropbox chooser')}
          {railBtn('onedrive', 'OneDrive', brandIco('#0a64c2', 'O'), () => { setSrc('onedrive'); fromPicker('onedrive') }, !pickers.onedrive, pickers.onedrive ? '' : 'Set VITE_MS_CLIENT_ID to enable the OneDrive picker')}
          {railBtn('gdrive', 'Google Drive', brandIco('#1ea362', 'G'), () => { setSrc('gdrive'); fromPicker('gdrive') }, !pickers.gdrive, pickers.gdrive ? '' : 'Set VITE_GOOGLE_CLIENT_ID and VITE_GOOGLE_API_KEY to enable the Drive picker')}
          {providers.length > 0 && <div className="ig-t" style={{ marginTop: 8 }}>Send with</div>}
          {providers.map(pa => <button key={pa.id} type="button" className="ig-src" disabled={!pending.length} title={pending.length ? `Accelerated transfer: ${pa.label} moves the files, Volt ingests them when they land` : 'Add files first'} onClick={() => sendWith(pa)}>{I.cloud}<span>{pa.label}</span></button>)}
          <input ref={fileRef} type="file" accept="video/*,audio/*,image/*" multiple hidden onChange={e => { add([...(e.target.files ?? [])]); e.target.value = '' }} />
          <input ref={folderRef} type="file" multiple hidden {...({ webkitdirectory: '' } as any)} onChange={e => { add([...(e.target.files ?? [])]); e.target.value = '' }} />
          <input ref={camRef} type="file" accept="video/*" capture="environment" hidden onChange={e => { add([...(e.target.files ?? [])]); e.target.value = '' }} />
        </div>

        <div className="ig-main"
          onDragEnter={e => { e.preventDefault(); depth.current++; setOver(true) }}
          onDragLeave={e => { e.preventDefault(); if (--depth.current <= 0) setOver(false) }}
          onDragOver={e => e.preventDefault()}
          onDrop={async e => { e.preventDefault(); depth.current = 0; setOver(false); add(await filesFromDrop(e.dataTransfer)) }}>
          <div className="ig-head">
            {picked.length ? <><b>{picked.length} file{picked.length === 1 ? '' : 's'}</b><span>· {fmtBytes(totalBytes)}</span></> : <span>Add to the library</span>}
            <span className="sp" />
            {picked.length > 0 && <button type="button" className="btn ghost" style={{ padding: '5px 10px', fontSize: 'var(--fs-xs)' }} onClick={() => fileRef.current?.click()}>Add more</button>}
            <button type="button" className="btn ghost" style={{ padding: '5px 10px', fontSize: 'var(--fs-xs)' }} onClick={() => setSheet(sheet === 'all' ? null : 'all')}>{typeId ? 'Type and metadata' : 'Set type and metadata'}</button>
          </div>

          <div className="ig-body">
            {sheet === 'all' && (
              <div className="ig-sheet">
                <h4>Applies to every file added from now</h4>
                <p>Leave the type empty and the ingest rules decide it. Required fields can be filled while the upload runs; ingest waits for them, the bytes do not.</p>
                <div style={{ display: 'grid', gridTemplateColumns: phone ? '1fr' : '240px 1fr', gap: 12 }}>
                  <TypePicker appliesTo="vod" value={typeId} onChange={id => { setTypeId(id); setMeta({}) }} />
                  {typeId ? <MetadataForm typeId={typeId} value={meta} onChange={setMeta} compact /> : <div />}
                </div>
                <div><button type="button" className="btn ghost" style={{ padding: '5px 10px', fontSize: 'var(--fs-xs)' }} onClick={() => setSheet(null)}>Done</button></div>
              </div>
            )}
            {sheet && sheet !== 'all' && (() => { const p = picked.find(x => x.id === sheet); if (!p) return null; return (
              <div className="ig-sheet">
                <h4>{p.file.name}</h4>
                <p>Type and metadata for this file only. Anything left empty falls back to the panel's setting, then the rules.</p>
                <div style={{ display: 'grid', gridTemplateColumns: phone ? '1fr' : '240px 1fr', gap: 12 }}>
                  <TypePicker appliesTo="vod" value={p.typeId ?? typeId} onChange={id => setPicked(c => c.map(x => x.id === p.id ? { ...x, typeId: id, meta: {} } : x))} />
                  {(p.typeId ?? typeId) ? <MetadataForm typeId={p.typeId ?? typeId} value={p.meta ?? {}} onChange={v => setPicked(c => c.map(x => x.id === p.id ? { ...x, meta: v } : x))} compact /> : <div />}
                </div>
                <div><button type="button" className="btn ghost" style={{ padding: '5px 10px', fontSize: 'var(--fs-xs)' }} onClick={() => setSheet(null)}>Done</button></div>
              </div>) })()}
            {src === 'link' && (
              <div className="ig-sheet">
                <h4>Import from a link</h4>
                <p>Fetched by Volt's servers as parallel ranges. Nothing goes through this device. Signed URLs work.</p>
                <form style={{ display: 'flex', gap: 8 }} onSubmit={e => { e.preventDefault(); fetchLink() }}>
                  <input className="ig-in" value={link} onChange={e => setLink(e.target.value)} placeholder="https://example.com/master.mxf" autoFocus />
                  <button type="submit" className="btn primary" disabled={!link.trim()}>Import</button>
                </form>
              </div>
            )}

            {picked.length === 0 && src !== 'link' ? (
              <div className={`ig-drop${over ? ' over' : ''}`}>
                <div>
                  {I.up}
                  <div className="big">Drop files here or <a onClick={() => fileRef.current?.click()}>browse</a></div>
                  <div className="sm">{phone ? 'Video, audio and images from your camera roll or Files' : 'Video, audio and images. Drop a whole folder and its structure is kept.'}{phone && isCellular() ? ' · on cellular: smaller chunks, resumes if it drops' : ''}</div>
                </div>
              </div>
            ) : picked.length > 0 && (
              <div className="ig-grid">
                {picked.map(p => {
                  const pv = p.preview
                  const badge = !pv ? <span className="ig-badge">checking rules</span>
                    : pv.reject ? <span className="ig-badge bad" title={pv.reject}>refused</span>
                    : p.cloud && pv.settings.transfer !== 'local' ? <span className="ig-badge cloud" title={`found in ${p.cloud.label} by ${p.cloud.strength.replace('_', ' ')}: transfers cloud to cloud`}>from {p.cloud.label}</span>
                    : pv.duplicate !== 'proceed' ? <span className="ig-badge warn" title={`looks like a duplicate (${pv.duplicateOf?.strength.replace('_', ' ')}), rule says ${pv.duplicate}`}>duplicate?</span>
                    : pv.settings.naming === 'honour' && pv.changed ? <span className="ig-badge" title={`will be named ${pv.sanitised}`}>renamed</span>
                    : <span className="ig-badge ok" title={pv.matched.map(m => m.ruleName).join(' < ')}>ready</span>
                  const prog = tusProg[p.id]
                  return (
                    <div key={p.id} className={`ig-card${p.skip ? ' dim' : ''}`}>
                      <div className="th">{p.thumb ? (p.file.type.startsWith('image/') ? <img src={p.thumb} alt="" /> : <img src={p.thumb} alt="" />) : (p.file.name.split('.').pop() ?? 'file').slice(0, 4)}</div>
                      <div className="nm" title={(p.file as any).webkitRelativePath || p.file.name}>{p.file.name}</div>
                      <div className="mt">{fmtBytes(p.file.size)}{(p.meta && Object.keys(p.meta).length) ? ' · metadata set' : ''}{p.typeId ? ' · own type' : ''}</div>
                      <div className="bd">{badge}{p.cloud && pv?.settings.transfer !== 'local' && <button type="button" className="ig-badge" style={{ cursor: 'pointer', border: 0 }} onClick={() => setPicked(c => c.map(x => x.id === p.id ? { ...x, cloud: null } : x))}>upload from here</button>}</div>
                      {prog != null && <div className="ig-pb"><i style={{ width: `${Math.round(prog * 100)}%` }} /></div>}
                      <button type="button" className="ed" onClick={() => setSheet(p.id)}>Edit</button>
                      <button type="button" className="x" aria-label="Remove" onClick={() => setPicked(c => c.filter(x => x.id !== p.id))}>×</button>
                    </div>
                  )
                })}
              </div>
            )}
            {err && <div style={{ color: 'var(--down)', fontSize: 'var(--fs-sm)' }}>{err}</div>}
          </div>

          {(active.length > 0 || recentDone.length > 0) && (
            <div className={`ig-status${active.length ? '' : ' done'}`}>
              {active.length ? <>
                <span>Uploading {active.length} file{active.length === 1 ? '' : 's'}</span>
                <div className="bar"><i style={{ width: `${tot ? Math.round((sent / tot) * 100) : 0}%` }} /></div>
                <span style={{ color: 'var(--muted)' }}>{fmtBytes(sent)} of {fmtBytes(tot)}{rate > 0 ? ` · ${fmtBytes(rate)}/s` : ''}{eta != null ? ` · ${eta >= 60 ? Math.round(eta / 60) + 'm' : eta + 's'} left` : ''}</span>
              </> : <><span style={{ color: 'var(--live)' }}>✓ {recentDone.length} uploaded</span><span style={{ color: 'var(--muted)' }}>{recentDone.map(i => i.ingest?.status === 'awaiting_metadata' ? `${i.name}: waiting for metadata` : i.ingest?.status === 'duplicate' ? `${i.name}: duplicate, decide in the queue` : '').filter(Boolean).join(' · ')}</span></>}
            </div>
          )}

          <div className="ig-foot">
            <label className={`ig-tog${autoUpload ? ' on' : ''}`} onClick={() => setAutoUpload(v => !v)}><i />Start as soon as added</label>
            {held.length > 0 && <span className="ig-badge warn" title="Open the Ingest Queue to fill metadata or decide duplicates">{held.length} waiting on you</span>}
            {transfers.filter(t => t.state !== 'landed').length > 0 && <span className="ig-badge fast">{transfers.filter(t => t.state !== 'landed').length} accelerated transfer{transfers.filter(t => t.state !== 'landed').length === 1 ? '' : 's'} running</span>}
            <span className="sp" />
            {pending.length > 0 && !autoUpload && <button type="button" className="btn primary" disabled={busy} onClick={() => start(pending)}>Upload {pending.length} file{pending.length === 1 ? '' : 's'}</button>}
            {pending.length > 0 && autoUpload && busy && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>starting…</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

export function label(g: UploadItem['ingest']): string {
  if (!g) return 'uploaded, encoding next'
  switch (g.status) {
    case 'ingested': return g.naming?.renamed ? 'filed, encoding next' : 'encoding next'
    case 'awaiting_metadata': return `waiting for ${(g.awaitingMetadata ?? []).join(', ') || 'metadata'}`
    case 'duplicate': return g.duplicate?.outcome === 'skip' ? 'skipped, already in the library' : 'duplicate, needs a decision'
    case 'rejected': return 'refused by an ingest rule'
    default: return 'uploaded'
  }
}
